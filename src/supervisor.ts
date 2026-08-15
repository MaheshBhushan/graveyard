// `gm start` -- the piece that turns a queue into a pipeline.
//
// `dispatch` was always one-shot: reconcile, fill the free slots, exit. That
// makes the queue drain only as often as something calls it, which in practice
// meant calling it by hand after every single job. The supervisor is the loop
// that was missing: it keeps ticking until stopped, so a job finishing frees a
// slot that the next tick fills on its own.
//
// It runs detached, writes a pidfile, and logs to a file, so `gm start` returns
// immediately and `gm watch` is what you look at afterwards.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { dispatchOnce, resolveFleetFlags } from "./dispatch.ts";
import { countByState } from "./queue.ts";

const FLEET_HOME = join(homedir(), ".local", "share", "mk-fleet");
export const PID_PATH = join(FLEET_HOME, "graveyard.pid");
export const SUPERVISOR_LOG = join(FLEET_HOME, "supervisor.log");

const DEFAULT_TICK_MS = 30_000;

export interface PidFile {
  pid: number;
  started_at: string;
  db: string;
  wip: number;
}

export function readPid(): PidFile | null {
  if (!existsSync(PID_PATH)) return null;
  try {
    return JSON.parse(readFileSync(PID_PATH, "utf8")) as PidFile;
  } catch {
    return null;
  }
}

/** A pidfile outlives a crash, so its mere existence proves nothing. Signal 0
 *  checks for a live process without touching it. */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The live supervisor, or null -- clearing a pidfile left behind by a crash
 *  rather than refusing to start because of it. */
export function activeSupervisor(): PidFile | null {
  const rec = readPid();
  if (!rec) return null;
  if (isRunning(rec.pid)) return rec;
  rmSync(PID_PATH, { force: true });
  return null;
}

// ---- the loop ---------------------------------------------------------------

export interface SuperviseOpts {
  dbPath: string;
  wip: number;
  maxJobs: number;
  live: boolean;
  tickMs: number;
  repoFilter?: string | null;
}

/** Runs until killed. Each tick is a full dispatch pass, so a job that ends
 *  between ticks is reconciled and its slot refilled without anyone asking. */
