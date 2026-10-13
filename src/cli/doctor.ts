import { Effect } from "effect";
import { Command } from "effect/cli";
import { existsSync, readdirSync, statSync } from "node:fs";
import { Store } from "../store/db.ts";
import { AppPaths, printJson } from "./app.ts";

type Check = { readonly name: string; readonly ok: boolean; readonly detail: string };

function mode(path: string): string | null {
  return existsSync(path) ? (statSync(path).mode & 0o777).toString(8) : null;
}

function countTranscripts(projectsDir: string): number {
  if (!existsSync(projectsDir)) return 0;
  let count = 0;
  for (const project of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    count += readdirSync(`${projectsDir}/${project.name}`).filter((name) => name.endsWith(".jsonl")).length;
  }
  return count;
}

export const doctor = Command.make(
  "doctor",
  {},
  Effect.fn(function* () {
    const paths = yield* AppPaths;
    const store = yield* Store;
    const version = yield* store.get<{ user_version: number }>("PRAGMA user_version");
    const transcripts = countTranscripts(paths.projectsDir);
    const checks: Check[] = [
      {
        name: "state dir",
        ok: mode(paths.stateRoot) === "700",
        detail: `${paths.stateRoot} mode ${mode(paths.stateRoot) ?? "absent"}`,
      },
      {
        name: "database",
        ok: mode(paths.dbPath) === "600",
        detail: `${paths.dbPath} mode ${mode(paths.dbPath) ?? "absent"}, schema v${version?.user_version ?? 0}`,
      },
      {
        name: "config",
        ok: true,
        detail: existsSync(paths.configPath) ? paths.configPath : `${paths.configPath} absent, defaults in use`,
      },
      { name: "transcripts", ok: transcripts > 0, detail: `${transcripts} session file(s) under ${paths.projectsDir}` },
      { name: "claude", ok: Bun.which("claude") !== null, detail: Bun.which("claude") ?? "not on PATH" },
      { name: "bun", ok: true, detail: Bun.version },
    ];
    yield* printJson({ ok: checks.every((check) => check.ok), checks });
  }),
).pipe(Command.withDescription("Paths, permissions, database schema, transcripts and the claude binary"));
