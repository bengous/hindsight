import type { Thresholds } from "./curate/curator.ts";
import type { CuratorGroup, Dropped, HistoryEntry, RuleSource } from "./curate/groups.ts";
import type { Effort, ModelAlias, ModelRunner } from "./model/claude.ts";
import type { ClusterThresholds } from "./signals/index.ts";
import type { BatchFailure, RunStatus, RunSummary } from "./state/index.ts";
import type { CollectOptions, CollectResult, Volumes } from "./transcripts/index.ts";
import type {
  ErrorCluster,
  ErrorEvent,
  ModelUsage,
  Proposal,
  RuleFile,
  SessionDigest,
  StaleFinding,
  SteeringItem,
} from "./types.ts";
import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { curatorOutput, curatorPrompt, DEFAULT_THRESHOLDS, gateCuration } from "./curate/curator.ts";
import { DEFAULT_EXTRACTION_LIMITS, EXTRACTION_PROMPT_VERSION, extractSession } from "./curate/extract.ts";
import { planGroups } from "./curate/groups.ts";
import { sha1 } from "./curate/ids.ts";
import { seedDigest } from "./curate/seeds.ts";
import { Budget, budgetedCall } from "./model/budget.ts";
import { claudeRunner } from "./model/claude.ts";
import { decode } from "./model/codec.ts";
import { git, gitToplevel } from "./rules/git.ts";
import { globMatcher } from "./rules/glob.ts";
import { inventory } from "./rules/inventory.ts";
import { staleScan } from "./rules/stale.ts";
import { clusterErrors } from "./signals/index.ts";
import {
  createRun,
  defaultStateRoot,
  newRunId,
  proposalHistory,
  readCuration,
  readExtraction,
  readHeads,
  runDir,
  writeCuration,
  writeExtraction,
  writeHeads,
  writeRunJson,
  writeRunLines,
} from "./state/index.ts";
import { collect, volumes } from "./transcripts/index.ts";

export type PipelineDeps = {
  readonly collect: (options: CollectOptions) => Promise<CollectResult>;
  readonly clusterErrors: (events: readonly ErrorEvent[], thresholds: ClusterThresholds) => readonly ErrorCluster[];
  readonly inventory: (repoRoots: readonly string[]) => Promise<readonly RuleFile[]>;
  readonly staleScan: (files: readonly RuleFile[]) => Promise<readonly StaleFinding[]>;
  readonly matchesPaths: (globs: readonly string[], absFile: string, repoRoot: string) => boolean;
  /** Real path of the checkout toplevel at `path`, or null when it is not one (missing or not a git repository). */
  readonly checkoutRoot: (path: string) => Promise<string | null>;
  readonly headCommit: (repoRoot: string) => Promise<string>;
  /** `git diff` of `paths` between `fromCommit` and HEAD. */
  readonly ruleDiff: (repoRoot: string, fromCommit: string, paths: readonly string[]) => Promise<string>;
  readonly readText: (path: string) => Promise<string>;
  readonly modifiedAt: (path: string) => Promise<string>;
  readonly runner: ModelRunner;
  readonly now: () => Date;
};

export function defaultDeps(): PipelineDeps {
  return {
    collect,
    clusterErrors,
    inventory: (repoRoots) => inventory(repoRoots),
    staleScan,
    matchesPaths: (globs, absFile, repoRoot) => {
      const path = relative(repoRoot, absFile);
      return globs.some((glob) => globMatcher(glob)(path));
    },
    checkoutRoot: async (path) => {
      const toplevel = await gitToplevel(path).catch(() => null);
      return toplevel === null ? null : realpathSync(toplevel);
    },
    headCommit: async (repoRoot) => (await git(repoRoot, ["rev-parse", "HEAD"])).trim(),
    ruleDiff: (repoRoot, fromCommit, paths) =>
      paths.length === 0 ? Promise.resolve("") : git(repoRoot, ["diff", fromCommit, "HEAD", "--", ...paths]),
    readText: (path) => Bun.file(path).text(),
    modifiedAt: async (path) => (await stat(path)).mtime.toISOString(),
    runner: claudeRunner(),
    now: () => new Date(),
  };
}

