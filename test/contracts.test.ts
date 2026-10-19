import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contractCompletionError, contractHistory, contractPrompt, getContract,
  parseContract, setContract, verifyContract,
} from "../src/contracts.ts";
import { addJob, clearJobs, requeueJobs, transitionJob } from "../src/queue.ts";

const schema = readFileSync(join(import.meta.dir, "..", "schema.sql"), "utf8");
const cli = join(import.meta.dir, "..", "src", "cli.ts");
const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "graveyard-contract-"));
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  const db = new Database(join(cwd, "queue.sqlite"));
  cleanup.push(() => db.close());
  db.exec(schema);
  const { job_id: id } = addJob(db, { repo: "o/r", issue_number: 42, task_source: "test" });
  const git = (...args: string[]) => {
    const proc = Bun.spawnSync(["git", ...args], { cwd });
    if (proc.exitCode) throw new Error(proc.stderr.toString());
    return proc.stdout.toString().trim();
  };
  git("init", "-q");
  git("config", "user.name", "Contract Tests");
  git("config", "user.email", "contract-tests@example.invalid");
  writeFileSync(join(cwd, ".gitignore"), "*.sqlite*\n");
  writeFileSync(join(cwd, "value.txt"), "broken");
  const commit = () => { git("add", "."); git("commit", "-qm", "fixture change"); };
  commit();
  return { db, cwd, id, git, commit };
}

const spec = () => ({
  specification: "The saved value is fixed and readable.",
  max_iterations: 3,
  criteria: [
    { id: "fixed", description: "The value equals fixed", checks: ["value"] },
    { id: "readable", description: "The file is readable", checks: ["value", "read"] },
  ],
  checks: [
    { id: "value", command: [process.execPath, "-e", 'process.exit(require("fs").readFileSync("value.txt", "utf8") === "fixed" ? 0 : 1)'] },
    { id: "read", command: [process.execPath, "-e", 'console.log(require("fs").readFileSync("value.txt", "utf8"))'] },
  ],
});

test("validates specification links, ids, argv, limits and timeouts", () => {
  expect(parseContract(spec()).checks[0].timeout_ms).toBe(30_000);
  for (const input of [
    null, {}, { ...spec(), specification: " " }, { ...spec(), criteria: [] },
    { ...spec(), checks: [] }, { ...spec(), max_iterations: 0 }, { ...spec(), max_iterations: 21 },
    { ...spec(), checks: [{ id: "value", command: "echo pass" }] },
    { ...spec(), checks: [{ id: "value", command: ["bun", 1] }] },
    { ...spec(), checks: [{ id: "value", command: ["bun"], timeout_ms: 30_001 }] },
    { ...spec(), criteria: [{ id: "c", description: "Missing check", checks: ["missing"] }] },
    { ...spec(), criteria: [spec().criteria[0], spec().criteria[0]] },
    { ...spec(), checks: [spec().checks[0], spec().checks[0]] },
    { ...spec(), criteria: [spec().criteria[0]] },
  ]) expect(() => parseContract(input)).toThrow();
});

test("upgrades existing databases idempotently and freezes a queued task specification", () => {
  const { db, id } = fixture();
  db.exec(schema);
  db.exec(schema);
  setContract(db, id, spec());
  setContract(db, id, spec());
  expect(() => setContract(db, id, { ...spec(), specification: "Move the goal" })).toThrow("immutable");
  expect(() => setContract(db, "missing", spec())).toThrow("queued");
  transitionJob(db, id, "running");
  expect(() => setContract(db, id, spec())).toThrow("queued");
  expect(getContract(db, id)?.specification).toBe(spec().specification);
});

test("enqueue attaches the contract atomically and rolls back invalid specifications", () => {
  const { db } = fixture();
  expect(() => addJob(db, { repo: "o/r", issue_number: 43, task_source: "test", contract: {} })).toThrow();
  expect(db.query("SELECT * FROM jobs WHERE issue_number = 43").get()).toBeNull();
  const { job_id } = addJob(db, { repo: "o/r", issue_number: 43, task_source: "test", contract: spec() });
  expect(getContract(db, job_id)?.criteria).toHaveLength(2);
  expect(addJob(db, { repo: "o/r", issue_number: 43, task_source: "test", contract: spec() }).inserted).toBe(false);
});

