import type { ModelRunner } from "../model/claude.ts";
import { describe, expect, test } from "bun:test";
import { promptData } from "../../fixtures/curate/world.ts";
import { Budget } from "../model/budget.ts";
import { decode } from "../model/codec.ts";
import { checkSupport, excerptAround, supportKey, supportOutput, supportPrompt } from "./support.ts";

const lesson = "Build orders with makeOrder() in tests.";
const members = [
  { evidenceId: "s1:u1", quote: "makeOrder()", text: `${"a".repeat(800)} utilise makeOrder() ici ${"b".repeat(800)}` },
  {
    evidenceId: "s2:u1",
    quote: "garde le fichier court",
    text: "on ne rédige pas un manuel, garde le fichier court",
  },
] as const;

const settings = { model: "haiku", effort: "low", maxBudgetUsd: 0.2, timeoutMs: 60_000 } as const;

function runner(answer: (refs: readonly string[]) => unknown, calls: string[] = []): ModelRunner {
  return async (request) => {
    calls.push(request.prompt);
    const data = promptData(request.prompt) as { excerpts: { ref: string }[] };
    return {
      output: decode(request.output, answer(data.excerpts.map((excerpt) => excerpt.ref))),
      usage: { costUsd: 0.001, inputTokens: 10, outputTokens: 2, durationMs: 1 },
    };
  };
}

describe("supportPrompt", () => {
  test("sends the lesson and a bounded window of each message around its quote, as data", () => {
    const data = promptData(supportPrompt(lesson, members)) as {
      lesson: string;
      excerpts: { ref: string; quote: string; context: string }[];
    };
    expect(data.lesson).toBe(lesson);
    expect(data.excerpts.map((excerpt) => excerpt.ref)).toEqual(["e1", "e2"]);
    expect(data.excerpts[0]?.context).toContain("utilise makeOrder() ici");
    expect(data.excerpts[0]?.context.length).toBeLessThan(1300);
  });

  test("excerptAround keeps the quote even when it sits at the edge", () => {
    expect(excerptAround("makeOrder() au début", "makeOrder()", 5)).toBe("makeOrder() au d");
  });
});

describe("checkSupport", () => {
  test("returns one verdict per member, keyed by lesson and evidence", async () => {
    const result = await checkSupport(
      lesson,
      members,
      runner(() => ({
        verdicts: [
          { ref: "e1", supports: true },
          { ref: "e2", supports: false },
        ],
      })),
      new Budget(1),
      settings,
    );
    expect(result).toEqual(
      new Map([
        [supportKey(lesson, members[0]), true],
        [supportKey(lesson, members[1]), false],
      ]),
    );
  });

  test("fails when a verdict is missing or names an unknown excerpt", async () => {
    const missing = runner(() => ({ verdicts: [{ ref: "e1", supports: true }] }));
    await expect(checkSupport(lesson, members, missing, new Budget(1), settings)).rejects.toThrow("e2");
    const unknown = runner(() => ({
      verdicts: [
        { ref: "e1", supports: true },
        { ref: "e2", supports: true },
        { ref: "e9", supports: false },
      ],
    }));
    await expect(checkSupport(lesson, members, unknown, new Budget(1), settings)).rejects.toThrow("e9");
  });

  test("the key changes with the lesson wording, not with its case or punctuation", () => {
    expect(supportKey("Build orders with makeOrder() in tests.", members[0])).toBe(
      supportKey("build orders with makeorder in tests", members[0]),
    );
    expect(supportKey("Use factories in tests.", members[0])).not.toBe(supportKey(lesson, members[0]));
  });

  test("the output schema is a strict list of boolean verdicts", () => {
    expect(() => decode(supportOutput, { verdicts: [{ ref: "e1", supports: "yes" }] })).toThrow("a boolean");
  });
});
