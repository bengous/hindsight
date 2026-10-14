import type { JsonValue } from "../domain/json.ts";
import type { On, SessionMessage, ToolUseSummary } from "claude-code";

import { describe, expect, mock, test } from "claude-code/testing";

import { isJsonObject, parseJson } from "../domain/json.ts";

const SESSION = { cwd: "/repo", surface: "terminal", isInteractive: true } as const;

const DEBRIEF_ID = "d-1";

const FORK_ANSWER =
  '```json\n{"steers":[{"quote":"non, pas de npm pour ça","lesson":"Install packages with pnpm.","habit":true}]}\n```';

type Call = { readonly argv: readonly string[]; readonly stdin: string | undefined };

type World = {
  readonly cli: Call[];
  readonly statuses: Array<string | undefined>;
  readonly toasts: string[];
  readonly classified: string[];
  readonly forked: string[];
  readonly clock: ReturnType<typeof mock.clock>;
  messages: SessionMessage[];
  classifyAnswer: string | undefined;
  pendingProposals: number;
  holdCli: Promise<void> | null;
};

function cliAnswer(world: World, argv: readonly string[]): JsonValue {
  const command = argv.slice(2).filter((arg) => arg !== "--json");
  const [name = ""] = command.join(" ").split(" --");

  switch (name) {
    case "config": {
      return { gate: { threshold: 1 } };
    }

    case "status": {
      return { pendingProposals: world.pendingProposals, failures: [] };
    }

    case "debrief start": {
      return { id: DEBRIEF_ID };
    }

    case "debrief record": {
      return {
        status: "recorded",
        failure: null,
        notes: { steers: 1, observations: 0, staleRules: 0 },
        proposals: 0,
        rejected: {},
      };
    }

    case "gate log": {
      return { ok: true };
    }

    default: {
      return {};
    }
  }
}

