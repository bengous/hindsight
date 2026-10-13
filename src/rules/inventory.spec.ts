import type { InventoryEnv } from "./inventory.ts";
import type { RuleFile } from "./types.ts";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { tempDir, tempRepo, writeTree } from "../../fixtures/rules/repo.ts";
import { inventory } from "./inventory.ts";

const project = tempRepo({
  "AGENTS.md": "# Project\n- Keep functions small.\n- Name things plainly.\n",
  "CLAUDE.md": "@AGENTS.md\nAlso see @docs/extra.md and `@docs/not-imported.md`.\n",
  "docs/extra.md": "- Imported rule.\n",
  "docs/not-imported.md": "- Never loaded.\n",
  ".claude/rules/tests.md": '---\npaths:\n  - "src/**/*.test.ts"\n---\n- Tests sit next to code.\n',
  ".claude/rules/always.md": "- Always loaded.\n",
  ".claude/rules/deep/inner.md": "- Recursive rule.\n",
  "pkg/CLAUDE.md": "- Package rule.\n",
  "pkg/.claude/rules/local.md": "- Package local rule.\n",
  ".claude/output-styles/terse.md": "---\nname: terse\n---\n- Answer in one line.\n",
  ".gitignore": "CLAUDE.local.md\nnode_modules/\n",
  "node_modules/dep/CLAUDE.md": "- Vendored, ignored.\n",
});

project.write("CLAUDE.local.md", "- Personal, ignored.\n");

const home = tempDir("home");

writeTree(home, {
  ".claude/CLAUDE.md": "@AGENTS.md\n",
  ".claude/AGENTS.md": "- Global rule one.\n- Global rule two.\n",
  ".claude/rules/global.md": "- A global rule file.\n",
  ".claude/output-styles/plain.md": "---\nname: plain\n---\n- Answer in plain words.\n",
});

const env: InventoryEnv = { home };

afterAll(() => {
  project.cleanup();
  rmSync(home, { recursive: true, force: true });
});

function byLoaded(files: readonly RuleFile[], path: string): RuleFile {
  const file = files.find((candidate) => candidate.loadedPath === path);

  if (file === undefined) {
    throw new Error(`no rule file loaded from ${path}`);
  }

  return file;
}

describe("inventory", () => {
  let files: readonly RuleFile[] = [];
  beforeAll(async () => {
    files = await inventory([project.root], env);
  });

  test("lists root, imported, nested and rules files, and skips ignored ones", () => {
    const loaded = files.map((file) => file.loadedPath.replace(project.root, "P").replace(home, "H")).sort();
    expect(loaded).toEqual([
      "H/.claude/AGENTS.md",
      "H/.claude/CLAUDE.md",
      "H/.claude/output-styles/plain.md",
      "H/.claude/rules/global.md",
      "P/.claude/output-styles/terse.md",
      "P/.claude/rules/always.md",
      "P/.claude/rules/deep/inner.md",
      "P/.claude/rules/tests.md",
      "P/AGENTS.md",
      "P/CLAUDE.md",
      "P/docs/extra.md",
      "P/pkg/.claude/rules/local.md",
      "P/pkg/CLAUDE.md",
    ]);
  });

  test("a global file is edited where the agents load it, with no checkout", () => {
    const agents = byLoaded(files, join(home, ".claude/AGENTS.md"));
    expect(agents.sourcePath).toBe(join(home, ".claude/AGENTS.md"));
    expect(agents.repoRoot).toBeNull();
    expect(agents.scope).toBe("global");
    expect(byLoaded(files, join(home, ".claude/rules/global.md")).repoRoot).toBeNull();
  });

  test("lists output styles as always-loaded rule files of their scope", () => {
    expect(byLoaded(files, join(project.root, ".claude/output-styles/terse.md"))).toMatchObject({
      scope: "repo",
      paths: null,
    });
    const plain = byLoaded(files, join(home, ".claude/output-styles/plain.md"));
    expect([plain.scope, plain.paths, plain.bullets.map((b) => b.text)]).toEqual([
      "global",
      null,
      ["- Answer in plain words."],
    ]);
  });

  test("records scope and loading condition", () => {
    expect(byLoaded(files, join(project.root, "AGENTS.md"))).toMatchObject({ scope: "repo", paths: null });
    expect(byLoaded(files, join(project.root, ".claude/rules/tests.md"))).toMatchObject({
      scope: "repo",
      paths: ["src/**/*.test.ts"],
    });
    expect(byLoaded(files, join(project.root, "pkg/CLAUDE.md"))).toMatchObject({ scope: "path", paths: ["pkg/**"] });
    expect(byLoaded(files, join(project.root, "pkg/.claude/rules/local.md"))).toMatchObject({
      scope: "path",
      paths: ["pkg/**"],
    });
  });

  test("hashes the source with git hash-object", () => {
    const agents = byLoaded(files, join(project.root, "AGENTS.md"));
    expect(agents.blobHash).toBe(project.git("hash-object", "AGENTS.md").trim());
  });

  test("prefixes bullet ids with the repo-relative or home-relative loaded path", () => {
    expect(byLoaded(files, join(project.root, ".claude/rules/tests.md")).bullets[0]?.id).toMatch(
      /^\.claude\/rules\/tests\.md#[0-9a-f]{8}$/,
    );
    expect(byLoaded(files, join(home, ".claude/AGENTS.md")).bullets.map((bullet) => bullet.id.split("#")[0])).toEqual([
      "~/.claude/AGENTS.md",
      "~/.claude/AGENTS.md",
    ]);
  });

  test("rejects a directory that is not a checkout toplevel", async () => {
    const sub = join(project.root, "docs");
    mkdirSync(sub, { recursive: true });
    expect(inventory([sub], env)).rejects.toThrow("not the toplevel");
  });
});
