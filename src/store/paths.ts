import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Paths = {
  readonly stateRoot: string;
  readonly dbPath: string;
  readonly configPath: string;
  readonly logDir: string;
  readonly projectsDir: string;
};

const DIR_MODE = 0o700;

export const FILE_MODE = 0o600;

export function hindsightPaths(env: Readonly<Record<string, string | undefined>> = process.env): Paths {
  const home = env["HOME"] ?? homedir();
  const stateBase = env["XDG_STATE_HOME"] ?? join(home, ".local", "state");
  const configBase = env["XDG_CONFIG_HOME"] ?? join(home, ".config");
  const stateRoot = join(stateBase, "hindsight");

  return {
    stateRoot,
    dbPath: join(stateRoot, "hindsight.sqlite"),
    configPath: join(configBase, "hindsight", "config.json"),
    logDir: join(stateRoot, "logs"),
    projectsDir: env["HINDSIGHT_PROJECTS_DIR"] ?? join(home, ".claude", "projects"),
  };
}

export function ensurePrivateDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode: DIR_MODE });
  }

  chmodSync(path, DIR_MODE);
}
