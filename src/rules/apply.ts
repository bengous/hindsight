import type { DeltaOp, Prevalence } from "../types.ts";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { relative } from "node:path";
import { git, hashObject, run } from "./git.ts";
import { isInside } from "./inventory.ts";

export type ApplyRequest = {
  readonly runId: string;
  readonly proposalId: string;
  readonly repoRoot: string | null;
  /** `git hash-object` of the target when the proposal was drafted; null only when the op creates the file. */
  readonly blobHash: string | null;
  readonly op: DeltaOp;
  /** Deployed file the agents load, when it differs from `op.sourcePath` (a chezmoi target). */
  readonly deployedPath: string | null;
  /** English imperative subject (`Proposal.commitSubject`). */
  readonly subject: string;
  /** English sentence opening the body (`Proposal.lesson`). */
  readonly lesson: string;
  readonly prevalence: Prevalence;
  /** Verbatim evidence quotes: the commit message must contain none of them. */
  readonly excerpts: readonly string[];
};

export type ApplyRefusal =
  | "no-checkout"
  | "outside-checkout"
  | "invalid-op"
  | "excerpt-in-message"
  | "file-exists"
  | "ignored-path"
  | "hash-mismatch"
  | "dirty-file"
  | "old-text-missing"
  | "old-text-ambiguous"
  | "commit-rejected";

export type ApplyResult =
  | { readonly kind: "committed"; readonly commit: string; readonly followUp: readonly string[] }
  | { readonly kind: "refused"; readonly reason: ApplyRefusal; readonly detail: string };

/** Deployed paths to re-apply after a commit to a chezmoi source; empty when chezmoi does not manage the file. */
export type TargetLookup = (sourcePath: string) => Promise<readonly string[]>;

type Refused = Extract<ApplyResult, { readonly kind: "refused" }>;

const MIN_EXCERPT_CHARS = 12;

function refuse(reason: ApplyRefusal, detail: string): Refused {
  return { kind: "refused", reason, detail };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function occurrences(text: string, needle: string): number {
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) count++;
  return count;
}

function preview(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

function commitMessage(request: ApplyRequest): string {
  const { sessions, days, repos } = request.prevalence;
  return [
    request.subject.replace(/\s+/g, " ").trim(),
    "",
    request.lesson.trim(),
    "",
    `Evidence: ${plural(sessions, "session")}, ${plural(days, "day")}, ${plural(repos, "repo")}`,
    `hindsight run ${request.runId}, proposal ${request.proposalId}`,
    "",
  ].join("\n");
}

function editedText(current: string, op: DeltaOp): { readonly kind: "edited"; readonly text: string } | Refused {
  let text = current;
  for (const edit of op.edits) {
    const count = occurrences(text, edit.oldText);
    if (count === 0) return refuse("old-text-missing", preview(edit.oldText));
    if (count > 1) return refuse("old-text-ambiguous", `${count} matches: ${preview(edit.oldText)}`);
    const at = text.indexOf(edit.oldText);
    text = text.slice(0, at) + edit.newText + text.slice(at + edit.oldText.length);
  }
  return { kind: "edited", text };
}

export function chezmoiTargets(timeoutMs = 10_000): TargetLookup {
  return async (sourcePath) => {
    if (Bun.which("chezmoi") === null) return [];
    const result = await run(["chezmoi", "target-path", sourcePath], { cwd: homedir(), timeoutMs });
    if (result.exitCode > 128) throw new Error(`chezmoi target-path ${sourcePath} timed out (exit ${result.exitCode})`);
    return result.exitCode === 0 ? [result.stdout.trim()] : [];
  };
}

/** One delta op becomes one commit of one file, or a typed refusal that leaves the checkout as it was. */
export async function applyDelta(
  request: ApplyRequest,
  targets: TargetLookup = chezmoiTargets(),
): Promise<ApplyResult> {
  const { op, repoRoot } = request;
  if (repoRoot === null) return refuse("no-checkout", op.sourcePath);
  if (!isInside(repoRoot, op.sourcePath) || relative(repoRoot, op.sourcePath) === "") {
    return refuse("outside-checkout", `${op.sourcePath} is not inside ${repoRoot}`);
  }
  const creates = op.edits.length === 1 && op.edits[0]?.oldText === "";
  if (op.edits.length === 0 || (!creates && op.edits.some((edit) => edit.oldText === ""))) {
    return refuse("invalid-op", "an op needs edits, and only a single edit with an empty oldText may create a file");
  }
  if (creates !== (request.blobHash === null)) {
    return refuse("invalid-op", creates ? "a file creation carries no blobHash" : "an edit needs the drafted blobHash");
  }
  const message = commitMessage(request);
  const leaked = request.excerpts.find(
    (excerpt) => squash(excerpt).length >= MIN_EXCERPT_CHARS && squash(message).includes(squash(excerpt)),
  );
  if (leaked !== undefined) return refuse("excerpt-in-message", preview(leaked));

  const path = relative(repoRoot, op.sourcePath);
  const exists = existsSync(op.sourcePath);
  let original: string | null = null;
  let next: string;
  if (creates) {
    if (exists) return refuse("file-exists", path);
    if ((await run(["git", "check-ignore", "-q", "--", path], { cwd: repoRoot })).exitCode === 0) {
      return refuse("ignored-path", path);
    }
    next = op.edits[0]?.newText ?? "";
  } else {
    if (!exists) return refuse("hash-mismatch", `${path} no longer exists`);
    const hash = await hashObject(op.sourcePath, repoRoot);
    if (hash !== request.blobHash) return refuse("hash-mismatch", `${path}: drafted ${request.blobHash}, now ${hash}`);
    const status = await git(repoRoot, ["status", "--porcelain", "--", path]);
    if (status.trim() !== "") return refuse("dirty-file", `${path} has uncommitted changes`);
    original = await Bun.file(op.sourcePath).text();
    const edited = editedText(original, op);
    if (edited.kind === "refused") return edited;
    next = edited.text;
  }

  await Bun.write(op.sourcePath, next);
  if (creates) await git(repoRoot, ["add", "--", path]);
  const commit = await run(["git", "commit", "--quiet", "--file=-", "--", path], { cwd: repoRoot, stdin: message });
  if (commit.exitCode !== 0) {
    if (original === null) {
      await git(repoRoot, ["rm", "--cached", "--quiet", "--", path]);
      rmSync(op.sourcePath);
    } else {
      await Bun.write(op.sourcePath, original);
    }
    const output = `${commit.stderr}\n${commit.stdout}`.trim().split("\n").slice(-20).join("\n");
    return refuse("commit-rejected", output);
  }

  const sha = (await git(repoRoot, ["rev-parse", "HEAD"])).trim();
  const deployed = [
    ...(await targets(op.sourcePath)),
    ...(request.deployedPath === null ? [] : [request.deployedPath]),
  ];
  const unique = [...new Set(deployed)];
  return { kind: "committed", commit: sha, followUp: unique.length === 0 ? [] : [`chezmoi apply ${unique.join(" ")}`] };
}
