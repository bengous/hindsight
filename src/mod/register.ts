import type { Host } from "./host.ts";
import type { EngineInterface, Register } from "claude-code";
import { defaultConfig, readConfig, type HindsightConfig } from "../domain/config.ts";
import { fromDraft, toDraft } from "../domain/diff.ts";
import { addHumanText } from "../domain/facts.ts";
import { cleanHumanText } from "../domain/human.ts";
import { cliConfig, cliStatus, runCli } from "./cli-client.ts";
import { afterTurn, classifyThenDebrief } from "./gate.ts";
import { noticeLine } from "./notice.ts";
import {
  drawReview,
  emptyReview,
  type PaneElements,
  type PaneItem,
  type PaneMode,
  type ReviewActions,
  type ReviewState,
} from "./review-pane.tsx";
import { pruneStore, readState, writeState } from "./state.ts";

const COMMAND = "hindsight";
const PANE = "hindsight-review";
const HUMAN_ORIGINS = new Set(["composer", "bridge"]);
const DECIDE_TIMEOUT_MS = 10 * 60 * 1000;

let config: HindsightConfig = defaultConfig;
let isInteractive = true;
let review: ReviewState = emptyReview;

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

type Json = Readonly<Record<string, unknown>>;
const isJson = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

function toPaneItems(answer: unknown): { items: PaneItem[]; pending: number } {
  const items = isJson(answer) && Array.isArray(answer["items"]) ? (answer["items"] as PaneItem[]) : [];
  const pending = isJson(answer) && typeof answer["pending"] === "number" ? answer["pending"] : items.length;
  return { items, pending };
}

async function openReview(host: Host, open: (focus: boolean) => Promise<boolean>, redraw: () => void): Promise<void> {
  const listed = toPaneItems(await runCli(host, ["review", "list"]));
  review = { ...emptyReview, items: listed.items, pending: listed.pending };
  if (listed.items.length === 0) {
    host.toast("hindsight : aucune Proposal en attente");
    return;
  }
  redraw();
  if (!(await open(true))) host.toast("hindsight : élargis le terminal pour voir le panneau de Review");
}

function dropCurrent(): void {
  const items = review.items.filter((_, index) => index !== review.index);
  review = {
    ...review,
    items,
    index: Math.min(review.index, Math.max(0, items.length - 1)),
    mode: { kind: "view" },
    expanded: [],
  };
}

async function decide(host: Host, body: Json, redraw: () => void): Promise<void> {
  review = { ...review, mode: { kind: "busy", label: "Décision en cours…" }, notice: null };
  redraw();
  try {
    const answer = await runCli(host, ["review", "decide"], {
      stdin: JSON.stringify(body),
      timeoutMs: DECIDE_TIMEOUT_MS,
    });
    const kind = isJson(answer) ? answer["kind"] : undefined;
    if (kind === "refused") {
      const reason = isJson(answer) && typeof answer["reason"] === "string" ? answer["reason"] : "refusée";
      review = { ...review, mode: { kind: "view" }, notice: `Décision refusée : ${reason}` };
    } else {
      const label = kind === "accepted" ? "acceptée" : kind === "rejected" ? "rejetée" : "en Handoff";
      host.toast(`hindsight : Proposal ${label}`);
      dropCurrent();
    }
  } catch (error) {
    review = { ...review, mode: { kind: "view" }, notice: describe(error) };
  }
  redraw();
}

function paneActions(host: Host, redraw: () => void): ReviewActions {
  const current = (): PaneItem | undefined => review.items[review.index];
  return {
    accept: (edits) => {
      const item = current();
      if (item === undefined) return;
      void decide(host, { id: item.id, decision: "accept", edits }, redraw);
    },
    acceptEdited: () => {
      const item = current();
      if (item === undefined || item.change.kind !== "edit" || review.mode.kind !== "edit") return;
      const drafts = review.mode.drafts;
      const edits = item.change.edits.map((edit, index) => ({
        oldText: edit.oldText,
        newText: fromDraft(drafts[index] ?? toDraft(edit.newText)),
      }));
      void decide(host, { id: item.id, decision: "accept", edits }, redraw);
    },
    reject: (reason) => {
      const item = current();
      if (item === undefined) return;
      if (reason.trim() === "") {
        review = { ...review, notice: "Un rejet demande une raison." };
        redraw();
        return;
      }
      void decide(host, { id: item.id, decision: "reject", reason: reason.trim() }, redraw);
    },
    handoff: () => {
      const item = current();
      if (item === undefined) return;
      void decide(host, { id: item.id, decision: "handoff" }, redraw);
    },
    next: () => {
      if (review.items.length === 0) return;
      review = {
        ...review,
        index: (review.index + 1) % review.items.length,
        mode: { kind: "view" },
        expanded: [],
        notice: null,
      };
      redraw();
    },
    setMode: (mode: PaneMode) => {
      review = { ...review, mode, notice: null };
      redraw();
    },
    toggleEvidence: (index) => {
      const expanded = review.expanded.includes(index)
        ? review.expanded.filter((i) => i !== index)
        : [...review.expanded, index];
      review = { ...review, expanded };
      redraw();
    },
    setDraft: (index, value) => {
      if (review.mode.kind !== "edit") return;
      const drafts = review.mode.drafts.map((draft, i) => (i === index ? value : draft));
      review = { ...review, mode: { kind: "edit", drafts } };
    },
  };
}

async function fillHandoff(host: Host): Promise<void> {
  const answer = await runCli(host, ["handoff", "prepare"]);
  const instructions = isJson(answer) && typeof answer["instructions"] === "string" ? answer["instructions"] : null;
  if (instructions === null) {
    host.toast("hindsight : aucune Proposal en Handoff");
    return;
  }
  await host.fill(instructions);
  host.toast("hindsight : instructions du Handoff dans le prompt, à envoyer si tu veux");
}

async function runCommand(
  host: Host,
  args: string,
  pane: { open: (focus: boolean) => Promise<boolean>; redraw: () => void },
): Promise<void> {
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
      await openReview(host, pane.open, pane.redraw);
      return;
    case "handoff":
      await fillHandoff(host);
      return;
    case "learn": {
      const answer = await runCli(host, ["learn", "--detach"]);
      host.toast(
        isJson(answer) && answer["detached"] === true
          ? "hindsight : Learn lancé en arrière-plan"
          : "hindsight : Learn non lancé",
      );
      return;
    }
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
    const pane = {
      open: async (focus: boolean) => {
        const opened = await $.ui.open(
          focus
            ? { id: PANE, title: "hindsight · Review", focus: true, closeOnEscape: true, rows: 30 }
            : { id: PANE, title: "hindsight · Review" },
        );
        return opened.isPlaced;
      },
      redraw: () => $.ui.invalidate("ui.render"),
    };
    void runCommand(host, e.args, pane).catch((error: unknown) => host.toast(`hindsight : ${describe(error)}`));
    return {};
  });

  on("ui.render", { component: "Pane", requestId: PANE }, ($, e) => {
    const host = makeHost($);
    const elements = $.ui.resolve(e) as PaneElements;
    return drawReview(
      elements,
      review,
      paneActions(host, () => $.ui.invalidate("ui.render")),
      e.props.bodyColumns,
    );
  });
};
