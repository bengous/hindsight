import type { LearnGroup, NoteView } from "./prompt.ts";
import type { Candidate } from "./schema.ts";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tempDir, tempRepo } from "../../fixtures/rules/repo.ts";
import { defaultConfig, type HindsightConfig } from "../domain/config.ts";
import { fingerprint } from "../rules/ids.ts";
import { makeStore, Store, type StoreShape } from "../store/db.ts";
import { insertDebrief, insertNote, type ProposalRow } from "../store/queries.ts";
import { ClaudeRunner, ModelError, scriptedRunner } from "./claude.ts";
import { gateLearn, type GateContext } from "./gates.ts";
import { knownRepos, prune } from "./prune.ts";
import { learn, planGroups, toNoteView } from "./run.ts";

const NOW = "2026-10-13T12:00:00.000Z";

const repo = tempRepo({
  "AGENTS.md": "# Atelier\n\n- Run `bun run check` before a commit.\n- Keep commits small.\n",
  "package.json": JSON.stringify({ scripts: { check: "true" } }),
  ".claude/rules/dead.md": "---\npaths:\n  - legacy/**\n---\n- Dead glob.\n",
  "src/a.ts": "",
});
const home = tempDir("home");
const AGENTS = join(repo.root, "AGENTS.md");
const RULE_TEXT = "# Atelier\n\n- Run `bun run check` before a commit.\n- Keep commits small.\n";

afterAll(() => {
  repo.cleanup();
  rmSync(home, { recursive: true, force: true });
});

const note = (id: string, session: string, day: string, text: string, extra: Partial<NoteView> = {}): NoteView => ({
  id,
  kind: "steer",
  sessionId: session,
  repoRoot: repo.root,
  at: `2026-10-${day}T10:00:00.000Z`,
  lesson: "Install packages with pnpm.",
  text,
  habit: true,
  tool: null,
  question: null,
  loadedRules: [AGENTS],
  isExplicit: false,
  evidenceId: `${session}:u-${id}`,
  ...extra,
});

const bulletId = `AGENTS.md#${new Bun.CryptoHasher("sha1").update("Run `bun run check` before a commit.").digest("hex").slice(0, 8)}`;

const group: LearnGroup = {
  key: repo.root,
  repoRoot: repo.root,
  notes: [
    note("n1", "s1", "01", "non, pas de npm pour ça"),
    note("n2", "s2", "02", "pas de npm, installe avec pnpm"),
    note("n3", "s3", "03", "encore npm ? installe avec pnpm"),
    note("n4", "s4", "04", "Désormais, installe directement avec pnpm", { isExplicit: true }),
  ],
  rules: [
    {
      file: {
        loadedPath: AGENTS,
        sourcePath: AGENTS,
        repoRoot: repo.root,
        scope: "repo",
        blobHash: "x",
        paths: null,
        bullets: [{ id: bulletId, line: 3, text: "- Run `bun run check` before a commit." }],
      },
      text: RULE_TEXT,
    },
  ],
  history: [],
};

const candidate = (overrides: Partial<Candidate> = {}): Candidate => ({
  verdict: "missing",
  scope: "repo",
  targetPath: AGENTS,
  noteIds: ["n1", "n2", "n3"],
  ruleBulletIds: [],
  claimFr: "Pas de npm dans ce dépôt.",
  reasoningFr: "Corrigé trois fois.",
  lessonEn: "Install packages with pnpm.",
  subjectEn: "Install packages with pnpm",
  change: {
    kind: "edit",
    edits: [
      {
        oldText: "- Keep commits small.",
        newText: "- Keep commits small.\n- Install packages with pnpm, never npm.",
      },
    ],
  },
  isWatchTask: false,
  singleSessionJustification: null,
  ...overrides,
});

const context: GateContext = {
  runId: "r1",
  now: NOW,
  minSessions: 3,
  minDays: 2,
  rejected: new Map(),
  pending: new Set(),
};

