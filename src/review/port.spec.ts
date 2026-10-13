import type { StoreService } from "../store/db.ts";
import type { ProposalInsert } from "../store/queries.ts";
import type { ReviewItem } from "./port.ts";
import type { PluginState } from "claude-code";

import { afterAll, beforeEach, describe, expect, expectTypeOf, test } from "bun:test";
import { Effect } from "effect";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { tempRepo } from "../../fixtures/rules/repo.ts";
import { defaultConfig } from "../domain/config.ts";
import { Store, makeStore } from "../store/db.ts";
import { insertProposal, upsertMessage } from "../store/queries.ts";
import { decideProposal, listReview, prepareHandoff } from "./port.ts";

const RULES = "# Rules\n- Keep functions small.\n- Name things plainly.\n";

const repo = tempRepo({ "AGENTS.md": RULES });

const AGENTS = join(repo.root, "AGENTS.md");

const NOW = "2026-10-13T12:00:00.000Z";

afterAll(() => repo.cleanup());

let store: StoreService;

const provide = async <A, E>(effect: Effect.Effect<A, E, Store>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provideService(Store, store)));

const proposal = (id: string, overrides: Partial<ProposalInsert> = {}): ProposalInsert => ({
  id,
  fingerprint: `fp-${id}`,
  createdAt: NOW,
  source: "learn",
  targetPath: AGENTS,
  repoRoot: repo.root,
  scope: "repo",
  verdict: "missing",
  claimFr: "Nommer d'après le domaine.",
  reasoningFr: "Corrigé souvent.",
  lessonEn: "Name things after the domain.",
  subjectEn: "Name things after the domain",
  change: { kind: "edit", edits: [{ oldText: "- Name things plainly.", newText: "- Name things after the domain." }] },
  evidence: [
    {
      evidenceId: "s1:u1",
      kind: "quote",
      at: NOW,
      sessionId: "s1",
      text: "nomme d'après le domaine, token=sk-ant-abcdefghijklmnopqrstuvwxyz0123",
      tool: null,
    },
  ],
  prevalence: { sessions: 3, days: 2, repos: 1, firstAt: NOW, lastAt: NOW },
  bulletId: null,
  learnRunId: null,
  ...overrides,
});

beforeEach(async () => {
  store = await Effect.runPromise(makeStore(":memory:"));
  repo.write("AGENTS.md", RULES);
  repo.git("commit", "-qam", "reset", "--allow-empty");
});

describe("the pane's contract", () => {
  test("every item the port lists is an item the pane draws", () => {
    expectTypeOf<ReviewItem>().toMatchTypeOf<PluginState["hindsight"]["review"]["items"][number]>();
  });
});

describe("listReview", () => {
  test("sorts by Prevalence then age, caps the pass, masks secrets and attaches the full message", async () => {
    await Effect.runPromise(
      store.transaction((db) => {
        upsertMessage(db, {
          evidenceId: "s1:u1",
          sessionId: "s1",
          at: NOW,
          repoRoot: repo.root,
          text: "bon, nomme d'après le domaine, token=sk-ant-abcdefghijklmnopqrstuvwxyz0123 merci",
        });
        insertProposal(
          db,
          proposal("old", {
            createdAt: "2026-10-01T00:00:00.000Z",
            prevalence: { sessions: 1, days: 1, repos: 1, firstAt: NOW, lastAt: NOW },
            change: { kind: "description", text: "d" },
            fingerprint: "a",
          }),
        );
        insertProposal(
          db,
          proposal("big", {
            prevalence: { sessions: 5, days: 3, repos: 1, firstAt: NOW, lastAt: NOW },
            change: { kind: "description", text: "e" },
            fingerprint: "b",
          }),
        );
        insertProposal(db, proposal("mid", { fingerprint: "c" }));
        insertProposal(
          db,
          proposal("tiny", {
            createdAt: "2026-10-02T00:00:00.000Z",
            prevalence: { sessions: 1, days: 1, repos: 1, firstAt: NOW, lastAt: NOW },
            change: { kind: "description", text: "f" },
            fingerprint: "d",
          }),
        );
      }),
    );
    const result = await provide(listReview(defaultConfig));
    expect(result.pending).toBe(4);
    expect(result.items.map((item) => item.id)).toEqual(["big", "mid", "old"]);
    const quote = result.items[1]?.evidence[0];
    expect(quote?.text).toBe("nomme d'après le domaine, token=[REDACTED]");
    expect(quote?.message).toBe("bon, nomme d'après le domaine, token=[REDACTED] merci");
  });

  test("expires an edit whose old text is gone and supersedes the older of two on the same text", async () => {
    await Effect.runPromise(
      store.transaction((db) => {
        insertProposal(
          db,
          proposal("gone", {
            change: { kind: "edit", edits: [{ oldText: "- Vanished.", newText: "x" }] },
            fingerprint: "g",
          }),
        );
        insertProposal(db, proposal("older", { createdAt: "2026-10-01T00:00:00.000Z", fingerprint: "o" }));
        insertProposal(db, proposal("newer", { fingerprint: "n" }));
      }),
    );
    const result = await provide(listReview(defaultConfig));
    expect(result).toMatchObject({ expired: 1, superseded: 1 });
    expect(result.items.map((item) => item.id)).toEqual(["newer"]);

    const states = await Effect.runPromise(
      store.all<{ id: string; state: string }>("SELECT id, state FROM proposals ORDER BY id"),
    );

    expect(states).toEqual([
      { id: "gone", state: "expired" },
      { id: "newer", state: "pending" },
      { id: "older", state: "superseded" },
    ]);
  });
});

