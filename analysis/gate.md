# mk-fleet gate: does the existing transcript history justify a discrete-event simulation?

Produced by `gate_analysis.py` (stdlib only, streaming, read-only over `~/.claude/projects/*/*.jsonl`).
Corpus range analysed: **2026-06-27T18:08:56Z .. 2026-08-14T21:39:52Z** (48.1 days).

The corpus is *live* — Claude Code appends to it while the script runs, so an unpinned run is not
reproducible. The script therefore hard-pins a cutoff (`CUTOFF = 2026-08-14T21:40:00Z`, overridable
with `--until`) and ignores everything at or after it (44 entries ignored, 1 file skipped entirely).

---

## 1. Corpus and session count

| | |
|---|---|
| files seen | 446 |
| lines streamed | 68,774 |
| malformed JSON lines | 0 |
| duplicate `uuid`s skipped (resumed/forked sessions replay history into new files) | 312 |
| files skipped | 11 — 10 contained no `user`/`assistant` entry with a timestamp (only `mode`, `permission-mode`, `file-history-snapshot`, `ai-title` etc.); 1 was entirely after the cutoff |
| distinct `sessionId`s with >= 2 timestamped turns | **435** |
| — of those, **interactive** (>= 1 human-origin prompt) | **158** |
| — of those, **headless SDK / batch** (no human prompt at all) | **277** |

**The corpus is bimodal, and this matters more than any other methodology decision.** 203 sessions
have exactly 2 turns; 179 have >= 20. Inspection of the 2-turn group shows 188 of them are batch
job-screening one-shots from the `eve` project (`promptSource: "sdk"`, identical candidate-profile
prompt, a single JSON score back, ~2.9 s median). Those are a *different workload class* from a
coding-agent session and mixing them into one distribution manufactures a heavy tail out of thin air.
Sessions are therefore split by whether a human ever typed into them, and the gate is decided on the
**interactive** population — that is what mk-fleet would actually schedule. Batch numbers are
reported alongside for completeness.

## 2. Service-time distribution

Three definitions are reported so the reader can see exactly how much the methodology moved the answer:

- **span** — naive last-timestamp minus first-timestamp. No exclusions.
- **active** — span with every gap >= `IDLE_GAP` (15 min) removed. This is the burst-splitting rule:
  a gap that long means the session was parked, not working. A session left open overnight
  contributes only its bursts.
- **service** — `active`, minus human latency: a gap > 30 s between an assistant `tool_use` and the
  matching `user` `tool_result` is scored as **approval wait**, and a gap > 30 s between an assistant
  turn and the next human prompt is scored as **thinking wait**. Both are excluded from service time
  and reported separately. This is the number the gate is decided on.

### Interactive sessions (n = 158) — the gate population

| metric | mean | median | p90 | p99 | max | stddev | **CV** |
|---|---|---|---|---|---|---|---|
| span | 16.97 h | 49.7 min | 47.88 h | 286.51 h | 307.91 h | 47.73 h | **2.812** |
| active | 42.9 min | 14.2 min | 1.97 h | 8.55 h | 8.76 h | 77.0 min | **1.797** |
| **service** | **21.7 min** | **5.6 min** | **69.9 min** | **3.05 h** | **3.60 h** | **35.6 min** | **1.637** |

### All sessions (n = 435) and batch-only (n = 277), for reference

| population | metric | mean | median | p90 | p99 | stddev | CV |
|---|---|---|---|---|---|---|---|
| all | span | 6.21 h | 21.5 s | 11.84 h | 195.31 h | 29.90 h | 4.815 |
| all | active | 16.5 min | 21.5 s | 42.0 min | 4.04 h | 50.6 min | 3.061 |
| all | service | 8.8 min | 20.7 s | 25.3 min | 2.15 h | 23.7 min | 2.682 |
| batch | span | 4.2 min | 2.9 s | 6.7 min | 39.7 min | 41.3 min | 9.743 |
| batch | active | 1.5 min | 2.9 s | 6.7 min | 19.2 min | 3.6 min | 2.398 |
| batch | service | 89.6 s | 2.9 s | 6.7 min | 19.2 min | 3.6 min | 2.398 |

