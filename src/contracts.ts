import type { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export interface TaskContract {
  specification: string;
  max_iterations: number;
  criteria: { id: string; description: string; checks: string[] }[];
  checks: { id: string; command: string[]; timeout_ms: number }[];
}

export interface CheckResult {
  id: string;
  command: string[];
  exit_code: number | null;
  timed_out: boolean;
  elapsed_ms: number;
  output: string;
  error: string | null;
}

export interface ContractIteration {
  iteration: number;
  session_id: string | null;
  started_at: string;
  ended_at: string;
  elapsed_ms: number;
  reported_effort_ms: number | null;
  git_commit: string;
  worktree: string;
  checks: CheckResult[];
  criteria: { id: string; passed: boolean }[];
  decision: "complete" | "retry" | "stop";
  reason: string;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= max;
}

export function parseContract(input: unknown): TaskContract {
  if (!input || typeof input !== "object") throw new Error("contract must be an object");
  const raw = input as Record<string, unknown>;
  if (!nonempty(raw.specification)) throw new Error("specification is required");
  const max = raw.max_iterations ?? 3;
  if (!integer(max, 20)) throw new Error("max_iterations must be an integer from 1 to 20");
  if (!Array.isArray(raw.checks) || !raw.checks.length) throw new Error("checks must be nonempty");
  const checks = raw.checks.map((check) => {
    if (!check || !nonempty(check.id) || !Array.isArray(check.command) ||
        !check.command.length || !nonempty(check.command[0]) ||
        !check.command.every((arg: unknown) => typeof arg === "string" && !arg.includes("\0"))) {
      throw new Error("each check needs an id and an executable argv array");
    }
    const timeout = check.timeout_ms ?? 30_000;
    if (!integer(timeout, 30_000)) throw new Error("timeout_ms must be an integer from 1 to 30000");
    return { id: check.id as string, command: [...check.command] as string[], timeout_ms: timeout };
  });
  const ids = new Set(checks.map((check) => check.id));
  if (ids.size !== checks.length) throw new Error("duplicate check id");
  if (!Array.isArray(raw.criteria) || !raw.criteria.length) throw new Error("criteria must be nonempty");
  const criteria = raw.criteria.map((criterion) => {
    if (!criterion || !nonempty(criterion.id) || !nonempty(criterion.description) ||
        !Array.isArray(criterion.checks) || !criterion.checks.length ||
        !criterion.checks.every((id: unknown) => typeof id === "string" && ids.has(id)) ||
        new Set(criterion.checks).size !== criterion.checks.length) {
      throw new Error("each criterion needs an id, description and unique references to existing checks");
    }
    return { id: criterion.id as string, description: criterion.description as string, checks: [...criterion.checks] as string[] };
  });
  if (new Set(criteria.map((criterion) => criterion.id)).size !== criteria.length) throw new Error("duplicate criterion id");
  const linked = new Set(criteria.flatMap((criterion) => criterion.checks));
  if (checks.some((check) => !linked.has(check.id))) throw new Error("every check must link to a criterion");
  return { specification: raw.specification, max_iterations: max, criteria, checks };
}

export function getContract(db: Database, jobId: string): TaskContract | null {
  const row = db.query("SELECT specification FROM task_contracts WHERE job_id = ?").get(jobId) as { specification: string } | null;
  return row ? parseContract(JSON.parse(row.specification)) : null;
}

export function setContract(db: Database, jobId: string, input: unknown): void {
  const contract = parseContract(input);
  db.transaction(() => {
    const job = db.query("SELECT state FROM jobs WHERE job_id = ?").get(jobId) as { state: string } | null;
    if (!job || job.state !== "queued") throw new Error("attach contracts to queued jobs only");
    const existing = getContract(db, jobId);
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(contract)) return;
      throw new Error("contract is immutable; queue a separate task for a changed specification");
    }
    db.query("INSERT INTO task_contracts VALUES (?, ?, ?)").run(jobId, JSON.stringify(contract), new Date().toISOString());
  })();
}

export function contractHistory(db: Database, jobId: string): ContractIteration[] {
  const rows = db.query("SELECT result FROM contract_iterations WHERE job_id = ? ORDER BY iteration").all(jobId) as { result: string }[];
  return rows.map((row) => JSON.parse(row.result));
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`git ${args[0]} failed: ${err.trim()}`);
  return out.trim();
}

async function revision(cwd: string): Promise<string> {
  if (realpathSync(await git(cwd, "rev-parse", "--show-toplevel")) !== realpathSync(cwd)) {
    throw new Error("verification cwd must be the Git worktree root");
  }
  if (await git(cwd, "status", "--porcelain", "--untracked-files=all")) {
    throw new Error("commit changes and clean the worktree before verification");
  }
  return git(cwd, "rev-parse", "HEAD");
}