export type ScanOptions = {
  /** Default `~/.claude/projects`. */
  readonly projectsDir?: string;
  /** Prevalence window, default 30 days. */
  readonly lookbackDays?: number;
  /** Read `archive/*.jsonl.gz|zst` too, default true. */
  readonly includeArchive?: boolean;
  /** Keep only sessions in these repositories; default every repository seen. */
  readonly repos?: readonly string[];
  readonly thresholds?: Thresholds;
};

export type ScanReport = {
  readonly since: string;
  /** Sessions whose repository has no checkout any more are counted under a null repoRoot. */
  readonly volumes: Volumes;
  /** Repository roots seen in the transcripts that are no git checkout now; their candidates fail closed. */
  readonly missingCheckouts: readonly string[];
  readonly ruleFiles: number;
  readonly clusters: readonly ErrorCluster[];
  readonly stale: readonly StaleFinding[];
};

export type StageModel = {
  readonly model: ModelAlias;
  readonly effort: Effort;
  /** `--max-budget-usd` of each call, reserved against the run budget before the call starts. */
  readonly maxBudgetUsd: number;
  readonly timeoutMs: number;
};

export const DEFAULT_EXTRACT_MODEL: StageModel = {
  model: "haiku",
  effort: "low",
  maxBudgetUsd: 0.5,
  timeoutMs: 5 * 60_000,
};

export const DEFAULT_CURATE_MODEL: StageModel = {
  model: "opus",
  effort: "high",
  maxBudgetUsd: 4,
  timeoutMs: 20 * 60_000,
};

export type RunOptions = ScanOptions & {
  /** Hard cap for the whole run, default 10 USD. */
  readonly budgetUsd?: number;
  readonly stateRoot?: string;
  /** Concurrent extraction calls, default 4. */
  readonly concurrency?: number;
  /** Extract at most this many sessions not already in the cache, highest-ranked first. */
  readonly maxSessions?: number;
  readonly extract?: Partial<StageModel>;
  readonly curate?: Partial<StageModel>;
  /** Old auto-memory notes to feed as `mem:<path>` evidence. */
  readonly seeds?: readonly string[];
  /** Repository the seed notes belong to. Required with `seeds`. */
  readonly seedRepo?: string;
};

export type RunReport = {
  readonly runId: string;
  readonly status: RunStatus;
  readonly stateDir: string;
  readonly sessions: {
    readonly collected: number;
    readonly withHumanText: number;
    readonly extracted: number;
    readonly cached: number;
    readonly failed: number;
    readonly notRun: number;
  };
  readonly items: number;
  readonly groups: number;
  readonly proposals: number;
  readonly dropped: Readonly<Record<string, number>>;
  readonly failures: readonly BatchFailure[];
  readonly usage: ModelUsage;
  readonly budgetUsd: number;
};

const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_BUDGET_USD = 10;
const DEFAULT_CONCURRENCY = 4;
const MAX_RULE_CHARS = 120_000;

