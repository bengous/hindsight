export type HindsightConfig = {
  readonly gate: {
    readonly threshold: number;
    readonly cooldownMs: number;
    readonly cooldownMaxSteps: number;
    readonly quietMinTools: number;
    readonly dailyCap: number;
    readonly minCacheShare: number;
    readonly classifierModel: string | null;
  };
  readonly learn: {
    readonly pendingNotes: number;
    readonly minIntervalMs: number;
    readonly model: string;
    readonly maxBudgetUsd: number;
    readonly timeoutMs: number;
  };
  readonly notes: { readonly windowDays: number };
  readonly review: { readonly pageSize: number };
  readonly excludedRepos: readonly string[];
};

export const defaultConfig: HindsightConfig = {
  gate: {
    threshold: 1,
    cooldownMs: 90_000,
    cooldownMaxSteps: 5,
    quietMinTools: 3,
    dailyCap: 20,
    minCacheShare: 0.9,
    classifierModel: null,
  },
  learn: {
    pendingNotes: 8,
    minIntervalMs: 6 * 60 * 60 * 1000,
    model: "opus",
    maxBudgetUsd: 2,
    timeoutMs: 15 * 60 * 1000,
  },
  notes: { windowDays: 30 },
  review: { pageSize: 3 },
  excludedRepos: [],
};

type Json = Readonly<Record<string, unknown>>;

const isJson = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

function num(source: Json, key: string, fallback: number): number {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(source: Json, key: string, fallback: string): string {
  const value = source[key];
  return typeof value === "string" && value !== "" ? value : fallback;
}

/** Overlays a parsed `config.json` on the defaults; an unreadable or absent field keeps its default. */
export function readConfig(input: unknown): HindsightConfig {
  const root = isJson(input) ? input : {};
  const gate = isJson(root["gate"]) ? root["gate"] : {};
  const learn = isJson(root["learn"]) ? root["learn"] : {};
  const notes = isJson(root["notes"]) ? root["notes"] : {};
  const review = isJson(root["review"]) ? root["review"] : {};
  const excluded = root["excludedRepos"];
  const classifier = gate["classifierModel"];
  return {
    gate: {
      threshold: num(gate, "threshold", defaultConfig.gate.threshold),
      cooldownMs: num(gate, "cooldownMs", defaultConfig.gate.cooldownMs),
      cooldownMaxSteps: num(gate, "cooldownMaxSteps", defaultConfig.gate.cooldownMaxSteps),
      quietMinTools: num(gate, "quietMinTools", defaultConfig.gate.quietMinTools),
      dailyCap: num(gate, "dailyCap", defaultConfig.gate.dailyCap),
      minCacheShare: num(gate, "minCacheShare", defaultConfig.gate.minCacheShare),
      classifierModel: typeof classifier === "string" && classifier !== "" ? classifier : null,
    },
    learn: {
      pendingNotes: num(learn, "pendingNotes", defaultConfig.learn.pendingNotes),
      minIntervalMs: num(learn, "minIntervalMs", defaultConfig.learn.minIntervalMs),
      model: str(learn, "model", defaultConfig.learn.model),
      maxBudgetUsd: num(learn, "maxBudgetUsd", defaultConfig.learn.maxBudgetUsd),
      timeoutMs: num(learn, "timeoutMs", defaultConfig.learn.timeoutMs),
    },
    notes: { windowDays: num(notes, "windowDays", defaultConfig.notes.windowDays) },
    review: { pageSize: num(review, "pageSize", defaultConfig.review.pageSize) },
    excludedRepos: Array.isArray(excluded) ? excluded.filter((entry) => typeof entry === "string") : [],
  };
}
