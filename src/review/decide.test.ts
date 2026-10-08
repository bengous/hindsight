import type { ApplyRequest, ApplyResult } from "../rules/apply.ts";
import type { PendingProposal } from "../state/index.ts";
import type { Decision, Proposal } from "../types.ts";
import { describe, expect, test } from "bun:test";
import { mockProposals } from "../../fixtures/review/proposals.ts";
import { checkRequest, decide, type DecisionDeps } from "./decide.ts";

function pick(id: string): Proposal {
  const proposal = mockProposals.find((candidate) => candidate.id === id);
  if (proposal === undefined) throw new Error(`fixture ${id} missing`);
  return proposal;
}

const withOp: PendingProposal = { runId: "run-7", proposal: pick("p-factory") };
const textOnly: PendingProposal = { runId: "run-7", proposal: pick("p-commit-hook") };
const pending = new Map([withOp, textOnly].map((entry) => [entry.proposal.fingerprint, entry]));

function harness(result: ApplyResult): {
  readonly deps: DecisionDeps;
  readonly applied: ApplyRequest[];
  readonly recorded: Decision[];
} {
  const applied: ApplyRequest[] = [];
  const recorded: Decision[] = [];
  return {
    applied,
    recorded,
    deps: {
      apply: async (request) => {
        applied.push(request);
        return result;
      },
      record: async (decision) => {
        recorded.push(decision);
      },
      deployedPath: async () => "/home/u/.claude/AGENTS.md",
      now: () => new Date("2026-10-08T10:00:00Z"),
    },
  };
}

const committed: ApplyResult = { kind: "committed", commit: "abc1234def", followUp: ["chezmoi apply x"] };

describe("decide", () => {
  test("records a rejection with its reason and applies nothing", async () => {
    const { deps, applied, recorded } = harness(committed);
    const reply = await decide(
      withOp,
      { fingerprint: "f-factory", decision: "rejected", reason: "faux", newTexts: null },
      deps,
    );
    expect(reply).toEqual({ ok: true, commit: null, followUp: [] });
    expect(applied).toHaveLength(0);
    expect(recorded).toEqual([
      {
        proposalId: "p-factory",
        fingerprint: "f-factory",
        runId: "run-7",
        decision: "rejected",
        editedOp: null,
        reason: "faux",
        commit: null,
        at: "2026-10-08T10:00:00.000Z",
      },
    ]);
  });

  test("records a text-only acceptance without a commit", async () => {
    const { deps, applied, recorded } = harness(committed);
    await decide(textOnly, { fingerprint: "f-commit-hook", decision: "accepted", reason: null, newTexts: null }, deps);
    expect(applied).toHaveLength(0);
    expect(recorded[0]).toMatchObject({ decision: "accepted", commit: null });
  });

  test("applies with the English subject and lesson, then records the commit", async () => {
    const { deps, applied, recorded } = harness(committed);
    const reply = await decide(
      withOp,
      { fingerprint: "f-factory", decision: "accepted", reason: null, newTexts: null },
      deps,
    );
    expect(reply).toEqual({ ok: true, commit: "abc1234def", followUp: ["chezmoi apply x"] });
    expect(applied[0]).toMatchObject({
      runId: "run-7",
      subject: withOp.proposal.commitSubject,
      why: withOp.proposal.lesson,
      deployedPath: "/home/u/.claude/AGENTS.md",
      excerpts: withOp.proposal.evidence.map((item) => item.quote),
    });
    expect(recorded[0]).toMatchObject({ decision: "accepted", editedOp: null, commit: "abc1234def" });
  });

  test("applies and records the human's edited text", async () => {
    const { deps, applied, recorded } = harness(committed);
    await decide(
      withOp,
      { fingerprint: "f-factory", decision: "accepted", reason: null, newTexts: ["- Edited."] },
      deps,
    );
    expect(applied[0]?.op.edits[0]).toEqual({
      oldText: withOp.proposal.op?.edits[0]?.oldText ?? "",
      newText: "- Edited.",
    });
    expect(recorded[0]?.editedOp?.edits[0]?.newText).toBe("- Edited.");
  });

  test("keeps the card pending when apply refuses", async () => {
    const { deps, recorded } = harness({ kind: "refused", reason: "hash-mismatch", detail: "AGENTS.md changed" });
    const reply = await decide(
      withOp,
      { fingerprint: "f-factory", decision: "accepted", reason: null, newTexts: null },
      deps,
    );
    expect(reply).toEqual({
      ok: false,
      error: "le fichier a changé depuis la proposition, relance hindsight run (AGENTS.md changed)",
    });
    expect(recorded).toHaveLength(0);
  });

  test("names the commit when recording fails after it", async () => {
    const { deps } = harness(committed);
    const failing: DecisionDeps = {
      ...deps,
      record: async () => {
        throw new Error("disk full");
      },
    };
    expect(
      decide(withOp, { fingerprint: "f-factory", decision: "accepted", reason: null, newTexts: null }, failing),
    ).rejects.toThrow("commit abc1234def");
  });
});

describe("checkRequest", () => {
  test("accepts well-formed bodies", () => {
    expect(
      checkRequest({ fingerprint: "f-factory", decision: "accepted", reason: null, newTexts: ["x"] }, pending),
    ).toMatchObject({
      ok: true,
      target: withOp,
    });
    expect(
      checkRequest({ fingerprint: "f-factory", decision: "rejected", reason: " faux ", newTexts: null }, pending),
    ).toMatchObject({
      ok: true,
      request: { reason: "faux" },
    });
  });

  test("rejects unknown cards, missing reasons and mismatched edits", () => {
    const errors = [
      checkRequest({ fingerprint: "f-nope", decision: "accepted", reason: null, newTexts: null }, pending),
      checkRequest({ fingerprint: "f-factory", decision: "rejected", reason: "  ", newTexts: null }, pending),
      checkRequest({ fingerprint: "f-factory", decision: "accepted", reason: null, newTexts: ["a", "b"] }, pending),
      checkRequest({ fingerprint: "f-commit-hook", decision: "accepted", reason: null, newTexts: ["a"] }, pending),
      checkRequest({ fingerprint: "f-factory", decision: "maybe", reason: null, newTexts: null }, pending),
      checkRequest("nope", pending),
    ];
    expect(errors.every((check) => !check.ok)).toBe(true);
  });
});
