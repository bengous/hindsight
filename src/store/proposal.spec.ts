import type { Change, Evidence, Prevalence, ProposalState } from "../domain/proposal.ts";
import type { ChangeSchema, EvidenceSchema, PrevalenceSchema, ProposalStateSchema } from "./proposal.ts";

import { describe, expect, expectTypeOf, test } from "bun:test";

import { decodeChange, decodeEvidence, decodePrevalence, decodeState } from "./proposal.ts";

describe("the Proposal Schemas", () => {
  test("decode to the domain types, field for field", () => {
    expectTypeOf<typeof ChangeSchema.Type>().toEqualTypeOf<Change>();
    expectTypeOf<ReadonlyArray<typeof EvidenceSchema.Type>>().toEqualTypeOf<readonly Evidence[]>();
    expectTypeOf<typeof PrevalenceSchema.Type>().toEqualTypeOf<Prevalence>();
    expectTypeOf<typeof ProposalStateSchema.Type>().toEqualTypeOf<ProposalState>();
  });

  test("read back what insertProposal writes with JSON.stringify", () => {
    const change: Change = { kind: "edit", edits: [{ oldText: "a", newText: "b" }] };

    const evidence: Evidence[] = [
      { evidenceId: "s:1", kind: "quote", at: "2024-01-01T00:00:00.000Z", sessionId: "s", text: "t", tool: null },
    ];

    const prevalence: Prevalence = { sessions: 2, days: 1, repos: 1, firstAt: "a", lastAt: "b" };

    expect(decodeChange(JSON.stringify(change))).toEqual(change);
    expect(decodeEvidence(JSON.stringify(evidence))).toEqual(evidence);
    expect(decodePrevalence(JSON.stringify(prevalence))).toEqual(prevalence);
    expect(decodeState("handed_off")).toBe("handed_off");
  });

  test("refuse a state the Proposal machine does not know", () => {
    expect(() => decodeState("done")).toThrow();
  });
});
