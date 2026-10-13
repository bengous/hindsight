import type { ObservationNote, StaleRuleNote, SteerNote } from "../../src/domain/debrief.ts";
import type { HumanText, ToolUse, TurnFacts } from "../../src/domain/facts.ts";
import type { SignalName, SkipReason } from "../../src/domain/gate.ts";
import type { ProposalState } from "../../src/domain/proposal.ts";
import type { Point, Rect } from "./camera.ts";
import type { Leaf } from "./layout.ts";

import { defaultConfig } from "../../src/domain/config.ts";
import { parseDebrief } from "../../src/domain/debrief.ts";
import { unifiedDiff } from "../../src/domain/diff.ts";
import { addHumanText, addToolUses, emptyFacts, markInterrupted } from "../../src/domain/facts.ts";
import { classifierText, gateBrief, gateSignals, gateSkip } from "../../src/domain/gate.ts";
import { cleanHumanText, markersFor } from "../../src/domain/human.ts";
import { nextProposalState } from "../../src/domain/proposal.ts";
import { redactSecrets } from "../../src/domain/redact.ts";
import { collapseWhitespace, containsVerbatim } from "../../src/domain/text.ts";
import { FLOW, GUARDS } from "./data-product.ts";
import { elkNested } from "./layout.ts";
import { BRICK, cardSize, labelSize, subLines, textHeight } from "./measure.ts";
import { Sheet, union } from "./sheet.ts";
import { defs, el, esc, onActivate, rounded, text } from "./svg.ts";

function byId<E extends Element>(id: string, kind: new () => E): E {
  const e = document.getElementById(id);

  if (!(e instanceof kind)) {
    throw new TypeError(`page.html : #${id} manque ou n'est pas un ${kind.name}`);
  }

  return e;
}

const fr = (n: number, digits = 1): string =>
  n.toLocaleString("fr-FR", { minimumFractionDigits: digits, maximumFractionDigits: digits });

// ---------- the flow and its stepper ----------
const MARGIN = 24;

// The stepper's buttons are wired once; a rebuild swaps the drawing they drive.
let stepTo: (i: number) => void = () => {};

let flowObserver: ResizeObserver | null = null;

