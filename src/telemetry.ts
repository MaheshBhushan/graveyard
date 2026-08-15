// mk-fleet telemetry: parse ~/.claude/projects/*/*.jsonl and derive one row
// per session for schema.sql's `sessions` + `rate_limit_events` tables.
//
// Parsing decisions (session grouping, idle/approval/think-gap splitting,
// workload classification, rate-limit event detection, rework/retry
// detection, token accounting) are ported as-is from
// mk-fleet/analysis/gate_analysis.py. Do not "fix" or re-derive them here —
// see that file for the reasoning. Deviations from it are called out inline
// with a comment starting "DEVIATION:".

import { readdirSync, statSync } from "node:fs";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

// ---- methodology constants (ported from gate_analysis.py, converted to ms) --
export const IDLE_GAP_MS = 900_000; // 15 min: gap this long is idle, never service time
export const APPROVAL_GAP_MS = 30_000; // tool_use -> tool_result gap beyond this is human approval latency
export const THINK_GAP_MS = 30_000; // assistant turn -> next human prompt gap beyond this is human thinking
export const BURST_GAP_MS = IDLE_GAP_MS; // bursts are separated by an idle gap
export const REWORK_WINDOW_MS = 3_600_000; // follow-on session within 1h of a bad ending = retry candidate
export const DUP_WINDOW_MS = 86_400_000; // near-duplicate opening prompt within 24h = retry candidate
export const DUP_JACCARD = 0.8; // token-set similarity threshold for "near-duplicate"
export const MIN_SESSION_EVENTS = 2; // need >=2 timestamps to have any span at all

// Real rate-limit/quota prose, ported verbatim from gate_analysis.py's QUOTA_PAT.
// Deliberately excludes generic "rate limit" substring matches: 478 of the
// corpus's ~478 "rate limit" mentions are code/content about rate limiting,
// not an actual stall (see gate_analysis.py's lines_mentioning_rate_limit vs
// quota_events counters). Only isApiErrorMessage lines are tested against this.
// Exported (not just used internally) so src/recover.ts can classify a
// dispatched job's plain-text agent.log against the same prose patterns
// instead of maintaining a second copy of them.
export const QUOTA_PAT =
  /(hit your (session|weekly|monthly|5-hour) limit|monthly spend limit|rate limit|usage credits are required|credit balance is too low|429)/i;
export const OVERLOAD_PAT = /(529|overloaded)/i;

// DEVIATION: gate_analysis.py also extracts RETRY_AFTER_PAT matches from raw
// lines (numeric retry_after=N seconds) for reporting; it found none in this
// corpus ("retry_after values parsed ... none"). Per this subtask's spec
// ("There is no Retry-After in this corpus... do not invent a numeric retry
// field"), that extraction is omitted here rather than ported unused.

export interface Event {
  ts: number; // epoch ms
  role: "user" | "assistant";
  human: boolean;
  toolUse: boolean;
  toolResult: boolean;
  err: boolean;
  quotaMatch: boolean;
  overloadMatch: boolean;
  errText: string;
  sidechain: boolean;
  model: string | null;
  cwd: string;
  branch: string;
  text: string;
  usage: { input: number; output: number; cacheCreation: number; cacheRead: number } | null;
}

export interface QuotaEvent {
  sid: string;
  ts: number;
  text: string;
}

export interface LoadStats {
  filesSeen: number;
  lines: number;
  badJsonLines: number;
  dupUuid: number;
}

function parseTs(s: unknown): number | null {
  if (typeof s !== "string" || !s) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

// Flatten a message.content field to searchable text, matching text_of() in
// gate_analysis.py (text blocks + nested tool_result text blocks).
function textOf(msg: any): string {
  if (!msg || typeof msg !== "object") return "";
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const out: string[] = [];
    for (const b of c) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text") {
        out.push(b.text || "");
      } else if (b.type === "tool_result") {
        const r = b.content;
        if (typeof r === "string") out.push(r);
        else if (Array.isArray(r)) {
          for (const x of r) if (x && typeof x === "object") out.push(x.text || "");
        }
      }
    }
    return out.join("\n");
  }
  return "";
}

function blockTypes(msg: any): Set<string> {
  if (!msg || typeof msg !== "object") return new Set();
  const c = msg.content;
  if (Array.isArray(c)) {
    return new Set(c.filter((b) => b && typeof b === "object").map((b) => b.type));
  }
  return new Set();
}

