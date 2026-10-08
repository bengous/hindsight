import type { Decision, ModelUsage, Proposal, SteeringItem } from "../types.ts";
import { appendFile, chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type PendingProposal = {
  readonly runId: string;
  readonly proposal: Proposal;
};

export type ExtractionKey = {
  readonly sessionId: string;
  readonly lastUuid: string;
  readonly promptVersion: string;
};

export type CachedExtraction = {
  readonly key: ExtractionKey;
  readonly items: readonly SteeringItem[];
  readonly at: string;
};

export type CachedCuration<T> = {
  readonly groupKey: string;
  readonly inputHash: string;
  readonly output: T;
  readonly at: string;
};

export type RunStatus = "running" | "complete" | "partial" | "failed";

export type BatchFailure = {
  readonly stage: "extract" | "curate";
  readonly key: string;
  readonly kind: string;
  readonly message: string;
};

export type RunSummary = {
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly status: RunStatus;
  readonly usage: ModelUsage;
  readonly budgetUsd: number;
  readonly failures: readonly BatchFailure[];
  readonly counts: Readonly<Record<string, number>>;
};

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export function defaultStateRoot(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const base = env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state");
  return join(base, "hindsight");
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: DIR_MODE });
  await chmod(path, DIR_MODE);
}

export async function ensureStateRoot(root: string): Promise<void> {
  await ensureDir(root);
  await ensureDir(join(root, "runs"));
  await ensureDir(join(root, "cache", "extract"));
  await ensureDir(join(root, "cache", "curate"));
}

async function writePrivate(path: string, content: string): Promise<void> {
  await writeFile(path, content, { mode: FILE_MODE });
  await chmod(path, FILE_MODE);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writePrivate(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(path: string): Promise<unknown> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return null;
  }
  try {
    return await file.json();
  } catch (error) {
    throw new Error(`hindsight state: ${path} is not valid JSON`, { cause: error });
  }
}