export async function mountFlow(): Promise<void> {
  const host = byId("flow", HTMLElement);
  const leaves: Leaf[] = FLOW.nodes.map((n) => ({ id: n.id, ...cardSize(BRICK, n.label, n.sub), group: null }));
  const edges = FLOW.edges.map((e) => ({ from: e.from, to: e.to, label: e.label, flip: false }));

  const laid = await elkNested(new Map(), new Map(), leaves, edges, labelSize, {
    "elk.direction": "RIGHT",
    "elk.layered.spacing.nodeNodeBetweenLayers": "46",
    "elk.spacing.nodeNode": "22",
  });

  const w = laid.w + 2 * MARGIN;
  const h = laid.h + 2 * MARGIN;
  const svg = el("svg", { role: "group", "aria-label": "Le flux d'un tour" }, null);
  defs(svg, "fl");
  const al = el("g", {}, svg);
  const nl = el("g", {}, svg);
  const nodeEls = new Map<string, SVGGElement>();
  const edgeEls = new Map<string, SVGGElement>();
  const stepText = byId("steptext", HTMLElement);
  const stepNo = byId("stepno", HTMLElement);
  const prev = byId("step-prev", HTMLButtonElement);
  const next = byId("step-next", HTMLButtonElement);
  const reset = byId("step-reset", HTMLButtonElement);
  let step = -1;

  const box = (id: string): Rect => {
    const b = laid.boxes.get(id);

    if (b === undefined) {
      throw new Error(`ELK n'a placé aucun nœud ${id}`);
    }

    return { x: b.x + MARGIN, y: b.y + MARGIN, w: b.w, h: b.h };
  };

  for (const n of FLOW.nodes) {
    const r = box(n.id);
    const lines = subLines(n.sub);
    const g = el("g", { class: `fl by-${n.by}` }, nl);
    el("rect", { x: r.x, y: r.y, width: r.w, height: r.h, rx: n.id === "nothing" ? r.h / 2 : 5, class: "box" }, g);
    const cx = r.x + r.w / 2;
    const top = r.y + r.h / 2 - textHeight(BRICK, lines.length) / 2 - 1;
    text(g, { x: cx, y: top + BRICK.ls * 0.8, class: BRICK.lbl, "text-anchor": "middle" }, n.label);

    for (const [i, line] of lines.entries()) {
      text(
        g,
        { x: cx, y: top + BRICK.ls + 5 + i * BRICK.lh + BRICK.ss * 0.85, class: BRICK.sub, "text-anchor": "middle" },
        line,
      );
    }

    onActivate(g, n.label, () => {
      for (const other of nodeEls.values()) {
        other.classList.remove("sel");
      }

      g.classList.add("sel");
      const by = { human: "vous", model: "modèle", code: "code", time: "délai" }[n.by];
      stepText.innerHTML = `<strong>${esc(n.label)}</strong><span class="tag">${by}</span><br>${n.info}`;
      stepNo.textContent = "";
    });

    nodeEls.set(n.id, g);
  }

  for (const [i, p] of laid.paths.entries()) {
    const e = FLOW.edges[i];

    if (e === undefined) {
      throw new Error(`ELK a rendu un tracé de trop ${i}`);
    }

    const g = el("g", { class: `fe ${e.kind ?? ""}`, "pointer-events": "none" }, al);
    const pts = p.pts.map(([x, y]): Point => [x + MARGIN, y + MARGIN]);
    const path = el("path", { d: rounded(pts, 6) }, g);
    path.setAttribute("marker-end", "url(#fl-arr)");

    if (p.label !== null) {
      text(
        g,
        { x: p.label.x + MARGIN + p.label.w / 2, y: p.label.y + MARGIN + 8, class: "elabel", "text-anchor": "middle" },
        e.label,
      );
    }

    edgeEls.set(e.id, g);
  }

  host.replaceChildren(svg);
  const sheet = new Sheet(svg);
  const all: Rect = { x: 0, y: 0, w, h };

  const frameOf = (ids: readonly string[]): Rect => {
    const u = union(ids.map(box));
    const grown = { x: u.x - 70, y: u.y - 40, w: u.w + 140, h: u.h + 80 };
    const minW = Math.min(w, 900);

    return grown.w >= minW ? grown : { ...grown, x: grown.x - (minW - grown.w) / 2, w: minW };
  };

  const setStep = (i: number): void => {
    step = i;
    const s = FLOW.steps[i];
    sheet.go(s === undefined ? sheet.frame(all, 10) : sheet.frame(frameOf(s.nodes), 0));

    for (const [id, g] of nodeEls) {
      g.classList.toggle("lit", s?.nodes.includes(id) ?? false);
      g.classList.remove("sel");
    }

    for (const [id, g] of edgeEls) {
      g.classList.toggle("lit", s?.edges.includes(id) ?? false);
    }

    stepText.innerHTML =
      s === undefined ? "Lancez le pas à pas : chaque étape allume la partie du flux qui travaille." : s.text;
    stepNo.textContent = s === undefined ? "" : `${i + 1} / ${FLOW.steps.length}`;
    prev.disabled = i <= 0;
    next.disabled = i >= FLOW.steps.length - 1;
    next.textContent = i < 0 ? "Commencer" : "Suivant";
  };

  stepTo = setStep;

  if (prev.dataset["wired"] !== "1") {
    prev.dataset["wired"] = "1";
    prev.addEventListener("click", () => {
      stepTo(Math.max(0, step - 1));
    });
    next.addEventListener("click", () => {
      stepTo(Math.min(FLOW.steps.length - 1, step + 1));
    });
    reset.addEventListener("click", () => {
      stepTo(-1);
    });
  }

  sheet.jump(sheet.frame(all, 10));
  setStep(-1);
  flowObserver?.disconnect();
  flowObserver = new ResizeObserver(() => {
    const s = FLOW.steps[step];
    sheet.jump(s === undefined ? sheet.frame(all, 10) : sheet.frame(frameOf(s.nodes), 0));
  });
  flowObserver.observe(svg);
}

// ---------- the Gate on the real code ----------
const SKIP_TEXT = {
  "non-interactive": "la session n'est pas interactive (un <code>claude -p</code>, un fork)",
  subagent:
    "le tour est celui d'un sous-agent ; dans le mod ce tour n'atteint jamais le Portail et rien n'est journalisé, seul le code du domaine répond ici",
  "turn-aborted": "vous avez interrompu le tour",
  "fork-running": "un Debrief de cette session est déjà en cours",
  "repo-excluded": "ce dépôt est dans <code>excludedRepos</code>",
  "daily-cap": "le plafond quotidien de Debriefs est atteint",
  cooldown: "refroidissement : trop tôt après le dernier Debrief de la session",
  quiet: "tour calme : aucun message humain et moins de trois outils",
} satisfies Record<SkipReason, string>;

const SIGNAL_TEXT = {
  human_marker: "marqueur dans un message humain",
  tool_refused: "un outil refusé",
  after_interrupt: "message après une interruption",
  rule_file_edit: "une Rule File éditée",
  many_edits: "au moins trois Edit/Write",
  tool_errors: "au moins deux erreurs d'outil",
  git_commit: "un git commit",
} satisfies Record<SignalName, string>;

const ALL_SIGNALS: readonly SignalName[] = [
  "human_marker",
  "tool_refused",
  "after_interrupt",
  "rule_file_edit",
  "many_edits",
  "tool_errors",
  "git_commit",
];

const SAMPLE_MESSAGE =
  "Non, pas de npm pour ça, c'est un dépôt pnpm. À l'avenir les installations de paquets passent toujours par pnpm.";

