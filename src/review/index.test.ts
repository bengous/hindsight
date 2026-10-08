import type { PendingProposal } from "../state/index.ts";
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { mockProposals } from "../../fixtures/review/proposals.ts";
import { tempDir } from "../../fixtures/rules/repo.ts";
import { createRun, writeRunLines } from "../state/index.ts";
import { evidenceTexts } from "./index.ts";

describe("evidenceTexts", () => {
  const base = tempDir("review-index");
  const stateRoot = join(base, "state");
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  test("merges the stored message texts of every run that has a pending card", async () => {
    const [first, second] = mockProposals;
    if (first === undefined || second === undefined) throw new Error("fixture mockProposals too short");
    await createRun(stateRoot, "run-a");
    await createRun(stateRoot, "run-b");
    await createRun(stateRoot, "run-old");
    await writeRunLines(stateRoot, "run-a", "evidence.jsonl", [{ evidenceId: "s-001:u-01", text: "message a" }]);
    await writeRunLines(stateRoot, "run-b", "evidence.jsonl", [{ evidenceId: "s-006:u-03", text: "message b" }]);
    await writeRunLines(stateRoot, "run-old", "evidence.jsonl", [{ evidenceId: "s-x:u-x", text: "not pending" }]);
    const pending: readonly PendingProposal[] = [
      { runId: "run-a", proposal: first },
      { runId: "run-b", proposal: second },
    ];
    expect(await evidenceTexts(stateRoot)(pending)).toEqual(
      new Map([
        ["s-001:u-01", "message a"],
        ["s-006:u-03", "message b"],
      ]),
    );
  });

  test("gives an empty map for a run written without evidence texts", async () => {
    const [first] = mockProposals;
    if (first === undefined) throw new Error("fixture mockProposals is empty");
    await createRun(stateRoot, "run-bare");
    expect(await evidenceTexts(stateRoot)([{ runId: "run-bare", proposal: first }])).toEqual(new Map());
  });
});
