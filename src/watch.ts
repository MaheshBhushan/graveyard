// `gm watch`: a live terminal view of the fleet -- one row per job, the ferb
// Phase 0 verdict beside each one as soon as the agent commits to it, and a log
// pane for whichever job is selected.
//
// Same split as render.ts: everything above the "---- live loop" divider is
// pure (data in, string out, `now` passed in) and asserted in bun test. Only
// the loop below reads the clock, the database, the filesystem, or the keyboard.

import type { Database } from "bun:sqlite";
import { reconcileOnly } from "./dispatch.ts";
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
  /** first visible job row. */
  rowOffset: number;
  /** how many job rows fit on screen. */
  rowViewport: number;
  /** the whole tail that was read, unsliced -- the pane does the windowing. */
  logTail: string;
  /** first visible log line, or null to stick to the bottom as it grows. */
  logOffset: number | null;
  /** how many log lines fit on screen. */
  logViewport: number;
  /** what `logTail` was read from, shown in the pane title. */
  logSource: string;
  wip: number;
  paused: boolean;
}

// ---- scrolling --------------------------------------------------------------
//
// The alternate screen has no scrollback, so anything taller than the terminal
// is unreachable unless the view scrolls it itself. Both the job list and the
// log pane are windows onto a longer list, and each carries a gutter showing
// where in that list the window sits.

export function clampScroll(offset: number, total: number, viewport: number): number {
  return Math.max(0, Math.min(offset, Math.max(0, total - viewport)));
}

/** Smallest scroll that keeps `selected` on screen -- j past the bottom edge
 *  should scroll by one, not jump the window. */
export function followSelection(selected: number, offset: number, viewport: number): number {
  if (selected < offset) return selected;
  if (selected >= offset + viewport) return selected - viewport + 1;
  return offset;
}

const GUTTER = 2; // one space + one glyph

// One glyph per visible row: a proportional thumb over a track. All spaces when
// everything fits, so the gutter costs the same width either way and the layout
// does not jump the moment a job is added.
export function scrollbar(
  total: number,
  offset: number,
  viewport: number,
  theme: Theme,
): string[] {
  if (viewport <= 0) return [];
  if (total <= viewport) return Array(viewport).fill(" ");

  const track = theme.unicode ? "│" : "|";
  const thumb = theme.unicode ? "█" : "#";

  const size = Math.max(1, Math.round((viewport * viewport) / total));
  const span = viewport - size;
  const scrolled = total - viewport;
  const top = scrolled <= 0 ? 0 : Math.round((offset / scrolled) * span);

  return Array.from({ length: viewport }, (_, i) =>
    i >= top && i < top + size ? ink(thumb, "accent", theme) : ink(track, "dim", theme),
  );
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

  // Column widths come from every job, not just the visible ones, so the
  // layout does not shift under you as the window scrolls.
  const repoCol = model.jobs.map(repoIssue);
  const elapsedCol = model.jobs.map((j) => elapsed(j, now));
  const repoW = Math.max(0, ...repoCol.map(cells));
  const elapsedW = Math.max(0, ...elapsedCol.map(cells));

  const viewport = Math.max(1, Math.min(model.rowViewport, model.jobs.length));
  const offset = clampScroll(model.rowOffset, model.jobs.length, viewport);
  // No gutter here on purpose: the list is navigated with the arrow keys and
  // the window follows the selection, so a bar would only cost width. The log
  // pane is the one you actually scroll through, and it keeps its bar.
  const more = model.jobs.length - (offset + viewport);

  // Everything the title has to share the line with, counted exactly:
  //   caret(1) sp(1) glyph(1) sp(1) repo(repoW) gap(2) <title> gap(2)
  //   badge(VERDICT_COL) gap(2) elapsed(elapsedW)
  const fixed = 10 + repoW + VERDICT_COL + elapsedW;
  const titleBudget = theme.width - fixed;
  // Below this the title column is not worth the space it costs. Dropping it
  // (rather than flooring the budget) is what keeps a narrow terminal from
  // rendering rows wider than itself -- the verdict is the thing worth keeping.
  const compact = titleBudget < 8;

  const lines = model.jobs.slice(offset, offset + viewport).map((j, vi) => {
    const i = offset + vi;
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
  });

  // Without a bar, say plainly that the list continues -- otherwise a queue
  // taller than the window looks like the whole fleet.
  if (more > 0) {
    const note = `   ${theme.unicode ? "…" : "..."} ${more} more (${theme.unicode ? "↓" : "j"} to reach)`;
    lines.push(ink(truncate(note, theme.width, theme), "dim", theme));
  }
  return lines.join("\n");
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
  const viewport = Math.max(1, model.logViewport);
  const all = model.logTail.split("\n");
  // Drop the trailing empty line a file's final newline produces, or the pane
  // reports one more line than it has and never quite reaches the bottom.
  if (all.length > 1 && all[all.length - 1] === "") all.pop();
  const total = all.length;

  // null means stick to the bottom: a log being written to should keep showing
  // its newest line until the reader deliberately scrolls away from it.
  const following = model.logOffset === null;
  const offset = following
    ? Math.max(0, total - viewport)
    : clampScroll(model.logOffset!, total, viewport);

  const posn =
    total <= viewport
      ? ""
      : ` ${offset + 1}-${Math.min(total, offset + viewport)}/${total}${following ? "" : " ⤒"}`;
  const label = `${model.logSource}${theme.unicode ? posn : posn.replace(" ⤒", " ^")}`;
  const rule = (theme.unicode ? "─" : "-").repeat(Math.max(0, theme.width - cells(label) - 4));
  const head = ` ${ink(label, "dim", theme)} ${ink(rule, "dim", theme)}`;

  if (model.logTail.trim() === "") {
    return [head, ink("   (no output yet)", "dim", theme)].join("\n");
  }

  const bar = scrollbar(total, offset, viewport, theme);
  const room = Math.max(10, theme.width - 4 - GUTTER);
  const body = all
    .slice(offset, offset + viewport)
    .map((l, i) => `   ${pad(truncate(l, room, theme), room)} ${bar[i] ?? " "}`);
  return [head, ...body].join("\n");
}