**Headline: service-time CV = 1.64 (interactive), 1.80 before removing human latency, 2.81 if you
naively use the raw span.** The entire distance between "GO" and "NO-GO" on the CV axis is one
methodology choice: whether overnight idle counts as service time. It should not.

### Human latency, reported separately (best effort — noisy)

| | n sessions | total | mean | median | p90 | max |
|---|---|---|---|---|---|---|
| `approval_wait_ms` | 77 | 15.87 h | 12.4 min | 5.1 min | 45.3 min | 1.77 h |
| `think_wait` (assistant turn -> next human prompt) | 109 | 39.78 h | 21.9 min | 11.0 min | 42.4 min | 4.20 h |

This is genuinely noisy and I will not defend it to the minute. The transcript records no
"permission prompt shown" event, so an approval wait is inferred purely from the delay between a
`tool_use` and its `tool_result` — a slow `npm install` or a long web fetch is indistinguishable from
a human staring at the screen. The 30 s threshold is a guess chosen to be above almost all tool
latency and below plausible human dithering. Direction of the bias: **approval wait is
over-counted**, so true service time is somewhat higher than 21.7 min and its CV somewhat lower.

### Threshold sensitivity (interactive service CV)

| `IDLE_GAP` | 5 min | 10 min | 15 min | 30 min | 60 min |
|---|---|---|---|---|---|
| service CV | 1.635 | 1.647 | **1.637** | 1.653 | 1.673 |
| active CV | 1.732 | 1.786 | 1.797 | 1.844 | 1.801 |
| bursts/session | 4.28 | 3.20 | 2.75 | 2.25 | 1.85 |

The answer is insensitive to the burst threshold across a 12x range. The CV is not an artefact of
picking 15 minutes. Bursts per interactive session at the chosen threshold: mean 2.75, median 2, max 19.

## 3. Rework rate

There is no `retry_of` field, so two independent heuristics were tried, over the 158 interactive
sessions:

- **Signal A** — a session starting in the same `cwd` + `gitBranch` within 1 h of a prior session
  that ended in an API error or was abandoned: **1 session = 0.6%**.
- **Signal B** — a session whose opening user prompt is a near-duplicate (token-set Jaccard >= 0.80,
  same `cwd`, within 24 h) of an earlier session's opening prompt: **1 session = 0.6%**.
- **Union: 2 = 1.3%.**

Signal B initially reported 5 (3.2%). Inspection showed 4 of the 5 were slash-command invocations
(`/clear`, `/model`, `/effort`, `/ferb`) whose identical `<command-name>`/`<command-message>` XML
wrapper dominated the token set — pure false positives. The script now strips that wrapper before
tokenising and reports both numbers. The unfiltered union (3.8%) is the honest upper bound; the
filtered union (1.3%) is the honest point estimate.

**Confidence: low, and the direction of the error is knowable.** Both signals detect only
*session-level* rework — starting over. They are blind to *in-session* rework, which is where the
real loops live: "no, that broke the tests, try again" inside one session is invisible to a
cwd/branch/prompt-similarity heuristic. So the real rework rate for the thing a scheduler cares
about (a work item that has to be redone) is **higher than 1.3%, by an amount this corpus cannot
measure.** What can be said with confidence is that it is nowhere near the 15% GO threshold on the
signals available, and that session-terminal failure is rare: 96.8% of interactive sessions end
clean, 2.5% abandoned, 0.6% in an error.

## 4. Rate-limit / quota events

**25 events over 48.1 days, on 12 distinct days.** All 39 `isApiErrorMessage: true` lines were
classified; the quota-bearing subset:

| count | event |
|---|---|
| 10 | "You've hit your monthly spend limit" |
| 9 | "You've hit your session limit · resets \<time\>" |
| 4 | "Usage credits are required for this model." |
| 1 | "You've hit your weekly limit" |
| 1 | "Credit balance is too low" |

