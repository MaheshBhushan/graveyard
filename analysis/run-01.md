# Run 01 — first live dispatch (T7)

**2026-08-15, 12:05–12:19 CEST.** First run of mk-fleet against real agents, real
tokens, real upstream issues.

```
bun run src/cli.ts dispatch --live --wip 2 --max-jobs 2 --db /tmp/t7.sqlite
```

Target repo `Textualize/rich`, 7 issues queued, 2 launched.

## Result

| | rich#3299 | rich#4207 |
|---|---|---|
| wall clock | 3m04s | 13m24s |
| turns | 68 | 152 |
| diff | 1 file / +19 | 2 files / +44 −4 |
| ceiling (2 files / 50 lines) | ok | ok |
| PR draft | yes | yes |
| resumes | 0 | 0 |
| approval wait | 0 ms | 0 ms |
| cost estimate | $6.07 | $24.65 |

Both jobs reached `done`. Nothing was pushed; no PR, comment, or label upstream.

## What the run actually proves

Independently re-verified rather than taken from the agents' self-reports:

- **WIP limit held.** 2 running, 5 never launched, no third worktree created.
- **Worktree isolation held.** Each job on its own branch off `origin/main`;
  both trees clean after commit; no writes to the source checkout.
- **Diff ceilings held** — re-measured with `git diff --numstat main...HEAD`,
  not trusted from the agent. 4207 landed at 48 changed lines against a 50-line
  ceiling, so the margin was one edit wide.
- **Tests genuinely green.** Re-ran both suites myself: 3299 → 960 passed /
  25 skipped / 0 failed; 4207 → 957 passed / 25 skipped / 0 failed.
- **Red/green genuinely red.** Reverted `rich/live.py` to `main` and re-ran
  4207's new test: it fails with exactly the `TypeError` the draft claims.
  The test is not a tautology.
- **Reconcile split finished-from-died correctly** — both `running -> done`
  on the presence of `pr-draft.md`.
- **Telemetry fold works.** `backfill` folded 2 placeholders into the real
  transcripts: one `sessions` row per job, `jobs.session_id` repointed. This is
  the double-count bug found in T3 and fixed inline; this is its first test
  against a real dispatch.

## What the run does not prove

- **The recovery path never fired.** Zero rate-limit events, zero resumes,
  zero stalls. `classifyStall`, the money-vs-time `needs_human` split, the
  rollover clamp, and `resumeAgentCommand` remain **untested against reality** —
  only against replayed corpus messages. A green run must not be read as
  validating them.
- **One job of two produced no fix.** 3299 was NO-REPRO: already fixed upstream
  in `4f40703e`, so the agent committed a regression test instead and reported a
  *different* live defect (ZWJ / VS16 clusters break `_split_cells`' additivity
  assumption) for separate triage. Correct behaviour, but it means the sample of
  "agent fixes a real bug unattended" is n=1, not n=2.
- **4207's fix is unverified where it matters.** The agent could not reproduce
  the failure headlessly — the drop is in the browser-side `msg_id` hook — so
  the fix is argued from removing a documented-unreliable mechanism, not from a
  browser repro. It says so in the draft. A human must run it in JupyterLab.
- **n=2, one repo, one model.** No variance estimate.

## The number that matters

`approval_wait_ms = 0` on both jobs.

The gate analysis put human approval and think time at **49.3%** of active
session time, and named that — not rate limits — as the real bottleneck. Two
sessions totalling 17m04s of service time spent none of it waiting on a human.
That is the whole thesis of the project, and it is the one thing this run
demonstrates cleanly.

Rate limits stayed as rare as the gate predicted: 0 events in 17 minutes at k=2,
against a corpus rate of 25 events / 48 days.

## Defects and gaps found by this run

1. **`--max-jobs 0` is rejected**, so there is no reconcile-only invocation.
   Had to abuse `--repo none/none`. One-line fix: allow 0 for `--max-jobs`
   (keep `--wip` positive).
2. **`PRICE_PER_MTOK` is still hand-entered and unverified**, and this run makes
   it expensive to be wrong: $30.72 claimed for two issues, dominated by 9.7M
   cache-read tokens. Order of magnitude looks plausible; the digits are not
   evidence. Replace with real billing figures before any cost claim is made.
3. **Agents' own diff arithmetic drifted** from `git`'s (4207 reported
   "16 insertions / 3 deletions" and "44 lines" against an actual 15/4 and 48).
   Harmless because the dispatcher measures independently — which is exactly why
   it should keep doing so.

## Verdict

The daemon half works end to end unattended. The half that handles things going
wrong has still never had anything go wrong to handle.
