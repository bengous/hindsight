import type { HindsightConfig } from "../domain/config.ts";
import type { ToolUse } from "../domain/facts.ts";
import type { GateState } from "../domain/gate.ts";
import type { Host } from "./host.ts";
import type { SessionState } from "./state.ts";
import type { SessionMessage, ToolUseSummary } from "claude-code";

import { addToolUses, isRefusalText, markInterrupted } from "../domain/facts.ts";
import { classifierText, gateBrief, gatePasses, gateSignals, gateSkip } from "../domain/gate.ts";
import { isString } from "../domain/json.ts";
import { cliGateLog } from "./cli-client.ts";
import { debriefToast, runDebrief } from "./debrief.ts";
import { changeState, countDebriefToday, debriefsToday, factsSince, takeFork } from "./state.ts";

export type TurnEnd = {
  readonly turnId: string;
  readonly isAborted: boolean;
  readonly agentId: string | null;
  readonly isInteractive: boolean;
};

function inputString(use: ToolUseSummary, key: string): string | null {
  const value = use.input[key];

  return isString(value) ? value : null;
}

export function toToolUse(use: ToolUseSummary): ToolUse {
  const isError = use.isError === true;

  return {
    tool: use.tool,
    path: inputString(use, "file_path") ?? inputString(use, "notebook_path"),
    command: inputString(use, "command"),
    isError,
    isRefused: isError && isRefusalText(use.text ?? ""),
  };
}

/** The tool uses of the last turn: every assistant row after the last human prompt. */
export function lastTurnTools(messages: readonly SessionMessage[]): readonly ToolUse[] {
  let start = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message?.role === "user" && message.text.trim() !== "" && (message.toolResults ?? []).length === 0) {
      start = index;
      break;
    }
  }

  return messages
    .slice(start)
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.toolUses.map(toToolUse));
}

export type GateOutcome =
  | { readonly kind: "skip"; readonly reason: string }
  | { readonly kind: "pass"; readonly brief: string; readonly score: number };

/** The code's part of the Gate at the end of a turn: adds the turn's tool uses to the facts, then skips or passes to the classifier. */
export async function afterTurn(
  host: Host,
  config: HindsightConfig,
  turn: TurnEnd,
  messages: readonly SessionMessage[],
): Promise<GateOutcome> {
  const now = await host.now();
  const sessionId = await host.sessionId();
  const tools = lastTurnTools(messages);
  const repoRoot = await host.repoRoot();
  const today = await debriefsToday(host, now);

  const state = await changeState(host, sessionId, now, (current) => {
    const withTools = addToolUses(current.facts, tools);

    return { ...current, facts: turn.isAborted ? markInterrupted(withTools) : withTools };
  });

  const { facts } = state;

  const gateState: GateState = {
    isInteractive: turn.isInteractive,
    agentId: turn.agentId,
    isAborted: turn.isAborted,
    forkRunning: state.forkRunning,
    repoRoot,
    lastDebriefAt: state.lastDebriefAt,
    debriefsInSession: state.debriefsInSession,
    debriefsToday: today,
    now,
  };

  const skip = gateSkip(gateState, facts, config);
  const signals = gateSignals(facts);

  if (skip !== null) {
    cliGateLog(host, {
      sessionId,
      turnId: turn.turnId,
      decision: "skip",
      reason: skip,
      score: signals.score,
      signals: signals.signals,
    });

    return { kind: "skip", reason: skip };
  }

  if (!gatePasses(signals, config)) {
    cliGateLog(host, {
      sessionId,
      turnId: turn.turnId,
      decision: "skip",
      reason: "below-threshold",
      score: signals.score,
      signals: signals.signals,
    });

    return { kind: "skip", reason: "below-threshold" };
  }

  return { kind: "pass", brief: gateBrief(signals, facts), score: signals.score };
}

async function setFork(host: Host, sessionId: string, update: (state: SessionState) => SessionState): Promise<void> {
  await changeState(host, sessionId, await host.now(), update);
}

/** The model's part: the classifier, then the Debrief. Runs off the turn's dispatch, from a timer. */
export async function classifyThenDebrief(
  host: Host,
  config: HindsightConfig,
  turnId: string | null,
  brief: string,
  score: number,
  force: boolean,
): Promise<void> {
  const sessionId = await host.sessionId();
  const startedAt = await host.now();
  const state = await takeFork(host, sessionId, startedAt);

  if (state === null) {
    cliGateLog(host, { sessionId, turnId, decision: "skip", reason: "fork-running", score, signals: [] });

    return;
  }

  const release = async (): Promise<void> =>
    setFork(host, sessionId, (current) => ({ ...current, forkRunning: false, forkStartedAt: null }));

  if (!force) {
    let label: string | undefined;

    try {
      label = await host.classify(classifierText(brief, state.facts), ["debrief", "skip"], config.gate.classifierModel);
    } catch (error) {
      cliGateLog(host, { sessionId, turnId, decision: "skip", reason: "classifier-error", score, signals: [] });
      host.log(`classifier failed: ${error instanceof Error ? error.message : String(error)}`);
      await release();

      return;
    }

    if (label !== "debrief") {
      cliGateLog(host, {
        sessionId,
        turnId,
        decision: "skip",
        reason: label === "skip" ? "classifier-skip" : "classifier-unsure",
        score,
        signals: [],
      });
      await release();

      return;
    }
  }

  cliGateLog(host, { sessionId, turnId, decision: force ? "forced" : "debrief", reason: null, score, signals: [] });

  try {
    const run = await runDebrief(host, sessionId, await host.repoRoot(), brief);
    const at = await host.now();
    await setFork(host, sessionId, (current) =>
      run.kind === "aborted"
        ? { ...current, forkRunning: false, forkStartedAt: null }
        : {
            ...current,
            forkRunning: false,
            forkStartedAt: null,
            facts: factsSince(current.facts, state.facts),
            lastDebriefAt: at,
            debriefsInSession: current.debriefsInSession + 1,
          },
    );

    if (run.kind !== "aborted") {
      await countDebriefToday(host, at);
    }

    const toast = debriefToast(run);

    if (toast !== null) {
      host.toast(toast);
    }
  } catch (error) {
    await release();
    host.toast(`Debrief impossible : ${error instanceof Error ? error.message : String(error)}`);
  }
}