Days with an event: 2026-07-04, 07-05, 07-14, 07-17, 07-18, 07-21, 07-24, 07-30, 07-31, 08-02,
08-04, 08-10. Plus **1** 529/Overloaded event in the whole corpus.

**`retry_after`: not present anywhere in the corpus as a value.** The **478** lines matching
"rate limit" and the **52** matching "retry_after" are all *content* — prompts and tool results in
which Mahesh and the agent were writing rate-limiting code — not events. A grep-level count of lines
mentioning "rate limit" is therefore not a count of rate-limit events; the real event count is 25,
out of 39 `isApiErrorMessage` lines total. A scheduler cannot
learn its backoff from a `Retry-After` header here, because the CLI never records one. It gets a
wall-clock reset time in prose ("resets 11pm (Europe/Berlin)"), which is parseable but is a different
mechanism.

## 5. Per-model tokens and outcomes

Token totals are over all sessions; outcome counts are over interactive sessions (dominant model per
session by turn count).

| model | turns | input | output | cache write | cache read | interactive sessions | clean | error | abandoned |
|---|---|---|---|---|---|---|---|---|---|
| claude-opus-5 | 18,453 | 197,424 | 17,339,662 | 84,860,503 | 2,425,454,935 | 100 | 97.0% | 0 | 3 |
| claude-opus-4-8 | 5,447 | 933,339 | 5,391,320 | 23,543,021 | 840,034,856 | 37 | 100.0% | 0 | 0 |
| claude-fable-5 | 2,004 | 370,996 | 2,692,542 | 13,397,815 | 198,047,404 | 18 | 100.0% | 0 | 0 |
| claude-sonnet-4-6 | 202 | 324 | 182,270 | 764,740 | 10,680,958 | 1 | 100.0% | 0 | 0 |
| claude-sonnet-5 | 205 | 410 | 63,508 | 2,358,792 | 4,861,584 | 0 (batch only) | — | 0 | 0 |
| claude-haiku-4-5-20251001 | 10 | 92 | 1,068 | 16,232 | 178,690 | 0 (batch only) | — | 0 | 0 |
| `<synthetic>` | 48 | 0 | 0 | 0 | 0 | 1 | 0% | 1 | 0 |

Notes, because these raw numbers are easy to over-read:

- **This cannot answer "five cheap sessions or two expensive ones".** The cheap models here
  (sonnet-5, haiku) were used *only* for the batch classification workload, and the expensive ones
  (opus-5, opus-4-8) *only* for interactive coding. There is no model held constant across a task
  type, so success rates are not comparable — the 100% clean rate on opus-4-8 vs 97.0% on opus-5 is
  37 vs 100 sessions of unmatched work, not a quality signal. Answering that question needs a
  controlled A/B, not this corpus.
- Cache reads dominate spend-relevant volume by ~16x over cache writes and ~140x over output
  (2.43 G cache-read tokens on opus-5 alone). Any fleet cost model that ignores cache-read pricing
  will be wrong by more than an order of magnitude.
- The `<synthetic>` model is the CLI's own error-message pseudo-model, not a real model.

## 6. Recommended WIP limit

Two independent derivations from the data, both landing in the same place.

**(a) The human is the bottleneck, not the API.** Across interactive sessions: 112.87 h of active
time, of which 57.23 h is service and **55.65 h (49.3%) is human wait** (approval + thinking). A
session is blocked on Mahesh roughly half the time it is nominally alive. To keep one human
continuously fed, concurrency of `1 / (1 - 0.493) = 1.97` sessions is enough. Anything beyond ~2 is
queueing work behind a human who is already saturated — which is exactly the regime where more WIP
buys latency, not throughput.

