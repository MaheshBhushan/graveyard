// `gm watch`: a live terminal view of the fleet -- one row per job, the ferb
// Phase 0 verdict beside each one as soon as the agent commits to it, and a log
// pane for whichever job is selected.
//
// Same split as render.ts: everything above the "---- live loop" divider is
// pure (data in, string out, `now` passed in) and asserted in bun test. Only
// the loop below reads the clock, the database, the filesystem, or the keyboard.

import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  cells,
  fmtDuration,
  ink,
  type JobRow,
  pad,
  renderFleetBox,
  repoIssue,
  stateGlyph,
  type Style,
  truncate,
} from "./render.ts";
import type { Theme } from "./theme.ts";

// ---- phase 0 verdicts -------------------------------------------------------

export type VerdictKind = "GO" | "NO-GO" | "ASK";

export interface Phase0Verdict {
  kind: VerdictKind;
  reason: string | null;
  blockers: string | null;
  effort: string | null;
  confidence: string | null;
}

const VERDICT_LINE = /^\s*(?:\*\*)?Verdict(?:\*\*)?\s*:\s*(?:\*\*)?\s*(GO|NO-GO|NOGO|ASK)\b/im;

// A field value continues onto following lines when they are indented and do
// not open a new `Label:` of their own -- ferb wraps long Reason values that
// way, and reading only the first line truncated them mid-sentence.
const NEW_FIELD = /^\s*(?:[-*]\s*)?(?:\*\*)?[A-Za-z][A-Za-z. ]{0,30}(?:\*\*)?\s*:/;

function field(text: string, label: string): string | null {
  // Tolerant of the markdown the agent tends to add around ferb's plain format
  // (bold labels, a fenced block, a leading list marker).
  const re = new RegExp(`^\\s*(?:[-*]\\s*)?(?:\\*\\*)?${label}(?:\\*\\*)?\\s*:\\s*(.*)$`, "im");
  const m = text.match(re);
  if (!m) return null;

  const lines = text.slice(m.index! + m[0].length).split("\n").slice(1);
  const parts = [m[1]];
  for (const line of lines) {
    if (!/^\s+\S/.test(line) || NEW_FIELD.test(line)) break;
    parts.push(line);
  }

  const v = parts.join(" ").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  return v === "" ? null : v;
}

// Parse a ferb Phase 0 block out of arbitrary surrounding prose. Returns null
// when there is no verdict yet -- an empty or half-written file is the normal
// case while an agent is still in Phase 0, not an error.
export function parseVerdict(text: string): Phase0Verdict | null {
  const m = text.match(VERDICT_LINE);
  if (!m) return null;
  const raw = m[1].toUpperCase();
  const kind: VerdictKind = raw === "GO" ? "GO" : raw === "ASK" ? "ASK" : "NO-GO";
  return {
    kind,
    reason: field(text, "Reason"),
    blockers: field(text, "Blockers"),
    effort: field(text, "Est\\. effort"),
    confidence: field(text, "Confidence[^:]*"),
  };
}

const VERDICT_STYLE: Record<VerdictKind, Style> = { GO: "ok", "NO-GO": "warn", ASK: "accent" };

export function verdictBadge(v: Phase0Verdict | null, theme: Theme): string {
  if (!v) return ink(theme.unicode ? "·" : "-", "dim", theme);
  return ink(v.kind, VERDICT_STYLE[v.kind], theme);
}

// ---- the model the view renders ---------------------------------------------

export interface WatchJob extends JobRow {
  verdict: Phase0Verdict | null;
  /** true while a tmux session for this job is alive. */
  alive: boolean;
}

export interface WatchModel {
  jobs: readonly WatchJob[];
  /** index into `jobs`, clamped by the caller. */
  selected: number;
  /** tail of the selected job's agent.log, already trimmed to the pane. */
  logTail: string;
  /** what `logTail` was read from, shown in the pane title. */
  logSource: string;
  wip: number;
  paused: boolean;
}

// ---- rows -------------------------------------------------------------------

const VERDICT_COL = 5; // "NO-GO"

function elapsed(job: WatchJob, now: number): string {
  const start = job.started_at ? Date.parse(job.started_at) : NaN;
  if (Number.isNaN(start)) return "";
  const end = job.ended_at ? Date.parse(job.ended_at) : now;
  return fmtDuration((Number.isNaN(end) ? now : end) - start);
}

