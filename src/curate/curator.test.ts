import type { ErrorCluster, SteeringItem } from "../types.ts";
import type { CuratorOutput, GateContext } from "./curator.ts";
import { describe, expect, test } from "bun:test";
import {
  docsRule,
  errorEvent,
  globalAgents,
  home,
  promptData,
  repo,
  repoAgents,
  ruleSources,
  session,
} from "../../fixtures/curate/world.ts";
import { decode, DecodeError } from "../model/codec.ts";
import { ruleAppliesTo } from "../rules/glob.ts";
import { curatorOutput, curatorPrompt, DEFAULT_THRESHOLDS, gateCuration } from "./curator.ts";
import { EvidenceError } from "./extract.ts";
import { GLOBAL_GROUP, planGroups } from "./groups.ts";
import { supportKey } from "./support.ts";

const factoryLesson = "Build orders with makeOrder() in tests.";
const digests = [
  session("s1", [{ uuid: "u1", at: "2026-10-01T09:00:00Z", text: "utilise makeOrder() pour les commandes" }]),
  session("s2", [{ uuid: "u1", at: "2026-10-02T09:00:00Z", text: "encore une fois, makeOrder() !" }]),
  session("s3", [{ uuid: "u1", at: "2026-10-03T09:00:00Z", text: "pas de littéral Order, makeOrder()" }]),
  session("s4", [{ uuid: "u1", at: "2026-10-04T09:00:00Z", text: "pas besoin de relancer le build tout le temps" }]),
  session("s5", [{ uuid: "u1", at: "2026-10-04T10:00:00Z", text: "les docs ne doivent pas citer de ticket" }], {
    filesTouched: [`${repo}/src/app.ts`],
  }),
  session("s6", [{ uuid: "u1", at: "2026-10-05T10:00:00Z", text: "lance bun test avant de commit" }]),
  session("s7", [{ uuid: "u1", at: "2026-10-06T10:00:00Z", text: "tu as encore oublié bun test" }]),
  session("s-nocheckout", [{ uuid: "u1", at: "2026-10-06T10:00:00Z", text: "ailleurs" }], { repoRoot: null }),
];

function item(evidenceId: string, quote: string, lesson: string, overrides: Partial<SteeringItem> = {}): SteeringItem {
  return {
    evidenceId: evidenceId as SteeringItem["evidenceId"],
    quote,
    kind: "inferred",
    lesson,
    scopeHint: "repo",
    pathHint: null,
    ...overrides,
  };
}

const items: readonly SteeringItem[] = [
  item("s1:u1", "makeOrder()", factoryLesson),
  item("s2:u1", "makeOrder()", factoryLesson),
  item("s3:u1", "makeOrder()", factoryLesson),
  item("s4:u1", "pas besoin de relancer le build", "Do not update snapshots after every commit.", { scopeHint: "global" }),
  item("s5:u1", "ne doivent pas citer de ticket", "Keep ticket numbers out of docs."),
  item("s6:u1", "bun test", "Run bun test before committing."),
  item("s7:u1", "bun test", "Run bun test before committing."),
  item("s-nocheckout:u1", "ailleurs", "Somewhere else."),
];

const signature = "Bash: PreToolUse:Bash hook error: [rm -rf <path>]";
const cluster: ErrorCluster = {
  signature,
  tool: "Bash",
  sessions: 3,
  days: 2,
  repoRoots: [repo],
  sample: ["e1:u1", "e2:u1"],
  excerpt: "PreToolUse:Bash hook error: [rm -rf <path>]: blocked by no-rm",
};
const events = [
  errorEvent("e1", "u1", "2026-10-01T09:00:00Z", signature),
  errorEvent("e2", "u1", "2026-10-01T11:00:00Z", signature),
  errorEvent("e3", "u1", "2026-10-02T09:00:00Z", signature),
];

const plan = planGroups({
  digests,
  items,
  rules: ruleSources,
  clusters: [cluster],
  events,
  stale: [],
  ruleDiffs: new Map([[repo, "diff --git a/AGENTS.md b/AGENTS.md"]]),
  history: [],
  maxRuleChars: 100_000,
});

