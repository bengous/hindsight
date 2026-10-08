import type { ErrorEvent } from "../types.ts";
import { describe, expect, test } from "bun:test";
import { bashKey, clusterErrors, errorSignature, hookErrorSignature, isNoiseSignature, maskDetail } from "./errors.ts";

const bash = (command: string) => ({ name: "Bash", input: { command } });

describe("bashKey", () => {
  test.each([
    ["git -C /x commit -m msg", "git commit"],
    ["cd /home/u/proj && bun test src", "bun test"],
    ["S=/tmp/x && rm -rf $S/out", "rm"],
    ["FOO=1 BAR=2 python3 script.py", "python3"],
    ["/usr/bin/ls -la", "ls"],
    ["", "?"],
  ])("%p -> %p", (command, key) => {
    expect(bashKey(command)).toBe(key);
  });
});

describe("errorSignature", () => {
  test("masks paths, numbers and ids in the first error line", () => {
    expect(
      errorSignature(bash("bun test"), "Exit code 1\nrunning\nerror: expected 3 at /home/u/a.ts:12 (abc1234f)"),
    ).toBe("Bash[bun test] error: expected # at <path>:# (#)");
  });

  test("names the hook that blocked a call", () => {
    const text =
      'PreToolUse:Bash hook error: [bun "$CLAUDE_PROJECT_DIR/.claude/hooks/guard.ts"]: BLOCKED: rm -rf in /tmp/x';
    expect(errorSignature(bash("rm -rf /tmp/x"), text)).toBe("Bash[rm] hook-block guard.ts: BLOCKED: rm -rf in <path>");
    expect(errorSignature(bash("rm -rf x"), "PreToolUse:Bash hook error: Recursive delete refused")).toBe(
      "Bash[rm] hook-block: Recursive delete refused",
    );
  });

  test("keeps the auto-mode denial reason", () => {
    const text =
      "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Self-Modification].";
    expect(errorSignature(bash("git add x"), text)).toBe("Bash[git add] auto-mode denial [self-modification]");
  });

  test("classifies harness errors", () => {
    expect(
      errorSignature({ name: "Edit", input: {} }, "<tool_use_error>File has not been read yet.</tool_use_error>"),
    ).toBe("Edit edit before read");
    expect(errorSignature(bash("ls /x"), "Exit code 2\nls: cannot access '/x': No such file or directory")).toBe(
      "Bash[ls] missing file",
    );
  });

  test("reports exit-only failures and unknown tools", () => {
    expect(errorSignature(bash("pkill foo"), "Exit code 1")).toBe("Bash[pkill] exit-only");
    expect(errorSignature(null, "boom failed")).toBe("unknown boom failed");
  });
});

describe("hookErrorSignature", () => {
  test("skips the quality-gate header", () => {
    expect(
      hookErrorSignature("PostToolUse:Edit", "Post-edit lint failed:\nsrc/a.ts:3:1: error no-unused-vars"),
    ).toBe("hook:PostToolUse:Edit src<path>:#:#: error no-unused-vars");
  });
});

describe("isNoiseSignature", () => {
  test.each([
    ["Read missing file", true],
    ["Edit edit string not found", true],
    ["Bash[pkill] exit-only", true],
    ["Bash[git commit] exit-only", true],
    ["Bash[rm] hook-block guard.ts: BLOCKED", false],
  ])("%p -> %p", (signature, noise) => {
    expect(isNoiseSignature(signature)).toBe(noise);
  });
});

describe("maskDetail", () => {
  test("caps the length", () => {
    expect(maskDetail("x".repeat(200))).toHaveLength(90);
  });
});

const event = (
  sessionId: string,
  timestamp: string,
  signature: string,
  repoRoot: string | null = "/r",
): ErrorEvent => ({
  evidenceId: `${sessionId}:${timestamp}`,
  sessionId,
  repoRoot,
  timestamp,
  tool: signature.split(" ")[0] ?? "",
  signature,
  excerpt: `excerpt ${timestamp}`,
});

describe("clusterErrors", () => {
  const events = [
    event("s1", "2026-03-01T10:00:00Z", "Bash[rm] hook-block guard.ts: BLOCKED"),
    event("s1", "2026-03-01T11:00:00Z", "Bash[rm] hook-block guard.ts: BLOCKED"),
    event("s2", "2026-03-02T10:00:00Z", "Bash[rm] hook-block guard.ts: BLOCKED", "/q"),
    event("s3", "2026-03-03T10:00:00Z", "Bash[rm] hook-block guard.ts: BLOCKED", null),
    event("s1", "2026-03-01T10:00:00Z", "Read missing file"),
    event("s2", "2026-03-02T10:00:00Z", "Read missing file"),
    event("s3", "2026-03-03T10:00:00Z", "Read missing file"),
    event("s1", "2026-03-01T10:00:00Z", "Bash[sleep] Blocked: sleep"),
    event("s2", "2026-03-01T12:00:00Z", "Bash[sleep] Blocked: sleep"),
    event("s3", "2026-03-01T13:00:00Z", "Bash[sleep] Blocked: sleep"),
  ];

  test("counts distinct sessions and days, drops noise, applies thresholds", () => {
    const clusters = clusterErrors(events, { minSessions: 3, minDays: 2 });
    expect(clusters).toEqual([
      {
        signature: "Bash[rm] hook-block guard.ts: BLOCKED",
        tool: "Bash[rm]",
        sessions: 3,
        days: 3,
        repoRoots: ["/q", "/r"],
        sample: ["s3:2026-03-03T10:00:00Z", "s2:2026-03-02T10:00:00Z", "s1:2026-03-01T11:00:00Z"],
        excerpt: "excerpt 2026-03-03T10:00:00Z",
      },
    ]);
  });

  test("defaults to 3 sessions over 2 days", () => {
    expect(clusterErrors(events).map((c) => c.signature)).toEqual(["Bash[rm] hook-block guard.ts: BLOCKED"]);
  });

  test("ranks by sessions, then days", () => {
    const clusters = clusterErrors(events, { minSessions: 1, minDays: 1 });
    expect(clusters.map((c) => c.signature)).toEqual([
      "Bash[rm] hook-block guard.ts: BLOCKED",
      "Bash[sleep] Blocked: sleep",
    ]);
  });
});
