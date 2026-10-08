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

/** Below this, a call is refused rather than started with a cap too small to produce an answer. */
export const MIN_CALL_USD = 0.02;

/**
 * Each call reserves its `--max-budget-usd` cap before it starts, lowered to what remains of the run cap, so
 * concurrent calls cannot overshoot it. A failed call without reported usage is charged its whole reservation.
 */
export class Budget {
  private reservedUsd = 0;
  private readonly byStage = new Map<Stage, ModelUsage>();

  constructor(readonly capUsd: number) {}

  /** Reserves up to `wantedUsd` and returns the amount reserved, which becomes the call's cap. */
  reserve(label: string, wantedUsd: number): number {
    const available = Math.floor((this.capUsd - this.spentUsd() - this.reservedUsd) * 100 + 1e-6) / 100;
    if (available < MIN_CALL_USD) {
      throw new BudgetError(label, this.capUsd);
    }
    const amountUsd = Math.min(wantedUsd, available);
    this.reservedUsd += amountUsd;
    return amountUsd;
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
  const capUsd = budget.reserve(request.label, request.maxBudgetUsd);
  try {
    const result = await runner({ ...request, maxBudgetUsd: capUsd });
    budget.settle(stage, capUsd, result.usage);
    return result;
  } catch (error) {
    budget.settle(stage, capUsd, error instanceof ModelError ? error.usage : null);
    throw error;
  }
}
