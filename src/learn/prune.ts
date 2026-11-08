import type { Oversized } from "../rules/budget.ts";
import type { InventoryEnv } from "../rules/inventory.ts";
import type { StaleFinding } from "../rules/types.ts";
import type { StoreError } from "../store/db.ts";
import type { ProposalInsert } from "../store/queries.ts";

import { Effect } from "effect";
import { existsSync } from "node:fs";
import { basename } from "node:path";

import { newId, sha1 } from "../platform/ids.ts";
import { oversized } from "../rules/budget.ts";
import { inventory } from "../rules/inventory.ts";
import { staleScan } from "../rules/stale.ts";
import { Store } from "../store/db.ts";
import { insertProposal, knownRepoRoots, pendingFingerprints, rejectedSessions } from "../store/queries.ts";

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

/** The file and the budget, not the measured length: a rejection holds until the budget changes. */
export function budgetFingerprint(sourcePath: string, budget: number): string {
  return sha1(`budget\n${sourcePath}\n${budget}`);
}

export function budgetProposal(entry: Oversized, budget: number, nowIso: string): ProposalInsert {
  const { file, chars } = entry;
  const name = basename(file.sourcePath);

  return {
    id: newId(),
    fingerprint: budgetFingerprint(file.sourcePath, budget),
    createdAt: nowIso,
    source: "prune",
    targetPath: file.sourcePath,
    repoRoot: file.repoRoot,
    scope: file.scope,
    verdict: null,
    claimFr: `${name} compte ${chars} caractères, au-delà du budget de ${budget}.`,
    reasoningFr:
      "Contrôle en code de Prune, sans modèle : un Rule File long coûte du contexte à chaque chargement et dilue l'attention portée à chaque règle. Learn ne l'allonge plus ; un Handoff le ramène sous le budget.",
    lessonEn: `Rule files stay under the size budget of ${budget} characters (${name}: ${chars}).`,
    subjectEn: `Trim ${name} under ${budget} characters`.slice(0, 72),
    change: {
      kind: "description",
      text: `${file.sourcePath} holds ${chars} characters, over the size budget of ${budget}. Bring it under the budget: cut what an agent can infer from the code or a tool enforces, merge rules that overlap, and move detail that only some files need into path-scoped rule files.`,
    },
    evidence: [],
    prevalence: { sessions: 0, days: 0, repos: file.repoRoot === null ? 0 : 1, firstAt: nowIso, lastAt: nowIso },
    bulletId: null,
    learnRunId: null,
  };
}

/** Prune's code checks over the repositories hindsight knows: dead globs, gone paths, missing scripts, files over the Size Budget. */
export const prune = (
  repoRoots: readonly string[],
  env: InventoryEnv,
  sizeBudgetChars: number,
  nowIso: string = new Date().toISOString(),
): Effect.Effect<PruneReport, StoreError, Store> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const roots = [...new Set(repoRoots)].filter((root) => existsSync(root));
    const files = yield* Effect.promise(async () => inventory(roots, env));
    const findings = yield* Effect.promise(async () => staleScan(files));
    const over = yield* Effect.promise(async () => oversized(files, sizeBudgetChars));

    const candidates = [
      ...findings.map((finding) => staleProposal(finding, nowIso)),
      ...over.map((entry) => budgetProposal(entry, sizeBudgetChars, nowIso)),
    ];

    const skipped: Record<string, number> = {};
    let proposals = 0;
    yield* store.transaction((db) => {
      const pending = pendingFingerprints(db);

      for (const proposal of candidates) {
        if (pending.has(proposal.fingerprint)) {
          skipped["already-pending"] = (skipped["already-pending"] ?? 0) + 1;
          continue;
        }

        if (rejectedSessions(db, proposal.fingerprint) !== null) {
          skipped["ledger-rejected"] = (skipped["ledger-rejected"] ?? 0) + 1;
          continue;
        }

        insertProposal(db, proposal);
        pending.add(proposal.fingerprint);
        proposals += 1;
      }
    });

    return { repos: roots.length, findings: candidates.length, proposals, skipped } satisfies PruneReport;
  });

/** The checkouts Prune scans: where the Notes and the pending Proposals point. */
export const knownRepos = Effect.gen(function* () {
  const store = yield* Store;

  return yield* store.transaction(knownRepoRoots);
});
