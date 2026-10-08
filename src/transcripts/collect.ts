import type { ErrorEvent, HumanMessage, LoadedRule, LoadedRuleSource, Marker, SessionDigest } from "../types.ts";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { errorExcerpt, errorSignature, hookErrorSignature, type ToolCall } from "../signals/errors.ts";
import { markersFor } from "../signals/markers.ts";
import { classifyUserEntry, rejectionFeedback } from "./human.ts";
import { contentText, isRecord, recordField, recordsField, stringField, type JsonRecord } from "./json.ts";
import { forEachEntry } from "./read.ts";
import { cachedRepoRootResolver } from "./repo.ts";

export type CollectOptions = {
  readonly projectsDir: string;
  readonly since: Date;
  readonly includeArchive: boolean;
  readonly repoRootOf?: (cwd: string) => string | null;
};

export type CollectStats = {
  readonly files: { readonly main: number; readonly subagent: number; readonly archive: number };
  readonly droppedSessions: { readonly sdk: number; readonly scratch: number };
  readonly sessions: number;
  readonly humanMessages: number;
  readonly duplicateEntries: number;
  readonly errorEvents: number;
  readonly partialLines: number;
};

export type CollectResult = {
  readonly digests: readonly SessionDigest[];
  readonly errors: readonly ErrorEvent[];
  readonly stats: CollectStats;
};

type FileKind = "main" | "subagent" | "archive";

type MessageDraft = {
  readonly uuid: string;
  readonly sessionId: string;
  readonly timestamp: string;
  readonly cwd: string;
  readonly text: string;
  readonly precedingAssistant: string;
  readonly loadedRulePaths: Set<string>;
  readonly markers: readonly Marker[];
};

type ErrorDraft = {
  readonly uuid: string;
  readonly fileSessionId: string;
  readonly timestamp: string;
  readonly cwd: string | null;
  readonly tool: string;
  readonly signature: string;
  readonly excerpt: string;
};

type FileScan = {
  readonly path: string;
  readonly kind: FileKind;
  readonly sessionId: string | null;
  readonly startCwd: string | null;
  readonly customTitle: string | null;
  readonly aiTitle: string | null;
  readonly continuedIn: string | null;
  readonly firstAt: string | null;
  readonly lastAt: string | null;
  readonly sdk: boolean;
  readonly partialLine: boolean;
  readonly messages: readonly MessageDraft[];
  readonly errors: readonly ErrorDraft[];
  readonly loadedRules: readonly LoadedRule[];
  readonly filesTouched: readonly string[];
};

const SCRATCH_PREFIX = "/tmp/claude-";
const PRECEDING_ASSISTANT_LENGTH = 1500;
const PATH_INPUTS: Readonly<Record<string, string>> = {
  Read: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  Write: "file_path",
  NotebookEdit: "notebook_path",
};
const IGNORED_DENIALS = new Set(["cancelled", "interrupted"]);
const PATTERNS: Readonly<Record<FileKind, readonly string[]>> = {
  main: ["*/*.jsonl"],
  subagent: ["*/*/subagents/*.jsonl"],
  archive: ["*/archive/*.jsonl.zst", "*/archive/*.jsonl.gz"],
};

const ruleKey = (rule: LoadedRule): string => `${rule.source}\0${rule.path}\0${rule.content ?? ""}`;

/** Absolute path of the output style file, or `output-style:<name>` for a style with no file (a built-in one). */
export function resolveOutputStylePath(name: string, styleDirs: readonly string[]): string {
  const file = styleDirs.map((dir) => join(dir, `${name}.md`)).find((candidate) => existsSync(candidate));
  return file ?? `output-style:${name}`;
}

function absolutePath(path: string, cwd: string | null): string {
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  if (isAbsolute(path) || cwd === null) return path;
  return resolve(cwd, path);
}

function required(entry: JsonRecord, key: string, path: string): string {
  const value = stringField(entry, key);
  if (value === null) throw new Error(`${path}: ${stringField(entry, "type")} entry without "${key}"`);
  return value;
}