**(b) Quota scales roughly linearly with concurrency, and the failure mode is shared.** Observed
burn: 152.1 M non-cache-read tokens over 107.5 busy hours = **1.42 M tok/busy-h**, at a time-weighted
mean concurrency of **1.115** (max observed 4; 89.8% of busy time at k=1, 9.0% at k=2, 1.0% at k=3,
0.1% at k=4). Session-limit hits arrived once per 5.3 days at that concurrency. Burn per wall-clock
hour scales ~linearly with k, so expected hits scale ~`k / 1.115`: k=3 gives one roughly every 2.0
days, k=5 one roughly every 1.2 days. The penalty is asymmetric — the quota is *shared*, so one hit
stalls **all** k sessions until the reset, and resets are prose wall-clock times up to 5 hours out.
Overshooting WIP does not degrade gracefully; it converts the whole fleet into a stall.

**WIP = 3.** Two because the human saturates at ~2, plus one so that a session blocked on an
approval does not idle the fleet — and no more, because quota hits are already a twice-monthly event
at k≈1.1 and they take everything down together. It also matches the observed ceiling: Mahesh has
already reached k=4 by hand, for 0.1% of busy time, i.e. accidentally rather than sustainably.

## 7. Limitation — what this data cannot do

**This history is almost entirely sequential: 89.8% of busy time had exactly one session active, and
the time-weighted mean concurrency is 1.115.** It therefore supports the two quantities the gate
actually tests — service-time distribution shape and rework rate — and nothing about congestion. It
contains **no congestion data at all**: no throughput-collapse-under-concurrency curve, no measured
interaction between concurrent sessions and the shared token quota, no queueing delay observed as a
function of k, no evidence about whether k sessions degrade each other through rate limits, disk
contention, or human approval starvation. The 1.1 h at k=3 and 0.1 h at k=4 are incidental overlaps,
not experiments. Consequently this corpus is **not adequate calibration data for a simulation** — it
could not validate one even if we built it, because there is no observed congested regime to compare
a simulated one against. Any claim about what happens at k=5 or k=10 would be extrapolation from a
single point at k≈1. If a simulation is ever genuinely needed, the prerequisite is a deliberate
concurrency ramp (run k=1,2,4,8 on comparable task batches and measure completion time and quota
hits), not more of this history.

## Verdict reasoning

Against the pre-committed rule:

- Service-time **CV = 1.64** (interactive, human latency and idle excluded). Not `≈1`, so this is not
  a clean textbook M/M/k; but also not `> 2`, so it is not the heavy tail that would force a DES.
  Note that `> 2` is reachable (2.81) *only* by using raw session span, which counts sessions parked
  overnight as being in service. That is a measurement artefact, not a heavy tail.
- Rework rate **1.3%** point estimate, **3.8%** unfiltered upper bound — both far below the 15% GO
  threshold, and below the 5% NO-GO threshold too. Caveat: this measures session-level rework only
  and is blind to in-session retry loops, so the true figure is higher by an unmeasured amount.

So: CV is in the in-between band (1.64), while rework is in NO-GO territory. **The rule says
judgement call, lean NO-GO — and I lean NO-GO.** Explicitly, why I leaned that way:

1. The only number in this analysis that clears the GO bar is the one contaminated by overnight idle.
   Every defensible service-time definition sits at 1.6–1.8, and that result is stable across a 12x
   sweep of the burst threshold.
2. A CV of 1.6 is a mildly heavy-tailed service distribution. There are closed-form and
   near-closed-form answers for that (M/G/k approximations such as Allen–Cunningham, which take
   exactly the mean and CV computed above). A discrete-event simulation would buy no accuracy that
   the CV-corrected formula does not already give, at far higher cost.
3. Rework is not driving loops. 96.8% of interactive sessions end clean; retries are ~1–4%. There is
   no rework feedback loop for a DES to model.
4. The real constraint is not queueing at all — it is a human who is blocked-on 49.3% of the time and
   a shared quota that fails all-at-once twice a month. Neither is a queueing-theory question. The
   scheduler needs a small hardcoded WIP, a quota-aware backoff that parses the reset time out of the
   error prose, and an approval queue. It does not need a simulator.
5. And as section 7 says: this data could not calibrate a simulation anyway. Building one now would
   mean tuning an unvalidatable model. Ship the constant, instrument the fleet, and revisit only if
   observed throughput at k=3 diverges from the M/G/k prediction.

VERDICT: NO-GO
WIP: 3
