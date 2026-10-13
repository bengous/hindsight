import type { JsonValue } from "../domain/json.ts";
import type { On } from "claude-code";

import { describe, expect, mock, test } from "claude-code/testing";

import { isJsonObject, parseJson } from "../domain/json.ts";

const SESSION = { cwd: "/repo", surface: "terminal", isInteractive: true } as const;

const RUN = { origin: { kind: "composer" }, presentation: { isFullscreen: true, columns: 160 } } as const;

const PANE_PROPS = {
  title: "hindsight · Review",
  isFocused: true,
  bodyColumns: 100,
  placement: "dock",
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const;

const edit = {
  id: "p-edit",
  targetPath: "/repo/AGENTS.md",
  repoRoot: "/repo",
  verdict: "missing",
  source: "learn",
  claimFr: "Pas de npm dans ce dépôt.",
  reasoningFr: "Corrigé trois fois.",
  lessonEn: "Install packages with pnpm.",
  change: {
    kind: "edit",
    edits: [{ oldText: "- Keep commits small.", newText: "- Keep commits small.\n- Install packages with pnpm." }],
  },
  evidence: [
    {
      kind: "quote",
      at: "2026-10-01T10:00:00.000Z",
      text: "non, pas de npm pour ça",
      message: "bon, non, pas de npm pour ça",
      tool: null,
      evidenceId: "s:u",
      sessionId: "s",
    },
  ],
  prevalence: { sessions: 3, days: 2, repos: 1 },
};

const description = {
  ...edit,
  id: "p-desc",
  change: { kind: "description", text: "Add a pre-commit hook." },
  evidence: [],
  prevalence: { sessions: 0, days: 0, repos: 1 },
};

type World = {
  readonly decisions: JsonValue[];
  readonly toasts: string[];
  readonly opened: unknown[];
  readonly clock: ReturnType<typeof mock.clock>;
};

function decided(decision: JsonValue | undefined): string {
  if (decision === "accept") {
    return "accepted";
  }

  if (decision === "reject") {
    return "rejected";
  }

  return "handed_off";
}

function cliAnswer(world: World, items: readonly JsonValue[], command: string, stdin: string | undefined): JsonValue {
  switch (command) {
    case "status": {
      return { pendingProposals: items.length, failures: [] };
    }

    case "review list": {
      return { items, pending: items.length, expired: 0, superseded: 0 };
    }

    case "review decide": {
      const body = parseJson(stdin ?? "{}");
      world.decisions.push(body);

      return { kind: decided(isJsonObject(body) ? body["decision"] : undefined) };
    }

    case "handoff prepare": {
      return { id: "h1", instructions: "hindsight handoff: do it", proposals: 1 };
    }

    default: {
      return {};
    }
  }
}

function build(on: On, items: readonly JsonValue[]): World {
  const world: World = { decisions: [], toasts: [], opened: [], clock: mock.clock(on, { now: 1_000_000 }) };
  mock.store(on);
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("session.id", () => ({ value: "s-test" }));
  on("session.repo", () => ({ value: null }));
  on("session.messages", () => ({ value: [] }));
  on("command.register", (_, e) => ({ value: { command: e.name } }));
  on("ui.status", () => ({ value: undefined }));
  on("ui.log", () => ({ value: undefined }));
  on("ui.toast", (_, e) => {
    world.toasts.push(e.text);

    return { value: undefined };
  });
  on("ui.open", (_, e) => {
    world.opened.push(e);

    return { value: { isPlaced: true } };
  });
  on("process.run", (_, e) => {
    const command = e.argv
      .slice(2)
      .filter((arg) => arg !== "--json")
      .slice(0, 2)
      .join(" ");

    return {
      value: {
        exitCode: 0,
        stdout: `${JSON.stringify(cliAnswer(world, items, command, e.init?.stdin))}\n`,
        stderr: "",
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    };
  });

  return world;
}

describe("the Review pane", () => {
  test("on every surface: accept and reject send the right decision, a rejection needs a reason", async ($, on) => {
    const world = build(on, [edit, description]);
    await $.session.start(SESSION);
    expect(await $.command.run({ command: "hindsight", args: "review", ...RUN })).toEqual({});
    await world.clock.settle();
    expect(world.opened).toHaveLength(1);

    const decideOn = async (surface: "terminal" | "desktop"): Promise<void> => {
      const before = world.decisions.length;

      const ui = await $.ui.mount({
        plugin: "hindsight",
        surface,
        component: "Pane",
        props: PANE_PROPS,
        requestId: "hindsight-review",
      });

      expect(await ui.find({ type: "Text", text: /AGENTS\.md/ })).toBeDefined();
      expect(await ui.find({ type: "Code" })).toBeDefined();
      expect(await ui.find({ type: "Button", text: /Accepter/ })).toBeDefined();
      await ui.press({ key: "reject" });
      await ui.input({ key: "reject-reason", text: "   " });
      expect(world.decisions).toHaveLength(before);
      expect(await ui.find({ type: "Text", text: /demande une raison/ })).toBeDefined();
      await ui.input({ key: "reject-reason", text: "trop large" });
      expect(world.decisions.at(-1)).toEqual({ id: "p-edit", decision: "reject", reason: "trop large" });
      expect(await ui.find({ type: "Button", text: /Accepter/ })).toBeUndefined();
      expect(await ui.find({ type: "Text", text: /Add a pre-commit hook/ })).toBeDefined();
      await ui.press({ key: "handoff" });
      expect(world.decisions.at(-1)).toEqual({ id: "p-desc", decision: "handoff" });
      expect(await ui.find({ type: "Text", text: /Aucune Proposal/ })).toBeDefined();
      await ui.unmount();
      await $.command.run({ command: "hindsight", args: "review", ...RUN });
      await world.clock.settle();
    };

    await decideOn("terminal");
    await decideOn("desktop");
  });

  test("accept sends the edits as drawn, and edit then accept sends the human's text", async ($, on) => {
    const world = build(on, [edit]);
    await $.session.start(SESSION);
    await $.command.run({ command: "hindsight", args: "review", ...RUN });
    await world.clock.settle();

    const ui = await $.ui.mount({
      plugin: "hindsight",
      surface: "terminal",
      component: "Pane",
      props: PANE_PROPS,
      requestId: "hindsight-review",
    });

    await ui.press({ key: "edit" });
    await ui.input({ key: "draft-0", text: "- Keep commits small.⏎- Add packages with pnpm.", kind: "change" });
    await ui.press({ key: "accept-edited" });
    expect(world.decisions.at(-1)).toEqual({
      id: "p-edit",
      decision: "accept",
      edits: [{ oldText: "- Keep commits small.", newText: "- Keep commits small.\n- Add packages with pnpm." }],
    });
    await ui.unmount();
    await $.command.run({ command: "hindsight", args: "review", ...RUN });
    await world.clock.settle();

    const again = await $.ui.mount({
      plugin: "hindsight",
      surface: "terminal",
      component: "Pane",
      props: PANE_PROPS,
      requestId: "hindsight-review",
    });

    await again.press({ key: "accept" });
    expect(world.decisions.at(-1)).toEqual({ id: "p-edit", decision: "accept", edits: null });
  });

  test("/hindsight handoff fills the prompt and answers no text", async ($, on) => {
    const world = build(on, []);
    const filled: string[] = [];
    on("prompt.fill", (_, e) => {
      filled.push(e.text);

      return { isFilled: true };
    });
    await $.session.start(SESSION);
    expect(await $.command.run({ command: "hindsight", args: "handoff", ...RUN })).toEqual({});
    await world.clock.settle();
    expect(filled).toEqual(["hindsight handoff: do it"]);
    expect(world.toasts.at(-1)).toContain("Handoff");
  });
});
