export type RuleScope = "global" | "repo" | "path";

export type RuleBullet = {
  /** `<path relative to repoRoot or ~>#<sha1 of normalized text, 8 hex>`: stable across line moves. */
  readonly id: string;
  readonly line: number;
  readonly text: string;
};

export type RuleFile = {
  /** Path the agents load; the file hindsight edits, as the agents load it. */
  readonly loadedPath: string;
  readonly sourcePath: string;
  /** Git checkout that holds the file, or null for a global file outside any checkout (written directly). */
  readonly repoRoot: string | null;
  readonly scope: RuleScope;
  /** `git hash-object` of the file at inventory time. */
  readonly blobHash: string;
  /** `paths:` globs from the frontmatter, or null for an always-loaded file. */
  readonly paths: readonly string[] | null;
  readonly bullets: readonly RuleBullet[];
};

export type StaleReason = "dead-glob" | "missing-path" | "missing-command";

export type StaleFinding = {
  /** sha1 of sourcePath + reason + detail, 10 hex: stable across runs. */
  readonly id: string;
  readonly sourcePath: string;
  readonly repoRoot: string | null;
  readonly bulletId: string | null;
  readonly reason: StaleReason;
  readonly detail: string;
};
