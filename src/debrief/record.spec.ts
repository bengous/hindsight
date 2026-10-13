import type { StoreShape } from "../store/db.ts";
import type { DebriefRow, NoteRow, ProposalRow } from "../store/queries.ts";
import type { SessionRecord } from "../transcripts/session.ts";
import type { RecordDeps, RecordInput } from "./record.ts";

import { beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { join } from "node:path";

import { defaultConfig } from "../domain/config.ts";
import { fingerprint } from "../rules/ids.ts";
import { makeStore } from "../store/db.ts";
import { abortStaleDebriefs, insertDebrief } from "../store/queries.ts";
import { readSession } from "../transcripts/session.ts";
import { recordDebrief } from "./record.ts";

const projectsDir = join(import.meta.dir, "../../fixtures/debrief/projects");

const NOW = "2026-10-01T10:00:00.000Z";

const files: Record<string, string> = {
  "/home/u/atelier/package.json": '{ "scripts": { "check": "bun run lint && bun test" } }',
  "/home/u/atelier/AGENTS.md": "# Atelier\n\n- Run `bun run check:full` before a commit.\n- Keep commits small.\n",
};

const deps: RecordDeps = { now: () => NOW, readFile: (path) => files[path] ?? null, repoOf: () => null };

const staleRule = {
  editedPath: "/home/u/atelier/package.json",
  editedExcerpt: '"check": "bun run lint && bun test"',
  ruleFile: "/home/u/atelier/AGENTS.md",
  oldText: "Run `bun run check:full` before a commit.",
  newText: "Run `bun run check` before a commit.",
  lesson: "Name the package script that exists.",
};

const answer = (notes: object): string => `\`\`\`json\n${JSON.stringify(notes)}\n\`\`\``;

let store: StoreShape;

let session: SessionRecord;

async function openDebrief(id = "d1"): Promise<void> {
  await Effect.runPromise(
    store.transaction((db) => insertDebrief(db, { id, sessionId: "s-d1", repoRoot: "/home/u/atelier", at: NOW })),
  );
}

async function record(text: string, overrides: Partial<RecordInput> = {}) {
  const input: RecordInput = {
    id: "d1",
    sessionId: "s-d1",
    cacheShare: 0.98,
    durationMs: 1200,
    text,
    repoRoot: "/home/u/atelier",
    ...overrides,
  };

  return Effect.runPromise(store.transaction((db) => recordDebrief(db, defaultConfig, session, input, deps)));
}

const rows = async <T extends Record<string, string | number | null>>(sql: string) =>
  Effect.runPromise(store.all<T>(sql));

beforeEach(async () => {
  store = await Effect.runPromise(makeStore(":memory:"));
  const read = await readSession(projectsDir, "s-d1");

  if (read === null) {
    throw new Error("fixture session s-d1 not found");
  }

  session = read;
  await openDebrief();
});

describe("readSession", () => {
  test("follows the continuation chain back and keeps the human messages and tool entries", () => {
    expect(session.chain).toEqual(["s-d0", "s-d1"]);
    expect(session.cwd).toBe("/home/u/atelier");
    const humans = session.events.filter((event) => event.kind === "human");
    expect(humans.map((human) => (human.kind === "human" ? human.uuid : ""))).toEqual(["a01", "b01", "b08"]);
    expect(humans[1]).toMatchObject({ text: "Reprends. Non, pas de npm pour ça, on reste sur pnpm." });
    const tools = session.events.filter((event) => event.kind === "tool");
    expect(tools.map((tool) => (tool.kind === "tool" ? [tool.tool, tool.isError, tool.isRefused] : []))).toEqual([
      ["Bash", true, false],
      ["Edit", false, false],
      ["Bash", true, true],
    ]);
    expect(session.loadedRules.map((rule) => rule.path)).toEqual([
      "/home/u/.claude/AGENTS.md",
      "/home/u/atelier/AGENTS.md",
    ]);
  });
});

describe("recordDebrief", () => {
  test("stores a Steer on its earliest message, an Observation on its tool entry, and a Stale Rule as a Proposal", async () => {
    const outcome = await record(
      answer({
        steers: [{ quote: "pas de npm pour ça", lesson: "Install with pnpm.", habit: true }],
        observations: [
          {
            question: 4,
            tool: "Bash",
            excerpt: 'Script not found "check:full"',
            lesson: "Name the real check script.",
            rulePath: null,
          },
        ],
        staleRules: [staleRule],
      }),
    );

    expect(outcome).toMatchObject({
      status: "recorded",
      notes: { steers: 1, observations: 1, staleRules: 1 },
      proposals: 1,
      rejected: {},
    });
    const notes = await rows<NoteRow>("SELECT * FROM notes ORDER BY kind");
    expect(notes.map((note) => [note.kind, note.evidence_id, note.status])).toEqual([
      ["observation", "s-d1:b02", "pending"],
      ["stale_rule", "s-d1:b04", "used"],
      ["steer", "s-d0:a01", "pending"],
    ]);
    const messages = await rows<{ evidence_id: string; text: string }>("SELECT evidence_id, text FROM messages");
    expect(messages).toEqual([
      { evidence_id: "s-d0:a01", text: "Corrige le script check. Non, pas de npm pour ça, on reste sur pnpm." },
    ]);
    const proposals = await rows<ProposalRow>("SELECT * FROM proposals");
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      state: "pending",
      source: "debrief",
      target_path: "/home/u/atelier/AGENTS.md",
      repo_root: "/home/u/atelier",
      scope: "repo",
      fingerprint: fingerprint("/home/u/atelier/AGENTS.md", staleRule.lesson),
    });
    expect(JSON.parse(proposals[0]?.change_json ?? "")).toEqual({
      kind: "edit",
      edits: [{ oldText: staleRule.oldText, newText: staleRule.newText }],
    });
    const debrief = (await rows<DebriefRow>("SELECT * FROM debriefs"))[0];
    expect(debrief).toMatchObject({ status: "recorded", cache_share: 0.98, duration_ms: 1200, finished_at: NOW });
  });

  test("rejects a Quote that no Human Message holds, and names a Quote copied from a tool output", async () => {
    const outcome = await record(
      answer({
        steers: [
          { quote: "lance npm install", lesson: "x", habit: false },
          { quote: "Toujours lancer les tests avant de committer", lesson: "Run tests before a commit.", habit: true },
        ],
      }),
    );

    expect(outcome.notes.steers).toBe(0);
    expect(outcome.rejected).toEqual({ "quote-missing": 1, "quote-from-tool": 1 });
    expect(await rows("SELECT * FROM notes")).toHaveLength(0);
  });

  test("rejects an Observation whose tool or excerpt matches no entry", async () => {
    const outcome = await record(
      answer({
        observations: [
          { question: 3, tool: "Read", excerpt: 'Script not found "check:full"', lesson: "x", rulePath: null },
          { question: 3, tool: "Bash", excerpt: "something the tool never printed", lesson: "x", rulePath: null },
          { question: 3, tool: "Bash", excerpt: "short", lesson: "x", rulePath: null },
        ],
      }),
    );

    expect(outcome.rejected).toEqual({ "observation-missing": 3 });
  });

  test("rejects a Stale Rule the Ledger already refused, one whose edit is gone, and one whose rule text is absent", async () => {
    await Effect.runPromise(
      store.transaction((db) => {
        db.run(
          `INSERT INTO proposals (id, fingerprint, created_at, state, source, target_path, scope, claim_fr, reasoning_fr, lesson_en, subject_en, change_json, evidence_json, prevalence_json)
           VALUES ('p0', ?, ?, 'rejected', 'debrief', '/home/u/atelier/AGENTS.md', 'repo', '', '', '', '', '{}', '[]', '{}')`,
          [fingerprint("/home/u/atelier/AGENTS.md", staleRule.lesson), NOW],
        );
        db.run(
          "INSERT INTO decisions (proposal_id, fingerprint, at, decision, reason, sessions_at_decision) VALUES ('p0', ?, ?, 'rejected', 'wrong', 1)",
          [fingerprint("/home/u/atelier/AGENTS.md", staleRule.lesson), NOW],
        );
      }),
    );

    const outcome = await record(
      answer({
        staleRules: [
          staleRule,
          { ...staleRule, editedExcerpt: '"check": "bun run nothing"', lesson: "other lesson" },
          { ...staleRule, oldText: "A rule that is not in the file.", lesson: "third lesson" },
        ],
      }),
    );

    expect(outcome.rejected).toEqual({ "ledger-rejected": 1, "stale-edit-missing": 1, "stale-rule-text": 1 });
    expect(await rows("SELECT * FROM proposals WHERE state = 'pending'")).toHaveLength(0);
  });

  test("a refused or errored Edit is no edit: the Stale Rule is rejected", async () => {
    const refused = {
      ...session,
      events: session.events.map((event) =>
        event.kind === "tool" && event.tool === "Edit" ? { ...event, isRefused: true, isError: true } : event,
      ),
    };

    const input: RecordInput = {
      id: "d1",
      sessionId: "s-d1",
      cacheShare: 0.98,
      durationMs: 1,
      text: answer({ staleRules: [staleRule] }),
      repoRoot: "/home/u/atelier",
    };

    const outcome = await Effect.runPromise(
      store.transaction((db) => recordDebrief(db, defaultConfig, refused, input, deps)),
    );

    expect(outcome.rejected).toEqual({ "stale-edit-missing": 1 });
  });

  test("a Stale Rule whose file moved on since the edit is rejected", async () => {
    const stale = {
      ...deps,
      readFile: (path: string) => (path.endsWith("package.json") ? "{}" : (files[path] ?? null)),
    };

    const input: RecordInput = {
      id: "d1",
      sessionId: "s-d1",
      cacheShare: 0.98,
      durationMs: 1,
      text: answer({ staleRules: [staleRule] }),
      repoRoot: "/home/u/atelier",
    };

    const outcome = await Effect.runPromise(
      store.transaction((db) => recordDebrief(db, defaultConfig, session, input, stale)),
    );

    expect(outcome.rejected).toEqual({ "stale-file-changed": 1 });
  });

  test("a Debrief that rebuilt the cache fails before anything is read", async () => {
    const outcome = await record(answer({ steers: [{ quote: "pas de npm", lesson: "x", habit: true }] }), {
      cacheShare: 0.5,
    });

    expect(outcome).toMatchObject({ status: "failed", failure: "cache:0.50" });
    expect(await rows("SELECT * FROM notes")).toHaveLength(0);
    expect((await rows<DebriefRow>("SELECT * FROM debriefs"))[0]?.status).toBe("failed");
  });

  test("an answer the parser refuses fails the Debrief with the reason", async () => {
    const outcome = await record("I have nothing to say.");
    expect(outcome).toMatchObject({ status: "failed", failure: "parse:no-json:no JSON block in the answer" });
  });

  test("a started row with no end reads aborted after fifteen minutes", async () => {
    await openDebrief("d-old");
    await Effect.runPromise(
      store.run("UPDATE debriefs SET started_at = ? WHERE id = 'd-old'", ["2026-10-01T09:40:00.000Z"]),
    );
    const changed = await Effect.runPromise(store.transaction((db) => abortStaleDebriefs(db, NOW)));
    expect(changed).toBe(1);
    const statuses = await rows<{ id: string; status: string }>("SELECT id, status FROM debriefs ORDER BY id");
    expect(statuses).toEqual([
      { id: "d-old", status: "aborted" },
      { id: "d1", status: "started" },
    ]);
  });
});
