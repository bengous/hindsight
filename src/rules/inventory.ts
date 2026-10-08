import type { RuleFile, RuleScope } from "../types.ts";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { defaultResolver, type SourceResolver } from "./chezmoi.ts";
import { gitToplevel, hashObject, listFiles } from "./git.ts";
import { frontmatterPaths, importTargets, ruleBullets } from "./markdown.ts";

export type InventoryEnv = {
  readonly home: string;
  readonly resolveSource: SourceResolver;
};

export function defaultInventoryEnv(): InventoryEnv {
  const home = homedir();
  return { home, resolveSource: defaultResolver(home) };
}

const MAX_IMPORT_HOPS = 4;
const instructionNames = new Set(["AGENTS.md", "CLAUDE.md"]);

type Candidate = {
  readonly loadedPath: string;
  readonly scope: RuleScope;
  /** Loading condition of a file without its own `paths:` frontmatter; null when always loaded. */
  readonly impliedPaths: readonly string[] | null;
};

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

function idPrefixFor(path: string, repoRoot: string | null, home: string): string {
  const posix = (value: string): string => value.split(sep).join("/");
  if (repoRoot !== null && isInside(repoRoot, path)) return posix(relative(repoRoot, path));
  return isInside(home, path) ? `~/${posix(relative(home, path))}` : posix(path);
}

function resolveImport(target: string, importer: string, home: string): string | null {
  const path = target.startsWith("~/")
    ? join(home, target.slice(2))
    : isAbsolute(target)
      ? target
      : join(dirname(importer), target);
  return isFile(path) ? path : null;
}

function scoped(loadedPath: string, base: string): Candidate {
  return base === ""
    ? { loadedPath, scope: "repo", impliedPaths: null }
    : { loadedPath, scope: "path", impliedPaths: [`${base}/**`] };
}

function repoCandidates(repoRoot: string, files: readonly string[]): readonly Candidate[] {
  const candidates = files.flatMap((file) => {
    const parts = file.split("/");
    const name = parts.at(-1) ?? "";
    const rulesAt = parts.findIndex((part, index) => part === ".claude" && parts[index + 1] === "rules");
    if (rulesAt !== -1) {
      return name.endsWith(".md") ? [scoped(join(repoRoot, file), parts.slice(0, rulesAt).join("/"))] : [];
    }
    if (!instructionNames.has(name)) return [];
    const dir = parts.slice(0, -1);
    const base = dir.at(-1) === ".claude" ? dir.slice(0, -1) : dir;
    return [scoped(join(repoRoot, file), base.join("/"))];
  });
  return candidates.filter((candidate) => isFile(candidate.loadedPath));
}

function globalCandidates(home: string): readonly Candidate[] {
  const claudeDir = join(home, ".claude");
  const roots = ["CLAUDE.md", "AGENTS.md"].map((name) => join(claudeDir, name)).filter(isFile);
  const rulesDir = join(claudeDir, "rules");
  const rules = existsSync(rulesDir)
    ? [...new Bun.Glob("**/*.md").scanSync({ cwd: rulesDir, followSymlinks: true })].map((file) => join(rulesDir, file))
    : [];
  return [...roots, ...rules].map((loadedPath) => ({ loadedPath, scope: "global", impliedPaths: null }));
}

async function withImports(candidates: readonly Candidate[], home: string): Promise<readonly Candidate[]> {
  const all = [...candidates];
  const seen = new Set(candidates.map((candidate) => realpathSync(candidate.loadedPath)));
  let frontier: readonly Candidate[] = candidates;
  for (let hop = 0; hop < MAX_IMPORT_HOPS && frontier.length > 0; hop++) {
    const next: Candidate[] = [];
    for (const importer of frontier) {
      for (const target of importTargets(await Bun.file(importer.loadedPath).text())) {
        const loadedPath = resolveImport(target, importer.loadedPath, home);
        if (loadedPath === null || seen.has(realpathSync(loadedPath))) continue;
        seen.add(realpathSync(loadedPath));
        next.push({ loadedPath, scope: importer.scope, impliedPaths: importer.impliedPaths });
      }
    }
    all.push(...next);
    frontier = next;
  }
  return all;
}

async function toRuleFile(candidate: Candidate, repoHint: string | null, env: InventoryEnv): Promise<RuleFile> {
  const inRepo = repoHint !== null && isInside(repoHint, candidate.loadedPath);
  const sourcePath = realpathSync(inRepo ? candidate.loadedPath : await env.resolveSource(candidate.loadedPath));
  const repoRoot =
    repoHint !== null && isInside(repoHint, sourcePath) ? repoHint : await gitToplevel(dirname(sourcePath));
  const text = await Bun.file(sourcePath).text();
  return {
    loadedPath: candidate.loadedPath,
    sourcePath,
    repoRoot,
    scope: candidate.scope,
    blobHash: await hashObject(sourcePath, dirname(sourcePath)),
    paths: frontmatterPaths(text) ?? candidate.impliedPaths,
    bullets: ruleBullets(text, idPrefixFor(candidate.loadedPath, inRepo ? repoHint : null, env.home)),
  };
}

async function checkoutRoot(repoRoot: string): Promise<string> {
  const toplevel = await gitToplevel(repoRoot);
  if (toplevel === null || realpathSync(toplevel) !== realpathSync(repoRoot)) {
    throw new Error(`inventory: ${repoRoot} is not the toplevel of a git checkout (toplevel: ${toplevel ?? "none"})`);
  }
  return realpathSync(toplevel);
}

/** Rule files the agents load for these repos, plus the global ones, deduplicated on the file to edit. */
export async function inventory(
  repoRoots: readonly string[],
  env: InventoryEnv = defaultInventoryEnv(),
): Promise<readonly RuleFile[]> {
  const files: RuleFile[] = [];
  const sources = new Set<string>();
  const add = (file: RuleFile): void => {
    if (sources.has(file.sourcePath)) return;
    sources.add(file.sourcePath);
    files.push(file);
  };

  for (const candidate of await withImports(globalCandidates(env.home), env.home)) {
    add(await toRuleFile(candidate, null, env));
  }
  for (const root of repoRoots) {
    const repoRoot = await checkoutRoot(root);
    for (const candidate of await withImports(repoCandidates(repoRoot, await listFiles(repoRoot)), env.home)) {
      add(await toRuleFile(candidate, repoRoot, env));
    }
  }
  return files;
}
