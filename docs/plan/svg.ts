import type { Point } from "./camera.ts";

const NS = "http://www.w3.org/2000/svg";

export type Attrs = Readonly<Record<string, string | number>>;

export function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Attrs,
  parent: Element | null,
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);

  for (const [k, v] of Object.entries(attrs)) {
    e.setAttribute(k, String(v));
  }

  parent?.append(e);

  return e;
}

export function text(parent: SVGElement, attrs: Attrs, content: string): SVGTextElement {
  const t = el("text", attrs, parent);
  t.textContent = content;

  return t;
}

export const esc = (s: string): string => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const fmt = ([x, y]: Point): string => `${x.toFixed(1)} ${y.toFixed(1)}`;

export function rounded(pts: readonly Point[], r: number): string {
  const first = pts[0];
  const last = pts.at(-1);

  if (first === undefined || last === undefined) {
    throw new Error("rounded : une polyligne vide");
  }

  let d = `M${fmt(first)}`;

  for (let i = 1; i < pts.length - 1; i += 1) {
    const [p0, p1, p2] = [pts[i - 1], pts[i], pts[i + 1]];

    if (p0 === undefined || p1 === undefined || p2 === undefined) {
      continue;
    }

    const l1 = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    const l2 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);

    if (l1 < 0.5 || l2 < 0.5) {
      continue;
    }

    const k1 = Math.min(r, l1 / 2) / l1;
    const k2 = Math.min(r, l2 / 2) / l2;
    const a: Point = [p1[0] - (p1[0] - p0[0]) * k1, p1[1] - (p1[1] - p0[1]) * k1];
    const b: Point = [p1[0] + (p2[0] - p1[0]) * k2, p1[1] + (p2[1] - p1[1]) * k2];
    d += ` L${fmt(a)} Q${fmt(p1)} ${fmt(b)}`;
  }

  return `${d} L${fmt(last)}`;
}

export function onActivate(g: SVGGElement, label: string, fn: () => void): void {
  g.setAttribute("tabindex", "0");
  g.setAttribute("role", "button");
  g.setAttribute("aria-label", label);
  g.classList.add("hit");
  g.addEventListener("click", (e) => {
    e.stopPropagation();
    fn();
  });
  g.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  });
}

export function defs(svg: SVGSVGElement, prefix: string): void {
  const d = el("defs", {}, svg);
  const pat = el("pattern", { id: `${prefix}-grid`, width: 100, height: 100, patternUnits: "userSpaceOnUse" }, d);

  for (let i = 0; i < 100; i += 20) {
    const width = i === 0 ? 1.2 : 0.6;
    el("line", { x1: i, y1: 0, x2: i, y2: 100, stroke: "var(--grid)", "stroke-width": width }, pat);
    el("line", { x1: 0, y1: i, x2: 100, y2: i, stroke: "var(--grid)", "stroke-width": width }, pat);
  }

  for (const [id, cls] of [
    ["arr", ""],
    ["arr-deny", "deny"],
    ["arr-hot", "hot"],
  ] as const) {
    const m = el(
      "marker",
      {
        id: `${prefix}-${id}`,
        viewBox: "0 0 10 10",
        refX: 8.5,
        refY: 5,
        markerWidth: 5.5,
        markerHeight: 5.5,
        orient: "auto-start-reverse",
        markerUnits: "strokeWidth",
      },
      d,
    );

    el("path", { d: "M0,0 L10,5 L0,10 z", class: `arrowhead ${cls}` }, m);
  }
}

export const markerOf = (prefix: string, kind: string | undefined): string =>
  kind === "deny" ? `url(#${prefix}-arr-deny)` : `url(#${prefix}-arr)`;

export type Registry = Map<string, SVGGElement[]>;

export type ArrowEl = {
  readonly from: string;
  readonly to: string;
  readonly g: SVGGElement;
  readonly path: SVGPathElement;
  readonly marker: string;
  readonly two: boolean;
};

export function register(map: Registry, id: string, g: SVGGElement): void {
  const list = map.get(id) ?? [];
  list.push(g);
  map.set(id, list);
}

export function arrowPath(g: SVGGElement, d: string, marker: string, two: boolean): SVGPathElement {
  const path = el("path", { d }, g);
  path.setAttribute("marker-end", marker);

  if (two) {
    path.setAttribute("marker-start", marker);
  }

  return path;
}

export function setMarker(e: ArrowEl, marker: string): void {
  e.path.setAttribute("marker-end", marker);

  if (e.two) {
    e.path.setAttribute("marker-start", marker);
  }
}
