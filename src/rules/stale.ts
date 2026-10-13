import type { RuleFile, StaleFinding } from "./types.ts";

import { Schema } from "effect";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { listFiles, run } from "./git.ts";
import { expandBraces, globMatcher, matchesOnDisk, ownerDir } from "./glob.ts";
import { isInside } from "./inventory.ts";
import { bodyLines, bulletAt, codeSpans } from "./markdown.ts";

type RepoView = {
  readonly files: readonly string[];
  readonly ignored: (path: string) => Promise<boolean>;
};

const NOT_A_PATH = /[\s*?[\]{}<>$|`'"=]|:\/\/|\.\.\./;

const LINE_SUFFIX = /:\d+(?:-\d+)?$/;

const SCRIPT_CALL = /(?:^|[\s`(;&|])(bun|npm|pnpm|yarn)\s+run\s+([^\s`'")]+)/g;

const FILE_SCRIPT = /\.(?:[cm]?[jt]s|sh)$/;

const PackageManifest = Schema.Struct({ scripts: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)) });

const decodeManifest = Schema.decodeSync(Schema.fromJsonString(PackageManifest));

function findingId(sourcePath: string, reason: StaleFinding["reason"], detail: string): string {
  return new Bun.CryptoHasher("sha1").update(`${sourcePath}\0${reason}\0${detail}`).digest("hex").slice(0, 10);
}

function finding(
  file: RuleFile,
  reason: StaleFinding["reason"],
  detail: string,
  bulletId: string | null,
): StaleFinding {
  return {
    id: findingId(file.sourcePath, reason, detail),
    sourcePath: file.sourcePath,
    repoRoot: file.repoRoot,
    bulletId,
    reason,
    detail,
  };
}

function deadGlobs(file: RuleFile, repoRoot: string, view: RepoView): readonly StaleFinding[] {
  if (file.paths === null) {
    return [];
  }

  const owner = relative(repoRoot, ownerDir(file, repoRoot));

  const local =
    owner === ""
      ? []
      : view.files.filter((path) => path.startsWith(`${owner}/`)).map((path) => path.slice(owner.length + 1));

  return file.paths.flatMap((glob) => {
    const matches = globMatcher(glob);

    const alive =
      view.files.some(matches) ||
      local.some(matches) ||
      matchesOnDisk(repoRoot, glob) ||
      (owner !== "" && matchesOnDisk(join(repoRoot, owner), glob));

    return alive ? [] : [finding(file, "dead-glob", glob, null)];
  });
}

function pathCandidate(code: string): string | null {
  const token = code
    .replace(LINE_SUFFIX, "")
    .replace(/^\.\//, "")
    .replace(/[.,;:]+$/, "");

  if (!token.includes("/") || token.endsWith("/") || NOT_A_PATH.test(token)) {
    return null;
  }

  if (/^[~/@#-]/.test(token) || token.startsWith("../")) {
    return null;
  }

  return token;
}

type MissingPath = { readonly line: number; readonly token: string; readonly cited: string };

async function missingPaths(file: RuleFile, repoRoot: string, view: RepoView): Promise<readonly StaleFinding[]> {
  const text = await Bun.file(file.sourcePath).text();
  const bases = [...new Set([repoRoot, ownerDir(file, repoRoot), dirname(file.sourcePath)])];

  const candidates = codeSpans(text).flatMap((span): MissingPath[] => {
    const token = pathCandidate(span.code);

    if (token === null) {
      return [];
    }

    const first = token.split("/")[0] ?? "";
    const anchored = bases.filter((base) => existsSync(join(base, first)));

    if (anchored.length === 0) {
      return [];
    }

    const cited = anchored.map((base) => relative(repoRoot, join(base, token)));

    if (anchored.some((base) => existsSync(join(base, token)))) {
      return [];
    }

    if (view.files.some((path) => cited.some((prefix) => path.startsWith(prefix)))) {
      return [];
    }

    return [{ line: span.line, token, cited: cited[0] ?? token }];
  });

  const checked = await Promise.all(
    candidates.map(async (candidate) => ({ candidate, ignored: await view.ignored(candidate.cited) })),
  );

  return checked.flatMap(({ candidate, ignored }) =>
    ignored ? [] : [finding(file, "missing-path", candidate.token, bulletAt(file.bullets, candidate.line)?.id ?? null)],
  );
}

function manifestsUpTo(from: string, repoRoot: string): readonly string[] {
  const manifests: string[] = [];

  for (let dir = from; isInside(repoRoot, dir); dir = dirname(dir)) {
    const manifest = join(dir, "package.json");

    if (existsSync(manifest)) {
      manifests.push(manifest);
    }

    if (dir === repoRoot) {
      break;
    }
  }

  return manifests;
}

async function scriptNames(manifest: string): Promise<readonly string[]> {
  let parsed: typeof PackageManifest.Type;

  try {
    parsed = decodeManifest(await Bun.file(manifest).text());
  } catch (error) {
    throw new Error(`stale scan: cannot parse ${manifest}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }

  return parsed.scripts === undefined ? [] : Object.keys(parsed.scripts);
}

async function missingCommands(file: RuleFile, repoRoot: string): Promise<readonly StaleFinding[]> {
  const manifests = manifestsUpTo(dirname(file.sourcePath), repoRoot);

  if (manifests.length === 0) {
    return [];
  }

  const scripts = new Set((await Promise.all(manifests.map(scriptNames))).flat());

  const isBin = (name: string): boolean =>
    manifests.some((manifest) => existsSync(join(dirname(manifest), "node_modules", ".bin", name)));

  const findings: StaleFinding[] = [];

  for (const line of bodyLines(await Bun.file(file.sourcePath).text())) {
    for (const match of line.text.matchAll(SCRIPT_CALL)) {
      const tool = match[1] ?? "";
      const cited = match[2] ?? "";

      if (cited.startsWith("-") || cited.includes("/") || cited.includes("|") || FILE_SCRIPT.test(cited)) {
        continue;
      }

      for (const script of expandBraces(cited)) {
        if (scripts.has(script) || isBin(script)) {
          continue;
        }

        const bulletId = bulletAt(file.bullets, line.line)?.id ?? null;
        findings.push(finding(file, "missing-command", `${tool} run ${script}`, bulletId));
      }
    }
  }

  return findings;
}

async function repoView(repoRoot: string): Promise<RepoView> {
  return {
    files: await listFiles(repoRoot),
    ignored: async (path) => (await run(["git", "check-ignore", "-q", "--", path], { cwd: repoRoot })).exitCode === 0,
  };
}

/** Deterministic and precision-first: a finding means the rule cites something the repo no longer has. */
export async function staleScan(files: readonly RuleFile[]): Promise<readonly StaleFinding[]> {
  const views = new Map<string, Promise<RepoView>>();
  const findings = new Map<string, StaleFinding>();

  const scans = await Promise.all(
    files.map(async (file): Promise<readonly StaleFinding[]> => {
      if (file.scope === "global" || file.repoRoot === null) {
        return [];
      }

      const repoRoot = file.repoRoot;
      const view = views.get(repoRoot) ?? repoView(repoRoot);
      views.set(repoRoot, view);

      return [
        ...deadGlobs(file, repoRoot, await view),
        ...(await missingPaths(file, repoRoot, await view)),
        ...(await missingCommands(file, repoRoot)),
      ];
    }),
  );

  for (const item of scans.flat()) {
    findings.set(item.id, item);
  }

  return [...findings.values()];
}
