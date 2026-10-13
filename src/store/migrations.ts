export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE debriefs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    repo_root TEXT,
    status TEXT NOT NULL CHECK (status IN ('started', 'recorded', 'aborted', 'failed')),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    cache_share REAL,
    duration_ms INTEGER,
    failure TEXT,
    rejected_json TEXT
  );
  CREATE INDEX debriefs_session ON debriefs (session_id, started_at);
  CREATE TABLE gate_decisions (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    at TEXT NOT NULL,
    turn_id TEXT,
    decision TEXT NOT NULL,
    reason TEXT,
    score REAL,
    signals_json TEXT NOT NULL
  );
  CREATE INDEX gate_decisions_at ON gate_decisions (at);
  CREATE TABLE messages (
    evidence_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    at TEXT NOT NULL,
    repo_root TEXT,
    text TEXT NOT NULL
  );
  CREATE TABLE notes (
    id TEXT PRIMARY KEY,
    debrief_id TEXT NOT NULL REFERENCES debriefs (id),
    session_id TEXT NOT NULL,
    repo_root TEXT,
    at TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('steer', 'observation', 'stale_rule')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'used', 'expired')),
    evidence_id TEXT NOT NULL,
    lesson TEXT NOT NULL,
    body_json TEXT NOT NULL
  );
  CREATE INDEX notes_status ON notes (status, at);
  CREATE TABLE proposals (
    id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'handed_off', 'rejected', 'superseded', 'expired')),
    source TEXT NOT NULL CHECK (source IN ('learn', 'prune', 'debrief')),
    target_path TEXT NOT NULL,
    repo_root TEXT,
    scope TEXT NOT NULL,
    verdict TEXT,
    claim_fr TEXT NOT NULL,
    reasoning_fr TEXT NOT NULL,
    lesson_en TEXT NOT NULL,
    subject_en TEXT NOT NULL,
    change_json TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    prevalence_json TEXT NOT NULL,
    bullet_id TEXT,
    learn_run_id TEXT
  );
  CREATE INDEX proposals_state ON proposals (state, created_at);
  CREATE INDEX proposals_fingerprint ON proposals (fingerprint);
  CREATE TABLE decisions (
    id INTEGER PRIMARY KEY,
    proposal_id TEXT NOT NULL REFERENCES proposals (id),
    fingerprint TEXT NOT NULL,
    at TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected', 'handed_off')),
    reason TEXT,
    edited_change_json TEXT,
    sessions_at_decision INTEGER NOT NULL,
    commit_sha TEXT,
    drift_json TEXT
  );
  CREATE INDEX decisions_fingerprint ON decisions (fingerprint, at);
  CREATE TABLE learn_runs (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'failed')),
    notes_read INTEGER NOT NULL DEFAULT 0,
    proposals_written INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    failure TEXT
  );
  CREATE TABLE handoffs (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    proposal_ids_json TEXT NOT NULL,
    instructions TEXT NOT NULL
  );`,
];
