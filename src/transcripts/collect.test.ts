import type { HumanMessage, SessionDigest } from "../types.ts";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect, resolveOutputStylePath } from "./collect.ts";

const projectsDir = join(import.meta.dir, "../../fixtures/transcripts/projects");
const since = new Date("2026-01-01T00:00:00.000Z");
const repoRootOf = (cwd: string): string | null => (cwd.startsWith("/home/u/proj") ? "/home/u/proj" : null);

const run = (overrides: { since?: Date; includeArchive?: boolean } = {}) =>
  collect({
    projectsDir,
    since: overrides.since ?? since,
    includeArchive: overrides.includeArchive ?? true,
    repoRootOf,
  });

function writeProject(sessionId: string, entries: readonly object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "hindsight-collect-"));
  mkdirSync(join(dir, "-home-u-proj"));
  writeFileSync(
    join(dir, "-home-u-proj", `${sessionId}.jsonl`),
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  return dir;
}

const entry = (uuid: string, extra: object): object => ({
  uuid,
  timestamp: "2026-03-05T10:00:00.000Z",
  sessionId: "s-tmp",
  cwd: "/home/u/proj",
  ...extra,
});

function digest(digests: readonly SessionDigest[], sessionId: string): SessionDigest {
  const found = digests.find((candidate) => candidate.sessionId === sessionId);
  if (found === undefined) throw new Error(`no digest for ${sessionId}`);
  return found;
}

function message(found: SessionDigest, uuid: string): HumanMessage {
  const hit = found.messages.find((candidate) => candidate.uuid === uuid);
  if (hit === undefined) throw new Error(`no message ${uuid} in ${found.sessionId}`);
  return hit;
}

