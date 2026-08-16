<h1 align="center">graveyard</h1>
<p align="center">Runs the graveyard shift so you don't have to.</p>

<p align="center">
  <a href="https://github.com/MaheshBhushan/graveyard/actions/workflows/test.yml"><img alt="tests" src="https://github.com/MaheshBhushan/graveyard/actions/workflows/test.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/github/license/MaheshBhushan/graveyard"></a>
  <a href="https://github.com/MaheshBhushan/graveyard/commits/main"><img alt="last commit" src="https://img.shields.io/github/last-commit/MaheshBhushan/graveyard"></a>
  <a href="https://bun.sh"><img alt="runtime" src="https://img.shields.io/badge/runtime-bun-black"></a>
  <img alt="runtime dependencies" src="https://img.shields.io/badge/runtime%20deps-0-brightgreen">
</p>

<p align="center">
  <a href="#why">Why</a> ·
  <a href="#watching-it">Watch</a> ·
  <a href="analysis/gate.md">Gate analysis</a> ·
  <a href="analysis/run-01.md">Run 01</a> ·
  <a href="analysis/run-02.md">Run 02</a> ·
  <a href="#honest-status">Honest status</a> ·
  <a href="#install">Install</a>
</p>

A scheduler for unattended coding agents. Queue up GitHub issues, walk away, and
come back to one pull request per issue — each fixed and tested in its own
throwaway checkout, pushed to your fork, with the issue thread notified.

`gm watch`, rendered from the live database — six real declines, none of them
mine to overrule:

```
╭─ graveyard ────────────────────────────────────╮
│  wip 0/3   queued 0   done 8   go 0   no-go 6  │
╰────────────────────────────────────────────────╯
  ✔ rich#4183           [BUG] attribute names `awehoi234_wdfjw…  NO-GO   9m21s
  ✔ rich#4192           [BUG] Live outputs different amounts o…  NO-GO   9m28s
  ✔ rich#4194           [BUG] When highlighting keywords, rich…  NO-GO   7m11s
  ✔ rich#4196           [BUG] Line breaking breaks at NBSP (U+…  NO-GO   7m36s
❯ ✔ rich#4199           Fix ambiguous-width character handling…  NO-GO   1m55s
   … 1 more (↓ to reach)
 │ verdict     NO-GO
 │ reason      Undecided design question, not a defect. The reporter
 │             explicitly asked maintainers for direction and no maintainer
 │             has replied; the only correct fix is a public API /
 │             configuration change, which ferb rule 4 bars.
 │ blockers    maintainer-has-not-decided; not-actually-a-bug (design
 │             discussion); scope-exceeds-rules (public API change);
 │             correctness not test-checkable here
 │ effort      heavy
 │ confidence  low
 Textualize__rich-4199/agent.log 17-19/19 ──────────────────────────────────
   - Latent trap for whoever does implement it: `_SINGLE_CELL_UNICODE_RANG… │
                                                                            │
   Run record written to `/home/maheshk/.local/share/mk-fleet/runs/Textual… █
 ↑↓ select   wheel scroll   g/G top/end   l log/record   space pause   q quit
