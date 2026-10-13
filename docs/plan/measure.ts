import type { LabelSize } from "./layout.ts";
import type { Brick, MState } from "./model.ts";

import { el } from "./svg.ts";

// Measured outside the drawings and without a viewBox, so Chrome measures at
// scale 1 whatever the zoom; the page sets text-rendering: geometricPrecision
// on SVG text so drawn text keeps this width. The font sizes here repeat the
// ones page.html gives these classes: change one, change the other.
const measSvg = el(
  "svg",
  { "aria-hidden": "true", width: 10, height: 10, style: "position:absolute;left:-10000px;top:0;visibility:hidden" },
  document.body,
);

const probes = new Map<string, SVGTextElement>();

export function textWidth(content: string, cls: string): number {
  const probe = probes.get(cls) ?? el("text", { class: cls }, measSvg);
  probes.set(cls, probe);
  probe.textContent = content;

  return probe.getComputedTextLength();
}

export type TextStyle = {
  readonly lbl: string;
  readonly sub: string;
  readonly ls: number;
  readonly ss: number;
  readonly lh: number;
  readonly padX: number;
  readonly padY: number;
};

export const BRICK: TextStyle = { lbl: "b-lbl", sub: "b-sub", ls: 15, ss: 8.5, lh: 10.5, padX: 22, padY: 16 };

export const EXT: TextStyle = { lbl: "x-lbl", sub: "x-sub", ls: 19, ss: 10, lh: 12.5, padX: 34, padY: 24 };

export const STATE: TextStyle = { lbl: "s-lbl", sub: "s-sub", ls: 15, ss: 10, lh: 12.5, padX: 30, padY: 18 };

export const textOf = (n: Brick): TextStyle => (n.zone === null ? EXT : BRICK);

export const subLines = (sub: string): string[] => (sub === "" ? [] : sub.split("\n"));

export const textHeight = (t: TextStyle, lines: number): number => t.ls + (lines > 0 ? 5 + lines * t.lh : 0);

export type Size = { readonly w: number; readonly h: number };

export function cardSize(t: TextStyle, label: string, sub: string): Size {
  const lines = subLines(sub);

  return {
    w: Math.ceil(Math.max(textWidth(label, t.lbl), ...lines.map((l) => textWidth(l, t.sub))) + t.padX),
    h: Math.ceil(textHeight(t, lines.length) + t.padY),
  };
}

export const brickSize = (n: Brick): Size => cardSize(textOf(n), n.label, n.sub);

export const stateSize = (s: MState): Size => cardSize(STATE, s.label, s.sub ?? "");

export const labelSize = (t: string): LabelSize => ({
  width: Math.ceil(textWidth(t, "elabel")) + 6,
  height: 10,
});

// Zone titles are uppercase through CSS, so the measure uppercases them too; 1.06 covers the letter-spacing.
export function titleWidth(title: string, tag: string, big: boolean): number {
  return big
    ? textWidth(title.toUpperCase(), "z-big") * 1.06 + textWidth(tag, "z-tag") + 70
    : Math.max(textWidth(title.toUpperCase(), "z-title") * 1.06, textWidth(tag, "z-tag")) + 32;
}

export const fontKey = (): string =>
  ["b-lbl", "b-sub", "x-lbl", "s-lbl", "z-big", "z-title", "z-tag", "elabel", "ov-chip-t", "ov-label"]
    .map((c) => textWidth("Mg Wq 0123", c).toFixed(1))
    .join(",");
