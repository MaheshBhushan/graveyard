-- mk-fleet telemetry schema.
-- One row per Claude Code session (transcript), keyed by the session's uuid.
-- Populated by src/backfill.ts from ~/.claude/projects/*/*.jsonl.

CREATE TABLE IF NOT EXISTS sessions (
  session_id         TEXT PRIMARY KEY,
  agent_kind         TEXT NOT NULL DEFAULT 'claude',
  workload_class     TEXT NOT NULL CHECK (workload_class IN ('interactive', 'headless')),
  account_id         TEXT,
  model              TEXT,
  effort             TEXT,
  task_id            TEXT,
  task_source        TEXT,
  cwd                TEXT,
  git_branch         TEXT,
  queued_at          TEXT,
  started_at         TEXT NOT NULL,
  ended_at           TEXT NOT NULL,
  service_ms         INTEGER NOT NULL DEFAULT 0,
  active_ms          INTEGER NOT NULL DEFAULT 0,
  approval_wait_ms   INTEGER NOT NULL DEFAULT 0,
  think_wait_ms      INTEGER NOT NULL DEFAULT 0,
  outcome            TEXT NOT NULL CHECK (
    outcome IN ('success', 'failed', 'stalled_rate_limit', 'stalled_other', 'killed', 'abandoned')
  ),
  tokens_in          INTEGER NOT NULL DEFAULT 0,
  tokens_out         INTEGER NOT NULL DEFAULT 0,
  cache_read         INTEGER NOT NULL DEFAULT 0,
  cache_write        INTEGER NOT NULL DEFAULT 0,
  cost_estimate      REAL,
  retry_of           TEXT REFERENCES sessions(session_id),
  downstream_outcome TEXT,
  turn_count         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sessions_workload_class ON sessions(workload_class);
CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at);

-- Real quota/rate-limit stalls extracted from isApiErrorMessage lines whose
-- text matches the QUOTA_PAT prose patterns ported from gate_analysis.py.
-- There is no Retry-After header anywhere in this corpus: raw_text keeps the
-- prose verbatim and reset_hint is a best-effort substring, never a number.
CREATE TABLE IF NOT EXISTS rate_limit_events (
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  at         TEXT NOT NULL,
  kind       TEXT NOT NULL,
  raw_text   TEXT NOT NULL,
  reset_hint TEXT
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_events_session ON rate_limit_events(session_id);

-- Durable work queue: one row per unit of work to dispatch (an issue to fix,
-- or a manually-queued job). job_id is deterministic from repo+issue_number
-- (see src/queue.ts), so enqueuing the same issue twice is a no-op via
-- INSERT ... ON CONFLICT DO NOTHING rather than a duplicate row.
CREATE TABLE IF NOT EXISTS jobs (
  job_id       TEXT PRIMARY KEY,
  repo         TEXT NOT NULL,
  issue_number INTEGER,
  title        TEXT,
  task_source  TEXT NOT NULL,
  url          TEXT,
  state        TEXT NOT NULL,
  priority     INTEGER DEFAULT 0,
  queued_at    TEXT NOT NULL,
  started_at   TEXT,
  ended_at     TEXT,
  session_id   TEXT REFERENCES sessions(session_id),
  attempts     INTEGER DEFAULT 0,
  last_error   TEXT,
  -- Dispatch bookkeeping (src/dispatch.ts). Present here for fresh databases;
  -- existing databases get these via the idempotent ADD COLUMN migration in
  -- dispatch.ts, since sqlite has no ALTER TABLE ... ADD COLUMN IF NOT EXISTS.
  worktree_path TEXT,
  branch        TEXT,
  base_ref      TEXT,
  tmux_session  TEXT,
  pr_draft_path TEXT,
  -- Stall recovery (src/recover.ts). state can additionally be 'parked': a
  -- job waiting out a quota/overload window, not occupying a WIP slot.
  -- resume_count is distinct from attempts -- it counts `claude --continue`
  -- resumes of an already-launched session, not fresh relaunches.
  resume_after  TEXT,
  resume_count  INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state);