test("records failing criteria, repair effort, passing revision and stale evidence", async () => {
  const { db, id, cwd, commit, git } = fixture();
  setContract(db, id, spec());
  expect(await contractCompletionError(db, id, cwd)).toContain("no passing");
  const failed = await verifyContract(db, id, cwd, { reportedEffortMs: 1200 });
  expect(failed).toMatchObject({ iteration: 1, decision: "retry", reported_effort_ms: 1200, git_commit: git("rev-parse", "HEAD") });
  expect(failed.criteria).toEqual([{ id: "fixed", passed: false }, { id: "readable", passed: false }]);
  expect(failed.checks.map((check) => check.exit_code)).toEqual([1, 0]);
  expect(failed.checks[1].output).toContain("broken");
  expect(failed.elapsed_ms).toBeGreaterThanOrEqual(0);
  writeFileSync(join(cwd, "value.txt"), "fixed");
  await expect(verifyContract(db, id, cwd)).rejects.toThrow("commit changes");
  expect(contractHistory(db, id)).toHaveLength(1);
  commit();
  const passed = await verifyContract(db, id, cwd);
  expect(passed).toMatchObject({ iteration: 2, decision: "complete", reported_effort_ms: null });
  expect(passed.criteria.every((criterion) => criterion.passed)).toBe(true);
  expect(await contractCompletionError(db, id, cwd)).toBeNull();
  writeFileSync(join(cwd, "value.txt"), "regression");
  expect(await contractCompletionError(db, id, cwd)).toContain("commit changes");
  commit();
  expect(await contractCompletionError(db, id, cwd)).toContain("stale");
  transitionJob(db, id, "failed");
  requeueJobs(db, { jobIds: [id] });
  expect(contractHistory(db, id)).toHaveLength(2);
  const stopped = await verifyContract(db, id, cwd);
  expect(stopped).toMatchObject({ iteration: 3, decision: "stop", reason: "failed checks; iteration limit reached" });
  await expect(verifyContract(db, id, cwd)).rejects.toThrow("budget is closed");
  transitionJob(db, id, "blocked");
  clearJobs(db);
  expect(getContract(db, id)).not.toBeNull();
  expect(contractHistory(db, id)).toHaveLength(3);
});

test("records real timeouts, spawn errors, bounded output and explicit stop decisions", async () => {
  const { db, id, cwd } = fixture();
  setContract(db, id, {
    specification: "Exercise unsuccessful checks",
    criteria: [{ id: "safe", description: "Checks complete successfully", checks: ["timeout", "missing", "output"] }],
    checks: [
      { id: "timeout", command: [process.execPath, "-e", 'require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio: "inherit"}).unref()'], timeout_ms: 80 },
      { id: "missing", command: [join(cwd, "missing-executable")] },
      { id: "output", command: [process.execPath, "-e", 'console.log("x".repeat(20000))'] },
    ],
  });
  const result = await verifyContract(db, id, cwd, { stopReason: "requires maintainer input" });
  expect(result.decision).toBe("stop");
  expect(result.reason).toBe("requires maintainer input");
  expect(result.checks[0].timed_out).toBe(true);
  // A wrapper can exit zero while a descendant still holds its output pipes.
  expect([0, null]).toContain(result.checks[0].exit_code);
  expect(result.checks[1].error).not.toBeNull();
  expect(result.checks[2].output.length).toBeLessThanOrEqual(8000);
  expect(result.criteria[0].passed).toBe(false);
  await expect(verifyContract(db, id, cwd)).rejects.toThrow("budget is closed");
});

test("rejects evidence from another session/worktree and detects mutations by checks", async () => {
  const { db, id, cwd } = fixture();
  expect(await contractCompletionError(db, id, cwd)).toBeNull(); // legacy task
  setContract(db, id, spec());
  const other = fixture();
  db.query("UPDATE jobs SET worktree_path = ? WHERE job_id = ?").run(cwd, id);
  await expect(verifyContract(db, id, other.cwd)).rejects.toThrow("differs");
  writeFileSync(join(cwd, "value.txt"), "fixed");
  Bun.spawnSync(["git", "add", "."], { cwd });
  Bun.spawnSync(["git", "commit", "-qm", "repair"], { cwd });
  await verifyContract(db, id, cwd);
  db.query(`INSERT INTO sessions (session_id, workload_class, started_at, ended_at, outcome)
    VALUES ('new-session', 'headless', 'now', 'now', 'abandoned')`).run();
  db.query("UPDATE jobs SET session_id = 'new-session' WHERE job_id = ?").run(id);
  expect(await contractCompletionError(db, id, cwd)).toContain("earlier session");
  const mutating = spec();
  mutating.checks[0].command = [process.execPath, "-e", 'require("fs").writeFileSync("value.txt", "mutation")'];
  setContract(other.db, other.id, mutating);
  const result = await verifyContract(other.db, other.id, other.cwd);
  expect(result.checks.every((check) => check.exit_code === 0)).toBe(true);
  expect(result.decision).toBe("retry");
  expect(await contractCompletionError(other.db, other.id, other.cwd)).not.toBeNull();
});

