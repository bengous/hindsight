import { Effect, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { replayGate } from "../gate/replay.ts";
import { Store } from "../store/db.ts";
import { insertGateDecision } from "../store/queries.ts";
import { AppConfig, AppPaths, nowIso, printJson, readStdin } from "./app.ts";

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

const replay = Command.make(
  "replay",
  { days: Flag.Int("days").pipe(Flag.withDescription("How many days of transcripts to replay"), Flag.withDefault(30)) },
  Effect.fn(function* ({ days }) {
    const paths = yield* AppPaths;
    const config = yield* AppConfig;
    yield* printJson(yield* Effect.promise(() => replayGate(paths.projectsDir, days, config)));
  }),
).pipe(Command.withDescription("Runs the Gate's code, without a model, over past transcripts"));

export const gate = Command.make("gate").pipe(
  Command.withDescription("The Debrief Gate's journal and replay"),
  Command.withSubcommands([log, replay]),
);
