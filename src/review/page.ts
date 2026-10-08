import type { DeltaOp, EvidenceItem, FindingKind, Prevalence, Proposal } from "../types.ts";
import type { Card } from "./round.ts";
import { basename, relative } from "node:path";
import { reviewClient, type ClientConfig } from "./client.ts";
import { lineDiff } from "./diff.ts";

export type PageInput = {
  readonly cards: readonly Card[];
  readonly pendingTotal: number;
  /** End of the 30-day evidence strip. */
  readonly now: Date;
  readonly timeZone: string;
  /** Rule bullet text by bullet id, for findings that cite a rule without changing it. */
  readonly bulletText: ReadonlyMap<string, string>;
  /** CSP nonce of the inline script. */
  readonly nonce: string;
  readonly client: ClientConfig;
};

const STRIP_DAYS = 30;

const kindLabel: Record<FindingKind, string> = {
  missing: "manquante",
  ignored: "ignorée",
  misplaced: "mal placée",
  conflict: "conflit",
  stale: "obsolète",
  "tool-config": "outillage",
  watch: "à surveiller",
};

const opLabel: Record<DeltaOp["op"], string> = {
  add: "ajout",
  update: "modification",
  remove: "suppression",
  consolidate: "fusion",
};

const confidenceLabel: Record<Proposal["confidence"], string> = {
  high: "confiance haute",
  medium: "confiance moyenne",
  low: "confiance basse",
};

const rejectReasons = ["trop spécifique", "déjà couvert", "faux", "pas une règle"] as const;

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function dayKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function shortDate(timestamp: string, timeZone: string): string {
  return new Intl.DateTimeFormat("fr-FR", { timeZone, day: "numeric", month: "short" }).format(new Date(timestamp));
}

