import type { Change, Evidence, Prevalence, ProposalState, Verdict } from "../domain/proposal.ts";
import type { SyncStore } from "./db.ts";

export type DebriefStatus = "started" | "recorded" | "aborted" | "failed";

export type DebriefRow = {
  readonly id: string;
  readonly session_id: string;
  readonly repo_root: string | null;
  readonly status: DebriefStatus;
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly cache_share: number | null;
  readonly duration_ms: number | null;
  readonly failure: string | null;
  readonly rejected_json: string | null;
  readonly answer: string | null;
};

export type NoteKind = "steer" | "observation" | "stale_rule";

export type NoteRow = {
  readonly id: string;
  readonly debrief_id: string;
  readonly session_id: string;
  readonly repo_root: string | null;
  readonly at: string;
  readonly kind: NoteKind;
  readonly status: "pending" | "used" | "expired";
  readonly evidence_id: string;
  readonly lesson: string;
  readonly body_json: string;
  readonly loaded_rules_json: string;
};

export type ProposalInsert = {
  readonly id: string;
  readonly fingerprint: string;
  readonly createdAt: string;
  readonly source: "learn" | "prune" | "debrief";
  readonly targetPath: string;
  readonly repoRoot: string | null;
  readonly scope: "global" | "repo" | "path";
  readonly verdict: Verdict | null;
  readonly claimFr: string;
  readonly reasoningFr: string;
  readonly lessonEn: string;
  readonly subjectEn: string;
  readonly change: Change;
  readonly evidence: readonly Evidence[];
  readonly prevalence: Prevalence;
  readonly bulletId: string | null;
  readonly learnRunId: string | null;
};

export type ProposalRow = {
  readonly id: string;
  readonly fingerprint: string;
  readonly created_at: string;
  readonly state: string;
  readonly source: string;
  readonly target_path: string;
  readonly repo_root: string | null;
  readonly scope: string;
  readonly verdict: string | null;
  readonly claim_fr: string;
  readonly reasoning_fr: string;
  readonly lesson_en: string;
  readonly subject_en: string;
  readonly change_json: string;
  readonly evidence_json: string;
  readonly prevalence_json: string;
  readonly bullet_id: string | null;
  readonly learn_run_id: string | null;
};

export const ABORT_AFTER_MS = 15 * 60 * 1000;

export function insertDebrief(
  db: SyncStore,
  row: { id: string; sessionId: string; repoRoot: string | null; at: string },
): void {
  db.run("INSERT INTO debriefs (id, session_id, repo_root, status, started_at) VALUES (?, ?, ?, 'started', ?)", [
    row.id,
    row.sessionId,
    row.repoRoot,
    row.at,
  ]);
}

export function getDebrief(db: SyncStore, id: string): DebriefRow | null {
  return db.get<DebriefRow>("SELECT * FROM debriefs WHERE id = ?", [id]);
}

export function finishDebrief(
  db: SyncStore,
  row: {
    id: string;
    status: Exclude<DebriefStatus, "started">;
    at: string;
    cacheShare: number | null;
    durationMs: number | null;
    failure: string | null;
    rejected: Readonly<Record<string, number>>;
    answer: string | null;
  },
): void {
  db.run(
    "UPDATE debriefs SET status = ?, finished_at = ?, cache_share = ?, duration_ms = ?, failure = ?, rejected_json = ?, answer = ? WHERE id = ?",
    [row.status, row.at, row.cacheShare, row.durationMs, row.failure, JSON.stringify(row.rejected), row.answer, row.id],
  );
}

/** A `started` row with no end after 15 minutes lost its fork: it reads `aborted`. */
export function abortStaleDebriefs(db: SyncStore, nowIso: string): number {
  const cutoff = new Date(new Date(nowIso).getTime() - ABORT_AFTER_MS).toISOString();

  return db.run("UPDATE debriefs SET status = 'aborted', finished_at = ? WHERE status = 'started' AND started_at < ?", [
    nowIso,
    cutoff,
  ]);
}

export function upsertMessage(
  db: SyncStore,
  row: { evidenceId: string; sessionId: string; at: string; repoRoot: string | null; text: string },
): void {
  db.run(
    "INSERT INTO messages (evidence_id, session_id, at, repo_root, text) VALUES (?, ?, ?, ?, ?) ON CONFLICT (evidence_id) DO NOTHING",
    [row.evidenceId, row.sessionId, row.at, row.repoRoot, row.text],
  );
}