function sinceOf(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/** Repository roots resolved to the real checkout path; a root without a checkout maps to null and fails closed. */
async function resolveCheckouts(
  roots: Iterable<string>,
  deps: PipelineDeps,
): Promise<ReadonlyMap<string, string | null>> {
  const resolved = new Map<string, string | null>();
  for (const root of new Set(roots)) {
    resolved.set(root, await deps.checkoutRoot(root));
  }
  return resolved;
}

function remapDigest(digest: SessionDigest, checkouts: ReadonlyMap<string, string | null>): SessionDigest {
  const repoRoot = digest.repoRoot === null ? null : (checkouts.get(digest.repoRoot) ?? null);
  return repoRoot === digest.repoRoot ? digest : { ...digest, repoRoot };
}

function remapEvent(event: ErrorEvent, checkouts: ReadonlyMap<string, string | null>): ErrorEvent {
  const repoRoot = event.repoRoot === null ? null : (checkouts.get(event.repoRoot) ?? null);
  return repoRoot === event.repoRoot ? event : { ...event, repoRoot };
}

type Gathered = {
  readonly since: Date;
  readonly digests: readonly SessionDigest[];
  readonly events: readonly ErrorEvent[];
  readonly checkouts: readonly string[];
  readonly volumes: Volumes;
  readonly missingCheckouts: readonly string[];
  readonly rules: readonly RuleFile[];
  readonly clusters: readonly ErrorCluster[];
  readonly stale: readonly StaleFinding[];
};

async function gather(options: ScanOptions, deps: PipelineDeps, extraRepos: readonly string[]): Promise<Gathered> {
  const since = sinceOf(deps.now(), options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS);
  const collected = await deps.collect({
    projectsDir: options.projectsDir ?? join(homedir(), ".claude", "projects"),
    since,
    includeArchive: options.includeArchive ?? true,
  });
  const seenRoots = [
    ...collected.digests.flatMap((digest) => (digest.repoRoot === null ? [] : [digest.repoRoot])),
    ...collected.errors.flatMap((event) => (event.repoRoot === null ? [] : [event.repoRoot])),
    ...(options.repos ?? []),
    ...extraRepos,
  ];
  const resolved = await resolveCheckouts(seenRoots, deps);
  const wanted =
    options.repos === undefined
      ? null
      : new Set(options.repos.map((root) => resolved.get(root)).filter((root) => root != null));
  const keep = (repoRoot: string | null): boolean => wanted === null || (repoRoot !== null && wanted.has(repoRoot));
  const digests = collected.digests.map((digest) => remapDigest(digest, resolved)).filter((d) => keep(d.repoRoot));
  const events = collected.errors.map((event) => remapEvent(event, resolved)).filter((e) => keep(e.repoRoot));
  const checkouts = [
    ...new Set([
      ...digests.flatMap((digest) => (digest.repoRoot === null ? [] : [digest.repoRoot])),
      ...events.flatMap((event) => (event.repoRoot === null ? [] : [event.repoRoot])),
      ...extraRepos.map((root) => resolved.get(root)).filter((root) => root != null),
    ]),
  ].toSorted();
  const rules = await deps.inventory(checkouts);
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  return {
    since,
    digests,
    events,
    checkouts,
    volumes: volumes({ digests, errors: events, stats: collected.stats }),
    missingCheckouts: [...resolved.entries()].flatMap(([root, checkout]) => (checkout === null ? [root] : [])),
    rules,
    clusters: deps.clusterErrors(events, thresholds),
    stale: await deps.staleScan(rules),
  };
}

/** Deterministic pass: no model call, no write. */
export async function scan(options: ScanOptions = {}, deps: PipelineDeps = defaultDeps()): Promise<ScanReport> {
  const gathered = await gather(options, deps, []);
  return {
    since: gathered.since.toISOString(),
    volumes: gathered.volumes,
    missingCheckouts: gathered.missingCheckouts,
    ruleFiles: gathered.rules.length,
    clusters: gathered.clusters,
    stale: gathered.stale,
  };
}

async function forEachPool<T>(values: readonly T[], limit: number, fn: (value: T) => Promise<void>): Promise<void> {
  const queue = [...values];
  const worker = async (): Promise<void> => {
    for (let value = queue.shift(); value !== undefined; value = queue.shift()) {
      await fn(value);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, values.length)) }, worker));
}

function rank(digest: SessionDigest): number {
  return digest.messages.reduce((sum, message) => sum + message.markers.length, 0);
}

function lastUuid(digest: SessionDigest): string {
  return digest.messages.toSorted((a, b) => a.timestamp.localeCompare(b.timestamp)).at(-1)?.uuid ?? "";
}

async function loadSeeds(options: RunOptions, deps: PipelineDeps): Promise<readonly SessionDigest[]> {
  const seeds = options.seeds ?? [];
  if (seeds.length === 0) {
    return [];
  }
  if (options.seedRepo === undefined) {
    throw new Error("run: seeds need seedRepo, the repository the notes belong to");
  }
  const repoRoot = await deps.checkoutRoot(options.seedRepo);
  if (repoRoot === null) {
    throw new Error(`run: seed repository ${options.seedRepo} is not a git checkout`);
  }
  return Promise.all(
    seeds.map(async (path) =>
      seedDigest({ path, repoRoot, text: await deps.readText(path), modifiedAt: await deps.modifiedAt(path) }),
    ),
  );
}

function failureOf(stage: BatchFailure["stage"], key: string, error: unknown): BatchFailure {
  const kind =
    error instanceof Error ? ("kind" in error && typeof error.kind === "string" ? error.kind : error.name) : "unknown";
  return { stage, key, kind, message: error instanceof Error ? error.message : String(error) };
}

