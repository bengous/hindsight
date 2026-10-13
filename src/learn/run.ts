import type { HindsightConfig } from "../domain/config.ts";
import type { InventoryEnv } from "../rules/inventory.ts";
import type { RuleFile } from "../rules/types.ts";
import type { StoreError, StoreService } from "../store/db.ts";
import type { HistoryEntry, NoteRow } from "../store/queries.ts";
import type { ModelAnswer, ModelRequest } from "./claude.ts";
import type { GateContext, GateResult } from "./gates.ts";
import type { LearnGroup, NoteView, RuleSource } from "./prompt.ts";

import { Cause, Effect, Schema } from "effect";
import { existsSync } from "node:fs";

import { markersFor } from "../domain/human.ts";
import { newId } from "../rules/ids.ts";
import { inventory } from "../rules/inventory.ts";
import { Store } from "../store/db.ts";
import {
  expireNotes,
  failStaleLearnRuns,
  finishLearnRun,
  insertProposal,
  lastLearnFinishedAt,
  ledgerHistory,
  markNotesUsed,
  pendingFingerprints,
  pendingNotes,
  reserveLearnRun,
} from "../store/queries.ts";
import { ClaudeRunner } from "./claude.ts";
import { LearnError, gateLearn } from "./gates.ts";
import { GLOBAL_GROUP, learnPrompt } from "./prompt.ts";
import { prune } from "./prune.ts";
import { decodeLearnOutput, learnJsonSchema } from "./schema.ts";

export type LearnOptions = { readonly ifDue: boolean; readonly inventoryEnv: InventoryEnv };

export type LearnReport = {
  readonly runId: string | null;
  readonly status: "complete" | "failed" | "skipped";
  readonly reason: string | null;
  readonly groups: number;
  readonly notesRead: number;
  readonly proposals: number;
  readonly pruned: number;
  readonly dropped: Readonly<Record<string, number>>;
  readonly failures: readonly string[];
  readonly costUsd: number;
};

const MIN_SESSIONS = 3;

const MIN_DAYS = 2;

const MIN_CALL_USD = 0.02;

const STALE_RUN_MS = 2 * 60 * 60 * 1000;

const NO_CONTEXT = { isFirstPrompt: false, afterInterrupt: false, rejectedTools: [] } as const;

const decodeSteerBody = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ quote: Schema.String, habit: Schema.Boolean })),
);

const decodeObservationBody = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ question: Schema.Number, tool: Schema.String, excerpt: Schema.String })),
);

const decodeLoadedRules = Schema.decodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const isLearnError = Schema.is(LearnError);

export function toNoteView(row: NoteRow): NoteView | null {
  if (row.kind === "stale_rule") {
    return null;
  }

  const loadedRules = decodeLoadedRules(row.loaded_rules_json);

  if (row.kind === "steer") {
    const body = decodeSteerBody(row.body_json);

    return {
      id: row.id,
      kind: "steer",
      sessionId: row.session_id,
      repoRoot: row.repo_root,
      at: row.at,
      lesson: row.lesson,
      text: body.quote,
      habit: body.habit,
      tool: null,
      question: null,
      loadedRules,
      isExplicit: markersFor(body.quote, NO_CONTEXT).includes("standing_instruction"),
      evidenceId: row.evidence_id,
    };
  }

  const body = decodeObservationBody(row.body_json);

  return {
    id: row.id,
    kind: "observation",
    sessionId: row.session_id,
    repoRoot: row.repo_root,
    at: row.at,
    lesson: row.lesson,
    text: body.excerpt,
    habit: null,
    tool: body.tool,
    question: body.question,
    loadedRules,
    isExplicit: false,
    evidenceId: row.evidence_id,
  };
}

