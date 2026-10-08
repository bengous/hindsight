import type {
  ErrorCluster,
  ErrorEvent,
  EvidenceId,
  HumanMessage,
  IsoTimestamp,
  Proposal,
  RuleFile,
  SessionDigest,
  StaleFinding,
  SteeringItem,
} from "../types.ts";
import { collapseWhitespace, expandHome } from "./ids.ts";

export type RuleSource = {
  readonly file: RuleFile;
  /** Current text of `file.sourcePath`. */
  readonly text: string;
};

export type ItemRef = {
  readonly item: SteeringItem;
  readonly sessionId: string;
  readonly sessionTitle: string | null;
  readonly repoRoot: string | null;
  readonly timestamp: IsoTimestamp;
  /** Absolute loaded paths of the rules in context when the message was sent. */
  readonly loadedRulePaths: readonly string[];
  readonly filesTouched: readonly string[];
  /** Loaded paths whose current bullets are not all in the text the session saw. */
  readonly changedRulePaths: readonly string[];
};

export type ClusterRef = {
  readonly cluster: ErrorCluster;
  readonly events: readonly ErrorEvent[];
};

export type HistoryEntry = {
  readonly fingerprint: string;
  readonly title: string;
  readonly kind: Proposal["kind"];
  readonly sourcePath: string;
  readonly status: "accepted" | "rejected" | "pending";
  readonly reason: string | null;
};

export const GLOBAL_GROUP = "global";

export type CuratorGroup = {
  /** `global` or the repository root. */
  readonly key: string;
  /** Checkout that holds the group's rule sources, or null: every op then fails closed. */
  readonly repoRoot: string | null;
  readonly rules: readonly RuleSource[];
  /** Rule files of the scope sent by name only, to keep the prompt bounded. */
  readonly listedRules: readonly RuleFile[];
  readonly items: readonly ItemRef[];
  readonly clusters: readonly ClusterRef[];
  readonly stale: readonly StaleFinding[];
  readonly ruleDiff: string;
  readonly history: readonly HistoryEntry[];
};

export type Dropped = {
  readonly reason: string;
  readonly detail: string;
};

export type PlanInput = {
  readonly digests: readonly SessionDigest[];
  readonly items: readonly SteeringItem[];
  readonly rules: readonly RuleSource[];
  readonly clusters: readonly ErrorCluster[];
  readonly events: readonly ErrorEvent[];
  readonly stale: readonly StaleFinding[];
  /** Rule-file diff since the last run, by repository root. */
  readonly ruleDiffs: ReadonlyMap<string, string>;
  readonly history: readonly HistoryEntry[];
  readonly maxRuleChars: number;
};

type Located = { readonly message: HumanMessage; readonly digest: SessionDigest };

function indexMessages(digests: readonly SessionDigest[]): ReadonlyMap<EvidenceId, Located> {
  const index = new Map<EvidenceId, Located>();
  for (const digest of digests) {
    for (const message of digest.messages) {
      index.set(message.evidenceId, { message, digest });
    }
  }
  return index;
}

function changedRulePaths(digest: SessionDigest, rules: readonly RuleSource[]): readonly string[] {
  return digest.loadedRules.flatMap((loaded) => {
    if (loaded.content === null) {
      return [];
    }
    const current = rules.find((rule) => expandHome(rule.file.loadedPath) === loaded.path);
    if (current === undefined) {
      return [];
    }
    const seen = collapseWhitespace(loaded.content);
    const changed = current.file.bullets.some((bullet) => !seen.includes(collapseWhitespace(bullet.text)));
    return changed ? [loaded.path] : [];
  });
}

function itemRef(item: SteeringItem, located: Located, rules: readonly RuleSource[]): ItemRef {
  const { message, digest } = located;
  return {
    item,
    sessionId: digest.sessionId,
    sessionTitle: digest.title,
    repoRoot: digest.repoRoot,
    timestamp: message.timestamp,
    loadedRulePaths: message.loadedRulePaths,
    filesTouched: digest.filesTouched,
    changedRulePaths: changedRulePaths(digest, rules),
  };
}

function isGlobalRule(rule: RuleSource): boolean {
  return rule.file.scope === "global";
}