function historyEntries(history: Awaited<ReturnType<typeof proposalHistory>>): readonly HistoryEntry[] {
  return history.map(({ proposal, decision }) => ({
    fingerprint: proposal.fingerprint,
    title: proposal.title,
    kind: proposal.kind,
    sourcePath: proposal.target.sourcePath,
    status: decision?.decision ?? "pending",
    reason: decision?.reason ?? null,
  }));
}

/** Cache key of a curator call: the inputs that can change its answer, without the history and the rule diff. */
function curationHash(group: CuratorGroup, stage: StageModel): string {
  return sha1(`${stage.model}\n${stage.effort}\n${curatorPrompt({ ...group, history: [], ruleDiff: "" })}`);
}

const CONFIDENCE_ORDER: Readonly<Record<Proposal["confidence"], number>> = { high: 0, medium: 1, low: 2 };

function countBy(dropped: readonly Dropped[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const entry of dropped) {
    counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
  }
  return counts;
}

/** Full pass: extraction and curation through the model, proposals written to the run directory, nothing else. */
export async function run(options: RunOptions = {}, deps: PipelineDeps = defaultDeps()): Promise<RunReport> {
  const stateRoot = options.stateRoot ?? defaultStateRoot();
  const startedAt = deps.now();
  const runId = newRunId(startedAt);
  await createRun(stateRoot, runId);
  const budget = new Budget(options.budgetUsd ?? DEFAULT_BUDGET_USD);
  const extractModel = { ...DEFAULT_EXTRACT_MODEL, ...options.extract };
  const curateModel = { ...DEFAULT_CURATE_MODEL, ...options.curate };
  const failures: BatchFailure[] = [];
  const summary = (status: RunStatus, counts: Readonly<Record<string, number>>): RunSummary => ({
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: status === "running" ? null : deps.now().toISOString(),
    status,
    usage: budget.usage(),
    budgetUsd: budget.capUsd,
    failures,
    counts,
  });
  await writeRunJson(stateRoot, runId, "run.json", summary("running", {}));

  try {
    const seeds = await loadSeeds(options, deps);
    const gathered = await gather(options, deps, options.seedRepo === undefined ? [] : [options.seedRepo]);
    const digests = [...gathered.digests, ...seeds];
    const withText = digests.filter((digest) => digest.messages.some((message) => message.text.trim() !== ""));

    const promptVersion = `${EXTRACTION_PROMPT_VERSION}:${extractModel.model}`;
    const items: SteeringItem[] = [];
    const toExtract: SessionDigest[] = [];
    let cached = 0;
    for (const digest of withText) {
      const hit = await readExtraction(stateRoot, {
        sessionId: digest.sessionId,
        lastUuid: lastUuid(digest),
        promptVersion,
      });
      if (hit === null) {
        toExtract.push(digest);
      } else {
        cached += 1;
        items.push(...hit);
      }
    }
    const ranked = toExtract.toSorted((a, b) => rank(b) - rank(a) || b.lastAt.localeCompare(a.lastAt));
    const selected = ranked.slice(0, options.maxSessions ?? ranked.length);
    let extracted = 0;
    let failed = 0;
    await forEachPool(selected, options.concurrency ?? DEFAULT_CONCURRENCY, async (digest) => {
      const outcome = await extractSession(digest, deps.runner, budget, {
        ...extractModel,
        limits: DEFAULT_EXTRACTION_LIMITS,
      });
      if (outcome.status === "failed") {
        failed += 1;
        failures.push(failureOf("extract", digest.sessionId, outcome.error));
        return;
      }
      extracted += 1;
      items.push(...outcome.items);
      await writeExtraction(stateRoot, {
        key: { sessionId: digest.sessionId, lastUuid: lastUuid(digest), promptVersion },
        items: outcome.items,
        at: deps.now().toISOString(),
      });
    });

    const rules: RuleSource[] = await Promise.all(
      gathered.rules.map(async (file) => ({ file, text: await deps.readText(file.sourcePath) })),
    );
    const heads = await readHeads(stateRoot);
    const ruleRepos = [...new Set(gathered.rules.flatMap((file) => (file.repoRoot === null ? [] : [file.repoRoot])))];
    const ruleDiffs = new Map<string, string>();
    for (const repoRoot of ruleRepos) {
      const from = heads[repoRoot];
      if (from !== undefined) {
        const paths = gathered.rules.filter((file) => file.repoRoot === repoRoot).map((file) => file.sourcePath);
        ruleDiffs.set(repoRoot, await deps.ruleDiff(repoRoot, from, paths));
      }
    }
    const history = historyEntries(await proposalHistory(stateRoot));
    const plan = planGroups({
      digests,
      items: items.toSorted((a, b) => a.evidenceId.localeCompare(b.evidenceId)),
      rules,
      clusters: gathered.clusters,
      events: gathered.events,
      stale: gathered.stale,
      ruleDiffs,
      history,
      maxRuleChars: MAX_RULE_CHARS,
    });

    const proposals: Proposal[] = [];
    const dropped: Dropped[] = [...plan.dropped];
    const context = {
      runId,
      now: deps.now().toISOString(),
      thresholds: options.thresholds ?? DEFAULT_THRESHOLDS,
      knownFingerprints: new Set(history.map((entry) => entry.fingerprint)),
      matchesPaths: deps.matchesPaths,
    };
    for (const group of plan.groups) {
      try {
        const inputHash = curationHash(group, curateModel);
        const stored = await readCuration(stateRoot, group.key, inputHash);
        let output = stored === null ? null : decode(curatorOutput, stored);
        if (output === null) {
          const result = await budgetedCall(deps.runner, budget, "curate", {
            label: `curate ${group.key}`,
            ...curateModel,
            prompt: curatorPrompt(group),
            output: curatorOutput,
          });
          output = result.output;
          await writeCuration(stateRoot, { groupKey: group.key, inputHash, output, at: deps.now().toISOString() });
        }
        const gated = gateCuration(group, output, context);
        proposals.push(...gated.proposals);
        dropped.push(...gated.dropped);
      } catch (error) {
        failures.push(failureOf("curate", group.key, error));
      }
    }

    const ordered = proposals.toSorted(
      (a, b) =>
        CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence] ||
        b.prevalence.sessions - a.prevalence.sessions,
    );
    await writeRunLines(
      stateRoot,
      runId,
      "digests.jsonl",
      digests.map((digest) => ({
        sessionId: digest.sessionId,
        title: digest.title,
        repoRoot: digest.repoRoot,
        firstAt: digest.firstAt,
        lastAt: digest.lastAt,
        humanMessages: digest.messages.length,
      })),
    );
    await writeRunLines(stateRoot, runId, "items.jsonl", items);
    await writeRunJson(stateRoot, runId, "proposals.json", ordered);
    await writeRunJson(stateRoot, runId, "dropped.json", dropped);
    await writeRunJson(stateRoot, runId, "cost.json", {
      extract: budget.usage("extract"),
      curate: budget.usage("curate"),
      total: budget.usage(),
      budgetUsd: budget.capUsd,
    });

    const newHeads: Record<string, string> = { ...heads };
    for (const repoRoot of ruleRepos) {
      newHeads[repoRoot] = await deps.headCommit(repoRoot);
    }
    await writeHeads(stateRoot, newHeads);

    const status: RunStatus = failures.length === 0 ? "complete" : "partial";
    const counts = {
      collected: gathered.digests.length,
      seeds: seeds.length,
      extracted,
      cached,
      failed,
      notRun: toExtract.length - selected.length,
      items: items.length,
      groups: plan.groups.length,
      proposals: ordered.length,
      dropped: dropped.length,
    };
    await writeRunJson(stateRoot, runId, "run.json", summary(status, counts));
    return {
      runId,
      status,
      stateDir: runDir(stateRoot, runId),
      sessions: {
        collected: gathered.digests.length,
        withHumanText: withText.length,
        extracted,
        cached,
        failed,
        notRun: toExtract.length - selected.length,
      },
      items: items.length,
      groups: plan.groups.length,
      proposals: ordered.length,
      dropped: countBy(dropped),
      failures,
      usage: budget.usage(),
      budgetUsd: budget.capUsd,
    };
  } catch (error) {
    await writeRunJson(stateRoot, runId, "run.json", summary("failed", {}));
    throw error;
  }
}
