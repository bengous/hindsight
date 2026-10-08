/** `<sessionId>:<uuid>` for a transcript entry, `mem:<absolute path>` for an old auto-memory note. */
export type EvidenceId = `${string}:${string}`;

export type IsoTimestamp = string;

/** Ranking features found by deterministic code. They order the work; they never gate it. */
export type Marker =
  | "interrupt_followup"
  | "user_rejected"
  | "question_rejected"
  | "plan_rejected"
  | "correction_strong"
  | "correction_medium"
  | "frustration"
  | "standing_instruction";

export type LoadedRuleSource = "instructions" | "nested_memory" | "output_style";

export type LoadedRule = {
  readonly path: string;
  readonly source: LoadedRuleSource;
  /** Rule text as the session saw it, or null when the transcript did not carry it. */
  readonly content: string | null;
};

export type HumanMessage = {
  readonly evidenceId: EvidenceId;
  readonly sessionId: string;
  readonly uuid: string;
  readonly timestamp: IsoTimestamp;
  readonly cwd: string;
  /** Human-typed text with foreign pastes and harness blocks removed. */
  readonly text: string;
  /** Tail of the visible assistant text before this message. */
  readonly precedingAssistant: string;
  /** Paths of the rule files in context when the message was sent. */
  readonly loadedRulePaths: readonly string[];
  readonly markers: readonly Marker[];
};

export type SessionDigest = {
  readonly sessionId: string;
  /** Session ids merged into this digest through `continued-in` links, oldest first. */
  readonly chain: readonly string[];
  readonly title: string | null;
  readonly cwd: string;
  /** Git toplevel of `cwd` (worktrees resolved to the main checkout), or null without a checkout. */
  readonly repoRoot: string | null;
  readonly firstAt: IsoTimestamp;
  readonly lastAt: IsoTimestamp;
  readonly messages: readonly HumanMessage[];
  /** Every rule file loaded at some point of the session, with the text it had then. */
  readonly loadedRules: readonly LoadedRule[];
  /** `file_path` inputs of Read, Edit and Write calls, used to check `paths:` globs. */
  readonly filesTouched: readonly string[];
};

export type ErrorEvent = {
  readonly evidenceId: EvidenceId;
  readonly sessionId: string;
  readonly repoRoot: string | null;
  readonly timestamp: IsoTimestamp;
  readonly tool: string;
  /** Tool plus masked first error line (paths, numbers and ids replaced). */
  readonly signature: string;
  readonly excerpt: string;
};

export type ErrorCluster = {
  readonly signature: string;
  readonly tool: string;
  readonly sessions: number;
  readonly days: number;
  readonly repoRoots: readonly string[];
  readonly sample: readonly EvidenceId[];
  readonly excerpt: string;
};

export type RuleScope = "global" | "repo" | "path";

export type RuleBullet = {
  /** `<path relative to repoRoot or ~>#<sha1 of normalized text, 8 hex>`: stable across line moves. */
  readonly id: string;
  readonly line: number;
  readonly text: string;
};

export type RuleFile = {
  /** Path the agents load (for the global file: `~/.claude/AGENTS.md`). */
  readonly loadedPath: string;
  /** File to edit: the chezmoi source for a deployed global file, else `loadedPath`. */
  readonly sourcePath: string;
  /** Git checkout that holds `sourcePath`, or null when none does (fail closed on apply). */
  readonly repoRoot: string | null;
  readonly scope: RuleScope;
  /** `git hash-object` of `sourcePath` at inventory time. */
  readonly blobHash: string;
  /** `paths:` globs from the frontmatter, or null for an always-loaded file. */
  readonly paths: readonly string[] | null;
  readonly bullets: readonly RuleBullet[];
};

export type StaleFinding = {
  /** sha1 of sourcePath + reason + detail, 10 hex: stable across runs. */
  readonly id: string;
  readonly sourcePath: string;
  readonly repoRoot: string | null;
  readonly bulletId: string | null;
  readonly reason: "dead-glob" | "missing-path" | "missing-command" | "missing-symbol";
  readonly detail: string;
};

/** Output of the per-session extraction call. */
export type SteeringItem = {
  readonly evidenceId: EvidenceId;
  /** Verbatim substring of the cited message text. */
  readonly quote: string;
  /** "explicit": a standing instruction stated by the human; "inferred": a lesson drawn from a correction. */
  readonly kind: "explicit" | "inferred";
  /** One generalized sentence, in English. */
  readonly lesson: string;
  readonly scopeHint: RuleScope;
  readonly pathHint: string | null;
};

export type Verdict = "missing" | "ignored" | "misplaced" | "conflict" | "watch";

export type FindingKind = Verdict | "tool-config" | "stale";

/** One exact replacement. An empty `oldText` creates `file`, which must not exist yet. */
export type TextEdit = {
  readonly oldText: string;
  readonly newText: string;
};

export type DeltaOp = {
  readonly op: "add" | "update" | "remove" | "consolidate";
  readonly sourcePath: string;
  readonly edits: readonly TextEdit[];
};

export type Prevalence = {
  readonly sessions: number;
  readonly days: number;
  readonly repos: number;
  readonly firstAt: IsoTimestamp;
  readonly lastAt: IsoTimestamp;
};

export type EvidenceItem = {
  readonly evidenceId: EvidenceId;
  readonly sessionTitle: string | null;
  readonly timestamp: IsoTimestamp;
  readonly quote: string;
};

export type Proposal = {
  readonly id: string;
  /** sha1 of target sourcePath + normalized lesson; the rejection ledger keys on it. */
  readonly fingerprint: string;
  readonly kind: FindingKind;
  /** Card claim for the human, in French, at most two lines. */
  readonly title: string;
  /** Reasoning for the human, in French. */
  readonly why: string;
  /** One English sentence stating the default behaviour; the commit body starts with it. */
  readonly lesson: string;
  /** English imperative commit subject, at most 72 characters. */
  readonly commitSubject: string;
  readonly target: {
    readonly repoRoot: string;
    readonly sourcePath: string;
    readonly blobHash: string | null;
  };
  /** Null for text-only findings: tool-config, hook or lint suggestions, watch items. */
  readonly op: DeltaOp | null;
  readonly suggestion: string | null;
  readonly ruleBulletIds: readonly string[];
  readonly prevalence: Prevalence;
  readonly evidence: readonly EvidenceItem[];
  readonly confidence: "high" | "medium" | "low";
};

export type Decision = {
  readonly proposalId: string;
  readonly fingerprint: string;
  readonly runId: string;
  readonly decision: "accepted" | "rejected";
  /** Set when the human edited the new text before accepting. */
  readonly editedOp: DeltaOp | null;
  readonly reason: string | null;
  readonly commit: string | null;
  readonly at: IsoTimestamp;
};

export type ModelUsage = {
  readonly calls: number;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
};