describe("gateLearn", () => {
  test("a well-supported missing rule becomes a Proposal with code-computed prevalence", () => {
    const result = gateLearn(group, { candidates: [candidate()] }, context);
    expect(result.dropped).toEqual([]);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({
      source: "learn",
      targetPath: AGENTS,
      scope: "repo",
      verdict: "missing",
      prevalence: { sessions: 3, days: 3, repos: 1 },
      fingerprint: fingerprint(AGENTS, "Install packages with pnpm."),
    });
    expect(result.usedNoteIds).toEqual(["n1", "n2", "n3"]);
  });

  test("an unknown note or bullet id fails the whole answer", () => {
    expect(() => gateLearn(group, { candidates: [candidate({ noteIds: ["nope"] })] }, context)).toThrow("unknown note");
    expect(() => gateLearn(group, { candidates: [candidate({ ruleBulletIds: ["AGENTS.md#dead"] })] }, context)).toThrow(
      "unknown bullet",
    );
  });

  test("principle 5: one session passes only when stated outright, in conflict with a loaded rule, or a clear Observation", () => {
    const one = (overrides: Partial<Candidate>) =>
      gateLearn(group, { candidates: [candidate({ noteIds: ["n1"], ...overrides })] }, context);
    expect(one({}).dropped[0]?.reason).toBe("below-threshold");
    expect(gateLearn(group, { candidates: [candidate({ noteIds: ["n4"] })] }, context).proposals).toHaveLength(1);
    expect(one({ verdict: "conflict", ruleBulletIds: [bulletId] }).proposals).toHaveLength(1);
    expect(one({ verdict: "conflict" }).dropped[0]?.reason).toBe("conflict-without-rule");
    const observed: LearnGroup = {
      ...group,
      notes: [note("o1", "s9", "05", "bun run check:full", { kind: "observation", tool: "Bash", isExplicit: false })],
    };
    expect(
      gateLearn(
        observed,
        { candidates: [candidate({ noteIds: ["o1"], singleSessionJustification: "The script does not exist." })] },
        context,
      ).proposals,
    ).toHaveLength(1);
    expect(gateLearn(observed, { candidates: [candidate({ noteIds: ["o1"] })] }, context).dropped[0]?.reason).toBe(
      "below-threshold",
    );
  });

  test("watch tasks, hold verdicts, style violations, edits that do not apply and unknown targets are dropped", () => {
    const reasons = gateLearn(
      group,
      {
        candidates: [
          candidate({ isWatchTask: true }),
          candidate({ verdict: "hold" }),
          candidate({
            change: {
              kind: "edit",
              edits: [{ oldText: "- Keep commits small.", newText: "- As of 2026-10-01 use pnpm." }],
            },
          }),
          candidate({ change: { kind: "edit", edits: [{ oldText: "- Nothing like this.", newText: "x" }] } }),
          candidate({ targetPath: "/elsewhere/AGENTS.md" }),
          candidate({
            targetPath: `${repo.root}/notes/x.md`,
            change: { kind: "edit", edits: [{ oldText: "", newText: "- x\n" }] },
          }),
        ],
      },
      context,
    ).dropped.map((drop) => drop.reason);
    expect(reasons).toEqual([
      "watch-task",
      "hold",
      "style",
      "old-text-not-found",
      "unknown-target",
      "new-file-outside-rules",
    ]);
  });

  test("a new path-scoped file inside the repository is accepted as a creation", () => {
    const result = gateLearn(
      group,
      {
        candidates: [
          candidate({
            targetPath: `${repo.root}/.claude/rules/packages.md`,
            change: {
              kind: "edit",
              edits: [{ oldText: "", newText: "---\npaths:\n  - src/**\n---\n- Install packages with pnpm.\n" }],
            },
          }),
        ],
      },
      context,
    );
    expect(result.proposals[0]).toMatchObject({ scope: "path", targetPath: `${repo.root}/.claude/rules/packages.md` });
  });

  test("a global target needs two repositories or a Steer stated for every repository", () => {
    const globalFile = {
      ...group.rules[0]!.file,
      loadedPath: join(home, ".claude/AGENTS.md"),
      sourcePath: join(home, ".claude/AGENTS.md"),
      repoRoot: null,
      scope: "global" as const,
    };
    const withGlobal: LearnGroup = { ...group, rules: [...group.rules, { file: globalFile, text: RULE_TEXT }] };
    const target = { targetPath: globalFile.sourcePath };
    expect(gateLearn(withGlobal, { candidates: [candidate(target)] }, context).dropped[0]?.reason).toBe(
      "global-one-repo",
    );
    const everywhere: LearnGroup = {
      ...withGlobal,
      notes: [
        ...group.notes,
        note("n5", "s5", "06", "Partout, dans tous les dépôts, installe avec pnpm", { isExplicit: true }),
      ],
    };
    expect(
      gateLearn(everywhere, { candidates: [candidate({ ...target, noteIds: ["n5"] })] }, context).proposals,
    ).toHaveLength(1);
    const twoRepos: LearnGroup = {
      ...withGlobal,
      notes: [...group.notes, note("n6", "s6", "06", "x", { repoRoot: "/other" })],
    };
    expect(
      gateLearn(twoRepos, { candidates: [candidate({ ...target, noteIds: ["n1", "n2", "n6"] })] }, context).proposals,
    ).toHaveLength(1);
  });

  test("a rejected fingerprint returns only with more sessions than at the rejection; duplicates share evidence", () => {
    const print = fingerprint(AGENTS, "Install packages with pnpm.");
    expect(
      gateLearn(group, { candidates: [candidate()] }, { ...context, rejected: new Map([[print, 3]]) }).dropped[0]
        ?.reason,
    ).toBe("ledger-rejected");
    expect(
      gateLearn(group, { candidates: [candidate()] }, { ...context, rejected: new Map([[print, 2]]) }).proposals,
    ).toHaveLength(1);
    expect(
      gateLearn(group, { candidates: [candidate()] }, { ...context, pending: new Set([print]) }).dropped[0]?.reason,
    ).toBe("already-proposed");
    const twins = gateLearn(
      group,
      {
        candidates: [
          candidate(),
          candidate({ lessonEn: "Another wording of the same thing.", noteIds: ["n1", "n2", "n3"] }),
        ],
      },
      context,
    );
    expect(twins.proposals).toHaveLength(1);
    expect(twins.dropped.map((d) => d.reason)).toEqual(["duplicate-evidence"]);
  });
});

