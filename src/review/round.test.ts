import type { Proposal } from "../types.ts";
import { describe, expect, test } from "bun:test";
import { mockProposals } from "../../fixtures/review/proposals.ts";
import { selectRound } from "./round.ts";

function variant(
  id: string,
  sessions: number,
  confidence: Proposal["confidence"],
  change: Partial<Proposal> = {},
): Proposal {
  const base = mockProposals[0];
  if (base === undefined) throw new Error("fixture mockProposals is empty");
  return { ...base, id, fingerprint: `f-${id}`, confidence, prevalence: { ...base.prevalence, sessions }, ...change };
}

const ids = (round: ReturnType<typeof selectRound>): readonly string[] => round.map((card) => card.proposal.id);

describe("selectRound", () => {
  test("keeps the three most prevalent proposals, highest first", () => {
    const round = selectRound([
      variant("a", 1, "high"),
      variant("b", 7, "high"),
      variant("c", 3, "high"),
      variant("d", 5, "high"),
    ]);
    expect(ids(round)).toEqual(["b", "d", "c"]);
  });

  test("keeps one place for a stale card, which has no session evidence", () => {
    const round = selectRound([
      variant("a", 9, "high"),
      variant("b", 7, "high"),
      variant("c", 5, "high"),
      variant("stale", 0, "high", { kind: "stale", evidence: [] }),
    ]);
    expect(ids(round)).toEqual(["a", "b", "stale"]);
  });

  test("keeps one place for a remove op", () => {
    const base = mockProposals[0]?.op;
    if (base === undefined || base === null) throw new Error("fixture op missing");
    const round = selectRound([
      variant("a", 9, "high"),
      variant("b", 7, "high"),
      variant("c", 5, "high"),
      variant("cut", 1, "high", { kind: "conflict", op: { ...base, op: "remove" } }),
    ]);
    expect(ids(round)).toEqual(["a", "b", "cut"]);
  });

  test("does not add a second reserved place when a removal already ranks high", () => {
    const round = selectRound([
      variant("stale", 9, "high", { kind: "stale" }),
      variant("b", 7, "high"),
      variant("c", 5, "high"),
      variant("d", 3, "high"),
    ]);
    expect(ids(round)).toEqual(["stale", "b", "c"]);
  });

  test("flags the lowest confidence as the card to contest", () => {
    const round = selectRound([variant("a", 9, "high"), variant("b", 8, "low"), variant("c", 7, "medium")]);
    expect(round.filter((card) => card.contest).map((card) => card.proposal.id)).toEqual(["b"]);
  });

  test("breaks a confidence tie with the fewest sessions", () => {
    const round = selectRound([variant("a", 9, "medium"), variant("b", 4, "medium"), variant("c", 6, "high")]);
    expect(round.filter((card) => card.contest).map((card) => card.proposal.id)).toEqual(["b"]);
  });

  test("flags nothing in a round of one", () => {
    expect(selectRound([variant("a", 2, "low")]).some((card) => card.contest)).toBe(false);
  });
});