function listJsonlFiles(corpusDir: string): string[] {
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(corpusDir).sort();
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const d of projectDirs) {
    const full = join(corpusDir, d);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const entries = readdirSync(full)
      .filter((f) => f.endsWith(".jsonl"))
      .sort();
    for (const f of entries) files.push(join(full, f));
  }
  return files;
}

async function forEachLine(path: string, cb: (line: string) => void): Promise<void> {
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) cb(line);
}

export interface LoadResult {
  sessions: Map<string, Event[]>;
  stats: LoadStats;
  quotaEvents: QuotaEvent[];
}

// Pass 1: stream the corpus into per-session event lists. Ports load() from
// gate_analysis.py. Dedup key is the transcript line's `uuid`, globally
// across all files (not per file) -- resumed/forked sessions replay prior
// history into a new transcript file, so per-file counting over-counts.
export async function loadCorpus(corpusDir: string, cutoffMs: number): Promise<LoadResult> {
  const sessions = new Map<string, Event[]>();
  const seenUuid = new Set<string>();
  const stats: LoadStats = { filesSeen: 0, lines: 0, badJsonLines: 0, dupUuid: 0 };
  const quotaEvents: QuotaEvent[] = [];

  const files = listJsonlFiles(corpusDir);
  for (const f of files) {
    stats.filesSeen++;
    await forEachLine(f, (raw) => {
      const line = raw.trim();
      if (!line) return;
      stats.lines++;
      let d: any;
      try {
        d = JSON.parse(line);
      } catch {
        stats.badJsonLines++;
        return;
      }
      if (!d || typeof d !== "object") {
        stats.badJsonLines++;
        return;
      }
      const t = d.type;
      if (t !== "user" && t !== "assistant") return;
      const uid = d.uuid;
      if (uid) {
        if (seenUuid.has(uid)) {
          stats.dupUuid++;
          return;
        }
        seenUuid.add(uid);
      }
      const sid = d.sessionId;
      const ts = parseTs(d.timestamp);
      if (!sid || ts === null) return;
      if (ts >= cutoffMs) return;

      const msg = d.message || {};
      const usageRaw = msg.usage || null;
      const model: string | null = msg.model ?? null;
      let usage: Event["usage"] = null;
      if (usageRaw && model) {
        usage = {
          input: usageRaw.input_tokens || 0,
          output: usageRaw.output_tokens || 0,
          cacheCreation: usageRaw.cache_creation_input_tokens || 0,
          cacheRead: usageRaw.cache_read_input_tokens || 0,
        };
      }
      const bt = blockTypes(msg);
      const txt = textOf(msg);
      const isErr = Boolean(d.isApiErrorMessage);
      let quotaMatch = false;
      let overloadMatch = false;
      if (isErr) {
        if (QUOTA_PAT.test(txt)) {
          quotaMatch = true;
          quotaEvents.push({ sid, ts, text: txt.trim().slice(0, 200) });
        }
        if (OVERLOAD_PAT.test(txt)) overloadMatch = true;
      }
      const origin = d.origin || {};
      const human =
        t === "user" &&
        (origin.kind === "human" || ["typed", "suggestion_accepted", "queued"].includes(d.promptSource));

      const ev: Event = {
        ts,
        role: t,
        human,
        toolUse: bt.has("tool_use"),
        toolResult: bt.has("tool_result"),
        err: isErr,
        quotaMatch,
        overloadMatch,
        errText: isErr ? txt : "",
        sidechain: Boolean(d.isSidechain),
        model,
        cwd: d.cwd || "",
        branch: d.gitBranch || "",
        text: txt,
        usage,
      };
      let arr = sessions.get(sid);
      if (!arr) {
        arr = [];
        sessions.set(sid, arr);
      }
      arr.push(ev);
    });
  }

  return { sessions, stats, quotaEvents };
}

export interface SessionDerived {
  sid: string;
  start: number;
  end: number;
  activeMs: number;
  serviceMs: number;
  approvalWaitMs: number;
  thinkWaitMs: number;
  bursts: number;
  events: number;
  outcome: "success" | "failed" | "stalled_rate_limit" | "stalled_other" | "abandoned";
  model: string | null;
  cwd: string;
  branch: string;
  firstHuman: string;
  firstUser: string;
  humanPrompts: number;
  interactive: boolean;
  tokensIn: number;
  tokensOut: number;
  cacheWrite: number;
  cacheRead: number;
}

