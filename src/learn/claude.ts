import type { JsonObject, JsonValue } from "../domain/json.ts";
import type { JsonSchema } from "effect";

import { Context, Effect, Schema } from "effect";
import { tmpdir } from "node:os";

import { isJsonArray, isJsonObject, numberField, parseJson, textField } from "../domain/json.ts";

export type ModelRequest = {
  readonly label: string;
  readonly model: string;
  readonly prompt: string;
  readonly jsonSchema: JsonSchema.JsonSchema;
  readonly maxBudgetUsd: number;
  readonly timeoutMs: number;
};

export type ModelAnswer = {
  readonly output: JsonValue;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly durationMs: number;
};

// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor; its fix inserts a `new` that breaks the class.
export class ModelError extends Schema.TaggedError<ModelError>()("ModelError", {
  kind: Schema.Literals(["timeout", "exit", "unparsable-stdout", "no-result", "result-error", "missing-output"]),
  label: Schema.String,
  detail: Schema.String,
  costUsd: Schema.Number,
}) {}

const isModelError = Schema.is(ModelError);

/** One `claude -p` call: no tools, no session, a JSON schema for the output. Tests provide a scripted one. */
export class ClaudeRunner extends Context.Service<
  ClaudeRunner,
  { readonly run: (request: ModelRequest) => Effect.Effect<ModelAnswer, ModelError> }
>()("hindsight/learn/claude/ClaudeRunner") {}

const EFFORT = "high";

export function claudeArgs(request: ModelRequest): string[] {
  return [
    "--print",
    "--safe-mode",
    "--no-session-persistence",
    "--model",
    request.model,
    "--effort",
    EFFORT,
    "--tools",
    "",
    "--strict-mcp-config",
    "--permission-mode",
    "dontAsk",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(request.jsonSchema),
    "--max-budget-usd",
    request.maxBudgetUsd.toFixed(2),
  ];
}

/** The child must not believe it runs inside a Claude Code session. */
export function childEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== "CLAUDECODE",
    ),
  );
}

const num = (source: JsonValue | undefined, key: string): number => numberField(source, key) ?? 0;

const isResult = (value: JsonValue): value is JsonObject => isJsonObject(value) && value["type"] === "result";

/** The CLI prints the result object or, under `--safe-mode`, an array of every message. */
export function findResultMessage(parsed: JsonValue): JsonObject | null {
  if (isResult(parsed)) {
    return parsed;
  }

  return isJsonArray(parsed) ? (parsed.findLast(isResult) ?? null) : null;
}

export type Spawned = {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
};

const tail = (text: string): string => text.slice(-400).trim();

export function parseClaudeOutput(request: ModelRequest, spawned: Spawned): ModelAnswer | ModelError {
  const { label } = request;

  if (spawned.timedOut) {
    return new ModelError({ kind: "timeout", label, detail: `killed after ${request.timeoutMs} ms`, costUsd: 0 });
  }

  let parsed: JsonValue;

  try {
    parsed = parseJson(spawned.stdout);
  } catch {
    return new ModelError({
      kind: spawned.exitCode === 0 ? "unparsable-stdout" : "exit",
      label,
      detail: `exit ${spawned.exitCode ?? "none"}, stderr=${JSON.stringify(tail(spawned.stderr))}`,
      costUsd: 0,
    });
  }

  const result = findResultMessage(parsed);

  if (result === null) {
    return new ModelError({ kind: "no-result", label, detail: "no result message in stdout", costUsd: 0 });
  }

  const usage = result["usage"];
  const costUsd = num(result, "total_cost_usd");

  if (result["is_error"] === true || result["subtype"] !== "success" || spawned.exitCode !== 0) {
    const detail = tail(textField(result, "result") ?? "");

    return new ModelError({
      kind: "result-error",
      label,
      detail: `subtype ${textField(result, "subtype") ?? "none"}: ${detail}`,
      costUsd,
    });
  }

  const output = result["structured_output"];

  if (output === undefined || output === null) {
    return new ModelError({ kind: "missing-output", label, detail: "success without structured_output", costUsd });
  }

  return {
    output,
    costUsd,
    inputTokens:
      num(usage, "input_tokens") + num(usage, "cache_creation_input_tokens") + num(usage, "cache_read_input_tokens"),
    outputTokens: num(usage, "output_tokens"),
    durationMs: spawned.durationMs,
  };
}

async function spawnClaude(request: ModelRequest): Promise<Spawned> {
  const startedAt = performance.now();

  const proc = Bun.spawn(["claude", ...claudeArgs(request)], {
    cwd: tmpdir(),
    env: childEnv(process.env),
    stdin: new Blob([request.prompt]),
    stdout: "pipe",
    stderr: "pipe",
    timeout: request.timeoutMs,
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
}

export const liveRunner = ClaudeRunner.of({
  run: (request) =>
    Effect.flatMap(
      Effect.tryPromise({
        try: async () => spawnClaude(request),
        catch: (cause) =>
          new ModelError({
            kind: "exit",
            label: request.label,
            detail: `cannot start claude: ${cause instanceof Error ? cause.message : String(cause)}`,
            costUsd: 0,
          }),
      }),
      (spawned) => {
        const parsed = parseClaudeOutput(request, spawned);

        return isModelError(parsed) ? Effect.fail(parsed) : Effect.succeed(parsed);
      },
    ),
});

/** A runner for specs: answers each call from `answers` in order, or fails when the script runs out. */
export function scriptedRunner(answers: ReadonlyArray<JsonValue | ModelError>, costUsd = 0.1): ClaudeRunner["Service"] {
  let index = 0;

  return {
    run: (request) => {
      const answer = answers[index];
      index += 1;

      if (answer === undefined) {
        return Effect.fail(
          new ModelError({ kind: "exit", label: request.label, detail: "script exhausted", costUsd: 0 }),
        );
      }

      if (isModelError(answer)) {
        return Effect.fail(answer);
      }

      return Effect.succeed({ output: answer, costUsd, inputTokens: 1000, outputTokens: 100, durationMs: 1 });
    },
  };
}
