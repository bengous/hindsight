import type { RuleFile } from "../types.ts";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

const MAX_EXPANSIONS = 1000;

function closingBrace(pattern: string, open: number): number {
  let depth = 0;
  for (let i = open; i < pattern.length; i++) {
    if (pattern[i] === "\\") i++;
    else if (pattern[i] === "{") depth++;
    else if (pattern[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

/** Splits on commas outside braces: `a/{b,c},d` gives `a/{b,c}` and `d`. */
export function splitTopLevel(inner: string): readonly string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "\\") i++;
    else if (inner[i] === "{") depth++;
    else if (inner[i] === "}") depth--;
    else if (inner[i] === "," && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts;
}

/** Brace expansion as Claude Code applies it to `paths:` globs; a pattern over budget stays unexpanded. */
export function expandBraces(pattern: string): readonly string[] {
  const open = pattern.indexOf("{");
  if (open === -1) return [pattern];
  const close = closingBrace(pattern, open);
  if (close === -1) return [pattern];
  const alternatives = splitTopLevel(pattern.slice(open + 1, close));
  if (alternatives.length < 2) return [pattern];
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  const expanded = alternatives.flatMap((alternative) => expandBraces(`${head}${alternative}${tail}`));
  return expanded.length > MAX_EXPANSIONS ? [pattern] : expanded;
}

export function globMatcher(pattern: string): (path: string) => boolean {
  const globs = expandBraces(pattern).map((expanded) => new Bun.Glob(expanded));
  return (path) => globs.some((glob) => glob.match(path));
}

const globChars = /[*?[\]{}]/;

/** True when a file under `base` matches; scans only below the pattern's literal directory prefix. */
export function matchesOnDisk(base: string, pattern: string): boolean {
  return expandBraces(pattern).some((expanded) => {
    const segments = expanded.split("/");
    const literal = segments.findIndex((segment) => globChars.test(segment));
    if (literal === -1) return existsSync(join(base, expanded));
    if (literal === 0) return false;
    const cwd = join(base, ...segments.slice(0, literal));
    if (!existsSync(cwd)) return false;
    const scan = new Bun.Glob(segments.slice(literal).join("/")).scanSync({ cwd, onlyFiles: true, dot: true });
    return scan.next().done !== true;
  });
}

/** Directory a rule file speaks for: the parent of its `.claude/`, else its own directory. */
export function ownerDir(file: RuleFile, repoRoot: string): string {
  const parts = relative(repoRoot, file.sourcePath).split("/");
  const claudeAt = parts.findIndex(
    (part, index) => part === ".claude" && (index === parts.length - 2 || parts[index + 1] === "rules"),
  );
  return join(repoRoot, ...(claudeAt === -1 ? parts.slice(0, -1) : parts.slice(0, claudeAt)));
}

function within(base: string, path: string): string | null {
  const rel = relative(base, path);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? null : rel;
}

/**
 * Whether a rule loads for a file the session read or wrote. Globs of a repository rule match from the checkout or
 * from the rule's owner directory, as the stale scan reads them; a global rule's globs match from the session's project.
 */
export function ruleAppliesTo(file: RuleFile, absPath: string, projectRoot: string | null): boolean {
  if (file.paths === null) return true;
  const bases =
    file.scope === "global" || file.repoRoot === null
      ? projectRoot === null
        ? []
        : [projectRoot]
      : [file.repoRoot, ownerDir(file, file.repoRoot)];
  const matchers = file.paths.map(globMatcher);
  return bases.some((base) => {
    const rel = within(base, absPath);
    return rel !== null && matchers.some((matches) => matches(rel));
  });
}