// Pass 2: per-session derivation. Ports derive() from gate_analysis.py.
export function deriveSessions(sessions: Map<string, Event[]>): Map<string, SessionDerived> {
  const out = new Map<string, SessionDerived>();
  for (const [sid, evsRaw] of sessions) {
    if (evsRaw.length < MIN_SESSION_EVENTS) continue;
    const evs = [...evsRaw].sort((a, b) => a.ts - b.ts);

    let active = 0;
    let service = 0;
    let approvalWait = 0;
    let thinkWait = 0;
    let bursts = 1;
    for (let i = 0; i < evs.length - 1; i++) {
      const a = evs[i];
      const b = evs[i + 1];
      let g = b.ts - a.ts;
      if (g < 0) g = 0;
      if (g >= BURST_GAP_MS) bursts++;
      if (g >= IDLE_GAP_MS) continue; // idle: excluded from both active and service
      active += g;
      if (a.role === "assistant" && a.toolUse && b.toolResult && g > APPROVAL_GAP_MS) {
        approvalWait += g;
        continue;
      }
      if (b.human && g > THINK_GAP_MS) {
        thinkWait += g;
        continue;
      }
      service += g;
    }

    // outcome classification, extended from gate_analysis.py's 3-way
    // (error/abandoned/clean) into this schema's richer enum by splitting
    // "error" on which pattern the tail's error text matched.
    // DEVIATION: 'killed' has no signal in a transcript corpus (it would
    // require external process-supervision data), so it is never assigned
    // here even though the schema allows it.
    const tail = evs.slice(-3);
    const last = evs[evs.length - 1];
    let outcome: SessionDerived["outcome"];
    if (tail.some((e) => e.quotaMatch)) outcome = "stalled_rate_limit";
    else if (tail.some((e) => e.overloadMatch)) outcome = "stalled_other";
    else if (tail.some((e) => e.err)) outcome = "failed";
    else if (last.role === "assistant" && last.toolUse) outcome = "abandoned";
    else if (last.role === "user" && last.human) outcome = "abandoned";
    else outcome = "success";

    const modelCounts = new Map<string, number>();
    for (const e of evs) if (e.model) modelCounts.set(e.model, (modelCounts.get(e.model) || 0) + 1);
    let bestModel: string | null = null;
    let bestCount = 0;
    for (const [m, c] of modelCounts) {
      if (c > bestCount) {
        bestModel = m;
        bestCount = c;
      }
    }

    let tokensIn = 0,
      tokensOut = 0,
      cacheWrite = 0,
      cacheRead = 0;
    for (const e of evs) {
      if (e.usage) {
        tokensIn += e.usage.input;
        tokensOut += e.usage.output;
        cacheWrite += e.usage.cacheCreation;
        cacheRead += e.usage.cacheRead;
      }
    }

    const humanPrompts = evs.filter((e) => e.human).length;
    const firstHuman = evs.find((e) => e.human && e.text.trim())?.text ?? "";
    const firstUser = evs.find((e) => e.role === "user" && !e.toolResult && e.text.trim())?.text ?? "";

    out.set(sid, {
      sid,
      start: evs[0].ts,
      end: evs[evs.length - 1].ts,
      activeMs: active,
      serviceMs: service,
      approvalWaitMs: approvalWait,
      thinkWaitMs: thinkWait,
      bursts,
      events: evs.length,
      outcome,
      model: bestModel,
      cwd: evs[0].cwd,
      branch: evs[0].branch,
      firstHuman,
      firstUser,
      humanPrompts,
      // interactive = a human actually drove it; the rest are headless
      // SDK/batch one-shot calls (job screening etc.), a different workload class.
      interactive: humanPrompts > 0,
      tokensIn,
      tokensOut,
      cacheWrite,
      cacheRead,
    });
  }
  return out;
}

// ---- rework / retry-of inference, ported from rework() in gate_analysis.py --

const CMD_TAG = /<command-(name|message|args|contents)>.*?<\/command-\1>/gs;
const STOPWORDS = new Set(
  "the a an and or to of in for on is it this that be with as at by".split(" "),
);

