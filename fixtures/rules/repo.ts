import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type TempRepo = {
  readonly root: string;
  /** Empty hooks directory wired as `core.hooksPath`, outside the work tree. */
  readonly hooks: string;
  readonly git: (...args: string[]) => string;
  readonly write: (path: string, content: string) => void;
  readonly cleanup: () => void;
};

export function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `hindsight-${prefix}-`)));
}

export function writeTree(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

/** A git checkout with synthetic files, one initial commit, local identity, no signing and no inherited hooks. */
export function tempRepo(files: Readonly<Record<string, string>>): TempRepo {
  const base = tempDir("rules-repo");
  const root = join(base, "work");
  const hooks = join(base, "hooks");
  mkdirSync(root);
  mkdirSync(hooks);
  const git = (...args: string[]): string => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    return result.stdout.toString();
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", hooks);
  writeTree(root, files);
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", "fixture");
  return {
    root,
    hooks,
    git,
    write: (path, content) => writeTree(root, { [path]: content }),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}
