export type RunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type RunOptions = {
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly stdin?: string;
};

const DEFAULT_TIMEOUT_MS = 30_000;

const repoScopedGitEnv = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_OBJECT_DIRECTORY"];

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !repoScopedGitEnv.includes(key)) env[key] = value;
  }
  return env;
}

export async function run(command: readonly string[], options: RunOptions): Promise<RunResult> {
  const child = Bun.spawn([...command], {
    cwd: options.cwd,
    env: childEnv(),
    stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const exitCode = await child.exited;
  if (child.signalCode !== null) {
    // A grandchild can keep the pipes open after the kill; waiting on them would defeat the timeout.
    return { exitCode, stdout: "", stderr: `killed by ${child.signalCode}` };
  }
  const [stdout, stderr] = await output;
  return { exitCode, stdout, stderr };
}

export async function git(cwd: string, args: readonly string[], stdin?: string): Promise<string> {
  const result = await run(["git", ...args], stdin === undefined ? { cwd } : { cwd, stdin });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd} (exit ${result.exitCode}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/** The checkout that holds `dir`, read synchronously for code that runs inside a SQLite transaction. */
export function gitToplevelSync(dir: string): string | null {
  const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
    cwd: dir,
    env: childEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

export async function gitToplevel(dir: string): Promise<string | null> {
  const result = await run(["git", "rev-parse", "--show-toplevel"], { cwd: dir });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

export async function hashObject(path: string, cwd: string): Promise<string> {
  return (await git(cwd, ["hash-object", "--", path])).trim();
}

/** Tracked files plus untracked files that are not ignored, relative to `repoRoot`. */
export async function listFiles(repoRoot: string): Promise<readonly string[]> {
  const output = await git(repoRoot, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  return [...new Set(output.split("\0").filter((path) => path !== ""))];
}