async function scanFile(path: string, kind: FileKind, sinceIso: string): Promise<FileScan> {
  let sessionId: string | null = null;
  let startCwd: string | null = null;
  let customTitle: string | null = null;
  let aiTitle: string | null = null;
  let continuedIn: string | null = null;
  let firstAt: string | null = null;
  let lastAt: string | null = null;
  let sdk = false;
  let assistantTail = "";
  let afterInterrupt = false;
  let rejectedTools: string[] = [];
  let prompts = 0;
  let pending: MessageDraft[] = [];
  const calls = new Map<string, ToolCall>();
  const context = new Map<string, LoadedRule>();
  const loadedRules = new Map<string, LoadedRule>();
  const filesTouched = new Set<string>();
  const messages: MessageDraft[] = [];
  const errors: ErrorDraft[] = [];

  const load = (rule: LoadedRule): void => {
    context.set(rule.path, rule);
    loadedRules.set(ruleKey(rule), rule);
    for (const draft of pending) draft.loadedRulePaths.add(rule.path);
  };

  const unload = (source: LoadedRuleSource): void => {
    for (const [key, rule] of context) if (rule.source === source) context.delete(key);
  };

  const addMessage = (entry: JsonRecord, text: string, markerText: string, isRejectionFeedback: boolean): void => {
    const markers = markersFor(markerText, {
      isFirstPrompt: prompts === 0,
      afterInterrupt,
      rejectedTools,
      isRejectionFeedback,
    });
    const precedingAssistant = assistantTail;
    prompts += 1;
    afterInterrupt = false;
    rejectedTools = [];
    assistantTail = "";
    const timestamp = required(entry, "timestamp", path);
    if (kind === "subagent" || timestamp < sinceIso) return;
    const draft: MessageDraft = {
      uuid: required(entry, "uuid", path),
      sessionId: required(entry, "sessionId", path),
      timestamp,
      cwd: required(entry, "cwd", path),
      text,
      precedingAssistant,
      loadedRulePaths: new Set(context.keys()),
      markers,
    };
    messages.push(draft);
    pending.push(draft);
  };

  const addError = (entry: JsonRecord, tool: string, signature: string, text: string): void => {
    const timestamp = required(entry, "timestamp", path);
    if (timestamp < sinceIso) return;
    errors.push({
      uuid: required(entry, "uuid", path),
      fileSessionId: required(entry, "sessionId", path),
      timestamp,
      cwd: stringField(entry, "cwd") ?? startCwd,
      tool,
      signature,
      excerpt: errorExcerpt(text),
    });
  };

  const onAssistant = (entry: JsonRecord): void => {
    pending = [];
    const message = recordField(entry, "message");
    for (const block of message === null ? [] : recordsField(message, "content")) {
      const type = stringField(block, "type");
      if (type === "text" && entry["isSidechain"] !== true) {
        const text = stringField(block, "text") ?? "";
        assistantTail = (assistantTail === "" ? text : `${assistantTail}\n\n${text}`).slice(
          -PRECEDING_ASSISTANT_LENGTH,
        );
      } else if (type === "tool_use") {
        const id = stringField(block, "id");
        const name = stringField(block, "name");
        const input = recordField(block, "input") ?? {};
        if (id === null || name === null) continue;
        calls.set(id, { name, input });
        const pathKey = PATH_INPUTS[name];
        const touched = pathKey === undefined ? null : stringField(input, pathKey);
        if (touched !== null && kind !== "subagent") {
          filesTouched.add(absolutePath(touched, stringField(entry, "cwd") ?? startCwd));
        }
      }
    }
  };

  const onToolResult = (entry: JsonRecord, block: JsonRecord): void => {
    if (block["is_error"] !== true) return;
    const toolUseId = stringField(block, "tool_use_id");
    const call = toolUseId === null ? null : (calls.get(toolUseId) ?? null);
    const text = contentText(block["content"]);
    const denial = stringField(entry, "toolDenialKind");
    if (denial === "user-rejected") {
      rejectedTools.push(call?.name ?? "unknown");
      const feedback = rejectionFeedback(text);
      if (feedback !== null) addMessage(entry, feedback, feedback, true);
      return;
    }
    if (denial !== null && IGNORED_DENIALS.has(denial)) return;
    addError(entry, call?.name ?? "unknown", errorSignature(call, text), text);
  };

  const onUser = (entry: JsonRecord): void => {
    const message = recordField(entry, "message");
    const results = (message === null ? [] : recordsField(message, "content")).filter(
      (block) => stringField(block, "type") === "tool_result",
    );
    if (results.length > 1) {
      throw new Error(
        `${path}: entry ${stringField(entry, "uuid")} holds ${results.length} tool results; evidence ids assume one`,
      );
    }
    const [result] = results;
    if (result !== undefined) {
      onToolResult(entry, result);
      return;
    }
    const classified = classifyUserEntry(entry);
    if (classified.kind === "interrupt") afterInterrupt = true;
    else if (classified.kind === "typed") addMessage(entry, classified.text, classified.markerText, false);
  };

  const onAttachment = (entry: JsonRecord): void => {
    const attachment = recordField(entry, "attachment");
    if (attachment === null) return;
    switch (stringField(attachment, "type")) {
      case "instructions":
        unload("instructions");
        for (const file of recordsField(attachment, "files")) {
          const filePath = stringField(file, "path");
          if (filePath !== null)
            load({ path: filePath, source: "instructions", content: stringField(file, "content") });
        }
        return;
      case "nested_memory": {
        const filePath = stringField(attachment, "path");
        const content = attachment["content"];
        const text = typeof content === "string" ? content : isRecord(content) ? stringField(content, "content") : null;
        if (filePath !== null) load({ path: filePath, source: "nested_memory", content: text });
        return;
      }
      case "output_style_instructions": {
        const style = recordField(attachment, "style");
        const name = style === null ? null : stringField(style, "name");
        if (style === null || name === null) return;
        unload("output_style");
        const cwd = stringField(entry, "cwd") ?? startCwd;
        const styleDirs = [
          ...(cwd === null ? [] : [join(cwd, ".claude", "output-styles")]),
          join(homedir(), ".claude", "output-styles"),
        ];
        load({
          path: resolveOutputStylePath(name, styleDirs),
          source: "output_style",
          content: stringField(style, "prompt"),
        });
        return;
      }
      case "hook_blocking_error":
      case "hook_non_blocking_error": {
        const hookName = stringField(attachment, "hookName") ?? "unknown";
        const blocking = recordField(attachment, "blockingError");
        const text =
          (blocking === null ? null : stringField(blocking, "blockingError")) ?? stringField(attachment, "stderr");
        addError(entry, `hook:${hookName}`, hookErrorSignature(hookName, text ?? ""), text ?? "");
        return;
      }
      default:
        return;
    }
  };

  const { partialLine } = await forEachEntry(path, (entry) => {
    const type = stringField(entry, "type");
    const timestamp = stringField(entry, "timestamp");
    if (timestamp !== null) {
      if (firstAt === null || timestamp < firstAt) firstAt = timestamp;
      if (lastAt === null || timestamp > lastAt) lastAt = timestamp;
    }
    if (stringField(entry, "entrypoint") === "sdk-cli") sdk = true;
    sessionId ??= stringField(entry, "sessionId");
    if (startCwd === null && (type === "user" || type === "assistant")) startCwd = stringField(entry, "cwd");
    switch (type) {
      case "assistant":
        onAssistant(entry);
        return;
      case "user":
        onUser(entry);
        return;
      case "attachment":
        onAttachment(entry);
        return;
      case "ai-title":
        aiTitle = stringField(entry, "aiTitle") ?? aiTitle;
        return;
      case "custom-title":
        customTitle = stringField(entry, "customTitle") ?? customTitle;
        return;
      case "continued-in":
        continuedIn = stringField(entry, "continuedInSessionId") ?? continuedIn;
        return;
      default:
        return;
    }
  });

  return {
    path,
    kind,
    sessionId,
    startCwd,
    customTitle,
    aiTitle,
    continuedIn,
    firstAt,
    lastAt,
    sdk,
    partialLine,
    messages,
    errors,
    loadedRules: [...loadedRules.values()],
    filesTouched: [...filesTouched],
  };
}