function build(on: On): World {
  const world: World = {
    cli: [],
    statuses: [],
    toasts: [],
    classified: [],
    forked: [],
    clock: mock.clock(on, { now: 1_000_000 }),
    messages: [],
    classifyAnswer: "debrief",
    pendingProposals: 0,
    holdCli: null,
  };

  mock.store(on);
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("session.id", () => ({ value: "s-test" }));
  on("session.repo", () => ({ value: { root: "/repo", remote: null, internal: false, name: null } }));
  on("session.messages", () => ({ value: world.messages }));
  on("command.register", (_, e) => ({ value: { command: e.name } }));
  on("ui.status", (_, e) => {
    world.statuses.push(e.text);

    return { value: undefined };
  });
  on("ui.toast", (_, e) => {
    world.toasts.push(e.text);

    return { value: undefined };
  });
  on("ui.log", () => ({ value: undefined }));
  on("process.run", async (_, e) => {
    world.cli.push({ argv: e.argv, stdin: e.init?.stdin });

    if (world.holdCli !== null) {
      await world.holdCli;
    }

    return {
      value: {
        exitCode: 0,
        stdout: `${JSON.stringify(cliAnswer(world, e.argv))}\n`,
        stderr: "",
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    };
  });
  on("model.classify", (_, e) => {
    world.classified.push(e.text);

    return { value: world.classifyAnswer };
  });
  on("model.fork", (_, e) => {
    world.forked.push(e.prompt);

    return {
      value: {
        isAnswered: true,
        text: FORK_ANSWER,
        usage: {
          input_tokens: 900,
          output_tokens: 200,
          cache_read_input_tokens: 60_000,
          cache_creation_input_tokens: 0,
        },
      },
    };
  });
  on("prompt.submit", (_, e) => ({ text: e.text, isAborted: false, turnId: "t-1" }));
  on("turn.complete", () => ({ text: "" }));

  return world;
}

const cliCommands = (world: World): string[] =>
  world.cli.map((call) =>
    call.argv
      .slice(2)
      .filter((arg) => arg !== "--json")
      .slice(0, 2)
      .join(" "),
  );

const RUN = { origin: { kind: "composer" }, presentation: { isFullscreen: false, columns: 120 } } as const;

const toolMessage = (tool: string, input: ToolUseSummary["input"], text = "ok", isError?: true): SessionMessage => {
  const use = { tool_use_id: `u-${tool}`, tool, input, text };

  return { role: "assistant", text: "", toolUses: [isError === undefined ? use : { ...use, isError }] };
};

describe("session.start", () => {
  test("registers /hindsight, then reads config and status without holding the hook", async ($, on) => {
    const world = build(on);
    world.pendingProposals = 2;
    world.holdCli = world.clock.sleep(5000);
    const started = await $.session.start(SESSION);
    expect(started).toEqual({ cwd: "/repo" });
    expect(world.cli).toHaveLength(1);
    expect(world.statuses).toEqual([]);
    await world.clock.advance(5000);
    await world.clock.settle();
    expect(cliCommands(world)).toEqual(["config", "status"]);
    expect(world.statuses).toEqual(["2 Proposals en attente · /hindsight review"]);
  });

  test("with nothing pending the status line stays empty", async ($, on) => {
    const world = build(on);
    await $.session.start(SESSION);
    await world.clock.settle();
    expect(world.statuses).toEqual([undefined]);
  });
});

describe("the Gate at turn.complete", () => {
  test("a plain turn is journaled as a skip and no model is called", async ($, on) => {
    const world = build(on);
    await $.session.start(SESSION);
    await world.clock.settle();
    await $.prompt.submit({ text: "Ajoute un test pour parse()", wait: false, origin: { kind: "composer" } });
    world.messages = [toolMessage("Read", { file_path: "/repo/a.ts" })];
    await $.turn.complete({ answer: "done", durationMs: 10, isAborted: false, turnId: "t-1", reason: "answer" });
    expect(world.cli.filter((call) => call.argv.includes("gate"))).toHaveLength(0);
    await world.clock.advance(1);
    await world.clock.settle();
    const log = world.cli.find((call) => call.argv.includes("gate"));
    expect(JSON.parse(log?.stdin ?? "{}")).toMatchObject({ decision: "skip", reason: "below-threshold", score: 0 });
    expect(world.classified).toEqual([]);
    expect(world.forked).toEqual([]);
  });

  test("a correction passes the code, the hook returns before the classifier, then the fork is recorded", async ($, on) => {
    const world = build(on);
    await $.session.start(SESSION);
    await world.clock.settle();
    await $.prompt.submit({ text: "fais le plan", wait: false, origin: { kind: "composer" } });
    await $.turn.complete({ answer: "ok", durationMs: 10, isAborted: false, turnId: "t-0", reason: "answer" });
    await world.clock.advance(1);
    await world.clock.settle();
    await $.prompt.submit({ text: "non, pas de npm pour ça", wait: false, origin: { kind: "composer" } });
    world.messages = [
      toolMessage("Bash", { command: "bun test -u" }, "The user doesn't want to proceed with this tool use.", true),
    ];

    const result = await $.turn.complete({
      answer: "ok",
      durationMs: 10,
      isAborted: false,
      turnId: "t-1",
      reason: "answer",
    });

    expect(result).toEqual({ text: "" });
    expect(world.classified).toEqual([]);
    await world.clock.advance(1);
    await world.clock.settle();
    expect(world.classified).toHaveLength(1);
    expect(world.classified[0]).toContain("tool_refused");
    expect(world.classified[0]).toContain("- non, pas de npm pour ça");
    expect(world.forked).toHaveLength(1);
    expect(world.forked[0]).toContain("[hindsight debrief]");
    const record = world.cli.find((call) => call.argv.includes("record"));
    const body = parseJson(record?.stdin ?? "{}");
    expect(body).toMatchObject({ sessionId: "s-test", text: FORK_ANSWER });
    expect(isJsonObject(body) ? body["cacheShare"] : null).toBeGreaterThan(0.98);
    expect(world.toasts).toEqual(["Debrief : 1 Note(s) retenue(s)"]);

    const decisions = world.cli
      .filter((call) => call.argv.includes("gate"))
      .map((call) => parseJson(call.stdin ?? "{}"));

    expect(decisions.map((decision) => (isJsonObject(decision) ? decision["decision"] : null))).toEqual([
      "skip",
      "debrief",
    ]);
  });

  test("a classifier that says skip stops the Gate and is journaled", async ($, on) => {
    const world = build(on);
    world.classifyAnswer = "skip";
    await $.session.start(SESSION);
    await world.clock.settle();
    await $.prompt.submit({ text: "Désormais, réponds en français", wait: false, origin: { kind: "composer" } });
    await $.turn.complete({ answer: "ok", durationMs: 10, isAborted: false, turnId: "t-1", reason: "answer" });
    await world.clock.advance(1);
    await world.clock.settle();
    expect(world.forked).toEqual([]);

    const decisions = world.cli
      .filter((call) => call.argv.includes("gate"))
      .map((call) => parseJson(call.stdin ?? "{}"));

    expect(decisions.at(-1)).toMatchObject({ decision: "skip", reason: "classifier-skip" });
  });

  test("a subagent's turn and a pasted report never reach the Gate", async ($, on) => {
    const world = build(on);
    await $.session.start(SESSION);
    await world.clock.settle();
    await $.prompt.submit({
      text: 'Regarde <pasted_content id="1">non, je t\'ai dit de ne jamais faire ça</pasted_content>',
      wait: false,
      origin: { kind: "composer" },
    });
    await $.turn.complete({
      answer: "ok",
      durationMs: 10,
      isAborted: false,
      turnId: "t-2",
      reason: "answer",
      agentId: "a-1",
    });
    await world.clock.settle();
    expect(world.cli.filter((call) => call.argv.includes("gate"))).toHaveLength(0);
    await $.turn.complete({ answer: "ok", durationMs: 10, isAborted: false, turnId: "t-3", reason: "answer" });
    await world.clock.advance(1);
    await world.clock.settle();
    expect(world.classified).toEqual([]);
  });
});

describe("/hindsight", () => {
  test("answers with no text on every verb", async ($, on) => {
    const world = build(on);
    await $.session.start(SESSION);
    await world.clock.settle();

    for (const args of ["", "status", "review", "learn", "handoff", "bogus"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each run must finish before the next starts, as when the human types them one after the other.
      const answer = await $.command.run({ command: "hindsight", args, ...RUN });
      expect(answer).toEqual({});
    }

    await world.clock.settle();
    expect(world.toasts.length).toBeGreaterThanOrEqual(5);
    expect(world.toasts.every((toast) => toast.length > 0)).toBe(true);
  });

  test("a recorded Debrief rewrites the status line", async ($, on) => {
    const world = build(on);
    await $.session.start(SESSION);
    await world.clock.settle();
    expect(world.statuses).toEqual([undefined]);
    world.pendingProposals = 1;
    await $.command.run({ command: "hindsight", args: "debrief", ...RUN });
    await world.clock.settle();
    expect(world.statuses).toEqual([undefined, "1 Proposal en attente · /hindsight review"]);
  });

  test("/hindsight debrief forks without the classifier", async ($, on) => {
    const world = build(on);
    await $.session.start(SESSION);
    await world.clock.settle();
    expect(await $.command.run({ command: "hindsight", args: "debrief", ...RUN })).toEqual({});
    await world.clock.settle();
    expect(world.classified).toEqual([]);
    expect(world.forked).toHaveLength(1);
    expect(cliCommands(world)).toContain("debrief record");
  });
});
