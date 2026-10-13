import { Effect, Layer } from "effect";
import { Command, Flag } from "effect/cli";
import { openSync } from "node:fs";
import { join } from "node:path";
import { ClaudeRunner, liveRunner } from "../learn/claude.ts";
import { knownRepos, prune } from "../learn/prune.ts";
import { learn } from "../learn/run.ts";
import { defaultInventoryEnv } from "../rules/inventory.ts";
import { ensurePrivateDir, type Paths } from "../store/paths.ts";
import { AppConfig, AppPaths, printJson } from "./app.ts";

/** Starts `hindsight learn` in its own process, its output in the log directory, and returns at once. */
export function detachLearn(paths: Paths, ifDue: boolean): string {
  ensurePrivateDir(paths.logDir);
  const log = join(paths.logDir, `learn-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  const fd = openSync(log, "a", 0o600);
  const child = Bun.spawn(["bun", join(import.meta.dir, "main.ts"), "learn", ...(ifDue ? ["--if-due"] : [])], {
    stdin: "ignore",
    stdout: fd,
    stderr: fd,
    detached: true,
    env: process.env,
  });
  child.unref();
  return log;
}

export const learnCommand = Command.make(
  "learn",
  {
    ifDue: Flag.Boolean("if-due").pipe(
      Flag.withDescription("Run only past the pending-Notes threshold and the interval"),
      Flag.withDefault(false),
    ),
    detach: Flag.Boolean("detach").pipe(
      Flag.withDescription("Start the run in the background and return"),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* ({ ifDue, detach }) {
    const paths = yield* AppPaths;
    if (detach) {
      yield* printJson({ detached: true, log: detachLearn(paths, ifDue) });
      return;
    }
    const config = yield* AppConfig;
    const report = yield* learn({ ifDue, inventoryEnv: defaultInventoryEnv() }, config).pipe(
      Effect.provide(Layer.succeed(ClaudeRunner, liveRunner)),
    );
    yield* printJson(report);
  }),
).pipe(Command.withDescription("Turns pending Notes into Proposals with one Opus call per scope"));

export const pruneCommand = Command.make(
  "prune",
  {
    repo: Flag.String("repo").pipe(
      Flag.withDescription("A checkout to scan, besides the ones hindsight knows"),
      Flag.optional,
    ),
  },
  Effect.fn(function* ({ repo }) {
    const known = yield* knownRepos;
    const roots = repo._tag === "Some" ? [...known, repo.value] : known;
    yield* printJson(yield* prune(roots, defaultInventoryEnv()));
  }),
).pipe(Command.withDescription("Code checks over the Rule Files: dead globs, gone paths, missing scripts"));
