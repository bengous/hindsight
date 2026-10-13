import type { HindsightConfig } from "../domain/config.ts";
import type { InventoryEnv } from "../rules/inventory.ts";
import type { RuleFile } from "../rules/types.ts";
import type { StoreShape } from "../store/db.ts";
import type { HistoryEntry, NoteRow } from "../store/queries.ts";
import type { GateContext } from "./gates.ts";
import type { LearnGroup, NoteView, RuleSource } from "./prompt.ts";

import { Effect } from "effect";
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
import { ClaudeRunner, ModelError } from "./claude.ts";
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

type Json = Record<string, unknown>;

const isJson = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

const str = (record: Json, key: string): string | null => (typeof record[key] === "string" ? record[key] : null);

export function toNoteView(row: NoteRow): NoteView | null {
  if (row.kind === "stale_rule") {
    return null;
  }

  const parsed: unknown = JSON.parse(row.body_json);
  const body = isJson(parsed) ? parsed : {};
  const loaded: unknown = JSON.parse(row.loaded_rules_json);
  const loadedRules = Array.isArray(loaded) ? loaded.filter((path): path is string => typeof path === "string") : [];

  if (row.kind === "steer") {
    const quote = str(body, "quote") ?? "";

    return {
      id: row.id,
      kind: "steer",
      sessionId: row.session_id,
      repoRoot: row.repo_root,
      at: row.at,
      lesson: row.lesson,
      text: quote,
      habit: body["habit"] === true,
      tool: null,
      question: null,
      loadedRules,
      isExplicit: markersFor(quote, NO_CONTEXT).includes("standing_instruction"),
      evidenceId: row.evidence_id,
    };
  }

  return {
    id: row.id,
    kind: "observation",
    sessionId: row.session_id,
    repoRoot: row.repo_root,
    at: row.at,
    lesson: row.lesson,
    text: str(body, "excerpt") ?? "",
    habit: null,
    tool: str(body, "tool"),
    question: typeof body["question"] === "number" ? body["question"] : null,
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
  const texts = new Map<string, string>();

  for (const group of groups) {
    for (const rule of group.rules) {
      if (!texts.has(rule.file.sourcePath)) {
        texts.set(rule.file.sourcePath, await Bun.file(rule.file.sourcePath).text());
      }
    }
  }

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

function reserve(store: StoreShape, config: HindsightConfig, ifDue: boolean, nowIso: string) {
  return store.transaction((db): Reserved | { readonly skipped: string } => {
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

/** Learn: pending Notes → one model call per scope → code gates → Proposals. One run at a time. */
export const learn = (options: LearnOptions, config: HindsightConfig, nowIso: string = new Date().toISOString()) =>
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

    const finish = (status: "complete" | "failed", failure: string | null) =>
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
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
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

    for (const group of groups) {
      const remaining = Math.floor((config.learn.maxBudgetUsd - costUsd) * 100) / 100;

      if (remaining < MIN_CALL_USD) {
        dropped["budget"] = (dropped["budget"] ?? 0) + group.notes.length;
        continue;
      }

      const answer = yield* runner
        .run({
          label: `learn ${group.key}`,
          model: config.learn.model,
          prompt: learnPrompt(group),
          jsonSchema,
          maxBudgetUsd: remaining,
          timeoutMs: config.learn.timeoutMs,
        })
        .pipe(Effect.catch((error: ModelError) => Effect.succeed(error)));

      if (answer instanceof ModelError) {
        costUsd += answer.costUsd;
        failures.push(`${group.key}: ${answer.kind}: ${answer.detail}`);
        continue;
      }

      costUsd += answer.costUsd;

      const context: GateContext = {
        runId: reserved.runId,
        now: nowIso,
        minSessions: MIN_SESSIONS,
        minDays: MIN_DAYS,
        rejected,
        pending: reserved.pending,
      };

      let gated;

      try {
        gated = gateLearn(group, decodeLearnOutput(answer.output), context);
      } catch (error) {
        failures.push(
          error instanceof LearnError
            ? error.message
            : `${group.key}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }

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
