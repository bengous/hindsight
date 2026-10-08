import type { ModelRequest, ModelRunner } from "./claude.ts";
import { describe, expect, test } from "bun:test";
import { Budget, BudgetError, budgetedCall, MIN_CALL_USD } from "./budget.ts";
import { ModelError } from "./claude.ts";
import { object, string } from "./codec.ts";

const request: ModelRequest<{ readonly note: string }> = {
  label: "curate /repo",
  model: "opus",
  effort: "high",
  prompt: "p",
  output: object({ note: string() }),
  maxBudgetUsd: 4,
  timeoutMs: 1000,
};

function runner(costUsd: number, caps: number[]): ModelRunner {
  return async (sent) => {
    caps.push(sent.maxBudgetUsd);
    return {
      output: { note: "ok" } as never,
      usage: { costUsd: Math.min(costUsd, sent.maxBudgetUsd), inputTokens: 1, outputTokens: 1, durationMs: 1 },
    };
  };
}

describe("budgetedCall", () => {
  test("lowers the call cap to what remains of the run budget", async () => {
    const caps: number[] = [];
    const budget = new Budget(2);
    await budgetedCall(runner(0.3, caps), budget, "extract", { ...request, maxBudgetUsd: 0.5 });
    await budgetedCall(runner(1, caps), budget, "curate", request);
    expect(caps).toEqual([0.5, 1.7]);
    expect(budget.usage()).toMatchObject({ calls: 2, costUsd: 1.3 });
  });

  test("a very large run budget leaves every call at its own stage cap", () => {
    const budget = new Budget(1000);
    expect([budget.reserve("e", 0.5), budget.reserve("c", 4), budget.reserve("s", 0.2)]).toEqual([0.5, 4, 0.2]);
  });

  test("keeps whole cents of the remaining budget despite float error", () => {
    const budget = new Budget(1);
    budget.settle("extract", budget.reserve("a", 0.5), {
      costUsd: 0.4,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
    });
    budget.settle("extract", budget.reserve("b", 0.5), {
      costUsd: 0.4,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
    });
    expect(budget.reserve("c", 0.5)).toBe(0.2);
  });

  test("refuses a call when less than the minimum remains, without calling the model", async () => {
    const caps: number[] = [];
    const budget = new Budget(0.5);
    await budgetedCall(runner(0.5 - MIN_CALL_USD / 2, caps), budget, "extract", request);
    await expect(budgetedCall(runner(0.1, caps), budget, "curate", request)).rejects.toThrow(BudgetError);
    expect(caps).toEqual([0.5]);
  });

  test("charges a failed call its reported spend, or its whole reservation when none was reported", async () => {
    const budget = new Budget(2);
    const failing =
      (usage: ModelError["usage"]): ModelRunner =>
      async () => {
        throw new ModelError("timeout", "x", "killed", usage);
      };
    await expect(budgetedCall(failing(null), budget, "extract", { ...request, maxBudgetUsd: 0.5 })).rejects.toThrow(
      ModelError,
    );
    const reported = { costUsd: 0.1, inputTokens: 1, outputTokens: 1, durationMs: 1 };
    await expect(budgetedCall(failing(reported), budget, "extract", { ...request, maxBudgetUsd: 0.5 })).rejects.toThrow(
      ModelError,
    );
    expect(budget.usage()).toMatchObject({ calls: 2, costUsd: 0.6 });
  });
});
