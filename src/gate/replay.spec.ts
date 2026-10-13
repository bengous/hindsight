import type { SessionEvent } from "../transcripts/session.ts";

import { describe, expect, test } from "bun:test";

import { emptyFacts, markInterrupted } from "../domain/facts.ts";
import { turnFacts, turnsOf } from "./replay.ts";

const human = (text: string, at: string): SessionEvent => ({
  kind: "human",
  uuid: `u-${at}`,
  sessionId: "s",
  timestamp: at,
  text,
});

const tool = (name: string, at: string, isRefused = false): SessionEvent => ({
  kind: "tool",
  uuid: `t-${at}`,
  sessionId: "s",
  timestamp: at,
  tool: name,
  input: { command: "bun test" },
  inputText: "",
  outputText: "",
  isError: isRefused,
  isRefused,
});

const EVENTS: readonly SessionEvent[] = [
  human("ajoute un test", "2026-01-01T10:00:00Z"),
  tool("Bash", "2026-01-01T10:00:05Z", true),
  human("non, pas comme ça", "2026-01-01T10:01:00Z"),
  tool("Edit", "2026-01-01T10:01:05Z"),
];

describe("turnsOf", () => {
  test("a human message opens a turn and the tools until the next one close it", () => {
    const turns = turnsOf(EVENTS);
    expect(turns.map((t) => [t.text, t.tools.map((u) => u.tool)])).toEqual([
      ["ajoute un test", ["Bash"]],
      ["non, pas comme ça", ["Edit"]],
    ]);
  });
});

describe("turnFacts", () => {
  test("the markers of a message read the prompts and refusals carried from earlier turns, as the mod does", () => {
    const [first, second] = turnsOf(EVENTS);

    if (first === undefined || second === undefined) {
      throw new Error("two turns expected");
    }

    const afterFirst = turnFacts(emptyFacts, first);
    expect(afterFirst.humanTexts.map((h) => h.markers)).toEqual([[]]);
    expect(afterFirst.refusedTools).toEqual(["Bash"]);

    const afterSecond = turnFacts(afterFirst, second);
    expect(afterSecond.humanTexts.at(-1)?.markers).toEqual(["user_rejected", "correction_medium"]);
    expect(afterSecond.prompts).toBe(2);
    expect(afterSecond.toolCalls).toBe(2);
  });

  test("a message after an aborted turn carries the interrupt marker", () => {
    const [first, second] = turnsOf(EVENTS);

    if (first === undefined || second === undefined) {
      throw new Error("two turns expected");
    }

    const facts = turnFacts(markInterrupted(turnFacts(emptyFacts, first)), second);
    expect(facts.humanTexts.at(-1)?.markers).toContain("interrupt_followup");
    expect(facts.afterInterrupt).toBe(false);
  });

  test("a pass resets the carried facts: the next message is a first prompt again", () => {
    const [, second] = turnsOf(EVENTS);

    if (second === undefined) {
      throw new Error("two turns expected");
    }

    expect(turnFacts(emptyFacts, second).humanTexts.at(-1)?.markers).toEqual([]);
  });
});
