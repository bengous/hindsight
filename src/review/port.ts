import type { HindsightConfig } from "../domain/config.ts";
import type { ProposalState } from "../domain/proposal.ts";
import type { ApplyResult, TextEdit } from "../rules/apply.ts";
import type { StoreError, StoreService, SyncStore } from "../store/db.ts";
import type { Change, Evidence, Prevalence, ProposalRow } from "../store/queries.ts";

import { Effect, Schema } from "effect";
import { existsSync, readFileSync } from "node:fs";

import { nextProposalState } from "../domain/proposal.ts";
import { redactSecrets } from "../domain/redact.ts";
import { ChangeSchema } from "../learn/schema.ts";
import { applyChange, editedText } from "../rules/apply.ts";
import { newId } from "../rules/ids.ts";
import { Store } from "../store/db.ts";

/** One Proposal as the Review shows it; the surface (pane today, a page later) only draws it. */
export type ReviewItem = {
  readonly id: string;
  readonly state: ProposalState;
  readonly source: string;
  readonly targetPath: string;
  readonly repoRoot: string | null;
  readonly scope: string;
  readonly verdict: string | null;
  readonly claimFr: string;
  readonly reasoningFr: string;
  readonly lessonEn: string;
  readonly subjectEn: string;
  readonly change: Change;
  readonly evidence: readonly ReviewEvidence[];
  readonly prevalence: Prevalence;
  readonly createdAt: string;
};

export type ReviewEvidence = Evidence & {
  /** The whole Human Message a Quote comes from, secrets masked; null for an Observation. */
  readonly message: string | null;
};

export type Decision =
  | { readonly kind: "accept"; readonly edits: readonly TextEdit[] | null }
  | { readonly kind: "reject"; readonly reason: string }
  | { readonly kind: "handoff" };

export type DecisionOutcome =
  | { readonly kind: "accepted"; readonly apply: ApplyResult }
  | { readonly kind: "rejected" }
  | { readonly kind: "handed_off" }
  | { readonly kind: "refused"; readonly reason: string };

export type ReviewPass = {
  readonly items: readonly ReviewItem[];
  readonly pending: number;
  readonly expired: number;
  readonly superseded: number;
};

export type PreparedHandoff = {
  readonly id: string | null;
  readonly instructions: string | null;
  readonly proposals: number;
};

export type ReadFile = (path: string) => string | null;

export const readFileOrNull: ReadFile = (path) => (existsSync(path) ? readFileSync(path, "utf8") : null);

const EvidenceSchema = Schema.Struct({
  evidenceId: Schema.String,
  kind: Schema.Literals(["quote", "observation"]),
  at: Schema.String,
  sessionId: Schema.String,
  text: Schema.String,
  tool: Schema.NullOr(Schema.String),
});

const PrevalenceSchema = Schema.Struct({
  sessions: Schema.Int,
  days: Schema.Int,
  repos: Schema.Int,
  firstAt: Schema.String,
  lastAt: Schema.String,
});

const decodeState = Schema.decodeUnknownSync(
  Schema.Literals(["pending", "accepted", "handed_off", "rejected", "superseded", "expired"]),
);

const decodeChange = Schema.decodeSync(Schema.fromJsonString(ChangeSchema));

const decodeEvidence = Schema.decodeSync(Schema.fromJsonString(Schema.Array(EvidenceSchema)));

const decodePrevalence = Schema.decodeSync(Schema.fromJsonString(PrevalenceSchema));

export function toReviewItem(row: ProposalRow, db: SyncStore): ReviewItem {
  const evidence = decodeEvidence(row.evidence_json).map((item): ReviewEvidence => {
    const message =
      item.kind === "quote"
        ? (db.get<{ text: string }>("SELECT text FROM messages WHERE evidence_id = ?", [item.evidenceId])?.text ?? null)
        : null;

    return {
      evidenceId: item.evidenceId,
      kind: item.kind,
      at: item.at,
      sessionId: item.sessionId,
      text: redactSecrets(item.text),
      tool: item.tool,
      message: message === null ? null : redactSecrets(message),
    };
  });

  return {
    id: row.id,
    state: decodeState(row.state),
    source: row.source,
    targetPath: row.target_path,
    repoRoot: row.repo_root,
    scope: row.scope,
    verdict: row.verdict,
    claimFr: row.claim_fr,
    reasoningFr: row.reasoning_fr,
    lessonEn: row.lesson_en,
    subjectEn: row.subject_en,
    change: decodeChange(row.change_json),
    evidence,
    prevalence: decodePrevalence(row.prevalence_json),
    createdAt: row.created_at,
  };
}

function setState(db: SyncStore, id: string, state: ProposalState): void {
  db.run("UPDATE proposals SET state = ? WHERE id = ?", [state, id]);
}

