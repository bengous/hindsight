import type { ModelUsage } from "../types.ts";
import type { CallUsage, ModelRequest, ModelResult, ModelRunner } from "./claude.ts";
import { ModelError } from "./claude.ts";

export type Stage = "extract" | "curate";

export class BudgetError extends Error {
  constructor(
    readonly label: string,
    readonly capUsd: number,
  ) {
    super(`${label}: run budget of ${capUsd.toFixed(2)} USD exhausted`);
    this.name = "BudgetError";
  }
}

const EMPTY_USAGE: ModelUsage = { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };

/**
 * Each call reserves its own `--max-budget-usd` cap before it starts, so concurrent calls cannot overshoot the run cap.
 * A failed call without reported usage is charged its whole reservation.
 */
export class Budget {
  private reservedUsd = 0;
  private readonly byStage = new Map<Stage, ModelUsage>();

  constructor(readonly capUsd: number) {}

  reserve(label: string, amountUsd: number): void {
    if (this.spentUsd() + this.reservedUsd + amountUsd > this.capUsd + 1e-9) {
      throw new BudgetError(label, this.capUsd);
    }
    this.reservedUsd += amountUsd;
  }

  settle(stage: Stage, reservedUsd: number, usage: CallUsage | null): void {
    this.reservedUsd = Math.max(0, this.reservedUsd - reservedUsd);
    const previous = this.byStage.get(stage) ?? EMPTY_USAGE;
    this.byStage.set(stage, {
      calls: previous.calls + 1,
      costUsd: previous.costUsd + (usage?.costUsd ?? reservedUsd),
      inputTokens: previous.inputTokens + (usage?.inputTokens ?? 0),
      outputTokens: previous.outputTokens + (usage?.outputTokens ?? 0),
    });
  }

  spentUsd(): number {
    return [...this.byStage.values()].reduce((sum, usage) => sum + usage.costUsd, 0);
  }

  usage(stage?: Stage): ModelUsage {
    const stages = stage === undefined ? [...this.byStage.values()] : [this.byStage.get(stage) ?? EMPTY_USAGE];
    return stages.reduce(
      (total, usage) => ({
        calls: total.calls + usage.calls,
        costUsd: total.costUsd + usage.costUsd,
        inputTokens: total.inputTokens + usage.inputTokens,
        outputTokens: total.outputTokens + usage.outputTokens,
      }),
      EMPTY_USAGE,
    );
  }
}

export async function budgetedCall<T>(
  runner: ModelRunner,
  budget: Budget,
  stage: Stage,
  request: ModelRequest<T>,
): Promise<ModelResult<T>> {
  budget.reserve(request.label, request.maxBudgetUsd);
  try {
    const result = await runner(request);
    budget.settle(stage, request.maxBudgetUsd, result.usage);
    return result;
  } catch (error) {
    budget.settle(stage, request.maxBudgetUsd, error instanceof ModelError ? error.usage : null);
    throw error;
  }
}
