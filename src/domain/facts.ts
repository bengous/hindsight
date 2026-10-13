import type { Marker } from "./human.ts";

import { markersFor } from "./human.ts";

/** One tool call of a turn, reduced to what the Gate reads. */
export type ToolUse = {
  readonly tool: string;
  readonly path: string | null;
  readonly command: string | null;
  readonly isError: boolean;
  readonly isRefused: boolean;
};

export type HumanText = {
  readonly text: string;
  readonly markers: readonly Marker[];
};

/** What happened in a session since its last Debrief, accumulated turn by turn. */
export type TurnFacts = {
  readonly humanTexts: readonly HumanText[];
  readonly edits: readonly string[];
  readonly toolCalls: number;
  readonly toolErrors: number;
  readonly refusedTools: readonly string[];
  readonly gitCommits: number;
  readonly afterInterrupt: boolean;
  readonly prompts: number;
};

export const HUMAN_TEXT_MAX = 4000;

const HUMAN_TEXTS_KEPT = 20;

const RULE_FILE = /(^|\/)(AGENTS|CLAUDE)\.md$|\/\.claude\/rules\/[^/]+\.md$|\/output-styles\/[^/]+\.md$/;

const GIT_COMMIT = /(^|[;&|]\s*)git\s+(-[^\s]+\s+)*commit\b/;

const REFUSAL_TEXT = /user doesn't want to proceed|user rejected|rejected this tool|permission denied by the user/i;

export const emptyFacts: TurnFacts = {
  humanTexts: [],
  edits: [],
  toolCalls: 0,
  toolErrors: 0,
  refusedTools: [],
  gitCommits: 0,
  afterInterrupt: false,
  prompts: 0,
};

export function isRuleFile(path: string): boolean {
  return RULE_FILE.test(path);
}

export function isGitCommit(command: string): boolean {
  return GIT_COMMIT.test(command);
}

/** True for the error text a tool result carries when the human refused the call. */
export function isRefusalText(text: string): boolean {
  return REFUSAL_TEXT.test(text);
}

/** `text` is already cleaned (`cleanHumanText`); an empty one adds nothing. */
export function addHumanText(facts: TurnFacts, text: string): TurnFacts {
  if (text === "") {
    return facts;
  }

  const markers = markersFor(text, {
    isFirstPrompt: facts.prompts === 0,
    afterInterrupt: facts.afterInterrupt,
    rejectedTools: facts.refusedTools,
  });

  return {
    ...facts,
    humanTexts: [...facts.humanTexts, { text: text.slice(0, HUMAN_TEXT_MAX), markers }].slice(-HUMAN_TEXTS_KEPT),
    afterInterrupt: false,
    prompts: facts.prompts + 1,
  };
}

export function addToolUses(facts: TurnFacts, uses: readonly ToolUse[]): TurnFacts {
  const edits = uses.flatMap((use) =>
    (use.tool === "Edit" || use.tool === "Write" || use.tool === "NotebookEdit") && use.path !== null ? [use.path] : [],
  );

  const commits = uses.filter((use) => use.tool === "Bash" && use.command !== null && isGitCommit(use.command)).length;
  const refused = uses.filter((use) => use.isRefused).map((use) => use.tool);

  return {
    ...facts,
    edits: [...facts.edits, ...edits],
    toolCalls: facts.toolCalls + uses.length,
    toolErrors: facts.toolErrors + uses.filter((use) => use.isError && !use.isRefused).length,
    refusedTools: [...facts.refusedTools, ...refused],
    gitCommits: facts.gitCommits + commits,
  };
}

export function markInterrupted(facts: TurnFacts): TurnFacts {
  return { ...facts, afterInterrupt: true };
}
