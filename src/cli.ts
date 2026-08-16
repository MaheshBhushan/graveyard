#!/usr/bin/env bun
// mk-fleet CLI: durable work queue plus the `dispatch` entry point, which
// launches one worktree-isolated agent session per queued job (src/dispatch.ts).
//
// Usage (via the `gm`/`graveyard` launcher in bin/gm, or `bun run src/cli.ts`):
//   gm add <issue-url | owner/name#n> [--title <s>] [--priority <n>]
//   gm add --repo <owner/name> --issue <n> [--title <s>] [--priority <n>]
//   gm add --from-gh <owner/name> [--label <l>] [--limit <n>]
//   gm start [--wip <n>] [--tick <s>] [--dry] [--foreground]
//   gm watch [--interval <seconds>] [--wip <n>]
//   gm stop
//   gm list [--state <s>] [--json]
//   gm status
//   gm clear [--state <s,s>] [--purge] [--dry-run]
//   gm dispatch [--wip <n>] [--max-jobs <n>] [--dry-run] [--live] [--repo <owner/name>]
//
// The normal loop is: add, start, watch. `start` runs the fleet until stopped
// and is LIVE by default -- it spends tokens and pushes for real; `--dry`
// launches no-ops instead.
//
// `dispatch` is the single pass underneath `start`, kept for scripting and
// debugging. It is inert without --live.
//
// Global flag: --db <path> (default ~/.local/share/mk-fleet/fleet.sqlite)

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readBugLabels, runDispatch } from "./dispatch.ts";
import { addJob, clearJobs, countByState, listJobs, parseIssueRef, type JobState } from "./queue.ts";
import { renderDashboard, renderJobRows, renderStatus } from "./render.ts";
import { runStart, runStop, supervise } from "./supervisor.ts";
import { runWatch } from "./watch.ts";
import { resolveTheme } from "./theme.ts";

// Matches backfill.ts's hand-rolled flag parsing style.
// Whichever name the launcher was invoked under, so `graveyard` does not
// print usage telling you to run `gm`.
const SELF = process.env.GRAVEYARD_INVOKED_AS || "gm";

