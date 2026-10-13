import type { StatusSnapshot } from "../store/queries.ts";

import { Effect } from "effect";
import { Command } from "effect/cli";

import { Store } from "../store/db.ts";
import { abortStaleDebriefs, countPendingNotes, statusSnapshot } from "../store/queries.ts";
import { nowIso, printJson } from "./app.ts";

export type StatusReport = StatusSnapshot & { readonly pendingNotes: number };

export const status = Command.make(
  "status",
  {},
  Effect.fn(function* () {
    const store = yield* Store;

    const report = yield* store.transaction((db): StatusReport => {
      abortStaleDebriefs(db, nowIso());

      return { ...statusSnapshot(db), pendingNotes: countPendingNotes(db) };
    });

    yield* printJson(report);
  }),
).pipe(Command.withDescription("Pending Proposals, Debriefs and their cache share, Gate decisions, Learn cost"));