describe("decideProposal", () => {
  test("accept commits one file, records the Decision with the commit, and a second decision is refused", async () => {
    await Effect.runPromise(store.transaction((db) => insertProposal(db, proposal("p1"))));
    const outcome = await provide(decideProposal("p1", { kind: "accept", edits: null }, NOW));
    expect(outcome.kind).toBe("accepted");
    expect(readFileSync(AGENTS, "utf8")).toContain("- Name things after the domain.");
    expect(repo.git("log", "-1", "--format=%B")).not.toContain("nomme d'après");

    const decisions = await Effect.runPromise(
      store.all<{ decision: string; commit_sha: string | null; sessions_at_decision: number }>(
        "SELECT decision, commit_sha, sessions_at_decision FROM decisions",
      ),
    );

    expect(decisions).toEqual([
      { decision: "accepted", commit_sha: repo.git("rev-parse", "HEAD").trim(), sessions_at_decision: 3 },
    ]);
    expect(await provide(decideProposal("p1", { kind: "reject", reason: "x" }, NOW))).toMatchObject({
      kind: "refused",
      reason: "proposal is accepted",
    });
  });

  test("the commit message is checked against the raw Quote, before masking, and a refused apply releases the Proposal", async () => {
    await Effect.runPromise(
      store.transaction((db) => {
        upsertMessage(db, {
          evidenceId: "s1:u1",
          sessionId: "s1",
          at: NOW,
          repoRoot: repo.root,
          text: "nomme d'après le domaine, token=sk-ant-abcdefghijklmnopqrstuvwxyz0123",
        });
        insertProposal(
          db,
          proposal("leak", {
            lessonEn: "User said: nomme d'après le domaine, token=sk-ant-abcdefghijklmnopqrstuvwxyz0123.",
          }),
        );
      }),
    );
    const outcome = await provide(decideProposal("leak", { kind: "accept", edits: null }, NOW));
    expect(outcome.kind).toBe("refused");
    expect(outcome.kind === "refused" ? outcome.reason : "").toContain("excerpt-in-message");
    expect(await Effect.runPromise(store.all("SELECT * FROM decisions"))).toHaveLength(0);
    expect(
      (await Effect.runPromise(store.all<{ state: string }>("SELECT state FROM proposals WHERE id = 'leak'")))[0]
        ?.state,
    ).toBe("pending");
  });

  test("edit then accept applies the human's text and keeps it on the Decision", async () => {
    await Effect.runPromise(store.transaction((db) => insertProposal(db, proposal("p2"))));
    const edits = [{ oldText: "- Name things plainly.", newText: "- Name things after the domain, in English." }];
    expect((await provide(decideProposal("p2", { kind: "accept", edits }, NOW))).kind).toBe("accepted");
    expect(readFileSync(AGENTS, "utf8")).toContain("in English.");

    const [row] = await Effect.runPromise(
      store.all<{ edited_change_json: string }>("SELECT edited_change_json FROM decisions"),
    );

    expect(JSON.parse(row?.edited_change_json ?? "{}")).toEqual({ kind: "edit", edits });
  });

  test("a rejection needs a reason; a description cannot be accepted; a refused apply leaves the Proposal pending", async () => {
    await Effect.runPromise(
      store.transaction((db) => {
        insertProposal(db, proposal("p3"));
        insertProposal(
          db,
          proposal("p4", { change: { kind: "description", text: "write a hook" }, fingerprint: "d4" }),
        );
        insertProposal(
          db,
          proposal("p5", {
            change: { kind: "edit", edits: [{ oldText: "- Gone.", newText: "x" }] },
            fingerprint: "d5",
          }),
        );
      }),
    );
    expect(await provide(decideProposal("p3", { kind: "reject", reason: "  " }, NOW))).toMatchObject({
      kind: "refused",
    });
    expect(await provide(decideProposal("p3", { kind: "reject", reason: "trop large" }, NOW))).toEqual({
      kind: "rejected",
    });
    expect(await provide(decideProposal("p4", { kind: "accept", edits: null }, NOW))).toMatchObject({
      kind: "refused",
    });
    const stale = await provide(decideProposal("p5", { kind: "accept", edits: null }, NOW));
    expect(stale.kind).toBe("refused");
    expect(stale.kind === "refused" ? stale.reason : "").toContain("old-text-missing");

    const states = await Effect.runPromise(
      store.all<{ id: string; state: string }>("SELECT id, state FROM proposals ORDER BY id"),
    );

    expect(states).toEqual([
      { id: "p3", state: "rejected" },
      { id: "p4", state: "pending" },
      { id: "p5", state: "pending" },
    ]);
  });

  test("handoff marks the Proposal, and prepare writes instructions without any Quote, once", async () => {
    await Effect.runPromise(
      store.transaction((db) =>
        insertProposal(
          db,
          proposal("p6", { change: { kind: "description", text: "Add a pre-commit hook that runs the check." } }),
        ),
      ),
    );
    expect(await provide(decideProposal("p6", { kind: "handoff" }, NOW))).toEqual({ kind: "handed_off" });
    const handoff = await provide(prepareHandoff(NOW));
    expect(handoff.proposals).toBe(1);
    expect(handoff.instructions).toContain("Add a pre-commit hook");
    expect(handoff.instructions).toContain(AGENTS);
    expect(handoff.instructions).not.toContain("nomme d'après");
    expect(await provide(prepareHandoff(NOW))).toEqual({ id: null, instructions: null, proposals: 0 });
  });
});