export function mountGate(): void {
  const host = byId("gate-sim", HTMLElement);

  host.innerHTML = `
<div class="card">
  <h3>Le tour</h3>
  <label class="field"><span>Votre message (le mod le nettoie et pose ses marqueurs)</span><textarea id="g-text" rows="3">${esc(SAMPLE_MESSAGE)}</textarea></label>
  <div class="marks" id="g-marks" style="margin:6px 0 10px"></div>
  <div class="fields">
    <label class="check"><input type="checkbox" id="g-first"> premier message de la session</label>
    <label class="check"><input type="checkbox" id="g-interrupt"> envoyé après une interruption</label>
    <label class="check"><input type="checkbox" id="g-refused" checked> un Bash refusé au tour précédent</label>
    <label class="check"><input type="checkbox" id="g-rule"> une Edit sur AGENTS.md</label>
    <label class="field"><span>Edit/Write dans le tour</span><input type="number" id="g-edits" min="0" max="20" value="1"></label>
    <label class="field"><span>Erreurs d'outil</span><input type="number" id="g-errors" min="0" max="20" value="0"></label>
    <label class="field"><span>git commit</span><input type="number" id="g-commits" min="0" max="10" value="0"></label>
    <label class="field"><span>Appels d'outil en tout</span><input type="number" id="g-tools" min="0" max="200" value="6"></label>
  </div>
  <h3 style="margin-top:14px">La session</h3>
  <div class="fields">
    <label class="field"><span>Nature</span><select id="g-kind"><option value="main">interactive, fil principal</option><option value="sub">sous-agent</option><option value="batch">non interactive</option></select></label>
    <label class="check"><input type="checkbox" id="g-aborted"> tour interrompu</label>
    <label class="check"><input type="checkbox" id="g-forking"> un fork tourne déjà</label>
    <label class="check"><input type="checkbox" id="g-excluded"> dépôt exclu</label>
    <label class="field"><span>Debriefs déjà faits dans la session</span><input type="number" id="g-inses" min="0" max="20" value="0"></label>
    <label class="field"><span>Minutes depuis le dernier (vide : aucun)</span><input type="number" id="g-since" min="0" max="600" value=""></label>
    <label class="field"><span>Debriefs aujourd'hui</span><input type="number" id="g-today" min="0" max="50" value="3"></label>
  </div>
</div>
<div class="card">
  <h3>Ce que le code décide</h3>
  <div class="outcome" id="g-out"></div>
</div>`;

  const q = <E extends Element>(id: string, kind: new () => E): E => byId(id, kind);
  const num = (id: string): number => Number(q(id, HTMLInputElement).value) || 0;
  const on = (id: string): boolean => q(id, HTMLInputElement).checked;

  const render = (): void => {
    const config = defaultConfig;
    const raw = q("g-text", HTMLTextAreaElement).value;
    const clean = cleanHumanText(raw);
    let facts: TurnFacts = on("g-first") ? emptyFacts : addHumanText(emptyFacts, "ok");

    if (on("g-interrupt")) {
      facts = markInterrupted(facts);
    }

    const refusedFirst: ToolUse[] = on("g-refused")
      ? [{ tool: "Bash", path: null, command: "npm install dayjs", isError: true, isRefused: true }]
      : [];

    facts = addToolUses(facts, refusedFirst);
    facts = addHumanText(facts, clean);
    const uses: ToolUse[] = [];
    const edits = num("g-edits");

    for (let i = 0; i < edits; i += 1) {
      uses.push({
        tool: "Edit",
        path: i === 0 && on("g-rule") ? "/repo/AGENTS.md" : `/repo/src/file${i}.ts`,
        command: null,
        isError: false,
        isRefused: false,
      });
    }

    for (let i = 0; i < num("g-errors"); i += 1) {
      uses.push({ tool: "Bash", path: null, command: "bun test", isError: true, isRefused: false });
    }

    for (let i = 0; i < num("g-commits"); i += 1) {
      uses.push({ tool: "Bash", path: null, command: "git commit -m x", isError: false, isRefused: false });
    }

    const others = Math.max(0, num("g-tools") - uses.length - refusedFirst.length);

    for (let i = 0; i < others; i += 1) {
      uses.push({ tool: "Read", path: "/repo/README.md", command: null, isError: false, isRefused: false });
    }

    facts = addToolUses(facts, uses);
    const markers = facts.humanTexts.flatMap((t: HumanText) => t.markers);
    q("g-marks", HTMLElement).innerHTML =
      markers.length === 0
        ? `<span class="note">aucun marqueur</span>`
        : markers.map((m) => `<span class="mark">${esc(m)}</span>`).join("");

    const kind = q("g-kind", HTMLSelectElement).value;
    const sinceRaw = q("g-since", HTMLInputElement).value;
    const now = 1_000_000_000;

    const skip = gateSkip(
      {
        isInteractive: kind !== "batch",
        agentId: kind === "sub" ? "agent-1" : null,
        isAborted: on("g-aborted"),
        forkRunning: on("g-forking"),
        repoRoot: "/repo",
        lastDebriefAt: sinceRaw === "" ? null : now - Number(sinceRaw) * 60_000,
        debriefsInSession: num("g-inses"),
        debriefsToday: num("g-today"),
        now,
      },
      facts,
      on("g-excluded") ? { ...config, excludedRepos: ["/repo"] } : config,
    );

    const signals = gateSignals(facts);
    const found = new Map(signals.signals.map((s) => [s.name, s]));

    const rows = ALL_SIGNALS.map((name) => {
      const s = found.get(name);

      return `<div class="sig${s === undefined ? " skipped" : ""}"><span class="w">${s === undefined ? "–" : fr(s.weight)}</span><span>${SIGNAL_TEXT[name]}${s === undefined ? "" : ` <span class="note">${esc(s.detail)}</span>`}</span></div>`;
    }).join("");

    const cooldown = config.gate.cooldownMs * Math.min(Math.max(num("g-inses"), 1), config.gate.cooldownMaxSteps);
    const passes = signals.score >= config.gate.threshold;
    const brief = gateBrief(signals, facts);
    let verdict: string;

    if (skip !== null) {
      verdict = `<p><span class="verdict skip">saut direct : ${esc(skip)}</span></p><p>${SKIP_TEXT[skip]}. Rien d'autre n'est calculé ; la décision est journalisée avec cette raison.</p>`;
    } else if (passes) {
      verdict = `<p><span class="verdict pass">ouvert : le classifieur tranche</span></p><p>Score ${fr(signals.score)} ≥ ${fr(config.gate.threshold)}. Le mod prend le verrou de fork, puis demande au classifieur depuis un minuteur.</p>`;
    } else {
      verdict = `<p><span class="verdict skip">fermé : sous le seuil</span></p><p>Score ${fr(signals.score)} contre un seuil de ${fr(config.gate.threshold)}. Journalisé, aucun modèle appelé.</p>`;
    }

    q("g-out", HTMLElement).innerHTML = [
      verdict,
      `<div class="row"><span class="score">${fr(signals.score)}</span><span class="note">seuil ${fr(config.gate.threshold)} · refroidissement ${fr(cooldown / 1000, 0)} s · plafond ${config.gate.dailyCap}/jour · calme sous ${config.gate.quietMinTools} outils</span></div>`,
      `<div class="sigs">${rows}</div>`,
      `<details><summary>Le brief envoyé au classifieur puis au Debrief</summary><pre>${esc(brief)}</pre></details>`,
      `<details><summary>Le texte complet du classifieur</summary><pre>${esc(classifierText(brief, facts))}</pre></details>`,
    ].join("");
  };

  host.addEventListener("input", render);
  host.addEventListener("change", render);
  render();
}

