import type { RuleFile } from "../rules/types.ts";
import type { Change, Evidence, Prevalence, ProposalInsert } from "../store/queries.ts";
import type { LearnGroup, NoteView } from "./prompt.ts";
import type { Candidate, LearnOutput } from "./schema.ts";

import { utcDay } from "../domain/text.ts";
import { fingerprint, newId } from "../rules/ids.ts";

export class LearnError extends Error {
  constructor(
    readonly group: string,
    message: string,
  ) {
    super(`learn ${group}: ${message}`);
    this.name = "LearnError";
  }
}

export type Dropped = { readonly reason: string; readonly detail: string };

export type GateContext = {
  readonly runId: string;
  readonly now: string;
  readonly minSessions: number;
  readonly minDays: number;
  /** Fingerprint → sessions the Ledger counted when it last rejected it. */
  readonly rejected: ReadonlyMap<string, number>;
  readonly pending: ReadonlySet<string>;
};

export type GateResult = {
  readonly proposals: readonly ProposalInsert[];
  readonly dropped: readonly Dropped[];
  readonly usedNoteIds: readonly string[];
};

const STYLE_PATTERNS: readonly RegExp[] = [
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/,
  /\bv\d+(?:\.\d+)+\b/,
  /\b(?:currently|no longer|replaced by|as of now|nowadays|recently)\b/i,
];

const EVERY_REPO =
  /\b(tous les (dépôts|depots|projets|repos)|partout|every (repo|repository|project)|all (repos|repositories|projects)|dans tous les cas)\b/i;

const NEW_RULE_FILE = /\/\.claude\/rules\/[^/]+\.md$/;

const EVIDENCE_PER_PROPOSAL = 8;

export function styleViolation(change: Change): string | null {
  if (change.kind !== "edit") {
    return null;
  }

  for (const edit of change.edits) {
    const oldLines = new Set(edit.oldText.split("\n"));

    for (const line of edit.newText.split("\n").filter((added) => !oldLines.has(added))) {
      const match = STYLE_PATTERNS.map((pattern) => pattern.exec(line)?.[0]).find((found) => found !== undefined);

      if (match !== undefined) {
        return match;
      }
    }
  }

  return null;
}

function occurrences(text: string, needle: string): number {
  let count = 0;

  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    count += 1;
  }

  return count;
}

export function prevalenceOf(notes: readonly NoteView[], fallbackAt: string): Prevalence {
  const timestamps = notes.map((note) => note.at).toSorted();

  return {
    sessions: new Set(notes.map((note) => note.sessionId)).size,
    days: new Set(timestamps.map(utcDay)).size,
    repos: new Set(notes.flatMap((note) => (note.repoRoot === null ? [] : [note.repoRoot]))).size,
    firstAt: timestamps[0] ?? fallbackAt,
    lastAt: timestamps.at(-1) ?? fallbackAt,
  };
}

type Target =
  | { readonly kind: "existing"; readonly file: RuleFile; readonly text: string }
  | { readonly kind: "new"; readonly path: string; readonly repoRoot: string };

function resolveTarget(candidate: Candidate, group: LearnGroup): Target | Dropped {
  const known = group.rules.find((rule) => rule.file.sourcePath === candidate.targetPath);

  if (known !== undefined) {
    return { kind: "existing", file: known.file, text: known.text };
  }

  if (candidate.change.kind !== "edit") {
    return { reason: "unknown-target", detail: candidate.targetPath };
  }

  const [edit, ...rest] = candidate.change.edits;
  const creates = edit !== undefined && rest.length === 0 && edit.oldText === "" && edit.newText.trim() !== "";

  if (!creates) {
    return { reason: "unknown-target", detail: candidate.targetPath };
  }

  const roots = [group.repoRoot, ...group.notes.map((note) => note.repoRoot)].filter(
    (root): root is string => root !== null,
  );

  const root = roots
    .filter((candidateRoot) => candidate.targetPath.startsWith(`${candidateRoot}/`))
    .toSorted((a, b) => b.length - a.length)[0];

  if (root === undefined || !NEW_RULE_FILE.test(candidate.targetPath)) {
    return { reason: "new-file-outside-rules", detail: candidate.targetPath };
  }

  return { kind: "new", path: candidate.targetPath, repoRoot: root };
}