```

> [!WARNING]
> **This pushes for real.** Each agent runs the full contribution loop via the
> [`ferb`](#skill-dependency-ferb) skill and ships: fork, branch, push, `gh pr
> create`, issue comment. There is no human between the agent and the repo. What
> stands in for review is ferb's go/no-go gate, which is biased toward declining,
> and its rule that a fix without a regression test doesn't ship. An agent that
> can push unattended can embarrass you on someone else's repo at 3am. That is
> the trade this configuration makes on purpose.

## Why

Because half of "agent working" is actually "agent waiting on a human."

Before building any of this, I mined 435 real Claude Code sessions from 48 days
of transcripts to find out where the time actually goes:

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
`VERDICT: NO-GO`. Spend figures are published there too, because the measurement
is the most useful thing in this repo.

## How it works

1. **Queue** — `gm add --from-gh` pulls open issues matching a repo's bug labels
   into SQLite. Job ids are deterministic, so re-running never duplicates.
2. **Isolate** — each job gets its own `git worktree` on its own branch off
   `origin/main`. Two agents can't collide because they aren't in the same files.
3. **Launch** — the agent runs in a detached tmux session with approvals off, on
   `claude-opus-5` at `--effort low`. Low is deliberate: this session is an
   orchestrator, and `ferb` dispatches its own phases at their own models.
4. **Work** — the agent drives `ferb`: go/no-go, analyse, reproduce, fix, test,
   adversarial review, then fork, push, `gh pr create`, issue comment. Its last
   act is writing a run record to `pr-draft.md`. That file's existence is the
   completion signal.
5. **Reconcile** — the next `dispatch` classifies each job: session gone plus a
   record means done; gone without one means work out why. Diffs are re-measured
   with `git diff --numstat` rather than believed from the agent.
6. **Refill** — `gm start` runs a supervisor that repeats steps 2–5 on a tick.
   A job ending frees a WIP slot the next tick fills, so the queue drains on its
   own. It keeps running after the queue empties, so a later `gm add` is picked
   up without restarting anything. `gm stop` ends the loop; agents already
   launched finish rather than being killed with tokens spent.
7. **You** — read the run records and the PRs that are already open.

## Watching it

```
$ gm watch
```

The verdict column is the point. ferb's Phase 0 decides whether an issue is worth
acting on at all, and that decision is the most interesting thing the fleet
produces — more so than the diffs, because a decline costs ~$2 and a wrong PR
costs a maintainer's afternoon.

To make it visible *while a job runs* rather than only in the final report, the
dispatch prompt tells the agent to write its verdict block to `phase0.md` the
moment Phase 0 decides, before anything else. `watch` polls that file and falls
back to parsing the run record for jobs that predate it.

`l` toggles the bottom pane between the live `agent.log` and the finished run
record. Elapsed time is measured from launch to when `reconcile` *observed* the
job finish, so with the supervisor running it can overstate by up to one tick.

**Scrolling.** The view runs on the alternate screen, so the terminal's own
scrollback is gone while it's open. The job list is a window you move with the
arrow keys — it follows the selection and says how many rows are below the fold.
The log pane is the one you actually scroll: mouse wheel, `PgUp`/`PgDn`, and
`g`/`G` for top and end, with a bar showing where you are. It sticks to its
newest line until you deliberately scroll away; `G` re-attaches it. Both panes
resize with the terminal.

## Honest status

The scheduler works end to end, at n=2. Write-ups:
[run 01](analysis/run-01.md) (dispatch), [run 02](analysis/run-02.md) (ferb).

**What's proven.** WIP limits hold. Worktree isolation holds. Diff ceilings hold
under independent re-measurement. Reconcile separates finished from died. Both
jobs recorded `approval_wait_ms = 0`, which is the entire thesis.

**What isn't.**

- **The shipping path has never executed.** The ferb delegation has run live once
  and correctly returned NO-GO at Phase 0 — nothing pushed, nothing posted,
  verified against GitHub. The gate is demonstrated; fork creation, `git push`,
  `gh pr create`, and the issue comment are wired and reviewed and have **never
  run once**. That run tested the brake, not the engine.
- **The failure-handling half has never run.** Stall detection, resume, and the
  "out of credit, wake a human" branch have fired zero times against reality.
  Tested against replayed transcripts only. Nothing here is production-ready.
- **The economics are unproven.** Roughly $30 of estimated tokens for two issues,
  and the per-token prices are hand-entered, not verified against a bill.
- **One of those two issues needed no fix at all.** Already fixed upstream; the
  agent correctly reported NO-REPRO, added the missing regression test, and
  flagged a separate live defect instead of inventing work. Good behaviour, but
  the sample of "unattended agent fixed a real bug" is n=1.
- Untested beyond one repo, one model, and two concurrent jobs.

**Guardrails, and what's left of them.** Still enforced by code: worktree
isolation, WIP limit, launch caps, resume caps, and an inert-by-default dispatch
that needs `--live` to invoke a real model. Still instructed, and load-bearing:
push to a **fork**, never upstream and never `main`; no AI attribution anywhere.
**Weakened by shipping unattended:** the per-repo file/line ceilings. graveyard
re-measures the diff, but the agent pushes before that check runs, so an
oversized PR is already public by the time the ceiling notices. It is now a
strong hint to the agent, not a gate.

## Skill dependency: `ferb`

**Required.** graveyard's dispatch prompt does not describe how to fix an issue —
it delegates the whole contribution loop to the `ferb` skill and only adds
adaptations for running unattended in a worktree. What ferb owns and graveyard
deliberately does not reimplement: the Phase 0 go/no-go gate biased toward
declining, a regression test as a non-optional shipping requirement, an
adversarial `critic` pass before the PR opens, and per-phase model assignment.

Install it at `~/.claude/skills/ferb/SKILL.md`. `gm dispatch --live` checks that
path and exits non-zero if it's missing, rather than letting an unattended agent
improvise its own contribution loop. Set `MK_FLEET_AGENT_CMD` to launch something
else and the check is skipped.

## Config dependency: `repos.yaml`

**Required, and not in this repo.** graveyard refuses to dispatch any repo it has
no entry for — that refusal is the outermost guardrail, and it is why a fresh
clone blocks every job you give it:

```
warning: Textualize/rich has no entry in .../config/repos.yaml
         it will be queued but blocked at dispatch, never run.
```

An entry supplies the base branch, the test command, the diff ceilings, and
optionally a branch-name convention. graveyard grew out of
[bugfix-loop](https://github.com/MaheshBhushan/bugfix-loop) and by default reads
that project's copy from a sibling directory, rather than keeping a second set of
ceilings that can disagree with the first. Both paths are env-overridable:

| variable | default | holds |
|---|---|---|
| `MK_FLEET_REPOS_YAML` | `../bugfix-loop/config/repos.yaml` | the allowlist and ceilings |
| `MK_FLEET_REPOS_DIR` | `../bugfix-loop/repos` | source clones, one per `<owner>__<name>` |

`gm status` prints both, and flags either as `MISSING`. A leading `~` is
expanded, so these work in a shell profile or a systemd unit.

```yaml
Textualize__rich:
  url: https://github.com/Textualize/rich
  default_branch: main                 # base ref; resolved as origin/<this>
  test_command: .venv/bin/pytest tests/ -vv
  bug_labels: [bug, Needs triage]      # what `gm add --from-gh` searches
  max_files_changed: 2                 # over this after the run -> blocked
  max_lines_changed: 50
  max_prs_per_week: 3
  # branch_pattern: issue-{n}          # default is fix/issue-{n}. set this for
                                       # repos whose docs ban slashes or prefixes