// ---------- the Debrief's verification ----------
const SAMPLE_HUMAN =
  "Non, pas de npm pour ça, c'est un dépôt pnpm. Les installations de paquets passent toujours par pnpm, merci.";

const SAMPLE_TOOL =
  "Bash · npm --prefix /home/u/atelier install dayjs@1.11.13\nTool result: user rejected this tool use";

const SAMPLE_ANSWER = `\`\`\`json
{
  "steers": [
    { "quote": "pas de npm pour ça, c'est un dépôt pnpm", "lesson": "Install packages with pnpm instead of npm.", "habit": true }
  ],
  "observations": [
    { "question": 4, "tool": "Bash", "excerpt": "npm install dayjs@1.11.13", "lesson": "State the package manager of the repository.", "rulePath": null }
  ],
  "staleRules": []
}
\`\`\``;

function steerCell(ok: boolean, fromTool: boolean): string {
  if (ok) {
    return '<span class="pill ok">quote trouvée</span><br><span class="note">id de preuve fabriqué, message entier stocké</span>';
  }

  return fromTool
    ? '<span class="pill deny">quote-from-tool</span><br><span class="note">la citation vient d\'une sortie d\'outil, pas d\'un message humain</span>'
    : '<span class="pill deny">quote-missing</span><br><span class="note">pas mot pour mot dans un message humain</span>';
}

type NoteRow = { readonly ok: boolean; readonly html: string };

function steerRow(s: SteerNote, human: string, tool: string): NoteRow {
  const ok = containsVerbatim(human, s.quote);
  const fromTool = !ok && containsVerbatim(tool, s.quote);

  return {
    ok,
    html: `<tr><td>Steer${s.habit ? " · habitude" : " · cas unique"}</td><td><span class="mono">« ${esc(s.quote)} »</span><br><span class="note">${esc(s.lesson)}</span></td><td>${steerCell(ok, fromTool)}</td></tr>`,
  };
}

function observationRow(o: ObservationNote, toolName: string, tool: string): NoteRow {
  const ok = o.tool === toolName && collapseWhitespace(o.excerpt).length >= 12 && containsVerbatim(tool, o.excerpt);

  return {
    ok,
    html: `<tr><td>Observation · q${o.question}</td><td><span class="mono">${esc(o.tool)} : « ${esc(o.excerpt)} »</span><br><span class="note">${esc(o.lesson)}</span></td><td>${ok ? '<span class="pill ok">appel retrouvé</span>' : '<span class="pill deny">observation-missing</span><br><span class="note">outil ou extrait absent du transcript</span>'}</td></tr>`,
  };
}

const staleRow = (r: StaleRuleNote): string =>
  `<tr><td>Stale Rule</td><td><span class="mono">${esc(r.ruleFile)}</span><br><span class="note">${esc(r.lesson)}</span></td><td><span class="pill">non simulée : vérifiée contre l'édition réelle et le fichier</span></td></tr>`;