describe("learn", () => {
  let store: StoreShape;
  const config: HindsightConfig = {
    ...defaultConfig,
    learn: { ...defaultConfig.learn, pendingNotes: 2, maxBudgetUsd: 0.25 },
  };

  const seed = (count: number) =>
    Effect.runPromise(
      store.transaction((db) => {
        insertDebrief(db, { id: "d1", sessionId: "s1", repoRoot: repo.root, at: NOW });
        for (let i = 1; i <= count; i += 1) {
          insertNote(db, {
            id: `n${i}`,
            debriefId: "d1",
            sessionId: `s${i}`,
            repoRoot: repo.root,
            at: `2026-10-0${i}T10:00:00.000Z`,
            kind: "steer",
            status: "pending",
            evidenceId: `s${i}:u${i}`,
            lesson: "Install packages with pnpm.",
            body: { quote: `correction ${i}: pas de npm`, habit: true },
            loadedRules: [AGENTS],
          });
        }
      }),
    );

  const run = (answers: readonly unknown[], ifDue = false, nowIso = NOW) =>
    Effect.runPromise(
      learn({ ifDue, inventoryEnv: { home } }, config, nowIso).pipe(
        Effect.provide(Layer.succeed(Store, store)),
        Effect.provide(Layer.succeed(ClaudeRunner, scriptedRunner(answers))),
      ),
    );

  const proposals = () => Effect.runPromise(store.all<ProposalRow>("SELECT * FROM proposals ORDER BY created_at"));

  beforeEach(async () => {
    store = await Effect.runPromise(makeStore(":memory:"));
  });

  test("turns pending Notes into Proposals, marks them used, records the run and its cost", async () => {
    await seed(3);
    const report = await run([{ candidates: [candidate()] }]);
    expect(report).toMatchObject({
      pruned: 1,
      status: "complete",
      groups: 1,
      notesRead: 3,
      proposals: 1,
      failures: [],
      costUsd: 0.1,
    });
    expect((await proposals())[0]).toMatchObject({
      state: "pending",
      source: "learn",
      target_path: AGENTS,
      learn_run_id: report.runId,
    });
    const notes = await Effect.runPromise(store.all<{ status: string }>("SELECT status FROM notes"));
    expect(notes.map((n) => n.status)).toEqual(["used", "used", "used"]);
    const runs = await Effect.runPromise(
      store.all<{ status: string; cost_usd: number; proposals_written: number }>(
        "SELECT status, cost_usd, proposals_written FROM learn_runs",
      ),
    );
    expect(runs).toEqual([{ status: "complete", cost_usd: 0.1, proposals_written: 1 }]);
  });

  test("--if-due skips below the Notes threshold and inside the interval", async () => {
    await seed(1);
    expect(await run([], true)).toMatchObject({ status: "skipped", reason: "pending-notes:1" });
    await Effect.runPromise(
      store.transaction((db) =>
        db.run("INSERT INTO learn_runs (id, started_at, finished_at, status) VALUES ('old', ?, ?, 'complete')", [
          NOW,
          NOW,
        ]),
      ),
    );
    await Effect.runPromise(
      store.transaction((db) => {
        for (let i = 2; i <= 3; i += 1) {
          insertNote(db, {
            id: `m${i}`,
            debriefId: "d1",
            sessionId: `s${i}`,
            repoRoot: repo.root,
            at: NOW,
            kind: "steer",
            status: "pending",
            evidenceId: `s${i}:u`,
            lesson: "x",
            body: { quote: "y", habit: false },
            loadedRules: [],
          });
        }
      }),
    );
    expect(await run([], true)).toMatchObject({ status: "skipped", reason: "interval" });
  });

  test("two runs at once: the second finds the slot taken", async () => {
    await seed(3);
    await Effect.runPromise(
      store.transaction((db) =>
        db.run("INSERT INTO learn_runs (id, started_at, status) VALUES ('live', ?, 'running')", [NOW]),
      ),
    );
    expect(await run([{ candidates: [] }])).toMatchObject({ status: "skipped", reason: "running" });
  });

  test("a rejected fingerprint is not proposed again, even when the model proposes it again", async () => {
    await seed(3);
    const print = fingerprint(AGENTS, "Install packages with pnpm.");
    await Effect.runPromise(
      store.transaction((db) => {
        db.run(
          `INSERT INTO proposals (id, fingerprint, created_at, state, source, target_path, scope, claim_fr, reasoning_fr, lesson_en, subject_en, change_json, evidence_json, prevalence_json)
           VALUES ('p0', ?, ?, 'rejected', 'learn', ?, 'repo', '', '', 'Install packages with pnpm.', '', '{}', '[]', '{}')`,
          [print, NOW, AGENTS],
        );
        db.run(
          "INSERT INTO decisions (proposal_id, fingerprint, at, decision, reason, sessions_at_decision) VALUES ('p0', ?, ?, 'rejected', 'non', 3)",
          [print, NOW],
        );
      }),
    );
    const report = await run([{ candidates: [candidate()] }]);
    expect(report.proposals).toBe(0);
    expect(report.dropped).toEqual({ "ledger-rejected": 1 });
    expect(await Effect.runPromise(store.all("SELECT id FROM proposals WHERE source = 'learn'"))).toHaveLength(1);
  });

  test("an unknown id fails that group and writes nothing; a model error is recorded with its cost", async () => {
    await seed(3);
    const failed = await run([{ candidates: [candidate({ noteIds: ["ghost"] })] }]);
    expect(failed).toMatchObject({ status: "failed", proposals: 0 });
    expect(failed.failures[0]).toContain("unknown note");
    expect(await Effect.runPromise(store.all("SELECT id FROM proposals WHERE source = 'learn'"))).toHaveLength(0);
    const errored = await run([new ModelError({ kind: "timeout", label: "learn", detail: "killed", costUsd: 0.05 })]);
    expect(errored).toMatchObject({ status: "failed", costUsd: 0.05 });
  });

  test("the budget caps the calls: a group past the remaining budget is not called", async () => {
    await seed(3);
    await Effect.runPromise(
      store.transaction((db) =>
        insertNote(db, {
          id: "g1",
          debriefId: "d1",
          sessionId: "s9",
          repoRoot: null,
          at: NOW,
          kind: "steer",
          status: "pending",
          evidenceId: "s9:u",
          lesson: "x",
          body: { quote: "y", habit: false },
          loadedRules: [],
        }),
      ),
    );
    const tight: HindsightConfig = { ...config, learn: { ...config.learn, maxBudgetUsd: 0.11 } };
    const report = await Effect.runPromise(
      learn({ ifDue: false, inventoryEnv: { home } }, tight, NOW).pipe(
        Effect.provide(Layer.succeed(Store, store)),
        Effect.provide(Layer.succeed(ClaudeRunner, scriptedRunner([{ candidates: [] }, { candidates: [] }]))),
      ),
    );
    expect(report.groups).toBe(2);
    expect(report.dropped).toEqual({ budget: 1 });
  });

  test("Notes older than the window expire before the run", async () => {
    await seed(2);
    await Effect.runPromise(
      store.transaction((db) => db.run("UPDATE notes SET at = '2026-08-01T00:00:00.000Z' WHERE id = 'n1'")),
    );
    const report = await run([{ candidates: [] }]);
    expect(report.notesRead).toBe(1);
    const statuses = await Effect.runPromise(
      store.all<{ id: string; status: string }>("SELECT id, status FROM notes ORDER BY id"),
    );
    expect(statuses).toEqual([
      { id: "n1", status: "expired" },
      { id: "n2", status: "pending" },
    ]);
  });
});

