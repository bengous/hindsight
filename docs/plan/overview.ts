import type { Point, Rect } from "./camera.ts";
import type { Leaf } from "./layout.ts";
import type { Size } from "./measure.ts";
import type { NavEvent } from "./nav.ts";
import type { ArrowEl, Registry } from "./svg.ts";

import { OVERVIEW_FLOWS } from "./data-edges.ts";
import { elkNested } from "./layout.ts";
import { labelSize, textWidth } from "./measure.ts";
import { PLAN, kidsOf, nestsZone, node, outside, roots, zone } from "./plan.ts";
import { arrowPath, el, markerOf, onActivate, register, rounded, text } from "./svg.ts";

// The overview, readable at its own scale: every root zone as a box that
// lists its bricks as chips (a nested zone as an inner frame), the systems
// outside as pills on each side, and one arrow per pair of boxes, named in
// OVERVIEW_FLOWS. ELK lays the boxes out; nothing here has a written position.
export type Overview = {
  readonly size: Size;
  readonly rects: ReadonlyMap<string, Rect>;
  readonly zoneEls: Registry;
  readonly nodeEls: Registry;
  readonly arrows: readonly ArrowEl[];
};

type Chip = { readonly id: string; readonly x: number; readonly y: number; readonly w: number };

type ChipBlock = { readonly w: number; readonly h: number; readonly chips: readonly Chip[] };

type SubBlock = { readonly zid: string; readonly y: number; readonly h: number; readonly chips: ChipBlock };

type Block = {
  readonly w: number;
  readonly h: number;
  readonly own: ChipBlock;
  readonly ownY: number;
  readonly subs: readonly SubBlock[];
};

const CHIP = { h: 32, gap: 9, pad: 13, maxW: 520 };

const PAD = 18;

const HEAD = 62;

const SUB_HEAD = 56;

const MARGIN = 40;

const PREFIX = "map";

function chipBlock(ids: readonly string[], minW: number): ChipBlock {
  const widths = ids.map((b) => Math.ceil(textWidth(node(b).label, "ov-chip-t")) + 2 * CHIP.pad);
  const total = widths.reduce((a, w) => a + w + CHIP.gap, 0);
  const target = Math.max(minW, Math.min(CHIP.maxW, Math.sqrt(total * (CHIP.h + CHIP.gap) * 2.4)));
  const chips: Chip[] = [];
  let x = 0;
  let y = 0;
  let maxX = 0;

  for (const [i, b] of ids.entries()) {
    const w = widths[i] ?? 0;

    if (x > 0 && x + w > target) {
      x = 0;
      y += CHIP.h + CHIP.gap;
    }

    chips.push({ id: b, x, y, w });
    x += w + CHIP.gap;
    maxX = Math.max(maxX, x - CHIP.gap);
  }

  return { w: Math.ceil(maxX), h: ids.length === 0 ? 0 : y + CHIP.h, chips };
}

const headWidth = (zid: string, big: boolean): number => {
  const z = zone(zid);

  return big
    ? textWidth(z.title.toUpperCase(), "z-big") * 1.06 + textWidth(z.tag, "z-tag") + 40
    : Math.max(textWidth(z.title.toUpperCase(), "z-title") * 1.06, textWidth(z.tag, "z-tag"));
};

function blockOf(zid: string): Block {
  const ownIds = PLAN.nodes.filter((n) => n.zone === zid).map((n) => n.id);
  const kids = kidsOf(zid);
  const minW = headWidth(zid, true);
  const own = chipBlock(ownIds, minW);
  const subs: SubBlock[] = [];
  let y = HEAD + own.h + (own.h > 0 ? PAD : 0);
  let w = Math.max(minW, own.w);

  for (const kid of kids) {
    const chips = chipBlock(
      PLAN.nodes.filter((n) => n.zone === kid).map((n) => n.id),
      headWidth(kid, false),
    );

    const h = SUB_HEAD + chips.h + PAD;
    subs.push({ zid: kid, y, h, chips });
    y += h + PAD;
    w = Math.max(w, chips.w + 2 * PAD, headWidth(kid, false) + 2 * PAD);
  }

  const h = subs.length === 0 ? y : y - PAD;

  return { w: Math.ceil(w + 2 * PAD), h: Math.ceil(h + PAD), own, ownY: HEAD, subs };
}

function drawChips(
  layer: SVGGElement,
  block: ChipBlock,
  x0: number,
  y0: number,
  nodeEls: Registry,
  pick: (ev: NavEvent) => void,
): void {
  for (const c of block.chips) {
    const n = node(c.id);
    const g = el("g", { class: "ov-chip", style: `--zc: var(${n.color})` }, layer);
    el("rect", { x: x0 + c.x, y: y0 + c.y, width: c.w, height: CHIP.h, rx: 4 }, g);
    text(
      g,
      { x: x0 + c.x + c.w / 2, y: y0 + c.y + CHIP.h / 2 + 6, class: "ov-chip-t", "text-anchor": "middle" },
      n.label,
    );
    onActivate(g, n.label, () => {
      pick({ type: "node", id: n.id });
    });
    register(nodeEls, n.id, g);
  }
}

