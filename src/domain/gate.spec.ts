import type { ToolUse } from "./facts.ts";
import type { GateState } from "./gate.ts";

import { describe, expect, test } from "bun:test";

import { defaultConfig } from "./config.ts";
import { addHumanText, addToolUses, emptyFacts, markInterrupted } from "./facts.ts";
import { classifierText, cooldownMs, gateBrief, gatePasses, gateSignals, gateSkip } from "./gate.ts";

const use = (tool: string, extra: Partial<ToolUse> = {}): ToolUse => ({
  tool,
  path: null,
  command: null,
  isError: false,
  isRefused: false,
  ...extra,
});

const read = (path: string): ToolUse => use("Read", { path });

const edit = (path: string): ToolUse => use("Edit", { path });

const open: GateState = {
  isInteractive: true,
  agentId: null,
  isAborted: false,
  forkRunning: false,
  repoRoot: "/home/u/proj",
  lastDebriefAt: null,
  debriefsInSession: 0,
  debriefsToday: 0,
  now: 1_000_000,
};

describe("gateSignals", () => {
  test("a plain request followed by the edits asked for scores nothing", () => {
    const facts = addToolUses(addHumanText(emptyFacts, "Ajoute un test pour parse()"), [edit("/p/src/a.ts")]);
    expect(gateSignals(facts)).toEqual({ signals: [], score: 0 });
  });

  test("an exploration of 62 reads scores nothing", () => {
    const reads = Array.from({ length: 62 }, (_, i) => read(`/p/src/f${i}.ts`));
    const facts = addToolUses(addHumanText(emptyFacts, "Explore le dossier src"), reads);
    expect(gatePasses(gateSignals(facts), defaultConfig)).toBe(false);
  });

  test("a correction in a human message weighs 1", () => {
    const facts = addHumanText(addHumanText(emptyFacts, "fais le plan"), "Non, je t'ai dit de ne pas régénérer");
    const { signals, score } = gateSignals(facts);
    expect(signals.map((s) => s.name)).toEqual(["human_marker"]);
    expect(score).toBe(1);
  });

  test("a refused tool, a Rule File edit and a commit add up", () => {
    const facts = addToolUses(emptyFacts, [
      use("Bash", { command: "bun test -u", isError: true, isRefused: true }),
      edit("/p/.claude/rules/tests.md"),
      use("Bash", { command: "git commit -m x" }),
    ]);

    const { signals, score } = gateSignals(facts);
    expect(signals.map((s) => s.name)).toEqual(["tool_refused", "rule_file_edit", "git_commit"]);
    expect(score).toBe(2.5);
  });

  test("three edits or two errors weigh half each", () => {
    const facts = addToolUses(emptyFacts, [
      edit("/p/a.ts"),
      use("Write", { path: "/p/b.ts" }),
      edit("/p/c.ts"),
      use("Bash", { command: "bun test", isError: true }),
      use("Bash", { command: "bun test", isError: true }),
    ]);

    expect(gateSignals(facts).score).toBe(1);
  });

  test("a message after an interrupt weighs 1 and the flag clears", () => {
    const facts = addHumanText(markInterrupted(emptyFacts), "continue mais sans toucher au CI");
    expect(gateSignals(facts).signals.map((s) => s.name)).toContain("after_interrupt");
    expect(facts.afterInterrupt).toBe(false);
  });

  test("a human text is cut at 4000 characters", () => {
    const facts = addHumanText(emptyFacts, "x".repeat(5000));
    expect(facts.humanTexts[0]?.text.length).toBe(4000);
  });
});

describe("gateSkip", () => {
  const facts = addHumanText(emptyFacts, "hello");

  test("direct skips, in order", () => {
    expect(gateSkip({ ...open, isInteractive: false }, facts, defaultConfig)).toBe("non-interactive");
    expect(gateSkip({ ...open, agentId: "a1" }, facts, defaultConfig)).toBe("subagent");
    expect(gateSkip({ ...open, isAborted: true }, facts, defaultConfig)).toBe("turn-aborted");
    expect(gateSkip({ ...open, forkRunning: true }, facts, defaultConfig)).toBe("fork-running");
    expect(gateSkip(open, facts, { ...defaultConfig, excludedRepos: ["/home/u/proj"] })).toBe("repo-excluded");
    expect(gateSkip({ ...open, debriefsToday: 20 }, facts, defaultConfig)).toBe("daily-cap");
    expect(gateSkip(open, facts, defaultConfig)).toBeNull();
  });

  test("the cooldown grows with the session's debriefs and stops at five steps", () => {
    expect(cooldownMs(1, defaultConfig.gate)).toBe(90_000);
    expect(cooldownMs(3, defaultConfig.gate)).toBe(270_000);
    expect(cooldownMs(9, defaultConfig.gate)).toBe(450_000);
    const recent = { ...open, lastDebriefAt: open.now - 60_000, debriefsInSession: 1 };
    expect(gateSkip(recent, facts, defaultConfig)).toBe("cooldown");
    expect(gateSkip({ ...recent, lastDebriefAt: open.now - 100_000 }, facts, defaultConfig)).toBeNull();
  });

  test("a long session of short exchanges does not debrief every turn", () => {
    let now = open.now;
    let debriefs = 0;
    let last: number | null = null;

    for (let turn = 0; turn < 20; turn += 1) {
      now += 30_000;
      const state = { ...open, now, lastDebriefAt: last, debriefsInSession: debriefs };

      if (gateSkip(state, facts, defaultConfig) === null) {
        debriefs += 1;
        last = now;
      }
    }

    expect(debriefs).toBeLessThanOrEqual(4);
  });

  test("a turn with no human message and fewer than three tools is quiet", () => {
    expect(gateSkip(open, addToolUses(emptyFacts, [read("/p/a")]), defaultConfig)).toBe("quiet");
    expect(gateSkip(open, addToolUses(emptyFacts, [read("/a"), read("/b"), read("/c")]), defaultConfig)).toBeNull();
  });
});

describe("gateBrief and classifierText", () => {
  test("the brief names counts and signals, not the messages", () => {
    const facts = addToolUses(addHumanText(emptyFacts, "Non, pas de npm pour ça"), [edit("/p/AGENTS.md")]);
    const brief = gateBrief(gateSignals(facts), facts);
    expect(brief).toContain("1 human message(s)");
    expect(brief).toContain("rule_file_edit");
    expect(brief).not.toContain("pas de npm");
    expect(classifierText(brief, facts)).toContain("- Non, pas de npm pour ça");
  });
});
