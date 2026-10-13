import type { Point, Rect } from "./camera.ts";
import type { Leaf } from "./layout.ts";
import type { Size } from "./measure.ts";
import type { Actor, MState, MTransition, Machine } from "./model.ts";
import type { Registry } from "./svg.ts";

import { elkNested } from "./layout.ts";
import { STATE, labelSize, stateSize, subLines, textHeight } from "./measure.ts";
import { el, esc, onActivate, register, rounded, text } from "./svg.ts";

export type MachineEvent =
  | { readonly type: "state"; readonly id: string }
  | { readonly type: "transition"; readonly id: string };

export type TransitionEl = {
  readonly t: MTransition;
  readonly g: SVGGElement;
  readonly path: SVGPathElement;
};

export type MachineDrawing = {
  readonly size: Size;
  readonly rects: ReadonlyMap<string, Rect>;
  readonly stateEls: Registry;
  readonly arrows: readonly TransitionEl[];
};

export type Player = {
  readonly at: string;
  readonly picked: string | null;
  readonly log: readonly string[];
};

const MARGIN = 30;

const START = "~start";

export const ACTOR_LABEL: Readonly<Record<Actor, string>> = {
  human: "vous",
  model: "un modèle",
  code: "du code",
  time: "le temps",
};

export function stateOf(m: Machine, id: string): MState {
  const s = m.states.find((x) => x.id === id);

  if (s === undefined) {
    throw new Error(`machine ${m.id} : état inconnu ${id}`);
  }

  return s;
}

export function transitionOf(m: Machine, id: string): MTransition {
  const t = m.transitions.find((x) => x.id === id);

  if (t === undefined) {
    throw new Error(`machine ${m.id} : transition inconnue ${id}`);
  }

  return t;
}

export const outgoing = (m: Machine, at: string): MTransition[] => m.transitions.filter((t) => t.from === at);

export const freshPlayer = (m: Machine): Player => ({ at: m.initial, picked: null, log: [] });

export function play(m: Machine, p: Player, ev: MachineEvent): Player {
  if (ev.type === "state") {
    return { ...p, picked: null, at: ev.id };
  }

  const t = transitionOf(m, ev.id);

  if (t.from !== p.at) {
    return { ...p, picked: t.id };
  }

  return {
    at: t.to,
    picked: t.id,
    log: [...p.log, `${stateOf(m, t.from).label} → ${t.event} → ${stateOf(m, t.to).label}`],
  };
}

function cornerOf(s: MState, r: Rect): number {
  if (s.kind === "outcome") {
    return r.h / 2;
  }

  return s.kind === "check" ? 2 : 8;
}

function drawState(layer: SVGGElement, s: MState, r: Rect, pick: (ev: MachineEvent) => void): SVGGElement {
  const lines = subLines(s.sub ?? "");
  const g = el("g", { class: `state k-${s.kind ?? "plain"}` }, layer);
  const rx = cornerOf(s, r);
  el("rect", { x: r.x, y: r.y, width: r.w, height: r.h, rx, class: "box" }, g);

  if (s.kind === "final") {
    el(
      "rect",
      { x: r.x + 3, y: r.y + 3, width: r.w - 6, height: r.h - 6, rx: Math.max(0, rx - 3), class: "box inner" },
      g,
    );
  }

  const cx = r.x + r.w / 2;
  const top = r.y + r.h / 2 - textHeight(STATE, lines.length) / 2 - 1;
  text(g, { x: cx, y: top + STATE.ls * 0.8, class: STATE.lbl, "text-anchor": "middle" }, s.label);

  for (const [i, line] of lines.entries()) {
    const y = top + STATE.ls + 5 + i * STATE.lh + STATE.ss * 0.85;
    text(g, { x: cx, y, class: STATE.sub, "text-anchor": "middle" }, line);
  }

  onActivate(g, s.label, () => {
    pick({ type: "state", id: s.id });
  });

  return g;
}