function editApplies(change: Change, text: string): Dropped | null {
  if (change.kind !== "edit") {
    return null;
  }

  if (change.edits.length === 0) {
    return { reason: "empty-edit", detail: "" };
  }

  let current = text;

  for (const edit of change.edits) {
    const count = edit.oldText === "" ? 0 : occurrences(current, edit.oldText);

    if (count !== 1) {
      return { reason: count === 0 ? "old-text-not-found" : "old-text-ambiguous", detail: edit.oldText.slice(0, 80) };
    }

    current = current.replace(edit.oldText, () => edit.newText);
  }

  return null;
}

function sharesEvidence(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  const smaller = Math.min(a.size, b.size);

  return smaller > 0 && [...a].filter((id) => b.has(id)).length * 2 >= smaller;
}

/** Principle 5: recurrence, or one session with strong evidence of its own. */
export function passesThreshold(
  candidate: Candidate,
  notes: readonly NoteView[],
  prevalence: Prevalence,
  cited: readonly RuleFile[],
  context: GateContext,
): boolean {
  if (prevalence.sessions >= context.minSessions && prevalence.days >= context.minDays) {
    return true;
  }

  if (notes.some((note) => note.kind === "steer" && note.isExplicit)) {
    return true;
  }

  const loadedPaths = new Set(cited.map((file) => file.loadedPath));

  const loadedConflict =
    candidate.verdict === "conflict" && notes.some((note) => note.loadedRules.some((path) => loadedPaths.has(path)));

  if (loadedConflict) {
    return true;
  }

  return candidate.singleSessionJustification !== null && notes.some((note) => note.kind === "observation");
}

