import type { Thresholds } from "./curate/curator.ts";
import type { SupportWork } from "./curate/curator.ts";
import type { CuratorGroup, Dropped, HistoryEntry, RuleSource } from "./curate/groups.ts";
import type { Effort, ModelAlias, ModelRunner } from "./model/claude.ts";
import type { ClusterThresholds } from "./signals/index.ts";
import type { BatchFailure, CachedExtraction, RunStatus, RunSummary } from "./state/index.ts";
import type { CollectOptions, CollectResult, Volumes } from "./transcripts/index.ts";
import type {
  ErrorCluster,
  ErrorEvent,
  HumanMessage,
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
import { join } from "node:path";
import { curationCanPass, curatorOutput, curatorPrompt, DEFAULT_THRESHOLDS, gateCuration } from "./curate/curator.ts";
import {
  DEFAULT_EXTRACTION_LIMITS,
  EXTRACTION_DROPS,
  evidenceText,
  EXTRACTION_PROMPT_VERSION,
  extractSession,
} from "./curate/extract.ts";
import { planGroups } from "./curate/groups.ts";
import { sha1 } from "./curate/ids.ts";
import { seedDigest } from "./curate/seeds.ts";
import { checkSupport, SUPPORT_PROMPT_VERSION, supportKey } from "./curate/support.ts";
import { Budget, budgetedCall } from "./model/budget.ts";
import { claudeRunner } from "./model/claude.ts";
import { decode } from "./model/codec.ts";
import { git, gitToplevel } from "./rules/git.ts";
import { ruleAppliesTo } from "./rules/glob.ts";
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
  readSupportVerdicts,
  runDir,
  writeCuration,
  writeExtraction,
  writeHeads,
  writeRunJson,
  writeRunLines,
  writeSupportVerdicts,
} from "./state/index.ts";
import { collect, volumes } from "./transcripts/index.ts";