export async function drawMachine(
  layer: SVGGElement,
  m: Machine,
  pick: (ev: MachineEvent) => void,
): Promise<MachineDrawing> {
  const leaves: Leaf[] = [
    { id: START, w: 14, h: 14, group: null },
    ...m.states.map((s) => ({ id: s.id, ...stateSize(s), group: null })),
  ];

  const edges = [
    { from: START, to: m.initial, label: "", flip: false },
    ...m.transitions.map((t) => ({ from: t.from, to: t.to, label: t.event, flip: false })),
  ];

  const laid = await elkNested(new Map(), new Map(), leaves, edges, labelSize, {
    "elk.direction": m.direction,
    "elk.layered.spacing.nodeNodeBetweenLayers": "64",
    "elk.spacing.nodeNode": "36",
    "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
    "elk.layered.cycleBreaking.strategy": "MODEL_ORDER",
  });

  const shift = (b: Rect): Rect => ({ x: b.x + MARGIN, y: b.y + MARGIN, w: b.w, h: b.h });

  const box = (id: string): Rect => {
    const b = laid.boxes.get(id);

    if (b === undefined) {
      throw new Error(`ELK n'a placé aucun état ${id}`);
    }

    return shift(b);
  };

  const al = el("g", {}, layer);
  const sl = el("g", {}, layer);
  const rects = new Map<string, Rect>();
  const stateEls: Registry = new Map();
  const start = box(START);
  el("circle", { cx: start.x + 7, cy: start.y + 7, r: 6, class: "start" }, sl);

  for (const s of m.states) {
    rects.set(s.id, box(s.id));
    register(stateEls, s.id, drawState(sl, s, box(s.id), pick));
  }

  const arrows = laid.paths.flatMap((p, i): TransitionEl[] => {
    const pts = p.pts.map(([x, y]): Point => [x + MARGIN, y + MARGIN]);
    const d = rounded(pts, 7);

    if (i === 0) {
      const g0 = el("g", { class: "tr by-code", "pointer-events": "none" }, al);
      const path0 = el("path", { d }, g0);
      path0.setAttribute("marker-end", "url(#mc-arr)");

      return [];
    }

    const t = m.transitions[i - 1];

    if (t === undefined) {
      throw new Error(`ELK a rendu un tracé de trop ${i}`);
    }

    const g = el("g", { class: `tr by-${t.by}` }, al);
    el("path", { d, class: "hit-area" }, g);
    const path = el("path", { d }, g);
    path.setAttribute("marker-end", "url(#mc-arr)");

    if (p.label !== null) {
      const lx = p.label.x + MARGIN + p.label.w / 2;
      text(g, { x: lx, y: p.label.y + MARGIN + 8, class: "elabel", "text-anchor": "middle" }, t.event);
    }

    onActivate(g, `${t.event} : ${stateOf(m, t.from).label} vers ${stateOf(m, t.to).label}`, () => {
      pick({ type: "transition", id: t.id });
    });

    return [{ t, g, path }];
  });

  return { size: { w: laid.w + 2 * MARGIN, h: laid.h + 2 * MARGIN }, rects, stateEls, arrows };
}

// The states a reader looks at now: the current one and where its events lead.
export function neighbourhood(d: MachineDrawing, m: Machine, p: Player): Rect[] {
  const ids = new Set([p.at, ...outgoing(m, p.at).map((t) => t.to)]);

  return [...ids].flatMap((id) => {
    const r = d.rects.get(id);

    return r === undefined ? [] : [r];
  });
}

export function highlightMachine(d: MachineDrawing, m: Machine, p: Player): void {
  const avail = new Set(outgoing(m, p.at).map((t) => t.id));

  for (const [id, gs] of d.stateEls) {
    for (const g of gs) {
      g.classList.toggle("current", id === p.at);
    }
  }

  for (const a of d.arrows) {
    a.g.classList.toggle("avail", avail.has(a.t.id));
    a.g.classList.toggle("hot", a.t.id === p.picked);
  }
}

function actorDot(by: Actor): string {
  return `<span class="actor by-${by}">${ACTOR_LABEL[by]}</span>`;
}

function transitionCard(m: Machine, t: MTransition): string {
  return [
    `<div class="tcard"><p class="label">Transition</p>`,
    `<p class="tline"><strong>${esc(stateOf(m, t.from).label)}</strong> → <code>${esc(t.event)}</code> → <strong>${esc(stateOf(m, t.to).label)}</strong> ${actorDot(t.by)}</p>`,
    t.guard === undefined ? "" : `<p class="guard">Garde : ${t.guard}</p>`,
    `<p>${t.desc}</p>`,
    t.src === undefined ? "" : `<p class="src">${esc(t.src)}</p>`,
    "</div>",
  ].join("");
}

export function renderMachinePanel(panel: HTMLElement, m: Machine, p: Player): void {
  const at = stateOf(m, p.at);
  const outs = outgoing(m, p.at);

  const events =
    outs.length === 0
      ? `<p class="alt">État terminal : plus aucun événement ne s'applique.</p>`
      : `<div class="chips">${outs
          .map(
            (t) =>
              `<button type="button" class="chip ev by-${t.by}" data-fire="${t.id}"><span class="dot"></span>${esc(t.event)}</button>`,
          )
          .join("")}</div>`;

  const picked = p.picked === null ? "" : transitionCard(m, transitionOf(m, p.picked));

  const log =
    p.log.length === 0
      ? ""
      : `<h3>Parcours joué</h3><ol class="log">${p.log.map((l) => `<li>${esc(l)}</li>`).join("")}</ol><div class="nav"><button type="button" data-reset="1">Recommencer</button></div>`;

  panel.innerHTML = [
    `<div style="--zc: var(--accent)">`,
    `<p class="kicker">${esc(m.tag)}</p>`,
    `<h2><span class="swatch"></span>${m.title}</h2>`,
    `<p class="lead">${m.lead}</p>`,
    `<dl class="facts"><dt>Où vit l'état</dt><dd>${m.store}</dd>${(m.facts ?? []).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>`,
    `<h3>État courant</h3><p class="tline"><strong>${esc(at.label)}</strong>${at.sub === undefined ? "" : ` <code>${esc(at.sub)}</code>`}</p><p>${at.lead}</p>`,
    at.where === undefined ? "" : `<p class="src">${esc(at.where)}</p>`,
    `<h3>Événements possibles</h3>${events}`,
    picked === "" ? "" : `<h3>Détail</h3>${picked}`,
    log,
    m.src === undefined ? "" : `<p class="src">Source : ${esc(m.src)}</p>`,
    "</div>",
  ].join("");

  panel.scrollTop = 0;
}
