import type { InventoryEnv } from "../rules/inventory.ts";
import type { StaleFinding } from "../rules/types.ts";
import type { StoreError } from "../store/db.ts";
import type { ProposalInsert } from "../store/queries.ts";

import { Effect } from "effect";
import { existsSync } from "node:fs";
import { basename } from "node:path";

import { newId, sha1 } from "../rules/ids.ts";
import { inventory } from "../rules/inventory.ts";
import { staleScan } from "../rules/stale.ts";
import { Store } from "../store/db.ts";
import { insertProposal, pendingFingerprints, rejectedSessions } from "../store/queries.ts";

export type PruneReport = {
  readonly repos: number;
  readonly findings: number;
  readonly proposals: number;
  readonly skipped: Readonly<Record<string, number>>;
};

export function staleFingerprint(finding: StaleFinding): string {
  return sha1(`stale\n${finding.id}`);
}

const CLAIMS: Record<StaleFinding["reason"], (detail: string, file: string) => string> = {
  "dead-glob": (detail, file) => `Le glob \`${detail}\` de ${file} ne correspond à aucun fichier.`,
  "missing-path": (detail, file) => `${file} cite \`${detail}\`, qui n'existe plus.`,
  "missing-command": (detail, file) => `${file} cite \`${detail}\`, qu'aucun package.json ne définit.`,
};

export function staleProposal(finding: StaleFinding, nowIso: string): ProposalInsert {
  const file = basename(finding.sourcePath);

  return {
    id: newId(),
    fingerprint: staleFingerprint(finding),
    createdAt: nowIso,
    source: "prune",
    targetPath: finding.sourcePath,
    repoRoot: finding.repoRoot,
    scope: "repo",
    verdict: null,
    claimFr: CLAIMS[finding.reason](finding.detail, file),
    reasoningFr:
      "Contrôle en code de Prune, sans modèle : la règle cite quelque chose que le dépôt n'a plus. Un Handoff retire ou corrige la mention.",
    lessonEn: `Rule files cite only paths, globs and scripts the repository has (${finding.reason}: ${finding.detail}).`,
    subjectEn: `Drop the dead reference ${finding.detail} from ${file}`.slice(0, 72),
    change: {
      kind: "description",
      text: `In ${finding.sourcePath}, fix or remove the reference to \`${finding.detail}\` (${finding.reason}).`,
    },
    evidence: [],
    prevalence: { sessions: 0, days: 0, repos: 1, firstAt: nowIso, lastAt: nowIso },
    bulletId: finding.bulletId,
    learnRunId: null,
  };
}

/** Prune's code checks over the repositories hindsight knows: dead globs, gone paths, missing scripts. */
export const prune = (
  repoRoots: readonly string[],
  env: InventoryEnv,
  nowIso: string = new Date().toISOString(),
): Effect.Effect<PruneReport, StoreError, Store> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const roots = [...new Set(repoRoots)].filter((root) => existsSync(root));
    const files = yield* Effect.promise(async () => inventory(roots, env));
    const findings = yield* Effect.promise(async () => staleScan(files));
    const skipped: Record<string, number> = {};
    let proposals = 0;
    yield* store.transaction((db) => {
      const pending = pendingFingerprints(db);

      for (const finding of findings) {
        const print = staleFingerprint(finding);

        if (pending.has(print)) {
          skipped["already-pending"] = (skipped["already-pending"] ?? 0) + 1;
          continue;
        }

        if (rejectedSessions(db, print) !== null) {
          skipped["ledger-rejected"] = (skipped["ledger-rejected"] ?? 0) + 1;
          continue;
        }

        insertProposal(db, staleProposal(finding, nowIso));
        pending.add(print);
        proposals += 1;
      }
    });

    return { repos: roots.length, findings: findings.length, proposals, skipped } satisfies PruneReport;
  });

/** The checkouts Prune scans: where the Notes and the pending Proposals point. */
export const knownRepos = Effect.gen(function* () {
  const store = yield* Store;

  const rows = yield* store.all<{ repo_root: string }>(
    "SELECT DISTINCT repo_root FROM notes WHERE repo_root IS NOT NULL UNION SELECT DISTINCT repo_root FROM proposals WHERE repo_root IS NOT NULL",
  );

  return rows.map((row) => row.repo_root);
});
