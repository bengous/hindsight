import type { RuleFile } from "./types.ts";

import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { tempDir, writeTree } from "../../fixtures/rules/repo.ts";
import { expandBraces, globMatcher, matchesOnDisk, ruleAppliesTo } from "./glob.ts";

describe("expandBraces", () => {
  test("expands nested and empty alternatives", () => {
    expect(expandBraces("a/{b,c/{d,e}}")).toEqual(["a/b", "a/c/d", "a/c/e"]);
    expect(expandBraces("x{,/**}")).toEqual(["x", "x/**"]);
  });

  test("leaves an unbalanced or single-alternative brace alone", () => {
    expect(expandBraces("a/{b")).toEqual(["a/{b"]);
    expect(expandBraces("a/{b}")).toEqual(["a/{b}"]);
  });
});

describe("globMatcher", () => {
  test("matches deep files through an empty brace alternative", () => {
    const matches = globMatcher("dot_config/{a,b}{,/**}");
    expect(matches("dot_config/b/x/y.json")).toBe(true);
    expect(matches("dot_config/c/x.json")).toBe(false);
  });
});

describe("matchesOnDisk", () => {
  const dir = tempDir("glob");
  writeTree(dir, { "pages/[lang]/phone/a.astro": "", "pages/en/b.astro": "" });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("finds a file below the literal prefix", () => {
    expect(matchesOnDisk(dir, "pages/*/b.astro")).toBe(true);
  });

  test("reads [lang] as a bracket expression, as Claude Code does", () => {
    expect(matchesOnDisk(dir, "pages/[lang]/phone/**")).toBe(false);
    expect(matchesOnDisk(dir, String.raw`pages/\[lang]/phone/**`)).toBe(true);
  });
});

describe("ruleAppliesTo", () => {
  const rule = (sourcePath: string, scope: RuleFile["scope"], paths: readonly string[] | null): RuleFile => ({
    loadedPath: sourcePath,
    sourcePath,
    repoRoot: scope === "global" ? "/dots" : "/repo",
    scope,
    blobHash: "0",
    paths,
    bullets: [],
  });

  test("an always-loaded rule applies everywhere", () => {
    expect(ruleAppliesTo(rule("/repo/AGENTS.md", "repo", null), "/elsewhere/x.ts", "/repo")).toBe(true);
  });

  test("a root rule matches repo-relative paths", () => {
    const file = rule("/repo/.claude/rules/t.md", "repo", ["src/**/*.{ts,tsx}"]);
    expect(ruleAppliesTo(file, "/repo/src/a/b.tsx", "/repo")).toBe(true);
    expect(ruleAppliesTo(file, "/repo/lib/b.ts", "/repo")).toBe(false);
    expect(ruleAppliesTo(file, "/other/src/b.ts", "/repo")).toBe(false);
  });

  test("a nested rule matches relative to its owner directory or to the repo", () => {
    const file = rule("/repo/apps/web/.claude/rules/t.md", "path", ["src/**"]);
    expect(ruleAppliesTo(file, "/repo/apps/web/src/x.ts", "/repo")).toBe(true);
    expect(ruleAppliesTo(file, "/repo/src/x.ts", "/repo")).toBe(true);
    expect(ruleAppliesTo(file, "/repo/apps/api/lib/x.ts", "/repo")).toBe(false);
  });

  test("a global path-scoped rule matches relative to the session's project", () => {
    const file = rule("/dots/dot_claude/rules/ts.md", "global", ["**/*.ts"]);
    expect(ruleAppliesTo(file, "/work/app/src/a.ts", "/work/app")).toBe(true);
    expect(ruleAppliesTo(file, "/work/app/src/a.ts", null)).toBe(false);
  });
});
