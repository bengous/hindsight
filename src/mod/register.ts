import type { HindsightConfig } from "../domain/config.ts";
import type { JsonObject, JsonValue } from "../domain/json.ts";
import type { Host, ReviewState } from "./host.ts";
import type { PaneItem, ReviewActions } from "./review-pane.tsx";
import type { EngineInterface, Register, SessionMessage } from "claude-code";

import { atom, read, update } from "claude-code";

import { defaultConfig, readConfig } from "../domain/config.ts";
import { fromDraft, toDraft } from "../domain/diff.ts";
import { addHumanText } from "../domain/facts.ts";
import { cleanHumanText } from "../domain/human.ts";
import { isJsonArray, isJsonObject, isJsonValue, numberField, textField } from "../domain/json.ts";
import { cliConfig, cliStatus, runCli } from "./cli-client.ts";
import { afterTurn, classifyThenDebrief } from "./gate.ts";
import { noticeLine } from "./notice.ts";
import { drawReview, emptyReview, isPaneItem } from "./review-pane.tsx";
import { changeState, pruneStore, readState } from "./state.ts";

const PANE = "hindsight-review";

const HUMAN_ORIGINS = new Set(["composer", "bridge"]);

const DECIDE_TIMEOUT_MS = 10 * 60 * 1000;

const REVIEW = atom({ plugin: "hindsight", key: "review" } as const, emptyReview);

let config: HindsightConfig = defaultConfig;

let isInteractive = true;

/** The texts typed in the edit mode: a `$.state` write per keystroke would redraw the field under the typing. */
let drafts: readonly string[] = [];

function makeHost($: EngineInterface): Host {
  return {
    pluginRoot: $.plugin.root,
    now: async () => $.clock.now(),
    sessionId: async () => $.session.id(),
    repoRoot: async () => (await $.session.repo())?.root ?? null,
    messages: async () => $.session.messages(),
    storeGet: async (key) => {
      const value = await $.store.get(key);

      return isJsonValue(value) ? value : undefined;
    },
    storeSet: async (key, value) => $.store.set(key, value),
    storeDelete: async (key) => $.store.delete(key),
    storeKeys: async () => $.store.keys(),
    reviewState: async () => read($, REVIEW),
    updateReview: async (change) => {
      await update($, REVIEW, change);
    },
    run: async (argv, init) => $.process.run([...argv], init),
    classify: async (text, labels, model) => $.model.classify(text, labels, model === null ? undefined : { model }),
    fork: async (prompt) => $.model.fork({ prompt }),
    after: (ms, fn) => {
      $.clock.after(ms, fn);
    },
    status: (text) => $.ui.status(text),
    toast: (text) => $.ui.toast(text),
    log: (text) => $.ui.log(text, { to: "debug" }),
    fill: async (text) => {
      // oxlint-disable-next-line unicorn/no-array-fill-with-reference-type -- `$.prompt.fill` fills the prompt, not an array: no slot shares the object.
      await $.prompt.fill({ text, mode: "replace" });
    },
  };
}

const describe = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const logFailure =
  (host: Host, what: string) =>
  (cause: unknown): void => {
    host.log(`${what} failed: ${describe(cause)}`);
  };

const toastFailure =
  (host: Host) =>
  (cause: unknown): void => {
    host.toast(describe(cause));
  };