export function mountVerify(): void {
  const host = byId("verify-sim", HTMLElement);

  host.innerHTML = `
<div class="card">
  <h3>Ce que le transcript contient</h3>
  <label class="field"><span>Votre message (Human Message)</span><textarea id="v-human" rows="3">${esc(SAMPLE_HUMAN)}</textarea></label>
  <label class="field" style="margin-top:8px"><span>Un appel d'outil du tour (nom et texte)</span><textarea id="v-tool" rows="3">${esc(SAMPLE_TOOL)}</textarea></label>
  <h3 style="margin-top:14px">Ce que le Debrief répond</h3>
  <label class="field"><span>Un bloc JSON, lu par <code>parseDebrief</code></span><textarea id="v-answer" rows="12">${esc(SAMPLE_ANSWER)}</textarea></label>
</div>
<div class="card">
  <h3>Ce que <code>debrief record</code> garde</h3>
  <div class="outcome" id="v-out"></div>
  <h3 style="margin-top:18px">La part de cache du fork</h3>
  <p class="note">Mesurée sur l'usage du fork : <code>cache_read / (cache_read + input + cache_creation)</code>. Plancher ${fr(defaultConfig.gate.minCacheShare, 2)}.</p>
  <div class="fields">
    <label class="field"><span>cache_read_input_tokens</span><input type="number" id="c-read" min="0" value="48200"></label>
    <label class="field"><span>input_tokens</span><input type="number" id="c-input" min="0" value="620"></label>
    <label class="field"><span>cache_creation_input_tokens</span><input type="number" id="c-creation" min="0" value="260"></label>
  </div>
  <div class="outcome" id="c-out"></div>
</div>`;

  const render = (): void => {
    const human = byId("v-human", HTMLTextAreaElement).value;
    const tool = byId("v-tool", HTMLTextAreaElement).value;
    const parsed = parseDebrief(byId("v-answer", HTMLTextAreaElement).value);
    const out = byId("v-out", HTMLElement);

    if (!parsed.ok) {
      out.innerHTML = `<p><span class="verdict fail">Debrief en échec : ${esc(parsed.reason)}</span></p><p>${esc(parsed.detail)}. La ligne du Debrief passe en échec, rien n'est stocké.</p>`;

      return;
    }

    const toolName = (tool.split("\n")[0] ?? "").split(" · ")[0]?.trim() ?? "";
    const steerRows = parsed.notes.steers.map((s) => steerRow(s, human, tool));
    const observationRows = parsed.notes.observations.map((o) => observationRow(o, toolName, tool));
    const kept = steerRows.filter((r) => r.ok).length + observationRows.filter((r) => r.ok).length;
    const dropped = steerRows.length + observationRows.length - kept;
    const stale = parsed.notes.staleRules.length;

    const rows = [
      ...steerRows.map((r) => r.html),
      ...observationRows.map((r) => r.html),
      ...parsed.notes.staleRules.map(staleRow),
    ];

    out.innerHTML = [
      `<p><span class="verdict ${dropped === 0 ? "pass" : "skip"}">${kept} gardée${kept > 1 ? "s" : ""}, ${dropped} rejetée${dropped > 1 ? "s" : ""}${stale > 0 ? `, ${stale} Stale Rule${stale > 1 ? "s" : ""} non simulée${stale > 1 ? "s" : ""}` : ""}</span></p>`,
      rows.length === 0
        ? `<p class="note">Aucune Note : des listes vides sont une réponse valable.</p>`
        : `<div class="tablewrap"><table><thead><tr><th>Note</th><th>Contenu</th><th>Vérification</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`,
      `<p class="note">Ce qui est rejeté est compté sur la ligne du Debrief (<code>debriefs</code>), jamais stocké comme Note. Ici l'extrait de l'Observation a été raccourci (le <code>--prefix /home/u/atelier</code> manque) : remplacez-le par le texte exact de l'appel pour le voir accepté.</p>`,
    ].join("");
  };

  const renderCache = (): void => {
    const read = Number(byId("c-read", HTMLInputElement).value) || 0;
    const input = Number(byId("c-input", HTMLInputElement).value) || 0;
    const creation = Number(byId("c-creation", HTMLInputElement).value) || 0;
    const total = read + input + creation;
    const share = total === 0 ? 0 : read / total;
    const ok = share >= defaultConfig.gate.minCacheShare;
    byId("c-out", HTMLElement).innerHTML =
      `<div class="row"><span class="score">${fr(share, 3)}</span><span class="verdict ${ok ? "pass" : "fail"}">${ok ? "Debrief enregistré" : "Debrief en erreur : cache rebâti"}</span></div><p class="note">${ok ? "Le préfixe est venu du cache de la session : le fork n'a rien relu." : "Le fork a payé le préfixe au prix fort : hindsight le signale comme une erreur, jamais comme un coût à absorber (ADR 0003)."}</p>`;
  };

  host.addEventListener("input", () => {
    render();
    renderCache();
  });
  render();
  renderCache();
}

// ---------- Learn's counting ----------
type SampleNote = {
  readonly id: string;
  readonly lesson: string;
  readonly session: string;
  readonly day: string;
  readonly repo: string;
  readonly quote: string;
};

