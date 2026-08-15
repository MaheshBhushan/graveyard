#!/usr/bin/env bun
// mk-fleet dispatcher: pull queued jobs and launch one coding-agent session
// per job, each isolated in its own git worktree, never exceeding a WIP limit.
//
// Usage:
//   bun run src/dispatch.ts [--wip <n>] [--max-jobs <n>] [--dry-run]
//                           [--repo <owner/name>] [--repos-dir <path>] [--db <path>]
//
// This file deliberately contains NO code path that pushes, opens a PR, or
// comments anywhere upstream -- see the HARD RULE in prompts/dispatch-agent.md.
// A run ends at a local commit on a worktree branch plus a drafted PR body in
// a local file, for human review. Do not add one.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { listJobs, transitionJob, type Job, type JobState } from "./queue.ts";
import { renderDashboard } from "./render.ts";
import { resolveTheme } from "./theme.ts";
import {
  classifyStall,
  currentAttemptLog,
  RESUME_CAP,
  resumeAgentCommand,
  resumeMarker,
  type StallVerdict,
} from "./recover.ts";

// queue.ts's Job predates the dispatch bookkeeping columns (see migrateJobs
// below); queue.ts is another subtask's file, so widen the row type here
// instead of editing it there.
type DispatchJob = Job & {
  worktree_path: string | null;
  branch: string | null;
  base_ref: string | null;
  tmux_session: string | null;
  pr_draft_path: string | null;
  resume_after: string | null;
  resume_count: number | null;
};

// queue.ts's JobState is a closed union that predates T4's park state (a job
// waiting out a quota/overload window). queue.ts is another subtask's file
// (see the widening comment above), so this file's own transitions use this
// wider type and cast at the transitionJob call site instead.
type DispatchJobState = JobState | "parked";

// ---- concurrency policy ----------------------------------------------------
//
// DERIVED FROM MEASURED DATA, not picked for taste. See mk-fleet/analysis:
// sessions block on human input 49.3% of their active time, so a handful of
// sessions is enough to keep the pipe full; and the API quota is *shared*
// across all of them, so overshooting does not degrade gracefully -- every
// in-flight session stalls on the same rate limit at once and the whole batch
// fails together. 3 is the measured sweet spot. Never exceed it.
const DEFAULT_WIP = 3;

// Cap on launches per invocation, independent of WIP. Deliberately tiny so an
// accidental bare `dispatch` cannot run away.
const DEFAULT_MAX_JOBS = 1;

// A job whose session died is requeued while attempts is below this, then failed.
const MAX_ATTEMPTS = 3;

const FLEET_HOME = join(homedir(), ".local", "share", "mk-fleet");
const WORKTREE_ROOT = join(FLEET_HOME, "worktrees");
const RUNS_ROOT = join(FLEET_HOME, "runs");

// Where the source clones live. bugfix-loop owns these clones; mk-fleet only
// ever reads them and adds/removes worktrees. Overridable so tests can point
// at a throwaway repo instead.
const DEFAULT_REPOS_DIR = join(import.meta.dir, "..", "..", "bugfix-loop", "repos");

const PROMPT_TEMPLATE_PATH = join(import.meta.dir, "..", "prompts", "dispatch-agent.md");

// ---- guardrail data: bugfix-loop/config/repos.yaml -------------------------
//
// Hand-rolled reader for exactly the fields mk-fleet needs. Not a general YAML
// parser -- do not extend it into one. Returns null when the repo has no entry,
// which is a refusal signal: a repo absent from repos.yaml is never dispatched
// and never gets invented default ceilings.
const REPOS_YAML_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "bugfix-loop",
  "config",
  "repos.yaml",
);

export interface RepoConfig {
  default_branch: string | null;
  test_command: string | null;
  bug_labels: string[] | null;
  max_files_changed: number | null;
  max_lines_changed: number | null;
  max_prs_per_week: number | null;
}

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1);
  }
  return t;
}

function parseFlowList(inline: string): string[] {
  return inline
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => unquote(s))
    .filter(Boolean);
}

