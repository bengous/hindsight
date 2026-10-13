import type { TempRepo } from "../../fixtures/rules/repo.ts";
import type { ApplyRequest, TextEdit } from "./apply.ts";

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { tempDir, tempRepo } from "../../fixtures/rules/repo.ts";
import { applyChange } from "./apply.ts";

const RULES = "# Rules\n- Keep functions small.\n- Name things plainly.\n";

const repos: TempRepo[] = [];

const dirs: string[] = [];

function fixture(): TempRepo {
  const repo = tempRepo({ "AGENTS.md": RULES, "src/app.ts": "export {};\n" });
  repos.push(repo);

  return repo;
}

afterEach(() => {
  for (const repo of repos.splice(0)) {
    repo.cleanup();
  }

  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function request(repo: TempRepo, edits: readonly TextEdit[], overrides: Partial<ApplyRequest> = {}): ApplyRequest {
  return {
    proposalId: "p-1",
    targetPath: join(repo.root, "AGENTS.md"),
    repoRoot: repo.root,
    edits,
    subject: "Prefer the order factory in tests",
    lesson: "Build orders in tests with the order factory.",
    prevalence: { sessions: 5, days: 4, repos: 1, firstAt: "2026-09-14T08:00:00Z", lastAt: "2026-10-06T16:00:00Z" },
    excerpts: ["utilise la fabrique makeOrder, pas un objet"],
    ...overrides,
  };
}

const rename = { oldText: "- Name things plainly.", newText: "- Name things after the domain." };

describe("applyChange in a checkout", () => {
  test("commits only the edited file, with the lesson and the evidence counts in the message", async () => {
    const repo = fixture();
    repo.write("src/app.ts", "export const dirty = 1;\n");
    repo.write("staged.txt", "staged\n");
    repo.git("add", "staged.txt");
    const result = await applyChange(request(repo, [rename]));
    expect(result.kind).toBe("committed");

    if (result.kind !== "committed") {
      return;
    }

    expect(result.commit).toBe(repo.git("rev-parse", "HEAD").trim());
    expect(repo.git("show", "--name-only", "--format=", "HEAD").trim()).toBe("AGENTS.md");
    expect(readFileSync(join(repo.root, "AGENTS.md"), "utf8")).toContain("- Name things after the domain.");
    expect(repo.git("log", "-1", "--format=%B").trimEnd()).toBe(
      [
        "Prefer the order factory in tests",
        "",
        "Build orders in tests with the order factory.",
        "",
        "Evidence: 5 sessions, 4 days, 1 repo",
        "hindsight proposal p-1",
      ].join("\n"),
    );
    expect(repo.git("status", "--porcelain").split("\n").filter(Boolean).toSorted()).toEqual([
      " M src/app.ts",
      "A  staged.txt",
    ]);
  });

  test("applies on a file that changed since the Proposal when the old text still matches once", async () => {
    const repo = fixture();
    repo.write("AGENTS.md", `${RULES}- Added later.\n`);
    repo.git("commit", "-qam", "later");
    expect(await applyChange(request(repo, [rename]))).toMatchObject({ kind: "committed" });
    expect(readFileSync(join(repo.root, "AGENTS.md"), "utf8")).toBe(
      "# Rules\n- Keep functions small.\n- Name things after the domain.\n- Added later.\n",
    );
  });

  test("refuses an old text found zero or several times, overlapping matches included, and leaves the file alone", async () => {
    const repo = fixture();
    expect(await applyChange(request(repo, [{ oldText: "- Absent rule.", newText: "x" }]))).toMatchObject({
      reason: "old-text-missing",
    });
    expect(await applyChange(request(repo, [{ oldText: "- ", newText: "* " }]))).toMatchObject({
      reason: "old-text-ambiguous",
    });
    expect(readFileSync(join(repo.root, "AGENTS.md"), "utf8")).toBe(RULES);
    repo.write("AGENTS.md", "- Use aaa.\n");
    repo.git("commit", "-qam", "triple");
    expect(await applyChange(request(repo, [{ oldText: "aa", newText: "a" }]))).toMatchObject({
      reason: "old-text-ambiguous",
    });
  });

  test("states the evidence of a Prune finding without sessions", async () => {
    const repo = fixture();
    const zero = { sessions: 0, days: 0, repos: 0, firstAt: "2026-10-08T00:00:00Z", lastAt: "2026-10-08T00:00:00Z" };
    await applyChange(request(repo, [rename], { prevalence: zero }));
    expect(repo.git("log", "-1", "--format=%B")).toContain("Evidence: deterministic rule scan\n");
  });

  test("refuses outside the checkout, a dirty file, a quote in the message, and a bad edit list", async () => {
    const repo = fixture();
    expect(await applyChange(request(repo, [rename], { targetPath: "/etc/hostname" }))).toMatchObject({
      reason: "outside-checkout",
    });
    expect(
      await applyChange(
        request(repo, [rename], { lesson: "User said: utilise la fabrique makeOrder, pas un objet écrit." }),
      ),
    ).toMatchObject({ reason: "excerpt-in-message" });
    expect(await applyChange(request(repo, []))).toMatchObject({ reason: "invalid-edit" });
    repo.write("AGENTS.md", `${RULES}\n`);
    expect(await applyChange(request(repo, [rename]))).toMatchObject({ reason: "dirty-file" });
  });

  test("creates a new rule file, and refuses when it already exists", async () => {
    const repo = fixture();

    const create = request(repo, [{ oldText: "", newText: "- New.\n" }], {
      targetPath: join(repo.root, ".claude/rules/tests.md"),
    });

    expect(await applyChange(create)).toMatchObject({ kind: "committed" });
    expect(repo.git("show", "--name-only", "--format=", "HEAD").trim()).toBe(".claude/rules/tests.md");
    expect(await applyChange(create)).toMatchObject({ reason: "file-exists" });
  });

  test("restores the file when a hook rejects the commit", async () => {
    const repo = fixture();
    const hook = join(repo.hooks, "pre-commit");
    await Bun.write(hook, "#!/bin/sh\necho 'lint: rule file rejected' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const result = await applyChange(request(repo, [rename]));
    expect(result).toMatchObject({ kind: "refused", reason: "commit-rejected" });

    if (result.kind === "refused") {
      expect(result.detail).toContain("lint: rule file rejected");
    }

    expect(readFileSync(join(repo.root, "AGENTS.md"), "utf8")).toBe(RULES);
    expect(repo.git("status", "--porcelain")).toBe("");
    const create = request(repo, [{ oldText: "", newText: "- New.\n" }], { targetPath: join(repo.root, "NEW.md") });
    expect(await applyChange(create)).toMatchObject({ reason: "commit-rejected" });
    expect(existsSync(join(repo.root, "NEW.md"))).toBe(false);
    expect(repo.git("status", "--porcelain")).toBe("");
  });
});

describe("applyChange on a global Rule File", () => {
  test("writes the file where the agents load it, with no commit", async () => {
    const home = tempDir("home");
    dirs.push(home);
    mkdirSync(join(home, ".claude"));
    const target = join(home, ".claude/AGENTS.md");
    await Bun.write(target, RULES);
    const repo = fixture();
    expect(await applyChange(request(repo, [rename], { repoRoot: null, targetPath: target }))).toEqual({
      kind: "written",
      path: target,
    });
    expect(readFileSync(target, "utf8")).toContain("- Name things after the domain.");
    expect(await applyChange(request(repo, [rename], { repoRoot: null, targetPath: target }))).toMatchObject({
      reason: "old-text-missing",
    });
    expect(
      await applyChange(request(repo, [rename], { repoRoot: null, targetPath: join(home, "nope.md") })),
    ).toMatchObject({ reason: "file-missing" });
  });
});