async function runCheck(check: TaskContract["checks"][number], cwd: string): Promise<CheckResult> {
  const start = performance.now();
  const result: CheckResult = { id: check.id, command: check.command, exit_code: null, timed_out: false, elapsed_ms: 0, output: "", error: null };
  try {
    await new Promise<void>((done) => {
      const proc = spawn(check.command[0], check.command.slice(1), {
        cwd, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
      });
      // Keep descendants in a group so test wrappers cannot outlive the timeout.
      const timer = setTimeout(() => {
        result.timed_out = true;
        try {
          if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, "SIGKILL");
          else proc.kill("SIGKILL");
        } catch { proc.kill("SIGKILL"); }
        proc.stdout.destroy();
        proc.stderr.destroy();
      }, check.timeout_ms);
      for (const stream of [proc.stdout, proc.stderr]) {
        stream.setEncoding("utf8");
        stream.on("data", (chunk: string) => { result.output = (result.output + chunk).slice(-8000); });
      }
      proc.once("error", (error) => { result.error = String(error); });
      proc.once("close", (code) => { clearTimeout(timer); result.exit_code = code; done(); });
    });
  } catch (error) {
    result.error = String(error);
  }
  result.elapsed_ms = Math.round(performance.now() - start);
  return result;
}

export async function verifyContract(
  db: Database,
  jobId: string,
  cwd: string,
  opts: { reportedEffortMs?: number; stopReason?: string; progress?: (message: string) => void } = {},
): Promise<ContractIteration> {
  if (opts.reportedEffortMs !== undefined && (!Number.isSafeInteger(opts.reportedEffortMs) || opts.reportedEffortMs < 0)) {
    throw new Error("reported effort must be a nonnegative integer in milliseconds");
  }
  if (opts.stopReason !== undefined && !nonempty(opts.stopReason)) throw new Error("stop reason must be nonempty");
  const contract = getContract(db, jobId);
  if (!contract) throw new Error(`no contract for ${jobId}`);
  const job = db.query("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as { worktree_path?: string | null; session_id: string | null } | null;
  if (!job) throw new Error("job is no longer in the queue; history remains available");
  if (job.worktree_path && realpathSync(job.worktree_path) !== realpathSync(cwd)) throw new Error("cwd differs from the job worktree");
  const history = contractHistory(db, jobId);
  if (history.at(-1)?.decision === "stop" || history.length >= contract.max_iterations) throw new Error("contract verification budget is closed");
  const commit = await revision(cwd);
  const start = performance.now();
  const startedAt = new Date().toISOString();
  const checks: CheckResult[] = [];
  for (const [index, check] of contract.checks.entries()) {
    opts.progress?.(`check ${index + 1}/${contract.checks.length}: ${check.id}`);
    checks.push(await runCheck(check, cwd));
  }
  let changeError: string | null = null;
  try {
    if (await revision(cwd) !== commit) changeError = "Git revision changed during verification";
  } catch (error) { changeError = String(error); }
  const passed = new Set(checks.filter((check) => check.exit_code === 0 && !check.timed_out && !check.error).map((check) => check.id));
  const criteria = contract.criteria.map((criterion) => ({ id: criterion.id, passed: criterion.checks.every((id) => passed.has(id)) }));
  const complete = !changeError && criteria.every((criterion) => criterion.passed);
  const decision = opts.stopReason ? "stop" : complete ? "complete" : history.length + 1 >= contract.max_iterations ? "stop" : "retry";
  const result: ContractIteration = {
    iteration: history.length + 1, session_id: job.session_id, started_at: startedAt, ended_at: new Date().toISOString(),
    elapsed_ms: Math.round(performance.now() - start), reported_effort_ms: opts.reportedEffortMs ?? null,
    git_commit: commit, worktree: realpathSync(cwd), checks, criteria, decision,
    reason: opts.stopReason ?? changeError ?? (complete ? "all acceptance criteria passed" : decision === "stop" ? "failed checks; iteration limit reached" : "failed checks; repair and retry"),
  };
  db.transaction(() => {
    if (contractHistory(db, jobId).length !== history.length) throw new Error("another verification finished; reload history before retrying");
    db.query("INSERT INTO contract_iterations VALUES (?, ?, ?)").run(jobId, result.iteration, JSON.stringify(result));
  })();
  return result;
}

/** A report cannot certify a contracted task without current executable evidence. */
export async function contractCompletionError(db: Database, jobId: string, cwd: string): Promise<string | null> {
  if (!getContract(db, jobId)) return null;
  const last = contractHistory(db, jobId).at(-1);
  if (!last || last.decision !== "complete") return "task contract has no passing verification; inspect contract history";
  const job = db.query("SELECT session_id FROM jobs WHERE job_id = ?").get(jobId) as { session_id: string | null } | null;
  if (!job || last.session_id !== job.session_id) return "task contract evidence belongs to an earlier session";
  try {
    if (last.worktree !== realpathSync(cwd) || last.git_commit !== await revision(cwd)) return "task contract evidence is stale for this worktree/revision";
  } catch (error) { return String(error); }
  return null;
}

export function contractPrompt(db: Database, jobId: string, cwd: string): string {
  const contract = getContract(db, jobId);
  if (!contract) return "";
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const command = [process.execPath, `${import.meta.dir}/cli.ts`, "verify", jobId, "--db", resolve(db.filename), "--cwd", cwd].map(quote).join(" ");
  return `\n\n## Task contract\n\n${JSON.stringify(contract, null, 2)}\n\nBefore shipping, commit your changes and verify the clean worktree with:\n\n${command}\n\nRead the JSON result. On retry, repair, commit and verify again. On stop, end work and explain the reason in the run record. Ship only after complete. Each verification records the linked criteria, check results, Git revision, elapsed check time and optional --effort-ms (reported implementation effort since the preceding verification). Use --stop-reason to record a deliberate stop. Do not change the specification to make checks pass. The verification budget persists across resumes and requeues.\n`;
}
