import type { Host } from "./host.ts";
import type { SessionMessage } from "claude-code";

import { describe, expect, test } from "bun:test";

import { CliError, runCli } from "./cli-client.ts";
import { cacheShareOf } from "./debrief.ts";
import { lastTurnTools } from "./gate.ts";
import { noticeLine } from "./notice.ts";
import { factsSince, freshState, pruneStore, readState } from "./state.ts";

const message = (
  role: "user" | "assistant",
  text: string,
  toolUses: SessionMessage["toolUses"] = [],
): SessionMessage => ({
  role,
  text,
  toolUses,
});

describe("lastTurnTools", () => {
  test("keeps the tool uses after the last human prompt and reads refusals from the error text", () => {
    const messages = [
      message("user", "first"),
      message("assistant", "", [{ tool_use_id: "1", tool: "Edit", input: { file_path: "/a" } }]),
      message("user", "second"),
      message("assistant", "", [
        {
          tool_use_id: "2",
          tool: "Bash",
          input: { command: "bun test -u" },
          isError: true,
          text: "The user doesn't want to proceed",
        },
        { tool_use_id: "3", tool: "Bash", input: { command: "bun test" }, isError: true, text: "exit 1" },
      ]),
      message("user", "", []),
    ];

    const last = {
      ...messages[4],
      toolResults: [{ tool_use_id: "3", text: "exit 1", isError: true, result: null }],
    } as SessionMessage;

    expect(lastTurnTools([...messages.slice(0, 4), last])).toEqual([
      { tool: "Bash", path: null, command: "bun test -u", isError: true, isRefused: true },
      { tool: "Bash", path: null, command: "bun test", isError: true, isRefused: false },
    ]);
  });
});

describe("cacheShareOf", () => {
  test("is the cache-read part of the fork's input", () => {
    expect(
      cacheShareOf({
        isAnswered: true,
        text: "",
        usage: {
          input_tokens: 1000,
          output_tokens: 1,
          cache_read_input_tokens: 99_000,
          cache_creation_input_tokens: 0,
        },
      }),
    ).toBeCloseTo(0.99);
    expect(
      cacheShareOf({
        isAnswered: true,
        text: "",
        usage: { input_tokens: 500, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 99_500 },
      }),
    ).toBe(0);
  });
});

describe("noticeLine", () => {
  test("names pending Proposals and failed Debriefs, or clears the line", () => {
    expect(noticeLine({ pendingProposals: 0, failures: 0 })).toBeUndefined();
    expect(noticeLine({ pendingProposals: 1, failures: 0 })).toBe("1 Proposal en attente · /hindsight review");
    expect(noticeLine({ pendingProposals: 3, failures: 2 })).toBe(
      "3 Proposals en attente · /hindsight review · 2 Debriefs en erreur · /hindsight status",
    );
  });
});

function fakeHost(
  answer: { exitCode: number; stdout: string; stderr?: string },
  store = new Map<string, unknown>(),
): Host {
  return {
    pluginRoot: "/plugin",
    now: async () => 10_000_000_000,
    sessionId: async () => "s",
    repoRoot: async () => null,
    messages: async () => [],
    storeGet: async (key) => store.get(key),
    storeSet: async (key, value) => {
      store.set(key, value);
    },
    storeDelete: async (key) => {
      store.delete(key);
    },
    storeKeys: async () => [...store.keys()],
    run: async () => ({ ...answer, stderr: answer.stderr ?? "", isStdoutTruncated: false, isStderrTruncated: false }),
    classify: async () => {},
    fork: async () => ({ isAnswered: false, reason: "nothing-to-fork" }),
    after: () => {},
    status: () => {},
    toast: () => {},
    log: () => {},
    fill: async () => {},
  };
}

describe("runCli", () => {
  test("reads the last stdout line as JSON and names a failure", async () => {
    expect(await runCli(fakeHost({ exitCode: 0, stdout: 'warning\n{"ok":true}\n' }), ["status"])).toEqual({ ok: true });
    await expect(
      runCli(fakeHost({ exitCode: 2, stdout: "", stderr: "boom\nlast line" }), ["status"]),
    ).rejects.toBeInstanceOf(CliError);
    await expect(runCli(fakeHost({ exitCode: 0, stdout: "not json" }), ["status"])).rejects.toThrow("not a JSON line");
  });
});

describe("readState and factsSince", () => {
  test("a fork lock older than fifteen minutes no longer holds, and the facts added during a Debrief stay", async () => {
    const now = Date.UTC(2026, 9, 13, 12);
    const stale = { ...freshState(now), forkRunning: true, forkStartedAt: now - 16 * 60_000 };
    const live = { ...freshState(now), forkRunning: true, forkStartedAt: now - 60_000 };

    const host = fakeHost(
      { exitCode: 0, stdout: "{}" },
      new Map<string, unknown>([
        ["session:a", stale],
        ["session:b", live],
      ]),
    );

    expect((await readState(host, "a", now)).forkRunning).toBe(false);
    expect((await readState(host, "b", now)).forkRunning).toBe(true);
    const before = freshState(now).facts;
    const during = { ...before, humanTexts: [{ text: "pendant le fork", markers: [] }], prompts: 1, toolCalls: 2 };
    expect(factsSince(during, before)).toMatchObject({
      humanTexts: [{ text: "pendant le fork" }],
      prompts: 1,
      toolCalls: 2,
    });
    expect(factsSince(during, during)).toMatchObject({ humanTexts: [], prompts: 0, toolCalls: 0 });
  });
});

describe("pruneStore", () => {
  test("drops session states older than seven days and stale day counters", async () => {
    const now = Date.UTC(2026, 9, 13);

    const store = new Map<string, unknown>([
      ["session:old", { ...freshState(now), updatedAt: now - 8 * 86_400_000 }],
      ["session:new", { ...freshState(now), updatedAt: now - 3_600_000 }],
      ["session:broken", "x"],
      ["day:2026-10-01", 4],
      ["day:2026-10-13", 2],
    ]);

    const host = fakeHost({ exitCode: 0, stdout: "{}" }, store);
    expect(await pruneStore(host, now)).toBe(3);
    expect([...store.keys()].sort()).toEqual(["day:2026-10-13", "session:new"]);
  });
});
