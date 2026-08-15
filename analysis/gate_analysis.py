#!/usr/bin/env python3
"""mk-fleet gate analysis: does the existing Claude Code transcript history
justify building a discrete-event simulation for session scheduling?

Reads ~/.claude/projects/*/*.jsonl READ-ONLY, streams line by line.
Standard library only. Deterministic: same corpus -> same numbers.

Usage: python3 gate_analysis.py [--json]
Writes nothing; prints a report to stdout.
"""

import json
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from statistics import mean, median, pstdev

CORPUS = Path.home() / ".claude" / "projects"

# The corpus is live: Claude Code appends to it while this runs, so an unpinned
# run is not reproducible. Everything at or after this instant is ignored.
# Override with --until ISO8601 (UTC).
CUTOFF = datetime(2026, 8, 14, 21, 40, 0, tzinfo=timezone.utc)

# ---- methodology constants (all in seconds) -------------------------------
IDLE_GAP = 900.0      # 15 min: any gap this long is idle/abandoned, never service time
APPROVAL_GAP = 30.0   # gap tool_use -> tool_result beyond this is human approval latency
THINK_GAP = 30.0      # gap assistant-turn -> next human prompt beyond this is human thinking
BURST_GAP = IDLE_GAP  # bursts are separated by an idle gap
REWORK_WINDOW = 3600.0    # follow-on session within 1h of a bad ending = retry candidate
DUP_WINDOW = 86400.0      # near-duplicate opening prompt within 24h = retry candidate
DUP_JACCARD = 0.8         # token-set similarity threshold for "near-duplicate"
MIN_SESSION_EVENTS = 2    # need >=2 timestamps to have any span at all

QUOTA_PAT = re.compile(
    r"(hit your (session|weekly|monthly|5-hour) limit"
    r"|monthly spend limit"
    r"|rate limit"
    r"|usage credits are required"
    r"|credit balance is too low"
    r"|429)",
    re.I,
)
RETRY_AFTER_PAT = re.compile(r"retry[-_ ]after[\"'\s:=]+(\d+)", re.I)
OVERLOAD_PAT = re.compile(r"(529|overloaded)", re.I)