const SAMPLE_NOTES: readonly SampleNote[] = [
  {
    id: "n1",
    lesson: "Install packages with pnpm.",
    session: "s-41",
    day: "2026-10-02",
    repo: "atelier",
    quote: "pas de npm pour ça, c'est un dépôt pnpm",
  },
  {
    id: "n2",
    lesson: "Install packages with pnpm.",
    session: "s-47",
    day: "2026-10-05",
    repo: "atelier",
    quote: "ajoute dayjs avec pnpm",
  },
  {
    id: "n3",
    lesson: "Install packages with pnpm.",
    session: "s-52",
    day: "2026-10-09",
    repo: "atelier",
    quote: "une dépendance de plus, avec pnpm",
  },
  {
    id: "n4",
    lesson: "Install packages with pnpm.",
    session: "s-58",
    day: "2026-10-09",
    repo: "carnet",
    quote: "à l'avenir, pas de npm pour ça",
  },
  {
    id: "n5",
    lesson: "Install packages with pnpm.",
    session: "s-61",
    day: "2026-10-12",
    repo: "jardin",
    quote: "avec pnpm, pas de npm",
  },
];

const NO_CONTEXT = { isFirstPrompt: false, afterInterrupt: false, rejectedTools: [] } as const;

function thresholdText(recurrent: boolean, explicit: boolean): string {
  if (recurrent) {
    return "passe : 3 sessions et 2 jours au moins";
  }

  return explicit
    ? "passe : une Steer explicite (marqueur standing_instruction)"
    : "below-threshold : le candidat est rejeté, les Notes restent en attente";
}

const VERDICT_TEXT: ReadonlyArray<readonly [string, string]> = [
  ["missing", "aucune règle ne le dit"],
  ["ignored", "une règle chargée le dit et l'agent l'a enfreinte"],
  ["misplaced", "une règle le dit mais n'était pas chargée au bon moment"],
  ["conflict", "une Steer contredit une règle"],
  ["unclear", "une règle chargée le dit en des mots qui ont trompé l'agent"],
  ["hold", "trop faible pour agir : attend la récurrence"],
];

export function mountLearn(): void {
  const host = byId("learn-sim", HTMLElement);

  host.innerHTML = `
<div class="card">
  <h3>Cinq Notes sur une même Lesson</h3>
  <p class="note">Cochez celles qui attendent : le code compte la Prevalence, applique le seuil (3 sessions et 2 jours, ou une Steer explicite) et place la cible.</p>
  <div class="tablewrap"><table><thead><tr><th></th><th>Session · jour · dépôt</th><th>Quote</th></tr></thead><tbody>${SAMPLE_NOTES.map(
    (n) =>
      `<tr><td><input type="checkbox" id="l-${n.id}" ${n.repo === "atelier" ? "checked" : ""}></td><td class="mono">${esc(n.session)} · ${esc(n.day)} · ${esc(n.repo)}</td><td>« ${esc(n.quote)} »</td></tr>`,
  ).join("")}</tbody></table></div>
  <div class="outcome" id="l-out"></div>
</div>
<div class="card">
  <h3>Ce que le code garde en main</h3>
  <ul>
    <li>Les ids de preuve viennent des Notes, jamais du modèle ; un id inconnu rejette le candidat.</li>
    <li>La Prevalence est recomptée en sessions, jours et dépôts distincts.</li>
    <li>Une cible globale demande des Steers d'au moins deux dépôts, ou une consigne énoncée pour tous.</li>
    <li>Jamais de Watch Task comme règle : un hook ou un contrôle passe par un Handoff.</li>
    <li>Une modification exacte doit s'appliquer une seule fois sur le fichier courant.</li>
    <li>Une empreinte rejetée au Ledger ne revient qu'avec plus de sessions qu'au rejet.</li>
  </ul>
  <h3 style="margin-top:14px">Les Verdicts</h3>
  <dl class="facts">${VERDICT_TEXT.map(([v, t]) => `<dt><code>${v}</code></dt><dd style="font-family:var(--f-body);font-size:14px">${t}</dd>`).join("")}</dl>
</div>`;

  const render = (): void => {
    const picked = SAMPLE_NOTES.filter((n) => byId(`l-${n.id}`, HTMLInputElement).checked);
    const sessions = new Set(picked.map((n) => n.session)).size;
    const days = new Set(picked.map((n) => n.day)).size;
    const repos = [...new Set(picked.map((n) => n.repo))];
    const out = byId("l-out", HTMLElement);

    if (picked.length === 0) {
      out.innerHTML = `<p class="note">Aucune Note : rien à proposer.</p>`;

      return;
    }

    const scope = repos.length >= 2 ? "globale : ~/.claude/AGENTS.md" : `dépôt : ${repos[0] ?? ""}/AGENTS.md`;
    const explicit = picked.some((n) => markersFor(n.quote, NO_CONTEXT).includes("standing_instruction"));
    const gate = thresholdText(sessions >= 3 && days >= 2, explicit);
    out.innerHTML = [
      `<dl class="facts"><dt>Prevalence</dt><dd>${sessions} session${sessions > 1 ? "s" : ""} · ${days} jour${days > 1 ? "s" : ""} · ${repos.length} dépôt${repos.length > 1 ? "s" : ""}</dd><dt>Cible</dt><dd>${esc(scope)}</dd><dt>Seuil</dt><dd>${esc(gate)}</dd></dl>`,
      `<p class="note">${repos.length >= 2 ? "Deux dépôts au moins : Learn ajoute un groupe de consolidation globale, restreint aux cibles globales." : "Un seul dépôt : la Proposal vise ses Rule Files, path-scoped quand cela convient."}</p>`,
    ].join("");
  };

  host.addEventListener("change", render);
  render();
}