function boundRules(
  candidates: readonly RuleSource[],
  needed: ReadonlySet<string>,
  maxChars: number,
): { readonly rules: readonly RuleSource[]; readonly listed: readonly RuleFile[] } {
  const priority = (rule: RuleSource): number =>
    rule.file.paths === null
      ? 0
      : needed.has(expandHome(rule.file.loadedPath)) || needed.has(rule.file.sourcePath)
        ? 1
        : 2;
  const ordered = candidates.toSorted((a, b) => priority(a) - priority(b) || a.text.length - b.text.length);
  const rules: RuleSource[] = [];
  const listed: RuleFile[] = [];
  let total = 0;
  for (const rule of ordered) {
    if (priority(rule) < 2 && total + rule.text.length <= maxChars) {
      rules.push(rule);
      total += rule.text.length;
    } else {
      listed.push(rule.file);
    }
  }
  return { rules, listed };
}

type Bucket = {
  items: ItemRef[];
  clusters: ClusterRef[];
  stale: StaleFinding[];
};

/** Assigns every item, cluster and stale finding to one curator call: its repository, or `global`. */
export function planGroups(input: PlanInput): {
  readonly groups: readonly CuratorGroup[];
  readonly dropped: readonly Dropped[];
} {
  const messages = indexMessages(input.digests);
  const globalRules = input.rules.filter(isGlobalRule);
  const buckets = new Map<string, Bucket>();
  const dropped: Dropped[] = [];
  const bucket = (key: string): Bucket => {
    const existing = buckets.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created: Bucket = { items: [], clusters: [], stale: [] };
    buckets.set(key, created);
    return created;
  };

  for (const item of input.items) {
    const located = messages.get(item.evidenceId);
    if (located === undefined) {
      throw new Error(`planGroups: steering item cites ${item.evidenceId}, absent from the collected sessions`);
    }
    const key = item.scopeHint === "global" ? GLOBAL_GROUP : located.digest.repoRoot;
    if (key === null) {
      dropped.push({ reason: "no-checkout", detail: `${item.evidenceId} (${located.digest.cwd})` });
      continue;
    }
    bucket(key).items.push(itemRef(item, located, input.rules));
  }

  for (const cluster of input.clusters) {
    const [only, ...others] = cluster.repoRoots;
    if (only === undefined) {
      dropped.push({ reason: "no-checkout", detail: `error cluster ${cluster.signature}` });
      continue;
    }
    const events = input.events.filter((event) => event.signature === cluster.signature);
    bucket(others.length > 0 ? GLOBAL_GROUP : only).clusters.push({ cluster, events });
  }

  const globalSources = new Set(globalRules.map((rule) => rule.file.sourcePath));
  for (const finding of input.stale) {
    const key = globalSources.has(finding.sourcePath) ? GLOBAL_GROUP : finding.repoRoot;
    if (key === null) {
      dropped.push({ reason: "no-checkout", detail: `stale finding ${finding.id} in ${finding.sourcePath}` });
      continue;
    }
    bucket(key).stale.push(finding);
  }

  const groups = [...buckets.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([key, content]): CuratorGroup => {
      const needed = new Set([
        ...content.items.flatMap((ref) => ref.loadedRulePaths),
        ...content.stale.map((finding) => finding.sourcePath),
      ]);
      const loadedElsewhere = input.rules.filter(
        (rule) => !isGlobalRule(rule) && rule.file.repoRoot !== key && needed.has(expandHome(rule.file.loadedPath)),
      );
      const scopeRules =
        key === GLOBAL_GROUP
          ? [...globalRules, ...loadedElsewhere]
          : [
              ...input.rules.filter((rule) => rule.file.repoRoot === key && !isGlobalRule(rule)),
              ...globalRules,
              ...loadedElsewhere,
            ];
      const { rules, listed } = boundRules(scopeRules, needed, input.maxRuleChars);
      const repoRoot = key === GLOBAL_GROUP ? (globalRules[0]?.file.repoRoot ?? null) : key;
      return {
        key,
        repoRoot,
        rules,
        listedRules: listed,
        items: content.items,
        clusters: content.clusters,
        stale: content.stale,
        ruleDiff: repoRoot === null ? "" : (input.ruleDiffs.get(repoRoot) ?? ""),
        history: input.history,
      };
    });
  return { groups, dropped };
}
