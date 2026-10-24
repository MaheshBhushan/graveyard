import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capturePullRequests, githubJson, openedPullRequests, repoAcceptance, syncOutcomes } from "../src/outcomes.ts";
import { addJob, clearJobs, requeueJobs, transitionJob } from "../src/queue.ts";
import { cells } from "../src/render.ts";
import { renderAcceptance } from "../src/watch.ts";

const schema = readFileSync(join(import.meta.dir, "..", "schema.sql"), "utf8");
const stamp = "2026-10-18T12:00:00Z";
const now = Date.parse(stamp);
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function database() {
  const db = new Database(":memory:");
  db.exec(schema);
  cleanups.push(() => db.close());
  return db;
}

function directory() {
  const dir = mkdtempSync(join(tmpdir(), "graveyard-outcomes-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function track(db: Database, number = 7, repo = "o/r") {
  db.query(`INSERT INTO pull_requests (repo, pr_number, job_id, url, branch)
    VALUES (?, ?, ?, ?, ?)`).run(repo, number, "o__r-42", `https://github.com/${repo}/pull/${number}`, "fix/issue-42");
}

function pull(number = 7, overrides = {}) {
  return {
    number, html_url: `https://github.com/o/r/pull/${number}`, state: "open",
    user: { login: "agent", type: "User" }, head: { ref: "fix/issue-42" },
    base: { repo: { full_name: "o/r" } }, created_at: stamp,
    merged_at: null, closed_at: null, ...overrides,
  };
}

const maintainer = { user: { login: "maintainer", type: "User" }, author_association: "MEMBER" };
function api(pr = pull(), events: unknown[] = [], reviews: unknown[] = [], comments: unknown[] = []) {
  const calls: string[] = [];
  const read: typeof githubJson = async (endpoint, paginated) => {
    calls.push(endpoint);
    if (!paginated) return pr;
    if (endpoint.includes("/events?")) return events;
    if (endpoint.includes("/reviews?")) return reviews;
    if (endpoint.includes("/comments?")) return comments;
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };
  return { read, calls };
}

describe("PR capture", () => {
  test("reads explicit and legacy run records without importing referenced or declined PRs", () => {
    expect(openedPullRequests("**PR_URL:** https://github.com/O/R/pull/7\nPR_URL: https://github.com/o/r/pull/7", "o/r")).toEqual([7]);
    expect(openedPullRequests("Outcome: PR opened\nPR URL: https://github.com/o/r/pull/7", "o/r")).toEqual([7]);
    expect(openedPullRequests("Outcome: PR opened\nhttps://github.com/o/r/pull/8", "o/r")).toEqual([8]);
    expect(openedPullRequests("PR_URL: https://github.com/other/repo/pull/7", "o/r")).toEqual([]);
    expect(openedPullRequests("Outcome: NO-GO. No PR opened. See https://github.com/o/r/pull/7", "o/r")).toEqual([]);
    expect(openedPullRequests("Related: https://github.com/o/r/pull/7", "o/r")).toEqual([]);
    expect(openedPullRequests("PR_URL: none\nRelated: https://github.com/o/r/pull/7", "o/r")).toEqual([]);
  });

  test("captures every submission once and retains PR history through requeue and clear", () => {
    const db = database();
    const dir = directory();
    const { job_id } = addJob(db, { repo: "O/R", issue_number: 42, task_source: "test" });
    mkdirSync(join(dir, job_id));
    writeFileSync(join(dir, job_id, "pr-draft.md"), "PR_URL: https://github.com/O/R/pull/7");
    db.query("UPDATE jobs SET branch = 'fix/issue-42' WHERE job_id = ?").run(job_id);
    capturePullRequests(db, dir);
    transitionJob(db, job_id, "done");
    requeueJobs(db, { jobIds: [job_id] });
    // A repeated run opens a second PR for the same issue.
    writeFileSync(join(dir, job_id, "pr-draft.md"), "PR_URL: https://github.com/O/R/pull/8");
    capturePullRequests(db, dir);
    capturePullRequests(db, dir);
    transitionJob(db, job_id, "done");
    clearJobs(db);
    expect(db.query("SELECT * FROM jobs").all()).toHaveLength(0);
    expect(db.query("SELECT pr_number FROM pull_requests ORDER BY pr_number").all()).toEqual([{ pr_number: 7 }, { pr_number: 8 }]);
    expect(repoAcceptance(db)[0]).toMatchObject({ repo: "o/r", unknown: 2, merged: 0, closed: 0, open: 0 });
  });

  test("upgrades an existing database without altering its queue rows", () => {
    const db = database();
    db.exec("DROP TABLE jobs; CREATE TABLE jobs (job_id TEXT PRIMARY KEY, repo TEXT, state TEXT);");
    db.exec("INSERT INTO jobs VALUES ('legacy', 'o/r', 'done')");
    db.exec(schema);
    db.exec(schema);
    const dir = directory();
    mkdirSync(join(dir, "legacy"));
    writeFileSync(join(dir, "legacy", "pr-draft.md"), "PR_URL: https://github.com/o/r/pull/7");
    capturePullRequests(db, dir);
    expect(db.query("SELECT * FROM jobs").all()).toEqual([{ job_id: "legacy", repo: "o/r", state: "done" }]);
    expect(repoAcceptance(db)[0].unknown).toBe(1);
  });

  test("captures a submitted PR before the agent writes its final run record", () => {
    const db = database();
    const dir = directory();
    const { job_id } = addJob(db, { repo: "o/r", issue_number: 42, task_source: "test" });
    transitionJob(db, job_id, "running");
    mkdirSync(join(dir, job_id));
    writeFileSync(join(dir, job_id, "pr-draft.md.urls"), "PR_URL: https://github.com/o/r/pull/7\nPR_URL: https://github.com/o/r/pull/8\n");
    capturePullRequests(db, dir);
    expect(db.query("SELECT pr_number FROM pull_requests ORDER BY pr_number").all()).toEqual([{ pr_number: 7 }, { pr_number: 8 }]);
    expect(db.query("SELECT state FROM jobs").get()).toEqual({ state: "running" });
  });
});

describe("GitHub decisions", () => {
  test("stores merges, close actors, maintainer reviews and inline comments idempotently", async () => {
    const db = database();
    track(db);
    const events = [
      { id: 1, event: "merged", actor: { login: "maintainer" }, created_at: stamp },
      { id: 2, event: "closed", actor: { login: "maintainer" }, created_at: stamp },
      { id: 3, event: "labeled", actor: { login: "maintainer" }, created_at: stamp },
    ];
    const reviews = [
      { ...maintainer, id: 1, state: "APPROVED", submitted_at: stamp, body: "Looks good", html_url: "https://github.com/o/r/pull/7#review-1" },
      { ...maintainer, id: 2, state: "CHANGES_REQUESTED", submitted_at: stamp },
      { ...maintainer, id: 3, state: "COMMENTED", submitted_at: stamp },
      { ...maintainer, id: 4, state: "PENDING", submitted_at: null },
      { ...maintainer, id: 5, user: { login: "agent" }, state: "APPROVED", submitted_at: stamp },
      { ...maintainer, id: 6, author_association: "CONTRIBUTOR", state: "APPROVED", submitted_at: stamp },
      { ...maintainer, id: 7, user: { login: "bot", type: "Bot" }, state: "APPROVED", submitted_at: stamp },
    ];
    const comments = [
      { ...maintainer, id: 1, body: "Please add a test", created_at: stamp, updated_at: stamp },
      { ...maintainer, id: 2, user: { login: "agent" }, created_at: stamp },
      { ...maintainer, id: 3, author_association: "NONE", created_at: stamp },
    ];
    const client = api(pull(7, { state: "closed", merged_at: stamp, closed_at: stamp }), events, reviews, comments);
    expect(await syncOutcomes(db, { ...client, now, force: true })).toEqual({ synced: 1, errors: [] });
    expect(await syncOutcomes(db, { ...client, now, force: true })).toEqual({ synced: 1, errors: [] });
    const rows = db.query("SELECT source, source_id, kind, actor FROM pr_decisions ORDER BY source, source_id").all();
    expect(rows).toHaveLength(6);
    expect(rows).toContainEqual({ source: "event", source_id: 1, kind: "merged", actor: "maintainer" });
    expect(rows).toContainEqual({ source: "event", source_id: 2, kind: "closed", actor: "maintainer" });
    expect(rows).toContainEqual({ source: "review", source_id: 1, kind: "APPROVED", actor: "maintainer" });
    expect(rows).toContainEqual({ source: "review", source_id: 2, kind: "CHANGES_REQUESTED", actor: "maintainer" });
    expect(rows).toContainEqual({ source: "review_comment", source_id: 1, kind: "COMMENTED", actor: "maintainer" });
    expect(repoAcceptance(db)[0]).toMatchObject({ merged: 1, closed: 0, open: 0, unknown: 0, errors: 0 });
    expect(client.calls.filter((c) => c.includes("?per_page=100"))).toHaveLength(6);

    reviews[0].state = "DISMISSED";
    comments[0].body = "Test added, thanks";
    await syncOutcomes(db, { ...client, now, force: true });
    expect(db.query("SELECT kind FROM pr_decisions WHERE source = 'review' AND source_id = 1").get()).toEqual({ kind: "DISMISSED" });
    expect(db.query("SELECT body FROM pr_decisions WHERE source = 'review_comment'").get()).toEqual({ body: "Test added, thanks" });
  });

  test("reopening a rejected PR updates the denominator and retains close history", async () => {
    const db = database();
    track(db);
    const events = [{ id: 1, event: "closed", actor: { login: "maintainer" }, created_at: stamp }];
    await syncOutcomes(db, { ...api(pull(7, { state: "closed", closed_at: stamp }), events), now });
    expect(repoAcceptance(db)[0]).toMatchObject({ merged: 0, closed: 1, open: 0 });
    events.push({ id: 2, event: "reopened", actor: { login: "maintainer" }, created_at: stamp });
    await syncOutcomes(db, { ...api(pull(), events), now: now + 60_000 });
    expect(repoAcceptance(db)[0]).toMatchObject({ merged: 0, closed: 0, open: 1 });
    expect(db.query("SELECT * FROM pr_decisions").all()).toHaveLength(2);
  });

  test("read failures preserve snapshots, surface errors, retry after a minute and recover", async () => {
    const db = database();
    track(db);
    await syncOutcomes(db, { ...api(pull()), now });
    const failing: typeof githubJson = async (endpoint, paginated) => {
      if (!paginated) return pull(7, { state: "closed", merged_at: stamp });
      throw new Error("GitHub unavailable (403)");
    };
    const failed = await syncOutcomes(db, { read: failing, now: now + 60_000 });
    expect(failed.errors[0]).toContain("403");
    expect(repoAcceptance(db)[0]).toMatchObject({ open: 1, merged: 0, errors: 1, last_synced_at: new Date(now).toISOString() });
    const client = api();
    expect(await syncOutcomes(db, { ...client, now: now + 60_001 })).toEqual({ synced: 0, errors: [] });
    expect(client.calls).toHaveLength(0);
    await syncOutcomes(db, { ...client, now: now + 120_000 });
    expect(repoAcceptance(db)[0].errors).toBe(0);
  });

  test("rejects mismatched repositories/branches and malformed decisions without inventing outcomes", async () => {
    const db = database();
    track(db);
    for (const pr of [pull(8), pull(7, { head: { ref: "unrelated" } }), pull(7, { base: { repo: { full_name: "x/y" } } })]) {
      expect((await syncOutcomes(db, { ...api(pr), now, force: true })).errors).toHaveLength(1);
      expect(repoAcceptance(db)[0]).toMatchObject({ unknown: 1, merged: 0, closed: 0, open: 0 });
    }
    const malformed = api(pull(), [{ id: 1, event: "closed" }]);
    expect((await syncOutcomes(db, { ...malformed, now, force: true })).errors).toHaveLength(1);
    expect(db.query("SELECT * FROM pr_decisions").all()).toHaveLength(0);
    const controller = new AbortController();
    controller.abort();
    const client = api();
    await syncOutcomes(db, { ...client, signal: controller.signal, force: true });
    expect(client.calls).toHaveLength(0);
  });

  test("one inaccessible PR does not prevent other submissions from syncing", async () => {
    const db = database();
    track(db, 7);
    track(db, 8);
    const read: typeof githubJson = async (endpoint, paginated) => {
      if (endpoint.endsWith("/7")) throw new Error("Not Found (404)");
      return paginated ? [] : pull(8, { state: "closed", merged_at: stamp, closed_at: stamp });
    };
    const result = await syncOutcomes(db, { read, now });
    expect(result.synced).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(repoAcceptance(db)[0]).toMatchObject({ merged: 1, unknown: 1, errors: 1 });
  });
});

describe("acceptance view", () => {
  test("counts each PR once and excludes pending/open PRs and reviews from resolved rates", () => {
    const db = database();
    for (let n = 1; n <= 4; n++) track(db, n);
    track(db, 1, "other/repo");
    db.exec("UPDATE pull_requests SET state = CASE pr_number WHEN 1 THEN 'merged' WHEN 2 THEN 'closed' WHEN 3 THEN 'open' END WHERE repo = 'o/r'");
    const stats = repoAcceptance(db);
    expect(stats[0]).toMatchObject({ repo: "o/r", merged: 1, closed: 1, open: 1, unknown: 1 });
    const out = renderAcceptance(stats, now, { color: false, unicode: false, width: 100 });
    expect(out).toContain("o/r 50.0% (1/2) open 1 unknown 1");
    expect(out).toContain("other/repo n/a (0/0) open 0 unknown 1");
    expect(out).not.toContain("NaN");
    expect(out).not.toContain("\x1b");
    expect(renderAcceptance([], now, { color: false, unicode: false, width: 80 })).toContain("no tracked PRs");
  });

  test("keeps the selected repository visible, limits height and marks stale/failed syncs", () => {
    const stats = ["a/b", "c/d", "o/r"].map((repo) => ({
      repo, merged: 0, closed: 0, open: 1, unknown: 0, errors: 0,
      last_synced_at: new Date(now - 600_000).toISOString(),
    }));
    stats[2].errors = 1;
    const out = renderAcceptance(stats, now, { color: false, unicode: false, width: 80 }, "O/R", 1);
    expect(out).toContain("o/r n/a (0/0) open 1 SYNC ERROR");
    expect(out).toContain("+2 repos: gm outcomes");
    expect(out).not.toContain("a/b");
    expect(renderAcceptance(stats, now, { color: false, unicode: false, width: 80 })).toContain("STALE");
    const narrow = renderAcceptance(stats, now, { color: true, unicode: true, width: 20 });
    expect(narrow.split("\n").every((line) => cells(line) <= 20)).toBe(true);
  });
});

test("real CLI and GitHub adapter use paginated GETs, persist decisions, and report failures", async () => {
  const dir = directory();
  // A local gh stand-in keeps this test deterministic and never contacts GitHub.
  const gh = join(dir, "gh");
  writeFileSync(gh, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] !== 'api' || args[args.indexOf('--method') + 1] !== 'GET' || args[args.indexOf('--hostname') + 1] !== 'github.com') process.exit(2);
if (process.env.OUTCOME_TEST_FAIL) { console.error('denied'); process.exit(1); }
const endpoint = args[5];
if (!endpoint) process.exit(3);
if (args.includes('--paginate') && !args.includes('--slurp')) process.exit(4);
const pr = ${JSON.stringify(pull(7, { state: "closed", merged_at: stamp, closed_at: stamp }))};
if (endpoint.includes('/events?')) console.log(JSON.stringify([[{ id: 1, event: 'merged', actor: { login: 'maintainer' }, created_at: '${stamp}' }], [{ id: 2, event: 'closed', actor: { login: 'maintainer' }, created_at: '${stamp}' }]]));
else if (endpoint.includes('/reviews?')) console.log(JSON.stringify([[{ id: 1, user: { login: 'maintainer' }, author_association: 'OWNER', state: 'APPROVED', submitted_at: '${stamp}' }], [{ id: 2, user: { login: 'maintainer' }, author_association: 'OWNER', state: 'COMMENTED', submitted_at: '${stamp}' }]]));
else if (endpoint.includes('/comments?')) console.log('[[]]');
else console.log(JSON.stringify(pr));
`, { mode: 0o755 });
  const filename = join(dir, "fleet.sqlite");
  const db = new Database(filename);
  db.exec(schema);
  const { job_id } = addJob(db, { repo: "o/r", issue_number: 42, task_source: "test" });
  const record = join(dir, "pr-draft.md");
  writeFileSync(record, "PR_URL: https://github.com/o/r/pull/7");
  db.query("UPDATE jobs SET branch = ?, pr_draft_path = ? WHERE job_id = ?")
    .run("fix/issue-42", record, job_id);
  db.close();
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  const cli = join(import.meta.dir, "..", "src", "cli.ts");
  const run = async (extraEnv = {}) => {
    const proc = Bun.spawn([process.execPath, cli, "outcomes", "--sync", "--db", filename], { env: { ...env, ...extraEnv }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { out, err, code };
  };
  const good = await run();
  expect(good.err).toBe("");
  expect(good.code).toBe(0);
  expect(JSON.parse(good.out)[0]).toMatchObject({ repo: "o/r", merged: 1, closed: 0, errors: 0 });
  const stored = new Database(filename);
  expect(stored.query("SELECT * FROM pr_decisions").all()).toHaveLength(4);
  stored.close();
  const bad = await run({ OUTCOME_TEST_FAIL: "1" });
  expect(bad.code).toBe(1);
  expect(bad.err).toContain("denied");
  expect(JSON.parse(bad.out)[0]).toMatchObject({ merged: 1, errors: 1 });
});