// ---------- the Review pane ----------
const PROPOSAL = {
  id: "p-7f3a",
  target: "/home/u/atelier/AGENTS.md",
  subject: "Add the package manager rule",
  claim: "Le dépôt installe avec pnpm : l'AGENTS.md du dépôt ne le dit pas.",
  verdict: "missing",
  prevalence: "3 sessions · 3 jours · 1 dépôt",
  oldText: "- Run the formatter before a commit.",
  newText: "- Run the formatter before a commit.\n- Install packages with pnpm; npm writes a second lockfile.",
  reasoning:
    "Trois sessions sur trois jours vous ont vu refuser npm pour une installation. Aucune règle du dépôt ne le dit ; l'agent redemande à chaque fois.",
  lesson: "Install packages with pnpm.",
  quotes: [
    {
      session: "s-41",
      day: "2026-10-02",
      quote: "pas de npm pour ça, c'est un dépôt pnpm",
      message:
        "Non, pas de npm pour ça, c'est un dépôt pnpm. Le token c'est GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 pour le script, ne l'affiche pas.",
    },
    {
      session: "s-47",
      day: "2026-10-05",
      quote: "ajoute dayjs avec pnpm",
      message: "Tu peux y aller, ajoute dayjs avec pnpm.",
    },
    {
      session: "s-52",
      day: "2026-10-09",
      quote: "avec pnpm",
      message: "Une dépendance de plus, avec pnpm stp.",
    },
  ],
};

function diffClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) {
    return "hdr";
  }

  if (line.startsWith("+")) {
    return "add";
  }

  return line.startsWith("-") ? "del" : "";
}