/** Every rule here is code; the model only proposed. An unknown id fails the whole answer. */
export function gateLearn(group: LearnGroup, output: LearnOutput, context: GateContext): GateResult {
  const notesById = new Map(group.notes.map((note) => [note.id, note]));

  const bullets = new Map(
    group.rules.flatMap((rule) => rule.file.bullets.map((bullet) => [bullet.id, rule.file] as const)),
  );

  output.candidates.forEach((candidate, index) => {
    for (const id of candidate.noteIds) {
      if (!notesById.has(id)) {
        throw new LearnError(group.key, `candidates[${index}] cites unknown note ${JSON.stringify(id)}`);
      }
    }

    for (const id of candidate.ruleBulletIds) {
      if (!bullets.has(id)) {
        throw new LearnError(group.key, `candidates[${index}] cites unknown bullet ${JSON.stringify(id)}`);
      }
    }
  });

  const dropped: Dropped[] = [];
  const accepted: Array<{ proposal: ProposalInsert; members: ReadonlySet<string>; noteIds: readonly string[] }> = [];
  const seen = new Set<string>();

  for (const candidate of output.candidates) {
    const notes = [...new Set(candidate.noteIds)]
      .map((id) => notesById.get(id))
      .filter((note): note is NoteView => note !== undefined);

    if (notes.length === 0) {
      dropped.push({ reason: "no-evidence", detail: candidate.lessonEn });
      continue;
    }

    if (candidate.isWatchTask) {
      dropped.push({ reason: "watch-task", detail: candidate.lessonEn });
      continue;
    }

    if (candidate.verdict === "hold") {
      dropped.push({ reason: "hold", detail: candidate.lessonEn });
      continue;
    }

    const cited = [
      ...new Set(
        candidate.ruleBulletIds.map((id) => bullets.get(id)).filter((file): file is RuleFile => file !== undefined),
      ),
    ];

    if (
      (candidate.verdict === "ignored" ||
        candidate.verdict === "misplaced" ||
        candidate.verdict === "conflict" ||
        candidate.verdict === "unclear") &&
      cited.length === 0
    ) {
      dropped.push({ reason: `${candidate.verdict}-without-rule`, detail: candidate.lessonEn });
      continue;
    }

    const prevalence = prevalenceOf(notes, context.now);

    if (!passesThreshold(candidate, notes, prevalence, cited, context)) {
      dropped.push({
        reason: "below-threshold",
        detail: `${candidate.lessonEn} (${prevalence.sessions} sessions, ${prevalence.days} days)`,
      });
      continue;
    }

    const target = resolveTarget(candidate, group);

    if ("reason" in target) {
      dropped.push(target);
      continue;
    }

    const scope = target.kind === "existing" ? target.file.scope : "path";

    if (group.repoRoot === null && group.notes.some((note) => note.repoRoot !== null) && scope !== "global") {
      dropped.push({ reason: "global-group-repo-target", detail: candidate.lessonEn });
      continue;
    }

    if (scope === "global") {
      const statedForAll = notes.some((note) => note.kind === "steer" && note.isExplicit && EVERY_REPO.test(note.text));

      if (prevalence.repos < 2 && !statedForAll) {
        dropped.push({ reason: "global-one-repo", detail: candidate.lessonEn });
        continue;
      }
    }

    const style = styleViolation(candidate.change);

    if (style !== null) {
      dropped.push({ reason: "style", detail: style });
      continue;
    }

    const applies = target.kind === "existing" ? editApplies(candidate.change, target.text) : null;

    if (applies !== null) {
      dropped.push(applies);
      continue;
    }

    const targetPath = target.kind === "existing" ? target.file.sourcePath : target.path;
    const print = fingerprint(targetPath, candidate.lessonEn);
    const rejectedAt = context.rejected.get(print);

    if (rejectedAt !== undefined && prevalence.sessions <= rejectedAt) {
      dropped.push({ reason: "ledger-rejected", detail: candidate.lessonEn });
      continue;
    }

    if (context.pending.has(print) || seen.has(print)) {
      dropped.push({ reason: "already-proposed", detail: candidate.lessonEn });
      continue;
    }

    seen.add(print);

    const evidence: Evidence[] = notes
      .toSorted((a, b) => b.at.localeCompare(a.at))
      .slice(0, EVIDENCE_PER_PROPOSAL)
      .map((note) => ({
        evidenceId: note.evidenceId,
        kind: note.kind === "steer" ? "quote" : "observation",
        at: note.at,
        sessionId: note.sessionId,
        text: note.text,
        tool: note.tool,
      }));

    accepted.push({
      proposal: {
        id: newId(),
        fingerprint: print,
        createdAt: context.now,
        source: "learn",
        targetPath,
        repoRoot: target.kind === "existing" ? target.file.repoRoot : target.repoRoot,
        scope,
        verdict: candidate.verdict,
        claimFr: candidate.claimFr,
        reasoningFr: candidate.reasoningFr,
        lessonEn: candidate.lessonEn,
        subjectEn: candidate.subjectEn.slice(0, 72),
        change: candidate.change,
        evidence,
        prevalence,
        bulletId: candidate.ruleBulletIds[0] ?? null,
        learnRunId: context.runId,
      },
      members: new Set(notes.map((note) => note.id)),
      noteIds: notes.map((note) => note.id),
    });
  }

  const kept: typeof accepted = [];

  for (const entry of accepted.toSorted((a, b) => b.proposal.prevalence.sessions - a.proposal.prevalence.sessions)) {
    if (kept.some((other) => sharesEvidence(entry.members, other.members))) {
      dropped.push({ reason: "duplicate-evidence", detail: entry.proposal.lessonEn });
    } else {
      kept.push(entry);
    }
  }

  return {
    proposals: kept.map((entry) => entry.proposal),
    dropped,
    usedNoteIds: [...new Set(kept.flatMap((entry) => entry.noteIds))],
  };
}
