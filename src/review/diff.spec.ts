import { describe, expect, test } from "bun:test";
import { lineDiff } from "./diff.ts";

describe("lineDiff", () => {
  test("keeps the anchor and marks the appended line", () => {
    expect(lineDiff("- a", "- a\n- b")).toEqual([
      { kind: "same", text: "- a" },
      { kind: "add", text: "- b" },
    ]);
  });

  test("shows a replaced line as a deletion then an addition", () => {
    expect(lineDiff("- old\n- keep", "- new\n- keep")).toEqual([
      { kind: "del", text: "- old" },
      { kind: "add", text: "- new" },
      { kind: "same", text: "- keep" },
    ]);
  });

  test("treats an empty old text as a new file", () => {
    expect(lineDiff("", "x\ny")).toEqual([
      { kind: "add", text: "x" },
      { kind: "add", text: "y" },
    ]);
  });

  test("treats an empty new text as a full removal", () => {
    expect(lineDiff("x", "")).toEqual([{ kind: "del", text: "x" }]);
  });
});
