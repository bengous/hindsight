import type { ModelRunner } from "../../src/model/claude.ts";
import type {
  ErrorEvent,
  EvidenceId,
  HumanMessage,
  LoadedRule,
  Marker,
  RuleFile,
  SessionDigest,
} from "../../src/types.ts";
import { homedir } from "node:os";
import { decode } from "../../src/model/codec.ts";

export const home = homedir();
export const repo = `${home}/Work/atelier`;
export const dotfiles = `${home}/chezmoi-src`;

export const globalAgents: RuleFile = {
  loadedPath: "~/.claude/AGENTS.md",
  sourcePath: `${dotfiles}/dot_agents/AGENTS.md`,
  repoRoot: dotfiles,
  scope: "global",
  blobHash: "1111111111111111111111111111111111111111",
  paths: null,
  bullets: [
    { id: "~/.claude/AGENTS.md#aa000001", line: 3, text: "- Answers use British spelling." },
    { id: "~/.claude/AGENTS.md#aa000002", line: 4, text: "- Commit, then update snapshots." },
  ],
};

export const globalAgentsText = [
  "# Global instructions",
  "",
  "- Answers use British spelling.",
  "- Commit, then update snapshots.",
  "",
].join("\n");

export const repoAgents: RuleFile = {
  loadedPath: `${repo}/AGENTS.md`,
  sourcePath: `${repo}/AGENTS.md`,
  repoRoot: repo,
  scope: "repo",
  blobHash: "2222222222222222222222222222222222222222",
  paths: null,
  bullets: [
    { id: "AGENTS.md#bb000001", line: 3, text: "- Run `bun test` before committing." },
    { id: "AGENTS.md#bb000002", line: 4, text: "- Tests live next to the code they cover." },
  ],
};

export const repoAgentsText = [
  "# Atelier",
  "",
  "- Run `bun test` before committing.",
  "- Tests live next to the code they cover.",
  "",
].join("\n");

export const docsRule: RuleFile = {
  loadedPath: `${repo}/.claude/rules/docs.md`,
  sourcePath: `${repo}/.claude/rules/docs.md`,
  repoRoot: repo,
  scope: "path",
  blobHash: "3333333333333333333333333333333333333333",
  paths: ["docs/**"],
  bullets: [{ id: ".claude/rules/docs.md#cc000001", line: 5, text: "- Never put ticket numbers in docs." }],
};

export const docsRuleText = ['---', "paths:", '  - "docs/**"', "---", "- Never put ticket numbers in docs.", ""].join("\n");

export const ruleSources = [
  { file: globalAgents, text: globalAgentsText },
  { file: repoAgents, text: repoAgentsText },
  { file: docsRule, text: docsRuleText },
] as const;

export type MessageSpec = {
  readonly uuid: string;
  readonly at: string;
  readonly text: string;
  readonly assistant?: string;
  readonly markers?: readonly Marker[];
  readonly loaded?: readonly string[];
};

export function session(
  sessionId: string,
  messages: readonly MessageSpec[],
  options: {
    readonly repoRoot?: string | null;
    readonly loadedRules?: readonly LoadedRule[];
    readonly filesTouched?: readonly string[];
  } = {},
): SessionDigest {
  const repoRoot = options.repoRoot === undefined ? repo : options.repoRoot;
  const cwd = repoRoot ?? "/tmp/elsewhere";
  const human: HumanMessage[] = messages.map((spec) => ({
    evidenceId: `${sessionId}:${spec.uuid}` as EvidenceId,
    sessionId,
    uuid: spec.uuid,
    timestamp: spec.at,
    cwd,
    text: spec.text,
    precedingAssistant: spec.assistant ?? "",
    loadedRulePaths: spec.loaded ?? [`${home}/.claude/AGENTS.md`, `${repo}/AGENTS.md`],
    markers: spec.markers ?? [],
  }));
  return {
    sessionId,
    chain: [sessionId],
    title: `Session ${sessionId}`,
    cwd,
    repoRoot,
    firstAt: messages[0]?.at ?? "2026-10-01T09:00:00Z",
    lastAt: messages.at(-1)?.at ?? "2026-10-01T09:00:00Z",
    messages: human,
    loadedRules: options.loadedRules ?? [
      { path: `${home}/.claude/AGENTS.md`, source: "instructions", content: globalAgentsText },
      { path: `${repo}/AGENTS.md`, source: "instructions", content: repoAgentsText },
    ],
    filesTouched: options.filesTouched ?? [],
  };
}

export function errorEvent(sessionId: string, uuid: string, at: string, signature: string): ErrorEvent {
  return {
    evidenceId: `${sessionId}:${uuid}` as EvidenceId,
    sessionId,
    repoRoot: repo,
    timestamp: at,
    tool: "Bash",
    signature,
    excerpt: "PreToolUse:Bash hook error: [rm -rf <path>]: blocked by no-rm",
  };
}

export type ScriptedCall = { readonly label: string; readonly prompt: string; readonly model: string };

/** Answers each call with the value the script returns for it, decoded through the request's codec like the real runner. */
export function scriptedRunner(
  script: (call: ScriptedCall) => unknown,
  calls: ScriptedCall[] = [],
  costUsd = 0.01,
): ModelRunner {
  return async (request) => {
    const call = { label: request.label, prompt: request.prompt, model: request.model };
    calls.push(call);
    return {
      output: decode(request.output, script(call)),
      usage: { costUsd, inputTokens: 100, outputTokens: 10, durationMs: 1 },
    };
  };
}

export function promptData(prompt: string): unknown {
  return JSON.parse(prompt.slice(prompt.indexOf("\nDATA\n") + "\nDATA\n".length));
}
