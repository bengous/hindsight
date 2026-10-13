import type { HindsightConfig } from "../domain/config.ts";
import type { DebriefNotes, ObservationNote, StaleRuleNote, SteerNote } from "../domain/debrief.ts";
import type { SyncStore } from "../store/db.ts";
import type { Evidence } from "../store/queries.ts";
import type { HumanEvent, SessionRecord, ToolEvent } from "../transcripts/session.ts";

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname } from "node:path";

import { parseDebrief } from "../domain/debrief.ts";
import { collapseWhitespace, containsVerbatim } from "../domain/text.ts";
import { gitToplevelSync } from "../rules/git.ts";
import { fingerprint, newId } from "../rules/ids.ts";
import {
  finishDebrief,
  getDebrief,
  insertNote,
  insertProposal,
  pendingProposalByFingerprint,
  rejectedSessions,
  upsertMessage,
} from "../store/queries.ts";
import { absolutePath, editedPath, editedText, humanEvents, toolEvents } from "../transcripts/session.ts";

export type RecordInput = {
  readonly id: string;
  readonly sessionId: string;
  readonly cacheShare: number;
  readonly durationMs: number;
  readonly text: string;
  readonly repoRoot: string | null;
};

export type RejectReason =
  | "quote-missing"
  | "quote-from-tool"
  | "observation-missing"
  | "stale-edit-missing"
  | "stale-file-changed"
  | "stale-rule-text"
  | "ledger-rejected";

export type RecordOutcome = {
  readonly id: string;
  readonly status: "recorded" | "failed";
  readonly failure: string | null;
  readonly notes: { readonly steers: number; readonly observations: number; readonly staleRules: number };
  readonly proposals: number;
  readonly rejected: Readonly<Record<string, number>>;
};

export type RecordDeps = {
  readonly now: () => string;
  readonly readFile: (path: string) => string | null;
  /** The checkout that holds a Rule File, or null for a file outside any checkout. */
  readonly repoOf: (path: string) => string | null;
};

export const defaultRecordDeps: RecordDeps = {
  now: () => new Date().toISOString(),
  readFile: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
  repoOf: (path) => (existsSync(dirname(path)) ? gitToplevelSync(dirname(path)) : null),
};

const MIN_EXCERPT = 12;

class Rejections {
  readonly counts: Record<string, number> = {};
  add(reason: RejectReason): void {
    this.counts[reason] = (this.counts[reason] ?? 0) + 1;
  }
}

/** The earliest Human Message that holds `quote` word for word; the human repeats, the first time is cited. */
export function locateQuote(humans: readonly HumanEvent[], quote: string): HumanEvent | null {
  return humans.find((human) => containsVerbatim(human.text, quote)) ?? null;
}

export function locateObservation(tools: readonly ToolEvent[], note: ObservationNote): ToolEvent | null {
  const needle = collapseWhitespace(note.excerpt);

  if (needle.length < MIN_EXCERPT) {
    return null;
  }

  return (
    tools.find(
      (tool) =>
        tool.tool === note.tool &&
        (collapseWhitespace(tool.inputText).includes(needle) || collapseWhitespace(tool.outputText).includes(needle)),
    ) ?? null
  );
}

function sameFile(candidate: string, cited: string, cwd: string | null): boolean {
  const absolute = absolutePath(cited, cwd);

  return candidate === absolute || basename(candidate) === cited || candidate.endsWith(`/${cited}`);
}

export function locateEdit(tools: readonly ToolEvent[], note: StaleRuleNote, cwd: string | null): ToolEvent | null {
  const needle = collapseWhitespace(note.editedExcerpt);

  if (needle.length < MIN_EXCERPT) {
    return null;
  }

  return (
    tools.find((tool) => {
      if (tool.isError || tool.isRefused) {
        return false;
      }

      const path = editedPath(tool);
      const text = editedText(tool);

      if (path === null || text === null) {
        return false;
      }

      return sameFile(absolutePath(path, cwd), note.editedPath, cwd) && collapseWhitespace(text).includes(needle);
    }) ?? null
  );
}

function occurrences(text: string, needle: string): number {
  let count = 0;

  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    count += 1;
  }

  return count;
}

function resolveRuleFile(note: StaleRuleNote, session: SessionRecord): string {
  const loaded = session.loadedRules.find(
    (rule) => rule.path === note.ruleFile || rule.path.endsWith(`/${note.ruleFile}`),
  );

  return loaded?.path ?? absolutePath(note.ruleFile, session.cwd);
}

