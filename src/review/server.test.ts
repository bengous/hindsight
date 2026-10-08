import type { PendingProposal } from "../state/index.ts";
import type { Proposal } from "../types.ts";
import type { DecisionReply, DecisionRequest } from "./client.ts";
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { mockProposals } from "../../fixtures/review/proposals.ts";
import { tempDir, tempRepo } from "../../fixtures/rules/repo.ts";
import { applyDelta } from "../rules/apply.ts";
import { appendDecision, createRun, pendingProposals, readDecisions, writeRunJson } from "../state/index.ts";
import { decide } from "./decide.ts";
import { serveReview, type ReviewServerOptions } from "./server.ts";

const pendingMock: readonly PendingProposal[] = mockProposals.map((proposal) => ({ runId: "run-1", proposal }));

function options(overrides: Partial<ReviewServerOptions> = {}): ReviewServerOptions {
  return {
    pending: async () => pendingMock,
    bulletText: async () => new Map(),
    decide: async () => ({ ok: true, commit: null, followUp: [] }),
    timeZone: "UTC",
    now: () => new Date("2026-10-08T09:00:00Z"),
    ...overrides,
  };
}

function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const origin = new URL(url).origin;
  return fetch(new URL(`/decision${new URL(url).search}`, url), {
    method: "POST",
    headers: { "content-type": "application/json", origin, ...headers },
    body: JSON.stringify(body),
  });
}

describe("serveReview", () => {
  test("binds 127.0.0.1 and refuses requests without the token", async () => {
    const server = serveReview(options());
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{48}$/);
      expect((await fetch(new URL("/", server.url))).status).toBe(403);
      expect((await fetch(`${new URL("/", server.url)}?t=${"0".repeat(48)}`)).status).toBe(403);
    } finally {
      await server.stop();
    }
  });

  test("serves the round with a CSP nonce that matches the inline script", async () => {
    const server = serveReview(options());
    try {
      const response = await fetch(server.url);
      const html = await response.text();
      const nonce = /script-src 'nonce-([0-9a-f]+)'/.exec(response.headers.get("content-security-policy") ?? "")?.[1];
      expect(response.status).toBe(200);
      expect(nonce).toBeDefined();
      expect(html).toContain(`<script nonce="${nonce}">`);
      expect([...html.matchAll(/data-card="([^"]+)"/g)].map((match) => match[1])).toEqual([
        "f-factory",
        "f-commit-hook",
        "f-draft-pr",
      ]);
      expect(response.headers.get("cache-control")).toBe("no-store");
    } finally {
      await server.stop();
    }
  });

  test("refuses a decision from another origin or with a bad body", async () => {
    const calls: DecisionRequest[] = [];
    const server = serveReview(
      options({
        decide: async (_, request) => {
          calls.push(request);
          return { ok: true, commit: null, followUp: [] };
        },
      }),
    );
    try {
      const body: DecisionRequest = { fingerprint: "f-factory", decision: "rejected", reason: "faux", newTexts: null };
      expect((await post(server.url, body, { origin: "http://evil.example" })).status).toBe(403);
      expect((await post(server.url, { ...body, reason: "" })).status).toBe(400);
      expect(calls).toHaveLength(0);
      const accepted = await post(server.url, body);
      expect(accepted.status).toBe(200);
      expect(calls).toEqual([body]);
    } finally {
      await server.stop();
    }
  });

  test("runs decisions one at a time", async () => {
    let active = 0;
    let overlap = false;
    const server = serveReview(
      options({
        decide: async (): Promise<DecisionReply> => {
          active++;
          overlap ||= active > 1;
          await Bun.sleep(30);
          active--;
          return { ok: true, commit: null, followUp: [] };
        },
      }),
    );
    try {
      const reject = (fingerprint: string): Promise<Response> =>
        post(server.url, { fingerprint, decision: "rejected", reason: "faux", newTexts: null });
      await Promise.all([reject("f-factory"), reject("f-commit-hook"), reject("f-draft-pr")]);
      expect(overlap).toBe(false);
    } finally {
      await server.stop();
    }
  });
});

describe("review end to end", () => {
  const repo = tempRepo({ "AGENTS.md": "# Rules\n- Tests live next to the code they cover.\n" });
  const stateRoot = join(tempDir("review-state"), "state");
  afterAll(() => {
    repo.cleanup();
    rmSync(join(stateRoot, ".."), { recursive: true, force: true });
  });

  test("an accepted card becomes one commit and one decision, then leaves the round", async () => {
    const base = mockProposals[0];
    if (base === undefined) throw new Error("fixture mockProposals is empty");
    const sourcePath = join(repo.root, "AGENTS.md");
    const proposal: Proposal = {
      ...base,
      target: { repoRoot: repo.root, sourcePath, blobHash: repo.git("hash-object", "AGENTS.md").trim() },
      op: {
        op: "add",
        sourcePath,
        edits: [
          {
            oldText: "- Tests live next to the code they cover.",
            newText: "- Tests live next to the code they cover.\n- Build orders with `makeOrder()`.",
          },
        ],
      },
    };
    await createRun(stateRoot, "run-e2e");
    await writeRunJson(stateRoot, "run-e2e", "proposals.json", [proposal]);

    const server = serveReview(
      options({
        pending: () => pendingProposals(stateRoot),
        decide: (target, request) =>
          decide(target, request, {
            apply: (applyRequest) => applyDelta(applyRequest, async () => []),
            record: (decision) => appendDecision(decision, stateRoot),
            deployedPath: async () => null,
            now: () => new Date("2026-10-08T10:00:00Z"),
          }),
      }),
    );
    try {
      const response = await post(server.url, {
        fingerprint: proposal.fingerprint,
        decision: "accepted",
        reason: null,
        newTexts: null,
      });
      const reply = (await response.json()) as DecisionReply;
      expect(reply.ok).toBe(true);
      const head = repo.git("rev-parse", "HEAD").trim();
      expect(reply).toEqual({ ok: true, commit: head, followUp: [] });
      expect(repo.git("log", "-1", "--format=%s").trim()).toBe(proposal.commitSubject);
      expect(await readDecisions(stateRoot)).toMatchObject([{ fingerprint: proposal.fingerprint, commit: head }]);
      expect(await (await fetch(server.url)).text()).toContain("Aucune proposition en attente.");
      expect(repo.git("status", "--porcelain")).toBe("");
    } finally {
      await server.stop();
    }
  });
});