function group(key: string) {
  const found = plan.groups.find((entry) => entry.key === key);
  if (found === undefined) {
    throw new Error(`no group ${key}`);
  }
  return found;
}

const context: GateContext = {
  runId: "r1",
  now: "2026-10-08T09:00:00Z",
  thresholds: DEFAULT_THRESHOLDS,
  knownFingerprints: new Set(),
  ruleAppliesTo,
  unsupported: new Set(),
};

type Candidate = CuratorOutput["candidates"][number];

function candidate(overrides: Partial<Candidate>): Candidate {
  return {
    kind: "missing",
    lesson: factoryLesson,
    title: "Utiliser makeOrder() dans les tests",
    why: "Corrigé dans trois sessions.",
    commitSubject: "Require makeOrder() for orders in tests",
    memberEvidenceIds: ["s1:u1", "s2:u1", "s3:u1"],
    ruleBulletIds: [],
    errorSignature: null,
    staleFindingId: null,
    op: {
      op: "add",
      sourcePath: `${repo}/AGENTS.md`,
      edits: [
        {
          oldText: "- Tests live next to the code they cover.",
          newText: "- Tests live next to the code they cover.\n- Build orders with `makeOrder()` in tests.",
        },
      ],
    },
    suggestion: null,
    confidence: "high",
    ...overrides,
  };
}

function gate(key: string, candidates: readonly Candidate[], overrides: Partial<GateContext> = {}) {
  return gateCuration(group(key), { candidates }, { ...context, ...overrides });
}

describe("planGroups", () => {
  test("sends global items to the global group and drops sessions without a checkout", () => {
    expect(plan.groups.map((entry) => entry.key)).toEqual([repo, GLOBAL_GROUP].toSorted());
    expect(group(GLOBAL_GROUP).items.map((ref) => ref.item.evidenceId)).toEqual(["s4:u1"]);
    expect(group(GLOBAL_GROUP).repoRoot).toBe(globalAgents.repoRoot);
    expect(group(repo).clusters.map((ref) => ref.events.length)).toEqual([3]);
    expect(plan.dropped).toEqual([{ reason: "no-checkout", detail: "s-nocheckout:u1 (/tmp/elsewhere)" }]);
  });

  test("gives the repo group its rules plus the global file, and the rule diff", () => {
    expect(
      group(repo)
        .rules.map((rule) => rule.file.sourcePath)
        .toSorted(),
    ).toEqual([globalAgents.sourcePath, repoAgents.sourcePath].toSorted());
    expect(group(repo).listedRules.map((file) => file.sourcePath)).toEqual([docsRule.sourcePath]);
    expect(group(repo).ruleDiff).toContain("AGENTS.md");
  });

  test("gives the global group the repository rules its sessions had loaded, so it can see a conflict there", () => {
    expect(
      group(GLOBAL_GROUP)
        .rules.map((rule) => rule.file.sourcePath)
        .toSorted(),
    ).toEqual([globalAgents.sourcePath, repoAgents.sourcePath].toSorted());
    const conflict = candidate({
      kind: "conflict",
      lesson: "Run tests only when asked.",
      memberEvidenceIds: ["s4:u1"],
      ruleBulletIds: ["AGENTS.md#bb000001"],
      op: {
        op: "update",
        sourcePath: repoAgents.sourcePath,
        edits: [{ oldText: "- Run `bun test` before committing.", newText: "- Run `bun test` when asked." }],
      },
    });
    const [proposal] = gate(GLOBAL_GROUP, [conflict]).proposals;
    expect(proposal?.target).toEqual({
      repoRoot: repo,
      sourcePath: repoAgents.sourcePath,
      blobHash: repoAgents.blobHash,
    });
  });

  test("a rule changed after the session is flagged even when two source files share its loaded path", () => {
    const loadedPath = `${home}/.claude/output-styles/plain.md`;
    const styleFile = (sourcePath: string, id: string, text: string) => ({
      file: {
        loadedPath: "~/.claude/output-styles/plain.md",
        sourcePath,
        repoRoot: globalAgents.repoRoot,
        scope: "global" as const,
        blobHash: "6666666666666666666666666666666666666666",
        paths: null,
        bullets: [{ id, line: 1, text }],
      },
      text,
    });
    const styleSession = session(
      "s10",
      [{ uuid: "u1", at: "2026-10-07T10:00:00Z", text: "pas de résumé en fin de réponse" }],
      {
        loadedRules: [{ path: loadedPath, source: "output_style", content: "- Answer first.\n" }],
      },
    );
    const stylePlan = planGroups({
      digests: [styleSession],
      items: [item("s10:u1", "pas de résumé en fin de réponse", "Skip closing summaries.", { scopeHint: "global" })],
      rules: [
        styleFile(`${globalAgents.repoRoot}/dot_claude/output-styles/plain.md.tmpl`, "brief#1", "- Answer first."),
        styleFile(`${globalAgents.repoRoot}/.chezmoitemplates/style-core.md`, "core#1", "- Answer in plain words."),
      ],
      clusters: [],
      events: [],
      stale: [],
      ruleDiffs: new Map(),
      history: [],
      maxRuleChars: 100_000,
    });
    expect(stylePlan.groups[0]?.items[0]?.changedRulePaths).toEqual([loadedPath]);
  });

  test("the curator prompt carries ids, loaded rules and bullets as data", () => {
    const data = promptData(curatorPrompt(group(repo))) as {
      items: { id: string; loadedRules: string[] }[];
      ruleFiles: { sourcePath: string; bullets: { id: string }[] }[];
    };
    expect(data.items.map((entry) => entry.id)).toContain("s1:u1");
    expect(data.items[0]?.loadedRules).toEqual(["~/.claude/AGENTS.md", "AGENTS.md"]);
    expect(data.ruleFiles.flatMap((file) => file.bullets.map((bullet) => bullet.id))).toContain("AGENTS.md#bb000001");
    expect(home.length).toBeGreaterThan(0);
  });
});

