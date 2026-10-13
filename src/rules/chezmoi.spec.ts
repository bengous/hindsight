import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tempDir, writeTree } from "../../fixtures/rules/repo.ts";
import { chezmoiResolver, unwrapInclude } from "./chezmoi.ts";

describe("unwrapInclude", () => {
  test("returns the included path of an include-only template", () => {
    expect(unwrapInclude('{{ include "dot_agents/AGENTS.md" }}\n')).toBe("dot_agents/AGENTS.md");
    expect(unwrapInclude('{{- include "a/b.md" -}}')).toBe("a/b.md");
  });

  test("returns null for any other template", () => {
    expect(unwrapInclude('# Title\n{{ include "x.md" }}')).toBeNull();
    expect(unwrapInclude("{{ if .work }}x{{ end }}")).toBeNull();
  });
});

describe("chezmoiResolver", () => {
  const dir = tempDir("chezmoi");
  const home = join(dir, "home");
  const source = join(dir, "source");
  const originalPath = process.env["PATH"];

  beforeAll(() => {
    writeTree(dir, {
      "home/.keep": "",
      "source/dot_agents/AGENTS.md": "- rule\n",
      "source/dot_claude/AGENTS.md.tmpl": '{{ include "dot_agents/AGENTS.md" }}\n',
      "source/dot_claude/CLAUDE.md": "@AGENTS.md\n",
      "source/dot_claude/output-styles/plain.md.tmpl":
        '---\nname: plain\n---\n- Style rule.\n{{ template "style-core.md" . }}\n{{ include "shared/extra.md" }}\n{{ template "missing.md" . }}\n',
      "source/.chezmoitemplates/style-core.md": "- Answer in plain words.\n",
      "source/shared/extra.md": "- Extra rule.\n",
      "bin/chezmoi": [
        "#!/bin/sh",
        'if [ "$1" != source-path ]; then exit 2; fi',
        `if [ -z "$2" ]; then echo "${source}"; exit 0; fi`,
        `case "$2" in`,
        `  "${home}/.claude/AGENTS.md") echo "${source}/dot_claude/AGENTS.md.tmpl" ;;`,
        `  "${home}/.claude/CLAUDE.md") echo "${source}/dot_claude/CLAUDE.md" ;;`,
        `  "${home}/.claude/output-styles/plain.md") echo "${source}/dot_claude/output-styles/plain.md.tmpl" ;;`,
        `  "${home}/slow.md") sleep 5 ;;`,
        '  *) echo "chezmoi: $2: not managed" >&2; exit 1 ;;',
        "esac",
      ].join("\n"),
    });
    chmodSync(join(dir, "bin/chezmoi"), 0o755);
    process.env["PATH"] = `${join(dir, "bin")}:${originalPath ?? ""}`;
  });

  afterAll(() => {
    process.env["PATH"] = originalPath;
    rmSync(dir, { recursive: true, force: true });
  });

  test("unwraps an include-only template to the included source", async () => {
    const resolve = chezmoiResolver({ home, timeoutMs: 2000 });
    expect(await resolve(join(home, ".claude/AGENTS.md"))).toEqual([join(source, "dot_agents/AGENTS.md")]);
    expect(await resolve(join(home, ".claude/CLAUDE.md"))).toEqual([join(source, "dot_claude/CLAUDE.md")]);
  });

  test("adds the existing files a template pulls in with template or include", async () => {
    const resolve = chezmoiResolver({ home, timeoutMs: 2000 });
    expect(await resolve(join(home, ".claude/output-styles/plain.md"))).toEqual([
      join(source, "dot_claude/output-styles/plain.md.tmpl"),
      join(source, ".chezmoitemplates/style-core.md"),
      join(source, "shared/extra.md"),
    ]);
  });

  test("keeps an unmanaged file as its own source", async () => {
    const resolve = chezmoiResolver({ home, timeoutMs: 2000 });
    expect(await resolve(join(home, "other.md"))).toEqual([join(home, "other.md")]);
  });

  test("fails on a timeout instead of guessing", async () => {
    const resolve = chezmoiResolver({ home, timeoutMs: 200 });
    expect(resolve(join(home, "slow.md"))).rejects.toThrow("timed out");
  });
});
