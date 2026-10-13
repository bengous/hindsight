import { describe, expect, test } from "bun:test";

import { defaultConfig, readConfig } from "./config.ts";

describe("readConfig", () => {
  test("an absent or malformed file yields the defaults", () => {
    expect(readConfig(undefined)).toEqual(defaultConfig);
    expect(readConfig("nope")).toEqual(defaultConfig);
    expect(readConfig({ gate: { threshold: "high" } })).toEqual(defaultConfig);
  });

  test("a set field overrides its default and the rest stay", () => {
    const config = readConfig({ gate: { threshold: 1.5, classifierModel: "haiku" }, excludedRepos: ["/r", 3] });
    expect(config.gate.threshold).toBe(1.5);
    expect(config.gate.classifierModel).toBe("haiku");
    expect(config.gate.dailyCap).toBe(20);
    expect(config.excludedRepos).toEqual(["/r"]);
  });
});