type Context = {
  readonly db: SyncStore;
  readonly loadedRules: readonly string[];
  readonly deps: RecordDeps;
  readonly config: HindsightConfig;
  readonly session: SessionRecord;
  readonly input: RecordInput;
  readonly at: string;
  readonly rejections: Rejections;
};

function storeSteer(
  ctx: Context,
  note: SteerNote,
  humans: readonly HumanEvent[],
  tools: readonly ToolEvent[],
): boolean {
  const human = locateQuote(humans, note.quote);

  if (human === null) {
    const needle = collapseWhitespace(note.quote);
    const fromTool = tools.some((tool) => collapseWhitespace(tool.outputText).includes(needle));
    ctx.rejections.add(fromTool ? "quote-from-tool" : "quote-missing");

    return false;
  }

  const evidenceId = `${human.sessionId}:${human.uuid}`;
  upsertMessage(ctx.db, {
    evidenceId,
    sessionId: ctx.input.sessionId,
    at: human.timestamp,
    repoRoot: ctx.input.repoRoot,
    text: human.text,
  });
  insertNote(ctx.db, {
    id: newId(),
    debriefId: ctx.input.id,
    sessionId: ctx.input.sessionId,
    repoRoot: ctx.input.repoRoot,
    at: human.timestamp,
    kind: "steer",
    status: "pending",
    evidenceId,
    lesson: note.lesson,
    body: { quote: note.quote, habit: note.habit },
    loadedRules: ctx.loadedRules,
  });

  return true;
}

function storeObservation(ctx: Context, note: ObservationNote, tools: readonly ToolEvent[]): boolean {
  const tool = locateObservation(tools, note);

  if (tool === null) {
    ctx.rejections.add("observation-missing");

    return false;
  }

  insertNote(ctx.db, {
    id: newId(),
    debriefId: ctx.input.id,
    sessionId: ctx.input.sessionId,
    repoRoot: ctx.input.repoRoot,
    at: tool.timestamp,
    kind: "observation",
    status: "pending",
    evidenceId: `${tool.sessionId}:${tool.uuid}`,
    lesson: note.lesson,
    body: { question: note.question, tool: note.tool, excerpt: note.excerpt, rulePath: note.rulePath },
    loadedRules: ctx.loadedRules,
  });

  return true;
}

function storeStaleRule(
  ctx: Context,
  note: StaleRuleNote,
  tools: readonly ToolEvent[],
): { note: boolean; proposal: boolean } {
  const edit = locateEdit(tools, note, ctx.session.cwd);

  if (edit === null) {
    ctx.rejections.add("stale-edit-missing");

    return { note: false, proposal: false };
  }

  const editedFile = absolutePath(editedPath(edit) ?? note.editedPath, ctx.session.cwd);
  const current = ctx.deps.readFile(editedFile);

  if (current === null || !collapseWhitespace(current).includes(collapseWhitespace(note.editedExcerpt))) {
    ctx.rejections.add("stale-file-changed");

    return { note: false, proposal: false };
  }

  const ruleFile = resolveRuleFile(note, ctx.session);
  const ruleText = ctx.deps.readFile(ruleFile);

  if (ruleText === null || occurrences(ruleText, note.oldText) !== 1) {
    ctx.rejections.add("stale-rule-text");

    return { note: false, proposal: false };
  }

  const print = fingerprint(ruleFile, note.lesson);

  if (rejectedSessions(ctx.db, print) !== null) {
    ctx.rejections.add("ledger-rejected");

    return { note: false, proposal: false };
  }

  const evidenceId = `${edit.sessionId}:${edit.uuid}`;
  insertNote(ctx.db, {
    id: newId(),
    debriefId: ctx.input.id,
    sessionId: ctx.input.sessionId,
    repoRoot: ctx.input.repoRoot,
    at: edit.timestamp,
    kind: "stale_rule",
    status: "used",
    evidenceId,
    lesson: note.lesson,
    body: {
      editedPath: editedFile,
      editedExcerpt: note.editedExcerpt,
      ruleFile,
      oldText: note.oldText,
      newText: note.newText,
    },
    loadedRules: ctx.loadedRules,
  });

  if (pendingProposalByFingerprint(ctx.db, print) !== null) {
    return { note: true, proposal: false };
  }

  const evidence: Evidence[] = [
    {
      evidenceId,
      kind: "observation",
      at: edit.timestamp,
      sessionId: ctx.input.sessionId,
      text: note.editedExcerpt,
      tool: edit.tool,
    },
  ];

  const ruleRepo =
    ctx.input.repoRoot !== null && ruleFile.startsWith(`${ctx.input.repoRoot}/`)
      ? ctx.input.repoRoot
      : ctx.deps.repoOf(ruleFile);

  const isGlobal = ruleRepo === null;
  insertProposal(ctx.db, {
    id: newId(),
    fingerprint: print,
    createdAt: ctx.at,
    source: "debrief",
    targetPath: ruleFile,
    repoRoot: ruleRepo,
    scope: isGlobal ? "global" : "repo",
    verdict: null,
    claimFr: `La règle « ${collapseWhitespace(note.oldText).slice(0, 120)} » ne correspond plus au code après l'édition de ${basename(editedFile)}.`,
    reasoningFr: `Le Debrief a signalé cette règle comme périmée ; le code a retrouvé l'édition (${edit.tool}) dans la session, confirmé que ${basename(editedFile)} contient toujours le nouveau texte, et trouvé l'ancien texte une seule fois dans ${basename(ruleFile)}.`,
    lessonEn: note.lesson,
    subjectEn: `Update ${basename(ruleFile)} after ${basename(editedFile)} changed`,
    change: { kind: "edit", edits: [{ oldText: note.oldText, newText: note.newText }] },
    evidence,
    prevalence: {
      sessions: 1,
      days: 1,
      repos: ctx.input.repoRoot === null ? 0 : 1,
      firstAt: edit.timestamp,
      lastAt: edit.timestamp,
    },
    bulletId: null,
    learnRunId: null,
  });

  return { note: true, proposal: true };
}

