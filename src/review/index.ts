import type { PendingProposal } from "../state/index.ts";
import { existsSync } from "node:fs";
import { applyDelta } from "../rules/apply.ts";
import { gitToplevel } from "../rules/git.ts";
import { inventory } from "../rules/inventory.ts";
import { appendDecision, defaultStateRoot, pendingProposals } from "../state/index.ts";
import { decide, type DecisionDeps } from "./decide.ts";
import { serveReview, type ReviewServer } from "./server.ts";

async function checkouts(pending: readonly PendingProposal[]): Promise<readonly string[]> {
  const roots = [...new Set(pending.map((entry) => entry.proposal.target.repoRoot))].filter(existsSync);
  const toplevels = await Promise.all(roots.map(async (root) => ((await gitToplevel(root)) === root ? root : null)));
  return toplevels.filter((root): root is string => root !== null);
}

async function bulletText(pending: readonly PendingProposal[]): Promise<ReadonlyMap<string, string>> {
  const files = await inventory(await checkouts(pending));
  return new Map(files.flatMap((file) => file.bullets.map((bullet) => [bullet.id, bullet.text] as const)));
}

function deployedPaths(): DecisionDeps["deployedPath"] {
  let globals: Promise<ReadonlyMap<string, string>> | null = null;
  return async (sourcePath) => {
    globals ??= inventory([]).then(
      (files) =>
        new Map(
          files.filter((file) => file.loadedPath !== file.sourcePath).map((file) => [file.sourcePath, file.loadedPath]),
        ),
    );
    return (await globals).get(sourcePath) ?? null;
  };
}

/** `hindsight review`: serves the pending proposals; an accepted card commits, then lands in decisions.jsonl. */
export function startReview(stateRoot: string = defaultStateRoot()): ReviewServer {
  const deps: DecisionDeps = {
    apply: (request) => applyDelta(request),
    record: (decision) => appendDecision(decision, stateRoot),
    deployedPath: deployedPaths(),
    now: () => new Date(),
  };
  return serveReview({
    pending: () => pendingProposals(stateRoot),
    bulletText,
    decide: (pending, request) => decide(pending, request, deps),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    now: () => new Date(),
  });
}
