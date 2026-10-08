import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedRepoRootResolver, gitRepoRoot } from "./repo.ts";

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

describe("gitRepoRoot", () => {
  test("resolves a linked worktree to its main checkout", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "hindsight-repo-")));
    const main = join(dir, "main");
    git(dir, "init", "-q", main);
    git(main, "commit", "-q", "--allow-empty", "-m", "init");
    git(main, "worktree", "add", "-q", join(dir, "wt"));
    expect(gitRepoRoot(main)).toBe(main);
    expect(gitRepoRoot(join(dir, "wt"))).toBe(main);
  });

  test("resolves a deleted worktree through its nearest existing parent", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "hindsight-repo-")));
    git(dir, "init", "-q", "main");
    expect(gitRepoRoot(join(dir, "main", ".claude", "worktrees", "gone"))).toBe(join(dir, "main"));
  });

  test("returns null outside a checkout and for a missing dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "hindsight-norepo-"));
    expect(gitRepoRoot(dir)).toBeNull();
    expect(gitRepoRoot(join(dir, "gone"))).toBeNull();
  });

  test("caches one resolution per cwd", () => {
    let calls = 0;
    const resolve = cachedRepoRootResolver(() => {
      calls += 1;
      return null;
    });
    resolve("/a");
    resolve("/a");
    resolve("/b");
    expect(calls).toBe(2);
  });
});
