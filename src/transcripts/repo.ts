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

function siblingCheckout(path: string): string | null {
  const segments = path.split("/");
  const index = segments.findIndex((segment) => segment.endsWith(".wt") && segment !== ".wt");
  if (index === -1) return null;
  const checkout = [...segments.slice(0, index), (segments[index] ?? "").slice(0, -".wt".length)].join("/");
  return existsSync(checkout) ? checkout : null;
}

/**
 * Main checkout of the repository that holds `cwd`: a linked worktree resolves to its main checkout.
 * A deleted directory resolves through the `<repo>.wt/...` sibling convention, else through its nearest
 * existing parent.
 */
export function gitRepoRoot(cwd: string): string | null {
  const dir = existsSync(cwd) ? cwd : (siblingCheckout(cwd) ?? nearestExisting(cwd));
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
