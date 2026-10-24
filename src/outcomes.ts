// GitHub is the source of truth. Run records only identify the PRs to follow.
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RUNS_ROOT = join(homedir(), ".local", "share", "mk-fleet", "runs");
const SYNC_INTERVAL_MS = 60_000;

export function openedPullRequests(text: string, repo: string): number[] {
  // New records have an unambiguous field. Older records must explicitly say
  // they opened a PR; a NO-GO mentioning someone else's PR is not a submission.
  const plain = text.replace(/\*\*/g, "");
  const fields = plain.match(/^\s*(?:-\s*)?PR[_ ]URL\s*:\s*(.+)$/gim);
  const source = fields ? fields.join("\n") : /^\s*(?:-\s*)?(?:Outcome:\s*)?PR opened\b/im.test(plain) ? plain : "";
  const numbers = [...source.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\b/g)]
    .filter((m) => m[1].toLowerCase() === repo.toLowerCase() && Number.isSafeInteger(Number(m[2])) && Number(m[2]) > 0)
    .map((m) => Number(m[2]));
  return [...new Set(numbers)];
}

/** Capture before queue cleanup. No FK to jobs, so subsequent runs retain history. */
export function capturePullRequests(db: Database, runsRoot = RUNS_ROOT): void {
  const columns = new Set((db.query("PRAGMA table_info(jobs)").all() as { name: string }[]).map((r) => r.name));
  const jobs = db.query(`SELECT job_id, repo,
    ${columns.has("branch") ? "branch" : "NULL AS branch"},
    ${columns.has("pr_draft_path") ? "pr_draft_path" : "NULL AS pr_draft_path"} FROM jobs`).all() as {
    job_id: string; repo: string; branch: string | null; pr_draft_path: string | null;
  }[];
  const insert = db.query(`INSERT INTO pull_requests (repo, pr_number, job_id, url, branch)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(repo, pr_number) DO NOTHING`);
  for (const job of jobs) {
    const record = job.pr_draft_path ?? join(runsRoot, job.job_id, "pr-draft.md");
    const numbers = new Set([record, `${record}.urls`].filter(existsSync)
      .flatMap((file) => openedPullRequests(readFileSync(file, "utf8"), job.repo)));
    for (const number of numbers) {
      insert.run(job.repo.toLowerCase(), number, job.job_id,
        `https://github.com/${job.repo}/pull/${number}`, job.branch);
    }
  }
}

