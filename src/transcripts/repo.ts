import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";

function git(cwd: string, args: readonly string[]): string | null {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

function nearestExisting(path: string): string | null {
  for (let current = path; ; current = dirname(current)) {
    if (existsSync(current)) return current;
    if (dirname(current) === current) return null;
  }
}

/**
 * Main checkout of the repository that holds `cwd`: a linked worktree resolves to its main checkout,
 * and a deleted directory (a removed worktree) resolves through its nearest existing parent.
 */
export function gitRepoRoot(cwd: string): string | null {
  const dir = nearestExisting(cwd);
  if (dir === null) return null;
  const commonDir = git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (commonDir === null) return null;
  if (basename(commonDir) === ".git") return dirname(commonDir);
  return git(dir, ["rev-parse", "--show-toplevel"]);
}

export function cachedRepoRootResolver(resolve: (cwd: string) => string | null = gitRepoRoot) {
  const cache = new Map<string, string | null>();
  return (cwd: string): string | null => {
    const known = cache.get(cwd);
    if (known !== undefined) return known;
    const root = resolve(cwd);
    cache.set(cwd, root);
    return root;
  };
}
