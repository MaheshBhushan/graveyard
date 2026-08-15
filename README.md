# graveyard

Runs the graveyard shift so you don't have to.

A scheduler for unattended coding agents. Queue up GitHub issues, walk away, and
come back to one drafted pull request per issue — each written in its own
throwaway checkout, each stopping short of anything you can't take back.

Nothing is pushed. Nothing is opened upstream. Every public action is still yours.

```
$ graveyard add --from-gh Textualize/rich
$ graveyard dispatch --live --wip 2
```

```
+- fleet -------------------------+
|  wip 2/3   parked 0   queued 5  |
+---------------------------------+

 o rich#3299  [BUG] Segment._split_cells doesn't handle non-unit char...  13m24s
 o rich#4207  [BUG] `Live`s don't get refreshed after first run in Ju...   3m04s
 . rich#4199  Fix ambiguous-width character handling for CJK terminals
 . rich#4196  [BUG] Line breaking breaks at NBSP (U+00A0)
 . rich#4194  [BUG] When highlighting keywords, rich captures substrings

 `- 2 done
```

## Why

Because half of "agent working" is actually "agent waiting on a human."

Before building any of this, I mined 435 real Claude Code sessions from 48 days
of transcripts to find out where the time actually goes. The answer:

| measurement | value |
|---|---|
| human approval + think time, as a share of active session time | **49.3%** |
| mean concurrency | 1.115 |
| share of busy time spent at exactly one active session | 89.8% |
| rate-limit events | 25, over 48 days |
| rework rate | 1.3% |
| service-time CV | 1.64 |

Two things fall out of that.

**The bottleneck is you, not the model.** Half the wall clock is an agent parked
on an approval prompt, and concurrency sits at ~1 because one human can only
babysit one session. So the win isn't a faster agent — it's an agent that doesn't
need watching, times however many you can afford to run.

**Rate limits are a rounding error.** 25 events in 48 days at concurrency 1.1.
This project started life as a rate-limit-dodging fleet with a discrete-event
simulation to model quota contention. The data killed that half before a line of
it was written. See [`analysis/gate.md`](analysis/gate.md) — it ends in
`VERDICT: NO-GO`.

Publishing the analysis, spend figures and all, because the measurement is the
most useful thing in this repo.

## How it works

1. **Queue** — `add --from-gh` pulls open issues matching a repo's bug labels into
   SQLite. Job ids are deterministic, so re-running never duplicates.
2. **Isolate** — each job gets its own `git worktree` on its own branch off
   `origin/main`. Two agents can't collide because they aren't in the same files.
3. **Launch** — the agent runs in a detached tmux session with approvals turned
   off. That flag is the whole point, and the worktree is why it's survivable:
   a disposable checkout with no network write path.
4. **Work** — the agent reproduces the bug, fixes it, writes a test, runs the
   suite, commits to its branch. Its last act is writing `pr-draft.md`. That
   file's existence is the completion signal.
5. **Reconcile** — the next `dispatch` classifies each job: session gone plus a
   draft means done; gone without one means work out why. Diffs are re-measured
   with `git diff --numstat` rather than believed from the agent, and anything
   over the repo's file/line ceiling is refused.
6. **You** — read the drafts, bin the wrong ones, open the rest yourself.

### What it will not do

Hard rules, given to every dispatched agent and backed by the absence of any code
path that could break them: no `git push`, no `gh pr create`, no issue comments,
labels, or closes, no remote or tag changes.

An agent that can push unattended can embarrass you on someone else's repo at 3am.

## Honest status

It works end to end, at n=2. First live run is written up in
[`analysis/run-01.md`](analysis/run-01.md).

**What's proven.** WIP limits hold. Worktree isolation holds. Diff ceilings hold
under independent re-measurement. Reconcile separates finished from died. Both
jobs recorded `approval_wait_ms = 0`, which is the entire thesis.

**What isn't.**

- **The failure-handling half has never run.** Stall detection, resume, and the
  "out of credit, waiting won't help, wake a human" branch have fired exactly
  zero times against reality. They're tested against replayed transcripts only.
  Nothing here is production-ready.
- **The economics are unproven.** Roughly $30 of estimated tokens for two issues,
  and the per-token prices are hand-entered, not verified against a bill.
- **One of those two issues needed no fix at all.** It was already fixed
  upstream; the agent correctly reported NO-REPRO, added the missing regression
  test, and flagged a separate live defect instead of inventing work. Good
  behaviour, but it means the sample of "unattended agent fixed a real bug" is
  n=1.
- Untested beyond one repo, one model, and two concurrent jobs.

## Install

Needs [Bun](https://bun.sh), `git`, `tmux`, `gh`, and an agent CLI on `PATH`.
No npm dependencies — SQLite comes from `bun:sqlite`.

```
git clone https://github.com/MaheshBhushan/graveyard
cd graveyard
bun test
```

`dispatch` is **inert without `--live`**: it launches a no-op instead of a real
agent, so a mistyped command costs nothing. Point `MK_FLEET_AGENT_CMD` at
whatever you want launched, or pass `--live` to use the default.

The CLI and internals still carry the project's working name, `mk-fleet`.

## Layout

```
src/telemetry.ts   transcript corpus parsing, session derivation, quota classification
src/backfill.ts    corpus -> sqlite (read-only on the corpus, idempotent)
src/queue.ts       durable job queue
src/dispatch.ts    worktrees, tmux launch, reconcile, diff ceilings
src/recover.ts     stall classification and resume decisions
src/render.ts      terminal rendering (pure, snapshot-tested)
analysis/          the go/no-go gate, and the first live run
```

## License

MIT
