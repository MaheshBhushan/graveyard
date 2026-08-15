// The render layer for mk-fleet's CLI: data in, string out. Nothing here
// prints, touches a Database, or reads the clock -- callers (cli.ts,
// dispatch.ts) do the I/O and pass `now` in, which is what makes every
// function here assertable in `bun test` against an exact string.

import type { Theme } from "./theme.ts";

// ---- ANSI -------------------------------------------------------------------

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const RESET = "\x1b[0m";

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

// One accent, plus a status scale. Six colours means none of them signals.
const STYLES = {
  dim: "2",
  bold: "1",
  accent: "36",
  ok: "32",
  warn: "33",
  err: "31",
} as const;

export type Style = keyof typeof STYLES;

export function ink(s: string, style: Style, theme: Theme): string {
  if (!theme.color || s === "") return s;
  return `\x1b[${STYLES[style]}m${s}${RESET}`;
}

// ---- width (cells, never .length) --------------------------------------------

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

function isWide(cp: number): boolean {
  for (const [lo, hi] of WIDE) if (cp >= lo && cp <= hi) return true;
  return false;
}

// Rendered width in terminal cells. CJK reads as 1 UTF-16 unit but renders as
// 2 cells; a ZWJ emoji family is many units but one wide grapheme. Every
// table misalignment traces back to using .length instead of this.
export function cells(s: string): number {
  let n = 0;
  for (const { segment } of segmenter.segment(stripAnsi(s))) {
    n += isWide(segment.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return n;
}

// Truncate to `max` cells, grapheme-wise, on *unpainted* text -- slicing a
// painted string can cut the trailing reset off and bleed colour down the
// page. Paint the result, don't truncate the paint.
export function truncate(s: string, max: number, theme: Theme): string {
  if (max <= 0) return "";
  if (cells(s) <= max) return s;
  const mark = theme.unicode ? "…" : "...";
  const budget = max - cells(mark);
  if (budget <= 0) return mark.slice(0, max);

  let out = "";
  let n = 0;
  for (const { segment } of segmenter.segment(stripAnsi(s))) {
    const w = isWide(segment.codePointAt(0) ?? 0) ? 2 : 1;
    if (n + w > budget) break;
    out += segment;
    n += w;
  }
  return out + mark;
}

export type Align = "left" | "right";

// Pad to `width` cells. Safe on painted strings -- the spaces land outside
// the reset, where a later trimEnd can still reach them.
export function pad(s: string, width: number, align: Align = "left"): string {
  const fill = " ".repeat(Math.max(0, width - cells(s)));
  return align === "right" ? fill + s : s + fill;
}

// ---- job data (structural -- no import from queue.ts/dispatch.ts, so this
// file stays free of the DB layer) --------------------------------------------

export type RenderJobState = "queued" | "running" | "parked" | "done" | "failed" | "blocked";

export interface JobRow {
  job_id: string;
  repo: string;
  issue_number: number | null;
  title: string | null;
  state: string;
  priority: number;
  queued_at: string;
  started_at: string | null;
  ended_at: string | null;
  resume_after?: string | null;
  last_error?: string | null;
}

// ---- glyph vocabulary ---------------------------------------------------------

const GLYPHS: Record<RenderJobState, { uni: string; ascii: string; style: Style }> = {
  running: { uni: "⏺", ascii: "o", style: "accent" },
  parked: { uni: "⏸", ascii: "=", style: "warn" },
  queued: { uni: "○", ascii: ".", style: "dim" },
  done: { uni: "✔", ascii: "+", style: "ok" },
  failed: { uni: "✗", ascii: "x", style: "err" },
  blocked: { uni: "⊘", ascii: "#", style: "err" },
};

function isRenderState(s: string): s is RenderJobState {
  return Object.prototype.hasOwnProperty.call(GLYPHS, s);
}

export function stateGlyph(state: string, theme: Theme): string {
  const g = isRenderState(state) ? GLYPHS[state] : { uni: "?", ascii: "?", style: "dim" as Style };
  return ink(theme.unicode ? g.uni : g.ascii, g.style, theme);
}

// "Textualize/rich" + 4207 -> "rich#4207". A repo with no slash renders as-is.
export function shortRepo(repo: string): string {
  const i = repo.lastIndexOf("/");
  return i === -1 ? repo : repo.slice(i + 1);
}

export function repoIssue(job: Pick<JobRow, "repo" | "issue_number">): string {
  const base = shortRepo(job.repo);
  return job.issue_number != null ? `${base}#${job.issue_number}` : base;
}

// ---- time -----------------------------------------------------------------

export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, "0")}s` : `${s}s`;
}

export function fmtClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "?";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function elapsedFor(job: JobRow, now: number, theme: Theme): string {
  switch (job.state) {
    case "running": {
      if (!job.started_at) return "";
      const t = Date.parse(job.started_at);
      return Number.isNaN(t) ? "" : fmtDuration(now - t);
    }
    case "parked":
      return theme.unicode ? "—" : "-";
    case "done":
    case "failed": {
      if (!job.started_at || !job.ended_at) return "";
      const a = Date.parse(job.started_at);
      const b = Date.parse(job.ended_at);
      return Number.isNaN(a) || Number.isNaN(b) ? "" : fmtDuration(b - a);
    }
    default:
      return "";
  }
}

// Detail column: the job's title for most states, except parked, where the
// resume time is more actionable than a title, and a missing title, which
// falls back to the bare state word so the row is never empty.
function detailFor(job: JobRow, theme: Theme): string {
  if (job.state === "parked") {
    const resets = job.resume_after ? fmtClock(job.resume_after) : null;
    return resets ? `parked ${theme.unicode ? "·" : "-"} resets ${resets}` : "parked";
  }
  const title = job.title?.trim();
  return title || job.state;
}

// ---- rows ---------------------------------------------------------------------

const ROW_ORDER: Record<string, number> = { running: 0, parked: 1, queued: 2, done: 3, failed: 4, blocked: 5 };

// Render a headerless block of job rows: glyph, compact repo#issue, a
// dimmed detail column, and a right-aligned elapsed time. Columns are
// measured in cells so CJK titles and emoji don't throw off alignment, and
// the detail column shrinks (never wraps) when the terminal is narrow.
export function renderJobRows(jobs: readonly JobRow[], now: number, theme: Theme): string {
  if (jobs.length === 0) return "";

  const sorted = [...jobs].sort((a, b) => (ROW_ORDER[a.state] ?? 9) - (ROW_ORDER[b.state] ?? 9));
  const repoCol = sorted.map((j) => repoIssue(j));
  const elapsedCol = sorted.map((j) => elapsedFor(j, now, theme));

  const repoW = Math.max(0, ...repoCol.map(cells));
  const elapsedW = Math.max(0, ...elapsedCol.map(cells));
  // Fixed cost: leading space + glyph + gap + repo col + gap + (elapsed col + gap).
  const fixed = 1 + 1 + 1 + repoW + 2 + (elapsedW > 0 ? elapsedW + 2 : 0);
  const detailBudget = Math.max(8, theme.width - fixed);

  const lines = sorted.map((j, i) => {
    const g = stateGlyph(j.state, theme);
    const repo = pad(repoCol[i]!, repoW);
    const detail = pad(ink(truncate(detailFor(j, theme), detailBudget, theme), "dim", theme), detailBudget);
    const elapsed = elapsedCol[i]!;
    const parts = [` ${g} ${repo}  ${detail}`];
    if (elapsedW > 0) parts.push(pad(elapsed, elapsedW, "right"));
    return parts.join("  ").trimEnd();
  });

  return lines.join("\n");
}

// ---- fleet box ------------------------------------------------------------

const MIN_BOX_WIDTH = 24;

// Bordered header box. Degrades to a plain, unframed line below MIN_BOX_WIDTH
// or when unicode box-drawing isn't available.
export function renderFleetBox(content: string, theme: Theme, title = "fleet"): string {
  const boxWidth = Math.max(MIN_BOX_WIDTH, Math.min(theme.width, Math.max(cells(content) + 4, 30)));
  const inner = boxWidth - 2;
  // The border is capped at theme.width but the content was not, so a long
  // summary line used to hang off the right-hand edge of its own box.
  content = truncate(content, inner, theme);

  if (theme.width < MIN_BOX_WIDTH) {
    return truncate(content.trim(), theme.width, theme);
  }

  if (theme.unicode) {
    const titleTag = ` ${title} `;
    const top = `╭─${titleTag}${"─".repeat(Math.max(0, inner - cells(titleTag) - 1))}╮`;
    const mid = `│${pad(content, inner)}│`;
    const bottom = `╰${"─".repeat(inner)}╯`;
    return [top, mid, bottom].join("\n");
  }

  const titleTag = ` ${title} `;
  const top = `+-${titleTag}${"-".repeat(Math.max(0, inner - cells(titleTag) - 1))}+`;
  const mid = `|${pad(content, inner)}|`;
  const bottom = `+${"-".repeat(inner)}+`;
  return [top, mid, bottom].join("\n");
}

// ---- footer -----------------------------------------------------------------

// Short tag for a blocked/failed job's reason, e.g. "diff ceiling breached:
// 12 files / 900 lines (max 10 / 500)" -> "diff ceiling breached". Best
// effort: `last_error` is free text, not a coded field.
function reasonTag(lastError: string, theme: Theme): string {
  const head = lastError.split(/[:;]/)[0]?.trim() || lastError.trim();
  return truncate(head, 28, theme);
}

export interface FooterCounts {
  done?: number;
  failed?: number;
  blocked?: number;
}

// Summary line on a tree branch, e.g. " └─ 3 done · 1 blocked (diff ceiling)".
// Terminal states (done/failed/blocked) are rolled up here rather than shown
// as rows -- they're no longer live work needing triage.
export function renderFooter(
  counts: FooterCounts,
  theme: Theme,
  blockedSample: JobRow | null = null,
): string {
  const dot = theme.unicode ? "·" : "*";
  const branch = theme.unicode ? "└─" : "`-";
  const parts: string[] = [];
  if (counts.done) parts.push(`${counts.done} done`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  if (counts.blocked) {
    const tag = blockedSample?.last_error ? ` (${reasonTag(blockedSample.last_error, theme)})` : "";
    parts.push(`${counts.blocked} blocked${tag}`);
  }
  if (parts.length === 0) return "";
  return ` ${branch} ${parts.join(` ${dot} `)}`;
}

