import type { Codec } from "./codec.ts";
import { tmpdir } from "node:os";
import { decode, DecodeError } from "./codec.ts";

export type ModelAlias = "haiku" | "sonnet" | "opus";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type ModelRequest<T> = {
  /** Names the call in errors and run files, e.g. `extract <sessionId>`. */
  readonly label: string;
  readonly model: ModelAlias;
  readonly effort: Effort;
  readonly prompt: string;
  readonly output: Codec<T>;
  readonly maxBudgetUsd: number;
  readonly timeoutMs: number;
};

export type CallUsage = {
  readonly costUsd: number;
  /** Uncached, cache-write and cache-read input tokens together. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly durationMs: number;
};

export type ModelResult<T> = {
  readonly output: T;
  readonly usage: CallUsage;
};

export type ModelRunner = <T>(request: ModelRequest<T>) => Promise<ModelResult<T>>;

export type ModelErrorKind =
  | "timeout"
  | "exit"
  | "unparsable-stdout"
  | "no-result"
  | "result-error"
  | "missing-output"
  | "invalid-output";

export class ModelError extends Error {
  constructor(
    readonly kind: ModelErrorKind,
    readonly label: string,
    message: string,
    /** Spend reported by the CLI before the failure, when it reported any. */
    readonly usage: CallUsage | null,
  ) {
    super(`${label}: ${kind}: ${message}`);
    this.name = "ModelError";
  }
}

export type SpawnResult = {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
};

export type SpawnFn = (
  argv: readonly string[],
  options: {
    readonly stdin: string;
    readonly env: Readonly<Record<string, string>>;
    readonly cwd: string;
    readonly timeoutMs: number;
  },
) => Promise<SpawnResult>;

export const bunSpawn: SpawnFn = async (argv, options) => {
  const startedAt = performance.now();
  const proc = Bun.spawn([...argv], {
    cwd: options.cwd,
    env: { ...options.env },
    stdin: new Blob([options.stdin]),
    stdout: "pipe",
    stderr: "pipe",
    timeout: options.timeoutMs,
    killSignal: "SIGKILL",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    exitCode: proc.signalCode === null ? exitCode : null,
    timedOut: proc.signalCode !== null,
    stdout,
    stderr,
    durationMs: Math.round(performance.now() - startedAt),
  };
};

export function claudeArgs(request: Pick<ModelRequest<unknown>, "model" | "effort" | "output" | "maxBudgetUsd">) {
  return [
    "--print",
    "--safe-mode",
    "--no-session-persistence",
    "--model",
    request.model,
    "--effort",
    request.effort,
    "--tools",
    "",
    "--strict-mcp-config",
    "--permission-mode",
    "dontAsk",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(request.output.schema),
    "--max-budget-usd",
    request.maxBudgetUsd.toFixed(2),
  ];
}

export function childEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && key !== "CLAUDECODE") {
      clean[key] = value;
    }
  }
  return clean;
}

type ResultMessage = Record<string, unknown> & { readonly type: "result" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isResultMessage(value: unknown): value is ResultMessage {
  return isRecord(value) && value["type"] === "result";
}

/** The CLI prints either the result object or, as observed with `--safe-mode`, an array of every message. */
export function findResultMessage(parsed: unknown): ResultMessage | null {
  if (isResultMessage(parsed)) {
    return parsed;
  }
  if (Array.isArray(parsed)) {
    return parsed.findLast(isResultMessage) ?? null;
  }
  return null;
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function usageOf(result: ResultMessage, durationMs: number): CallUsage {
  const usage = isRecord(result["usage"]) ? result["usage"] : {};
  return {
    costUsd: numberField(result, "total_cost_usd"),
    inputTokens:
      numberField(usage, "input_tokens") +
      numberField(usage, "cache_creation_input_tokens") +
      numberField(usage, "cache_read_input_tokens"),
    outputTokens: numberField(usage, "output_tokens"),
    durationMs,
  };
}

function tail(text: string, limit = 400): string {
  return text.slice(-limit).trim();
}

export function parseClaudeOutput<T>(request: ModelRequest<T>, spawned: SpawnResult): ModelResult<T> {
  const { label } = request;
  if (spawned.timedOut) {
    throw new ModelError("timeout", label, `killed after ${request.timeoutMs} ms`, null);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(spawned.stdout);
  } catch {
    const kind = spawned.exitCode === 0 ? "unparsable-stdout" : "exit";
    throw new ModelError(
      kind,
      label,
      `exit ${spawned.exitCode ?? "none"}, stderr=${JSON.stringify(tail(spawned.stderr))} stdout=${JSON.stringify(tail(spawned.stdout))}`,
      null,
    );
  }
  const result = findResultMessage(parsed);
  if (result === null) {
    throw new ModelError("no-result", label, `exit ${spawned.exitCode ?? "none"}, no result message in stdout`, null);
  }
  const usage = usageOf(result, spawned.durationMs);
  if (result["is_error"] === true || result["subtype"] !== "success" || spawned.exitCode !== 0) {
    const detail = typeof result["result"] === "string" ? tail(result["result"]) : "";
    throw new ModelError(
      "result-error",
      label,
      `exit ${spawned.exitCode ?? "none"}, subtype ${String(result["subtype"])}: ${JSON.stringify(detail)}`,
      usage,
    );
  }
  if (!("structured_output" in result) || result["structured_output"] === null) {
    throw new ModelError("missing-output", label, "success without structured_output", usage);
  }
  try {
    return { output: decode(request.output, result["structured_output"]), usage };
  } catch (error) {
    if (error instanceof DecodeError) {
      throw new ModelError("invalid-output", label, error.message, usage);
    }
    throw error;
  }
}

export type ClaudeRunnerOptions = {
  readonly spawn?: SpawnFn;
  readonly binary?: string;
  /** Neutral directory the CLI starts in, so no repository leaks into its system prompt. */
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
};

export function claudeRunner(options: ClaudeRunnerOptions = {}): ModelRunner {
  const spawn = options.spawn ?? bunSpawn;
  const binary = options.binary ?? "claude";
  const cwd = options.cwd ?? tmpdir();
  const env = childEnv(options.env ?? process.env);
  return async (request) => {
    const spawned = await spawn([binary, ...claudeArgs(request)], {
      stdin: request.prompt,
      env,
      cwd,
      timeoutMs: request.timeoutMs,
    });
    return parseClaudeOutput(request, spawned);
  };
}
