#!/usr/bin/env bun
// mk-fleet backfill entry point.
//
// Reads ~/.claude/projects/*/*.jsonl (STRICTLY READ-ONLY -- never writes,
// moves, or deletes anything under ~/.claude) and populates the sessions +
// rate_limit_events tables in the mk-fleet sqlite database. Safe to re-run:
// every write is an upsert keyed on session_id, so running twice does not
// duplicate rows or double-count tokens.
//
// Usage: bun run src/backfill.ts [--db <path>] [--until <iso8601>] [--corpus <dir>]

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  classifyQuotaKind,
  computeRetries,
  deriveSessions,
  estimateCost,
  extractResetHint,
  loadCorpus,
} from "./telemetry.ts";

function argVal(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const dbPath = argVal("--db") ?? join(homedir(), ".local", "share", "mk-fleet", "fleet.sqlite");
const corpusDir = argVal("--corpus") ?? join(homedir(), ".claude", "projects");
const untilArg = argVal("--until");
// The corpus is live: Claude Code appends to it while this runs, so anything
// at or after "now" is ignored for this run, matching gate_analysis.py's
// CUTOFF strategy (there it's a pinned instant for reproducibility; here it
// defaults to "now" each run, overridable with --until for a pinned rerun).
const cutoffMs = untilArg ? Date.parse(untilArg) : Date.now();

mkdirSync(dirname(dbPath), { recursive: true });

const db = new Database(dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL;");

const schemaPath = join(import.meta.dir, "..", "schema.sql");
db.exec(readFileSync(schemaPath, "utf8"));

async function main() {
  const { sessions, quotaEvents } = await loadCorpus(corpusDir, cutoffMs);
  const derived = deriveSessions(sessions);
  const derivedIds = new Set(derived.keys());

  const interactive = [...derived.values()].filter((s) => s.interactive);
  const retryOf = computeRetries(interactive);

  const upsertSession = db.prepare(`
    INSERT INTO sessions (
      session_id, agent_kind, workload_class, account_id, model, effort,
      task_id, task_source, cwd, git_branch, queued_at, started_at, ended_at,
      service_ms, active_ms, approval_wait_ms, think_wait_ms, outcome,
      tokens_in, tokens_out, cache_read, cache_write, cost_estimate,
      retry_of, downstream_outcome, turn_count
    ) VALUES (
      $session_id, 'claude', $workload_class, NULL, $model, NULL,
      NULL, NULL, $cwd, $git_branch, NULL, $started_at, $ended_at,
      $service_ms, $active_ms, $approval_wait_ms, $think_wait_ms, $outcome,
      $tokens_in, $tokens_out, $cache_read, $cache_write, $cost_estimate,
      $retry_of, NULL, $turn_count
    )
    ON CONFLICT(session_id) DO UPDATE SET
      workload_class    = excluded.workload_class,
      model             = excluded.model,
      cwd               = excluded.cwd,
      git_branch        = excluded.git_branch,
      started_at        = excluded.started_at,
      ended_at          = excluded.ended_at,
      service_ms        = excluded.service_ms,
      active_ms         = excluded.active_ms,
      approval_wait_ms  = excluded.approval_wait_ms,
      think_wait_ms     = excluded.think_wait_ms,
      outcome           = excluded.outcome,
      tokens_in         = excluded.tokens_in,
      tokens_out        = excluded.tokens_out,
      cache_read        = excluded.cache_read,
      cache_write       = excluded.cache_write,
      cost_estimate     = excluded.cost_estimate,
      retry_of          = excluded.retry_of,
      turn_count        = excluded.turn_count
  `);

  const deleteEvents = db.prepare(`DELETE FROM rate_limit_events WHERE session_id = $session_id`);
  const insertEvent = db.prepare(`
    INSERT INTO rate_limit_events (session_id, at, kind, raw_text, reset_hint)
    VALUES ($session_id, $at, $kind, $raw_text, $reset_hint)
  `);

  const runAll = db.transaction(() => {
    for (const s of derived.values()) {
      const cost = estimateCost(s.model, s.tokensIn, s.tokensOut, s.cacheWrite, s.cacheRead);
      upsertSession.run({
        $session_id: s.sid,
        $workload_class: s.interactive ? "interactive" : "headless",
        $model: s.model,
        $cwd: s.cwd,
        $git_branch: s.branch,
        $started_at: new Date(s.start).toISOString(),
        $ended_at: new Date(s.end).toISOString(),
        $service_ms: s.serviceMs,
        $active_ms: s.activeMs,
        $approval_wait_ms: s.approvalWaitMs,
        $think_wait_ms: s.thinkWaitMs,
        $outcome: s.outcome,
        $tokens_in: s.tokensIn,
        $tokens_out: s.tokensOut,
        $cache_read: s.cacheRead,
        $cache_write: s.cacheWrite,
        $cost_estimate: cost,
        $retry_of: retryOf.get(s.sid) ?? null,
        $turn_count: s.events,
      });
    }

    // Rebuild rate_limit_events per session from scratch each run: the
    // events are fully re-derived from the corpus every time, so a
    // delete+reinsert per touched session_id is idempotent without needing
    // a synthetic unique key on this child table.
    const bySession = new Map<string, typeof quotaEvents>();
    for (const q of quotaEvents) {
      if (!derivedIds.has(q.sid)) continue; // defensive: session dropped as too-short
      const arr = bySession.get(q.sid) ?? [];
      arr.push(q);
      bySession.set(q.sid, arr);
    }
    for (const [sid, evs] of bySession) {
      deleteEvents.run({ $session_id: sid });
      for (const q of evs) {
        insertEvent.run({
          $session_id: sid,
          $at: new Date(q.ts).toISOString(),
          $kind: classifyQuotaKind(q.text),
          $raw_text: q.text,
          $reset_hint: extractResetHint(q.text),
        });
      }
    }
  });

  runAll();

  // A dispatched job writes a placeholder sessions row at launch (synthetic
  // session_id, task_id set) because the agent has no transcript yet. Once the
  // real transcript is ingested above, two rows describe the same run and every
  // token and duration stat double-counts. Fold the placeholder into the real
  // row -- matched on cwd, which is the job's own worktree and so unique per
  // job -- carrying over the queue-side fields only the dispatcher knew, then
  // repoint the job at the real session_id.
  const selectPlaceholders = db.prepare(`
    SELECT session_id, task_id, task_source, cwd, queued_at
    FROM sessions
    WHERE task_id IS NOT NULL AND cwd IS NOT NULL
  `);
  const selectReal = db.prepare(`
    SELECT session_id FROM sessions
    WHERE cwd = $cwd AND task_id IS NULL
    ORDER BY started_at DESC
    LIMIT 1
  `);
  const adoptReal = db.prepare(`
    UPDATE sessions SET task_id = $task_id, task_source = $task_source, queued_at = $queued_at
    WHERE session_id = $real
  `);
  const repointJob = db.prepare(`UPDATE jobs SET session_id = $real WHERE session_id = $placeholder`);
  const dropPlaceholder = db.prepare(`DELETE FROM sessions WHERE session_id = $placeholder`);

  let folded = 0;
  const foldPlaceholders = db.transaction(() => {
    for (const p of selectPlaceholders.all() as {
      session_id: string;
      task_id: string;
      task_source: string | null;
      cwd: string;
      queued_at: string | null;
    }[]) {
      const real = selectReal.get({ $cwd: p.cwd }) as { session_id: string } | null;
      if (!real) continue; // agent hasn't produced a transcript yet; leave the placeholder
      adoptReal.run({
        $task_id: p.task_id,
        $task_source: p.task_source,
        $queued_at: p.queued_at,
        $real: real.session_id,
      });
      repointJob.run({ $real: real.session_id, $placeholder: p.session_id });
      dropPlaceholder.run({ $placeholder: p.session_id });
      folded++;
    }
  });
  foldPlaceholders();

  console.log(`mk-fleet backfill: db=${dbPath}`);
  console.log(`sessions upserted: ${derived.size}`);
  console.log(`retry_of assigned: ${retryOf.size}`);
  console.log(`dispatch placeholders folded into real sessions: ${folded}`);
}

await main();
db.close();