export async function githubJson(endpoint: string, paginated: boolean, signal?: AbortSignal): Promise<unknown> {
  const proc = Bun.spawn(["gh", "api", "--method", "GET", "--hostname", "github.com", endpoint,
    ...(paginated ? ["--paginate", "--slurp"] : [])], {
    stdout: "pipe", stderr: "pipe",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  if (code !== 0) throw new Error(`GitHub read failed (${code}): ${err.trim()}`);
  const value = JSON.parse(out);
  if (!paginated) return value;
  if (!Array.isArray(value) || !value.every(Array.isArray)) throw new Error("Invalid GitHub pagination response");
  return value.flat();
}

type User = { login: string; type?: string };
type Pull = {
  number: number; html_url: string; state: "open" | "closed"; user: User;
  head: { ref: string }; base: { repo: { full_name: string } };
  created_at: string; merged_at: string | null; closed_at: string | null;
};
type Decision = {
  id: number; user?: User | null; actor?: User | null; author_association?: string;
  event?: string; state?: string; body?: string | null; html_url?: string;
  created_at?: string; submitted_at?: string | null; updated_at?: string;
};

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isMaintainer(decision: Decision, author: string): boolean {
  return decision.user != null && decision.user.type !== "Bot" &&
    decision.user.login.toLowerCase() !== author.toLowerCase() &&
    ["OWNER", "MEMBER", "COLLABORATOR"].includes(decision.author_association ?? "");
}

/** Complete each PR atomically. Failed reads preserve the last successful snapshot. */
export async function syncOutcomes(db: Database, opts: {
  force?: boolean;
  signal?: AbortSignal;
  read?: typeof githubJson;
  now?: number;
} = {}): Promise<{ synced: number; errors: string[] }> {
  const read = opts.read ?? githubJson;
  const now = opts.now ?? Date.now();
  const stamp = new Date(now).toISOString();
  const rows = db.query("SELECT repo, pr_number, branch, last_checked_at FROM pull_requests ORDER BY repo, pr_number").all() as {
    repo: string; pr_number: number; branch: string | null; last_checked_at: string | null;
  }[];
  const result = { synced: 0, errors: [] as string[] };
  for (const row of rows) {
    if (opts.signal?.aborted) break;
    if (!opts.force && row.last_checked_at && now - Date.parse(row.last_checked_at) < SYNC_INTERVAL_MS) continue;
    const root = `repos/${row.repo}`;
    const pull = `${root}/pulls/${row.pr_number}`;
    try {
      const pr = await read(pull, false, opts.signal) as Pull;
      if (pr.number !== row.pr_number || pr.base?.repo?.full_name?.toLowerCase() !== row.repo ||
          (row.branch && pr.head?.ref !== row.branch) || !["open", "closed"].includes(pr.state) ||
          !pr.user?.login || !validTimestamp(pr.created_at) ||
          [pr.merged_at, pr.closed_at].some((value) => value !== null && !validTimestamp(value))) {
        throw new Error("GitHub PR does not match the recorded repository/branch or has invalid data");
      }
      const [events, reviews, comments] = await Promise.all([
        read(`${root}/issues/${row.pr_number}/events?per_page=100`, true, opts.signal),
        read(`${pull}/reviews?per_page=100`, true, opts.signal),
        read(`${pull}/comments?per_page=100`, true, opts.signal),
      ]) as [Decision[], Decision[], Decision[]];
      if (![events, reviews, comments].every(Array.isArray)) throw new Error("Invalid GitHub decision response");
      const decisions: [string, Decision, string, string][] = [];
      for (const event of events) {
        if (["merged", "closed", "reopened"].includes(event.event ?? "")) {
          decisions.push(["event", event, event.event!, event.created_at!]);
        }
      }
      for (const review of reviews) {
        if (isMaintainer(review, pr.user.login) && review.submitted_at &&
            ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"].includes(review.state ?? "")) {
          decisions.push(["review", review, review.state!, review.submitted_at]);
        }
      }
      for (const comment of comments) {
        if (isMaintainer(comment, pr.user.login)) decisions.push(["review_comment", comment, "COMMENTED", comment.created_at!]);
      }
      if (decisions.some(([, d, , at]) => !Number.isSafeInteger(d.id) || d.id <= 0 || !validTimestamp(at))) {
        throw new Error("Invalid GitHub decision identity/timestamp");
      }
      db.transaction(() => {
        db.query(`UPDATE pull_requests SET author = ?, state = ?, created_at = ?,
          merged_at = ?, closed_at = ?, last_checked_at = ?, last_synced_at = ?, sync_error = NULL
          WHERE repo = ? AND pr_number = ?`).run(pr.user.login, pr.merged_at ? "merged" : pr.state,
            pr.created_at, pr.merged_at, pr.closed_at, stamp, stamp, row.repo, row.pr_number);
        const insert = db.query(`INSERT INTO pr_decisions
          (repo, pr_number, source, source_id, kind, actor, author_association, body, url, occurred_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(repo, pr_number, source, source_id) DO UPDATE SET
            kind = excluded.kind, actor = excluded.actor, author_association = excluded.author_association,
            body = excluded.body, url = excluded.url, updated_at = excluded.updated_at`);
        for (const [source, d, kind, at] of decisions) {
          insert.run(row.repo, row.pr_number, source, d.id, kind,
            (d.user ?? d.actor)?.login ?? null, d.author_association ?? null,
            d.body ?? null, d.html_url ?? pr.html_url, at, d.updated_at ?? null);
        }
      })();
      result.synced++;
    } catch (error) {
      if (opts.signal?.aborted) break;
      const message = error instanceof Error ? error.message : String(error);
      db.query("UPDATE pull_requests SET last_checked_at = ?, sync_error = ? WHERE repo = ? AND pr_number = ?")
        .run(stamp, message, row.repo, row.pr_number);
      result.errors.push(`${row.repo}#${row.pr_number}: ${message}`);
    }
  }
  return result;
}

export interface RepoAcceptance {
  repo: string;
  merged: number;
  closed: number;
  open: number;
  unknown: number;
  errors: number;
  last_synced_at: string | null;
}

export function repoAcceptance(db: Database): RepoAcceptance[] {
  return db.query(`SELECT repo,
    COALESCE(SUM(state = 'merged'), 0) AS merged, COALESCE(SUM(state = 'closed'), 0) AS closed,
    COALESCE(SUM(state = 'open'), 0) AS open, SUM(state IS NULL) AS unknown,
    SUM(sync_error IS NOT NULL) AS errors, MIN(last_synced_at) AS last_synced_at
    FROM pull_requests GROUP BY repo ORDER BY repo`).all() as RepoAcceptance[];
}
