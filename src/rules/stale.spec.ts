import type { RuleFile, StaleFinding } from "./types.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tempDir, tempRepo } from "../../fixtures/rules/repo.ts";
import { inventory } from "./inventory.ts";
import { staleScan } from "./stale.ts";

const repo = tempRepo({
  "package.json": JSON.stringify({ scripts: { build: "true", test: "true", "check:fast": "true" } }),
  "src/app.ts": "",
  "lib/deep/x.ts": "",
  "src/pages/[lang]/index.astro": "",
  "docs/adr/0001-first.md": "",
  "web/package.json": JSON.stringify({ scripts: { dev: "true" } }),
  "web/src/main.ts": "",
  ".gitignore": "dist/\n",
  ".claude/rules/alive.md": "---\npaths: src/**/*.ts, lib{,/**}\n---\n- Alive glob.\n",
  ".claude/rules/dead.md": "---\npaths:\n  - legacy/**\n---\n- Dead glob.\n",
  ".claude/rules/bracket.md": "---\npaths:\n  - src/pages/[lang]/**\n---\n- Bracket glob.\n",
  "web/.claude/rules/local.md": "---\npaths:\n  - src/**/*.ts\n---\n- Relative to web/.\n",
  "AGENTS.md": [
    "- Entry point is `src/app.ts:12`.",
    "- The old helper lives in `src/helpers/old.ts`.",
    "- Fork of `openai/codex`, output in `dist/bundle.js`, runtime state in `src/cache/`.",
    "- Decisions start at `docs/adr/0001`.",
    "- Run `bun run build`, `bun run check:{fast,full}` and `npm run deploy`.",
    "- Run `bun run src/app.ts`, `npm run server:start|stop`.",
    "",
  ].join("\n"),
  "web/AGENTS.md": "- From the root, `bun run test`; here, `bun run dev` and `bun run storybook`.\n",
});

const home = tempDir("home");

let files: readonly RuleFile[] = [];
let findings: readonly StaleFinding[] = [];

beforeAll(async () => {
  files = await inventory([repo.root], { home });
  findings = await staleScan(files);
});

afterAll(() => {
  repo.cleanup();
  rmSync(home, { recursive: true, force: true });
});

function details(reason: StaleFinding["reason"]): readonly string[] {
  return findings
    .filter((finding) => finding.reason === reason)
    .map((finding) => finding.detail)
    .sort();
}

describe("staleScan", () => {
  test("reports globs that match no file, reading [ as a bracket expression", () => {
    expect(details("dead-glob")).toEqual(["legacy/**", "src/pages/[lang]/**"]);
  });

  test("reports a cited repo path that is gone, and nothing ambiguous", () => {
    expect(details("missing-path")).toEqual(["src/helpers/old.ts"]);
  });

  test("ties a missing path to its bullet", () => {
    const missing = findings.find((finding) => finding.reason === "missing-path");
    const agents = files.find((file) => file.loadedPath === `${repo.root}/AGENTS.md`);
    expect(missing?.bulletId).toBe(agents?.bullets[1]?.id ?? "");
  });

  test("reports scripts missing from every package.json up to the root", () => {
    expect(details("missing-command")).toEqual(["bun run check:full", "bun run storybook", "npm run deploy"]);
  });

  test("gives stable ids", async () => {
    const again = await staleScan(files);
    expect(again.map((finding) => finding.id).sort()).toEqual(findings.map((finding) => finding.id).sort());
    expect(findings[0]?.id).toMatch(/^[0-9a-f]{10}$/);
  });

  test("skips global files", async () => {
    const global = files.map((file): RuleFile => ({ ...file, scope: "global" }));
    expect(await staleScan(global)).toEqual([]);
  });
});
