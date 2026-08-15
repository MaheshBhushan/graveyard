#!/usr/bin/env bun
// mk-fleet CLI: durable work queue plus the `dispatch` entry point, which
// launches one worktree-isolated agent session per queued job (src/dispatch.ts).
//
// Usage (via the `gm` launcher in bin/gm, or `bun run src/cli.ts` directly):
//   gm add --repo <owner/name> --issue <n> [--title <s>] [--priority <n>]
//   gm add --from-gh <owner/name> [--label <l>] [--limit <n>]
//   gm list [--state <s>] [--json]
//   gm status
//   gm dispatch [--wip <n>] [--max-jobs <n>] [--dry-run] [--live] [--repo <owner/name>]
//   gm watch [--interval <seconds>] [--wip <n>]
//
// dispatch is INERT by default: without --live it launches a no-op instead of a
// real agent, so a mistyped command costs nothing. --live is what spends tokens.
//
// Global flag: --db <path> (default ~/.local/share/mk-fleet/fleet.sqlite)

import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readBugLabels, runDispatch } from "./dispatch.ts";
import { addJob, countByState, listJobs, type JobState } from "./queue.ts";
import { renderDashboard, renderJobRows, renderStatus } from "./render.ts";
import { runWatch } from "./watch.ts";
import { resolveTheme } from "./theme.ts";

// Matches backfill.ts's hand-rolled flag parsing style.
function argVal(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const dbPath = argVal("--db") ?? join(homedir(), ".local", "share", "mk-fleet", "fleet.sqlite");
// --db may appear before or after the subcommand, so pick the subcommand out
// of argv rather than assuming a fixed position.
const subcommand = process.argv.slice(2).find((a) =>
  ["add", "list", "status", "dispatch", "watch"].includes(a),
);

mkdirSync(dirname(dbPath), { recursive: true });

const db = new Database(dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL;");

const schemaPath = join(import.meta.dir, "..", "schema.sql");
db.exec(readFileSync(schemaPath, "utf8"));

// ---- subcommands -------------------------------------------------------------

async function cmdAdd(): Promise<void> {
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
    console.error("usage: add --repo <owner/name> --issue <n> [--title <s>] [--priority <n>]");
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
    console.error("usage: gm <add|list|status|dispatch|watch> [flags]");
    console.error("  watch [--interval <seconds>]  live view: per-job phase 0 verdict + logs");
    console.error(
      "  dispatch [--wip <n>] [--max-jobs <n>] [--dry-run] [--live] [--repo <owner/name>] [--repos-dir <path>]",
    );
    console.error(
      "  dispatch defaults: --wip 3 (measured safe concurrency), --max-jobs 1 (per-invocation launch cap)",
    );
    console.error(
      "  dispatch is INERT without --live: it launches a no-op, not a real agent. --live spends tokens.",
    );
    process.exitCode = 1;
}

db.close();