// ---- whole screen -----------------------------------------------------------

// Drop hints from the right as the terminal narrows rather than wrapping the
// line, which would push the pane above it off the top of the screen.
export function hints(theme: Theme): string {
  const parts = [
    `${theme.unicode ? "↑↓" : "jk"} select`,
    `${theme.unicode ? "wheel" : "PgUp/PgDn"} scroll`,
    "g/G top/end",
    "l log/record",
    "space pause",
    "q quit",
  ];
  while (parts.length > 1 && cells(` ${parts.join("   ")}`) > theme.width) parts.pop();
  return ` ${parts.join("   ")}`;
}

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
    ink(hints(theme), "dim", theme),
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
  let rowOffset = 0;
  let logOffset: number | null = null; // null = stuck to the bottom

  const out = process.stdout;
  const raw = process.stdin.isTTY === true;
  if (raw) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
  }
  // Alternate screen, hide cursor, and report wheel events in SGR form. The
  // alternate screen is what costs us the terminal's own scrollback, so the
  // wheel has to be handled here instead.
  out.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h");

  const restore = () => {
    out.write("\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l");
    if (raw) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
  };

  let jobCount = 0;
  let rowViewport = 8;
  let logViewport = 8;
  // First screen line of the log pane, so the wheel can scroll whichever pane
  // the pointer is actually over.
  let logTop = 0;

  let logLineCount = 0;

  const scrollLog = (delta: number) => {
    // Leaving the bottom is what turns following off; G turns it back on.
    logOffset = Math.max(0, (logOffset ?? Math.max(0, logLineCount - logViewport)) + delta);
  };

  let dirty = false;

  // Raw mode disables line discipline, so Ctrl-C arrives as a byte rather than
  // SIGINT and has to be handled here or the view cannot be left.
  const onKey = (key: string) => {
    dirty = true;
    // Wheel events arrive as SGR mouse reports, possibly several per chunk;
    // buttons 64 and 65 are wheel up and wheel down.
    const wheel = [...key.matchAll(/\x1b\[<(\d+);(\d+);(\d+)[Mm]/g)];
    if (wheel.length > 0) {
      for (const m of wheel) {
        const button = Number(m[1]);
        const y = Number(m[3]);
        if (button !== 64 && button !== 65) continue;
        const dir = button === 64 ? -1 : 1;
        if (y > logTop) scrollLog(dir * 3);
        else selected = Math.max(0, Math.min(selected + dir, Math.max(0, jobCount - 1)));
      }
      return;
    }

    if (key === "q" || key === "\x03" || key === "\x1b") stop = true;
    else if (key === "j" || key === "\x1b[B") selected = Math.min(selected + 1, Math.max(0, jobCount - 1));
    else if (key === "k" || key === "\x1b[A") selected = Math.max(selected - 1, 0);
    else if (key === "\x1b[6~" || key === "\x06") scrollLog(logViewport);
    else if (key === "\x1b[5~" || key === "\x02") scrollLog(-logViewport);
    else if (key === "g" || key === "\x1b[H") logOffset = 0;
    else if (key === "G" || key === "\x1b[F") logOffset = null;
    else if (key === "l") {
      showRecord = !showRecord;
      logOffset = null; // a different file entirely; start at its end
    } else if (key === " ") paused = !paused;
  };
  if (raw) process.stdin.on("data", onKey);

  try {
    while (!stop) {
      // Bring the database in line with reality before reading it. Without
      // this, a job whose agent exited stays "running" on screen until the
      // next dispatch happens to run -- which, with no supervisor up, is
      // never. Silent: reconcile's progress lines would corrupt the screen.
      try {
        await reconcileOnly(db);
      } catch {
        // A reconcile failure is not worth tearing the view down for; the
        // next tick tries again and the rows are still readable meanwhile.
      }

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
      const tail = readTail(logPath);
      logLineCount = tail.split("\n").length;

      // Re-read the terminal every frame so a resize is picked up rather than
      // corrupting the layout until restart.
      const theme = { ...opts.theme, width: out.columns ?? opts.theme.width };
      const height = out.rows ?? opts.height;

      // Split the leftover height between the two scrollable panes. The verdict
      // pane is measured rather than guessed because it wraps to the width.
      const verdictH = sel ? renderVerdictPane(sel, theme).split("\n").length : 0;
      const chrome = 3 /* box */ + 2 /* blanks */ + verdictH + 1 /* blank */ + 1 /* log head */ + 2;
      const free = Math.max(6, height - chrome);
      // -1 leaves room for the "… N more" line the row pane may append.
      rowViewport = Math.max(3, Math.min(jobs.length || 1, Math.floor(free * 0.55) - 1));
      logViewport = Math.max(3, free - rowViewport);

      rowOffset = followSelection(selected, clampScroll(rowOffset, jobs.length, rowViewport), rowViewport);
      if (logOffset !== null) logOffset = clampScroll(logOffset, logLineCount, logViewport);

      const model: WatchModel = {
        jobs,
        selected,
        rowOffset,
        rowViewport,
        logTail: tail,
        logOffset,
        logViewport,
        logSource: sel ? `${sel.job_id}/${logName}` : "(no job selected)",
        wip: opts.wip,
        paused,
      };

      const screen = renderWatch(model, Date.now(), theme);
      // Where the log pane starts, for the wheel's hit test on the next event.
      logTop = screen.split("\n").findIndex((l) => l.includes(model.logSource)) + 1;

      // Home + clear-to-end rather than a full clear: no flicker between frames.
      out.write(`\x1b[H\x1b[J${screen}`);

      // Sleep in slices so a keypress or wheel tick redraws now rather than at
      // the next poll -- at a 1s interval, waiting out the frame makes
      // scrolling feel broken.
      dirty = false;
      const until = paused ? 120 : opts.intervalMs;
      for (let waited = 0; waited < until && !dirty && !stop; waited += 25) {
        await Bun.sleep(25);
      }
    }
  } finally {
    if (raw) process.stdin.off("data", onKey);
    restore();
  }
}