test("CLI attaches and reports contracts, executes checks and exposes history without external services", async () => {
  const { db, id, cwd, commit } = fixture();
  writeFileSync(join(cwd, "contract.json"), JSON.stringify(spec()));
  writeFileSync(join(cwd, "value.txt"), "fixed");
  commit();
  const run = async (...args: string[]) => {
    const proc = Bun.spawn([process.execPath, cli, ...args, "--db", db.filename], { cwd, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { out, err, code };
  };
  const attach = await run("contract", id, "--file", "contract.json");
  expect(attach.code).toBe(0);
  expect(JSON.parse(attach.out).iterations).toEqual([]);
  const verified = await run("verify", id, "--cwd", cwd, "--effort-ms", "123");
  expect(verified.code).toBe(0);
  expect(JSON.parse(verified.out)).toMatchObject({ decision: "complete", reported_effort_ms: 123 });
  expect(verified.err).toContain("check 2/2: read");
  const show = await run("contract", id);
  expect(JSON.parse(show.out).iterations).toHaveLength(1);
  expect((await run("verify", id, "--effort-ms", "NaN")).code).toBe(1);
  expect(contractPrompt(db, id, cwd)).toContain("Before shipping");
  expect(contractPrompt(db, id, cwd)).toContain(db.filename);
  expect(contractPrompt(db, "legacy", cwd)).toBe("");
  const add = await run("add", "--repo", "o/r", "--issue", "43", "--title", "Test", "--contract", "contract.json");
  expect(add.code).toBe(0);
  expect(getContract(db, "o__r-43")?.specification).toBe(spec().specification);
});

test("reconciliation blocks a report without passing evidence and accepts verified work", async () => {
  const { db, cwd, id } = fixture();
  const repos = join(cwd, "repos");
  const source = join(repos, "o__r");
  mkdirSync(source, { recursive: true });
  const git = (...args: string[]) => {
    const proc = Bun.spawnSync(["git", ...args], { cwd: source });
    if (proc.exitCode) throw new Error(proc.stderr.toString());
  };
  git("init", "-q");
  git("config", "user.name", "Contract Tests");
  git("config", "user.email", "contract-tests@example.invalid");
  writeFileSync(join(source, "value.txt"), "fixed");
  git("add", ".");
  git("commit", "-qm", "baseline");
  const good = addJob(db, { repo: "o/r", issue_number: 43, task_source: "test" }).job_id;
  for (const jobId of [id, good]) {
    const wt = join(cwd, jobId);
    git("worktree", "add", "-qb", jobId, wt, "HEAD");
    setContract(db, jobId, spec());
    const report = join(cwd, `${jobId}.md`);
    writeFileSync(report, "Outcome: stopped\nPR_URL: none\n");
    db.query("UPDATE jobs SET worktree_path = ?, pr_draft_path = ?, base_ref = 'HEAD', state = 'running' WHERE job_id = ?").run(wt, report, jobId);
    if (jobId === good) await verifyContract(db, jobId, wt);
  }
  const bin = join(cwd, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "tmux"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "tmux"), 0o755);
  const config = join(cwd, "repos.yaml");
  writeFileSync(config, "o__r:\n  max_files_changed: 10\n  max_lines_changed: 100\n  max_prs_per_week: 3\n");
  const proc = Bun.spawn([process.execPath, cli, "dispatch", "--db", db.filename], {
    cwd, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MK_FLEET_REPOS_YAML: config, MK_FLEET_REPOS_DIR: repos },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect({ code, out, err }).toMatchObject({ code: 0 });
  expect(db.query("SELECT state, last_error FROM jobs WHERE job_id = ?").get(id)).toMatchObject({ state: "blocked", last_error: "task contract has no passing verification; inspect contract history" });
  expect(db.query("SELECT state FROM jobs WHERE job_id = ?").get(good)).toEqual({ state: "done" });
});