export async function supervise(opts: SuperviseOpts): Promise<void> {
  const db = new Database(opts.dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(readFileSync(join(import.meta.dir, "..", "schema.sql"), "utf8"));

  let stop = false;
  const bye = () => {
    stop = true;
  };
  process.on("SIGTERM", bye);
  process.on("SIGINT", bye);

  const stamp = () => new Date().toISOString();
  const say = (s: string) => console.error(`${stamp()} ${s}`);

  say(`supervisor up: wip=${opts.wip} max-jobs=${opts.maxJobs} tick=${opts.tickMs}ms live=${opts.live}`);

  let idle = false;
  while (!stop) {
    try {
      // Buffer the pass's diagnostics and only commit them if the pass did
      // something. A supervisor idling overnight at one tick every 30s would
      // otherwise write thousands of identical "0 queued candidates" lines and
      // bury the tick that actually mattered.
      const buffered: string[] = [];
      const res = await dispatchOnce(db, {
        wip: opts.wip,
        maxJobs: opts.maxJobs,
        live: opts.live,
        repoFilter: opts.repoFilter ?? null,
        say: (s) => buffered.push(s),
      });

      const quiet = res.launched === 0 && res.alive === 0 && res.queued === 0;
      if (!quiet) {
        idle = false;
        for (const line of buffered) say(line);
      } else if (!idle) {
        // Idle is a normal state, not an end state: `gm add` during an idle
        // stretch is picked up on the next tick, no restart needed. Say so
        // once, on the transition.
        idle = true;
        say("queue drained; idling (add more with `gm add`, stop with `gm stop`)");
      }
    } catch (e) {
      // One bad tick must not take the fleet down -- the next tick reconciles
      // whatever this one left half-done.
      say(`tick failed, continuing: ${e instanceof Error ? e.message : String(e)}`);
    }

    for (let waited = 0; waited < opts.tickMs && !stop; waited += 250) {
      await Bun.sleep(250);
    }
  }

  say("supervisor down");
  db.close();
  rmSync(PID_PATH, { force: true });
}

// ---- start / stop -----------------------------------------------------------

export interface StartOpts {
  dbPath: string;
  live: boolean;
  tickMs?: number;
  foreground: boolean;
  repoFilter?: string | null;
}

export async function runStart(opts: StartOpts): Promise<number> {
  const existing = activeSupervisor();
  if (existing) {
    console.error(`already running (pid ${existing.pid}, since ${existing.started_at})`);
    console.error("`gm watch` to see it, `gm stop` to stop it");
    return 1;
  }

  const flags = resolveFleetFlags(opts.live);
  if (!flags) return 1;
  // --max-jobs caps launches per invocation, which exists so a stray one-shot
  // `dispatch` cannot start a whole fleet at once. A supervisor ticking on its
  // own does not need that brake: without this it would leave WIP slots empty
  // for a whole tick each.
  if (!process.argv.includes("--max-jobs")) flags.maxJobs = flags.wip;

  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  mkdirSync(dirname(PID_PATH), { recursive: true });

  if (opts.foreground) {
    writeFileSync(
      PID_PATH,
      JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), db: opts.dbPath, wip: flags.wip }),
    );
    await supervise({ dbPath: opts.dbPath, ...flags, live: opts.live, tickMs, repoFilter: opts.repoFilter });
    return 0;
  }

  // Detach: the child outlives this shell, so `gm start` can return. Its
  // output goes to an append-mode fd because nobody is watching this terminal
  // -- a pipe would fill and block the supervisor once nothing drained it.
  const logFd = openSync(SUPERVISOR_LOG, "a");
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      join(import.meta.dir, "cli.ts"),
      "__supervise",
      "--db",
      opts.dbPath,
      "--wip",
      String(flags.wip),
      "--max-jobs",
      String(flags.maxJobs),
      "--tick",
      String(Math.round(tickMs / 1000)),
      ...(opts.live ? ["--live"] : []),
      ...(opts.repoFilter ? ["--repo", opts.repoFilter] : []),
    ],
    { stdin: "ignore", stdout: logFd, stderr: logFd, env: process.env },
  );
  child.unref();

  writeFileSync(
    PID_PATH,
    JSON.stringify({ pid: child.pid, started_at: new Date().toISOString(), db: opts.dbPath, wip: flags.wip }),
  );

  const counts = countByState(new Database(opts.dbPath, { create: true }));
  const queued = counts.queued ?? 0;
  console.log(`graveyard started (pid ${child.pid}), wip ${flags.wip}, tick ${Math.round(tickMs / 1000)}s`);
  console.log(
    opts.live
      ? `  ${queued} issue${queued === 1 ? "" : "s"} queued -- it will work through them and keep going`
      : `  ${queued} queued, but NOT live: launching no-ops. use \`gm start --live\` to spend tokens`,
  );
  console.log(`  gm watch    the dashboard`);
  console.log(`  gm stop     stop it`);
  console.log(`  log: ${SUPERVISOR_LOG}`);
  return 0;
}

export function runStop(): number {
  const rec = activeSupervisor();
  if (!rec) {
    console.error("not running");
    return 1;
  }
  try {
    // SIGTERM, not SIGKILL: the loop finishes its tick and removes the pidfile.
    // Agents already launched keep running in their own tmux sessions -- they
    // are not children of the supervisor, and killing work mid-flight would
    // waste tokens already spent.
    process.kill(rec.pid, "SIGTERM");
  } catch (e) {
    console.error(`could not signal pid ${rec.pid}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  console.log(`stopping graveyard (pid ${rec.pid})`);
  console.log("agents already launched keep running; `gm watch` still shows them");
  return 0;
}