/** Config, Notice and store upkeep, none of it awaited by the hook: the first prompt never waits for the CLI. */
async function startup(host: Host): Promise<void> {
  try {
    config = readConfig(await cliConfig(host));
  } catch (error) {
    host.toast(`config illisible, défauts gardés (${describe(error)})`);
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

  if (cleaned === "") {
    return;
  }

  const now = await host.now();
  const sessionId = await host.sessionId();
  await changeState(host, sessionId, now, (state) => ({ ...state, facts: addHumanText(state.facts, cleaned) }));
}

async function endTurn(
  host: Host,
  turnId: string,
  isAborted: boolean,
  messages: readonly SessionMessage[],
): Promise<void> {
  const outcome = await afterTurn(host, config, { turnId, isAborted, agentId: null, isInteractive }, messages);

  if (outcome.kind !== "pass") {
    return;
  }

  try {
    await classifyThenDebrief(host, config, turnId, outcome.brief, outcome.score, false);
  } catch (error) {
    logFailure(host, "debrief pipeline")(error);
  }
}

async function forceDebrief(host: Host): Promise<void> {
  const now = await host.now();
  const sessionId = await host.sessionId();
  const state = await readState(host, sessionId, now);
  const brief = `Forced by /hindsight debrief. Facts since the previous debrief: ${state.facts.prompts} human message(s), ${state.facts.toolCalls} tool call(s), ${state.facts.edits.length} Edit/Write.`;
  host.toast("Debrief forcé : le fork relit la session…");
  await classifyThenDebrief(host, config, null, brief, 0, true);
}

function toPaneItems(answer: JsonValue): Pick<ReviewState, "items" | "pending"> {
  const listed = isJsonObject(answer) ? answer["items"] : undefined;

  if (!isJsonArray(listed)) {
    throw new TypeError("review list answered without items");
  }

  const items = listed.map((item, index) => {
    if (!isPaneItem(item)) {
      throw new TypeError(`review list: item ${index} is out of shape`);
    }

    return item;
  });

  return { items, pending: numberField(answer, "pending") ?? items.length };
}

async function openReview(host: Host, open: (focus: boolean) => Promise<boolean>): Promise<void> {
  const listed = toPaneItems(await runCli(host, ["review", "list"]));
  await host.updateReview(() => ({ ...emptyReview, items: listed.items, pending: listed.pending }));

  if (listed.items.length === 0) {
    host.toast("aucune Proposal en attente");

    return;
  }

  if (!(await open(true))) {
    host.toast("élargis le terminal pour voir le panneau de Review");
  }
}

function decisionLabel(kind: JsonValue | undefined): string {
  if (kind === "accepted") {
    return "acceptée";
  }

  if (kind === "rejected") {
    return "rejetée";
  }

  return "en Handoff";
}

function dropProposal(state: ReviewState, id: string): ReviewState {
  const items = state.items.filter((item) => item.id !== id);

  return {
    ...state,
    items,
    index: Math.min(state.index, Math.max(0, items.length - 1)),
    mode: { kind: "view" },
    expanded: [],
  };
}

async function decide(host: Host, id: string, decision: JsonObject): Promise<void> {
  await host.updateReview((state) => ({ ...state, mode: { kind: "busy", label: "Décision en cours…" }, notice: null }));

  try {
    const answer = await runCli(host, ["review", "decide"], {
      stdin: JSON.stringify({ id, ...decision }),
      timeoutMs: DECIDE_TIMEOUT_MS,
    });

    const kind = isJsonObject(answer) ? answer["kind"] : undefined;

    if (kind === "refused") {
      const reason = textField(answer, "reason") ?? "refusée";
      await host.updateReview((state) => ({
        ...state,
        mode: { kind: "view" },
        notice: `Décision refusée : ${reason}`,
      }));
    } else {
      host.toast(`Proposal ${decisionLabel(kind)}`);
      await host.updateReview((state) => dropProposal(state, id));
    }
  } catch (error) {
    await host.updateReview((state) => ({ ...state, mode: { kind: "view" }, notice: describe(error) }));
  }
}

/** The drafts of the item being edited; seeded again when a reload emptied them while `$.state` kept the edit mode. */
function draftsFor(state: ReviewState): readonly string[] {
  const item = state.items[state.index];

  if (state.mode.kind === "edit" && item?.change.kind === "edit" && drafts.length !== item.change.edits.length) {
    drafts = item.change.edits.map((edit) => toDraft(edit.newText));
  }

  return drafts;
}

function paneActions(host: Host): ReviewActions {
  const change = (fn: (state: ReviewState) => ReviewState): void => {
    void host.updateReview(fn).catch(logFailure(host, "review"));
  };

  const onCurrent = (act: (item: PaneItem, state: ReviewState) => Promise<void>): void => {
    const run = async (): Promise<void> => {
      const state = await host.reviewState();
      const item = state.items[state.index];

      if (item !== undefined) {
        await act(item, state);
      }
    };

    void run().catch(logFailure(host, "review"));
  };

  return {
    accept: (edits) => onCurrent(async (item) => decide(host, item.id, { decision: "accept", edits })),
    acceptEdited: () =>
      onCurrent(async (item, state) => {
        if (item.change.kind !== "edit" || state.mode.kind !== "edit") {
          return;
        }

        const edits = item.change.edits.map((edit, index) => ({
          oldText: edit.oldText,
          newText: fromDraft(drafts[index] ?? toDraft(edit.newText)),
        }));

        await decide(host, item.id, { decision: "accept", edits });
      }),
    reject: (reason) =>
      onCurrent(async (item) => {
        if (reason.trim() === "") {
          await host.updateReview((state) => ({ ...state, notice: "Un rejet demande une raison." }));

          return;
        }

        await decide(host, item.id, { decision: "reject", reason: reason.trim() });
      }),
    handoff: () => onCurrent(async (item) => decide(host, item.id, { decision: "handoff" })),
    next: () =>
      change((state) =>
        state.items.length === 0
          ? state
          : {
              ...state,
              index: (state.index + 1) % state.items.length,
              mode: { kind: "view" },
              expanded: [],
              notice: null,
            },
      ),
    edit: () =>
      onCurrent(async (item) => {
        if (item.change.kind !== "edit") {
          return;
        }

        drafts = item.change.edits.map((edit) => toDraft(edit.newText));
        await host.updateReview((state) => ({ ...state, mode: { kind: "edit" }, notice: null }));
      }),
    setMode: (mode) => change((state) => ({ ...state, mode, notice: null })),
    toggleEvidence: (index) =>
      change((state) => ({
        ...state,
        expanded: state.expanded.includes(index)
          ? state.expanded.filter((i) => i !== index)
          : [...state.expanded, index],
      })),
    setDraft: (index, value) => {
      drafts = drafts.map((draft, i) => (i === index ? value : draft));
    },
  };
}

async function fillHandoff(host: Host): Promise<void> {
  const answer = await runCli(host, ["handoff", "prepare"]);
  const instructions = textField(answer, "instructions");

  if (instructions === null) {
    host.toast("aucune Proposal en Handoff");

    return;
  }

  await host.fill(instructions);
  host.toast("instructions du Handoff dans le prompt, à envoyer si tu veux");
}

async function runCommand(host: Host, args: string, open: (focus: boolean) => Promise<boolean>): Promise<void> {
  const [verb = "status"] = args.trim().split(/\s+/);

  switch (verb) {
    case "status": {
      const status = await cliStatus(host);
      host.toast(noticeLine(status) ?? "rien en attente");

      return;
    }

    case "debrief": {
      await forceDebrief(host);

      return;
    }

    case "review": {
      await openReview(host, open);

      return;
    }

    case "handoff": {
      await fillHandoff(host);

      return;
    }

    case "learn": {
      const answer = await runCli(host, ["learn", "--detach"]);
      host.toast(
        isJsonObject(answer) && answer["detached"] === true ? "Learn lancé en arrière-plan" : "Learn non lancé",
      );

      return;
    }

    default: {
      host.toast(`commande inconnue « ${verb} » (review, status, debrief, learn, handoff)`);
    }
  }
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    isInteractive = e.isInteractive;
    const host = makeHost($);

    try {
      await $.command.register({
        name: "hindsight",
        description: "review, status, debrief, learn, handoff",
        argumentHint: "review|status|debrief|learn|handoff",
      });
    } catch (error) {
      host.toast(`commande non enregistrée (${describe(error)})`);
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

      const messages = await host.messages();

      host.after(1, () => {
        void endTurn(host, e.turnId, e.isAborted, messages).catch(logFailure(host, "gate"));
      });
    }

    return result;
  });

  on("command.run", { command: "hindsight" }, async ($, e) => {
    const host = makeHost($);

    const open = async (focus: boolean): Promise<boolean> => {
      const opened = await $.ui.open(
        focus
          ? { id: PANE, title: "hindsight · Review", focus: true, closeOnEscape: true, rows: 30 }
          : { id: PANE, title: "hindsight · Review" },
      );

      return opened.isPlaced;
    };

    void runCommand(host, e.args, open).catch(toastFailure(host));

    return {};
  });

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const state = await read($, REVIEW);

    return drawReview($.ui.resolve(e), state, draftsFor(state), paneActions(makeHost($)), e.props.bodyColumns);
  });
};
