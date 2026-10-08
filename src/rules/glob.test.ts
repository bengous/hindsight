import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tempDir, writeTree } from "../../fixtures/rules/repo.ts";
import { expandBraces, globMatcher, matchesOnDisk } from "./glob.ts";

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
    expect(matchesOnDisk(dir, "pages/\\[lang]/phone/**")).toBe(true);
  });
});
