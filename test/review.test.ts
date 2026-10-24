import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { getTaskReview, handleReviewApi, listTaskReviews, type TaskReview } from "../src/review-api.ts";
import { TaskDetail, TaskTable, testVerdict } from "../src/review/App.tsx";

const schema = readFileSync(join(import.meta.dir, "..", "schema.sql"), "utf8");
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function fixture() {
  const db = new Database(":memory:");
  db.exec(schema);
  cleanups.push(() => db.close());
  const job = db.query(`INSERT INTO jobs (job_id, repo, issue_number, title, task_source, state, queued_at, attempts, last_error)
    VALUES (?, ?, ?, ?, 'github', ?, ?, ?, ?)`);
  job.run("o__r-1", "o/r", 1, "Fix parser", "done", "2026-10-01T00:00:00Z", 2, null);
  job.run("o__r-2", "o/r", 2, "Flaky test", "failed", "2026-10-02T00:00:00Z", 1, "checks failed");
  job.run("o__r-3", "o/r", 3, null, "queued", "2026-10-03T00:00:00Z", 0, null);
  db.query("INSERT INTO task_contracts VALUES (?, '{}', '2026-10-01T00:00:00Z')").run("o__r-1");
  db.query("INSERT INTO task_contracts VALUES (?, '{}', '2026-10-02T00:00:00Z')").run("o__r-2");
  const iteration = (id: string, n: number, exit: number | null, timedOut: boolean, decision: string) =>
    db.query("INSERT INTO contract_iterations VALUES (?, ?, ?)").run(id, n, JSON.stringify({
      iteration: n, session_id: null, started_at: "t", ended_at: `2026-10-0${n}T01:00:00Z`, elapsed_ms: 5,
      reported_effort_ms: null, git_commit: "a".repeat(40), worktree: "/w", criteria: [], decision, reason: `r${n}`,
      checks: [{ id: "unit", command: ["bun", "test"], exit_code: exit, timed_out: timedOut, elapsed_ms: 3, output: "SECRET LOG", error: null }],
    }));
  iteration("o__r-1", 1, 1, false, "retry");
  iteration("o__r-1", 2, 0, false, "complete");
  iteration("o__r-2", 1, null, true, "stop");
  db.query(`INSERT INTO pull_requests (repo, pr_number, job_id, url, state) VALUES ('o/r', 9, 'o__r-1', 'https://github.com/o/r/pull/9', 'merged')`).run();
  db.query(`INSERT INTO pull_requests (repo, pr_number, job_id, url, state) VALUES ('o/r', 10, 'other-job', 'https://github.com/o/r/pull/10', 'open')`).run();
  const decision = db.query(`INSERT INTO pr_decisions (repo, pr_number, source, source_id, kind, actor, body, occurred_at)
    VALUES ('o/r', ?, 'review', ?, ?, 'maint', ?, ?)`);
  decision.run(9, 2, "approved", "LGTM", "2026-10-05T00:00:00Z");
  decision.run(9, 1, "changes_requested", "add a test", "2026-10-04T00:00:00Z");
  decision.run(10, 3, "approved", "other job note", "2026-10-04T00:00:00Z");
  return db;
}

test("API exposes job state, test history and only the job's own review notes", () => {
  const db = fixture();
  const tasks = listTaskReviews(db);
  expect(tasks.map((t) => [t.job_id, t.state])).toEqual([["o__r-3", "queued"], ["o__r-2", "failed"], ["o__r-1", "done"]]);
  const done = getTaskReview(db, "o__r-1")!;
  expect(done.tests.map((r) => r.decision)).toEqual(["retry", "complete"]);
  expect(JSON.stringify(done)).not.toContain("SECRET LOG");
  expect(done.reviews.map((n) => n.body)).toEqual(["add a test", "LGTM"]);
  expect(tasks.find((t) => t.job_id === "o__r-3")).toMatchObject({ tests: [], reviews: [] });
  expect(getTaskReview(db, "missing")).toBeNull();
});

test("REST handler is read-only and scoped to /api", async () => {
  const db = fixture();
  const get = (path: string, method = "GET") => handleReviewApi(db, new Request(`http://x${path}`, { method }));
  expect(get("/")).toBeNull();
  expect(get("/api/tasks", "POST")!.status).toBe(405);
  expect(get("/api/tasks/o__r-1", "DELETE")!.status).toBe(405);
  expect(get("/api/tasks/nope")!.status).toBe(404);
  const body = (await get("/api/tasks/o__r-2")!.json()) as TaskReview;
  expect(body).toMatchObject({ state: "failed", last_error: "checks failed" });
  expect(db.query("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 3 });
});

test("frontend renders state and test/review boundaries from fixtures", () => {
  const tasks = listTaskReviews(fixture());
  const [queued, failed, done] = tasks;
  expect(testVerdict(done.tests.at(-1))).toBe("pass");
  expect(testVerdict(done.tests[0])).toBe("fail");
  expect(testVerdict(failed.tests.at(-1))).toBe("fail");
  expect(testVerdict(undefined)).toBe("none");
  const table = renderToStaticMarkup(createElement(TaskTable, { tasks }));
  expect(table).toContain('class="state-queued">queued');
  expect(table).toContain("pass (iteration 2, complete)");
  expect(table).toContain("no runs");
  expect(table).not.toContain("<button");
  expect(renderToStaticMarkup(createElement(TaskTable, { tasks: [] }))).toContain("No jobs");
  const detail = renderToStaticMarkup(createElement(TaskDetail, { task: failed }));
  expect(detail).toContain("unit: timed out");
  expect(detail).toContain("No maintainer review notes.");
  const doneDetail = renderToStaticMarkup(createElement(TaskDetail, { task: done }));
  expect(doneDetail).toContain("changes_requested by maint");
  expect(doneDetail).not.toContain("other job note");
  expect(renderToStaticMarkup(createElement(TaskDetail, { task: queued }))).toContain("No verification runs.");
});
