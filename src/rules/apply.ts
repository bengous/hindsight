import type { Prevalence } from "../store/queries.ts";
import { existsSync, rmSync } from "node:fs";
import { relative } from "node:path";
import { git, hashObject, run } from "./git.ts";
import { isInside } from "./inventory.ts";

export type TextEdit = { readonly oldText: string; readonly newText: string };

export type ApplyRequest = {
  readonly proposalId: string;
  readonly targetPath: string;
  /** The checkout that holds the file; null for a global Rule File written where the agents load it. */
  readonly repoRoot: string | null;
  readonly edits: readonly TextEdit[];
  readonly subject: string;
  readonly lesson: string;
  readonly prevalence: Prevalence;
  /** Verbatim evidence texts: the commit message must contain none of them. */
  readonly excerpts: readonly string[];
};

export type ApplyRefusal =
  | "outside-checkout"
  | "invalid-edit"
  | "excerpt-in-message"
  | "file-exists"
  | "file-missing"
  | "ignored-path"
  | "dirty-file"
  | "old-text-missing"
  | "old-text-ambiguous"
  | "commit-rejected";

export type ApplyResult =
  | { readonly kind: "committed"; readonly commit: string; readonly blobHash: string }
  | { readonly kind: "written"; readonly path: string }
  | { readonly kind: "refused"; readonly reason: ApplyRefusal; readonly detail: string };

type Refused = Extract<ApplyResult, { readonly kind: "refused" }>;

const MIN_EXCERPT_CHARS = 12;

const refuse = (reason: ApplyRefusal, detail: string): Refused => ({ kind: "refused", reason, detail });
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;
const squash = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();

function occurrences(text: string, needle: string): number {
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) count += 1;
  return count;
}

function preview(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

/** Subject, lesson, evidence counts and the proposal id: never a Quote (principle 7). */
export function commitMessage(request: ApplyRequest): string {
  const { sessions, days, repos } = request.prevalence;
  const evidence =
    sessions === 0
      ? "deterministic rule scan"
      : [plural(sessions, "session"), plural(days, "day"), plural(repos, "repo")].join(", ");
  return [
    request.subject.replace(/\s+/g, " ").trim(),
    "",
    request.lesson.trim(),
    "",
    `Evidence: ${evidence}`,
    `hindsight proposal ${request.proposalId}`,
    "",
  ].join("\n");
}

export function editedText(
  current: string,
  edits: readonly TextEdit[],
): { readonly kind: "edited"; readonly text: string } | Refused {
  let text = current;
  for (const edit of edits) {
    const count = occurrences(text, edit.oldText);
    if (count === 0) return refuse("old-text-missing", preview(edit.oldText));
    if (count > 1) return refuse("old-text-ambiguous", `${count} matches: ${preview(edit.oldText)}`);
    const at = text.indexOf(edit.oldText);
    text = text.slice(0, at) + edit.newText + text.slice(at + edit.oldText.length);
  }
  return { kind: "edited", text };
}

function isCreation(edits: readonly TextEdit[]): boolean | Refused {
  const creates = edits.length === 1 && edits[0]?.oldText === "";
  if (edits.length === 0 || (!creates && edits.some((edit) => edit.oldText === ""))) {
    return refuse(
      "invalid-edit",
      "a change needs edits, and only a single edit with an empty oldText may create a file",
    );
  }
  return creates;
}

/** A global Rule File outside any checkout: one write of that file, no commit. */
async function writeGlobal(request: ApplyRequest, creates: boolean): Promise<ApplyResult> {
  const exists = existsSync(request.targetPath);
  if (creates) {
    if (exists) return refuse("file-exists", request.targetPath);
    await Bun.write(request.targetPath, request.edits[0]?.newText ?? "");
    return { kind: "written", path: request.targetPath };
  }
  if (!exists) return refuse("file-missing", request.targetPath);
  const edited = editedText(await Bun.file(request.targetPath).text(), request.edits);
  if (edited.kind === "refused") return edited;
  await Bun.write(request.targetPath, edited.text);
  return { kind: "written", path: request.targetPath };
}

/** One accepted Proposal becomes one commit of one file, or a typed refusal that leaves the checkout as it was. */
export async function applyChange(request: ApplyRequest): Promise<ApplyResult> {
  const creates = isCreation(request.edits);
  if (typeof creates !== "boolean") return creates;
  const { repoRoot, targetPath } = request;
  if (repoRoot === null) return writeGlobal(request, creates);
  if (!isInside(repoRoot, targetPath) || relative(repoRoot, targetPath) === "") {
    return refuse("outside-checkout", `${targetPath} is not inside ${repoRoot}`);
  }
  const message = commitMessage(request);
  const leaked = request.excerpts.find(
    (excerpt) => squash(excerpt).length >= MIN_EXCERPT_CHARS && squash(message).includes(squash(excerpt)),
  );
  if (leaked !== undefined) return refuse("excerpt-in-message", preview(leaked));

  const path = relative(repoRoot, targetPath);
  const exists = existsSync(targetPath);
  let original: string | null = null;
  let next: string;
  if (creates) {
    if (exists) return refuse("file-exists", path);
    if ((await run(["git", "check-ignore", "-q", "--", path], { cwd: repoRoot })).exitCode === 0) {
      return refuse("ignored-path", path);
    }
    next = request.edits[0]?.newText ?? "";
  } else {
    if (!exists) return refuse("file-missing", path);
    const status = await git(repoRoot, ["status", "--porcelain", "--", path]);
    if (status.trim() !== "") return refuse("dirty-file", `${path} has uncommitted changes`);
    original = await Bun.file(targetPath).text();
    const edited = editedText(original, request.edits);
    if (edited.kind === "refused") return edited;
    next = edited.text;
  }

  await Bun.write(targetPath, next);
  if (creates) await git(repoRoot, ["add", "--", path]);
  const commit = await run(["git", "commit", "--quiet", "--file=-", "--", path], { cwd: repoRoot, stdin: message });
  if (commit.exitCode !== 0) {
    if (original === null) {
      await git(repoRoot, ["rm", "--cached", "--quiet", "--", path]);
      rmSync(targetPath);
    } else {
      await Bun.write(targetPath, original);
    }
    const output = `${commit.stderr}\n${commit.stdout}`.trim().split("\n").slice(-20).join("\n");
    return refuse("commit-rejected", output);
  }
  return {
    kind: "committed",
    commit: (await git(repoRoot, ["rev-parse", "HEAD"])).trim(),
    blobHash: await hashObject(targetPath, repoRoot),
  };
}