function storeNotes(ctx: Context, notes: DebriefNotes): RecordOutcome["notes"] & { proposals: number } {
  const humans = humanEvents(ctx.session);
  const tools = toolEvents(ctx.session);
  let steers = 0;
  let observations = 0;
  let staleRules = 0;
  let proposals = 0;

  for (const note of notes.steers) {
    if (storeSteer(ctx, note, humans, tools)) {
      steers += 1;
    }
  }

  for (const note of notes.observations) {
    if (storeObservation(ctx, note, tools)) {
      observations += 1;
    }
  }

  for (const note of notes.staleRules) {
    const stored = storeStaleRule(ctx, note, tools);

    if (stored.note) {
      staleRules += 1;
    }

    if (stored.proposal) {
      proposals += 1;
    }
  }

  return { steers, observations, staleRules, proposals };
}

/** Verifies and stores a Debrief's answer inside one transaction; the debrief row always ends recorded or failed. */
export function recordDebrief(
  db: SyncStore,
  config: HindsightConfig,
  session: SessionRecord | null,
  input: RecordInput,
  deps: RecordDeps = defaultRecordDeps,
): RecordOutcome {
  const at = deps.now();
  const row = getDebrief(db, input.id);

  if (row === null) {
    throw new Error(`debrief ${input.id} not found`);
  }

  if (row.status !== "started") {
    throw new Error(`debrief ${input.id} is already ${row.status}`);
  }

  const rejections = new Rejections();

  const fail = (failure: string): RecordOutcome => {
    finishDebrief(db, {
      id: input.id,
      status: "failed",
      at,
      cacheShare: input.cacheShare,
      durationMs: input.durationMs,
      failure,
      rejected: {},
      answer: input.text,
    });

    return {
      id: input.id,
      status: "failed",
      failure,
      notes: { steers: 0, observations: 0, staleRules: 0 },
      proposals: 0,
      rejected: {},
    };
  };

  if (input.cacheShare < config.gate.minCacheShare) {
    return fail(`cache:${input.cacheShare.toFixed(2)}`);
  }

  if (session === null) {
    return fail("session-not-found");
  }

  const parsed = parseDebrief(input.text);

  if (!parsed.ok) {
    return fail(`parse:${parsed.reason}:${parsed.detail}`);
  }

  const ctx: Context = {
    db,
    deps,
    config,
    session,
    input,
    at,
    rejections,
    loadedRules: session.loadedRules.map((rule) => rule.path),
  };

  const { proposals, ...notes } = storeNotes(ctx, parsed.notes);
  finishDebrief(db, {
    id: input.id,
    status: "recorded",
    at,
    cacheShare: input.cacheShare,
    durationMs: input.durationMs,
    failure: null,
    rejected: rejections.counts,
    answer: input.text,
  });

  return { id: input.id, status: "recorded", failure: null, notes, proposals, rejected: rejections.counts };
}