async function listFiles(projectsDir: string, kind: FileKind, sinceMs: number): Promise<readonly string[]> {
  const found: string[] = [];
  for (const pattern of PATTERNS[kind]) {
    for await (const relative of new Bun.Glob(pattern).scan({ cwd: projectsDir, onlyFiles: true })) {
      const path = join(projectsDir, relative);
      if (Bun.file(path).lastModified >= sinceMs) found.push(path);
    }
  }
  return found.sort();
}

const byFirstAt = (a: FileScan, b: FileScan): number =>
  (a.firstAt ?? "").localeCompare(b.firstAt ?? "") || a.path.localeCompare(b.path);

function sessionChains(groups: ReadonlyMap<string, readonly FileScan[]>): readonly (readonly string[])[] {
  const next = new Map<string, string>();
  for (const [sessionId, scans] of groups) {
    const target = scans.find((scan) => scan.continuedIn !== null)?.continuedIn;
    if (target !== undefined && target !== null && groups.has(target)) next.set(sessionId, target);
  }
  const targets = new Set(next.values());
  const visited = new Set<string>();
  const chains: string[][] = [];
  const firstAtOf = (sessionId: string): string => groups.get(sessionId)?.[0]?.firstAt ?? "";
  const heads = [...groups.keys()].filter((id) => !targets.has(id));
  const unreached = [...groups.keys()];
  for (const start of [...heads, ...unreached]) {
    if (visited.has(start)) continue;
    const chain: string[] = [];
    for (
      let current: string | undefined = start;
      current !== undefined && !visited.has(current);
      current = next.get(current)
    ) {
      visited.add(current);
      chain.push(current);
    }
    chains.push(chain);
  }
  return chains.sort((a, b) => firstAtOf(a[0] ?? "").localeCompare(firstAtOf(b[0] ?? "")));
}