export function insertNote(
  db: SyncStore,
  row: {
    id: string;
    debriefId: string;
    sessionId: string;
    repoRoot: string | null;
    at: string;
    kind: NoteKind;
    status: NoteRow["status"];
    evidenceId: string;
    lesson: string;
    body: unknown;
    loadedRules: readonly string[];
  },
): void {
  db.run(
    "INSERT INTO notes (id, debrief_id, session_id, repo_root, at, kind, status, evidence_id, lesson, body_json, loaded_rules_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      row.id,
      row.debriefId,
      row.sessionId,
      row.repoRoot,
      row.at,
      row.kind,
      row.status,
      row.evidenceId,
      row.lesson,
      JSON.stringify(row.body),
      JSON.stringify(row.loadedRules),
    ],
  );
}

export function insertProposal(db: SyncStore, row: ProposalInsert): void {
  db.run(
    `INSERT INTO proposals (id, fingerprint, created_at, state, source, target_path, repo_root, scope, verdict, claim_fr, reasoning_fr, lesson_en, subject_en, change_json, evidence_json, prevalence_json, bullet_id, learn_run_id)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.fingerprint,
      row.createdAt,
      row.source,
      row.targetPath,
      row.repoRoot,
      row.scope,
      row.verdict,
      row.claimFr,
      row.reasoningFr,
      row.lessonEn,
      row.subjectEn,
      JSON.stringify(row.change),
      JSON.stringify(row.evidence),
      JSON.stringify(row.prevalence),
      row.bulletId,
      row.learnRunId,
    ],
  );
}

/** The session count the Ledger saw when it last rejected this fingerprint; null when never rejected. */
export function rejectedSessions(db: SyncStore, fingerprint: string): number | null {
  const row = db.get<{ sessions_at_decision: number }>(
    "SELECT sessions_at_decision FROM decisions WHERE fingerprint = ? AND decision = 'rejected' ORDER BY at DESC LIMIT 1",
    [fingerprint],
  );

  return row === null ? null : row.sessions_at_decision;
}

export function pendingProposalByFingerprint(db: SyncStore, fingerprint: string): ProposalRow | null {
  return db.get<ProposalRow>("SELECT * FROM proposals WHERE fingerprint = ? AND state = 'pending'", [fingerprint]);
}

export function getProposal(db: SyncStore, id: string): ProposalRow | null {
  return db.get<ProposalRow>("SELECT * FROM proposals WHERE id = ?", [id]);
}

export function getPendingProposal(db: SyncStore, id: string): ProposalRow | null {
  return db.get<ProposalRow>("SELECT * FROM proposals WHERE id = ? AND state = 'pending'", [id]);
}

/** Every pending Proposal, newest first. */
export function pendingProposals(db: SyncStore): ProposalRow[] {
  return db.all<ProposalRow>("SELECT * FROM proposals WHERE state = 'pending' ORDER BY created_at DESC");
}

export function setProposalState(db: SyncStore, id: string, state: ProposalState): void {
  db.run("UPDATE proposals SET state = ? WHERE id = ?", [state, id]);
}

/** The Human Message an evidence id cites, as the Debrief stored it; null when none was kept. */
export function messageText(db: SyncStore, evidenceId: string): string | null {
  return db.get<{ text: string }>("SELECT text FROM messages WHERE evidence_id = ?", [evidenceId])?.text ?? null;
}

export function insertDecision(
  db: SyncStore,
  row: {
    proposalId: string;
    at: string;
    decision: "accepted" | "rejected" | "handed_off";
    reason: string | null;
    editedChange: Change | null;
    sessionsAtDecision: number;
    commitSha: string | null;
  },
): void {
  db.run(
    "INSERT INTO decisions (proposal_id, fingerprint, at, decision, reason, edited_change_json, sessions_at_decision, commit_sha) VALUES (?, (SELECT fingerprint FROM proposals WHERE id = ?), ?, ?, ?, ?, ?, ?)",
    [
      row.proposalId,
      row.proposalId,
      row.at,
      row.decision,
      row.reason,
      row.editedChange === null ? null : JSON.stringify(row.editedChange),
      row.sessionsAtDecision,
      row.commitSha,
    ],
  );
}

/** Drops the accept that reserved a Proposal and never reached a commit. */
export function deleteUncommittedAccept(db: SyncStore, proposalId: string): void {
  db.run("DELETE FROM decisions WHERE proposal_id = ? AND decision = 'accepted' AND commit_sha IS NULL", [proposalId]);
}

export function setDecisionCommit(
  db: SyncStore,
  proposalId: string,
  commitSha: string,
  editedChange: Change | null,
): void {
  db.run(
    "UPDATE decisions SET commit_sha = ?, edited_change_json = ? WHERE proposal_id = ? AND decision = 'accepted'",
    [commitSha, editedChange === null ? null : JSON.stringify(editedChange), proposalId],
  );
}

/** The handed-off Proposals no Handoff has carried yet, oldest first. */
export function handedOffWithoutHandoff(db: SyncStore): ProposalRow[] {
  return db.all<ProposalRow>(
    `SELECT * FROM proposals WHERE state = 'handed_off' AND id NOT IN (
       SELECT value FROM handoffs, json_each(handoffs.proposal_ids_json)
     ) ORDER BY created_at`,
  );
}

export function insertHandoff(
  db: SyncStore,
  row: { id: string; createdAt: string; proposalIds: readonly string[]; instructions: string },
): void {
  db.run("INSERT INTO handoffs (id, created_at, proposal_ids_json, instructions) VALUES (?, ?, ?, ?)", [
    row.id,
    row.createdAt,
    JSON.stringify(row.proposalIds),
    row.instructions,
  ]);
}

export function countPendingNotes(db: SyncStore): number {
  return db.get<{ n: number }>("SELECT COUNT(*) AS n FROM notes WHERE status = 'pending'")?.n ?? 0;
}

export function countPendingProposals(db: SyncStore): number {
  return db.get<{ n: number }>("SELECT COUNT(*) AS n FROM proposals WHERE state = 'pending'")?.n ?? 0;
}

export type StatusSnapshot = {
  readonly debriefs: Readonly<Record<string, number>>;
  readonly cacheShare: { readonly min: number | null; readonly mean: number | null };
  readonly failures: ReadonlyArray<{ readonly id: string; readonly failure: string }>;
  readonly pendingProposals: number;
  readonly gate: Readonly<Record<string, number>>;
  readonly learn: { readonly runs: number; readonly costUsd: number; readonly running: boolean };
};

/** The aggregates `hindsight status` prints: Debriefs by status and their cache share, the ten last failures, Gate decisions, Learn runs. */
export function statusSnapshot(db: SyncStore): StatusSnapshot {
  const debriefs: Record<string, number> = {};

  for (const row of db.all<{ status: string; n: number }>(
    "SELECT status, COUNT(*) AS n FROM debriefs GROUP BY status",
  )) {
    debriefs[row.status] = row.n;
  }

  const share = db.get<{ min: number | null; mean: number | null }>(
    "SELECT MIN(cache_share) AS min, AVG(cache_share) AS mean FROM debriefs WHERE status = 'recorded'",
  );

  const gate: Record<string, number> = {};

  for (const row of db.all<{ key: string; n: number }>(
    "SELECT decision || COALESCE(':' || reason, '') AS key, COUNT(*) AS n FROM gate_decisions GROUP BY key",
  )) {
    gate[row.key] = row.n;
  }

  const learn = db.get<{ runs: number; cost: number | null; running: number }>(
    "SELECT COUNT(*) AS runs, SUM(cost_usd) AS cost, SUM(status = 'running') AS running FROM learn_runs",
  );

  return {
    debriefs,
    cacheShare: { min: share?.min ?? null, mean: share?.mean ?? null },
    failures: db.all<{ id: string; failure: string }>(
      "SELECT id, failure FROM debriefs WHERE status = 'failed' ORDER BY started_at DESC LIMIT 10",
    ),
    pendingProposals: countPendingProposals(db),
    gate,
    learn: { runs: learn?.runs ?? 0, costUsd: learn?.cost ?? 0, running: (learn?.running ?? 0) > 0 },
  };
}

export function knownRepoRoots(db: SyncStore): string[] {
  return db
    .all<{ repo_root: string }>(
      "SELECT DISTINCT repo_root FROM notes WHERE repo_root IS NOT NULL UNION SELECT DISTINCT repo_root FROM proposals WHERE repo_root IS NOT NULL",
    )
    .map((row) => row.repo_root);
}

export function insertGateDecision(
  db: SyncStore,
  row: {
    sessionId: string;
    at: string;
    turnId: string | null;
    decision: string;
    reason: string | null;
    score: number | null;
    signals: unknown;
  },
): void {
  db.run(
    "INSERT INTO gate_decisions (session_id, at, turn_id, decision, reason, score, signals_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [row.sessionId, row.at, row.turnId, row.decision, row.reason, row.score, JSON.stringify(row.signals)],
  );
}

export function countDebriefsSince(db: SyncStore, sinceIso: string): number {
  return (
    db.get<{ n: number }>("SELECT COUNT(*) AS n FROM debriefs WHERE started_at >= ? AND status <> 'aborted'", [
      sinceIso,
    ])?.n ?? 0
  );
}

export function pendingNotes(db: SyncStore, sinceIso: string): NoteRow[] {
  return db.all<NoteRow>("SELECT * FROM notes WHERE status = 'pending' AND at >= ? ORDER BY at", [sinceIso]);
}

export function expireNotes(db: SyncStore, beforeIso: string): number {
  return db.run("UPDATE notes SET status = 'expired' WHERE status = 'pending' AND at < ?", [beforeIso]);
}

export function markNotesUsed(db: SyncStore, ids: readonly string[]): void {
  for (const id of ids) {
    db.run("UPDATE notes SET status = 'used' WHERE id = ?", [id]);
  }
}

export type HistoryEntry = {
  readonly fingerprint: string;
  readonly decision: string;
  readonly reason: string | null;
  readonly sessionsAtDecision: number;
  readonly lessonEn: string;
  readonly targetPath: string;
};

export function ledgerHistory(db: SyncStore): HistoryEntry[] {
  return db
    .all<{
      fingerprint: string;
      decision: string;
      reason: string | null;
      sessions_at_decision: number;
      lesson_en: string;
      target_path: string;
    }>(
      `SELECT d.fingerprint, d.decision, d.reason, d.sessions_at_decision, p.lesson_en, p.target_path
       FROM decisions d JOIN proposals p ON p.id = d.proposal_id ORDER BY d.at`,
    )
    .map((row) => ({
      fingerprint: row.fingerprint,
      decision: row.decision,
      reason: row.reason,
      sessionsAtDecision: row.sessions_at_decision,
      lessonEn: row.lesson_en,
      targetPath: row.target_path,
    }));
}

export function pendingFingerprints(db: SyncStore): Set<string> {
  return new Set(
    db
      .all<{ fingerprint: string }>("SELECT fingerprint FROM proposals WHERE state = 'pending'")
      .map((r) => r.fingerprint),
  );
}

/** Takes the single running slot, or returns null when a run already holds it. */
export function reserveLearnRun(db: SyncStore, id: string, at: string): string | null {
  const running = db.get<{ id: string }>("SELECT id FROM learn_runs WHERE status = 'running'");

  if (running !== null) {
    return null;
  }

  db.run("INSERT INTO learn_runs (id, started_at, status) VALUES (?, ?, 'running')", [id, at]);

  return id;
}

export function finishLearnRun(
  db: SyncStore,
  row: {
    id: string;
    at: string;
    status: "complete" | "failed";
    notesRead: number;
    proposalsWritten: number;
    costUsd: number;
    failure: string | null;
  },
): void {
  db.run(
    "UPDATE learn_runs SET finished_at = ?, status = ?, notes_read = ?, proposals_written = ?, cost_usd = ?, failure = ? WHERE id = ?",
    [row.at, row.status, row.notesRead, row.proposalsWritten, row.costUsd, row.failure, row.id],
  );
}

export function lastLearnFinishedAt(db: SyncStore): string | null {
  return (
    db.get<{ at: string | null }>("SELECT MAX(finished_at) AS at FROM learn_runs WHERE status = 'complete'")?.at ?? null
  );
}

/** A run left `running` by a dead process reads failed after `staleMs`. */
export function failStaleLearnRuns(db: SyncStore, nowIso: string, staleMs: number): number {
  const cutoff = new Date(new Date(nowIso).getTime() - staleMs).toISOString();

  return db.run(
    "UPDATE learn_runs SET status = 'failed', finished_at = ?, failure = 'stale' WHERE status = 'running' AND started_at < ?",
    [nowIso, cutoff],
  );
}