/** One group per repository that has a checkout, plus the global group; each sees the global rules too. */
export function planGroups(
  notes: readonly NoteView[],
  files: readonly RuleFile[],
  history: readonly HistoryEntry[],
): LearnGroup[] {
  const sources = new Map<string, RuleSource>();

  for (const file of files) {
    sources.set(file.sourcePath, { file, text: "" });
  }

  const globalRules = files.filter((file) => file.scope === "global");
  const byRepo = new Map<string, NoteView[]>();

  for (const note of notes) {
    const key = note.repoRoot === null || !existsSync(note.repoRoot) ? GLOBAL_GROUP : note.repoRoot;
    byRepo.set(key, [...(byRepo.get(key) ?? []), note]);
  }

  if (globalRules.length > 0 && new Set(notes.map((note) => note.repoRoot)).size >= 2) {
    byRepo.set(GLOBAL_GROUP, [...notes]);
  }

  return [...byRepo].map(([key, groupNotes]) => {
    const repoRoot = key === GLOBAL_GROUP ? null : key;

    const rules =
      key === GLOBAL_GROUP ? globalRules : [...files.filter((file) => file.repoRoot === repoRoot), ...globalRules];

    const targets = new Set(rules.map((file) => file.sourcePath));

    return {
      key,
      repoRoot,
      notes: groupNotes,
      rules: rules.map((file) => sources.get(file.sourcePath) ?? { file, text: "" }),
      history: history.filter((entry) => targets.has(entry.targetPath)),
    };
  });
}

async function withTexts(groups: readonly LearnGroup[]): Promise<LearnGroup[]> {
  const paths = [...new Set(groups.flatMap((group) => group.rules.map((rule) => rule.file.sourcePath)))];

  const texts = new Map(
    await Promise.all(
      paths.map(async (path): Promise<readonly [string, string]> => [path, await Bun.file(path).text()]),
    ),
  );

  return groups.map((group) => ({
    ...group,
    rules: group.rules.map((rule) => ({ file: rule.file, text: texts.get(rule.file.sourcePath) ?? "" })),
  }));
}

type Reserved = {
  readonly runId: string;
  readonly notes: NoteRow[];
  readonly history: HistoryEntry[];
  readonly pending: Set<string>;
};

type Skipped = { readonly skipped: string };

function reserve(
  store: StoreService,
  config: HindsightConfig,
  ifDue: boolean,
  nowIso: string,
): Effect.Effect<Reserved | Skipped, StoreError> {
  return store.transaction((db): Reserved | Skipped => {
    failStaleLearnRuns(db, nowIso, STALE_RUN_MS);
    const windowStart = new Date(new Date(nowIso).getTime() - config.notes.windowDays * 86_400_000).toISOString();
    expireNotes(db, windowStart);
    const notes = pendingNotes(db, windowStart);

    if (ifDue) {
      if (notes.length < config.learn.pendingNotes) {
        return { skipped: `pending-notes:${notes.length}` };
      }

      const last = lastLearnFinishedAt(db);

      if (last !== null && new Date(nowIso).getTime() - new Date(last).getTime() < config.learn.minIntervalMs) {
        return { skipped: "interval" };
      }
    }

    const runId = reserveLearnRun(db, newId(), nowIso);

    if (runId === null) {
      return { skipped: "running" };
    }

    return { runId, notes, history: ledgerHistory(db), pending: pendingFingerprints(db) };
  });
}

type GroupOutcome =
  | { readonly costUsd: number; readonly failure: string }
  | { readonly costUsd: number; readonly gated: GateResult };

