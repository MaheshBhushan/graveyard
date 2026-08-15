# Run 02 — first live run of the shipping configuration (supervised)

**2026-08-15, 21:29:49–21:31 CEST.** One job, supervised, `--wip 1 --max-jobs 1`,
on the ferb-delegating prompt that can push and open PRs.

```
gm dispatch --live --wip 1 --max-jobs 1
```

## Result: NO-GO at ferb Phase 0, nothing posted

| | rich#4199 |
|---|---|
| wall clock | 69 s |
| turns | 21 |
| model / effort | claude-opus-5 / low |
| outcome | NO-GO (Phase 0 gate) |
| files changed | 0 |
| commits | 0 |
| fork created | no |
| branch pushed | no |
| PR opened | no |
| issue comment posted | no |
| approval wait | 0 ms |
| cost estimate | $2.36 |

The issue — "Fix ambiguous-width character handling for CJK terminals" — is a
design question, not a defect. The reporter wrote it as a PR description, then
walked their own patch back in a comment asking maintainers for direction, and no
maintainer had replied. ferb Phase 0 lists *maintainer-has-not-decided* and
*scope-exceeds-rules (public API change)* as hard blockers, so it stopped before
setup.

## Independently verified, not taken from the run record

Every public-side claim was checked against GitHub and git directly:

- **Issue comment count: 1 before the run, 1 after.** Nothing was posted. ferb's
  rule against posting a "cannot fix" note to a public thread held.
- **No fork of `Textualize/rich`** exists under the account (`gh repo list --fork`).
- **No PR** on `Textualize/rich` authored by the account, any state.
- **Worktree clean, zero commits** ahead of `origin/main`, and no `fork` remote
  was added.
- **Its prior-art claim was true.** It cited PR #3686 as closed unmerged;
  `gh pr view 3686` confirms `state=CLOSED`, `mergedAt=null`,
  author `shyam-ramani`, head `fix/unicode-table-alignment`. It found a real
  earlier rejected attempt in the same area, which is the strongest single
  argument in its verdict.
- **Reconcile** classified the job `running -> done` on the run record's presence.
- **Telemetry fold** produced exactly one `sessions` row for the job, not two.

## What this run proves

**The gate is real, and it is the load-bearing part.** Given push rights, no
supervision, and an issue that superficially looks like an easy width fix with a
patch already written in the body, the agent declined and posted nothing. It also
worked out that the literal fix suggested in the issue would break every non-CJK
user — returning 2 for EAW=Ambiguous mis-pads `…`, `°`, `±`, `→`, Cyrillic, Greek
and box-drawing — and noticed that `rich/cells.py` already hardcodes some of those
as single-cell, so the proposed patch contradicts a deliberate table in the same
file.

That is the failure mode this whole configuration risks: a confident, wrong,
public PR. It didn't happen, and it didn't happen at the gate rather than by luck.

**A decline is cheap.** $2.36 and 69 seconds, versus ~$15–30 for a full fix run.
Phase 0 being a read-only pass is what makes a NO-GO-biased gate affordable
enough to keep.

## What this run does NOT prove

**The shipping path is still completely unexercised.** Fork creation, the `fork`
remote, `git push`, `gh pr create --head <user>:<branch>`, and the issue comment
have now been *wired and reviewed* but have still **never executed once**. This
run tested the brake, not the engine.

Concretely, these remain unverified against reality:

- whether `gh repo fork` + cross-fork `gh pr create` actually work from inside a
  worktree whose `origin` is upstream (the specific breakage this addendum exists
  to prevent);
- whether the PR body and commit come out free of AI attribution;
- whether an agent respects the file/line ceiling now that nothing enforces it
  before the push.

**The recovery half also still has zero real firings** — no rate limit, no stall,
no resume, three live runs in.

## Consequence for arming the tick

`deploy/graveyard.timer` is installed but disabled. Arming it now means the first
real execution of the fork/push/PR path happens **unattended**, because this
supervised run never reached it.

Two honest options:

1. Arm it and accept that the shipping path's debut is unsupervised. The
   mitigations are ferb's gate (demonstrated working here), the fork-only push,
   and the fact that a PR can be closed and a branch deleted.
2. Queue an issue likely to pass Phase 0 — a small, reproducible, maintainer-
   acknowledged bug — and supervise one GO end to end first. The four issues left
   in the queue are all labelled `[BUG]` and are better candidates than #4199 was.

Option 2 costs one more supervised run and removes the only remaining untested
public code path. Recommended.
