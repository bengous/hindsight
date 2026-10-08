import type { SpawnFn, SpawnResult } from "./claude.ts";
import { describe, expect, test } from "bun:test";
import { childEnv, claudeArgs, claudeRunner, ModelError } from "./claude.ts";
import { array, object, oneOf, string } from "./codec.ts";

const output = object({ labels: array(oneOf(["keep", "drop"])), note: string() });

const request = {
  label: "extract s1",
  model: "sonnet",
  effort: "low",
  prompt: "classify",
  output,
  maxBudgetUsd: 0.25,
  timeoutMs: 1000,
} as const;

const resultMessage = {
  type: "result",
  subtype: "success",
  is_error: false,
  total_cost_usd: 0.0123,
  usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 5, output_tokens: 42 },
  structured_output: { labels: ["keep"], note: "ok" },
};

function spawned(stdout: unknown, overrides: Partial<SpawnResult> = {}): SpawnResult {
  return {
    exitCode: 0,
    timedOut: false,
    stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout),
    stderr: "",
    durationMs: 7,
    ...overrides,
  };
}

function fakeSpawn(result: SpawnResult, calls: Parameters<SpawnFn>[] = []): SpawnFn {
  return async (...args) => {
    calls.push(args);
    return result;
  };
}

async function failure(spawn: SpawnFn): Promise<ModelError> {
  try {
    await claudeRunner({ spawn })(request);
  } catch (error) {
    if (error instanceof ModelError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a ModelError");
}

describe("claudeRunner", () => {
  test("sends the prompt on stdin with the isolation flags and decodes the result element of an array", async () => {
    const calls: Parameters<SpawnFn>[] = [];
    const runner = claudeRunner({
      spawn: fakeSpawn(spawned([{ type: "system", subtype: "init" }, resultMessage]), calls),
      cwd: "/neutral",
      env: { HOME: "/home/u", CLAUDECODE: "1" },
    });

    const result = await runner(request);

    expect(result.output).toEqual({ labels: ["keep"], note: "ok" });
    expect(result.usage).toEqual({ costUsd: 0.0123, inputTokens: 115, outputTokens: 42, durationMs: 7 });
    const [argv, options] = calls[0] ?? [];
    expect(argv?.[0]).toBe("claude");
    expect(argv).toContain("--safe-mode");
    expect(argv).toContain("--no-session-persistence");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv?.slice(argv.indexOf("--tools"), argv.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
    expect(argv?.slice(argv.indexOf("--permission-mode"), argv.indexOf("--permission-mode") + 2)).toEqual([
      "--permission-mode",
      "dontAsk",
    ]);
    expect(options?.stdin).toBe("classify");
    expect(options?.cwd).toBe("/neutral");
    expect(options?.env).toEqual({ HOME: "/home/u" });
  });

  test("accepts a single result object", async () => {
    const result = await claudeRunner({ spawn: fakeSpawn(spawned(resultMessage)) })(request);
    expect(result.output.note).toBe("ok");
  });

  test("passes the JSON schema and the budget cap", () => {
    const argv = claudeArgs(request);
    const schema: unknown = JSON.parse(argv[argv.indexOf("--json-schema") + 1] ?? "null");
    expect(schema).toMatchObject({ type: "object", required: ["labels", "note"], additionalProperties: false });
    expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe("0.25");
  });

  test("rejects an output that does not match the codec, keeping the spend", async () => {
    const bad = { ...resultMessage, structured_output: { labels: ["maybe"], note: "x" } };
    const error = await failure(fakeSpawn(spawned([bad])));
    expect(error.kind).toBe("invalid-output");
    expect(error.message).toContain("$.labels[0]");
    expect(error.usage?.costUsd).toBe(0.0123);
  });

  test("rejects a success without structured output", async () => {
    const { structured_output: _dropped, ...withoutOutput } = resultMessage;
    expect((await failure(fakeSpawn(spawned([withoutOutput])))).kind).toBe("missing-output");
  });

  test("reports an error result such as a budget stop", async () => {
    const stopped = { ...resultMessage, subtype: "error_max_budget_usd", is_error: true };
    const error = await failure(fakeSpawn(spawned([stopped], { exitCode: 1 })));
    expect(error.kind).toBe("result-error");
    expect(error.message).toContain("error_max_budget_usd");
  });

  test("reports a timeout, a crash and garbage stdout", async () => {
    expect((await failure(fakeSpawn(spawned("", { timedOut: true, exitCode: null })))).kind).toBe("timeout");
    expect((await failure(fakeSpawn(spawned("boom", { exitCode: 2, stderr: "auth failed" })))).message).toContain(
      "auth failed",
    );
    expect((await failure(fakeSpawn(spawned("not json")))).kind).toBe("unparsable-stdout");
    expect((await failure(fakeSpawn(spawned([{ type: "assistant" }])))).kind).toBe("no-result");
  });
});

describe("childEnv", () => {
  test("drops CLAUDECODE and undefined values", () => {
    expect(childEnv({ A: "1", CLAUDECODE: "1", B: undefined })).toEqual({ A: "1" });
  });
});
