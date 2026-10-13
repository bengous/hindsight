import { Effect, Schema } from "effect";
import { Command } from "effect/cli";
import { Store } from "../store/db.ts";
import { insertGateDecision } from "../store/queries.ts";
import { nowIso, printJson, readStdin } from "./app.ts";

const LogStdin = Schema.Struct({
  sessionId: Schema.String,
  turnId: Schema.NullOr(Schema.String),
  decision: Schema.String,
  reason: Schema.NullOr(Schema.String),
  score: Schema.NullOr(Schema.Number),
  signals: Schema.Unknown,
});

const log = Command.make(
  "log",
  {},
  Effect.fn(function* () {
    const store = yield* Store;
    const input = yield* Schema.decodeUnknownEffect(LogStdin)(JSON.parse(yield* readStdin));
    yield* store.transaction((db) => insertGateDecision(db, { ...input, at: nowIso() }));
    yield* printJson({ ok: true });
  }),
).pipe(Command.withDescription("Journals one Gate decision read on stdin"));

export const gate = Command.make("gate").pipe(
  Command.withDescription("The Debrief Gate's journal and replay"),
  Command.withSubcommands([log]),
);