describe("gateCuration", () => {
  test("turns a well-supported missing rule into a proposal with code-computed prevalence", () => {
    const { proposals, dropped } = gate(repo, [candidate({})]);
    expect(dropped).toEqual([]);
    const [proposal] = proposals;
    expect(proposal?.prevalence).toMatchObject({ sessions: 3, days: 3, repos: 1 });
    expect(proposal?.target).toEqual({
      repoRoot: repo,
      sourcePath: `${repo}/AGENTS.md`,
      blobHash: repoAgents.blobHash,
    });
    expect(proposal?.evidence.map((entry) => entry.evidenceId)).toEqual(["s3:u1", "s2:u1", "s1:u1"]);
    expect(proposal?.id).toBe(`p-${proposal?.fingerprint.slice(0, 10)}`);
  });

  test("fails the batch on an unknown evidence id, bullet, cluster or stale finding", () => {
    expect(() => gate(repo, [candidate({ memberEvidenceIds: ["s1:u1", "s9:u9"] })])).toThrow(EvidenceError);
    expect(() => gate(repo, [candidate({ ruleBulletIds: ["AGENTS.md#ffffffff"] })])).toThrow("unknown rule bullet");
    expect(() => gate(repo, [candidate({ kind: "tool-config", errorSignature: "Bash: other" })])).toThrow(
      "unknown error cluster",
    );
    expect(() => gate(repo, [candidate({ kind: "stale", staleFindingId: "nope" })])).toThrow("unknown stale finding");
  });

  test("an inferred lesson below three sessions and two days is dropped", () => {
    const { proposals, dropped } = gate(repo, [candidate({ memberEvidenceIds: ["s1:u1", "s2:u1"] })]);
    expect(proposals).toEqual([]);
    expect(dropped[0]?.reason).toBe("below-threshold");
  });

  test("a single-session explicit item passes only when its message carries an instruction or correction marker", () => {
    const lesson = "Keep ticket numbers out of docs.";
    const quote = "ne doivent pas citer de ticket";
    const marked = session("s11", [
      {
        uuid: "u1",
        at: "2026-10-05T10:00:00Z",
        text: "à l'avenir, les docs ne doivent pas citer de ticket",
        markers: ["standing_instruction"],
      },
    ]);
    const gateOne = (evidenceId: string) => {
      const [only] = planGroups({
        digests: [...digests, marked],
        items: [item(evidenceId, quote, lesson, { kind: "explicit" })],
        rules: ruleSources,
        clusters: [],
        events: [],
        stale: [],
        ruleDiffs: new Map(),
        history: [],
        maxRuleChars: 100_000,
      }).groups;
      if (only === undefined) {
        throw new Error("no group");
      }
      return gateCuration(only, { candidates: [candidate({ memberEvidenceIds: [evidenceId], lesson })] }, context);
    };
    expect(gateOne("s5:u1").dropped.map((entry) => entry.reason)).toEqual(["single-session-unmarked"]);
    expect(gateOne("s11:u1").proposals).toHaveLength(1);
  });

  test("a conflict with a loaded rule passes at one session", () => {
    const conflict = candidate({
      kind: "conflict",
      lesson: "Do not update snapshots after every commit.",
      memberEvidenceIds: ["s4:u1"],
      ruleBulletIds: ["~/.claude/AGENTS.md#aa000002"],
      op: {
        op: "update",
        sourcePath: globalAgents.sourcePath,
        edits: [{ oldText: "- Commit, then update snapshots.", newText: "- Commit; update snapshots only when the user asks." }],
      },
    });
    const { proposals } = gate(GLOBAL_GROUP, [conflict]);
    expect(proposals.map((entry) => [entry.kind, entry.prevalence.sessions])).toEqual([["conflict", 1]]);
  });

  test("an ignored rule that was never loaded becomes misplaced when the touched files miss its globs", () => {
    const ignored = candidate({
      kind: "ignored",
      lesson: "Keep ticket numbers out of docs.",
      memberEvidenceIds: ["s5:u1"],
      ruleBulletIds: [".claude/rules/docs.md#cc000001"],
      op: null,
    });
    const { proposals } = gate(repo, [ignored], { thresholds: { minSessions: 1, minDays: 1 } });
    expect(proposals[0]?.kind).toBe("misplaced");
    expect(proposals[0]?.op).toBeNull();
    expect(proposals[0]?.suggestion).toContain(".claude/rules/docs.md");
    expect(proposals[0]?.target.sourcePath).toBe(docsRule.sourcePath);
  });

  test("a nested rule whose globs match from its own directory is not called misplaced", () => {
    const nested = {
      loadedPath: `${repo}/apps/journal/.claude/rules/journal.md`,
      sourcePath: `${repo}/apps/journal/.claude/rules/journal.md`,
      repoRoot: repo,
      scope: "path" as const,
      blobHash: "5555555555555555555555555555555555555555",
      paths: ["src/**"],
      bullets: [
        { id: "apps/journal/.claude/rules/journal.md#ee000001", line: 5, text: "- Journal entries are immutable." },
      ],
    };
    const touchedSession = session(
      "s9",
      [
        {
          uuid: "u1",
          at: "2026-10-07T10:00:00Z",
          text: "ne modifie jamais une entrée",
          markers: ["standing_instruction"],
        },
      ],
      {
        filesTouched: [`${repo}/apps/journal/src/entry.ts`],
      },
    );
    const nestedPlan = planGroups({
      digests: [touchedSession],
      items: [item("s9:u1", "ne modifie jamais une entrée", "Never edit a journal entry.", { kind: "explicit" })],
      rules: [
        ...ruleSources,
        { file: nested, text: "---\npaths:\n  - src/**\n---\n- Journal entries are immutable.\n" },
      ],
      clusters: [],
      events: [],
      stale: [],
      ruleDiffs: new Map(),
      history: [],
      maxRuleChars: 100_000,
    });
    const [only] = nestedPlan.groups;
    if (only === undefined) {
      throw new Error("no group");
    }
    const ignored = candidate({
      kind: "ignored",
      lesson: "Never edit a journal entry.",
      memberEvidenceIds: ["s9:u1"],
      ruleBulletIds: ["apps/journal/.claude/rules/journal.md#ee000001"],
      op: null,
    });
    const { proposals } = gateCuration(only, { candidates: [ignored] }, context);
    expect(proposals.map((proposal) => proposal.kind)).toEqual(["watch"]);
  });

  test("a loaded rule broken in two sessions keeps the model's rewording without the canned hook suggestion", () => {
    const ignored = candidate({
      kind: "ignored",
      lesson: "Run bun test before committing.",
      memberEvidenceIds: ["s6:u1", "s7:u1"],
      ruleBulletIds: ["AGENTS.md#bb000001"],
      op: {
        op: "update",
        sourcePath: `${repo}/AGENTS.md`,
        edits: [
          {
            oldText: "- Run `bun test` before committing.",
            newText: "- Run `bun test` and read its output before committing.",
          },
        ],
      },
    });
    const { proposals } = gate(repo, [ignored], { thresholds: { minSessions: 2, minDays: 2 } });
    expect(proposals[0]?.kind).toBe("ignored");
    expect(proposals[0]?.suggestion).toBeNull();
  });

  test("a loaded rule broken in two sessions stays ignored and gets the hook suggestion", () => {
    const ignored = candidate({
      kind: "ignored",
      lesson: "Run bun test before committing.",
      memberEvidenceIds: ["s6:u1", "s7:u1"],
      ruleBulletIds: ["AGENTS.md#bb000001"],
      op: null,
    });
    const { proposals } = gate(repo, [ignored], { thresholds: { minSessions: 2, minDays: 2 } });
    expect(proposals[0]?.kind).toBe("ignored");
    expect(proposals[0]?.suggestion).toContain("hook");
  });

  test("a tool-config finding counts error sessions and cites error events", () => {
    const toolConfig = candidate({
      kind: "tool-config",
      lesson: "Allow rm -rf inside the session scratchpad.",
      memberEvidenceIds: [],
      errorSignature: signature,
      op: null,
      suggestion: "Autoriser rm -rf sous le scratchpad dans no-rm.",
    });
    const { proposals } = gate(repo, [toolConfig]);
    expect(proposals[0]?.prevalence).toMatchObject({ sessions: 3, days: 2 });
    expect(proposals[0]?.evidence.map((entry) => entry.evidenceId)).toEqual(["e3:u1", "e2:u1", "e1:u1"]);
    expect(proposals[0]?.target.blobHash).toBeNull();
  });

  test("a tool-config or watch finding never carries a diff, so tool output alone cannot change a rule", () => {
    const op = candidate({}).op;
    const toolConfig = candidate({
      kind: "tool-config",
      lesson: "Always run X.",
      memberEvidenceIds: [],
      errorSignature: signature,
      op,
    });
    const watch = candidate({ kind: "watch", lesson: "Maybe use makeOrder() later.", op });
    const { proposals } = gate(repo, [toolConfig, watch]);
    expect(proposals.map((proposal) => [proposal.kind, proposal.op, proposal.target.blobHash])).toEqual([
      ["tool-config", null, null],
      ["watch", null, null],
    ]);
  });

  test("drops ops that cannot apply, break the style rules or create files outside the rules directory", () => {
    const notFound = candidate({
      op: { op: "update", sourcePath: `${repo}/AGENTS.md`, edits: [{ oldText: "- absent line", newText: "- x" }] },
    });
    const dated = candidate({
      op: {
        op: "add",
        sourcePath: `${repo}/AGENTS.md`,
        edits: [{ oldText: "- Run `bun test` before committing.", newText: "- Since 2026-10-01, use makeOrder()." }],
      },
    });
    const outside = candidate({
      op: { op: "add", sourcePath: `${repo}/src/rules.md`, edits: [{ oldText: "", newText: "- x" }] },
    });
    const { proposals, dropped } = gate(repo, [notFound, dated, outside]);
    expect(proposals).toEqual([]);
    expect(dropped.map((entry) => entry.reason)).toEqual(["old-text-not-found", "style", "new-file-outside-rules"]);
  });

  test("creates a new path-scoped rule file inside the repository", () => {
    const creates = candidate({
      op: {
        op: "add",
        sourcePath: `${repo}/.claude/rules/tests.md`,
        edits: [{ oldText: "", newText: '---\npaths:\n  - "**/*.test.ts"\n---\n- Build orders with makeOrder().\n' }],
      },
    });
    const { proposals } = gate(repo, [creates]);
    expect(proposals[0]?.target).toEqual({
      repoRoot: repo,
      sourcePath: `${repo}/.claude/rules/tests.md`,
      blobHash: null,
    });
  });

  test("copies lesson and commit subject, and rejects a commit subject over 72 characters", () => {
    const [proposal] = gate(repo, [candidate({})]).proposals;
    expect(proposal?.lesson).toBe(factoryLesson);
    expect(proposal?.commitSubject).toBe("Require makeOrder() for orders in tests");
    expect(() => decode(curatorOutput, { candidates: [candidate({ commitSubject: "x".repeat(73) })] })).toThrow(
      DecodeError,
    );
  });

  test("of two candidates sharing at least half of the smaller evidence set, only the more confident stays", () => {
    const broad = candidate({ confidence: "medium" });
    const narrow = candidate({
      lesson: "Never write an Order literal in tests.",
      memberEvidenceIds: ["s2:u1", "s3:u1"],
      confidence: "high",
      op: {
        op: "add",
        sourcePath: `${repo}/AGENTS.md`,
        edits: [
          {
            oldText: "- Run `bun test` before committing.",
            newText: "- Run `bun test` before committing.\n- No Order literals.",
          },
        ],
      },
    });
    const apart = candidate({
      lesson: "Run bun test before committing.",
      memberEvidenceIds: ["s6:u1", "s7:u1"],
      op: null,
    });
    const { proposals, dropped } = gate(repo, [broad, narrow, apart], { thresholds: { minSessions: 2, minDays: 2 } });
    expect(proposals.map((proposal) => proposal.lesson)).toEqual([
      "Never write an Order literal in tests.",
      "Run bun test before committing.",
    ]);
    expect(dropped).toEqual([{ reason: "duplicate-evidence", detail: factoryLesson }]);
  });

  test("lists the members each item-based proposal rests on, for the support gate", () => {
    const toolConfig = candidate({
      kind: "tool-config",
      lesson: "Allow rm -rf in the scratchpad.",
      memberEvidenceIds: [],
      errorSignature: signature,
      op: null,
    });
    const { supportWork } = gate(repo, [candidate({}), toolConfig]);
    expect(supportWork).toEqual([
      {
        lesson: factoryLesson,
        members: [
          { evidenceId: "s1:u1", quote: "makeOrder()" },
          { evidenceId: "s2:u1", quote: "makeOrder()" },
          { evidenceId: "s3:u1", quote: "makeOrder()" },
        ],
      },
    ]);
  });

  test("a member judged unsupported leaves, and a proposal left below threshold is dropped as unsupported", () => {
    const unsupported = new Set([supportKey(factoryLesson, { evidenceId: "s3:u1", quote: "makeOrder()" })]);
    const { proposals, dropped, supportWork } = gate(repo, [candidate({})], { unsupported });
    expect(proposals).toEqual([]);
    expect(dropped.map((entry) => entry.reason)).toEqual(["unsupported"]);
    expect(supportWork).toEqual([]);
    const lenient = gate(repo, [candidate({})], { unsupported, thresholds: { minSessions: 2, minDays: 2 } });
    expect(lenient.proposals[0]?.prevalence.sessions).toBe(2);
    expect(lenient.proposals[0]?.evidence.map((entry) => entry.evidenceId)).toEqual(["s2:u1", "s1:u1"]);
  });

  test("suppresses a fingerprint already in the ledger and duplicates within the run", () => {
    const first = gate(repo, [candidate({})]).proposals[0];
    const fingerprint = first?.fingerprint ?? "";
    expect(gate(repo, [candidate({})], { knownFingerprints: new Set([fingerprint]) }).dropped[0]?.reason).toBe(
      "already-proposed",
    );
    expect(gate(repo, [candidate({}), candidate({ title: "même leçon" })]).proposals).toHaveLength(1);
  });
});
