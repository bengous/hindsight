import type { HindsightConfig } from "../domain/config.ts";
import type { ToolUse, TurnFacts } from "../domain/facts.ts";
import type { GateState, SkipReason } from "../domain/gate.ts";
import type { SessionEvent, SessionRecord, ToolEvent } from "../transcripts/session.ts";

import { join } from "node:path";

import { addHumanText, addToolUses, emptyFacts, markInterrupted } from "../domain/facts.ts";
import { gateBrief, gatePasses, gateSignals, gateSkip } from "../domain/gate.ts";
import { textField } from "../domain/json.ts";
import { utcDay } from "../domain/text.ts";
import { editedPath, scanSessionFile } from "../transcripts/session.ts";

export type ReplayReport = {
  readonly files: number;
  readonly sessions: number;
  readonly turns: number;
  readonly passed: number;
  readonly sessionsWithPass: number;
  readonly skipped: Readonly<Record<string, number>>;
  readonly scoreHistogram: Readonly<Record<string, number>>;
  readonly sampleBriefs: readonly string[];
};

const SCRATCH_PREFIX = "/tmp/claude-";

const SAMPLE_BRIEFS = 5;

export function toToolUse(event: ToolEvent): ToolUse {
  return {
    tool: event.tool,
    path: editedPath(event),
    command: textField(event.input, "command"),
    isError: event.isError,
    isRefused: event.isRefused,
  };
}

type Turn = { readonly facts: TurnFacts; readonly at: string; readonly aborted: boolean };

/** Cuts a session's events into turns: a human message opens one, the tools until the next close it. */
export function turnsOf(events: readonly SessionEvent[]): readonly Turn[] {
  const turns: Turn[] = [];
  let facts = emptyFacts;
  let open = false;
  let at = "";
  let aborted = false;
  let tools: ToolUse[] = [];

  const close = (): void => {
    if (!open) {
      return;
    }

    turns.push({ facts: addToolUses(facts, tools), at, aborted });
    facts = emptyFacts;
    tools = [];
    open = false;
    aborted = false;
  };

  for (const event of events) {
    switch (event.kind) {
      case "human": {
        close();
        facts = addHumanText(turns.at(-1)?.aborted === true ? markInterrupted(facts) : facts, event.text);
        open = true;
        at = event.timestamp;
        break;
      }

      case "tool": {
        tools.push(toToolUse(event));
        at = event.timestamp;
        break;
      }

      case "interrupt": {
        aborted = true;
        at = event.timestamp;
        break;
      }

      default: {
        break;
      }
    }
  }

  close();

  return turns;
}

type Tally = {
  turns: number;
  passed: number;
  sessionsWithPass: number;
  skipped: Record<string, number>;
  scoreHistogram: Record<string, number>;
  sampleBriefs: string[];
};

/** Replays the Gate's code over one session: facts accumulate across turns until a pass resets them. */
export function replaySession(
  record: SessionRecord,
  config: HindsightConfig,
  tally: Tally,
  debriefsByDay: Map<string, number>,
): void {
  let carried = emptyFacts;
  let lastDebriefAt: number | null = null;
  let debriefsInSession = 0;
  let passedHere = false;

  for (const turn of turnsOf(record.events)) {
    tally.turns += 1;

    const facts: TurnFacts = {
      ...turn.facts,
      humanTexts: [...carried.humanTexts, ...turn.facts.humanTexts],
      edits: [...carried.edits, ...turn.facts.edits],
      toolCalls: carried.toolCalls + turn.facts.toolCalls,
      toolErrors: carried.toolErrors + turn.facts.toolErrors,
      refusedTools: [...carried.refusedTools, ...turn.facts.refusedTools],
      gitCommits: carried.gitCommits + turn.facts.gitCommits,
      prompts: carried.prompts + turn.facts.prompts,
    };

    const now = new Date(turn.at).getTime();
    const day = utcDay(turn.at);

    const state: GateState = {
      isInteractive: record.isInteractive,
      agentId: null,
      isAborted: turn.aborted,
      forkRunning: false,
      repoRoot: record.cwd,
      lastDebriefAt,
      debriefsInSession,
      debriefsToday: debriefsByDay.get(day) ?? 0,
      now,
    };

    const skip: SkipReason | null = gateSkip(state, facts, config);

    if (skip !== null) {
      tally.skipped[skip] = (tally.skipped[skip] ?? 0) + 1;
      carried = turn.aborted ? markInterrupted(facts) : facts;
      continue;
    }

    const signals = gateSignals(facts);
    const bucket = signals.score.toFixed(1);
    tally.scoreHistogram[bucket] = (tally.scoreHistogram[bucket] ?? 0) + 1;

    if (!gatePasses(signals, config)) {
      tally.skipped["below-threshold"] = (tally.skipped["below-threshold"] ?? 0) + 1;
      carried = facts;
      continue;
    }

    tally.passed += 1;
    passedHere = true;

    if (tally.sampleBriefs.length < SAMPLE_BRIEFS) {
      tally.sampleBriefs.push(gateBrief(signals, facts));
    }

    lastDebriefAt = now;
    debriefsInSession += 1;
    debriefsByDay.set(day, (debriefsByDay.get(day) ?? 0) + 1);
    carried = emptyFacts;
  }

  if (passedHere) {
    tally.sessionsWithPass += 1;
  }
}

export async function replayGate(projectsDir: string, days: number, config: HindsightConfig): Promise<ReplayReport> {
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const tally: Tally = { turns: 0, passed: 0, sessionsWithPass: 0, skipped: {}, scoreHistogram: {}, sampleBriefs: [] };
  const debriefsByDay = new Map<string, number>();
  let files = 0;
  let sessions = 0;
  const paths: string[] = [];

  for await (const relative of new Bun.Glob("*/*.jsonl").scan({ cwd: projectsDir, onlyFiles: true })) {
    const path = join(projectsDir, relative);

    if (Bun.file(path).lastModified >= sinceMs) {
      paths.push(path);
    }
  }

  for (const path of paths.toSorted()) {
    files += 1;
    // oxlint-disable-next-line eslint/no-await-in-loop -- a replay spans days of transcripts: scanning them all at once would hold every record in memory.
    const record = await scanSessionFile(path);

    if (record === null || record.cwd === null || record.cwd.startsWith(SCRATCH_PREFIX)) {
      continue;
    }

    if (record.firstAt !== null && new Date(record.firstAt).getTime() < sinceMs) {
      continue;
    }

    sessions += 1;
    replaySession(record, config, tally, debriefsByDay);
  }

  return { files, sessions, ...tally };
}
