import type { Point, Rect } from "./camera.ts";
import type { Group, LayoutEdge, Leaf } from "./layout.ts";
import type { Size } from "./measure.ts";
import type { Zone } from "./model.ts";
import type { NavEvent } from "./nav.ts";
import type { ArrowEl, Registry } from "./svg.ts";

import { elkNested } from "./layout.ts";
import { brickSize, labelSize, subLines, textHeight, textOf, textWidth, titleWidth } from "./measure.ts";
import { OWN, PLAN, groupOf, links, nestOrder, nestsZone, node, parentMap, roots, zone } from "./plan.ts";
import { arrowPath, el, markerOf, onActivate, register, rounded, text } from "./svg.ts";

export type MapDrawing = {
  readonly size: Size;
  readonly rects: ReadonlyMap<string, Rect>;
  readonly zoneEls: Registry;
  readonly nodeEls: Registry;
  readonly arrows: readonly ArrowEl[];
};

const MARGIN = 40;

const PREFIX = "map";

function groups(): Map<string, Group> {
  const all = new Map<string, Group>();

  for (const z of PLAN.zones) {
    const nesting = nestsZone(z.id);
    all.set(z.id, {
      pad: nesting ? "[top=74,left=28,bottom=28,right=28]" : "[top=66,left=20,bottom=20,right=20]",
      minW: titleWidth(z.title, z.tag, nesting),
    });

    if (nesting) {
      all.set(z.id + OWN, { pad: "[top=14,left=14,bottom=14,right=14]" });
    }
  }

  return all;
}

const leaves = (): Leaf[] =>
  PLAN.nodes.map((n) => {
    const { w, h } = brickSize(n);

    return { id: n.id, w, h, group: groupOf(n) };
  });

// An arrow from a service on the right toward a brick inside is laid out
// reversed: ELK's layers run left to right, so a pure source would otherwise
// land on the left, among the inbound side.
const layoutEdges = (): LayoutEdge[] =>
  links.map((e) => ({
    from: e.from,
    to: e.to,
    label: e.label,
    flip: node(e.from).side === "out" && node(e.to).zone !== null,
  }));

function zoneKind(z: Zone): string {
  if (!nestsZone(z.id)) {
    return "module";
  }

  return z.parent === undefined ? "outer" : "inner";
}

function drawZone(layer: SVGGElement, z: Zone, r: Rect, pick: (ev: NavEvent) => void): SVGGElement {
  const kind = zoneKind(z);
  const g = el("g", { class: `zone ${kind}`, style: `--zc: var(${z.color})` }, layer);
  el("rect", { x: r.x, y: r.y, width: r.w, height: r.h, rx: kind === "outer" ? 16 : 10, class: "zone-bg" }, g);

  if (nestsZone(z.id)) {
    text(g, { x: r.x + 22, y: r.y + 40, class: "z-big" }, z.title);
    const tagX = r.x + 34 + textWidth(z.title.toUpperCase(), "z-big") * 1.06;
    text(g, { x: tagX, y: r.y + 38, class: "z-tag" }, z.tag);
  } else {
    text(g, { x: r.x + 16, y: r.y + 31, class: "z-title" }, z.title);
    text(g, { x: r.x + 16, y: r.y + 48, class: "z-tag" }, z.tag);
  }

  onActivate(g, `Zone ${z.title}`, () => {
    pick({ type: "zone", id: z.id });
  });

  return g;
}

function drawBrick(layer: SVGGElement, id: string, r: Rect, pick: (ev: NavEvent) => void): SVGGElement {
  const n = node(id);
  const t = textOf(n);
  const lines = subLines(n.sub);
  const g = el("g", { class: `brick${n.zone === null ? " ext" : ""}`, style: `--zc: var(${n.color})` }, layer);
  el("rect", { x: r.x, y: r.y, width: r.w, height: r.h, rx: n.zone === null ? 12 : 4, class: "box" }, g);
  const cx = r.x + r.w / 2;
  const top = r.y + r.h / 2 - textHeight(t, lines.length) / 2 - 1;
  text(g, { x: cx, y: top + t.ls * 0.8, class: t.lbl, "text-anchor": "middle" }, n.label);

  for (const [i, line] of lines.entries()) {
    const y = top + t.ls + 5 + i * t.lh + t.ss * 0.85;
    text(g, { x: cx, y, class: t.sub, "text-anchor": "middle" }, line);
  }

  onActivate(g, n.label, () => {
    pick({ type: "node", id: n.id });
  });

  return g;
}

export async function drawMap(layer: SVGGElement, pick: (ev: NavEvent) => void): Promise<MapDrawing> {
  const all = leaves();
  const laid = await elkNested(groups(), parentMap(), all, layoutEdges(), labelSize);
  const shift = (b: Rect): Rect => ({ x: b.x + MARGIN, y: b.y + MARGIN, w: b.w, h: b.h });

  const box = (id: string): Rect => {
    const b = laid.boxes.get(id);

    if (b === undefined) {
      throw new Error(`ELK n'a placé aucune boîte ${id}`);
    }

    return shift(b);
  };

  const zl = el("g", {}, layer);
  const al = el("g", {}, layer);
  const bl = el("g", {}, layer);
  const rects = new Map<string, Rect>();
  const zoneEls: Registry = new Map();

  for (const zid of roots.flatMap((z) => nestOrder(z.id))) {
    rects.set(zid, box(zid));

    if (nestsZone(zid)) {
      rects.set(zid + OWN, box(zid + OWN));
    }

    register(zoneEls, zid, drawZone(zl, zone(zid), box(zid), pick));
  }

  const nodeEls: Registry = new Map();

  for (const l of all) {
    register(nodeEls, l.id, drawBrick(bl, l.id, box(l.id), pick));
  }

  const arrows = laid.paths.map((p, i): ArrowEl => {
    const e = links[i];

    if (e === undefined) {
      throw new Error(`ELK a rendu un tracé de trop ${i}`);
    }

    const g = el("g", { class: `edge ${e.kind ?? ""}`, "pointer-events": "none" }, al);
    const pts = p.pts.map(([x, y]): Point => [x + MARGIN, y + MARGIN]);
    const marker = markerOf(PREFIX, e.kind);
    const path = arrowPath(g, rounded(pts, 7), marker, e.two === true);

    if (p.label !== null) {
      const lx = p.label.x + MARGIN + p.label.w / 2;
      text(g, { x: lx, y: p.label.y + MARGIN + 8, class: "elabel", "text-anchor": "middle" }, e.label);
    }

    return { from: e.from, to: e.to, g, path, marker, two: e.two === true };
  });

  return { size: { w: laid.w + 2 * MARGIN, h: laid.h + 2 * MARGIN }, rects, zoneEls, nodeEls, arrows };
}
