import type { RuleFile, StaleFinding } from "../types.ts";
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

const notAPath = /[\s*?[\]{}<>$|`'"=]|:\/\/|\.\.\./;
const lineSuffix = /:\d+(?:-\d+)?$/;
const scriptCall = /(?:^|[\s`(;&|])(bun|npm|pnpm|yarn)\s+run\s+([^\s`'")]+)/g;
const fileScript = /\.(?:[cm]?[jt]s|sh)$/;

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
  if (file.paths === null) return [];
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
    .replace(lineSuffix, "")
    .replace(/^\.\//, "")
    .replace(/[.,;:]+$/, "");
  if (!token.includes("/") || token.endsWith("/") || notAPath.test(token)) return null;
  if (/^[~/@#-]/.test(token) || token.startsWith("../")) return null;
  return token;
}

async function missingPaths(file: RuleFile, repoRoot: string, view: RepoView): Promise<readonly StaleFinding[]> {
  const text = await Bun.file(file.sourcePath).text();
  const bases = [...new Set([repoRoot, ownerDir(file, repoRoot), dirname(file.sourcePath)])];
  const findings: StaleFinding[] = [];
  for (const span of codeSpans(text)) {
    const token = pathCandidate(span.code);
    if (token === null) continue;
    const first = token.split("/")[0] ?? "";
    const anchored = bases.filter((base) => existsSync(join(base, first)));
    if (anchored.length === 0) continue;
    const cited = anchored.map((base) => relative(repoRoot, join(base, token)));
    if (anchored.some((base) => existsSync(join(base, token)))) continue;
    if (view.files.some((path) => cited.some((prefix) => path.startsWith(prefix)))) continue;
    if (await view.ignored(cited[0] ?? token)) continue;
    findings.push(finding(file, "missing-path", token, bulletAt(file.bullets, span.line)?.id ?? null));
  }
  return findings;
}

function manifestsUpTo(from: string, repoRoot: string): readonly string[] {
  const manifests: string[] = [];
  for (let dir = from; isInside(repoRoot, dir); dir = dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) manifests.push(manifest);
    if (dir === repoRoot) break;
  }
  return manifests;
}

async function scriptNames(manifest: string): Promise<readonly string[]> {
  let parsed: unknown;
  try {
    parsed = await Bun.file(manifest).json();
  } catch (error) {
    throw new Error(`stale scan: cannot parse ${manifest}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const scripts = typeof parsed === "object" && parsed !== null && "scripts" in parsed ? parsed.scripts : null;
  return typeof scripts === "object" && scripts !== null ? Object.keys(scripts) : [];
}

async function missingCommands(file: RuleFile, repoRoot: string): Promise<readonly StaleFinding[]> {
  const manifests = manifestsUpTo(dirname(file.sourcePath), repoRoot);
  if (manifests.length === 0) return [];
  const scripts = new Set((await Promise.all(manifests.map(scriptNames))).flat());
  const isBin = (name: string): boolean =>
    manifests.some((manifest) => existsSync(join(dirname(manifest), "node_modules", ".bin", name)));
  const findings: StaleFinding[] = [];
  for (const line of bodyLines(await Bun.file(file.sourcePath).text())) {
    for (const match of line.text.matchAll(scriptCall)) {
      const tool = match[1] ?? "";
      const cited = match[2] ?? "";
      if (cited.startsWith("-") || cited.includes("/") || cited.includes("|") || fileScript.test(cited)) continue;
      for (const script of expandBraces(cited)) {
        if (scripts.has(script) || isBin(script)) continue;
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
  for (const file of files) {
    if (file.scope === "global" || file.repoRoot === null) continue;
    const repoRoot = file.repoRoot;
    const view = views.get(repoRoot) ?? repoView(repoRoot);
    views.set(repoRoot, view);
    const found = [
      ...deadGlobs(file, repoRoot, await view),
      ...(await missingPaths(file, repoRoot, await view)),
      ...(await missingCommands(file, repoRoot)),
    ];
    for (const item of found) findings.set(item.id, item);
  }
  return [...findings.values()];
}