type Settled = { readonly expired: number; readonly superseded: number };

/** An edit whose old text no longer applies expires; of two pending Proposals on the same text, the newer stays. */
export function settlePending(db: SyncStore, readFile: ReadFile): Settled {
  const rows = db.all<ProposalRow>("SELECT * FROM proposals WHERE state = 'pending' ORDER BY created_at DESC");
  let expired = 0;
  let superseded = 0;
  const seen = new Set<string>();

  for (const row of rows) {
    const change = decodeChange(row.change_json);
    const key = `${row.target_path}\0${row.bullet_id ?? (change.kind === "edit" ? (change.edits[0]?.oldText ?? "") : row.id)}`;

    if (seen.has(key)) {
      setState(db, row.id, "superseded");
      superseded += 1;
      continue;
    }

    seen.add(key);

    if (change.kind === "edit" && change.edits[0]?.oldText !== "") {
      const text = readFile(row.target_path);

      if (text === null || editedText(text, change.edits).kind === "refused") {
        setState(db, row.id, "expired");
        expired += 1;
      }
    }
  }

  return { expired, superseded };
}

/** The pending Proposals of one Review pass: by Prevalence, then by age, `pageSize` at most. */
export const listReview = (
  config: HindsightConfig,
  readFile: ReadFile = readFileOrNull,
): Effect.Effect<ReviewPass, StoreError, Store> =>
  Effect.gen(function* () {
    const store = yield* Store;

    return yield* store.transaction((db) => {
      const settled = settlePending(db, readFile);
      const rows = db.all<ProposalRow>("SELECT * FROM proposals WHERE state = 'pending'");

      const items = rows
        .map((row) => toReviewItem(row, db))
        .toSorted((a, b) => b.prevalence.sessions - a.prevalence.sessions || a.createdAt.localeCompare(b.createdAt))
        .slice(0, config.review.pageSize);

      const pending = rows.length;

      return { items, pending, ...settled };
    });
  });

function recordDecision(
  db: SyncStore,
  item: ReviewItem,
  decision: "accepted" | "rejected" | "handed_off",
  details: { reason: string | null; edits: readonly TextEdit[] | null; commit: string | null },
  at: string,
): void {
  db.run(
    "INSERT INTO decisions (proposal_id, fingerprint, at, decision, reason, edited_change_json, sessions_at_decision, commit_sha) VALUES (?, (SELECT fingerprint FROM proposals WHERE id = ?), ?, ?, ?, ?, ?, ?)",
    [
      item.id,
      item.id,
      at,
      decision,
      details.reason,
      details.edits === null ? null : JSON.stringify({ kind: "edit", edits: details.edits }),
      item.prevalence.sessions,
      details.commit,
    ],
  );
  setState(db, item.id, decision);
}

const loadPending = (store: StoreService, id: string): Effect.Effect<ReviewItem | null, StoreError> =>
  store.transaction((db) => {
    const row = db.get<ProposalRow>("SELECT * FROM proposals WHERE id = ?", [id]);

    return row === null ? null : toReviewItem(row, db);
  });

/** The texts a commit message must not hold: the evidence and the cited messages, before any masking. */
function rawExcerpts(db: SyncStore, row: ProposalRow): string[] {
  const evidence = decodeEvidence(row.evidence_json);

  const messages = evidence
    .filter((item) => item.kind === "quote")
    .flatMap((item) => {
      const found = db.get<{ text: string }>("SELECT text FROM messages WHERE evidence_id = ?", [item.evidenceId]);

      return found === null ? [] : [found.text];
    });

  return [...evidence.map((item) => item.text), ...messages];
}

type ReservedAccept = { readonly item: ReviewItem; readonly excerpts: readonly string[] };

/** Takes the Proposal for this accept before any file changes: a second accept, concurrent or later, finds it taken. */
const reserveAccept = (
  store: StoreService,
  id: string,
  nowIso: string,
): Effect.Effect<ReservedAccept | null, StoreError> =>
  store.transaction((db) => {
    const row = db.get<ProposalRow>("SELECT * FROM proposals WHERE id = ? AND state = 'pending'", [id]);

    if (row === null) {
      return null;
    }

    const item = toReviewItem(row, db);
    recordDecision(db, item, "accepted", { reason: null, edits: null, commit: null }, nowIso);

    return { item, excerpts: rawExcerpts(db, row) };
  });

const releaseAccept = (store: StoreService, id: string): Effect.Effect<void, StoreError> =>
  store.transaction((db) => {
    db.run("DELETE FROM decisions WHERE proposal_id = ? AND decision = 'accepted' AND commit_sha IS NULL", [id]);
    setState(db, id, "pending");
  });