function isDropped(scan: FileScan): "sdk" | "scratch" | null {
  if (scan.sdk) return "sdk";
  if (scan.startCwd?.startsWith(SCRATCH_PREFIX) === true) return "scratch";
  return null;
}

export async function collect(options: CollectOptions): Promise<CollectResult> {
  if (!existsSync(options.projectsDir)) throw new Error(`projects dir not found: ${options.projectsDir}`);
  const repoRootOf = options.repoRootOf ?? cachedRepoRootResolver();
  const sinceIso = options.since.toISOString();
  const sinceMs = options.since.getTime();
  const kinds: readonly FileKind[] = options.includeArchive ? ["main", "archive", "subagent"] : ["main", "subagent"];
  const scans: FileScan[] = [];
  const fileCounts = { main: 0, subagent: 0, archive: 0 };
  for (const kind of kinds) {
    for (const path of await listFiles(options.projectsDir, kind, sinceMs)) {
      scans.push(await scanFile(path, kind, sinceIso));
      fileCounts[kind] += 1;
    }
  }

  const dropped = { sdk: new Set<string>(), scratch: new Set<string>() };
  const groups = new Map<string, FileScan[]>();
  const subagentScans: FileScan[] = [];
  for (const scan of scans) {
    const reason = isDropped(scan);
    if (reason !== null) {
      if (scan.kind !== "subagent" && scan.sessionId !== null) dropped[reason].add(scan.sessionId);
      continue;
    }
    if (scan.sessionId === null) continue;
    if (scan.kind === "subagent") {
      subagentScans.push(scan);
      continue;
    }
    const group = groups.get(scan.sessionId);
    if (group === undefined) groups.set(scan.sessionId, [scan]);
    else group.push(scan);
  }
  for (const group of groups.values()) group.sort(byFirstAt);
  const droppedIds = new Set([...dropped.sdk, ...dropped.scratch]);
  const chains = sessionChains(groups);
  const headOf = new Map(
    chains.flatMap((chain) => chain.map((sessionId) => [sessionId, chain[0] ?? sessionId] as const)),
  );

  const seen = new Set<string>();
  let duplicateEntries = 0;
  const fresh = <T extends { readonly uuid: string }>(items: readonly T[]): T[] =>
    items.filter((item) => {
      if (seen.has(item.uuid)) {
        duplicateEntries += 1;
        return false;
      }
      seen.add(item.uuid);
      return true;
    });

  const toEvent = (draft: ErrorDraft): ErrorEvent => ({
    evidenceId: `${draft.fileSessionId}:${draft.uuid}`,
    sessionId: headOf.get(draft.fileSessionId) ?? draft.fileSessionId,
    repoRoot: draft.cwd === null ? null : repoRootOf(draft.cwd),
    timestamp: draft.timestamp,
    tool: draft.tool,
    signature: draft.signature,
    excerpt: draft.excerpt,
  });

  const digests: SessionDigest[] = [];
  const errors: ErrorEvent[] = [];
  for (const chain of chains) {
    const chainScans = chain.flatMap((sessionId) => groups.get(sessionId) ?? []);
    const messages = chainScans.flatMap((scan) => fresh(scan.messages));
    errors.push(...chainScans.flatMap((scan) => fresh(scan.errors).map(toEvent)));
    if (messages.length === 0) continue;
    digests.push(toDigest(chain, chainScans, messages, repoRootOf));
  }
  for (const scan of subagentScans.sort(byFirstAt)) {
    if (scan.sessionId !== null && droppedIds.has(scan.sessionId)) continue;
    errors.push(...fresh(scan.errors).map(toEvent));
  }

  return {
    digests,
    errors: errors.sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    stats: {
      files: fileCounts,
      droppedSessions: { sdk: dropped.sdk.size, scratch: dropped.scratch.size },
      sessions: digests.length,
      humanMessages: digests.reduce((sum, digest) => sum + digest.messages.length, 0),
      duplicateEntries,
      errorEvents: errors.length,
      partialLines: scans.filter((scan) => scan.partialLine).length,
    },
  };
}