```

You also need a clone of each repo at `$MK_FLEET_REPOS_DIR/<owner>__<name>`.
graveyard only reads it and adds worktrees to it; it never fetches or commits
there.

## Install

Needs [Bun](https://bun.sh), `git`, `tmux`, an authenticated `gh`, an agent CLI on
`PATH`, the [`ferb` skill](#skill-dependency-ferb), and a
[`repos.yaml`](#config-dependency-reposyaml). No runtime dependencies and no
install step — SQLite comes from `bun:sqlite`, and the only devDependency is
`@types/bun`.

```bash
git clone https://github.com/MaheshBhushan/graveyard
cd graveyard
bun test                                    # no install step
ln -s "$PWD/bin/gm" ~/.local/bin/gm         # must be on your PATH
ln -s "$PWD/bin/gm" ~/.local/bin/graveyard  # same tool, longer name
```

`bin/gm` resolves through the symlink, so the repo can live anywhere — including
a path with spaces — and `gm` works from any directory. Then, three commands in
this order:

```bash
gm add https://github.com/Textualize/rich/issues/4196   # paste a URL
gm start                                                # work the queue, live
gm watch                                                # see what it's doing
```

`gm start` returns immediately and leaves a supervisor running in its own
session, so closing the terminal doesn't kill it. From then on the queue drains
by itself: it holds the WIP limit and refills a slot within seconds of a job
ending. It keeps idling afterwards, and a later `gm add` signals it to dispatch
immediately rather than waiting out the tick. `gm stop` ends the loop and leaves
running agents alone.

> [!WARNING]
> `start` is **live by default** — it spends tokens and opens real PRs. Use
> `gm start --dry` to run the same loop against no-op agents first.

The rest:

```bash
gm add Textualize/rich#4196        # short form
gm add --from-gh Textualize/rich   # bulk: every open issue with a bug label
gm list                            # the queue, non-interactive
gm status                          # counts by state
gm clear                           # drop finished jobs from the queue
gm stop                            # stop the supervisor
gm dispatch --live                 # one pass, no loop (what `start` runs on a tick)
```

Adding by URL looks the title up through `gh`, and re-adding the same issue in
any form collides on the same deterministic job id rather than queueing it
twice. Every command also answers to `graveyard` if you'd rather type it out.

`gm clear` drops everything finished — done, failed and blocked — so the queue
shows only what's still ahead of you. It refuses to touch a `running` or
`parked` job, since one has a live agent behind it and the other is waiting to
resume into its existing worktree. Run records under `runs/<job>/` are kept by
default, because the Phase 0 verdicts and reports in them are the output of
having run at all; `--purge` removes those too. `--dry-run` lists first, and
`--state done` narrows it.

State lives in SQLite at `~/.local/share/mk-fleet/fleet.sqlite`, overridable with
`--db <path>`.

### Surviving a reboot

`gm start` is enough for a session. To have the fleet come back on its own:

```bash
cp deploy/graveyard.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now graveyard      # arms a paid, unattended loop
```

The unit runs `gm start --foreground`, so it is the same supervisor — don't run
both. Edit the `PATH=` line if `claude` and `gm` don't live in `~/.local/bin`: a
systemd user unit gets a minimal environment and the agent's tmux session
inherits it, so a missing entry shows up as a launch that succeeds with an agent
that was never found.

Enable it last, and only after watching one live run: its whole job is to spend
money and act publicly without asking.

## Layout

```
bin/gm                 launcher; resolves through its own symlink
prompts/               the dispatch prompt — delegates to ferb, adds 6 addenda
deploy/                systemd user service, for surviving a reboot
schema.sql             job queue and telemetry tables
src/telemetry.ts       transcript parsing, session derivation, quota classification
src/backfill.ts        corpus -> sqlite (read-only on the corpus, idempotent)
src/queue.ts           durable job queue
src/dispatch.ts        worktrees, tmux launch, reconcile, diff ceilings
src/recover.ts         stall classification and resume decisions
src/render.ts          terminal rendering (pure, snapshot-tested)
src/supervisor.ts      the `start` loop: tick, refill, pidfile, stop
src/watch.ts           live TUI: phase 0 verdicts + log pane
test/                  52 tests over the renderers, parsers, refs and the queue
analysis/              the go/no-go gate, and the two live runs
```

The CLI and internals still carry the project's working name, `mk-fleet`.

## License

MIT. Issues and questions:
[github.com/MaheshBhushan/graveyard/issues](https://github.com/MaheshBhushan/graveyard/issues).