describe("collect", () => {
  test("keeps only human-typed messages inside the window", async () => {
    const { digests } = await run();
    const main = digest(digests, "s-main");
    expect(main.messages.map((m) => m.uuid)).toEqual(["m12", "m18", "m21", "m22"]);
    const texts = digests.flatMap((d) => d.messages.map((m) => m.text)).join("\n");
    expect(texts).not.toContain("always add a rule");
    expect(texts).not.toContain("always update snapshots");
    expect(texts).not.toContain("task-notification");
    expect(texts).not.toContain("Reply with ok");
    expect(texts).not.toContain("being continued");
  });

  test("drops sdk and scratch sessions", async () => {
    const { digests, stats } = await run();
    expect(digests.map((d) => d.sessionId)).not.toContain("s-sdk");
    expect(digests.map((d) => d.sessionId)).not.toContain("s-scratch");
    expect(stats.droppedSessions).toEqual({ sdk: 1, scratch: 1 });
  });

  test("cleans harness blocks and foreign pastes, keeps dictation", async () => {
    const main = digest((await run({ since: new Date("2025-01-01T00:00:00.000Z") })).digests, "s-main");
    expect(message(main, "m01").text).toBe("Ajoute un test pour parse().");
    const pasted = message(main, "m21").text;
    expect(pasted).toContain("je pense que mon idée est meilleure");
    expect(pasted).not.toContain("Report");
    expect(pasted).not.toContain("deploy now");
  });

  test("turns slash-command args into text and skips bare commands", async () => {
    const main = digest((await run()).digests, "s-main");
    expect(message(main, "m22").text).toBe("/handoff désormais résume en français");
    expect(message(main, "m22").markers).toEqual(["standing_instruction"]);
    expect(main.messages.map((m) => m.uuid)).not.toContain("m23");
  });

  test("sets structural and lexical markers", async () => {
    const main = digest((await run()).digests, "s-main");
    expect(message(main, "m12").markers).toEqual(["interrupt_followup", "correction_strong"]);
    expect(message(main, "m18").markers).toEqual(["user_rejected", "plan_rejected"]);
    expect(message(main, "m21").markers).toEqual(["user_rejected", "question_rejected"]);
  });

  test("extracts rejection feedback without the harness note", async () => {
    const main = digest((await run()).digests, "s-main");
    expect(message(main, "m18").text).toBe("Le plan est trop long, fais court.");
    expect(message(main, "m18").precedingAssistant).toBe("Voici le plan.");
  });

  test("keeps the assistant text of the turn before each message", async () => {
    const main = digest((await run()).digests, "s-main");
    expect(message(main, "m12").precedingAssistant).toBe("Je lis le parseur.\n\nLe test échoue, je régénère quand même.");
  });

  test("records the rules in context at each message", async () => {
    const main = digest((await run({ since: new Date("2025-01-01T00:00:00.000Z") })).digests, "s-main");
    expect(message(main, "m01").loadedRulePaths).toEqual([
      "/home/u/.claude/AGENTS.md",
      "/home/u/proj/AGENTS.md",
      "output-style:terse",
    ]);
    expect(message(main, "m12").loadedRulePaths).toContain("/home/u/proj/.claude/rules/src.md");
    expect(main.loadedRules).toContainEqual({
      path: "/home/u/proj/.claude/rules/src.md",
      source: "nested_memory",
      content: "- Parsers return typed results.",
    });
    expect(main.loadedRules).toContainEqual({
      path: "output-style:terse",
      source: "output_style",
      content: "Answer in plain words.",
    });
  });

  test("fills session metadata", async () => {
    const main = digest((await run()).digests, "s-main");
    expect(main.title).toBe("parser work");
    expect(main.repoRoot).toBe("/home/u/proj");
    expect(main.chain).toEqual(["s-main"]);
    expect(main.filesTouched).toEqual(["/home/u/proj/src/parse.ts", "/home/u/proj/src/other.ts"]);
    expect(message(main, "m12").evidenceId).toBe("s-main:m12");
  });

  test("merges a continued-in pair and drops copied entries", async () => {
    const { digests, stats } = await run();
    const merged = digest(digests, "s-old");
    expect(merged.chain).toEqual(["s-old", "s-new"]);
    expect(merged.messages.map((m) => m.evidenceId)).toEqual(["s-old:o01", "s-new:n01"]);
    expect(merged.messages.map((m) => m.sessionId)).toEqual(["s-old", "s-old"]);
    expect(digests.map((d) => d.sessionId)).not.toContain("s-new");
    expect(stats.duplicateEntries).toBe(1);
  });

  test("reads zstd and gzip archives only when asked", async () => {
    const withArchive = await run();
    expect(digest(withArchive.digests, "s-arch").messages[0]?.markers).toEqual(["correction_strong"]);
    expect(digest(withArchive.digests, "s-arch2").messages[0]?.text).toBe("Ajoute un changelog.");
    expect(withArchive.stats.files.archive).toBe(2);
    const withoutArchive = await run({ includeArchive: false });
    expect(withoutArchive.digests.map((d) => d.sessionId)).not.toContain("s-arch");
  });

  test("emits error events from main and subagent files", async () => {
    const { errors } = await run();
    expect(errors.map((e) => [e.evidenceId, e.signature])).toEqual([
      ["s-main:m09", "Bash[bun test] error: expected #, received # at <path>:#"],
      ["s-main:m27", "Edit edit string not found"],
      ["s-main:m28", "hook:PostToolUse:Edit src<path>:#:#: error eslint(no-unused-vars): x is unused"],
      ["s-main:a02", "Bash[rm] hook-block no-rm.ts: refused: recursive delete: rm -rf"],
    ]);
    expect(errors.every((e) => e.repoRoot === "/home/u/proj")).toBe(true);
  });

  test("skips a partial last line and fails on a malformed one elsewhere", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hindsight-collect-"));
    const slug = join(dir, "-home-u-proj");
    mkdirSync(slug);
    const line = JSON.stringify({
      type: "user",
      uuid: "p01",
      timestamp: "2026-03-05T10:00:00.000Z",
      sessionId: "s-partial",
      cwd: "/home/u/proj",
      origin: { kind: "human" },
      message: { role: "user", content: "Bonjour" },
    });
    writeFileSync(join(slug, "s-partial.jsonl"), `${line}\n{"type":"assis`);
    const partial = await collect({ projectsDir: dir, since, includeArchive: false, repoRootOf });
    expect(partial.stats.partialLines).toBe(1);
    expect(partial.stats.humanMessages).toBe(1);
    writeFileSync(join(slug, "s-partial.jsonl"), `{"type":"assis\n${line}\n`);
    await expect(collect({ projectsDir: dir, since, includeArchive: false, repoRootOf })).rejects.toThrow(
      "s-partial.jsonl:1: invalid JSON line",
    );
  });

  test("resolves relative tool paths against the entry cwd", async () => {
    const dir = writeProject("s-tmp", [
      entry("q01", { type: "user", origin: { kind: "human" }, message: { role: "user", content: "Lis le fichier" } }),
      entry("q02", {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "src/rel.ts" } }],
        },
      }),
    ]);
    const { digests } = await collect({ projectsDir: dir, since, includeArchive: false, repoRootOf });
    expect(digests[0]?.filesTouched).toEqual(["/home/u/proj/src/rel.ts"]);
  });

  test("fails on an entry holding several tool results", async () => {
    const block = { type: "tool_result", tool_use_id: "x", is_error: true, content: "boom" };
    const dir = writeProject("s-tmp", [
      entry("q01", { type: "user", message: { role: "user", content: [block, block] } }),
    ]);
    await expect(collect({ projectsDir: dir, since, includeArchive: false, repoRootOf })).rejects.toThrow(
      "entry q01 holds 2 tool results",
    );
  });

  test("fails when the projects dir is missing", async () => {
    await expect(collect({ projectsDir: "/nonexistent/projects", since, includeArchive: false })).rejects.toThrow(
      "projects dir not found",
    );
  });
});

describe("resolveOutputStylePath", () => {
  test("prefers the first dir holding the style file, else names the style", () => {
    const project = mkdtempSync(join(tmpdir(), "hindsight-style-"));
    const user = mkdtempSync(join(tmpdir(), "hindsight-style-"));
    writeFileSync(join(user, "terse.md"), "Answer in plain words.");
    expect(resolveOutputStylePath("terse", [project, user])).toBe(join(user, "terse.md"));
    expect(resolveOutputStylePath("Explanatory", [project, user])).toBe("output-style:Explanatory");
  });
});
