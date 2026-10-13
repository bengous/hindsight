import type { RuleFile, RuleScope } from "./types.ts";

import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { gitToplevel, hashObject, listFiles } from "../platform/git.ts";
import { frontmatterPaths, importTargets, ruleBullets } from "./markdown.ts";

export type InventoryEnv = {
  readonly home: string;
};

export function defaultInventoryEnv(): InventoryEnv {
  return { home: homedir() };
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

function posix(value: string): string {
  return value.split(sep).join("/");
}

function idPrefixFor(path: string, repoRoot: string | null, home: string): string {
  if (repoRoot !== null && isInside(repoRoot, path)) {
    return posix(relative(repoRoot, path));
  }

  return isInside(home, path) ? `~/${posix(relative(home, path))}` : posix(path);
}

function importPath(target: string, importer: string, home: string): string {
  if (target.startsWith("~/")) {
    return join(home, target.slice(2));
  }

  return isAbsolute(target) ? target : join(dirname(importer), target);
}

function resolveImport(target: string, importer: string, home: string): string | null {
  const path = importPath(target, importer, home);

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

    if (parts.length === 3 && parts[0] === ".claude" && parts[1] === "output-styles") {
      return name.endsWith(".md") ? [scoped(join(repoRoot, file), "")] : [];
    }

    if (!instructionNames.has(name)) {
      return [];
    }

    const dir = parts.slice(0, -1);
    const base = dir.at(-1) === ".claude" ? dir.slice(0, -1) : dir;

    return [scoped(join(repoRoot, file), base.join("/"))];
  });

  return candidates.filter((candidate) => isFile(candidate.loadedPath));
}

function markdownUnder(dir: string, pattern: string): readonly string[] {
  return existsSync(dir)
    ? [...new Bun.Glob(pattern).scanSync({ cwd: dir, followSymlinks: true })].map((file) => join(dir, file))
    : [];
}

function globalCandidates(home: string): readonly Candidate[] {
  const claudeDir = join(home, ".claude");

  const roots = ["CLAUDE.md", "AGENTS.md"].flatMap((name) => {
    const path = join(claudeDir, name);

    return isFile(path) ? [path] : [];
  });

  const rules = markdownUnder(join(claudeDir, "rules"), "**/*.md");
  const styles = markdownUnder(join(claudeDir, "output-styles"), "*.md");

  return [...roots, ...rules, ...styles].map((loadedPath) => ({ loadedPath, scope: "global", impliedPaths: null }));
}

async function withImports(candidates: readonly Candidate[], home: string): Promise<readonly Candidate[]> {
  const all = [...candidates];
  const seen = new Set(candidates.map((candidate) => realpathSync(candidate.loadedPath)));
  let frontier: readonly Candidate[] = candidates;

  for (let hop = 0; hop < MAX_IMPORT_HOPS && frontier.length > 0; hop += 1) {
    const next: Candidate[] = [];

    // oxlint-disable-next-line eslint/no-await-in-loop -- each hop reads the files the previous hop imported: the hops cannot run at once.
    const importers = await Promise.all(
      frontier.map(async (importer) => ({ importer, text: await Bun.file(importer.loadedPath).text() })),
    );

    for (const { importer, text } of importers) {
      for (const target of importTargets(text)) {
        const loadedPath = resolveImport(target, importer.loadedPath, home);

        if (loadedPath === null || seen.has(realpathSync(loadedPath))) {
          continue;
        }

        seen.add(realpathSync(loadedPath));
        next.push({ loadedPath, scope: importer.scope, impliedPaths: importer.impliedPaths });
      }
    }

    all.push(...next);
    frontier = next;
  }

  return all;
}

/** The file the agents load is the file hindsight edits; a global file outside any checkout has no repoRoot. */
async function toRuleFile(candidate: Candidate, repoHint: string | null, env: InventoryEnv): Promise<RuleFile> {
  const inRepo = repoHint !== null && isInside(repoHint, candidate.loadedPath);
  const sourcePath = realpathSync(candidate.loadedPath);
  const repoRoot = inRepo ? repoHint : await gitToplevel(dirname(sourcePath));
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
    if (sources.has(file.sourcePath)) {
      return;
    }

    sources.add(file.sourcePath);
    files.push(file);
  };

  const globalFiles = await Promise.all(
    (await withImports(globalCandidates(env.home), env.home)).map(async (candidate) =>
      toRuleFile(candidate, null, env),
    ),
  );

  const repoFiles = await Promise.all(
    repoRoots.map(async (root) => {
      const repoRoot = await checkoutRoot(root);
      const candidates = await withImports(repoCandidates(repoRoot, await listFiles(repoRoot)), env.home);

      return Promise.all(candidates.map(async (candidate) => toRuleFile(candidate, repoRoot, env)));
    }),
  );

  for (const file of [...globalFiles, ...repoFiles.flat()]) {
    add(file);
  }

  return files;
}
