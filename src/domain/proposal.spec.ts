import { describe, expect, test } from "bun:test";
import { nextProposalState, type ProposalEvent, type ProposalState } from "./proposal.ts";

describe("nextProposalState", () => {
  test("a pending Proposal moves once, to the state its event names", () => {
    expect(nextProposalState("pending", "accept")).toBe("accepted");
    expect(nextProposalState("pending", "handoff")).toBe("handed_off");
    expect(nextProposalState("pending", "reject")).toBe("rejected");
    expect(nextProposalState("pending", "supersede")).toBe("superseded");
    expect(nextProposalState("pending", "expire")).toBe("expired");
  });

  test("a settled Proposal never moves again", () => {
    const settled: ProposalState[] = ["accepted", "handed_off", "rejected", "superseded", "expired"];
    const events: ProposalEvent[] = ["accept", "handoff", "reject", "supersede", "expire"];
    for (const state of settled) for (const event of events) expect(nextProposalState(state, event)).toBeNull();
  });
});
