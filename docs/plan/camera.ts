export type Rect = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };

export type Point = readonly [number, number];

export type Camera =
  | { readonly kind: "idle"; readonly vb: Rect }
  | { readonly kind: "moving"; readonly from: Rect; readonly to: Rect; readonly t0: number; readonly dur: number };

export type CameraEvent =
  | { readonly type: "jump"; readonly vb: Rect }
  | { readonly type: "tick"; readonly now: number }
  | { readonly type: "go"; readonly to: Rect; readonly now: number; readonly dur: number };

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const easeInOut = (p: number): number => (p < 0.5 ? 4 * p ** 3 : 1 - (2 - 2 * p) ** 3 / 2);

export const center = (r: Rect): Point => [r.x + r.w / 2, r.y + r.h / 2];

// The width moves on a log scale so zooming in and out feel the same speed.
export function shown(cam: Camera, now: number): Rect {
  if (cam.kind === "idle") {
    return cam.vb;
  }

  if (now >= cam.t0 + cam.dur) {
    return cam.to;
  }

  const e = easeInOut(clamp01((now - cam.t0) / cam.dur));
  const w = Math.exp(lerp(Math.log(cam.from.w), Math.log(cam.to.w), e));
  const h = Math.exp(lerp(Math.log(cam.from.h), Math.log(cam.to.h), e));
  const [ax, ay] = center(cam.from);
  const [bx, by] = center(cam.to);
  const cx = lerp(ax, bx, e);
  const cy = lerp(ay, by, e);

  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

export function camera(cam: Camera, ev: CameraEvent): Camera {
  switch (ev.type) {
    case "jump": {
      return { kind: "idle", vb: ev.vb };
    }

    case "tick": {
      return cam.kind === "moving" && ev.now >= cam.t0 + cam.dur ? { kind: "idle", vb: cam.to } : cam;
    }

    case "go": {
      if (ev.dur <= 0) {
        return { kind: "idle", vb: ev.to };
      }

      return { kind: "moving", from: shown(cam, ev.now), to: ev.to, t0: ev.now, dur: ev.dur };
    }

    default: {
      const unknown: never = ev;

      return unknown;
    }
  }
}

// The viewBox that frames r with pad around it at the given aspect, so nothing is letterboxed.
export function fit(r: Rect, pad: number, aspect: number): Rect {
  const w = r.w + 2 * pad;
  const h = r.h + 2 * pad;

  if (w / h < aspect) {
    return { x: r.x - pad - (h * aspect - w) / 2, y: r.y - pad, w: h * aspect, h };
  }

  return { x: r.x - pad, y: r.y - pad - (w / aspect - h) / 2, w, h: w / aspect };
}
