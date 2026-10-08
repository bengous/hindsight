import type { ErrorCluster, ErrorEvent, EvidenceId } from "../types.ts";
import { basename } from "node:path";

export type ToolCall = {
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
};

export type ClusterThresholds = {
  readonly minSessions: number;
  readonly minDays: number;
};

const HARNESS_CLASSES: readonly (readonly [string, RegExp])[] = [
  ["worktree isolation", /is isolated in the worktree|working-directory isolation context/],
  ["edit before read", /file has not been read yet/],
  ["stale file", /file has been modified since read/],
  ["edit string not found", /string to replace not found/],
  [
    "approval required",
    /this command requires approval|permission to use \w+ with command|contains multiple operations|haven't granted it yet/,
  ],
  ["missing file", /file does not exist|no such file or directory|cannot access '/],
];

const NOISE_DETAILS = new Set(["missing file", "edit string not found", "stale file", "edit before read"]);

const SUBCOMMAND_TOOLS = new Set([
  "git",
  "bun",
  "bunx",
  "npm",
  "npx",
  "pnpm",
  "cargo",
  "chezmoi",
  "dots",
  "gh",
  "systemctl",
  "docker",
  "uv",
  "codex",
  "claude",
]);

const ERROR_WORD = /error|fatal|denied|not found|no such|failed|refus|blocked|cannot|invalid|traceback|fail/i;
const HEADER_LINE = /^(exit code \d+|post-edit lint failed:?|stop check failed:?)$/i;
const ESCAPE = String.fromCharCode(27);
const ANSI = new RegExp(`${ESCAPE}\\[[0-9;]*[A-Za-z]`, "g");
const DETAIL_LENGTH = 90;
const EXCERPT_LENGTH = 200;
const SAMPLE_SIZE = 5;
const EXIT_ONLY = "exit-only";

const stripAnsi = (text: string): string => text.replace(ANSI, "");

export function maskDetail(text: string): string {
  return text
    .replace(/(?:~|\.{1,2})?\/[\w.@~+/-]+/g, "<path>")
    .replace(/\b[0-9a-f]{7,}\b/gi, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, DETAIL_LENGTH);
}

function errorLines(text: string): readonly string[] {
  return stripAnsi(text)
    .replace(/<\/?tool_use_error>/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !HEADER_LINE.test(line));
}

export function firstErrorLine(text: string): string {
  const lines = errorLines(text);
  return lines.slice(0, 15).find((line) => ERROR_WORD.test(line)) ?? lines[0] ?? "";
}

export function errorExcerpt(text: string): string {
  return firstErrorLine(text).slice(0, EXCERPT_LENGTH);
}

export function bashKey(command: string): string {
  const segment = command
    .split(/&&|\|\||;|\n/)
    .map((part) => part.trim().replace(/^(\w+=\S* *)+/, ""))
    .find((part) => part !== "" && !/^cd\b/.test(part));
  const [first, ...rest] = (segment ?? "").split(/\s+/).filter((token) => token !== "");
  if (first === undefined) return "?";
  const name = basename(first);
  if (!SUBCOMMAND_TOOLS.has(name)) return name;
  const sub = rest.find((token) => !token.startsWith("-") && !token.includes("/"));
  return sub === undefined ? name : `${name} ${sub}`;
}

function hookBlockDetail(firstLine: string): string | null {
  const match = /^PreToolUse:\w+ hook error: (?:\[([^\]]*)\]: )?(.*)$/i.exec(firstLine);
  if (match === null) return null;
  const command = match[1] ?? "";
  const script = /[\w.-]+\.(?:ts|js|sh|py)\b/.exec(command)?.[0] ?? (command === "" ? "" : basename(command));
  const message = maskDetail(match[2] ?? "");
  return script === "" ? `hook-block: ${message}` : `hook-block ${script}: ${message}`;
}

function autoModeDetail(folded: string): string | null {
  if (folded.includes("auto mode classifier gave no verdict")) return "auto-mode denial [no verdict]";
  if (!folded.includes("denied by the claude code auto mode classifier")) return null;
  const reason = /reason: \[([^\]]+)\]/.exec(folded)?.[1];
  return reason === undefined ? "auto-mode denial" : `auto-mode denial [${reason}]`;
}

function errorDetail(text: string): string {
  const lines = errorLines(text);
  const hookBlock = lines[0] === undefined ? null : hookBlockDetail(lines[0]);
  if (hookBlock !== null) return hookBlock;
  const folded = stripAnsi(text).slice(0, 600).toLowerCase();
  const autoMode = autoModeDetail(folded);
  if (autoMode !== null) return autoMode;
  const harness = HARNESS_CLASSES.find(([, pattern]) => pattern.test(folded));
  if (harness !== undefined) return harness[0];
  const line = lines.slice(0, 15).find((candidate) => ERROR_WORD.test(candidate));
  return line === undefined ? EXIT_ONLY : maskDetail(line);
}

function toolHead(call: ToolCall | null): string {
  if (call === null) return "unknown";
  if (call.name !== "Bash") return call.name;
  const command = call.input["command"];
  return `Bash[${typeof command === "string" ? bashKey(command) : "?"}]`;
}

export function errorSignature(call: ToolCall | null, text: string): string {
  return `${toolHead(call)} ${errorDetail(text)}`;
}

export function hookErrorSignature(hookName: string, text: string): string {
  const line = firstErrorLine(text);
  return `hook:${hookName} ${line === "" ? EXIT_ONLY : maskDetail(line)}`;
}

export function isNoiseSignature(signature: string): boolean {
  const detail = /^[^\s[]+(?:\[[^\]]*\])? (.*)$/.exec(signature)?.[1];
  return detail !== undefined && (NOISE_DETAILS.has(detail) || detail === EXIT_ONLY);
}

function toCluster(signature: string, events: readonly ErrorEvent[]): ErrorCluster {
  const byRecency = [...events].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const latest = byRecency[0];
  if (latest === undefined) throw new Error(`error cluster "${signature}" has no event`);
  const sampleSessions = new Set<string>();
  const sample: EvidenceId[] = [];
  for (const event of byRecency) {
    if (sample.length === SAMPLE_SIZE) break;
    if (sampleSessions.has(event.sessionId)) continue;
    sampleSessions.add(event.sessionId);
    sample.push(event.evidenceId);
  }
  return {
    signature,
    tool: latest.tool,
    sessions: new Set(events.map((event) => event.sessionId)).size,
    days: new Set(events.map((event) => event.timestamp.slice(0, 10))).size,
    repoRoots: [...new Set(events.flatMap((event) => (event.repoRoot === null ? [] : [event.repoRoot])))].sort(),
    sample,
    excerpt: latest.excerpt,
  };
}

export function clusterErrors(events: readonly ErrorEvent[], thresholds: ClusterThresholds): readonly ErrorCluster[] {
  const groups = new Map<string, ErrorEvent[]>();
  for (const event of events) {
    if (isNoiseSignature(event.signature)) continue;
    const group = groups.get(event.signature);
    if (group === undefined) groups.set(event.signature, [event]);
    else group.push(event);
  }
  return [...groups]
    .map(([signature, group]) => toCluster(signature, group))
    .filter((cluster) => cluster.sessions >= thresholds.minSessions && cluster.days >= thresholds.minDays)
    .sort((a, b) => b.sessions - a.sessions || b.days - a.days || a.signature.localeCompare(b.signature));
}
