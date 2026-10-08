import type { ErrorCluster, SteeringItem } from "../types.ts";
import type { CuratorOutput, GateContext } from "./curator.ts";
import { describe, expect, test } from "bun:test";
import { relative } from "node:path";
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
import { curatorOutput, curatorPrompt, DEFAULT_THRESHOLDS, gateCuration } from "./curator.ts";
import { EvidenceError } from "./extract.ts";
import { GLOBAL_GROUP, planGroups } from "./groups.ts";

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
  matchesPaths: (globs, absFile, repoRoot) =>
    globs.some((glob) => new Bun.Glob(glob).match(relative(repoRoot, absFile))),
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

  test("an explicit instruction passes at one session", () => {
    const explicitPlan = planGroups({
      digests,
      items: [
        item("s5:u1", "ne doivent pas citer de ticket", "Keep ticket numbers out of docs.", { kind: "explicit" }),
      ],
      rules: ruleSources,
      clusters: [],
      events: [],
      stale: [],
      ruleDiffs: new Map(),
      history: [],
      maxRuleChars: 100_000,
    });
    const [only] = explicitPlan.groups;
    if (only === undefined) {
      throw new Error("no group");
    }
    const result = gateCuration(
      only,
      { candidates: [candidate({ memberEvidenceIds: ["s5:u1"], lesson: "Keep ticket numbers out of docs." })] },
      context,
    );
    expect(result.proposals).toHaveLength(1);
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

  test("suppresses a fingerprint already in the ledger and duplicates within the run", () => {
    const first = gate(repo, [candidate({})]).proposals[0];
    const fingerprint = first?.fingerprint ?? "";
    expect(gate(repo, [candidate({})], { knownFingerprints: new Set([fingerprint]) }).dropped[0]?.reason).toBe(
      "already-proposed",
    );
    expect(gate(repo, [candidate({}), candidate({ title: "même leçon" })]).proposals).toHaveLength(1);
  });
});