export function mountReview(): void {
  const host = byId("review-sim", HTMLElement);
  let state: ProposalState = "pending";
  let draft = PROPOSAL.newText;
  let mode: "idle" | "edit" | "reject" = "idle";
  let consequence = "";

  const diffHtml = (): string =>
    unifiedDiff(PROPOSAL.target, [{ oldText: PROPOSAL.oldText, newText: draft }])
      .split("\n")
      .map((l) => `<div class="${diffClass(l)}">${esc(l)}</div>`)
      .join("");

  const commitMessage = (): string =>
    [
      PROPOSAL.subject,
      ``,
      PROPOSAL.lesson,
      ``,
      `Evidence: 3 sessions, 3 days, 1 repo`,
      `hindsight proposal ${PROPOSAL.id}`,
    ].join("\n");

  const render = (): void => {
    const pending = state === "pending";

    const quotes = PROPOSAL.quotes
      .map(
        (q) =>
          `<details><summary>« ${esc(q.quote)} » <span class="note">${esc(q.session)} · ${esc(q.day)}</span></summary><div class="quote"><span class="who">Human Message, secrets masqués</span><br>${esc(redactSecrets(q.message))}</div></details>`,
      )
      .join("");

    const editor =
      mode === "edit"
        ? `<label class="field" style="margin-top:8px"><span>Nouveau texte (⏎ marque un saut de ligne dans le panneau)</span><textarea id="r-draft" rows="3">${esc(draft)}</textarea></label><div class="keys"><button type="button" data-act="edit-ok"><b>A</b>ppliquer et accepter</button><button type="button" data-act="cancel">Annuler</button></div>`
        : "";

    const reason =
      mode === "reject"
        ? `<div class="reason"><input type="text" id="r-reason" placeholder="La raison, obligatoire : elle nourrit le Ledger"><button type="button" class="btn" data-act="reject-ok">Rejeter</button><button type="button" class="btn" data-act="cancel">Annuler</button></div>`
        : "";

    host.innerHTML = `
<div class="pane" aria-label="Maquette du panneau de Review">
  <div><span class="ph">hindsight · Proposal 1/3</span> · <span class="state-chip">${esc(state)}</span></div>
  <div style="margin-top:6px"><b>Cible</b> ${esc(PROPOSAL.target)}</div>
  <div><b>Verdict</b> ${esc(PROPOSAL.verdict)} · <b>Prevalence</b> ${esc(PROPOSAL.prevalence)}</div>
  <div style="margin-top:6px">${esc(PROPOSAL.claim)}</div>
  <div class="diff">${diffHtml()}</div>
  <div>${esc(PROPOSAL.reasoning)}</div>
  <div style="margin-top:8px"><b>Preuves</b></div>
  ${quotes}
  ${editor}
  ${reason}
  <div class="keys">
    <button type="button" data-act="accept" ${pending && mode === "idle" ? "" : "disabled"}><b>A</b>ccepter</button>
    <button type="button" data-act="edit" ${pending && mode === "idle" ? "" : "disabled"}><b>M</b>odifier</button>
    <button type="button" data-act="reject" ${pending && mode === "idle" ? "" : "disabled"}><b>R</b>ejeter</button>
    <button type="button" data-act="handoff" ${pending && mode === "idle" ? "" : "disabled"}><b>H</b>andoff</button>
    <button type="button" data-act="reset">Recommencer</button>
  </div>
</div>
<div class="card">
  <h3>Ce que le CLI fait de votre décision</h3>
  <div class="outcome">${consequence === "" ? `<p class="note">Pressez une touche du panneau : chaque pression appelle <code>review decide</code>, qui applique et consigne.</p>` : consequence}</div>
</div>`;
  };

  const decide = (event: "accept" | "reject" | "handoff", detail: string): void => {
    const next = nextProposalState(state, event);

    if (next === null) {
      consequence = `<p><span class="verdict fail">refusé</span></p><p><code>nextProposalState(${esc(state)}, ${event})</code> rend <code>null</code> : seule une Proposal en attente bouge.</p>`;
    } else {
      state = next;
      consequence = detail;
    }

    mode = "idle";
    render();
  };

  host.addEventListener("click", (e) => {
    const b = e.target instanceof Element ? e.target.closest("[data-act]") : null;

    if (!(b instanceof HTMLButtonElement)) {
      return;
    }

    const act = b.dataset["act"] ?? "";

    if (act === "reset") {
      state = "pending";
      draft = PROPOSAL.newText;
      mode = "idle";
      consequence = "";
      render();
    } else if (act === "edit") {
      mode = "edit";
      render();
    } else if (act === "reject") {
      mode = "reject";
      render();
    } else if (act === "cancel") {
      mode = "idle";
      render();
    } else if (act === "edit-ok") {
      draft = byId("r-draft", HTMLTextAreaElement).value;
      decide(
        "accept",
        `<p><span class="verdict pass">accepted</span> avec votre texte</p><p>La décision est écrite d'abord (la Proposal est réservée), puis la modification exacte s'applique une fois sur le fichier courant, puis un commit du seul fichier, hooks du dépôt actifs, jamais poussé. Un hook qui refuse restaure le fichier et libère la Proposal.</p><pre>${esc(commitMessage())}</pre><p class="note">Le message est contrôlé contre les preuves brutes : il ne peut porter aucune Quote.</p>`,
      );
    } else if (act === "accept") {
      decide(
        "accept",
        `<p><span class="verdict pass">accepted</span></p><p>La décision est écrite d'abord (la Proposal est réservée), puis la modification exacte s'applique une fois sur le fichier courant, puis un commit du seul fichier, hooks du dépôt actifs, jamais poussé. Un hook qui refuse restaure le fichier et libère la Proposal.</p><pre>${esc(commitMessage())}</pre><dl class="facts ledger"><dt>Ledger</dt><dd>accepted · ${esc(PROPOSAL.id)} · sessions_at_decision 3 · sha du commit</dd></dl>`,
      );
    } else if (act === "reject-ok") {
      const reason = byId("r-reason", HTMLInputElement).value.trim();

      if (reason === "") {
        byId("r-reason", HTMLInputElement).focus();

        return;
      }

      decide(
        "reject",
        `<p><span class="verdict skip">rejected</span></p><dl class="facts ledger"><dt>Ledger</dt><dd>rejected · ${esc(PROPOSAL.id)} · « ${esc(reason)} »</dd><dt>Empreinte</dt><dd>sha1(cible + Lesson normalisée) · sessions_at_decision 3</dd></dl><p>Learn relit le Ledger : la même empreinte ne revient qu'avec plus de sessions qu'au rejet, et la raison entre dans son prompt. Prune et le chemin des Stale Rules, eux, la bloquent pour toujours.</p>`,
      );
    } else if (act === "handoff") {
      decide(
        "handoff",
        `<p><span class="verdict pass">handed_off</span></p><p>La Proposal rejoint le Handoff en attente. <code>/hindsight handoff</code> remplit ensuite votre prompt, sans Quote ; vous lancez la session qui l'exécute.</p><pre>${esc(`hindsight handoff: apply the following Rule File changes, one commit per file, without pushing. Each change was reviewed by the human; carry it out as written and say what you changed.\n\n## 1. ${PROPOSAL.target}\n\n${PROPOSAL.claim}\n\nLesson: ${PROPOSAL.lesson}\n\nReplace:\n${PROPOSAL.oldText}\nwith:\n${PROPOSAL.newText}`)}</pre>`,
      );
    }
  });

  render();
}

export function mountGuards(): void {
  const body = byId("guards", HTMLTableElement).tBodies[0];

  if (body === undefined) {
    throw new Error("page.html : #guards sans tbody");
  }

  body.innerHTML = GUARDS.map(
    ([g, h, w]) => `<tr><td><strong>${g}</strong></td><td>${h}</td><td class="mono">${esc(w)}</td></tr>`,
  ).join("");
}