function normTokens(s: string, stripCmd: boolean): Set<string> {
  let str = s || "";
  if (stripCmd) str = str.replace(CMD_TAG, " ");
  const toks = (str.toLowerCase().match(/[a-z0-9]+/g) || []).slice(0, 120);
  return new Set(toks.filter((t) => !STOPWORDS.has(t) && t.length > 1));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

// Returns a map of sid -> prior session id it is a retry of. Only computed
// over interactive sessions, matching gate_analysis.py's rework() which is
// invoked as rework(interactive) (headless one-shots aren't "rework" candidates).
export function computeRetries(interactive: SessionDerived[]): Map<string, string> {
  const order = [...interactive].sort((a, b) => a.start - b.start);
  const retryOf = new Map<string, string>();
  const badOutcomes = new Set(["failed", "stalled_rate_limit", "stalled_other", "abandoned"]);

  // signal A: follow-on in same cwd+branch within REWORK_WINDOW of a bad ending
  const byKeyA = new Map<string, SessionDerived[]>();
  for (const s of order) {
    const key = s.cwd + " " + s.branch;
    const arr = byKeyA.get(key) ?? [];
    for (let i = arr.length - 1; i >= 0; i--) {
      const prev = arr[i];
      const dt = s.start - prev.end;
      if (dt > REWORK_WINDOW_MS) break;
      if (dt >= -1000 && badOutcomes.has(prev.outcome)) {
        retryOf.set(s.sid, prev.sid);
        break;
      }
    }
    arr.push(s);
    byKeyA.set(key, arr);
  }

  // signal B: near-duplicate opening prompt in same cwd within DUP_WINDOW
  const byCwdB = new Map<string, { toks: Set<string>; start: number; sid: string }[]>();
  for (const s of order) {
    const toks = normTokens(s.firstUser, true);
    if (toks.size >= 4) {
      const arr = byCwdB.get(s.cwd) ?? [];
      for (const p of arr) {
        if (s.start - p.start > DUP_WINDOW_MS) continue;
        if (jaccard(toks, p.toks) >= DUP_JACCARD) {
          if (!retryOf.has(s.sid)) retryOf.set(s.sid, p.sid);
          break;
        }
      }
      arr.push({ toks, start: s.start, sid: s.sid });
      byCwdB.set(s.cwd, arr);
    }
  }

  return retryOf;
}

// ---- rate-limit event classification -----------------------------------

export function classifyQuotaKind(text: string): string {
  if (/monthly spend limit/i.test(text)) return "monthly_spend";
  if (/hit your weekly limit/i.test(text)) return "weekly_limit";
  if (/hit your session limit/i.test(text)) return "session_limit";
  if (/hit your 5-hour limit/i.test(text)) return "five_hour_limit";
  if (/usage credits are required/i.test(text)) return "credits_required";
  if (/credit balance is too low/i.test(text)) return "credit_balance_low";
  if (/429/.test(text)) return "http_429";
  return "rate_limit_other";
}

export function extractResetHint(text: string): string | null {
  const m = text.match(/resets?\s+([^.,;\n]{1,60})/i);
  if (m) return m[1].trim();
  // "try again in 5 minutes" phrasing carries no "resets" word but is the
  // same kind of prose hint (T4: relative-duration rate-limit messages).
  const rel = text.match(/try again in\s+([^.,;\n]{1,60})/i);
  return rel ? rel[1].trim() : null;
}

// T4: no Retry-After header exists anywhere in this corpus (see schema.sql's
// comment on rate_limit_events), so any absolute resume time has to come from
// parsing extractResetHint's prose, or fall back to a fixed, conservative
// delay. 30 minutes: short enough that a session-limit or 5-hour-window stall
// doesn't sit idle for hours, long enough that an unparseable hint doesn't
// hammer a wall that is (by definition, since we couldn't read it) still up.
export const DEFAULT_RESET_DELAY_MS = 30 * 60_000;

// A parsed clock time this far in the past is read as "the window just
// reopened" rather than "the same time tomorrow" -- see resolveResetTime.
export const ROLLOVER_GRACE_MS = 2 * 3_600_000;
// How soon to retry when the reset time appears to have just passed.
export const JUST_PASSED_RETRY_MS = 2 * 60_000;
// Backstop on any parsed reset, however it was derived. The gate analysis
// measured real resets at up to ~5 hours out, so nothing legitimate needs a
// longer park; this bounds the damage from any future parsing mistake to one
// wasted window instead of a silently lost night.
export const MAX_PARK_MS = 6 * 3_600_000;

const RELATIVE_HINT_PAT = /^(\d+)\s*(second|minute|hour|day)s?\b/i;
const RELATIVE_UNIT_MS: Record<string, number> = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};
// "9:20pm (Europe/Berlin)" / "11pm (Europe/Berlin)" -- a clock time plus an
// IANA zone name in parens, which is how every observed reset hint in this
// corpus spells a timezone.
const CLOCK_TZ_HINT_PAT = /(\d{1,2})(?::(\d{2}))?\s*([ap]m)\s*\(([^)]+)\)/i;

