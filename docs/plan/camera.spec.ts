import { describe, expect, test } from "bun:test";

import { camera, fit, shown } from "./camera.ts";

const A = { x: 0, y: 0, w: 1000, h: 500 };

const B = { x: 100, y: 100, w: 200, h: 100 };

describe("camera", () => {
  test("a go with no duration lands at once", () => {
    expect(camera({ kind: "idle", vb: A }, { type: "go", to: B, now: 0, dur: 0 })).toEqual({ kind: "idle", vb: B });
  });

  test("a move starts where the previous one stood and ends on its target", () => {
    const first = camera({ kind: "idle", vb: A }, { type: "go", to: B, now: 0, dur: 100 });
    const mid = shown(first, 50);
    const second = camera(first, { type: "go", to: A, now: 50, dur: 100 });
    expect(second.kind === "moving" && second.from).toEqual(mid);
    expect(shown(second, 150)).toEqual(A);
    expect(camera(second, { type: "tick", now: 150 })).toEqual({ kind: "idle", vb: A });
  });

  test("the shown frame stays between the two ends", () => {
    const cam = camera({ kind: "idle", vb: A }, { type: "go", to: B, now: 0, dur: 100 });
    const r = shown(cam, 40);
    expect(r.w).toBeLessThan(A.w);
    expect(r.w).toBeGreaterThan(B.w);
  });
});

describe("fit", () => {
  test("keeps the aspect and wraps the rect", () => {
    const r = fit(B, 10, 2);
    expect(r.w / r.h).toBeCloseTo(2);
    expect(r.x).toBeLessThanOrEqual(B.x - 10);
    expect(r.y).toBeLessThanOrEqual(B.y - 10);
    expect(r.x + r.w).toBeGreaterThanOrEqual(B.x + B.w + 10);
    expect(r.y + r.h).toBeGreaterThanOrEqual(B.y + B.h + 10);
  });
});