function sha1(text: string): string {
  return new Bun.CryptoHasher("sha1").update(text).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function newRunId(now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `${stamp}-${crypto.randomUUID().slice(0, 6)}`;
}

export function runDir(root: string, runId: string): string {
  return join(root, "runs", runId);
}

export async function createRun(root: string, runId: string): Promise<string> {
  await ensureStateRoot(root);
  const dir = runDir(root, runId);
  await ensureDir(dir);
  return dir;
}

export async function writeRunJson(root: string, runId: string, name: string, value: unknown): Promise<void> {
  await writeJson(join(runDir(root, runId), name), value);
}

export async function writeRunLines(
  root: string,
  runId: string,
  name: string,
  values: readonly unknown[],
): Promise<void> {
  await writePrivate(join(runDir(root, runId), name), values.map((value) => `${JSON.stringify(value)}\n`).join(""));
}

export async function listRunIds(root: string): Promise<readonly string[]> {
  try {
    return (await readdir(join(root, "runs"))).toSorted();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function readRunSummary(root: string, runId: string): Promise<RunSummary | null> {
  return (await readJson(join(runDir(root, runId), "run.json"))) as RunSummary | null;
}

function isProposal(value: unknown): value is Proposal {
  return (
    isRecord(value) &&
    typeof value["id"] === "string" &&
    typeof value["fingerprint"] === "string" &&
    typeof value["kind"] === "string" &&
    isRecord(value["target"])
  );
}

export async function readRunProposals(root: string, runId: string): Promise<readonly Proposal[]> {
  const path = join(runDir(root, runId), "proposals.json");
  const value = await readJson(path);
  if (value === null) {
    return [];
  }
  if (!Array.isArray(value) || !value.every(isProposal)) {
    throw new Error(`hindsight state: ${path} does not hold a proposal array`);
  }
  return value;
}

function isDecision(value: unknown): value is Decision {
  return (
    isRecord(value) &&
    typeof value["proposalId"] === "string" &&
    typeof value["fingerprint"] === "string" &&
    typeof value["runId"] === "string" &&
    (value["decision"] === "accepted" ||
      (value["decision"] === "rejected" && typeof value["reason"] === "string" && value["reason"].trim() !== "")) &&
    typeof value["at"] === "string"
  );
}

function decisionsPath(root: string): string {
  return join(root, "decisions.jsonl");
}

export async function readDecisions(root: string = defaultStateRoot()): Promise<readonly Decision[]> {
  const file = Bun.file(decisionsPath(root));
  if (!(await file.exists())) {
    return [];
  }
  const lines = (await file.text()).split("\n");
  return lines.flatMap((line, index) => {
    if (line.trim() === "") {
      return [];
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`hindsight state: decisions.jsonl line ${index + 1} is not valid JSON`, { cause: error });
    }
    if (!isDecision(value)) {
      throw new Error(`hindsight state: decisions.jsonl line ${index + 1} is not a decision`);
    }
    return [value];
  });
}

export async function appendDecision(decision: Decision, root: string = defaultStateRoot()): Promise<void> {
  const received: unknown = decision;
  if (!isDecision(received)) {
    throw new Error(`hindsight state: refusing to record a malformed decision: ${JSON.stringify(received)}`);
  }
  await ensureStateRoot(root);
  const path = decisionsPath(root);
  await appendFile(path, `${JSON.stringify(decision)}\n`, { mode: FILE_MODE });
  await chmod(path, FILE_MODE);
}

/** Proposals of every run without a decision on their fingerprint; the latest run wins for a repeated fingerprint. */
export async function pendingProposals(root: string = defaultStateRoot()): Promise<readonly PendingProposal[]> {
  const decided = new Set((await readDecisions(root)).map((decision) => decision.fingerprint));
  const byFingerprint = new Map<string, PendingProposal>();
  for (const runId of await listRunIds(root)) {
    for (const proposal of await readRunProposals(root, runId)) {
      if (!decided.has(proposal.fingerprint)) {
        byFingerprint.set(proposal.fingerprint, { runId, proposal });
      }
    }
  }
  return [...byFingerprint.values()];
}

/** Every proposal ever written, with its decision when one exists; the curator reads it to avoid re-proposals. */
export async function proposalHistory(
  root: string,
): Promise<readonly { readonly proposal: Proposal; readonly decision: Decision | null }[]> {
  const decisions = new Map((await readDecisions(root)).map((decision) => [decision.fingerprint, decision]));
  const byFingerprint = new Map<string, Proposal>();
  for (const runId of await listRunIds(root)) {
    for (const proposal of await readRunProposals(root, runId)) {
      byFingerprint.set(proposal.fingerprint, proposal);
    }
  }
  return [...byFingerprint.values()].map((proposal) => ({
    proposal,
    decision: decisions.get(proposal.fingerprint) ?? null,
  }));
}

function extractionPath(root: string, sessionId: string): string {
  return join(root, "cache", "extract", `${sha1(sessionId)}.json`);
}

export async function readExtraction(root: string, key: ExtractionKey): Promise<readonly SteeringItem[] | null> {
  const value = await readJson(extractionPath(root, key.sessionId));
  if (!isRecord(value) || !isRecord(value["key"]) || !Array.isArray(value["items"])) {
    return null;
  }
  const cached = value["key"];
  const sameKey =
    cached["sessionId"] === key.sessionId &&
    cached["lastUuid"] === key.lastUuid &&
    cached["promptVersion"] === key.promptVersion;
  return sameKey ? (value["items"] as readonly SteeringItem[]) : null;
}

export async function writeExtraction(root: string, entry: CachedExtraction): Promise<void> {
  await ensureStateRoot(root);
  await writeJson(extractionPath(root, entry.key.sessionId), entry);
}

function curationPath(root: string, groupKey: string): string {
  return join(root, "cache", "curate", `${sha1(groupKey)}.json`);
}

/** Returns the stored model output only when the curator input is byte-identical to the cached one. */
export async function readCuration(root: string, groupKey: string, inputHash: string): Promise<unknown> {
  const value = await readJson(curationPath(root, groupKey));
  if (!isRecord(value) || value["groupKey"] !== groupKey || value["inputHash"] !== inputHash) {
    return null;
  }
  return value["output"] ?? null;
}

export async function writeCuration<T>(root: string, entry: CachedCuration<T>): Promise<void> {
  await ensureStateRoot(root);
  await writeJson(curationPath(root, entry.groupKey), entry);
}

/** Git HEAD of each repository at the end of the last run, used to diff rule files since then. */
export async function readHeads(root: string): Promise<Readonly<Record<string, string>>> {
  const value = await readJson(join(root, "heads.json"));
  if (value === null) {
    return {};
  }
  if (!isRecord(value) || !Object.values(value).every((head) => typeof head === "string")) {
    throw new Error(`hindsight state: ${join(root, "heads.json")} is not a repo-to-commit map`);
  }
  return value as Record<string, string>;
}

export async function writeHeads(root: string, heads: Readonly<Record<string, string>>): Promise<void> {
  await ensureStateRoot(root);
  await writeJson(join(root, "heads.json"), heads);
}
