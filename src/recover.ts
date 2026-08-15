// mk-fleet stall recovery: decide why a dispatched job's tmux session
// vanished with no PR draft, and whether it is worth resuming.
//
// Ported from /home/maheshk/cc-continue/bin/cc-continue's decision logic
// (stall detection via the tail of the transcript, wait-vs-drop on the reset
// window, resume via the CLI's own continuation rather than a fresh prompt).
// Not ported: its arg parsing, cron install/uninstall, credential/keychain
// lookups, and the live `usage` API poll -- mk-fleet has no OAuth token
// plumbing and works from the job's own agent.log instead of a live quota
// endpoint. This file has no code path that pushes, opens a PR, or comments
// upstream -- same hard rule as dispatch.ts.

import { classifyQuotaKind, extractResetHint, OVERLOAD_PAT, QUOTA_PAT, resolveResetTime } from "./telemetry.ts";

// A job that keeps stalling stops being resumed here and is failed instead,
// so a permanently-stuck rate limit (or a flaky non-quota error that never
// clears) cannot loop forever. Distinct from dispatch.ts's MAX_ATTEMPTS,
// which counts fresh launches, not resumes of an already-launched session.
export const RESUME_CAP = 3;

// Sent to `claude --continue` on resume. Deliberately generic: the resumed
// session already has the original dispatch-agent.md prompt (with its
// no-push instructions) in its history, so this only needs to nudge it back
// into motion, matching cc-continue's CC_PROMPT default.
export const RESUME_PROMPT = "continue where you left off";

export type StallClassification =
  | "success"
  | "stalled_rate_limit"
  | "stalled_other"
  | "needs_human"
  | "failed";

// Not every quota wall is a clock. Of the 25 real quota events in the corpus,
// 15 -- monthly spend, credits required, credit balance -- are exhausted money,
// not an exhausted window: waiting does not clear them, only Mahesh does.
// Parking and retrying those every DEFAULT_RESET_DELAY_MS would burn the resume
// budget all night and then report a rate-limit stall when the truth is "raise
// a limit". Only session and weekly limits actually reopen on their own.
const MONEY_QUOTA_KINDS = new Set(["monthly_spend", "credits_required", "credit_balance_low"]);

export interface StallVerdict {
  classification: StallClassification;
  rawText: string | null;
  resetHint: string | null;
  quotaKind: string | null;
  resumeAfter: string | null; // ISO 8601, only set for stalled_* classifications
}

// Ported from cc-continue's scan_paused(): the trigger is the LAST thing the
// session said, not any occurrence anywhere in the log -- a quota message
// earlier in a transcript that went on to finish is not a stall (mk-fleet's
// own corpus has zero sessions that terminally died on a rate limit; the tail
// is what distinguishes "hit a wall mid-session and kept going" from "hit a
// wall and stopped there"). Only the last few KB are considered.
const TAIL_BYTES = 4_000;

function findLastMatch(text: string, pat: RegExp): string | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line && pat.test(line)) return line;
  }
  return null;
}

// Classify why a job's agent.log ended, given whether its PR draft is
// present. Mirrors dispatch.ts's reconcile() "finished vs died" split, then
// -- only on the "died" side -- decides quota-stall vs other-stall vs
// genuinely dead, per cc-continue's scan_paused()/decide() heuristics.
export function classifyStall(logText: string, prDraftExists: boolean, now: Date = new Date()): StallVerdict {
  if (prDraftExists) {
    return { classification: "success", rawText: null, resetHint: null, quotaKind: null, resumeAfter: null };
  }

  const tail = logText.slice(-TAIL_BYTES);

  const quotaLine = findLastMatch(tail, QUOTA_PAT);
  if (quotaLine) {
    const hint = extractResetHint(quotaLine);
    const quotaKind = classifyQuotaKind(quotaLine);
    if (quotaKind && MONEY_QUOTA_KINDS.has(quotaKind)) {
      return {
        classification: "needs_human",
        rawText: quotaLine.slice(0, 200),
        resetHint: hint,
        quotaKind,
        resumeAfter: null,
      };
    }
    return {
      classification: "stalled_rate_limit",
      rawText: quotaLine.slice(0, 200),
      resetHint: hint,
      quotaKind,
      resumeAfter: resolveResetTime(hint, now).toISOString(),
    };
  }

  // Non-quota but transient (529/"overloaded") -- ported from the same
  // OVERLOAD_PAT telemetry.ts already uses to classify a session outcome.
  // No reset window is knowable for these, so resume is eligible immediately.
  if (findLastMatch(tail, OVERLOAD_PAT)) {
    return {
      classification: "stalled_other",
      rawText: null,
      resetHint: null,
      quotaKind: null,
      resumeAfter: now.toISOString(),
    };
  }

  return { classification: "failed", rawText: null, resetHint: null, quotaKind: null, resumeAfter: null };
}

// Resume command for an already-launched job: `claude --continue` in the
// job's existing worktree, per cc-continue's approach, instead of a fresh
// `-p <prompt>` on a fresh worktree/branch. Same MK_FLEET_AGENT_CMD override
// dispatch.ts's agentCommand() uses, so tests never invoke a real model here
// either. Same permission posture (--dangerously-skip-permissions) and same
// absence of any push/PR/comment invocation as a fresh launch.
// agent.log is appended across resume attempts (each resume reuses the same
// logPath, for a human reading the whole run's history in the morning). That
// means a stall message from an EARLIER attempt can still sit inside the
// trailing bytes classifyStall looks at after a LATER attempt ends for an
// unrelated reason. dispatch.ts writes this marker immediately before
// starting each resume's tmux command; currentAttemptLog() then confines
// classification to whatever was written after the most recent one, so a
// resumed attempt is never classified by its predecessor's tail.
const RESUME_MARKER_PREFIX = "----- mk-fleet resume ";

export function resumeMarker(now: Date = new Date()): string {
  return `\n${RESUME_MARKER_PREFIX}${now.toISOString()} -----\n`;
}

export function currentAttemptLog(logText: string): string {
  const idx = logText.lastIndexOf(RESUME_MARKER_PREFIX);
  return idx === -1 ? logText : logText.slice(idx);
}

export function resumeAgentCommand(logPath: string, live: boolean): string {
  const override = process.env.MK_FLEET_AGENT_CMD;
  const cmd = override
    ? override
    : live
      ? `claude --continue --dangerously-skip-permissions --model claude-opus-5 -p "${RESUME_PROMPT}"`
      : `echo "mk-fleet: inert resume -- pass --live (or set MK_FLEET_AGENT_CMD) to invoke a real agent"`;
  return `${cmd} >> ${logPath} 2>&1`;
}