export function readRepoConfig(repo: string): RepoConfig | null {
  if (!existsSync(REPOS_YAML_PATH)) return null;
  const key = repo.replace("/", "__");
  const lines = readFileSync(REPOS_YAML_PATH, "utf8").split("\n");
  const keyLineIdx = lines.findIndex((l) => l.trimEnd() === `${key}:`);
  if (keyLineIdx === -1) return null;

  const scalars: Record<string, string> = {};
  let bugLabels: string[] | null = null;

  for (let i = keyLineIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (!/^\s/.test(line)) break; // dedented back to a new top-level key
    const m = line.match(/^\s*([a-z_]+):\s*(.*)$/);
    if (!m) continue;
    const [, field, rawValue] = m;
    const value = rawValue.trim();
    if (field === "bug_labels") {
      if (value.startsWith("[")) {
        bugLabels = parseFlowList(value);
      } else {
        // block list: subsequent "  - item" lines
        const labels: string[] = [];
        for (let j = i + 1; j < lines.length; j++) {
          const item = lines[j].match(/^\s*-\s*(.+)$/);
          if (!item) break;
          labels.push(unquote(item[1]));
        }
        bugLabels = labels;
      }
      continue;
    }
    if (value !== "") scalars[field] = unquote(value);
  }

  const num = (field: string): number | null => {
    const v = scalars[field];
    if (v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  return {
    default_branch: scalars["default_branch"] ?? null,
    test_command: scalars["test_command"] ?? null,
    bug_labels: bugLabels,
    max_files_changed: num("max_files_changed"),
    max_lines_changed: num("max_lines_changed"),
    max_prs_per_week: num("max_prs_per_week"),
  };
}

// Kept for cli.ts's `add --from-gh` label default.
export function readBugLabels(repo: string): string[] | null {
  return readRepoConfig(repo)?.bug_labels ?? null;
}

// ---- process helpers -------------------------------------------------------

interface RunResult {
  code: number;
  out: string;
  err: string;
}

async function run(argv: string[], cwd?: string): Promise<RunResult> {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

// tmux session name derived from job_id so a running job can always be found
// again. tmux forbids "." and ":" in session names.
export function tmuxName(jobId: string): string {
  return `mkfleet-${jobId.replace(/[.:]/g, "_")}`;
}

async function tmuxHasSession(name: string): Promise<boolean> {
  // "=name" forces an exact match rather than tmux's fnmatch prefix behaviour.
  const r = await run(["tmux", "has-session", "-t", `=${name}`]);
  return r.code === 0;
}

// ---- schema migration ------------------------------------------------------
//
// sqlite has no ALTER TABLE ... ADD COLUMN IF NOT EXISTS, and schema.sql is
// re-executed on every run, so the columns dispatch needs are added here
// idempotently by inspecting PRAGMA table_info first.
const DISPATCH_COLUMNS: [string, string][] = [
  ["worktree_path", "TEXT"],
  ["branch", "TEXT"],
  ["base_ref", "TEXT"],
  ["tmux_session", "TEXT"],
  ["pr_draft_path", "TEXT"],
  ["resume_after", "TEXT"],
  ["resume_count", "INTEGER DEFAULT 0"],
];

export function migrateJobs(db: Database): void {
  const present = new Set(
    (db.query("PRAGMA table_info(jobs)").all() as { name: string }[]).map((r) => r.name),
  );
  for (const [name, type] of DISPATCH_COLUMNS) {
    if (!present.has(name)) db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${type}`);
  }
}

// ---- diff accounting -------------------------------------------------------

export interface DiffStat {
  files: number;
  lines: number;
}

export function parseNumstat(out: string): DiffStat {
  let files = 0;
  let lines = 0;
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    files++;
    const added = Number(parts[0]);
    const deleted = Number(parts[1]);
    if (Number.isFinite(added)) lines += added; // "-" for binary files -> NaN, counted as 0
    if (Number.isFinite(deleted)) lines += deleted;
  }
  return { files, lines };
}

// Everything this branch changed relative to the ref it was cut from, committed
// or not.
async function diffStatVsBase(worktree: string, baseRef: string): Promise<DiffStat | null> {
  const r = await run(["git", "diff", "--numstat", baseRef], worktree);
  if (r.code !== 0) return null;
  return parseNumstat(r.out);
}

// ---- worktree lifecycle ----------------------------------------------------

function worktreePath(jobId: string): string {
  return join(WORKTREE_ROOT, jobId);
}

function runDir(jobId: string): string {
  return join(RUNS_ROOT, jobId);
}

export function branchName(job: DispatchJob): string {
  return job.issue_number != null ? `fix/issue-${job.issue_number}` : `fix/${job.job_id}`;
}

function sourceRepoPath(reposDir: string, repo: string): string {
  return join(reposDir, repo.replace("/", "__"));
}

async function resolveBaseRef(srcRepo: string, defaultBranch: string | null): Promise<string | null> {
  const candidates = defaultBranch
    ? [`origin/${defaultBranch}`, defaultBranch, "HEAD"]
    : ["HEAD"];
  for (const ref of candidates) {
    const r = await run(["git", "rev-parse", "--verify", "--quiet", ref], srcRepo);
    if (r.code === 0) return ref;
  }
  return null;
}

// Remove a job's worktree from its source repo. NOTE: `git worktree add` wrote
// metadata into the *source* repo's .git/worktrees/, so removal has to go
// through git in that repo, not a plain rmdir.
async function removeWorktree(srcRepo: string, wt: string): Promise<void> {
  if (existsSync(wt)) {
    await run(["git", "worktree", "remove", "--force", wt], srcRepo);
    if (existsSync(wt)) rmSync(wt, { recursive: true, force: true });
  }
  await run(["git", "worktree", "prune"], srcRepo);
}

// ---- the agent command line ------------------------------------------------
//
// Permissions are bypassed on purpose: this runs unattended, so there is no
// human to approve tool calls. What makes that acceptable is (a) the agent is
// confined to a throwaway worktree and (b) the no-push/no-PR rule above, which
// this file has no code to violate.
//
// Invoking a real agent requires an explicit opt-in: either --live, or
// MK_FLEET_AGENT_CMD naming the command to run instead. Without one of those,
// dispatch substitutes an inert no-op rather than a real model.
//
// The default used to be the other way round -- real agent unless
// MK_FLEET_AGENT_CMD was set -- and during T4's own testing that fired twice by
// omission on a manual retry, launching a real permission-bypassed agent that
// nobody intended. A safety property that depends on remembering an env var is
// not a safety property; forgetting a flag now costs an inert run, not a live
// one.
export function agentCommand(promptPath: string, logPath: string, live: boolean): string {
  const override = process.env.MK_FLEET_AGENT_CMD;
  const cmd = override
    ? override
    : live
      ? `claude --dangerously-skip-permissions --model claude-opus-5 -p "$(cat ${promptPath})"`
      : `echo "mk-fleet: inert run -- pass --live (or set MK_FLEET_AGENT_CMD) to invoke a real agent"`;
  return `${cmd} >> ${logPath} 2>&1`;
}

// ---- dispatch --------------------------------------------------------------

function argVal(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

interface Plan {
  job: DispatchJob;
  cfg: RepoConfig;
  srcRepo: string;
  baseRef: string;
  branch: string;
  worktree: string;
  promptPath: string;
  logPath: string;
  prDraftPath: string;
  tmux: string;
  shellCmd: string;
}

function renderPrompt(plan: Plan): string {
  const { job, cfg } = plan;
  const subs: Record<string, string> = {
    ISSUE: job.issue_number != null ? String(job.issue_number) : "(none)",
    REPO: job.repo,
    TITLE: job.title ?? "(no title recorded)",
    URL: job.url ?? "(no url recorded)",
    WORKTREE: plan.worktree,
    BRANCH: plan.branch,
    BASE_REF: plan.baseRef,
    TEST_COMMAND: cfg.test_command ?? "(none recorded in repos.yaml)",
    MAX_FILES: String(cfg.max_files_changed),
    MAX_LINES: String(cfg.max_lines_changed),
    PR_DRAFT_PATH: plan.prDraftPath,
  };
  let text = readFileSync(PROMPT_TEMPLATE_PATH, "utf8");
  for (const [k, v] of Object.entries(subs)) text = text.replaceAll(`{{${k}}}`, v);
  return text;
}

// Reconcile jobs left in 'running' by a killed dispatcher. A scheduler that
// double-launches on restart is broken, so this runs before any launch and is
// the only thing that moves a job out of 'running'.
async function reconcile(db: Database, reposDir: string, dryRun: boolean): Promise<number> {
  const running = listJobs(db, { state: "running" }) as DispatchJob[];
  let alive = 0;

  for (const job of running) {
    const tmux = job.tmux_session ?? tmuxName(job.job_id);
    if (await tmuxHasSession(tmux)) {
      alive++;
      console.error(`  running: ${job.job_id} (tmux ${tmux} alive) -- left alone`);
      continue;
    }

    const wt = job.worktree_path ?? worktreePath(job.job_id);
    const srcRepo = sourceRepoPath(reposDir, job.repo);
    const cfg = readRepoConfig(job.repo);
    const draft = job.pr_draft_path ?? join(runDir(job.job_id), "pr-draft.md");
    const finished = existsSync(draft);

    // Session is gone. Either it finished (it left a PR draft), stalled on a
    // quota wall or a transient error (T4: recover.ts's classifyStall reads
    // the same agent.log this job's tmux command redirected into), or died.
    let nextState: "done" | "failed" | "blocked" | "queued" | "parked";
    let reason: string | null = null;
    let verdict: StallVerdict | null = null;

    if (finished) {
      const stat = job.base_ref ? await diffStatVsBase(wt, job.base_ref) : null;
      if (!stat) {
        nextState = "blocked";
        reason = "could not measure diff against base ref after run";
      } else if (
        cfg?.max_files_changed == null ||
        cfg?.max_lines_changed == null
      ) {
        nextState = "blocked";
        reason = `no diff ceilings in repos.yaml for ${job.repo}`;
      } else if (stat.files > cfg.max_files_changed || stat.lines > cfg.max_lines_changed) {
        nextState = "blocked";
        reason =
          `diff ceiling breached: ${stat.files} files / ${stat.lines} lines ` +
          `(max ${cfg.max_files_changed} files / ${cfg.max_lines_changed} lines)`;
      } else {
        nextState = "done";
      }
    } else {
      const logPath = join(runDir(job.job_id), "agent.log");
      const logText = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
      verdict = classifyStall(currentAttemptLog(logText), false);
      const resumeCount = job.resume_count ?? 0;

      if (verdict.classification === "needs_human") {
        // Money, not a window -- no amount of waiting reopens it. Block so the
        // fleet stops spending resume budget on it and it shows up in the
        // morning as something for Mahesh to action.
        nextState = "blocked";
        reason = `${verdict.quotaKind}: needs human action, not a wait -- ${verdict.rawText ?? ""}`.trim();
      } else if (
        verdict.classification === "stalled_rate_limit" ||
        verdict.classification === "stalled_other"
      ) {
        if (resumeCount >= RESUME_CAP) {
          nextState = "failed";
          reason = `resume cap (${RESUME_CAP}) reached after ${verdict.classification}; giving up`;
        } else {
          nextState = "parked";
          reason = `${verdict.classification}: parked until ${verdict.resumeAfter} (resume ${resumeCount + 1}/${RESUME_CAP})`;
        }
      } else if ((job.attempts ?? 0) < MAX_ATTEMPTS) {
        nextState = "queued";
        reason = `session ${tmux} vanished with no PR draft; requeued (attempt ${job.attempts})`;
      } else {
        nextState = "failed";
        reason = `session ${tmux} vanished with no PR draft after ${job.attempts} attempts`;
      }
    }

    if (dryRun) {
      console.error(`  would reconcile: ${job.job_id} running -> ${nextState}${reason ? ` (${reason})` : ""}`);
      continue;
    }

    if (nextState === "parked") {
      // The point of parking is to resume the SAME worktree/branch later
      // (T4: "resume, don't relaunch") -- unlike every other terminal-ish
      // state here, do not remove it.
      transitionJob(db, job.job_id, "parked" as DispatchJobState as JobState, {
        ...(reason ? { last_error: reason } : {}),
      });
      db.query("UPDATE jobs SET resume_after = $after, resume_count = $count WHERE job_id = $id").run({
        $after: verdict!.resumeAfter,
        $count: (job.resume_count ?? 0) + 1,
        $id: job.job_id,
      });
      db.query("UPDATE sessions SET ended_at = $at, outcome = $outcome WHERE session_id = $sid").run({
        $at: new Date().toISOString(),
        $outcome: verdict!.classification,
        $sid: job.session_id,
      });
      if (verdict!.classification === "stalled_rate_limit" && job.session_id) {
        db.query(
          `INSERT INTO rate_limit_events (session_id, at, kind, raw_text, reset_hint)
           VALUES ($session_id, $at, $kind, $raw_text, $reset_hint)`,
        ).run({
          $session_id: job.session_id,
          $at: new Date().toISOString(),
          $kind: verdict!.quotaKind,
          $raw_text: verdict!.rawText,
          $reset_hint: verdict!.resetHint,
        });
      }
      console.error(`  reconciled: ${job.job_id} running -> parked${reason ? ` (${reason})` : ""}`);
      continue;
    }

    await removeWorktree(srcRepo, wt);
    transitionJob(db, job.job_id, nextState, {
      ...(nextState === "queued" ? {} : { ended_at: new Date().toISOString() }),
      ...(reason ? { last_error: reason } : {}),
    });
    db.query("UPDATE sessions SET ended_at = $at, outcome = $outcome WHERE session_id = $sid").run({
      $at: new Date().toISOString(),
      $outcome:
        verdict?.classification === "needs_human"
          ? "stalled_rate_limit"
          : nextState === "done"
            ? "success"
            : nextState === "queued"
              ? "killed"
              : "failed",
      $sid: job.session_id,
    });
    // A money-based wall is still a quota event: record it so the next gate
    // analysis sees it, even though it was blocked rather than parked.
    if (verdict?.classification === "needs_human" && job.session_id) {
      db.query(
        `INSERT INTO rate_limit_events (session_id, at, kind, raw_text, reset_hint)
         VALUES ($session_id, $at, $kind, $raw_text, $reset_hint)`,
      ).run({
        $session_id: job.session_id,
        $at: new Date().toISOString(),
        $kind: verdict.quotaKind,
        $raw_text: verdict.rawText,
        $reset_hint: verdict.resetHint,
      });
    }
    console.error(`  reconciled: ${job.job_id} running -> ${nextState}${reason ? ` (${reason})` : ""}`);
  }

  return alive;
}

// Resume jobs parked on a quota/overload wall whose resume_after has passed,
// up to `budget` (the WIP headroom left after reconcile()'s still-running
// count) -- a resume occupies a slot exactly like a fresh launch does. Ported
// from cc-continue's cmd_run(): re-enter the SAME worktree/branch/tmux name
// and run `claude --continue` rather than relaunching from scratch, so the
// work already paid for is not thrown away.
async function resumeStalled(db: Database, reposDir: string, dryRun: boolean, budget: number, live: boolean): Promise<number> {
  if (budget <= 0) return 0;
  const now = new Date().toISOString();
  const due = db
    .query(
      `SELECT * FROM jobs WHERE state = 'parked' AND resume_after IS NOT NULL AND resume_after <= $now
       ORDER BY resume_after ASC`,
    )
    .all({ $now: now }) as DispatchJob[];

  const notYet = db
    .query(`SELECT job_id, resume_after FROM jobs WHERE state = 'parked' AND resume_after > $now`)
    .all({ $now: now }) as { job_id: string; resume_after: string }[];
  for (const j of notYet) {
    console.error(`  still parked: ${j.job_id} (resume_after ${j.resume_after} not reached)`);
  }

  let resumed = 0;
  for (const job of due) {
    if (resumed >= budget) {
      console.error(`  due but no free slot this invocation: ${job.job_id}`);
      break;
    }

    const resumeCount = job.resume_count ?? 0;
    if (!job.worktree_path || !job.branch || !existsSync(job.worktree_path)) {
      if (dryRun) {
        console.error(`  would fail ${job.job_id}: worktree missing at resume time`);
        continue;
      }
      transitionJob(db, job.job_id, "failed", {
        ended_at: new Date().toISOString(),
        last_error: `worktree missing at resume time: ${job.worktree_path ?? "(none recorded)"}`,
      });
      console.error(`  ${job.job_id}: worktree missing -> failed`);
      continue;
    }

    if (dryRun) {
      console.error(`  would resume ${job.job_id}: claude --continue in ${job.worktree_path} (branch ${job.branch})`);
      resumed++;
      continue;
    }

    const rd = runDir(job.job_id);
    const logPath = join(rd, "agent.log");
    mkdirSync(rd, { recursive: true });
    // See recover.ts's resumeMarker/currentAttemptLog: agent.log is appended
    // across resumes, so mark the boundary before this attempt's output lands.
    writeFileSync(logPath, resumeMarker(), { flag: "a" });
    const tmux = job.tmux_session ?? tmuxName(job.job_id);
    const shellCmd = resumeAgentCommand(logPath, live);

    const started = await run(["tmux", "new-session", "-d", "-s", tmux, "-c", job.worktree_path, shellCmd]);
    if (started.code !== 0) {
      transitionJob(db, job.job_id, "blocked", {
        ended_at: new Date().toISOString(),
        last_error: `resume tmux new-session failed (exit ${started.code}): ${started.err.trim().slice(0, 300)}`,
      });
      console.error(`  ${job.job_id}: resume tmux launch failed -> blocked`);
      continue;
    }

    const sessionNow = new Date().toISOString();
    const sessionId = crypto.randomUUID();
    db.query(
      `INSERT INTO sessions (
         session_id, agent_kind, workload_class, task_id, task_source, cwd,
         git_branch, queued_at, started_at, ended_at, outcome
       ) VALUES (
         $sid, 'claude', 'headless', $task_id, $task_source, $cwd,
         $branch, $queued_at, $now, $now, 'abandoned'
       )`,
    ).run({
      $sid: sessionId,
      $task_id: job.job_id,
      $task_source: job.task_source,
      $cwd: job.worktree_path,
      $branch: job.branch,
      $queued_at: job.queued_at,
      $now: sessionNow,
    });

    transitionJob(db, job.job_id, "running", {
      started_at: sessionNow,
      session_id: sessionId,
    });
    db.query(
      "UPDATE jobs SET resume_after = NULL, resume_count = $count, tmux_session = $tmux, last_error = NULL WHERE job_id = $job_id",
    ).run({ $count: resumeCount + 1, $tmux: tmux, $job_id: job.job_id });

    console.error(
      `  resumed ${job.job_id}: tmux=${tmux} worktree=${job.worktree_path} branch=${job.branch} session=${sessionId} (${shellCmd})`,
    );
    resumed++;
  }

  return resumed;
}

async function buildPlan(job: DispatchJob, reposDir: string, live: boolean): Promise<Plan | { blocked: string }> {
  const cfg = readRepoConfig(job.repo);
  if (!cfg) return { blocked: `repo ${job.repo} is absent from repos.yaml; refusing to dispatch` };
  if (
    cfg.max_files_changed == null ||
    cfg.max_lines_changed == null ||
    cfg.max_prs_per_week == null
  ) {
    return { blocked: `repo ${job.repo} has incomplete guardrails in repos.yaml; refusing to dispatch` };
  }

  const srcRepo = sourceRepoPath(reposDir, job.repo);
  if (!existsSync(join(srcRepo, ".git"))) {
    return { blocked: `no source clone at ${srcRepo}; refusing to dispatch` };
  }
  const baseRef = await resolveBaseRef(srcRepo, cfg.default_branch);
  if (!baseRef) {
    return { blocked: `could not resolve a base ref in ${srcRepo}; refusing to dispatch` };
  }

  const rd = runDir(job.job_id);
  const promptPath = join(rd, "prompt.md");
  const logPath = join(rd, "agent.log");
  const prDraftPath = join(rd, "pr-draft.md");
  const plan: Plan = {
    job,
    cfg,
    srcRepo,
    baseRef,
    branch: branchName(job),
    worktree: worktreePath(job.job_id),
    promptPath,
    logPath,
    prDraftPath,
    tmux: tmuxName(job.job_id),
    shellCmd: "",
  };
  plan.shellCmd = agentCommand(promptPath, logPath, live);
  return plan;
}

async function launch(db: Database, plan: Plan): Promise<boolean> {
  const { job } = plan;
  mkdirSync(WORKTREE_ROOT, { recursive: true });
  mkdirSync(dirname(plan.promptPath), { recursive: true });

  // -B so a retry of the same job reuses/resets its branch instead of failing.
  const add = await run(
    ["git", "worktree", "add", "-B", plan.branch, plan.worktree, plan.baseRef],
    plan.srcRepo,
  );
  if (add.code !== 0) {
    transitionJob(db, job.job_id, "blocked", {
      ended_at: new Date().toISOString(),
      last_error: `git worktree add failed (exit ${add.code}): ${add.err.trim().slice(0, 300)}`,
    });
    console.error(`  ${job.job_id}: worktree creation failed -> blocked`);
    return false;
  }

  // A worktree contains tracked files only, so a gitignored .venv stays behind
  // in the source clone and repos.yaml's test_command (".venv/bin/pytest ...")
  // would not resolve. Link it through so the configured command runs verbatim.
  // Safe despite the venv's editable install pointing at the source checkout:
  // the interpreter runs with the worktree as cwd, so the worktree's own copy
  // of the package shadows it -- verified by breaking a worktree function and
  // watching that worktree's tests fail.
  const srcVenv = join(plan.srcRepo, ".venv");
  const wtVenv = join(plan.worktree, ".venv");
  if (existsSync(srcVenv) && !existsSync(wtVenv)) {
    symlinkSync(srcVenv, wtVenv);
  }

  writeFileSync(plan.promptPath, renderPrompt(plan));

  const started = await run([
    "tmux",
    "new-session",
    "-d",
    "-s",
    plan.tmux,
    "-c",
    plan.worktree,
    plan.shellCmd,
  ]);
  if (started.code !== 0) {
    await removeWorktree(plan.srcRepo, plan.worktree);
    transitionJob(db, job.job_id, "blocked", {
      ended_at: new Date().toISOString(),
      last_error: `tmux new-session failed (exit ${started.code}): ${started.err.trim().slice(0, 300)}`,
    });
    console.error(`  ${job.job_id}: tmux launch failed -> blocked`);
    return false;
  }

  const now = new Date().toISOString();
  const sessionId = crypto.randomUUID();
  // sessions.ended_at/outcome are NOT NULL, so an in-flight launch is recorded
  // with ended_at == started_at and outcome 'abandoned' as a placeholder;
  // reconcile() rewrites both when the session is seen to have exited.
  db.query(
    `INSERT INTO sessions (
       session_id, agent_kind, workload_class, task_id, task_source, cwd,
       git_branch, queued_at, started_at, ended_at, outcome
     ) VALUES (
       $sid, 'claude', 'headless', $task_id, $task_source, $cwd,
       $branch, $queued_at, $now, $now, 'abandoned'
     )`,
  ).run({
    $sid: sessionId,
    $task_id: job.job_id,
    $task_source: job.task_source,
    $cwd: plan.worktree,
    $branch: plan.branch,
    $queued_at: job.queued_at,
    $now: now,
  });

  transitionJob(db, job.job_id, "running", {
    started_at: now,
    session_id: sessionId,
    attempts: (job.attempts ?? 0) + 1,
  });
  db.query(
    `UPDATE jobs SET worktree_path = $wt, branch = $branch, base_ref = $base,
                     tmux_session = $tmux, pr_draft_path = $draft, last_error = NULL
     WHERE job_id = $job_id`,
  ).run({
    $wt: plan.worktree,
    $branch: plan.branch,
    $base: plan.baseRef,
    $tmux: plan.tmux,
    $draft: plan.prDraftPath,
    $job_id: job.job_id,
  });

  console.error(`  launched ${job.job_id}: tmux=${plan.tmux} worktree=${plan.worktree} session=${sessionId}`);
  return true;
}

export async function runDispatch(db: Database): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const live = process.argv.includes("--live");
  const wipArg = argVal("--wip");
  const maxJobsArg = argVal("--max-jobs");
  const wip = wipArg ? Number(wipArg) : DEFAULT_WIP;
  const maxJobs = maxJobsArg ? Number(maxJobsArg) : DEFAULT_MAX_JOBS;
  const repoFilter = argVal("--repo");
  const reposDir = argVal("--repos-dir") ?? DEFAULT_REPOS_DIR;

  if (!Number.isFinite(wip) || wip < 1 || !Number.isFinite(maxJobs) || maxJobs < 1) {
    console.error("--wip and --max-jobs must be positive integers");
    process.exitCode = 1;
    return;
  }
  if (wip > DEFAULT_WIP) {
    console.error(`note: --wip ${wip} exceeds the measured safe limit of ${DEFAULT_WIP}`);
  }

  // Idempotent ADD COLUMN only; --dry-run does no row writes beyond this.
  migrateJobs(db);

  console.error(
    `mk-fleet dispatch: wip=${wip} max-jobs=${maxJobs}${dryRun ? " (DRY RUN -- nothing will be created)" : ""}`,
  );
  console.error("reconcile:");
  const aliveRunning = await reconcile(db, reposDir, dryRun);

  console.error("resume:");
  const resumeBudget = Math.max(wip - aliveRunning, 0);
  const resumed = await resumeStalled(db, reposDir, dryRun, resumeBudget, live);
  const alive = aliveRunning + resumed;

  const slots = Math.min(Math.max(wip - alive, 0), maxJobs);
  console.error(`running now: ${alive}; free slots this invocation: ${slots}`);
  if (slots === 0) {
    console.error("nothing to launch");
    return;
  }

  const queued = (listJobs(db, { state: "queued" }) as DispatchJob[]).filter(
    (j) => !repoFilter || j.repo === repoFilter,
  );
  console.error(`plan (${queued.length} queued candidate${queued.length === 1 ? "" : "s"}):`);

  let launched = 0;
  for (const job of queued) {
    if (launched >= slots) break;
    const plan = await buildPlan(job, reposDir, live);
    if ("blocked" in plan) {
      if (dryRun) {
        console.error(`  would block ${job.job_id}: ${plan.blocked}`);
      } else {
        transitionJob(db, job.job_id, "blocked", {
          ended_at: new Date().toISOString(),
          last_error: plan.blocked,
        });
        console.error(`  blocked ${job.job_id}: ${plan.blocked}`);
      }
      continue; // a refusal consumes no slot
    }

    if (dryRun) {
      console.error(`  would launch ${job.job_id} (${job.repo}#${job.issue_number ?? "-"})`);
      console.error(`    worktree: ${plan.worktree}  (from ${plan.srcRepo} @ ${plan.baseRef})`);
      console.error(`    branch:   ${plan.branch}`);
      console.error(`    tmux:     tmux new-session -d -s ${plan.tmux} -c ${plan.worktree} '${plan.shellCmd}'`);
      console.error(
        `    ceilings: ${plan.cfg.max_files_changed} files / ${plan.cfg.max_lines_changed} lines / ` +
          `${plan.cfg.max_prs_per_week} prs-per-week (from repos.yaml)`,
      );
      launched++;
      continue;
    }

    if (await launch(db, plan)) launched++;
  }

  console.error(dryRun ? `would launch ${launched} job(s)` : `launched ${launched} job(s)`);

  // The dashboard is the one piece of dispatch output that's "data" rather
  // than progress: current fleet state after this invocation's reconcile/
  // resume/launch pass. Everything above is diagnostics on stderr; this goes
  // to stdout.
  const allJobs = listJobs(db) as DispatchJob[];
  console.log(renderDashboard(allJobs, Date.now(), resolveTheme(), { wip }));
}

if (import.meta.main) {
  const dbPath = argVal("--db") ?? join(FLEET_HOME, "fleet.sqlite");
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(readFileSync(join(import.meta.dir, "..", "schema.sql"), "utf8"));
  await runDispatch(db);
  db.close();
}
