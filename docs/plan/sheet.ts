import type { Camera, Rect } from "./camera.ts";

import { camera, fit, shown } from "./camera.ts";

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

const DUR = 650;

// One drawing sheet: its SVG and the camera that frames it, as the viewBox.
export class Sheet {
  cam: Camera | null = null;
  private raf = 0;

  constructor(readonly svg: SVGSVGElement) {}

  aspect(): number {
    const r = this.svg.getBoundingClientRect();

    return r.width > 0 && r.height > 0 ? r.width / r.height : 1.5;
  }

  frame(r: Rect, pad: number): Rect {
    return fit(r, pad, this.aspect());
  }

  paint(vb: Rect): void {
    this.svg.setAttribute("viewBox", `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  }

  jump(vb: Rect): void {
    this.cam = { kind: "idle", vb };
    this.paint(vb);
  }

  go(vb: Rect): void {
    const now = performance.now();
    this.cam = camera(this.cam ?? { kind: "idle", vb }, { type: "go", to: vb, now, dur: reduced ? 0 : DUR });
    this.paint(shown(this.cam, now));

    if (this.raf === 0) {
      this.raf = requestAnimationFrame(() => {
        this.tick();
      });
    }
  }

  private tick(): void {
    this.raf = 0;

    if (this.cam === null) {
      return;
    }

    const now = performance.now();
    this.cam = camera(this.cam, { type: "tick", now });
    this.paint(shown(this.cam, now));

    if (this.cam.kind === "moving") {
      this.raf = requestAnimationFrame(() => {
        this.tick();
      });
    }
  }
}

export function union(rects: readonly Rect[]): Rect {
  const first = rects[0];

  if (first === undefined) {
    throw new Error("union : aucun rectangle");
  }

  let x0 = first.x;
  let y0 = first.y;
  let x1 = first.x + first.w;
  let y1 = first.y + first.h;

  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }

  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