// ---- full dashboard ---------------------------------------------------------

export interface DashboardOptions {
  /** Concurrency ceiling, e.g. dispatch's --wip. Omitted for plain `list`. */
  wip?: number;
}

// The mk-fleet dashboard: framed counts, active-job rows, terminal-state
// footer. Used by both `list` (no filter) and `dispatch`'s summary.
export function renderDashboard(jobs: readonly JobRow[], now: number, theme: Theme, opts: DashboardOptions = {}): string {
  const counts: Record<string, number> = {};
  for (const j of jobs) counts[j.state] = (counts[j.state] ?? 0) + 1;

  const running = counts.running ?? 0;
  const parked = counts.parked ?? 0;
  const queued = counts.queued ?? 0;

  const boxContent =
    opts.wip !== undefined
      ? `  wip ${running}/${opts.wip}   parked ${parked}   queued ${queued}`
      : `  running ${running}   parked ${parked}   queued ${queued}`;

  const active = jobs.filter((j) => j.state === "running" || j.state === "parked" || j.state === "queued");
  const blockedSample = jobs.find((j) => j.state === "blocked" && j.last_error) ?? null;

  const lines: string[] = [renderFleetBox(boxContent, theme)];
  lines.push("");
  lines.push(active.length ? renderJobRows(active, now, theme) : " (no active jobs)");

  const footer = renderFooter({ done: counts.done, failed: counts.failed, blocked: counts.blocked }, theme, blockedSample);
  if (footer) {
    lines.push("");
    lines.push(footer);
  }

  return lines.join("\n");
}

// ---- status (key/value) -----------------------------------------------------

// Aligned key/value block for `status`. Keys are chrome: dim them.
export function renderStatus(counts: Record<string, number>, states: readonly string[], theme: Theme): string {
  const total = states.reduce((sum, s) => sum + (counts[s] ?? 0), 0);
  const rows: [string, number][] = [...states.map((s) => [s, counts[s] ?? 0] as [string, number]), ["total", total]];
  const w = Math.max(...rows.map(([k]) => cells(k)));
  return rows
    .map(([k, n], i) =>
      `${pad(ink(k, i === rows.length - 1 ? "bold" : "dim", theme), w)}  ${n}`,
    )
    .join("\n");
}