export type PipelineDeps = {
  readonly collect: (options: CollectOptions) => Promise<CollectResult>;
  readonly clusterErrors: (events: readonly ErrorEvent[], thresholds: ClusterThresholds) => readonly ErrorCluster[];
  readonly inventory: (repoRoots: readonly string[]) => Promise<readonly RuleFile[]>;
  readonly staleScan: (files: readonly RuleFile[]) => Promise<readonly StaleFinding[]>;
  readonly ruleAppliesTo: (file: RuleFile, absPath: string, projectRoot: string | null) => boolean;
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
    ruleAppliesTo,
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

export const DEFAULT_SUPPORT_MODEL: StageModel = {
  model: "haiku",
  effort: "low",
  maxBudgetUsd: 0.2,
  timeoutMs: 3 * 60_000,
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
  /** The yes/no check that each cited message supports its proposal's lesson. */
  readonly support?: Partial<StageModel>;
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
    /** Sessions sent to extraction in this run, whole or only their new messages. */
    readonly extracted: number;
    /** Of those, sessions that had a cache entry and grew since. */
    readonly grown: number;
    /** Extraction batches retried one tier up after a schema failure. */
    readonly retried: number;
    readonly cached: number;
    readonly failed: number;
    readonly notRun: number;
  };
  readonly items: number;
  /** Items whose quote the human typed in several messages; each cites the earliest one. */
  readonly quotesRepeated: number;
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

type PendingExtraction = {
  /** The session restricted to the messages never sent to extraction under this prompt version. */
  readonly digest: SessionDigest;
  readonly entry: CachedExtraction | null;
};

/** Cached items whose message is still in the window and was extracted as it reads now. */
function cachedItems(entry: CachedExtraction | null, digest: SessionDigest): readonly SteeringItem[] {
  if (entry === null) {
    return [];
  }
  const known = new Set(entry.extractedUuids);
  const current = new Map<string, string>(digest.messages.map((message) => [message.evidenceId, message.uuid]));
  return entry.items.filter((item) => {
    const uuid = current.get(item.evidenceId);
    return uuid !== undefined && known.has(uuid);
  });
}

/** The user's routing rule: after a failed call, retry one tier up; never escalate to fable. */
const NEXT_TIER: Readonly<Record<ModelAlias, ModelAlias | null>> = { haiku: "sonnet", sonnet: "opus", opus: null };

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

/** One line per human message the proposals cite; tool-output evidence has no message and keeps its card excerpt. */
function evidenceLines(
  proposals: readonly Proposal[],
  digests: readonly SessionDigest[],
): readonly { readonly evidenceId: string; readonly text: string }[] {
  const messages = new Map<string, HumanMessage>(
    digests.flatMap((digest) => digest.messages.map((message) => [message.evidenceId, message] as const)),
  );
  const cited = new Set(proposals.flatMap((proposal) => proposal.evidence.map((evidence) => evidence.evidenceId)));
  return [...cited].flatMap((evidenceId) => {
    const message = messages.get(evidenceId);
    return message === undefined ? [] : [{ evidenceId, text: evidenceText(message) }];
  });
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
  const supportModel = { ...DEFAULT_SUPPORT_MODEL, ...options.support };
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
    const pending: PendingExtraction[] = [];
    let cached = 0;
    for (const digest of withText) {
      const entry = await readExtraction(stateRoot, digest.sessionId, promptVersion);
      items.push(...cachedItems(entry, digest));
      const known = new Set(entry?.extractedUuids ?? []);
      const fresh = digest.messages.filter((message) => !known.has(message.uuid));
      if (fresh.every((message) => message.text.trim() === "")) {
        cached += 1;
      } else {
        pending.push({ digest: { ...digest, messages: fresh }, entry });
      }
    }
    const ranked = pending.toSorted(
      (a, b) => rank(b.digest) - rank(a.digest) || b.digest.lastAt.localeCompare(a.digest.lastAt),
    );
    const selected = ranked.slice(0, options.maxSessions ?? ranked.length);
    const quoteDrops: Dropped[] = [];
    let extracted = 0;
    let grown = 0;
    let retried = 0;
    let quotesRepeated = 0;
    let failed = 0;
    await forEachPool(selected, options.concurrency ?? DEFAULT_CONCURRENCY, async ({ digest, entry }) => {
      const retryModel = NEXT_TIER[extractModel.model];
      const outcome = await extractSession(digest, deps.runner, budget, {
        ...extractModel,
        ...(retryModel === null ? {} : { retryModel }),
        limits: DEFAULT_EXTRACTION_LIMITS,
      });
      if (outcome.status === "failed") {
        failed += 1;
        failures.push(failureOf("extract", digest.sessionId, outcome.error));
        return;
      }
      extracted += 1;
      grown += entry === null ? 0 : 1;
      retried += outcome.retried;
      for (const reason of EXTRACTION_DROPS) {
        for (let index = 0; index < outcome.counts[reason]; index += 1) {
          quoteDrops.push({ reason, detail: digest.sessionId });
        }
      }
      quotesRepeated += outcome.counts["quote-repeated"];
      items.push(...outcome.items);
      const freshIds = new Set<string>(digest.messages.map((message) => message.evidenceId));
      await writeExtraction(stateRoot, {
        sessionId: digest.sessionId,
        promptVersion,
        extractedUuids: [...new Set([...(entry?.extractedUuids ?? []), ...digest.messages.map((m) => m.uuid)])],
        items: [...(entry?.items ?? []).filter((item) => !freshIds.has(item.evidenceId)), ...outcome.items],
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
    const dropped: Dropped[] = [...quoteDrops, ...plan.dropped];
    const context = {
      runId,
      now: deps.now().toISOString(),
      thresholds: options.thresholds ?? DEFAULT_THRESHOLDS,
      knownFingerprints: new Set(history.map((entry) => entry.fingerprint)),
      ruleAppliesTo: deps.ruleAppliesTo,
      unsupported: new Set<string>(),
    };
    const supportVersion = `${SUPPORT_PROMPT_VERSION}:${supportModel.model}`;
    const verdicts = new Map(await readSupportVerdicts(stateRoot, supportVersion));
    const messages = new Map<string, HumanMessage>(
      digests.flatMap((digest) => digest.messages.map((message) => [message.evidenceId, message] as const)),
    );
    const judge = async (work: readonly SupportWork[]): Promise<void> => {
      for (const { lesson, members } of work) {
        const open = members.flatMap((member) => {
          const message = messages.get(member.evidenceId);
          return message === undefined || verdicts.has(supportKey(lesson, member))
            ? []
            : [{ ...member, text: evidenceText(message) }];
        });
        if (open.length === 0) {
          continue;
        }
        try {
          for (const [key, supports] of await checkSupport(lesson, open, deps.runner, budget, supportModel)) {
            verdicts.set(key, supports);
          }
        } catch (error) {
          failures.push(failureOf("support", lesson, error));
        }
      }
    };
    for (const group of plan.groups) {
      if (!curationCanPass(group, context.thresholds)) {
        dropped.push({ reason: "group-skipped", detail: group.key });
        continue;
      }
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
        const first = gateCuration(group, output, context);
        await judge(first.supportWork);
        const unsupported = new Set(
          first.supportWork.flatMap(({ lesson, members }) =>
            members.flatMap((member) => {
              const key = supportKey(lesson, member);
              return verdicts.get(key) === false ? [key] : [];
            }),
          ),
        );
        const gated = unsupported.size === 0 ? first : gateCuration(group, output, { ...context, unsupported });
        proposals.push(...gated.proposals);
        dropped.push(...gated.dropped);
      } catch (error) {
        failures.push(failureOf("curate", group.key, error));
      }
    }

    await writeSupportVerdicts(stateRoot, supportVersion, verdicts);
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
    await writeRunLines(stateRoot, runId, "evidence.jsonl", evidenceLines(ordered, digests));
    await writeRunJson(stateRoot, runId, "proposals.json", ordered);
    await writeRunJson(stateRoot, runId, "dropped.json", dropped);
    await writeRunJson(stateRoot, runId, "cost.json", {
      extract: budget.usage("extract"),
      curate: budget.usage("curate"),
      support: budget.usage("support"),
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
      grown,
      retried,
      cached,
      failed,
      notRun: pending.length - selected.length,
      items: items.length,
      quotesRepeated,
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
        grown,
        retried,
        cached,
        failed,
        notRun: pending.length - selected.length,
      },
      items: items.length,
      quotesRepeated,
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
