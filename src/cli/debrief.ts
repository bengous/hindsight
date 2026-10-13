import { Effect, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { recordDebrief } from "../debrief/record.ts";
import { newId } from "../rules/ids.ts";
import { Store } from "../store/db.ts";
import { countPendingNotes, insertDebrief } from "../store/queries.ts";
import { readSession } from "../transcripts/session.ts";
import { AppConfig, AppPaths, nowIso, printJson, readStdin } from "./app.ts";
import { detachLearn } from "./learn.ts";

const RecordStdin = Schema.Struct({
  sessionId: Schema.String,
  cacheShare: Schema.Number,
  durationMs: Schema.Number,
  text: Schema.String,
  repoRoot: Schema.NullOr(Schema.String),
});

const start = Command.make(
  "start",
  {
    session: Flag.String("session").pipe(Flag.withDescription("The session id the Debrief forks")),
    repo: Flag.String("repo").pipe(
      Flag.withDescription("The repository root, when the session runs in one"),
      Flag.optional,
    ),
  },
  Effect.fn(function* ({ session, repo }) {
    const store = yield* Store;
    const id = newId();
    yield* store.transaction((db) =>
      insertDebrief(db, { id, sessionId: session, repoRoot: repo._tag === "Some" ? repo.value : null, at: nowIso() }),
    );
    yield* printJson({ id });
  }),
).pipe(Command.withDescription("Opens a Debrief row before the fork starts"));

const record = Command.make(
  "record",
  { id: Flag.String("id").pipe(Flag.withDescription("The id `debrief start` returned")) },
  Effect.fn(function* ({ id }) {
    const store = yield* Store;
    const config = yield* AppConfig;
    const paths = yield* AppPaths;
    const raw = yield* readStdin;
    const input = yield* Schema.decodeUnknownEffect(RecordStdin)(JSON.parse(raw));
    const session = yield* Effect.promise(() => readSession(paths.projectsDir, input.sessionId));
    const outcome = yield* store.transaction((db) => recordDebrief(db, config, session, { id, ...input }));
    const pending = yield* store.transaction((db) => countPendingNotes(db));
    const learnStarted = pending >= config.learn.pendingNotes && process.env["HINDSIGHT_NO_LEARN"] === undefined;
    if (learnStarted) detachLearn(paths, true);
    yield* printJson({ ...outcome, learnStarted });
  }),
).pipe(Command.withDescription("Reads the fork's answer on stdin, verifies every Note and stores what holds"));

export const debrief = Command.make("debrief").pipe(
  Command.withDescription("Debrief rows: start before the fork, record after it"),
  Command.withSubcommands([start, record]),
);