function drawZoneBox(
  layer: SVGGElement,
  zid: string,
  r: Rect,
  block: Block,
  rects: Map<string, Rect>,
  zoneEls: Registry,
  nodeEls: Registry,
  pick: (ev: NavEvent) => void,
): void {
  const z = zone(zid);
  const kind = nestsZone(zid) ? "outer" : "module";
  const g = el("g", { class: `zone ${kind} ov`, style: `--zc: var(${z.color})` }, layer);
  el("rect", { x: r.x, y: r.y, width: r.w, height: r.h, rx: kind === "outer" ? 16 : 10, class: "zone-bg" }, g);
  text(g, { x: r.x + PAD, y: r.y + 40, class: "z-big" }, z.title);
  const tagX = r.x + PAD + 12 + textWidth(z.title.toUpperCase(), "z-big") * 1.06;
  text(g, { x: tagX, y: r.y + 38, class: "z-tag" }, z.tag);
  onActivate(g, `Zone ${z.title}`, () => {
    pick({ type: "zone", id: zid });
  });
  register(zoneEls, zid, g);
  rects.set(zid, r);
  const chips = el("g", {}, layer);
  drawChips(chips, block.own, r.x + PAD, r.y + block.ownY, nodeEls, pick);

  for (const s of block.subs) {
    const kid = zone(s.zid);
    const sr = { x: r.x + PAD, y: r.y + s.y, w: r.w - 2 * PAD, h: s.h };
    const sg = el("g", { class: "zone module ov", style: `--zc: var(${kid.color})` }, layer);
    el("rect", { x: sr.x, y: sr.y, width: sr.w, height: sr.h, rx: 10, class: "zone-bg" }, sg);
    text(sg, { x: sr.x + 16, y: sr.y + 31, class: "z-title" }, kid.title);
    text(sg, { x: sr.x + 16, y: sr.y + 48, class: "z-tag" }, kid.tag);
    onActivate(sg, `Zone ${kid.title}`, () => {
      pick({ type: "zone", id: s.zid });
    });
    register(zoneEls, s.zid, sg);
    rects.set(s.zid, sr);
    drawChips(el("g", {}, layer), s.chips, sr.x + PAD, sr.y + SUB_HEAD, nodeEls, pick);
  }
}

export async function drawOverview(layer: SVGGElement, pick: (ev: NavEvent) => void): Promise<Overview> {
  const blocks = new Map(roots.map((z) => [z.id, blockOf(z.id)]));

  const leaves: Leaf[] = [
    ...[...blocks].map(([id, b]) => ({ id, w: b.w, h: b.h, group: null })),
    ...outside.map((n) => ({ id: n.id, w: Math.ceil(textWidth(n.label, "x-lbl")) + 44, h: 50, group: null })),
  ];

  // An arrow toward a system on the "in" side is laid out reversed, so that system stands in the left column.
  const edges = OVERVIEW_FLOWS.map((f) => ({
    from: f.from,
    to: f.to,
    label: f.label,
    flip: PLAN.nodes.some((n) => n.id === f.to && n.zone === null && n.side === "in"),
  }));

  const laid = await elkNested(new Map(), new Map(), leaves, edges, labelSize, {
    "elk.layered.spacing.nodeNodeBetweenLayers": "96",
    "elk.spacing.nodeNode": "40",
    "elk.spacing.edgeNode": "24",
    "elk.spacing.edgeEdge": "18",
  });

  const box = (id: string): Rect => {
    const b = laid.boxes.get(id);

    if (b === undefined) {
      throw new Error(`ELK n'a placé aucune boîte ${id}`);
    }

    return { x: b.x + MARGIN, y: b.y + MARGIN, w: b.w, h: b.h };
  };

  const zl = el("g", {}, layer);
  const al = el("g", {}, layer);
  const rects = new Map<string, Rect>();
  const zoneEls: Registry = new Map();
  const nodeEls: Registry = new Map();

  for (const [id, b] of blocks) {
    drawZoneBox(zl, id, box(id), b, rects, zoneEls, nodeEls, pick);
  }

  for (const n of outside) {
    const r = box(n.id);
    const g = el("g", { class: "ov-ext", style: `--zc: var(${n.color})` }, zl);
    el("rect", { x: r.x, y: r.y, width: r.w, height: r.h, rx: 14 }, g);
    text(g, { x: r.x + r.w / 2, y: r.y + r.h / 2 + 7, class: "ov-ext-t", "text-anchor": "middle" }, n.label);
    onActivate(g, n.label, () => {
      pick({ type: "node", id: n.id });
    });
    register(nodeEls, n.id, g);
    rects.set(n.id, r);
  }

  const arrows = laid.paths.map((p, i): ArrowEl => {
    const f = OVERVIEW_FLOWS[i];

    if (f === undefined) {
      throw new Error(`ELK a rendu un tracé de trop ${i}`);
    }

    const g = el("g", { class: `ov-flow ${f.kind ?? ""}`, "pointer-events": "none" }, al);
    const pts = p.pts.map(([x, y]): Point => [x + MARGIN, y + MARGIN]);
    const marker = markerOf(PREFIX, f.kind);
    const path = arrowPath(g, rounded(pts, 10), marker, f.two === true);

    if (p.label !== null) {
      text(
        g,
        {
          x: p.label.x + MARGIN + p.label.w / 2,
          y: p.label.y + MARGIN + 11,
          class: "ov-label",
          "text-anchor": "middle",
        },
        f.label,
      );
    }

    return { from: f.from, to: f.to, g, path, marker, two: f.two === true };
  });

  return { size: { w: laid.w + 2 * MARGIN, h: laid.h + 2 * MARGIN }, rects, zoneEls, nodeEls, arrows };
}