/** The one place a Decision is taken: accept applies and commits, reject needs a reason, handoff marks. */
export const decideProposal = (
  id: string,
  decision: Decision,
  nowIso: string = new Date().toISOString(),
): Effect.Effect<DecisionOutcome, StoreError, Store> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const item = yield* loadPending(store, id);

    if (item === null) {
      return { kind: "refused", reason: `no proposal ${id}` } satisfies DecisionOutcome;
    }

    if (nextProposalState(item.state, decision.kind) === null) {
      return { kind: "refused", reason: `proposal is ${item.state}` } satisfies DecisionOutcome;
    }

    switch (decision.kind) {
      case "reject": {
        if (decision.reason.trim() === "") {
          return { kind: "refused", reason: "a rejection needs a reason" } satisfies DecisionOutcome;
        }

        yield* store.transaction((db) =>
          recordDecision(db, item, "rejected", { reason: decision.reason.trim(), edits: null, commit: null }, nowIso),
        );

        return { kind: "rejected" } satisfies DecisionOutcome;
      }

      case "handoff": {
        yield* store.transaction((db) =>
          recordDecision(db, item, "handed_off", { reason: null, edits: null, commit: null }, nowIso),
        );

        return { kind: "handed_off" } satisfies DecisionOutcome;
      }

      case "accept": {
        if (item.change.kind !== "edit") {
          return {
            kind: "refused",
            reason: "a description can only be handed off or rejected",
          } satisfies DecisionOutcome;
        }

        const edits = decision.edits ?? item.change.edits;
        const reserved = yield* reserveAccept(store, id, nowIso);

        if (reserved === null) {
          return { kind: "refused", reason: "proposal is no longer pending" } satisfies DecisionOutcome;
        }

        const apply = yield* Effect.promise(async () =>
          applyChange({
            proposalId: item.id,
            targetPath: item.targetPath,
            repoRoot: item.repoRoot,
            edits,
            subject: item.subjectEn,
            lesson: item.lessonEn,
            prevalence: item.prevalence,
            excerpts: reserved.excerpts,
          }),
        );

        if (apply.kind === "refused") {
          yield* releaseAccept(store, id);

          return { kind: "refused", reason: `${apply.reason}: ${apply.detail}` } satisfies DecisionOutcome;
        }

        yield* store.transaction((db) =>
          db.run(
            "UPDATE decisions SET commit_sha = ?, edited_change_json = ? WHERE proposal_id = ? AND decision = 'accepted'",
            [
              apply.kind === "committed" ? apply.commit : `written:${apply.path}`,
              decision.edits === null ? null : JSON.stringify({ kind: "edit", edits: decision.edits }),
              id,
            ],
          ),
        );

        return { kind: "accepted", apply } satisfies DecisionOutcome;
      }

      default: {
        return { kind: "refused", reason: "unknown decision" } satisfies DecisionOutcome;
      }
    }
  });

function changeInstructions(item: ReviewItem): string {
  if (item.change.kind === "description") {
    return item.change.text;
  }

  return item.change.edits
    .map((edit) =>
      edit.oldText === ""
        ? `Create the file with:\n${edit.newText}`
        : `Replace:\n${edit.oldText}\nwith:\n${edit.newText}`,
    )
    .join("\n\n");
}

/** The Handoff's instructions: targets, claims, lessons and changes, never a Quote (principle 7). */
export const prepareHandoff = (
  nowIso: string = new Date().toISOString(),
): Effect.Effect<PreparedHandoff, StoreError, Store> =>
  Effect.gen(function* () {
    const store = yield* Store;

    return yield* store.transaction((db) => {
      const rows = db.all<ProposalRow>(
        `SELECT * FROM proposals WHERE state = 'handed_off' AND id NOT IN (
           SELECT value FROM handoffs, json_each(handoffs.proposal_ids_json)
         ) ORDER BY created_at`,
      );

      if (rows.length === 0) {
        return { id: null, instructions: null, proposals: 0 };
      }

      const items = rows.map((row) => toReviewItem(row, db));

      const sections = items.map(
        (item, index) =>
          `## ${index + 1}. ${item.targetPath}\n\n${item.claimFr}\n\nLesson: ${item.lessonEn}\n\n${changeInstructions(item)}`,
      );

      const instructions = [
        "hindsight handoff: apply the following Rule File changes, one commit per file, without pushing. Each change was reviewed by the human; carry it out as written and say what you changed.",
        "",
        ...sections,
      ].join("\n");

      const id = newId();
      db.run("INSERT INTO handoffs (id, created_at, proposal_ids_json, instructions) VALUES (?, ?, ?, ?)", [
        id,
        nowIso,
        JSON.stringify(items.map((item) => item.id)),
        instructions,
      ]);

      return { id, instructions, proposals: items.length };
    });
  });