function toDigest(
  chain: readonly string[],
  scans: readonly FileScan[],
  drafts: readonly MessageDraft[],
  repoRootOf: (cwd: string) => string | null,
): SessionDigest {
  const sessionId = chain[0];
  const cwd = scans.find((scan) => scan.startCwd !== null)?.startCwd;
  if (sessionId === undefined || cwd === undefined || cwd === null) {
    throw new Error(`session chain [${chain.join(", ")}] has human messages but no cwd`);
  }
  const customTitle = scans.findLast((scan) => scan.customTitle !== null)?.customTitle ?? null;
  const aiTitle = scans.findLast((scan) => scan.aiTitle !== null)?.aiTitle ?? null;
  const loadedRules = new Map<string, LoadedRule>();
  for (const rule of scans.flatMap((scan) => scan.loadedRules)) loadedRules.set(ruleKey(rule), rule);
  const instants = scans
    .flatMap((scan) => [scan.firstAt, scan.lastAt])
    .filter((at): at is string => at !== null)
    .sort();
  const firstAt = instants[0];
  const lastAt = instants.at(-1);
  if (firstAt === undefined || lastAt === undefined) throw new Error(`session ${sessionId} has no timestamp`);
  const messages: HumanMessage[] = drafts.map((draft) => ({
    evidenceId: `${draft.sessionId}:${draft.uuid}`,
    sessionId,
    uuid: draft.uuid,
    timestamp: draft.timestamp,
    cwd: draft.cwd,
    text: draft.text,
    precedingAssistant: draft.precedingAssistant,
    loadedRulePaths: [...draft.loadedRulePaths],
    markers: draft.markers,
  }));
  return {
    sessionId,
    chain,
    title: customTitle ?? aiTitle,
    cwd,
    repoRoot: repoRootOf(cwd),
    firstAt,
    lastAt,
    messages,
    loadedRules: [...loadedRules.values()],
    filesTouched: [...new Set(scans.flatMap((scan) => scan.filesTouched))],
  };
}
