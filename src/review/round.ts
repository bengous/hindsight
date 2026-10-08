import type { Proposal } from "../types.ts";

export const ROUND_SIZE = 3;

export type Card = {
  readonly proposal: Proposal;
  /** The least sure card of the round, shown to the human as the one to contest. */
  readonly contest: boolean;
};

const confidenceRank: Record<Proposal["confidence"], number> = { high: 2, medium: 1, low: 0 };

function byPrevalence(a: Proposal, b: Proposal): number {
  return (
    b.prevalence.sessions - a.prevalence.sessions ||
    b.prevalence.days - a.prevalence.days ||
    b.prevalence.repos - a.prevalence.repos ||
    a.fingerprint.localeCompare(b.fingerprint)
  );
}

/** A card that shrinks the rules; it gets a reserved place so the rule files do not only grow. */
export function isRemoval(proposal: Proposal): boolean {
  return proposal.kind === "stale" || proposal.op?.op === "remove";
}

function leastSureIndex(round: readonly Proposal[]): number {
  let index = 0;
  round.forEach((proposal, i) => {
    const current = round[index];
    if (current === undefined) return;
    const rank = confidenceRank[proposal.confidence];
    const currentRank = confidenceRank[current.confidence];
    if (rank < currentRank || (rank === currentRank && proposal.prevalence.sessions <= current.prevalence.sessions)) {
      index = i;
    }
  });
  return index;
}

/** The most prevalent pending proposals, with one of the places kept for a removal when one is pending. */
export function selectRound(pending: readonly Proposal[]): readonly Card[] {
  const ranked = [...pending].sort(byPrevalence);
  const removal = ranked.find(isRemoval);
  const others = ranked.filter((proposal) => proposal !== removal);
  const chosen = removal === undefined ? others.slice(0, ROUND_SIZE) : [...others.slice(0, ROUND_SIZE - 1), removal];
  const round = chosen.sort(byPrevalence);
  const contestIndex = round.length >= 2 ? leastSureIndex(round) : -1;
  return round.map((proposal, i) => ({ proposal, contest: i === contestIndex }));
}
