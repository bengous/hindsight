import type { DeltaOp } from "../types.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tempRepo, type TempRepo } from "../../fixtures/rules/repo.ts";
import { applyDelta, type ApplyRequest, type TargetLookup } from "./apply.ts";

const RULES = "# Rules\n- Keep functions small.\n- Name things plainly.\n";
const noTargets: TargetLookup = async () => [];
const repos: TempRepo[] = [];

function fixture(): TempRepo {
  const repo = tempRepo({ "AGENTS.md": RULES, "src/app.ts": "export {};\n" });
  repos.push(repo);
  return repo;
}

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
});

function request(
  repo: TempRepo,
  op: Partial<DeltaOp> & Pick<DeltaOp, "edits">,
  overrides: Partial<ApplyRequest> = {},
): ApplyRequest {
  return {
    runId: "run-1",
    proposalId: "p-1",
    repoRoot: repo.root,
    blobHash: repo.git("hash-object", "AGENTS.md").trim(),
    op: { op: "update", sourcePath: join(repo.root, "AGENTS.md"), ...op },
    deployedPath: null,
    subject: "Prefer the order factory in tests",
    lesson: "Build orders in tests with the order factory.",
    prevalence: { sessions: 5, days: 4, repos: 1, firstAt: "2026-09-14T08:00:00Z", lastAt: "2026-10-06T16:00:00Z" },
    excerpts: ["utilise la fabrique makeOrder, pas un objet"],
    ...overrides,
  };
}

const rename = { oldText: "- Name things plainly.", newText: "- Name things after the domain." };

describe("applyDelta", () => {
  test("commits only the edited file, with run and prevalence in the message", async () => {
    const repo = fixture();
    repo.write("src/app.ts", "export const dirty = 1;\n");
    repo.write("staged.txt", "staged\n");
    repo.git("add", "staged.txt");

    const result = await applyDelta(request(repo, { edits: [rename] }), async () => ["/home/u/.claude/AGENTS.md"]);

    expect(result.kind).toBe("committed");
    if (result.kind !== "committed") return;
    expect(result.commit).toBe(repo.git("rev-parse", "HEAD").trim());
    expect(result.followUp).toEqual(["chezmoi apply /home/u/.claude/AGENTS.md"]);
    expect(repo.git("show", "--name-only", "--format=", "HEAD").trim()).toBe("AGENTS.md");
    expect(readFileSync(join(repo.root, "AGENTS.md"), "utf8")).toContain("- Name things after the domain.");
    const message = repo.git("log", "-1", "--format=%B");
    expect(message).toContain("Prefer the order factory in tests");
    expect(message.trimEnd()).toBe(
      [
        "Prefer the order factory in tests",
        "",
        "Build orders in tests with the order factory.",
        "",
        "Evidence: 5 sessions, 4 days, 1 repo",
        "hindsight run run-1, proposal p-1",
      ].join("\n"),
    );
    expect(repo.git("status", "--porcelain").split("\n").filter(Boolean).sort()).toEqual([
      " M src/app.ts",
      "A  staged.txt",
    ]);
  });

  test("refuses when the file changed since the draft", async () => {
    const repo = fixture();
    const drafted = request(repo, { edits: [rename] });
    repo.write("AGENTS.md", `${RULES}- Added later.\n`);
    repo.git("commit", "-qam", "later");
    const result = await applyDelta(drafted, noTargets);
    expect(result).toMatchObject({ kind: "refused", reason: "hash-mismatch" });
  });

  test("refuses an old text found zero or several times, and leaves the file alone", async () => {
    const repo = fixture();
    expect(
      await applyDelta(request(repo, { edits: [{ oldText: "- Absent rule.", newText: "x" }] }), noTargets),
    ).toMatchObject({ kind: "refused", reason: "old-text-missing" });
    expect(await applyDelta(request(repo, { edits: [{ oldText: "- ", newText: "* " }] }), noTargets)).toMatchObject({
      kind: "refused",
      reason: "old-text-ambiguous",
    });
    expect(readFileSync(join(repo.root, "AGENTS.md"), "utf8")).toBe(RULES);
  });

  test("refuses without a checkout, outside it, or on a dirty file", async () => {
    const repo = fixture();
    expect(await applyDelta(request(repo, { edits: [rename] }, { repoRoot: null }), noTargets)).toMatchObject({
      reason: "no-checkout",
    });
    expect(await applyDelta(request(repo, { edits: [rename], sourcePath: "/etc/hostname" }), noTargets)).toMatchObject({
      reason: "outside-checkout",
    });
    const drafted = request(repo, { edits: [rename] });
    repo.write("AGENTS.md", `${RULES}\n`);
    expect(
      await applyDelta({ ...drafted, blobHash: repo.git("hash-object", "AGENTS.md").trim() }, noTargets),
    ).toMatchObject({
      reason: "dirty-file",
    });
  });

  test("refuses a commit message that carries an evidence quote", async () => {
    const repo = fixture();
    const leaking = request(
      repo,
      { edits: [rename] },
      { lesson: "User said: utilise la fabrique makeOrder, pas un objet écrit." },
    );
    expect(await applyDelta(leaking, noTargets)).toMatchObject({ reason: "excerpt-in-message" });
  });

  test("creates a new rule file, and refuses when it already exists", async () => {
    const repo = fixture();
    const create = request(
      repo,
      {
        op: "add",
        sourcePath: join(repo.root, ".claude/rules/tests.md"),
        edits: [{ oldText: "", newText: "- New.\n" }],
      },
      { blobHash: null },
    );
    expect(await applyDelta(create, noTargets)).toMatchObject({ kind: "committed" });
    expect(repo.git("show", "--name-only", "--format=", "HEAD").trim()).toBe(".claude/rules/tests.md");
    expect(await applyDelta(create, noTargets)).toMatchObject({ reason: "file-exists" });
  });

  test("restores the file when a hook rejects the commit", async () => {
    const repo = fixture();
    const hook = join(repo.hooks, "pre-commit");
    await Bun.write(hook, "#!/bin/sh\necho 'lint: rule file rejected' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const result = await applyDelta(request(repo, { edits: [rename] }), noTargets);
    expect(result).toMatchObject({ kind: "refused", reason: "commit-rejected" });
    if (result.kind === "refused") expect(result.detail).toContain("lint: rule file rejected");
    expect(readFileSync(join(repo.root, "AGENTS.md"), "utf8")).toBe(RULES);
    expect(repo.git("status", "--porcelain")).toBe("");

    const create = request(
      repo,
      { op: "add", sourcePath: join(repo.root, "NEW.md"), edits: [{ oldText: "", newText: "- New.\n" }] },
      { blobHash: null },
    );
    expect(await applyDelta(create, noTargets)).toMatchObject({ reason: "commit-rejected" });
    expect(existsSync(join(repo.root, "NEW.md"))).toBe(false);
    expect(repo.git("status", "--porcelain")).toBe("");
  });
});