function renderStrip(evidence: readonly EvidenceItem[], now: Date, timeZone: string): string {
  const counts = new Map<string, number>();
  for (const item of evidence) {
    const key = dayKey(new Date(item.timestamp), timeZone);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const cells: string[] = [];
  for (let back = STRIP_DAYS - 1; back >= 0; back--) {
    const day = new Date(now.getTime() - back * 86_400_000);
    const count = counts.get(dayKey(day, timeZone)) ?? 0;
    const level = Math.min(count, 3);
    cells.push(`<i class="d${level}" title="${escapeHtml(shortDate(day.toISOString(), timeZone))} : ${count}"></i>`);
  }
  return `<span class="strip" aria-label="Preuves sur ${STRIP_DAYS} jours">${cells.join("")}</span>`;
}

function renderPrevalence(prevalence: Prevalence): string {
  return [
    `<b>${plural(prevalence.sessions, "session", "sessions")}</b>`,
    plural(prevalence.days, "jour", "jours"),
    plural(prevalence.repos, "dépôt", "dépôts"),
  ].join(" · ");
}

function renderDiff(op: DeltaOp): string {
  const hunks = op.edits.map((edit) => {
    const created = edit.oldText === "" ? `<div class="ln note">nouveau fichier</div>` : "";
    const rows = lineDiff(edit.oldText, edit.newText).map((line) => {
      const sign = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
      return `<div class="ln ${line.kind}"><span class="sg">${sign}</span>${escapeHtml(line.text) || " "}</div>`;
    });
    return `<div class="hunk">${created}${rows.join("")}</div>`;
  });
  return `<div class="diff">${hunks.join('<div class="gap">⋯</div>')}</div>`;
}

function renderEditor(op: DeltaOp): string {
  const areas = op.edits.map((edit, index) => {
    const rows = Math.min(Math.max(edit.newText.split("\n").length + 1, 3), 14);
    return `<textarea data-edit="${index}" rows="${rows}" spellcheck="false">${escapeHtml(edit.newText)}</textarea>`;
  });
  return `<div class="panel" data-panel="edit" hidden>
  ${areas.join("")}
  <div class="row">
    <button class="btn ok" data-action="accept-edited">Accepter la version modifiée</button>
    <button class="btn ghost" data-action="cancel">Annuler</button>
  </div>
</div>`;
}

function renderCitedRules(proposal: Proposal, bulletText: ReadonlyMap<string, string>): string {
  const rows = proposal.ruleBulletIds.flatMap((id) => {
    const text = bulletText.get(id);
    if (text === undefined) return [];
    return [`<div class="rule" title="${escapeHtml(id)}">${escapeHtml(text)}</div>`];
  });
  return rows.length === 0 ? "" : `<div class="cited"><span class="lbl">Règle chargée</span>${rows.join("")}</div>`;
}

function renderBody(proposal: Proposal, bulletText: ReadonlyMap<string, string>): string {
  if (proposal.op !== null) return renderDiff(proposal.op);
  const suggestion = proposal.suggestion ?? "";
  return `${renderCitedRules(proposal, bulletText)}<div class="suggest"><span class="lbl">Suggestion · rien n'est écrit dans les règles</span>${escapeHtml(suggestion)}</div>`;
}

function renderEvidence(evidence: readonly EvidenceItem[], timeZone: string): string {
  if (evidence.length === 0)
    return `<div class="ev none">Aucune preuve de session : constat déterministe sur le dépôt.</div>`;
  const first = evidence[0]?.quote ?? "";
  const rows = evidence.map(
    (item) => `<tr title="${escapeHtml(item.evidenceId)}">
      <td class="ses">${escapeHtml(item.sessionTitle ?? "session sans titre")}</td>
      <td class="dt">${escapeHtml(shortDate(item.timestamp, timeZone))}</td>
      <td class="q">${escapeHtml(item.quote)}</td>
    </tr>`,
  );
  return `<details class="ev">
  <summary><span class="lbl">${plural(evidence.length, "preuve", "preuves")}</span><span class="teaser">« ${escapeHtml(first)} »</span></summary>
  <table><tbody>${rows.join("")}</tbody></table>
</details>`;
}

function renderCard(card: Card, rank: number, input: PageInput): string {
  const { proposal } = card;
  const target = proposal.target;
  const repo = basename(target.repoRoot);
  const file = relative(target.repoRoot, target.sourcePath);
  const op = proposal.op === null ? "suggestion" : opLabel[proposal.op.op];
  const contest = card.contest ? `<div class="contest">Le moins sûr de ce tour · conteste-le</div>` : "";
  const edit = proposal.op === null ? "" : `<button class="btn" data-action="edit">Modifier</button>`;
  const chips = rejectReasons.map(
    (reason) => `<button class="chip" type="button" data-chip="${reason}">${reason}</button>`,
  );

  return `<article class="card k-${proposal.kind}${card.contest ? " is-contest" : ""}" data-card="${escapeHtml(proposal.fingerprint)}">
  ${contest}
  <header class="top">
    <span class="rank">${rank}</span>
    <span class="badge">${kindLabel[proposal.kind]}</span>
    <h2 class="claim" title="${escapeHtml(proposal.title)}">${escapeHtml(proposal.title)}</h2>
    <div class="stats">
      ${
        proposal.evidence.length === 0
          ? `<div class="prev"><b>constat déterministe</b></div>`
          : `<div class="prev">${renderPrevalence(proposal.prevalence)}</div>${renderStrip(proposal.evidence, input.now, input.timeZone)}`
      }
      <div class="conf c-${proposal.confidence}">${confidenceLabel[proposal.confidence]}</div>
    </div>
  </header>
  <div class="target"><span class="repo">${escapeHtml(repo)}</span><span class="path">${escapeHtml(file)}</span><span class="op">${op}</span></div>
  <div class="body">${renderBody(proposal, input.bulletText)}</div>
  <p class="why" data-why title="Cliquer pour tout lire"><span class="lbl">Pourquoi</span> ${escapeHtml(proposal.why)}</p>
  ${renderEvidence(proposal.evidence, input.timeZone)}
  <footer class="decide">
    <div class="panel" data-panel="actions">
      <button class="btn ok" data-action="accept">Accepter</button>
      ${edit}
      <button class="btn no" data-action="reject">Rejeter…</button>
    </div>
    ${proposal.op === null ? "" : renderEditor(proposal.op)}
    <div class="panel" data-panel="reject" hidden>
      <div class="chips">${chips.join("")}</div>
      <div class="row">
        <input data-reason type="text" placeholder="Pourquoi la rejeter ?" maxlength="200">
        <button class="btn no" data-action="confirm-reject">Confirmer le rejet</button>
        <button class="btn ghost" data-action="cancel">Annuler</button>
      </div>
    </div>
    <div class="err" data-error role="alert"></div>
    <div class="status" data-status></div>
  </footer>
</article>`;
}

const styles = `
:root {
  color-scheme: light;
  --bg: #f4f2ee; --panel: #ffffff; --ink: #1d1c1a; --muted: #6b6760; --line: #e3dfd8; --soft: #f7f5f1;
  --add-bg: #e6f4ea; --add-ink: #14532d; --del-bg: #fbe9e7; --del-ink: #7f1d1d;
  --ok: #15803d; --no: #b91c1c; --contest: #b45309;
  --k-missing: #2563eb; --k-ignored: #ea580c; --k-misplaced: #7c3aed; --k-conflict: #dc2626;
  --k-stale: #64748b; --k-tool-config: #0891b2; --k-watch: #a16207;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --bg: #151412; --panel: #1f1e1b; --ink: #ece9e3; --muted: #9c978e; --line: #34312c; --soft: #262420;
    --add-bg: #15301f; --add-ink: #a7e3b7; --del-bg: #3a1a17; --del-ink: #f4b4ab;
    --ok: #4ade80; --no: #f87171; --contest: #fbbf24;
    --k-missing: #60a5fa; --k-ignored: #fb923c; --k-misplaced: #a78bfa; --k-conflict: #f87171;
    --k-stale: #94a3b8; --k-tool-config: #22d3ee; --k-watch: #facc15;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
code, .diff, textarea, .path, .rule { font-family: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace; }
main { max-width: 980px; margin: 0 auto; padding: 20px 16px 48px; }
.head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.head h1 { font-size: 18px; margin: 0; letter-spacing: -0.01em; }
.head .meta { color: var(--muted); font-size: 13px; }
.head .progress { margin-left: auto; font-size: 13px; font-weight: 600; }
.card { --k: var(--k-stale); position: relative; background: var(--panel); border: 1px solid var(--line); border-left: 4px solid var(--k); border-radius: 10px; padding: 12px 14px; margin-bottom: 14px; }
.k-missing { --k: var(--k-missing); } .k-ignored { --k: var(--k-ignored); } .k-misplaced { --k: var(--k-misplaced); }
.k-conflict { --k: var(--k-conflict); } .k-stale { --k: var(--k-stale); } .k-tool-config { --k: var(--k-tool-config); } .k-watch { --k: var(--k-watch); }
.is-contest { outline: 2px dashed var(--contest); outline-offset: 3px; }
.contest { position: absolute; top: -11px; right: 14px; background: var(--contest); color: var(--panel); font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px; }
.top { display: grid; grid-template-columns: auto auto 1fr auto; gap: 10px; align-items: start; }
.rank { font-weight: 700; color: var(--muted); font-size: 13px; padding-top: 2px; }
.badge { justify-self: start; background: var(--k); color: var(--panel); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; padding: 3px 7px; border-radius: 5px; white-space: nowrap; }
.claim { font-size: 15px; font-weight: 650; margin: 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.stats { text-align: right; font-size: 12px; color: var(--muted); display: grid; gap: 3px; justify-items: end; }
.prev b { color: var(--ink); }
.strip { display: inline-flex; gap: 2px; }
.strip i { width: 5px; height: 12px; border-radius: 1px; background: var(--line); }
.strip .d1 { background: color-mix(in srgb, var(--k) 45%, var(--line)); }
.strip .d2 { background: color-mix(in srgb, var(--k) 75%, var(--line)); }
.strip .d3 { background: var(--k); }
.conf { font-weight: 600; } .c-low { color: var(--contest); }
.target { display: flex; gap: 8px; align-items: center; margin: 8px 0 8px 0; font-size: 12px; flex-wrap: wrap; }
.repo { font-weight: 700; } .path { color: var(--muted); }
.op { border: 1px solid var(--line); border-radius: 999px; padding: 0 8px; color: var(--muted); }
.diff { border: 1px solid var(--line); border-radius: 7px; overflow: hidden; font-size: 12.5px; }
.ln { padding: 1px 10px 1px 22px; text-indent: -22px; white-space: pre-wrap; word-break: break-word; }
.ln .sg { display: inline-block; width: 22px; text-indent: 0; text-align: center; color: var(--muted); user-select: none; }
.ln.add { background: var(--add-bg); color: var(--add-ink); } .ln.add .sg { color: var(--add-ink); }
.ln.del { background: var(--del-bg); color: var(--del-ink); } .ln.del .sg { color: var(--del-ink); }
.ln.same { color: var(--muted); } .ln.note { text-indent: 0; color: var(--muted); font-style: italic; }
.gap { text-align: center; color: var(--muted); background: var(--soft); font-size: 11px; }
.lbl { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin-right: 6px; }
.cited, .suggest { border: 1px solid var(--line); border-radius: 7px; padding: 7px 10px; }
.cited { margin-bottom: 6px; background: var(--soft); }
.cited .lbl, .suggest .lbl { display: block; margin-bottom: 2px; }
.rule { font-size: 12.5px; }
.suggest { border-style: dashed; }
.why { margin: 8px 0 4px; color: var(--muted); font-size: 13px; cursor: pointer; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; }
.why.open { display: block; }
.ev { font-size: 13px; }
.ev summary { cursor: pointer; display: flex; gap: 4px; align-items: baseline; list-style: none; }
.ev summary .lbl { white-space: nowrap; }
.ev summary::-webkit-details-marker { display: none; }
.ev summary::before { content: "▸"; color: var(--muted); width: 12px; }
.ev[open] summary::before { content: "▾"; }
.ev .teaser { color: var(--muted); font-style: italic; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.ev[open] .teaser { display: none; }
.ev.none { color: var(--muted); font-style: italic; }
.ev table { width: 100%; border-collapse: collapse; margin-top: 6px; }
.ev td { border-top: 1px solid var(--line); padding: 5px 6px; vertical-align: top; }
.ev .ses { width: 30%; font-weight: 600; } .ev .dt { width: 64px; color: var(--muted); white-space: nowrap; }
.ev .q { white-space: pre-wrap; word-break: break-word; }
.decide { margin-top: 10px; border-top: 1px solid var(--line); padding-top: 10px; }
.panel { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.panel[hidden] { display: none; }
.panel[data-panel="edit"], .panel[data-panel="reject"] { display: grid; gap: 8px; }
.panel[data-panel="edit"][hidden], .panel[data-panel="reject"][hidden] { display: none; }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.btn { font: inherit; font-weight: 600; border: 1px solid var(--line); background: var(--soft); color: var(--ink); border-radius: 7px; padding: 5px 12px; cursor: pointer; }
.btn:hover { border-color: var(--muted); }
.btn.ok { background: var(--ok); border-color: var(--ok); color: var(--panel); }
.btn.no { color: var(--no); border-color: color-mix(in srgb, var(--no) 45%, var(--line)); background: transparent; }
.btn.ghost { background: transparent; }
.btn:disabled { opacity: 0.5; cursor: progress; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chip { font: inherit; font-size: 12px; border: 1px solid var(--line); background: transparent; color: var(--muted); border-radius: 999px; padding: 2px 10px; cursor: pointer; }
.chip:hover { color: var(--ink); border-color: var(--muted); }
input[data-reason] { flex: 1; min-width: 220px; font: inherit; padding: 5px 8px; border: 1px solid var(--line); border-radius: 7px; background: var(--panel); color: var(--ink); }
textarea { width: 100%; font-size: 12.5px; padding: 8px; border: 1px solid var(--line); border-radius: 7px; background: var(--soft); color: var(--ink); resize: vertical; }
.err { color: var(--no); font-size: 13px; }
.err:empty, .status:empty { display: none; }
.status { font-size: 13px; }
.card[data-state] .body, .card[data-state] .why, .card[data-state] .ev, .card[data-state] .panel { display: none; }
.card[data-state] { opacity: 0.75; }
.card[data-state="accepted"] .status strong { color: var(--ok); }
.card[data-state="rejected"] .status strong { color: var(--no); }
.done { text-align: center; color: var(--muted); padding: 12px; border: 1px dashed var(--line); border-radius: 10px; }
.empty { text-align: center; color: var(--muted); padding: 40px 12px; }
@media (max-width: 640px) {
  .top { grid-template-columns: auto 1fr; }
  .claim { grid-column: 1 / -1; }
  .stats { grid-column: 1 / -1; justify-items: start; text-align: left; }
  .ev .ses { width: auto; }
}
`;

export function renderPage(input: PageInput): string {
  const cards = input.cards.map((card, index) => renderCard(card, index + 1, input));
  const meta = `Tour de ${plural(input.cards.length, "proposition", "propositions")} sur ${input.pendingTotal} en attente`;
  const content =
    cards.length === 0
      ? `<p class="empty">Aucune proposition en attente.</p>`
      : `${cards.join("\n")}
<p class="done" data-done hidden>Tour terminé. ${input.client.mode === "live" ? '<button class="btn" data-next>Tour suivant</button>' : "Fin de la maquette."}</p>`;
  const script = `(${reviewClient.toString()})(${JSON.stringify(input.client)});`;

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${input.nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<title>hindsight · revue</title>
<style>${styles}</style>
</head>
<body>
<main>
<div class="head">
  <h1>hindsight · revue</h1>
  <span class="meta">${meta}</span>
  <span class="progress" data-progress></span>
</div>
${content}
</main>
<script nonce="${input.nonce}">${script}</script>
</body>
</html>
`;
}