// One row per job: selection caret, state glyph, repo#issue, title, Phase 0
// verdict, elapsed. Unlike render.ts's dashboard this keeps terminal-state jobs
// as rows rather than rolling them into a footer -- in a live view the whole
// point is watching a job cross from running into done.
export function renderWatchRows(model: WatchModel, now: number, theme: Theme): string {
  if (model.jobs.length === 0) return ink(" (no jobs -- queue some with `gm add`)", "dim", theme);

  const repoCol = model.jobs.map(repoIssue);
  const elapsedCol = model.jobs.map((j) => elapsed(j, now));
  const repoW = Math.max(0, ...repoCol.map(cells));
  const elapsedW = Math.max(0, ...elapsedCol.map(cells));

  // Everything the title has to share the line with, counted exactly:
  //   caret(1) sp(1) glyph(1) sp(1) repo(repoW) gap(2) <title> gap(2)
  //   badge(VERDICT_COL) gap(2) elapsed(elapsedW)
  const fixed = 10 + repoW + VERDICT_COL + elapsedW;
  const titleBudget = theme.width - fixed;
  // Below this the title column is not worth the space it costs. Dropping it
  // (rather than flooring the budget) is what keeps a narrow terminal from
  // rendering rows wider than itself -- the verdict is the thing worth keeping.
  const compact = titleBudget < 8;

  return model.jobs
    .map((j, i) => {
      const caret = i === model.selected ? ink(theme.unicode ? "❯" : ">", "accent", theme) : " ";
      const glyph = stateGlyph(j.alive && j.state === "running" ? "running" : j.state, theme);
      const badge = verdictBadge(j.verdict, theme);

      if (compact) {
        // Truncate the repo label unpainted, then pad: slicing a painted string
        // can cut its reset off and bleed colour down the page.
        const room = Math.max(3, theme.width - 2 - 1 - 1 - 2 - VERDICT_COL);
        const repo = truncate(repoCol[i]!, room, theme);
        return `${caret} ${glyph} ${repo}  ${pad(badge, VERDICT_COL)}`.trimEnd();
      }

      const repo = pad(repoCol[i]!, repoW);
      const rawTitle = j.title?.trim() || j.state;
      const title = pad(
        ink(truncate(rawTitle, titleBudget, theme), i === model.selected ? "bold" : "dim", theme),
        titleBudget,
      );
      return `${caret} ${glyph} ${repo}  ${title}  ${pad(badge, VERDICT_COL)}  ${pad(elapsedCol[i]!, elapsedW, "right")}`.trimEnd();
    })
    .join("\n");
}

// ---- verdict pane -----------------------------------------------------------

function wrap(s: string, width: number): string[] {
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    if (line === "") line = w;
    else if (cells(line) + 1 + cells(w) <= width) line += ` ${w}`;
    else {
      out.push(line);
      line = w;
    }
  }
  if (line) out.push(line);
  return out;
}

// The selected job's Phase 0 verdict, spelled out. This is the thing worth
// reading per job: whether ferb decided to act, and on what grounds.
export function renderVerdictPane(job: WatchJob | undefined, theme: Theme): string {
  if (!job) return "";
  const width = Math.max(20, Math.min(theme.width, 100));
  const inner = width - 4;

  if (!job.verdict) {
    const msg = job.state === "queued" ? "not started" : "phase 0 in progress…";
    return ink(` ${theme.unicode ? "│" : "|"} ${msg}`, "dim", theme);
  }

  const v = job.verdict;
  const rows: [string, string | null][] = [
    ["verdict", v.kind],
    ["reason", v.reason],
    ["blockers", v.blockers],
    ["effort", v.effort],
    ["confidence", v.confidence],
  ];
  const labelW = Math.max(...rows.map(([k]) => cells(k)));
  const bar = theme.unicode ? "│" : "|";

  const lines: string[] = [];
  for (const [k, val] of rows) {
    if (val == null) continue;
    const painted = k === "verdict" ? ink(val, VERDICT_STYLE[v.kind], theme) : val;
    const body = k === "verdict" ? [painted] : wrap(val, Math.max(10, inner - labelW - 2));
    body.forEach((seg, i) => {
      const label = i === 0 ? pad(ink(k, "dim", theme), labelW) : pad("", labelW);
      lines.push(` ${ink(bar, "dim", theme)} ${label}  ${seg}`);
    });
  }
  return lines.join("\n");
}

// ---- log pane ---------------------------------------------------------------

export function renderLogPane(model: WatchModel, theme: Theme): string {
  const rule = (theme.unicode ? "─" : "-").repeat(Math.max(0, theme.width - cells(model.logSource) - 4));
  const head = ` ${ink(model.logSource, "dim", theme)} ${ink(rule, "dim", theme)}`;
  if (model.logTail.trim() === "") {
    return [head, ink("   (no output yet)", "dim", theme)].join("\n");
  }
  const body = model.logTail
    .split("\n")
    .map((l) => `   ${truncate(l, Math.max(10, theme.width - 4), theme)}`)
    .join("\n");
  return [head, body].join("\n");
}

// ---- whole screen -----------------------------------------------------------

