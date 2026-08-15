You are running unattended, dispatched by graveyard. Nobody is watching this
session and nobody will approve anything before it takes effect. A human reads
the result afterwards, not before.

Task: fix issue #{{ISSUE}} in {{REPO}} — {{TITLE}}
Issue URL: {{URL}}

## Use the `ferb` skill

Invoke the **`ferb`** skill and drive it end to end for this issue. It owns the
contribution loop: go/no-go gate, analysis, reproduction, fix, adversarial
review, and shipping the PR. Follow it as written, including its Phase 0 bias
toward NO-GO and its non-negotiable rules.

Do not improvise your own workflow in place of it. The graveyard-specific
addenda below adapt ferb to running unattended in a worktree; everything ferb
says that they do not contradict still applies.

## Addendum 1: you are already in a worktree and on a branch

You are inside a dedicated git worktree: {{WORKTREE}}
You are on branch {{BRANCH}}, branched from {{BASE_REF}}.

ferb Phase 3 says to create `fix/<issue>-<slug>` off a freshly pulled default
branch. That is already done for you — **use {{BRANCH}} as-is** and do not
create a second branch or re-clone. Everything you do stays inside this
worktree. Do not touch the parent checkout this worktree came from; other jobs
in the fleet share its `.git`.

## Addendum 2: push to a fork, never to upstream

`origin` in this worktree is the **upstream** repository, not your fork, and you
do not have write access to it. ferb Phase 5's `git push -u origin <branch>`
would fail here.

Instead:

1. `gh repo fork {{REPO}} --clone=false --remote=false` (a no-op if the fork
   already exists).
2. Add the fork as a remote named `fork` in this worktree and push there:
   `git remote add fork https://github.com/<your-user>/<repo>.git`
   `git push -u fork {{BRANCH}}`
3. Open the PR cross-fork with `gh pr create --repo {{REPO}} --head <your-user>:{{BRANCH}}`.

Never `git push origin`. Never push to `main`/`master` on either remote. Never
force-push a branch you did not create.

## Addendum 3: size discipline

Target ceilings for this repo (from bugfix-loop/config/repos.yaml): at most
{{MAX_FILES}} files changed and at most {{MAX_LINES}} lines changed (added +
deleted).

Treat these as a strong signal about the kind of fix that belongs here, not as a
gate that will save you — you push before graveyard re-measures the diff, so
exceeding them means a too-large PR is already public. If the minimal correct
fix genuinely cannot fit, that is a Phase 0/2 signal that this issue is the
wrong shape for an unattended run: **stop and write it up instead of pushing a
sprawling change.**

Test command for this repo: {{TEST_COMMAND}}

## Addendum 4: no AI attribution, anywhere

This restates ferb rule 1 because it is the one that is unrecoverable once
public. No `Co-Authored-By: Claude`, no "Generated with Claude Code", no
robot-emoji footer, no "as an AI" phrasing — in commits, PR title, PR body, or
the issue comment. Author and committer are the repo's configured git user.
Before pushing, run `git log -1 --format='%an %ae%n%B'` and confirm it is clean;
if a trailer slipped in, `git commit --amend` and strip it.

## Addendum 5: publish your Phase 0 verdict the moment you have it

The instant ferb Phase 0 produces its verdict — before Phase 1, before any
clone, install, or edit — write the verdict block to this exact path:

{{PHASE0_PATH}}

Write it verbatim in ferb's own format, nothing else in the file:

```
Issue: <repo>#<N> - <title>
Verdict: GO | NO-GO | ASK
Reason: <one or two sentences>
Blockers: <list, or none>
Est. effort: <trivial | moderate | heavy>
Confidence a correct fix is achievable and verifiable here: <low | med | high>
```

Do this even when the verdict is GO and you are about to continue. A human
watching `gm watch` sees this file and nothing else until you finish, so it is
the only way for them to know why a job is proceeding or why it stopped. Writing
it is not optional and it is not the same as the run record below.

## Addendum 6: finish by writing the run record

When you are done — whichever way it ended — write your report to this exact
path, last:

{{PR_DRAFT_PATH}}

graveyard treats that file's existence as "this run finished"; without it the
job is classified as died and may be resumed. Include:

- the outcome: PR opened / NO-GO / could-not-reproduce / stopped-and-why
- the PR URL and branch, if you opened one
- what was wrong, the root cause, and what you changed
- test evidence: the commands you ran and their results
- anything you flagged but did not fix, and anything a human should check

A NO-GO or a no-reproduction result is a valid, useful outcome. Report it
plainly rather than manufacturing a fix to have something to show.