function gateAnswer(group: LearnGroup, answer: ModelAnswer, context: GateContext): GroupOutcome {
  try {
    return { costUsd: answer.costUsd, gated: gateLearn(group, decodeLearnOutput(answer.output), context) };
  } catch (error) {
    if (isLearnError(error)) {
      return { costUsd: answer.costUsd, failure: error.message };
    }

    return {
      costUsd: answer.costUsd,
      failure: `${group.key}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function askGroup(
  runner: ClaudeRunner["Service"],
  request: ModelRequest,
  group: LearnGroup,
  context: GateContext,
): Effect.Effect<GroupOutcome> {
  return runner.run(request).pipe(
    Effect.match({
      onFailure: (error): GroupOutcome => ({
        costUsd: error.costUsd,
        failure: `${group.key}: ${error.kind}: ${error.detail}`,
      }),
      onSuccess: (answer) => gateAnswer(group, answer, context),
    }),
  );
}

/** Learn: pending Notes → one model call per scope → code gates → Proposals. One run at a time. */
export const learn = (
  options: LearnOptions,
  config: HindsightConfig,
  nowIso: string = new Date().toISOString(),
): Effect.Effect<LearnReport, StoreError | Cause.UnknownError, Store | ClaudeRunner> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const runner = yield* ClaudeRunner;
    const reserved = yield* reserve(store, config, options.ifDue, nowIso);

    if ("skipped" in reserved) {
      return {
        runId: null,
        status: "skipped",
        reason: reserved.skipped,
        groups: 0,
        notesRead: 0,
        proposals: 0,
        pruned: 0,
        dropped: {},
        failures: [],
        costUsd: 0,
      } satisfies LearnReport;
    }

    const views = reserved.notes.map(toNoteView).filter((note): note is NoteView => note !== null);

    const repoRoots = [
      ...new Set(views.flatMap((note) => (note.repoRoot !== null && existsSync(note.repoRoot) ? [note.repoRoot] : []))),
    ];

    const dropped: Record<string, number> = {};
    const failures: string[] = [];
    let proposals = 0;
    let costUsd = 0;
    let groups: LearnGroup[] = [];

    const finish = (status: "complete" | "failed", failure: string | null): Effect.Effect<void, StoreError> =>
      store.transaction((db) =>
        finishLearnRun(db, {
          id: reserved.runId,
          at: new Date().toISOString(),
          status,
          notesRead: views.length,
          proposalsWritten: proposals,
          costUsd,
          failure,
        }),
      );

    const files = yield* Effect.tryPromise({
      try: async () => inventory(repoRoots, options.inventoryEnv),
      catch: (cause) => new Cause.UnknownError(cause, cause instanceof Error ? cause.message : String(cause)),
    }).pipe(
      Effect.catch((error) =>
        Effect.flatMap(finish("failed", `inventory: ${error.message}`), () => Effect.fail(error)),
      ),
    );

    groups = yield* Effect.promise(async () => withTexts(planGroups(views, files, reserved.history)));

    const rejected = new Map(
      reserved.history
        .filter((entry) => entry.decision === "rejected")
        .map((entry) => [entry.fingerprint, entry.sessionsAtDecision]),
    );

    const jsonSchema = learnJsonSchema();

    const context: GateContext = {
      runId: reserved.runId,
      now: nowIso,
      minSessions: MIN_SESSIONS,
      minDays: MIN_DAYS,
      rejected,
      pending: reserved.pending,
    };

    for (const group of groups) {
      const remaining = Math.floor((config.learn.maxBudgetUsd - costUsd) * 100) / 100;

      if (remaining < MIN_CALL_USD) {
        dropped["budget"] = (dropped["budget"] ?? 0) + group.notes.length;
        continue;
      }

      const request: ModelRequest = {
        label: `learn ${group.key}`,
        model: config.learn.model,
        prompt: learnPrompt(group),
        jsonSchema,
        maxBudgetUsd: remaining,
        timeoutMs: config.learn.timeoutMs,
      };

      const outcome = yield* askGroup(runner, request, group, context);
      costUsd += outcome.costUsd;

      if ("failure" in outcome) {
        failures.push(outcome.failure);
        continue;
      }

      const { gated } = outcome;

      for (const drop of gated.dropped) {
        dropped[drop.reason] = (dropped[drop.reason] ?? 0) + 1;
      }

      yield* store.transaction((db) => {
        for (const proposal of gated.proposals) {
          insertProposal(db, proposal);
          reserved.pending.add(proposal.fingerprint);
        }

        markNotesUsed(db, gated.usedNoteIds);
      });
      proposals += gated.proposals.length;
    }

    const pruned = yield* prune(repoRoots, options.inventoryEnv, nowIso).pipe(
      Effect.catch((error) => {
        failures.push(`prune: ${error instanceof Error ? error.message : String(error)}`);

        return Effect.succeed({ proposals: 0 });
      }),
    );

    const status = failures.length > 0 && proposals === 0 && groups.length > 0 ? "failed" : "complete";
    yield* finish(status, failures.length === 0 ? null : failures.join("\n"));

    return {
      runId: reserved.runId,
      status,
      reason: null,
      groups: groups.length,
      notesRead: views.length,
      proposals,
      pruned: pruned.proposals,
      dropped,
      failures,
      costUsd,
    } satisfies LearnReport;
  });
