export type ProposalState = "pending" | "accepted" | "handed_off" | "rejected" | "superseded" | "expired";

export type ProposalEvent = "accept" | "handoff" | "reject" | "supersede" | "expire";

const FROM_PENDING: Readonly<Record<ProposalEvent, ProposalState>> = {
  accept: "accepted",
  handoff: "handed_off",
  reject: "rejected",
  supersede: "superseded",
  expire: "expired",
};

/** The next state, or null when `event` does not apply to `state`: only a pending Proposal moves. */
export function nextProposalState(state: ProposalState, event: ProposalEvent): ProposalState | null {
  return state === "pending" ? FROM_PENDING[event] : null;
}

export type Verdict = "missing" | "ignored" | "misplaced" | "conflict" | "unclear" | "hold";

export const VERDICTS: readonly Verdict[] = ["missing", "ignored", "misplaced", "conflict", "unclear", "hold"];