// Returns, for a given instant, what UTC offset (in minutes, east positive)
// timeZone is observing. Used to convert a wall-clock time in that zone to an
// absolute instant without pulling in a date library.
function offsetMinutesAt(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instantMs));
  const map: Record<string, string> = {};
  for (const p of parts) if (p.type !== "literal") map[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour) % 24,
    Number(map.minute),
    Number(map.second),
  );
  return (asUtc - instantMs) / 60_000;
}

// Absolute instant for wall-clock (year, month, day, hour, minute) as observed
// in timeZone. day is allowed to overflow past the end of the month (Date.UTC
// rolls it into the next month), which is how "roll to tomorrow" is done below.
function zonedWallTimeToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset = offsetMinutesAt(wallAsUtc, timeZone);
  return wallAsUtc - offset * 60_000;
}

// Sibling to extractResetHint: turns the prose hint it extracted into an
// absolute instant. Handles a relative duration ("5 minutes"), a clock time
// with a named timezone ("9:20pm (Europe/Berlin)"), and rolls a clock time
// that has already passed today over to tomorrow. Anything else -- including
// a null hint -- falls back to DEFAULT_RESET_DELAY_MS from `now`.
export function resolveResetTime(hint: string | null, now: Date = new Date()): Date {
  if (!hint) return new Date(now.getTime() + DEFAULT_RESET_DELAY_MS);

  const rel = hint.match(RELATIVE_HINT_PAT);
  if (rel) {
    const n = Number(rel[1]);
    const unitMs = RELATIVE_UNIT_MS[rel[2].toLowerCase()];
    if (Number.isFinite(n) && unitMs) return new Date(now.getTime() + n * unitMs);
  }

  const clock = hint.match(CLOCK_TZ_HINT_PAT);
  if (clock) {
    let hour = Number(clock[1]) % 12;
    const minute = clock[2] ? Number(clock[2]) : 0;
    if (clock[3].toLowerCase() === "pm") hour += 12;
    const timeZone = clock[4].trim();
    try {
      const todayParts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(now);
      const map: Record<string, string> = {};
      for (const p of todayParts) if (p.type !== "literal") map[p.type] = p.value;
      const year = Number(map.year);
      const month = Number(map.month);
      const day = Number(map.day);
      let targetMs = zonedWallTimeToUtcMs(year, month, day, hour, minute, timeZone);
      // A clock time that has already passed usually means tomorrow -- but only
      // if it passed a while ago. "resets 11pm" read at 23:30 means the window
      // just reopened, not that we should sleep for 23.5 hours; rolling that
      // forward would park an overnight job for the whole night on work that was
      // resumable in minutes. Inside the grace window, treat it as just-passed.
      if (targetMs <= now.getTime()) {
        if (now.getTime() - targetMs <= ROLLOVER_GRACE_MS) {
          return new Date(now.getTime() + JUST_PASSED_RETRY_MS);
        }
        targetMs = zonedWallTimeToUtcMs(year, month, day + 1, hour, minute, timeZone);
      }
      return new Date(Math.min(targetMs, now.getTime() + MAX_PARK_MS));
    } catch {
      // Unknown/invalid IANA zone name -- fall through to the default delay.
    }
  }

  return new Date(now.getTime() + DEFAULT_RESET_DELAY_MS);
}

// ---- cost estimation ------------------------------------------------------
//
// HAND-ENTERED, NEEDS CHECKING: these are best-guess $/million-token rates
// keyed by the model strings actually observed in this corpus. They are not
// scraped from a pricing page (some of these model names, e.g. claude-opus-5
// / claude-fable-5 / claude-sonnet-5, postdate this author's training data
// and no authoritative source was consulted). Treat cost_estimate as
// directional only until someone verifies this table against real billing.
export const PRICE_PER_MTOK: Record<
  string,
  { in: number; out: number; cacheWrite: number; cacheRead: number }
> = {
  "claude-opus-5": { in: 15, out: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-opus-4-8": { in: 15, out: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-fable-5": { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-sonnet-4-6": { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-sonnet-5": { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-4-5-20251001": { in: 1, out: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

export function estimateCost(
  model: string | null,
  tokensIn: number,
  tokensOut: number,
  cacheWrite: number,
  cacheRead: number,
): number | null {
  if (!model) return null;
  const p = PRICE_PER_MTOK[model];
  if (!p) return null;
  return (
    (tokensIn / 1e6) * p.in +
    (tokensOut / 1e6) * p.out +
    (cacheWrite / 1e6) * p.cacheWrite +
    (cacheRead / 1e6) * p.cacheRead
  );
}
