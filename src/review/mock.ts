import { mockBulletText, mockEvidenceText, mockNow, mockProposals } from "../../fixtures/review/proposals.ts";
import { renderPage } from "./page.ts";
import { selectRound } from "./round.ts";

const out = process.argv[2];
if (out === undefined) {
  console.error("usage: bun src/review/mock.ts <out.html>");
  process.exit(2);
}

const html = renderPage({
  cards: selectRound(mockProposals),
  pendingTotal: mockProposals.length,
  now: mockNow,
  timeZone: "Europe/Paris",
  bulletText: mockBulletText,
  evidenceText: mockEvidenceText,
  nonce: crypto.randomUUID().replaceAll("-", ""),
  client: { mode: "mock" },
});
await Bun.write(out, html);
console.log(out);
