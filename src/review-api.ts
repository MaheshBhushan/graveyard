// Read-only REST view of the scheduler database for the task-review frontend.
// Joins jobs, contract verification history and maintainer PR decisions.
import type { Database } from "bun:sqlite";
import { contractHistory } from "./contracts.ts";

export interface CheckSummary { id: string; exit_code: number | null; timed_out: boolean; elapsed_ms: number }
export interface TestRun {
  iteration: number; ended_at: string; git_commit: string;
  decision: "complete" | "retry" | "stop"; reason: string; checks: CheckSummary[];
}
export interface ReviewNote {
  repo: string; pr_number: number; pr_url: string; pr_state: string | null;
  kind: string; actor: string | null; body: string | null; url: string | null; occurred_at: string;
}
export interface TaskReview {
  job_id: string; repo: string; issue_number: number | null; title: string | null; url: string | null;
  state: string; attempts: number; last_error: string | null;
  queued_at: string; started_at: string | null; ended_at: string | null;
  tests: TestRun[]; reviews: ReviewNote[];
}

type JobRow = Omit<TaskReview, "tests" | "reviews">;
const JOB_COLUMNS = `job_id, repo, issue_number, title, url, state, COALESCE(attempts, 0) AS attempts,
  last_error, queued_at, started_at, ended_at`;

function testRuns(db: Database, jobId: string): TestRun[] {
  return contractHistory(db, jobId).map((run) => ({
    iteration: run.iteration, ended_at: run.ended_at, git_commit: run.git_commit,
    decision: run.decision, reason: run.reason,
    // Check output can be large and noisy; the review view only needs verdicts.
    checks: run.checks.map(({ id, exit_code, timed_out, elapsed_ms }) => ({ id, exit_code, timed_out, elapsed_ms })),
  }));
}

function reviewNotes(db: Database, jobId: string): ReviewNote[] {
  return db.query(`SELECT d.repo, d.pr_number, p.url AS pr_url, p.state AS pr_state,
      d.kind, d.actor, d.body, d.url, d.occurred_at
    FROM pr_decisions d JOIN pull_requests p ON p.repo = d.repo AND p.pr_number = d.pr_number
    WHERE p.job_id = ? ORDER BY d.occurred_at, d.source, d.source_id`).all(jobId) as ReviewNote[];
}

function withDetails(db: Database, job: JobRow): TaskReview {
  return { ...job, tests: testRuns(db, job.job_id), reviews: reviewNotes(db, job.job_id) };
}

export function listTaskReviews(db: Database): TaskReview[] {
  const jobs = db.query(`SELECT ${JOB_COLUMNS} FROM jobs ORDER BY queued_at DESC, job_id`).all() as JobRow[];
  return jobs.map((job) => withDetails(db, job));
}

export function getTaskReview(db: Database, jobId: string): TaskReview | null {
  const job = db.query(`SELECT ${JOB_COLUMNS} FROM jobs WHERE job_id = ?`).get(jobId) as JobRow | null;
  return job ? withDetails(db, job) : null;
}

/** Handles /api/* requests. Returns null for paths outside the API. */
export function handleReviewApi(db: Database, req: Request): Response | null {
  const { pathname } = new URL(req.url);
  if (!pathname.startsWith("/api/")) return null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    return Response.json({ error: "read-only API" }, { status: 405, headers: { allow: "GET, HEAD" } });
  }
  if (pathname === "/api/tasks") return Response.json(listTaskReviews(db));
  const match = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (match) {
    const task = getTaskReview(db, decodeURIComponent(match[1]));
    return task ? Response.json(task) : Response.json({ error: "unknown job" }, { status: 404 });
  }
  return Response.json({ error: "not found" }, { status: 404 });
}
