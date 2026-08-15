// mk-fleet work queue: pure functions over the `jobs` table in schema.sql.
//
// This module only stores and lists queued work -- it does not launch,
// dispatch, run, or supervise anything. That is a later subtask's job.

import type { Database } from "bun:sqlite";

export type JobState = "queued" | "running" | "done" | "failed" | "blocked";

export interface Job {
  job_id: string;
  repo: string;
  issue_number: number | null;
  title: string | null;
  task_source: string;
  url: string | null;
  state: JobState;
  priority: number;
  queued_at: string;
  started_at: string | null;
  ended_at: string | null;
  session_id: string | null;
  attempts: number;
  last_error: string | null;
}

export interface NewJob {
  repo: string;
  issue_number?: number | null;
  title?: string | null;
  task_source: string;
  url?: string | null;
  priority?: number;
}

// Deterministic job_id from repo+issue_number, e.g. "owner__name-42". This is
// the whole idempotency mechanism: re-enqueuing the same issue collides on
// the primary key instead of creating a duplicate row.
export function jobId(repo: string, issueNumber: number | null | undefined): string {
  const slug = repo.replace("/", "__");
  return issueNumber != null ? `${slug}-${issueNumber}` : slug;
}

export interface IssueRef {
  repo: string;
  issue_number: number;
  url: string;
}

// Accept the thing a human actually has in their clipboard. `gm add <url>`
// beats reconstructing --repo/--issue by hand from a browser tab.
//
// Understood: a github.com issue or PR URL (with or without scheme, trailing
// slash, #anchor or ?query), and the short `owner/name#42` form.
export function parseIssueRef(input: string): IssueRef | null {
  const s = input.trim();

  const short = s.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (short) {
    const n = Number(short[2]);
    return n > 0
      ? { repo: short[1], issue_number: n, url: `https://github.com/${short[1]}/issues/${n}` }
      : null;
  }

  // A PR URL is accepted deliberately: someone pasting one means that number,
  // and gh resolves both under the same numbering.
  const url = s.match(
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)/i,
  );
  if (!url) return null;
  const n = Number(url[3]);
  if (!(n > 0)) return null;
  const repo = `${url[1]}/${url[2].replace(/\.git$/, "")}`;
  return { repo, issue_number: n, url: `https://github.com/${repo}/issues/${n}` };
}

export interface AddResult {
  job_id: string;
  inserted: boolean;
}

// Insert a job if it doesn't already exist. Returns whether it was newly
// inserted (false = already present, matching prior job_id).
export function addJob(db: Database, job: NewJob): AddResult {
  const id = jobId(job.repo, job.issue_number ?? null);
  const stmt = db.prepare(`
    INSERT INTO jobs (
      job_id, repo, issue_number, title, task_source, url, state, priority, queued_at
    ) VALUES (
      $job_id, $repo, $issue_number, $title, $task_source, $url, 'queued', $priority, $queued_at
    )
    ON CONFLICT(job_id) DO NOTHING
  `);
  const result = stmt.run({
    $job_id: id,
    $repo: job.repo,
    $issue_number: job.issue_number ?? null,
    $title: job.title ?? null,
    $task_source: job.task_source,
    $url: job.url ?? null,
    $priority: job.priority ?? 0,
    $queued_at: new Date().toISOString(),
  });
  return { job_id: id, inserted: result.changes > 0 };
}

// List jobs, optionally filtered by state, newest-queued-first within
// priority (highest priority first, then earliest queued).
export function listJobs(db: Database, opts: { state?: JobState } = {}): Job[] {
  if (opts.state) {
    return db
      .query("SELECT * FROM jobs WHERE state = $state ORDER BY priority DESC, queued_at ASC")
      .all({ $state: opts.state }) as Job[];
  }
  return db
    .query("SELECT * FROM jobs ORDER BY priority DESC, queued_at ASC")
    .all() as Job[];
}

export function countByState(db: Database): Record<string, number> {
  const rows = db.query("SELECT state, COUNT(*) as n FROM jobs GROUP BY state").all() as {
    state: string;
    n: number;
  }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.state] = r.n;
  return out;
}

// Transition a job's state, e.g. queued -> running -> done/failed/blocked.
// Kept here for the later dispatcher subtask to build on; this subtask does
// not call it beyond what CLI commands need.
export function transitionJob(
  db: Database,
  jobId: string,
  state: JobState,
  extra: { started_at?: string; ended_at?: string; session_id?: string; last_error?: string; attempts?: number } = {},
): boolean {
  const fields: string[] = ["state = $state"];
  const params: Record<string, unknown> = { $job_id: jobId, $state: state };
  for (const [k, v] of Object.entries(extra)) {
    fields.push(`${k} = $${k}`);
    params[`$${k}`] = v;
  }
  const stmt = db.prepare(`UPDATE jobs SET ${fields.join(", ")} WHERE job_id = $job_id`);
  return stmt.run(params).changes > 0;
}