export function renderWatch(model: WatchModel, now: number, theme: Theme): string {
  const counts: Record<string, number> = {};
  for (const j of model.jobs) counts[j.state] = (counts[j.state] ?? 0) + 1;
  const running = model.jobs.filter((j) => j.alive).length;

  const gos = model.jobs.filter((j) => j.verdict?.kind === "GO").length;
  const nogos = model.jobs.filter((j) => j.verdict?.kind === "NO-GO").length;

  const header =
    `  wip ${running}/${model.wip}   queued ${counts.queued ?? 0}   done ${counts.done ?? 0}` +
    `   go ${gos}   no-go ${nogos}${model.paused ? "   PAUSED" : ""}`;

  const sel = model.jobs[model.selected];
  const parts = [
    renderFleetBox(header, theme, "graveyard"),
    "",
    renderWatchRows(model, now, theme),
    "",
    renderVerdictPane(sel, theme),
    "",
    renderLogPane(model, theme),
    "",
    ink(
      ` ${theme.unicode ? "↑↓" : "jk"} select   l log/record   space pause   r refresh   q quit`,
      "dim",
      theme,
    ),
  ];
  return parts.filter((p) => p !== "").join("\n");
}

// ---- live loop --------------------------------------------------------------

const FLEET_HOME = join(homedir(), ".local", "share", "mk-fleet");
const RUNS_ROOT = join(FLEET_HOME, "runs");
const TAIL_BYTES = 8_000;

function readTail(path: string, bytes = TAIL_BYTES): string {
  if (!existsSync(path)) return "";
  const size = statSync(path).size;
  const buf = readFileSync(path);
  return buf.subarray(Math.max(0, size - bytes)).toString("utf8");
}

function loadVerdict(jobId: string): Phase0Verdict | null {
  // phase0.md is written the moment Phase 0 decides. The run record is the
  // fallback for jobs dispatched before that addendum existed, and for agents
  // that skipped the file but still put the block in their report.
  for (const name of ["phase0.md", "pr-draft.md"]) {
    const p = join(RUNS_ROOT, jobId, name);
    if (!existsSync(p)) continue;
    const v = parseVerdict(readFileSync(p, "utf8"));
    if (v) return v;
  }
  return null;
}

async function aliveSessions(): Promise<Set<string>> {
  const proc = Bun.spawn(["tmux", "ls", "-F", "#{session_name}"], { stdout: "pipe", stderr: "pipe" });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return new Set(
    out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("mkfleet-")),
  );
}

export interface WatchOptions {
  wip: number;
  intervalMs: number;
  theme: Theme;
  /** Terminal rows. Theme owns width only, so height is passed separately. */
  height: number;
}

export async function runWatch(db: Database, opts: WatchOptions): Promise<void> {
  const query = db.query(`
    SELECT job_id, repo, issue_number, title, state, priority, queued_at,
           started_at, ended_at, resume_after, last_error, tmux_session
    FROM jobs
    ORDER BY CASE state WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
             priority DESC, job_id
  `);

  let selected = 0;
  let paused = false;
  let showRecord = false;
  let stop = false;

  const out = process.stdout;
  const raw = process.stdin.isTTY === true;
  if (raw) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
  }
  out.write("\x1b[?1049h\x1b[?25l"); // alternate screen, hide cursor

  const restore = () => {
    out.write("\x1b[?25h\x1b[?1049l"); // show cursor, leave alternate screen
    if (raw) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
  };

  let jobCount = 0;
  // Raw mode disables line discipline, so Ctrl-C arrives as a byte rather than
  // SIGINT and has to be handled here or the view cannot be left.
  const onKey = (key: string) => {
    if (key === "q" || key === "\x03" || key === "\x1b") stop = true;
    else if (key === "j" || key === "\x1b[B") selected = Math.min(selected + 1, Math.max(0, jobCount - 1));
    else if (key === "k" || key === "\x1b[A") selected = Math.max(selected - 1, 0);
    else if (key === "l") showRecord = !showRecord;
    else if (key === " ") paused = !paused;
  };
  if (raw) process.stdin.on("data", onKey);

  try {
    while (!stop) {
      const rows = query.all() as (JobRow & { tmux_session: string | null })[];
      jobCount = rows.length;
      selected = Math.min(selected, Math.max(0, rows.length - 1));

      const live = await aliveSessions();
      const jobs: WatchJob[] = rows.map((r) => ({
        ...r,
        verdict: loadVerdict(r.job_id),
        alive: r.tmux_session != null && live.has(r.tmux_session),
      }));

      const sel = jobs[selected];
      const logName = showRecord ? "pr-draft.md" : "agent.log";
      const logPath = sel ? join(RUNS_ROOT, sel.job_id, logName) : "";
      // Leave room for the header box, rows, verdict pane and key hints.
      const paneLines = Math.max(3, opts.height - jobs.length - 16);
      const tail = readTail(logPath).split("\n").slice(-paneLines).join("\n");

      const model: WatchModel = {
        jobs,
        selected,
        logTail: tail,
        logSource: sel ? `${sel.job_id}/${logName}` : "(no job selected)",
        wip: opts.wip,
        paused,
      };

      // Home + clear-to-end rather than a full clear: no flicker between frames.
      out.write(`\x1b[H\x1b[J${renderWatch(model, Date.now(), opts.theme)}`);

      if (!paused) await Bun.sleep(opts.intervalMs);
      else await Bun.sleep(120);
    }
  } finally {
    if (raw) process.stdin.off("data", onKey);
    restore();
  }
}