def parse_ts(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def pct(sorted_vals, p):
    """Nearest-rank percentile. Deterministic, no interpolation."""
    if not sorted_vals:
        return 0.0
    k = max(0, min(len(sorted_vals) - 1, int(round(p / 100.0 * len(sorted_vals) + 0.5)) - 1))
    return sorted_vals[k]


def cv(vals):
    if len(vals) < 2:
        return 0.0
    m = mean(vals)
    return pstdev(vals) / m if m else 0.0


def shape(vals):
    v = sorted(vals)
    return {
        "n": len(v),
        "mean": mean(v) if v else 0.0,
        "median": median(v) if v else 0.0,
        "p90": pct(v, 90),
        "p99": pct(v, 99),
        "stddev": pstdev(v) if len(v) > 1 else 0.0,
        "cv": cv(v),
        "max": v[-1] if v else 0.0,
    }


def text_of(msg):
    """Flatten a message content field to searchable text."""
    if not isinstance(msg, dict):
        return ""
    c = msg.get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        out = []
        for b in c:
            if not isinstance(b, dict):
                continue
            if b.get("type") == "text":
                out.append(b.get("text") or "")
            elif b.get("type") == "tool_result":
                r = b.get("content")
                if isinstance(r, str):
                    out.append(r)
                elif isinstance(r, list):
                    out.extend(x.get("text") or "" for x in r if isinstance(x, dict))
        return "\n".join(out)
    return ""


def block_types(msg):
    if not isinstance(msg, dict):
        return set()
    c = msg.get("content")
    if isinstance(c, list):
        return {b.get("type") for b in c if isinstance(b, dict)}
    return set()


# ---- pass 1: stream corpus into per-session event lists ------------------

def load(cutoff=CUTOFF):
    sessions = defaultdict(list)   # sessionId -> list of event dicts
    seen_uuid = set()
    files = sorted(CORPUS.glob("*/*.jsonl"))
    stats = Counter()
    skipped = {}
    model_tokens = defaultdict(lambda: Counter())
    quota_events = []
    overload_events = []
    retry_afters = []

    for f in files:
        stats["files_seen"] += 1
        usable = 0
        cut = 0
        try:
            fh = f.open(errors="replace")
        except OSError as e:
            skipped[str(f)] = "unreadable: %s" % e.__class__.__name__
            continue
        with fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                stats["lines"] += 1
                try:
                    d = json.loads(line)
                except ValueError:
                    stats["bad_json_lines"] += 1
                    continue
                if not isinstance(d, dict):
                    stats["bad_json_lines"] += 1
                    continue
                t = d.get("type")
                stats["type_" + str(t)] += 1
                low = line.lower()
                if "rate limit" in low or "rate_limit" in low:
                    stats["lines_mentioning_rate_limit"] += 1
                if "retry_after" in low or "retry-after" in low:
                    stats["lines_mentioning_retry_after"] += 1
                if t not in ("user", "assistant"):
                    continue
                uid = d.get("uuid")
                if uid:
                    if uid in seen_uuid:
                        stats["dup_uuid"] += 1
                        continue
                    seen_uuid.add(uid)
                sid = d.get("sessionId")
                ts = parse_ts(d.get("timestamp"))
                if not sid or ts is None:
                    stats["no_sid_or_ts"] += 1
                    continue
                if ts >= cutoff:
                    stats["after_cutoff"] += 1
                    cut += 1
                    continue
                msg = d.get("message") or {}
                usage = msg.get("usage") or {}
                model = msg.get("model")
                if usage and model:
                    c = model_tokens[model]
                    c["input"] += usage.get("input_tokens", 0) or 0
                    c["output"] += usage.get("output_tokens", 0) or 0
                    c["cache_creation"] += usage.get("cache_creation_input_tokens", 0) or 0
                    c["cache_read"] += usage.get("cache_read_input_tokens", 0) or 0
                    c["turns"] += 1
                bt = block_types(msg)
                txt = text_of(msg)
                is_err = bool(d.get("isApiErrorMessage"))
                if is_err:
                    stats["api_error_lines"] += 1
                    if QUOTA_PAT.search(txt):
                        quota_events.append((ts, txt.strip()[:160], sid))
                    if OVERLOAD_PAT.search(txt):
                        overload_events.append((ts, txt.strip()[:160], sid))
                for m in RETRY_AFTER_PAT.finditer(line):
                    retry_afters.append(int(m.group(1)))
                origin = d.get("origin") or {}
                sessions[sid].append({
                    "ts": ts,
                    "role": t,
                    "human": t == "user" and (
                        origin.get("kind") == "human"
                        or d.get("promptSource") in ("typed", "suggestion_accepted", "queued")
                    ),
                    "tool_use": "tool_use" in bt,
                    "tool_result": "tool_result" in bt,
                    "err": is_err,
                    "sidechain": bool(d.get("isSidechain")),
                    "model": model,
                    "cwd": d.get("cwd") or "",
                    "branch": d.get("gitBranch") or "",
                    "text": txt,
                })
                usable += 1
        if usable == 0:
            skipped.setdefault(str(f), "entirely after --until cutoff" if cut
                               else "no user/assistant entries with timestamps")

    return sessions, stats, skipped, model_tokens, quota_events, overload_events, retry_afters


# ---- pass 2: per-session derivation --------------------------------------

def derive(sessions):
    out = {}
    for sid, evs in sessions.items():
        evs.sort(key=lambda e: e["ts"])
        if len(evs) < MIN_SESSION_EVENTS:
            continue
        span = (evs[-1]["ts"] - evs[0]["ts"]).total_seconds()
        active = 0.0        # idle gaps removed only
        service = 0.0       # idle + approval + thinking removed
        approval_wait = 0.0
        think_wait = 0.0
        idle = 0.0
        bursts = 1
        for a, b in zip(evs, evs[1:]):
            g = (b["ts"] - a["ts"]).total_seconds()
            if g < 0:
                g = 0.0
            if g >= BURST_GAP:
                bursts += 1
            if g >= IDLE_GAP:
                idle += g
                continue          # excluded from both active and service
            active += g
            if a["role"] == "assistant" and a["tool_use"] and b["tool_result"] and g > APPROVAL_GAP:
                approval_wait += g
                continue
            if b["human"] and g > THINK_GAP:
                think_wait += g
                continue
            service += g

        # outcome classification
        tail = evs[-3:]
        last = evs[-1]
        if any(e["err"] for e in tail):
            outcome = "error"
        elif last["role"] == "assistant" and last["tool_use"]:
            outcome = "abandoned"   # tool call issued, no result ever recorded
        elif last["role"] == "user" and last["human"]:
            outcome = "abandoned"   # human asked, no answer recorded
        else:
            outcome = "clean"

        models = Counter(e["model"] for e in evs if e["model"])
        human_prompts = sum(1 for e in evs if e["human"])
        first_human = next((e["text"] for e in evs if e["human"] and e["text"].strip()), "")
        first_user = next((e["text"] for e in evs
                           if e["role"] == "user" and not e["tool_result"] and e["text"].strip()), "")
        out[sid] = {
            "sid": sid,
            "start": evs[0]["ts"],
            "end": evs[-1]["ts"],
            "span": span,
            "active": active,
            "service": service,
            "approval_wait": approval_wait,
            "think_wait": think_wait,
            "idle": idle,
            "bursts": bursts,
            "events": len(evs),
            "outcome": outcome,
            "model": models.most_common(1)[0][0] if models else None,
            "cwd": evs[0]["cwd"],
            "branch": evs[0]["branch"],
            "first_human": first_human,
            "first_user": first_user,
            "human_prompts": human_prompts,
            # interactive = a human actually drove it; the rest are headless
            # SDK/batch one-shot calls (job screening etc), a different workload class.
            "interactive": human_prompts > 0,
            "sidechain_events": sum(1 for e in evs if e["sidechain"]),
            "intervals": burst_intervals(evs),
        }
    return out


def burst_intervals(evs):
    """Active intervals (burst start,end) with idle gaps cut out."""
    iv = []
    s = evs[0]["ts"]
    prev = evs[0]["ts"]
    for e in evs[1:]:
        if (e["ts"] - prev).total_seconds() >= BURST_GAP:
            iv.append((s, prev))
            s = e["ts"]
        prev = e["ts"]
    iv.append((s, prev))
    return iv


# ---- rework inference ----------------------------------------------------

STOPWORDS = set("the a an and or to of in for on is it this that be with as at by".split())


CMD_TAG = re.compile(r"<command-(name|message|args|contents)>.*?</command-\1>", re.S)


def norm_tokens(s, strip_cmd=True):
    s = s or ""
    if strip_cmd:
        # Slash-command prompts are wrapped in identical <command-*> XML, which
        # makes unrelated invocations look like near-duplicates. Strip it.
        s = CMD_TAG.sub(" ", s)
    toks = re.findall(r"[a-z0-9]+", s.lower())
    return set(t for t in toks[:120] if t not in STOPWORDS and len(t) > 1)


def rework(sess):
    """Two independent retry signals; report each and their union.

    A: a session that starts in the same cwd+branch within REWORK_WINDOW of a
       prior session that ended 'error' or 'abandoned' -> the prior run's work
       is being redone.
    B: a session whose opening human prompt is a near-duplicate (Jaccard >=
       DUP_JACCARD) of an earlier session's opening prompt in the same cwd
       within DUP_WINDOW.
    """
    order = sorted(sess.values(), key=lambda s: s["start"])
    by_key = defaultdict(list)
    sig_a, sig_b = set(), set()
    for s in order:
        k = (s["cwd"], s["branch"])
        for prev in reversed(by_key[k]):
            dt = (s["start"] - prev["end"]).total_seconds()
            if dt > REWORK_WINDOW:
                break
            if dt >= -1 and prev["outcome"] in ("error", "abandoned"):
                sig_a.add(s["sid"])
                break
        by_key[k].append(s)

    by_cwd = defaultdict(list)
    sig_b_unfiltered = set()
    for s in order:
        toks = norm_tokens(s["first_user"], strip_cmd=False)
        if len(toks) >= 4:
            for pts, pstart in by_cwd[s["cwd"]]:
                if (s["start"] - pstart).total_seconds() > DUP_WINDOW:
                    continue
                u = len(toks | pts)
                if u and len(toks & pts) / u >= DUP_JACCARD:
                    sig_b_unfiltered.add(s["sid"])
                    break
            by_cwd[s["cwd"]].append((toks, s["start"]))

    by_cwd = defaultdict(list)
    for s in order:
        toks = norm_tokens(s["first_user"])
        if len(toks) >= 4:
            for pts, pstart in by_cwd[s["cwd"]]:
                if (s["start"] - pstart).total_seconds() > DUP_WINDOW:
                    continue
                inter = len(toks & pts)
                union = len(toks | pts)
                if union and inter / union >= DUP_JACCARD:
                    sig_b.add(s["sid"])
                    break
            by_cwd[s["cwd"]].append((toks, s["start"]))
    return sig_a, sig_b, sig_b_unfiltered


# ---- concurrency ---------------------------------------------------------

def concurrency(sess):
    pts = []
    for s in sess.values():
        for a, b in s["intervals"]:
            if (b - a).total_seconds() <= 0:
                continue
            pts.append((a, 1))
            pts.append((b, -1))
    pts.sort(key=lambda x: (x[0], -x[1]))
    cur = mx = 0
    hist = Counter()
    prev = None
    for ts, d in pts:
        if prev is not None and cur > 0:
            hist[cur] += (ts - prev).total_seconds()
        cur += d
        mx = max(mx, cur)
        prev = ts
    total = sum(hist.values())
    return mx, hist, total


def fmt(sec):
    if sec < 90:
        return "%.1fs" % sec
    if sec < 5400:
        return "%.1f min" % (sec / 60)
    return "%.2f h" % (sec / 3600)


def population_stats(sub):
    return {
        "n": len(sub),
        "span": shape([s["span"] for s in sub]),
        "active": shape([s["active"] for s in sub]),
        "service": shape([s["service"] for s in sub]),
        "approval_wait": shape([s["approval_wait"] for s in sub if s["approval_wait"] > 0]),
        "think_wait": shape([s["think_wait"] for s in sub if s["think_wait"] > 0]),
        "bursts": shape([float(s["bursts"]) for s in sub]),
        "outcomes": Counter(s["outcome"] for s in sub),
    }


def main():
    cutoff = CUTOFF
    if "--until" in sys.argv:
        cutoff = parse_ts(sys.argv[sys.argv.index("--until") + 1])
    sessions, stats, skipped, model_tokens, quota, overload, retry_afters = load(cutoff)
    sess = derive(sessions)
    interactive = {k: v for k, v in sess.items() if v["interactive"]}
    batch = {k: v for k, v in sess.items() if not v["interactive"]}
    sig_a, sig_b, sig_b_raw = rework(interactive)
    mx, chist, ctotal = concurrency(sess)
    imx, ichist, ictotal = concurrency(interactive)

    R = {
        "files_seen": stats["files_seen"],
        "lines": stats["lines"],
        "bad_json_lines": stats["bad_json_lines"],
        "dup_uuid": stats["dup_uuid"],
        "api_error_lines": stats["api_error_lines"],
        "sessions_raw": len(sessions),
        "sessions_analysed": len(sess),
        "sessions_dropped_too_short": len(sessions) - len(sess),
        "files_skipped": len(skipped),
        "skip_reasons": Counter(skipped.values()),
        "range": (min(s["start"] for s in sess.values()), max(s["end"] for s in sess.values())),
        "all": population_stats(list(sess.values())),
        "interactive": population_stats(list(interactive.values())),
        "batch": population_stats(list(batch.values())),
        "rework_a": len(sig_a),
        "rework_b": len(sig_b),
        "rework_b_unfiltered": len(sig_b_raw),
        "rework_union": len(sig_a | sig_b),
        "rework_union_unfiltered": len(sig_a | sig_b_raw),
        "rework_denom": len(interactive),
        "quota_events": quota,
        "overload_events": overload,
        "retry_afters": retry_afters,
        "max_concurrency": mx,
        "conc_hist": chist,
        "conc_total": ctotal,
        "max_concurrency_interactive": imx,
        "conc_hist_interactive": ichist,
        "conc_total_interactive": ictotal,
        "model_tokens": model_tokens,
        "per_model_outcome": defaultdict(Counter),
    }
    for s in interactive.values():
        R["per_model_outcome"][s["model"]][s["outcome"]] += 1

    if "--json" in sys.argv:
        def enc(o):
            if isinstance(o, datetime):
                return o.isoformat()
            if isinstance(o, Counter):
                return dict(o)
            return str(o)
        print(json.dumps(R, default=enc, indent=1, sort_keys=True))
        return

    print("== corpus ==")
    print("cutoff (--until): %s   entries ignored after it: %d"
          % (cutoff.isoformat(), stats["after_cutoff"]))
    print("files seen: %d   lines: %d   bad-json lines: %d   dup uuids skipped: %d"
          % (R["files_seen"], R["lines"], R["bad_json_lines"], R["dup_uuid"]))
    print("files skipped: %d  reasons: %s" % (R["files_skipped"], dict(R["skip_reasons"])))
    print("sessions with >=2 timestamped turns: %d (of %d ids; %d dropped as too short)"
          % (R["sessions_analysed"], R["sessions_raw"], R["sessions_dropped_too_short"]))
    print("  interactive (>=1 human prompt): %d    headless SDK/batch: %d"
          % (len(interactive), len(batch)))
    print("range: %s .. %s" % (R["range"][0].isoformat(), R["range"][1].isoformat()))

    for pop in ("all", "interactive", "batch"):
        P = R[pop]
        n = max(1, P["n"])
        print("\n=== population: %s (n=%d) ===" % (pop, P["n"]))
        for label in ("span", "active", "service"):
            d = P[label]
            print("  %-8s mean=%-10s median=%-9s p90=%-10s p99=%-10s max=%-10s stddev=%-10s CV=%.3f"
                  % (label, fmt(d["mean"]), fmt(d["median"]), fmt(d["p90"]), fmt(d["p99"]),
                     fmt(d["max"]), fmt(d["stddev"]), d["cv"]))
        for label in ("approval_wait", "think_wait"):
            d = P[label]
            print("  %-14s n=%-4d total=%-10s mean=%-9s median=%-9s p90=%-9s max=%s"
                  % (label, d["n"], fmt(d["mean"] * d["n"]), fmt(d["mean"]),
                     fmt(d["median"]), fmt(d["p90"]), fmt(d["max"])))
        b = P["bursts"]
        print("  bursts/session mean=%.2f median=%.1f p90=%.1f max=%.0f"
              % (b["mean"], b["median"], b["p90"], b["max"]))
        print("  outcomes: " + "  ".join("%s=%d (%.1f%%)" % (k, v, 100.0 * v / n)
                                         for k, v in P["outcomes"].most_common()))

    d = R["rework_denom"]
    print("\n== rework (denominator = interactive sessions, n=%d) ==" % d)
    print("signal A (follow-on after error/abandon, same cwd+branch <=1h): %d  = %.1f%%"
          % (R["rework_a"], 100.0 * R["rework_a"] / d))
    print("signal B (near-duplicate opening prompt, same cwd <=24h, J>=%.2f): %d  = %.1f%%"
          % (DUP_JACCARD, R["rework_b"], 100.0 * R["rework_b"] / d))
    print("  (before stripping <command-*> slash-command boilerplate: %d = %.1f%% -- those were"
          " false positives) " % (R["rework_b_unfiltered"], 100.0 * R["rework_b_unfiltered"] / d))
    print("union: %d = %.1f%%  (unfiltered union: %d = %.1f%%)"
          % (R["rework_union"], 100.0 * R["rework_union"] / d,
             R["rework_union_unfiltered"], 100.0 * R["rework_union_unfiltered"] / d))

    print("\n== quota / rate-limit events ==")
    print("total: %d over %.1f days" % (len(quota),
          (R["range"][1] - R["range"][0]).total_seconds() / 86400))
    kinds = Counter()
    for ts, txt, sid in quota:
        kinds[re.sub(r"[\d:apm]+ \(.*|·.*", "", txt).strip()[:60]] += 1
    for k, v in kinds.most_common():
        print("  %2d  %s" % (v, k))
    days = Counter(ts.date().isoformat() for ts, _, _ in quota)
    print("  distinct days with a quota event: %d -> %s" % (len(days), sorted(days)))
    print("529/overload events: %d" % len(overload))
    print("retry_after values parsed out of user/assistant entries: %s"
          % (sorted(set(retry_afters)) or "none"))
    print("lines merely MENTIONING 'rate limit' (content, not events): %d"
          % stats["lines_mentioning_rate_limit"])
    print("lines merely MENTIONING 'retry_after' (content, not events): %d"
          % stats["lines_mentioning_retry_after"])
    print("isApiErrorMessage lines total: %d" % stats["api_error_lines"])

    print("\n== per-model tokens (all sessions) & outcomes (interactive sessions) ==")
    for m, c in sorted(model_tokens.items(), key=lambda kv: -kv[1]["output"]):
        oc = R["per_model_outcome"].get(m, Counter())
        tot = sum(oc.values())
        clean = 100.0 * oc["clean"] / tot if tot else 0.0
        print("  %-28s turns=%6d in=%9d out=%8d cache_w=%10d cache_r=%12d | sessions=%3d clean=%.1f%% err=%d aband=%d"
              % (m, c["turns"], c["input"], c["output"], c["cache_creation"], c["cache_read"],
                 tot, clean, oc["error"], oc["abandoned"]))

    for label, m, h, tot in (("all", mx, chist, ctotal),
                             ("interactive", imx, ichist, ictotal)):
        print("\n== observed concurrency, %s (overlapping active bursts) ==" % label)
        print("max concurrent sessions: %d" % m)
        for k in sorted(h):
            print("  k=%d  %6.1f h  %5.1f%% of busy time" % (k, h[k] / 3600, 100.0 * h[k] / tot))
        print("busy time: %.1f h   time-weighted mean concurrency: %.3f"
              % (tot / 3600, sum(k * v for k, v in h.items()) / tot if tot else 0.0))

    busy_h = ctotal / 3600.0
    billed = sum(c["input"] + c["output"] + c["cache_creation"] for c in model_tokens.values())
    days = (R["range"][1] - R["range"][0]).total_seconds() / 86400
    print("\n== burn rate (for WIP derivation) ==")
    print("non-cache-read tokens: %d over %.1f busy h = %.0f tok/busy-h" % (billed, busy_h, billed / busy_h))
    print("session-limit hits: %d over %.1f days = 1 per %.1f days at mean concurrency %.2f"
          % (sum(1 for _, t, _ in quota if "session limit" in t.lower()), days,
             days / max(1, sum(1 for _, t, _ in quota if "session limit" in t.lower())),
             sum(k * v for k, v in chist.items()) / ctotal if ctotal else 0.0))


if __name__ == "__main__":
    main()
