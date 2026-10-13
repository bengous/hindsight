import { describe, expect, test } from "bun:test";

import { bulletAt, codeSpans, frontmatterPaths, importTargets, ruleBullets } from "./markdown.ts";

describe("frontmatterPaths", () => {
  test("reads a YAML list", () => {
    expect(frontmatterPaths('---\npaths:\n  - "src/**/*.ts"\n  - lib/*.ts\n---\n- rule')).toEqual([
      "src/**/*.ts",
      "lib/*.ts",
    ]);
  });

  test("splits a comma-separated string outside braces", () => {
    expect(frontmatterPaths("---\npaths: src/**/*.{css,astro}, docs/*.md\n---\n")).toEqual([
      "src/**/*.{css,astro}",
      "docs/*.md",
    ]);
  });

  test("treats unparsable YAML and a missing field as always loaded", () => {
    expect(frontmatterPaths("---\npaths: [unclosed\n---\n")).toBeNull();
    expect(frontmatterPaths("---\ndescription: x\n---\n")).toBeNull();
    expect(frontmatterPaths("- no frontmatter")).toBeNull();
  });
});

describe("ruleBullets", () => {
  const text = [
    "---",
    "paths: x/**",
    "---",
    "# Title",
    "- First rule",
    "  continues here.",
    "  - Nested rule",
    "",
    "```",
    "- not a rule",
    "```",
    "1. Numbered rule",
  ].join("\n");

  test("keeps list items verbatim with their continuation lines", () => {
    expect(ruleBullets(text, "f.md").map((bullet) => [bullet.line, bullet.text])).toEqual([
      [5, "- First rule\n  continues here."],
      [7, "  - Nested rule"],
      [12, "1. Numbered rule"],
    ]);
  });

  test("ids survive a line move and a whitespace change", () => {
    const moved = ruleBullets("intro\n\n*   Numbered   rule", "f.md");
    const original = ruleBullets(text, "f.md").find((bullet) => bullet.text === "1. Numbered rule");
    expect(moved[0]?.id).toBe(original?.id ?? "");
    expect(original?.id).toMatch(/^f\.md#[0-9a-f]{8}$/);
  });

  test("suffixes a duplicate bullet", () => {
    const ids = ruleBullets("- same\n- same", "f.md").map((bullet) => bullet.id);
    expect(ids[1]).toBe(`${ids[0]}~2`);
  });

  test("maps a line back to its bullet", () => {
    const bullets = ruleBullets(text, "f.md");
    expect(bulletAt(bullets, 6)?.line).toBe(5);
    expect(bulletAt(bullets, 4)).toBeNull();
  });
});

describe("importTargets", () => {
  test("follows prose imports and skips code", () => {
    const text = "@AGENTS.md\nSee @docs/a\\ b.md, and `@not-this.md`.\nmail me@example.com\n```\n@nor-this.md\n```";
    expect(importTargets(text)).toEqual(["AGENTS.md", "docs/a b.md"]);
  });
});

describe("codeSpans", () => {
  test("lists inline code outside fences with its line", () => {
    expect(codeSpans("- use `src/a.ts` and ``b c``\n```\n`x`\n```")).toEqual([
      { line: 1, code: "src/a.ts" },
      { line: 1, code: "b c" },
    ]);
  });
});
