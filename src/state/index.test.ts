import type { Decision, Proposal } from "../types.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendDecision,
  createRun,
  defaultStateRoot,
  pendingProposals,
  proposalHistory,
  readCuration,
  readDecisions,
  readExtraction,
  readHeads,
  writeCuration,
  writeExtraction,
  writeHeads,
  writeRunJson,
} from "./index.ts";

let root: string;

beforeEach(async () => {
  root = join(await mkdtemp(join(tmpdir(), "hindsight-state-")), "state");
});

afterEach(async () => {
  await rm(join(root, ".."), { recursive: true, force: true });
});

function proposal(id: string, fingerprint: string): Proposal {
  return {
    id,
    fingerprint,
    kind: "missing",
    title: "Ajouter une règle",
    why: "Trois sessions.",
    lesson: "Build orders with makeOrder() in tests.",
    commitSubject: "Require makeOrder() for orders in tests",
    target: { repoRoot: "/repo", sourcePath: "/repo/AGENTS.md", blobHash: "abc" },
    op: { op: "add", sourcePath: "/repo/AGENTS.md", edits: [{ oldText: "- a", newText: "- a\n- b" }] },
    suggestion: null,
    ruleBulletIds: [],
    prevalence: { sessions: 3, days: 2, repos: 1, firstAt: "2026-10-01T10:00:00Z", lastAt: "2026-10-03T10:00:00Z" },
    evidence: [],
    confidence: "high",
  };
}

function decision(fingerprint: string, verdict: Decision["decision"]): Decision {
  return {
    proposalId: `p-${fingerprint}`,
    fingerprint,
    runId: "r1",
    decision: verdict,
    editedOp: null,
    reason: verdict === "rejected" ? "trop spécifique" : null,
    commit: null,
    at: "2026-10-08T10:00:00Z",
  };
}

describe("state", () => {
  test("defaults to XDG_STATE_HOME", () => {
    expect(defaultStateRoot({ XDG_STATE_HOME: "/x/state" })).toBe("/x/state/hindsight");
  });

  test("creates private directories and files", async () => {
    await createRun(root, "r1");
    await writeRunJson(root, "r1", "proposals.json", []);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "runs", "r1"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "runs", "r1", "proposals.json"))).mode & 0o777).toBe(0o600);
  });

  test("pending proposals exclude decided fingerprints and keep the latest run per fingerprint", async () => {
    await createRun(root, "r1");
    await writeRunJson(root, "r1", "proposals.json", [proposal("p-a", "a"), proposal("p-b", "b")]);
    await createRun(root, "r2");
    await writeRunJson(root, "r2", "proposals.json", [proposal("p-b", "b"), proposal("p-c", "c")]);
    await appendDecision(decision("a", "rejected"), root);

    const pending = await pendingProposals(root);

    expect(pending.map((entry) => [entry.runId, entry.proposal.fingerprint])).toEqual([
      ["r2", "b"],
      ["r2", "c"],
    ]);
    expect((await stat(join(root, "decisions.jsonl"))).mode & 0o777).toBe(0o600);
    const history = await proposalHistory(root);
    expect(history.find((entry) => entry.proposal.fingerprint === "a")?.decision?.decision).toBe("rejected");
  });

  test("decisions round-trip and a corrupt line fails with its line number", async () => {
    await appendDecision(decision("a", "accepted"), root);
    await appendDecision(decision("b", "rejected"), root);
    expect((await readDecisions(root)).map((entry) => entry.decision)).toEqual(["accepted", "rejected"]);

    await Bun.write(join(root, "decisions.jsonl"), `${JSON.stringify(decision("a", "accepted"))}\n{"oops":1}\n`);
    await expect(readDecisions(root)).rejects.toThrow("line 2");
  });

  test("refuses to record a malformed decision or a rejection without a reason", async () => {
    const malformed = { ...decision("a", "accepted"), decision: "maybe" } as unknown as Decision;
    await expect(appendDecision(malformed, root)).rejects.toThrow("malformed decision");
    await expect(appendDecision({ ...decision("b", "rejected"), reason: " " }, root)).rejects.toThrow(
      "malformed decision",
    );
    await expect(appendDecision({ ...decision("c", "rejected"), reason: null }, root)).rejects.toThrow(
      "malformed decision",
    );
  });

  test("the extraction cache hits only on the same session, last uuid and prompt version", async () => {
    const key = { sessionId: "s1", lastUuid: "u9", promptVersion: "v1" };
    await writeExtraction(root, { key, items: [], at: "2026-10-08T10:00:00Z" });
    expect(await readExtraction(root, key)).toEqual([]);
    expect(await readExtraction(root, { ...key, lastUuid: "u10" })).toBeNull();
    expect(await readExtraction(root, { ...key, promptVersion: "v2" })).toBeNull();
    expect(await readExtraction(root, { ...key, sessionId: "s2" })).toBeNull();
  });

  test("the curation cache hits only on the same input hash", async () => {
    await writeCuration(root, { groupKey: "/repo", inputHash: "h1", output: { candidates: [] }, at: "now" });
    expect(await readCuration(root, "/repo", "h1")).toEqual({ candidates: [] });
    expect(await readCuration(root, "/repo", "h2")).toBeNull();
  });

  test("heads round-trip", async () => {
    expect(await readHeads(root)).toEqual({});
    await writeHeads(root, { "/repo": "abc123" });
    expect(await readHeads(root)).toEqual({ "/repo": "abc123" });
  });
});
