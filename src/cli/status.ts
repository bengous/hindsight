import { Effect } from "effect";
import { Command } from "effect/cli";
import { Store } from "../store/db.ts";
import { abortStaleDebriefs, countPendingNotes } from "../store/queries.ts";
import { nowIso, printJson } from "./app.ts";

export type StatusReport = {
  readonly debriefs: Readonly<Record<string, number>>;
  readonly cacheShare: { readonly min: number | null; readonly mean: number | null };
  readonly failures: readonly { readonly id: string; readonly failure: string }[];
  readonly pendingNotes: number;
  readonly pendingProposals: number;
  readonly gate: Readonly<Record<string, number>>;
  readonly learn: { readonly runs: number; readonly costUsd: number; readonly running: boolean };
};

export const status = Command.make(
  "status",
  {},
  Effect.fn(function* () {
    const store = yield* Store;
    const report = yield* store.transaction((db): StatusReport => {
      abortStaleDebriefs(db, nowIso());
      const debriefs: Record<string, number> = {};
      for (const row of db.all<{ status: string; n: number }>(
        "SELECT status, COUNT(*) AS n FROM debriefs GROUP BY status",
      )) {
        debriefs[row.status] = row.n;
      }
      const share = db.get<{ min: number | null; mean: number | null }>(
        "SELECT MIN(cache_share) AS min, AVG(cache_share) AS mean FROM debriefs WHERE status = 'recorded'",
      );
      const gate: Record<string, number> = {};
      for (const row of db.all<{ key: string; n: number }>(
        "SELECT decision || COALESCE(':' || reason, '') AS key, COUNT(*) AS n FROM gate_decisions GROUP BY key",
      )) {
        gate[row.key] = row.n;
      }
      const learn = db.get<{ runs: number; cost: number | null; running: number }>(
        "SELECT COUNT(*) AS runs, SUM(cost_usd) AS cost, SUM(status = 'running') AS running FROM learn_runs",
      );
      return {
        debriefs,
        cacheShare: { min: share?.min ?? null, mean: share?.mean ?? null },
        failures: db.all<{ id: string; failure: string }>(
          "SELECT id, failure FROM debriefs WHERE status = 'failed' ORDER BY started_at DESC LIMIT 10",
        ),
        pendingNotes: countPendingNotes(db),
        pendingProposals: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM proposals WHERE state = 'pending'")?.n ?? 0,
        gate,
        learn: { runs: learn?.runs ?? 0, costUsd: learn?.cost ?? 0, running: (learn?.running ?? 0) > 0 },
      };
    });
    yield* printJson(report);
  }),
).pipe(Command.withDescription("Pending Proposals, Debriefs and their cache share, Gate decisions, Learn cost"));
