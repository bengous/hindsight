import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { collect } from "./collect.ts";
import { volumes } from "./volumes.ts";

describe("volumes", () => {
  test("counts sessions, messages and errors per repo", async () => {
    const result = await collect({
      projectsDir: join(import.meta.dir, "../../fixtures/transcripts/projects"),
      since: new Date("2026-01-01T00:00:00.000Z"),
      includeArchive: true,
      repoRootOf: (cwd) => (cwd.startsWith("/home/u/proj") ? "/home/u/proj" : null),
    });
    expect(volumes(result)).toEqual({
      totals: { sessions: 4, humanMessages: 8, errorEvents: 4 },
      byRepo: [{ repoRoot: "/home/u/proj", sessions: 4, humanMessages: 8, errorEvents: 4, errorSessions: 1 }],
      stats: result.stats,
    });
  });
});