describe("toNoteView and planGroups", () => {
  test("reads a Steer's markers from its quote and groups by checkout, the global rules in every group", () => {
    const view = toNoteView({
      id: "n",
      debrief_id: "d",
      session_id: "s",
      repo_root: "/nowhere",
      at: NOW,
      kind: "steer",
      status: "pending",
      evidence_id: "s:u",
      lesson: "l",
      body_json: JSON.stringify({ quote: "Désormais, réponds en français", habit: true }),
      loaded_rules_json: JSON.stringify([AGENTS]),
    });
    expect(view).toMatchObject({ kind: "steer", isExplicit: true, loadedRules: [AGENTS] });
    const globalFile = {
      ...group.rules[0]!.file,
      sourcePath: "/h/.claude/AGENTS.md",
      loadedPath: "/h/.claude/AGENTS.md",
      repoRoot: null,
      scope: "global" as const,
    };
    const groups = planGroups([view!, note("x", "s", "01", "t")], [group.rules[0]!.file, globalFile], []);
    expect(groups.map((g) => [g.key, g.notes.length, g.rules.length])).toEqual([
      ["global", 2, 1],
      [repo.root, 1, 2],
    ]);
  });
});

describe("prune", () => {
  test("a dead glob becomes a description Proposal once, filtered by the Ledger", async () => {
    const store = await Effect.runPromise(makeStore(":memory:"));
    const first = await Effect.runPromise(
      prune([repo.root], { home }, NOW).pipe(Effect.provide(Layer.succeed(Store, store))),
    );
    expect(first).toMatchObject({ repos: 1, proposals: 1, skipped: {} });
    expect(first.findings).toBeGreaterThanOrEqual(1);
    const rows = await Effect.runPromise(store.all<ProposalRow>("SELECT * FROM proposals"));
    expect(rows[0]).toMatchObject({
      source: "prune",
      scope: "repo",
      target_path: join(repo.root, ".claude/rules/dead.md"),
    });
    expect(JSON.parse(rows[0]?.change_json ?? "")).toMatchObject({ kind: "description" });
    expect(rows[0]?.claim_fr).toContain("legacy/**");
    const second = await Effect.runPromise(
      prune([repo.root], { home }, NOW).pipe(Effect.provide(Layer.succeed(Store, store))),
    );
    expect(second.skipped).toEqual({ "already-pending": first.findings });
    await Effect.runPromise(
      store.transaction((db) => {
        db.run("UPDATE proposals SET state = 'rejected'");
        for (const row of rows)
          db.run(
            "INSERT INTO decisions (proposal_id, fingerprint, at, decision, reason, sessions_at_decision) VALUES (?, ?, ?, 'rejected', 'keep', 0)",
            [row.id, row.fingerprint, NOW],
          );
      }),
    );
    const third = await Effect.runPromise(
      prune([repo.root], { home }, NOW).pipe(Effect.provide(Layer.succeed(Store, store))),
    );
    expect(third.skipped).toEqual({ "ledger-rejected": first.findings });
    expect(await Effect.runPromise(knownRepos.pipe(Effect.provide(Layer.succeed(Store, store))))).toEqual([repo.root]);
  });
});
