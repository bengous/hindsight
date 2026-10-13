import type { JsonValue } from "../domain/json.ts";
import type { Host } from "./host.ts";

import { isJsonObject, isNumber, numberField, parseJson, textField } from "../domain/json.ts";

// @effect-diagnostics-next-line extendsNativeError:off -- src/mod imports no Effect: this error never enters an Effect failure channel.
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
): Promise<JsonValue> {
  const argv = ["bun", `${host.pluginRoot}/src/cli/main.ts`, ...args, "--json"];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const init = options.stdin === undefined ? { timeoutMs } : { timeoutMs, stdin: options.stdin };

  const result = await host.run(argv, init);

  if (result.exitCode !== 0) {
    throw new CliError(argv, result.exitCode, result.stderr);
  }

  const line = result.stdout.trim().split("\n").at(-1) ?? "";

  try {
    return parseJson(line);
  } catch {
    throw new CliError(argv, result.exitCode, `not a JSON line: ${line.slice(0, 200)}`);
  }
}

export async function cliConfig(host: Host): Promise<JsonValue> {
  return runCli(host, ["config"]);
}

export type StatusSummary = { readonly pendingProposals: number; readonly failures: number };

export async function cliStatus(host: Host): Promise<StatusSummary> {
  const answer = await runCli(host, ["status"]);
  const failures = isJsonObject(answer) ? answer["failures"] : undefined;

  return {
    pendingProposals: numberField(answer, "pendingProposals") ?? 0,
    failures: Array.isArray(failures) ? failures.length : 0,
  };
}

export async function cliDebriefStart(host: Host, sessionId: string, repoRoot: string | null): Promise<string> {
  const answer = await runCli(host, [
    "debrief",
    "start",
    "--session",
    sessionId,
    ...(repoRoot === null ? [] : ["--repo", repoRoot]),
  ]);

  const id = textField(answer, "id");

  if (id === null) {
    throw new TypeError("debrief start answered without an id");
  }

  return id;
}

export type RecordAnswer = {
  readonly status: string;
  readonly failure: string | null;
  readonly notes: { readonly steers: number; readonly observations: number; readonly staleRules: number };
  readonly proposals: number;
  readonly rejected: Readonly<Record<string, number>>;
};

function rejectedCounts(value: JsonValue | undefined): RecordAnswer["rejected"] {
  if (!isJsonObject(value)) {
    throw new TypeError("debrief record answered without rejected counts");
  }

  const counts: Record<string, number> = {};

  for (const [reason, count] of Object.entries(value)) {
    if (!isNumber(count)) {
      throw new TypeError(`debrief record: rejected.${reason} is not a number`);
    }

    counts[reason] = count;
  }

  return counts;
}

export async function cliDebriefRecord(
  host: Host,
  id: string,
  body: { sessionId: string; cacheShare: number; durationMs: number; text: string; repoRoot: string | null },
): Promise<RecordAnswer> {
  const answer = await runCli(host, ["debrief", "record", "--id", id], {
    stdin: JSON.stringify(body),
    timeoutMs: 120_000,
  });

  const status = textField(answer, "status");

  if (status === null) {
    throw new Error("debrief record answered out of shape");
  }

  const notes = isJsonObject(answer) ? answer["notes"] : undefined;
  const rejected = isJsonObject(answer) ? answer["rejected"] : undefined;
  const count = (key: string): number => numberField(notes, key) ?? 0;

  return {
    status,
    failure: textField(answer, "failure"),
    notes: { steers: count("steers"), observations: count("observations"), staleRules: count("staleRules") },
    proposals: numberField(answer, "proposals") ?? 0,
    rejected: rejectedCounts(rejected),
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
  const logFailure = (cause: unknown): void => {
    host.log(`gate log failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  };

  void runCli(host, ["gate", "log"], { stdin: JSON.stringify(entry) }).catch(logFailure);
}
