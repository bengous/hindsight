import type { Host } from "./host.ts";

export class CliError extends Error {
  constructor(
    readonly argv: readonly string[],
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(`hindsight ${argv.join(" ")} failed (exit ${exitCode}): ${stderr.trim().split("\n").at(-1) ?? ""}`);
    this.name = "CliError";
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** The CLI answers with one JSON line; this is the mod's side of that contract. */
export async function runCli(
  host: Host,
  args: readonly string[],
  options: { readonly stdin?: string; readonly timeoutMs?: number } = {},
): Promise<unknown> {
  const argv = ["bun", `${host.pluginRoot}/src/cli/main.ts`, ...args, "--json"];
  const init = {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
  };
  const result = await host.run(argv, init);
  if (result.exitCode !== 0) throw new CliError(argv, result.exitCode, result.stderr);
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  try {
    return JSON.parse(line);
  } catch {
    throw new CliError(argv, result.exitCode, `not a JSON line: ${line.slice(0, 200)}`);
  }
}

type Json = Readonly<Record<string, unknown>>;
const isJson = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

export async function cliConfig(host: Host): Promise<unknown> {
  return runCli(host, ["config"]);
}

export type StatusSummary = { readonly pendingProposals: number; readonly failures: number };

export async function cliStatus(host: Host): Promise<StatusSummary> {
  const answer = await runCli(host, ["status"]);
  const pending = isJson(answer) ? answer["pendingProposals"] : 0;
  const failures = isJson(answer) && Array.isArray(answer["failures"]) ? answer["failures"].length : 0;
  return { pendingProposals: typeof pending === "number" ? pending : 0, failures };
}

export async function cliDebriefStart(host: Host, sessionId: string, repoRoot: string | null): Promise<string> {
  const answer = await runCli(host, [
    "debrief",
    "start",
    "--session",
    sessionId,
    ...(repoRoot === null ? [] : ["--repo", repoRoot]),
  ]);
  const id = isJson(answer) ? answer["id"] : undefined;
  if (typeof id !== "string") throw new Error("debrief start answered without an id");
  return id;
}

export type RecordAnswer = {
  readonly status: string;
  readonly failure: string | null;
  readonly notes: { readonly steers: number; readonly observations: number; readonly staleRules: number };
  readonly proposals: number;
  readonly rejected: Readonly<Record<string, number>>;
};

export async function cliDebriefRecord(
  host: Host,
  id: string,
  body: { sessionId: string; cacheShare: number; durationMs: number; text: string; repoRoot: string | null },
): Promise<RecordAnswer> {
  const answer = await runCli(host, ["debrief", "record", "--id", id], {
    stdin: JSON.stringify(body),
    timeoutMs: 120_000,
  });
  if (!isJson(answer) || typeof answer["status"] !== "string") throw new Error("debrief record answered out of shape");
  const notes = isJson(answer["notes"]) ? answer["notes"] : {};
  const count = (key: string): number => (typeof notes[key] === "number" ? (notes[key] as number) : 0);
  return {
    status: answer["status"],
    failure: typeof answer["failure"] === "string" ? answer["failure"] : null,
    notes: { steers: count("steers"), observations: count("observations"), staleRules: count("staleRules") },
    proposals: typeof answer["proposals"] === "number" ? answer["proposals"] : 0,
    rejected: isJson(answer["rejected"]) ? (answer["rejected"] as Record<string, number>) : {},
  };
}

export type GateLogEntry = {
  readonly sessionId: string;
  readonly turnId: string | null;
  readonly decision: string;
  readonly reason: string | null;
  readonly score: number | null;
  readonly signals: unknown;
};

/** Fire and forget: a journal line never holds the session. */
export function cliGateLog(host: Host, entry: GateLogEntry): void {
  void runCli(host, ["gate", "log"], { stdin: JSON.stringify(entry) }).catch((error: unknown) => {
    host.log(`gate log failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}
