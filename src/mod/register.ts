import type { Host } from "./host.ts";
import type { EngineInterface, Register } from "claude-code";
import { defaultConfig, readConfig, type HindsightConfig } from "../domain/config.ts";
import { addHumanText } from "../domain/facts.ts";
import { cleanHumanText } from "../domain/human.ts";
import { cliConfig, cliStatus } from "./cli-client.ts";
import { afterTurn, classifyThenDebrief } from "./gate.ts";
import { noticeLine } from "./notice.ts";
import { pruneStore, readState, writeState } from "./state.ts";

const COMMAND = "hindsight";
const HUMAN_ORIGINS = new Set(["composer", "bridge"]);

let config: HindsightConfig = defaultConfig;
let isInteractive = true;

function makeHost($: EngineInterface): Host {
  return {
    pluginRoot: $.plugin.root,
    now: () => $.clock.now(),
    sessionId: () => $.session.id(),
    repoRoot: async () => (await $.session.repo())?.root ?? null,
    messages: () => $.session.messages(),
    storeGet: (key) => $.store.get(key),
    storeSet: (key, value) => $.store.set(key, value),
    storeDelete: (key) => $.store.delete(key),
    storeKeys: () => $.store.keys(),
    run: (argv, init) => $.process.run([...argv], init),
    classify: (text, labels, model) => $.model.classify(text, labels, model === null ? undefined : { model }),
    fork: (prompt) => $.model.fork({ prompt }),
    after: (ms, fn) => {
      $.clock.after(ms, fn);
    },
    status: (text) => $.ui.status(text),
    toast: (text) => $.ui.toast(text),
    log: (text) => $.ui.log(text, { to: "debug" }),
    fill: async (text) => {
      await $.prompt.fill({ text, mode: "replace" });
    },
  };
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Config, Notice and store upkeep, none of it awaited by the hook: the first prompt never waits for the CLI. */
async function startup(host: Host): Promise<void> {
  try {
    config = readConfig(await cliConfig(host));
  } catch (error) {
    host.toast(`hindsight : config illisible, défauts gardés (${describe(error)})`);
  }
  try {
    host.status(noticeLine(await cliStatus(host)));
  } catch (error) {
    host.log(`status failed: ${describe(error)}`);
  }
  try {
    await pruneStore(host, await host.now());
  } catch (error) {
    host.log(`store prune failed: ${describe(error)}`);
  }
}

async function captureHuman(host: Host, text: string): Promise<void> {
  const cleaned = cleanHumanText(text);
  if (cleaned === "") return;
  const now = await host.now();
  const sessionId = await host.sessionId();
  const state = await readState(host, sessionId, now);
  await writeState(host, sessionId, { ...state, facts: addHumanText(state.facts, cleaned) }, now);
}

async function endTurn(host: Host, turnId: string, isAborted: boolean, agentId: string | null): Promise<void> {
  const outcome = await afterTurn(host, config, { turnId, isAborted, agentId, isInteractive });
  if (outcome.kind !== "pass") return;
  host.after(1, () => {
    void classifyThenDebrief(host, config, turnId, outcome.brief, outcome.score, false).catch((error: unknown) =>
      host.log(`debrief pipeline failed: ${describe(error)}`),
    );
  });
}

async function forceDebrief(host: Host): Promise<void> {
  const now = await host.now();
  const sessionId = await host.sessionId();
  const state = await readState(host, sessionId, now);
  const brief = `Forced by /hindsight debrief. Facts since the previous debrief: ${state.facts.prompts} human message(s), ${state.facts.toolCalls} tool call(s), ${state.facts.edits.length} Edit/Write.`;
  host.toast("Debrief forcé : le fork relit la session…");
  await classifyThenDebrief(host, config, null, brief, 0, true);
}

async function runCommand(host: Host, args: string): Promise<void> {
  const [verb = "status"] = args.trim().split(/\s+/);
  switch (verb) {
    case "status": {
      const status = await cliStatus(host);
      host.toast(noticeLine(status) ?? "hindsight : rien en attente");
      return;
    }
    case "debrief":
      await forceDebrief(host);
      return;
    case "review":
    case "learn":
    case "handoff":
      host.toast(`hindsight : /hindsight ${verb} arrive dans une tranche suivante de la v2`);
      return;
    default:
      host.toast(`hindsight : commande inconnue « ${verb} » (review, status, debrief, learn, handoff)`);
  }
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    isInteractive = e.isInteractive;
    const host = makeHost($);
    try {
      await $.command.register({
        name: COMMAND,
        description: "hindsight : review, status, debrief, learn, handoff",
        argumentHint: "review|status|debrief|learn|handoff",
      });
    } catch (error) {
      host.toast(`hindsight : commande non enregistrée (${describe(error)})`);
    }
    void startup(host);
    return next(e);
  });

  on("prompt.submit", async ($, e, next) => {
    if (HUMAN_ORIGINS.has(e.origin.kind)) {
      try {
        await captureHuman(makeHost($), e.text);
      } catch (error) {
        makeHost($).log(`prompt capture failed: ${describe(error)}`);
      }
    }
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    if (e.agentId === undefined) {
      const host = makeHost($);
      void endTurn(host, e.turnId, e.isAborted, null).catch((error: unknown) =>
        host.log(`gate failed: ${describe(error)}`),
      );
    }
    return result;
  });

  on("command.run", { command: COMMAND }, async ($, e) => {
    const host = makeHost($);
    void runCommand(host, e.args).catch((error: unknown) => host.toast(`hindsight : ${describe(error)}`));
    return {};
  });
};
