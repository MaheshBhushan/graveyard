# graveyard

Runs the graveyard shift so you don't have to.

A scheduler for unattended coding agents. Queue up GitHub issues, walk away, and
come back to one opened pull request per issue — each fixed and tested in its own
throwaway checkout, pushed to your fork, with the issue thread notified.

**This pushes for real.** Each agent runs the full contribution loop via the
[`ferb`](#skill-dependency-ferb) skill and ships: fork, branch, push, `gh pr
create`, issue comment. There is no human between the agent and the repo. What
stands in for review is ferb's own go/no-go gate, which is biased toward
declining, and its rule that a fix without a regression test doesn't ship.

```
$ gm add --from-gh Textualize/rich
$ gm dispatch --live --wip 2
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
   off, on `claude-opus-5` at `--effort low`. Low is deliberate: this session is
   an orchestrator, and `ferb` dispatches its own phases at their own models and
   efforts.
4. **Work** — the agent drives `ferb`: go/no-go, analyse, reproduce, fix, test,
   adversarial review, then fork, push, `gh pr create`, issue comment. Its last
   act is writing a run record to `pr-draft.md` — outcome, PR URL, test
   evidence. That file's existence is the completion signal.
5. **Reconcile** — the next `dispatch` classifies each job: session gone plus a
   record means done; gone without one means work out why. Diffs are re-measured
   with `git diff --numstat` rather than believed from the agent.
6. **Tick** — `dispatch` is one-shot: it reconciles, launches up to `--max-jobs`,
   and exits. A systemd user timer calls it every 10 minutes, which is what keeps
   the queue draining after the first agent finishes. Without the timer the fleet
   stalls at whatever one invocation started. See [`deploy/`](deploy/).
7. **You** — read the run records and the PRs that are already open.

### Guardrails, and what's left of them

Still enforced by the code: worktree isolation per job, a WIP limit, launch caps,
resume caps, and an inert-by-default dispatch that needs `--live` to invoke a
real model. `--live` also refuses to start if the `ferb` skill isn't installed,
rather than letting an unattended agent improvise its own contribution loop.

Still instructed, and load-bearing: push to a **fork**, never to upstream and
never to `main`; no AI attribution in commits, PR bodies, or issue comments;
don't invent scope.

**Weakened by shipping unattended:** the per-repo file/line ceilings. graveyard
re-measures the diff, but the agent pushes before that check runs, so an
oversized PR is already public by the time the ceiling notices. The ceiling is
now a strong hint to the agent, not a gate. Treated honestly rather than quietly.

An agent that can push unattended can embarrass you on someone else's repo at
3am. That is the trade this configuration makes on purpose.

## Skill dependency: `ferb`

**Required.** graveyard's dispatch prompt does not describe how to fix an issue;
it delegates the entire contribution loop to the `ferb` skill and only adds
adaptations for running unattended in a worktree (use the pre-made branch, push
to a fork rather than upstream, write the run record last).

Install it at:

```
~/.claude/skills/ferb/SKILL.md
```

`gm dispatch --live` checks for that path and exits non-zero if it's missing.
Set `MK_FLEET_AGENT_CMD` to launch something else instead and the check is
skipped.

What ferb contributes that graveyard deliberately does not reimplement:

- a **Phase 0 go/no-go gate** biased toward declining — platform-specific bugs
  that can't be reproduced on this machine, already-claimed issues, undecided
  maintainer threads, repos that ban AI contributions, and dead repos are all
  hard stops before any code is written;
- a regression test as a non-optional shipping requirement;
- an adversarial `critic` pass over the diff before the PR opens;
- per-phase model and effort assignment, and its own escalation rules.

That gate is the main thing standing between an unattended fleet and a pile of
noise in someone's issue tracker, which is why it's a hard dependency and not a
soft one.

## Honest status

The scheduler works end to end, at n=2. First live run is written up in
[`analysis/run-01.md`](analysis/run-01.md).

**What's proven.** WIP limits hold. Worktree isolation holds. Diff ceilings hold
under independent re-measurement. Reconcile separates finished from died. Both
jobs recorded `approval_wait_ms = 0`, which is the entire thesis.

**What isn't.**

- **The shipping path has still never executed.** The ferb delegation has run live
  once ([`analysis/run-02.md`](analysis/run-02.md)) and correctly returned NO-GO at
  Phase 0 — nothing pushed, nothing posted, verified against GitHub. So the gate is
  demonstrated, but fork creation, `git push`, `gh pr create`, and the issue
  comment are wired and reviewed and have **never run once**. That run tested the
  brake, not the engine.
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

Needs [Bun](https://bun.sh), `git`, `tmux`, an authenticated `gh`, an agent CLI on
`PATH`, and the [`ferb` skill](#skill-dependency-ferb) installed. No npm
dependencies — SQLite comes from `bun:sqlite`.

```
git clone https://github.com/MaheshBhushan/graveyard
cd graveyard
bun test
ln -s "$PWD/bin/gm" ~/.local/bin/gm     # the `gm` shortcut
```

### The tick

```
cp deploy/graveyard.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now graveyard.timer     # arms a paid, unattended loop
```

Both caps still apply per tick, so the fleet fills to the WIP limit one job at a
time rather than launching several paid agents at once. Edit the `PATH=` line in
the service if `claude` and `gm` don't live in `~/.local/bin` on your machine —
a systemd user unit gets a minimal environment, and the agent's tmux session
inherits it, so a missing `PATH` entry shows up as a launch that succeeds with an
agent that was never found.

Arm it last, and only after one supervised `--live` run: the timer's whole job is
to spend money and act publicly without asking.

`bin/gm` resolves through the symlink, so the repo can live anywhere and `gm`
works from any directory:

```
$ gm status
queued   0
running  0
done     0
failed   0
blocked  0
total    0
```

State lives in SQLite at `~/.local/share/mk-fleet/fleet.sqlite`, overridable
per-invocation with `--db <path>`. A fresh install reports zeros until you queue
something with `gm add`.

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
