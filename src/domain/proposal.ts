import type { TextEdit } from "./diff.ts";

export const PROPOSAL_STATES = ["pending", "accepted", "handed_off", "rejected", "superseded", "expired"] as const;

export type ProposalState = (typeof PROPOSAL_STATES)[number];

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

export const VERDICTS = ["missing", "ignored", "misplaced", "conflict", "unclear", "hold"] as const;

export type Verdict = (typeof VERDICTS)[number];

export type Change =
  | { readonly kind: "edit"; readonly edits: readonly TextEdit[] }
  | { readonly kind: "description"; readonly text: string };

export type Evidence = {
  readonly evidenceId: string;
  readonly kind: "quote" | "observation";
  readonly at: string;
  readonly sessionId: string;
  readonly text: string;
  readonly tool: string | null;
};

export type Prevalence = {
  readonly sessions: number;
  readonly days: number;
  readonly repos: number;
  readonly firstAt: string;
  readonly lastAt: string;
};
