import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dirname, "../../..");

const FIXTURE = `
const MAX_RETRIES = 3;
export const DEFAULT_NAME = "hindsight";
const ITEMS = /a/u;
const items = ["a"];
const lookup = new Map<string, number>();
let counter = 0;
function local(): number {
  const limit = 3;
  return limit + counter + MAX_RETRIES;
}
const greeting = \`hi \${DEFAULT_NAME}\`;
const { size } = lookup;
const nothing = null;

const maxRetries = 3;
export const defaultName = "hindsight";
const enabled = true;
const pattern = /a/u;
const banner = \`plain\`;
const Mixed = "x";

export { ITEMS, items, local, greeting, size, nothing, maxRetries, enabled, pattern, banner, Mixed };
`;

// oxlint's RuleTester refuses to run under Bun, so the rule runs through the CLI.
test("constant-case flags module constants that hold a literal and are not UPPER_CASE", () => {
  const dir = mkdtempSync(join(tmpdir(), "constant-case-test-"));

  try {
    const config = join(dir, ".oxlintrc.json");
    const fixture = join(dir, "fixture.ts");
    writeFileSync(
      config,
      JSON.stringify({
        categories: { correctness: "off" },
        jsPlugins: [{ name: "hindsight", specifier: join(import.meta.dirname, "index.ts") }],
        rules: { "hindsight/constant-case": "error" },
      }),
    );
    writeFileSync(fixture, FIXTURE);

    const result = Bun.spawnSync(
      [process.execPath, join(PROJECT_ROOT, "node_modules/oxlint/bin/oxlint"), "-c", config, "--format=unix", fixture],
      { stdout: "pipe", stderr: "pipe" },
    );

    const output = result.stdout.toString();
    const flagged = [...output.matchAll(/`(\w+)` is a module constant/g)].map((match) => match[1]);

    expect(result.stderr.toString()).toBe("");
    expect(flagged).toEqual(["maxRetries", "defaultName", "enabled", "pattern", "banner", "Mixed"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
