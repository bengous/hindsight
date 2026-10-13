import type { Proposal } from "../types.ts";
import { describe, expect, test } from "bun:test";
import { mockBulletText, mockNow, mockProposals } from "../../fixtures/review/proposals.ts";
import { renderPage, type PageInput } from "./page.ts";
import { selectRound } from "./round.ts";

function page(overrides: Partial<PageInput> = {}): string {
  return renderPage({
    cards: selectRound(mockProposals),
    pendingTotal: mockProposals.length,
    now: mockNow,
    timeZone: "UTC",
    bulletText: mockBulletText,
    evidenceText: new Map(),
    nonce: "n0nce",
    client: { mode: "mock" },
    ...overrides,
  });
}

describe("renderPage", () => {
  test("renders one card per proposal of the round, in round order", () => {
    const ids = [...page().matchAll(/data-card="([^"]+)"/g)].map((match) => match[1]);
    expect(ids).toEqual(["f-factory", "f-commit-hook", "f-draft-pr"]);
  });

  test("escapes evidence quotes and titles", () => {
    const base = mockProposals[0];
    if (base === undefined) throw new Error("fixture mockProposals is empty");
    const hostile: Proposal = {
      ...base,
      title: "<img src=x onerror=alert(1)>",
      evidence: [
        {
          evidenceId: "s:u",
          sessionTitle: "<b>t</b>",
          timestamp: base.prevalence.lastAt,
          quote: "</script><script>alert(2)</script>",
        },
      ],
    };
    const html = page({ cards: [{ proposal: hostile, contest: false }] });
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert(2)");
    expect(html).toContain("&lt;/script&gt;&lt;script&gt;alert(2)&lt;/script&gt;");
  });

  test("allows only the nonced inline script", () => {
    const html = page();
    expect(html).toContain("script-src 'nonce-n0nce'");
    expect(html.match(/<script\b/g)?.length).toBe(1);
    expect(html).toContain('<script nonce="n0nce">');
  });

  test("shows the cited rule and the suggestion for a text-only finding", () => {
    const html = page();
    expect(html).toContain("Write dates in ISO format");
    expect(html).toContain("Suggestion · rien n'est écrit dans les règles");
  });

  test("offers no edit button on a text-only finding", () => {
    const card =
      page()
        .split("<article")
        .find((chunk) => chunk.includes('data-card="f-commit-hook"')) ?? "";
    expect(card).toContain('data-action="accept"');
    expect(card).not.toContain('data-action="edit"');
  });

  test("flags the least sure card", () => {
    const card =
      page()
        .split("<article")
        .find((chunk) => chunk.includes('data-card="f-draft-pr"')) ?? "";
    expect(card).toContain("is-contest");
  });

  test("renders an empty state without cards", () => {
    expect(page({ cards: [], pendingTotal: 0 })).toContain("Aucune proposition en attente.");
  });

  test("shows memory-note evidence as notes, not as zero sessions", () => {
    const base = mockProposals[0];
    if (base === undefined) throw new Error("fixture mockProposals is empty");
    const seeded: Proposal = {
      ...base,
      prevalence: { ...base.prevalence, sessions: 0, days: 0, repos: 0 },
      evidence: [{ evidenceId: "mem:/notes/a.md", sessionTitle: "a", timestamp: base.prevalence.lastAt, quote: "q" }],
    };
    const html = page({ cards: [{ proposal: seeded, contest: false }] });
    expect(html).toContain("1 note mémoire");
    expect(html).not.toContain("0 session");
  });

  test("shows a finding without session evidence as deterministic, without a strip", () => {
    const base = mockProposals[0];
    if (base === undefined) throw new Error("fixture mockProposals is empty");
    const stale: Proposal = { ...base, kind: "stale", evidence: [] };
    const html = page({ cards: [{ proposal: stale, contest: false }] });
    expect(html).toContain("constat déterministe");
    expect(html).not.toContain('class="strip"');
  });

  test("expands an evidence quote into its redacted message, with the quote highlighted", () => {
    const base = mockProposals[0];
    const item = base?.evidence[0];
    if (base === undefined || item === undefined) throw new Error("fixture evidence missing");
    const message = `Contexte <b>avant</b> token=s3cr3tvalue ; ${item.quote} ; et la suite.`;
    const html = page({
      cards: [{ proposal: base, contest: false }],
      evidenceText: new Map([[item.evidenceId, message]]),
    });
    expect(html).toContain(`<details class="msg">`);
    expect(html).toContain(`<mark>${item.quote}</mark>`);
    expect(html).toContain("Contexte &lt;b&gt;avant&lt;/b&gt; token=[REDACTED]");
    expect(html).not.toContain("s3cr3tvalue");
  });

  test("flags a quote that its message does not contain", () => {
    const base = mockProposals[0];
    const item = base?.evidence[0];
    if (base === undefined || item === undefined) throw new Error("fixture evidence missing");
    const html = page({
      cards: [{ proposal: base, contest: false }],
      evidenceText: new Map([[item.evidenceId, "Un message sans la citation."]]),
    });
    expect(html).toContain("Citation introuvable telle quelle dans le message.");
  });

  test("keeps a plain quote when no message text is stored for it", () => {
    const base = mockProposals[0];
    if (base === undefined) throw new Error("fixture mockProposals is empty");
    const html = page({ cards: [{ proposal: base, contest: false }] });
    expect(html).not.toContain(`<details class="msg">`);
  });
});