function argVal(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const dbPath = argVal("--db") ?? join(homedir(), ".local", "share", "mk-fleet", "fleet.sqlite");
// --db may appear before or after the subcommand, so pick the subcommand out
// of argv rather than assuming a fixed position.
const subcommand = process.argv.slice(2).find((a) =>
  ["add", "list", "status", "clear", "start", "stop", "dispatch", "watch", "__supervise"].includes(a),
);

mkdirSync(dirname(dbPath), { recursive: true });

const db = new Database(dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL;");

const schemaPath = join(import.meta.dir, "..", "schema.sql");
db.exec(readFileSync(schemaPath, "utf8"));

// ---- subcommands -------------------------------------------------------------

// The first bare (non-flag, non-flag-value) word after `add`, if any. That is
// where a pasted issue URL lands.
function positionalAfter(subcmd: string): string | null {
  const start = process.argv.indexOf(subcmd);
  if (start < 0) return null;
  for (let i = start + 1; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith("-")) continue;
    if (process.argv[i - 1]?.startsWith("-") && process.argv[i - 1] !== subcmd) continue;
    return a;
  }
  return null;
}

// Best-effort title lookup so a URL-added job reads like a gh-added one. A
// failure here is not fatal: the job is still queueable without a title.
async function fetchIssueTitle(repo: string, issue: number): Promise<string | null> {
  const proc = Bun.spawn(["gh", "issue", "view", String(issue), "--repo", repo, "--json", "title"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) return null;
  try {
    return JSON.parse(out).title ?? null;
  } catch {
    return null;
  }
}

async function cmdAdd(): Promise<void> {
  const bare = positionalAfter("add");
  if (bare) {
    const ref = parseIssueRef(bare);
    if (!ref) {
      console.error(`not a GitHub issue reference: ${bare}`);
      console.error("expected https://github.com/<owner>/<name>/issues/<n> or <owner>/<name>#<n>");
      process.exitCode = 1;
      return;
    }
    const title = argVal("--title") ?? (await fetchIssueTitle(ref.repo, ref.issue_number));
    const priorityStr = argVal("--priority");
    const res = addJob(db, {
      repo: ref.repo,
      issue_number: ref.issue_number,
      title,
      task_source: "url",
      url: ref.url,
      priority: priorityStr ? Number(priorityStr) : 0,
    });
    const shown = title ? ` ${title}` : "";
    console.log(`${res.job_id}${shown} -> ${res.inserted ? "queued" : "already present"}`);
    return;
  }

  const fromGh = argVal("--from-gh");
  if (fromGh) {
    const repo = fromGh;
    const limit = argVal("--limit") ?? "30";
    // gh AND-filters multiple --label flags, so a repo's bug_labels list needs
    // one query per label unioned, not one query carrying them all.
    const explicit = argVal("--label");
    const labels = explicit ? [explicit] : (readBugLabels(repo) ?? []);

    const issues: { number: number; title: string; url: string }[] = [];
    const seen = new Set<number>();
    for (const label of labels.length ? labels : [null]) {
      const ghArgs = [
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        "open",
        "--json",
        "number,title,url",
        "--limit",
        limit,
      ];
      if (label) ghArgs.push("--label", label);

      const proc = Bun.spawn(["gh", ...ghArgs], { stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) {
        console.error(`gh issue list failed (exit ${code}): ${err.trim()}`);
        process.exitCode = 1;
        return;
      }

      let batch: { number: number; title: string; url: string }[];
      try {
        batch = JSON.parse(out);
      } catch (e) {
        console.error(`could not parse gh output as JSON: ${e}`);
        process.exitCode = 1;
        return;
      }
      for (const issue of batch) {
        if (seen.has(issue.number)) continue;
        seen.add(issue.number);
        issues.push(issue);
      }
    }

    const shown = labels.length ? `labels=${labels.join("|")}` : "no label filter";
    console.log(`mk-fleet add --from-gh ${repo} (${shown})`);
    let inserted = 0;
    for (const issue of issues) {
      const res = addJob(db, {
        repo,
        issue_number: issue.number,
        title: issue.title,
        task_source: "gh",
        url: issue.url,
      });
      console.log(`  #${issue.number} ${issue.title} -> ${res.job_id} (${res.inserted ? "queued" : "already present"})`);
      if (res.inserted) inserted++;
    }
    console.log(`${inserted} newly queued, ${issues.length - inserted} already present`);
    return;
  }

  const repo = argVal("--repo");
  const issueStr = argVal("--issue");
  if (!repo || !issueStr) {
    console.error("usage: add <issue-url | owner/name#n> [--title <s>] [--priority <n>]");
    console.error("       add --repo <owner/name> --issue <n> [--title <s>] [--priority <n>]");
    console.error("       add --from-gh <owner/name> [--label <l>] [--limit <n>]");
    process.exitCode = 1;
    return;
  }
  const issue = Number(issueStr);
  const title = argVal("--title");
  const priorityStr = argVal("--priority");
  const priority = priorityStr ? Number(priorityStr) : 0;

  const res = addJob(db, {
    repo,
    issue_number: issue,
    title,
    task_source: "manual",
    priority,
  });
  console.log(`${res.job_id}: ${res.inserted ? "queued" : "already present"}`);
}

function cmdList(): void {
  const state = argVal("--state") as JobState | null;
  const asJson = process.argv.includes("--json");
  const jobs = listJobs(db, { state: state ?? undefined });
  if (asJson) {
    // --json is machine-readable output, not a themed render: no ANSI, no
    // glyphs, no framing, regardless of TTY.
    console.log(JSON.stringify(jobs, null, 2));
    return;
  }

  const theme = resolveTheme();
  if (jobs.length === 0) {
    console.log("(no jobs)");
    return;
  }
  if (state) {
    // A single filtered state is a flat list of rows, not the fleet dashboard.
    console.log(renderJobRows(jobs, Date.now(), theme));
  } else {
    console.log(renderDashboard(jobs, Date.now(), theme));
  }
}

function cmdClear(): void {
  const dryRun = process.argv.includes("--dry-run");
  const purge = process.argv.includes("--purge");
  const stateArg = argVal("--state");
  const states = stateArg ? stateArg.split(",").map((s) => s.trim()) : undefined;

  const res = clearJobs(db, { states, dryRun });

  for (const k of res.kept) {
    console.error(`kept ${k.job_id}: still ${k.state} -- ${k.state === "parked" ? "waiting to resume" : "an agent is live"}`);
  }
  if (res.cleared.length === 0) {
    console.log(states ? `nothing to clear in ${states.join(", ")}` : "nothing to clear");
    return;
  }

  const byState: Record<string, number> = {};
  for (const c of res.cleared) byState[c.state] = (byState[c.state] ?? 0) + 1;
  const summary = Object.entries(byState)
    .map(([s, n]) => `${n} ${s}`)
    .join(", ");

  if (dryRun) {
    console.log(`would clear ${res.cleared.length} job(s): ${summary}`);
    for (const c of res.cleared) console.log(`  ${c.job_id}`);
    return;
  }

  let purged = 0;
  if (purge) {
    for (const c of res.cleared) {
      const dir = join(homedir(), ".local", "share", "mk-fleet", "runs", c.job_id);
      if (!existsSync(dir)) continue;
      rmSync(dir, { recursive: true, force: true });
      purged++;
    }
  }

  console.log(`cleared ${res.cleared.length} job(s): ${summary}`);
  console.log(
    purge
      ? `  and removed ${purged} run record director${purged === 1 ? "y" : "ies"}`
      : "  run records kept (verdicts and reports); --purge removes those too",
  );
  console.log("  re-add any of them with `gm add <issue-url>`");
}

function cmdStatus(): void {
  const counts = countByState(db);
  const states: JobState[] = ["queued", "running", "done", "failed", "blocked"];
  console.log(renderStatus(counts, states, resolveTheme()));
}

switch (subcommand) {
  case "add":
    await cmdAdd();
    break;
  case "list":
    cmdList();
    break;
  case "status":
    cmdStatus();
    break;
  case "clear":
    cmdClear();
    break;
  case "start": {
    // start means start: live unless explicitly told to rehearse.
    const live = !process.argv.includes("--dry");
    const tickArg = argVal("--tick");
    db.close();
    process.exitCode = await runStart({
      dbPath,
      live,
      foreground: process.argv.includes("--foreground"),
      tickMs: tickArg ? Number(tickArg) * 1000 : undefined,
      repoFilter: argVal("--repo"),
    });
    process.exit(process.exitCode ?? 0);
  }
  case "stop":
    process.exitCode = runStop();
    break;
  case "__supervise": {
    // Internal: the detached child `start` spawns. Not in the usage text.
    const tickArg = argVal("--tick");
    const wipArg = argVal("--wip");
    const maxArg = argVal("--max-jobs");
    db.close();
    await supervise({
      dbPath,
      wip: wipArg ? Number(wipArg) : 3,
      maxJobs: maxArg ? Number(maxArg) : 1,
      live: process.argv.includes("--live"),
      tickMs: tickArg ? Number(tickArg) * 1000 : 30_000,
      repoFilter: argVal("--repo"),
    });
    process.exit(0);
  }
  case "dispatch":
    await runDispatch(db);
    break;
  case "watch": {
    const intervalArg = argVal("--interval");
    const wipArg = argVal("--wip");
    await runWatch(db, {
      wip: wipArg ? Number(wipArg) : 3,
      intervalMs: intervalArg ? Number(intervalArg) * 1000 : 1000,
      theme: resolveTheme(),
      height: process.stdout.rows ?? 24,
    });
    break;
  }
  default:
    console.error(`usage: ${SELF} <add|start|watch|stop|list|status|clear|dispatch> [flags]`);
    console.error("");
    console.error(`  add <issue-url | owner/name#n>   queue an issue`);
    console.error(`  start [--wip <n>] [--tick <s>]   run the fleet until stopped -- SPENDS TOKENS`);
    console.error("  watch [--interval <seconds>]     dashboard: phase 0 verdicts + logs");
    console.error("  stop                             stop the fleet (running agents finish)");
    console.error("  list [--state <s>] [--json]      the queue");
    console.error("  status                           counts by state");
    console.error("  clear [--purge] [--dry-run]      drop finished jobs from the queue");
    console.error("");
    console.error(`  start runs live by default; --dry launches no-ops instead.`);
    console.error("  start defaults: --wip 3 (measured safe concurrency), --tick 30 (seconds)");
    console.error("");
    console.error("  dispatch [--wip <n>] [--max-jobs <n>] [--dry-run] [--live] [--repo <owner/name>]");
    console.error("  dispatch is ONE PASS, and inert without --live. `start` is the loop.");
    process.exitCode = 1;
}

db.close();
