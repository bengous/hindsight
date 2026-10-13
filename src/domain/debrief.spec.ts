import { describe, expect, test } from "bun:test";
import { debriefPrompt, parseDebrief } from "./debrief.ts";

const valid = {
  steers: [{ quote: "pas de npm pour ça", lesson: "Install packages with pnpm.", habit: true }],
  observations: [
    { question: 3, tool: "Bash", excerpt: "bun run check:full", lesson: "Name the check.", rulePath: null },
  ],
  staleRules: [
    {
      editedPath: "/p/package.json",
      editedExcerpt: '"check": "bun run lint"',
      ruleFile: "/p/AGENTS.md",
      oldText: "Run `bun run check:full`.",
      newText: "Run `bun run check`.",
      lesson: "Name the script that exists.",
    },
  ],
};

describe("debriefPrompt", () => {
  test("carries the brief, the five questions and the answer shape", () => {
    const prompt = debriefPrompt("Signals: human_marker");
    expect(prompt).toContain("Signals: human_marker");
    for (const n of ["1.", "2.", "3.", "4.", "5."]) expect(prompt).toContain(`\n${n} `);
    expect(prompt).toContain("Call no tool");
    expect(prompt).toContain('"staleRules"');
    expect(prompt).toContain("in English");
  });
});

describe("parseDebrief", () => {
  test("reads a fenced answer", () => {
    const result = parseDebrief(`Here it is:\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.notes.steers[0]?.habit).toBe(true);
      expect(result.notes.observations[0]?.question).toBe(3);
      expect(result.notes.staleRules[0]?.ruleFile).toBe("/p/AGENTS.md");
    }
  });

  test("reads bare JSON and treats a missing list as empty", () => {
    const result = parseDebrief('{"steers": []}');
    expect(result).toEqual({ ok: true, notes: { steers: [], observations: [], staleRules: [] } });
  });

  test("rejects an answer without JSON", () => {
    expect(parseDebrief("Nothing to report.")).toMatchObject({ ok: false, reason: "no-json" });
  });

  test("rejects a truncated answer without throwing", () => {
    const cut = JSON.stringify(valid).slice(0, 80);
    expect(parseDebrief(`\`\`\`json\n${cut}`)).toMatchObject({ ok: false, reason: "no-json" });
    expect(parseDebrief(`${cut}}`)).toMatchObject({ ok: false, reason: "invalid-json" });
  });

  test("rejects an item that lacks a field or has a bad question", () => {
    expect(parseDebrief(JSON.stringify({ steers: [{ quote: "x" }] }))).toMatchObject({
      ok: false,
      reason: "bad-shape",
      detail: "steers[0] lacks a required field",
    });
    expect(
      parseDebrief(JSON.stringify({ observations: [{ question: 5, tool: "Bash", excerpt: "x", lesson: "y" }] })),
    ).toMatchObject({ ok: false, reason: "bad-shape" });
    expect(parseDebrief(JSON.stringify({ steers: {} }))).toMatchObject({ ok: false, reason: "bad-shape" });
    expect(parseDebrief("[1,2]").ok).toBe(false);
  });
});
