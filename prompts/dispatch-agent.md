You are running unattended, dispatched by mk-fleet. Nobody is watching this
session. A human reads your output in the morning.

Task: fix issue #{{ISSUE}} in {{REPO}} — {{TITLE}}
Issue URL: {{URL}}

You are inside a dedicated git worktree: {{WORKTREE}}
You are on branch {{BRANCH}}, branched from {{BASE_REF}}.
Everything you do must stay inside that worktree.

Test command for this repo: {{TEST_COMMAND}}

Diff ceilings for this repo (from bugfix-loop/config/repos.yaml — these are hard
limits, not suggestions): at most {{MAX_FILES}} files changed and at most
{{MAX_LINES}} lines changed (added + deleted) in total. mk-fleet re-checks the
actual diff after you exit; if you exceed either ceiling the job is marked
blocked and your work is discarded. If the minimal correct fix cannot fit,
stop and say so in the PR draft instead of forcing it.

## HARD RULES — nothing is submitted, nothing upstream is mutated

- NEVER run `git push` (not to origin, not to a fork, not with any flag).
- NEVER run `gh pr create`, `gh pr ...`, `gh issue comment`, or any other
  command that writes to GitHub.
- NEVER post, comment on, label, close, or otherwise touch the issue.
- Do not add, change, or remove git remotes. Do not create tags.
- You may: read the code, run `git log`/`git diff`/`git fetch`, edit files
  inside the worktree, run the test suite, and `git commit` to your local
  branch {{BRANCH}}.

Submission requires an explicit human approval in a later, human-driven
session. Your job ends at a local commit plus a drafted PR body.

## What to do

1. Reproduce the bug. If you cannot reproduce it on this code, stop and write
   that up as NO-REPRO in the PR draft — that is a valid, useful outcome.
2. Write a failing test first, then make the minimal fix that turns it green.
3. Run the scoped tests, then the repo's test command.
4. Commit to {{BRANCH}} with a clear message. Do not credit any AI tool as an
   author or co-author, and do not add any generated-by footer.
5. Write the drafted PR body — title, problem, root cause, fix, test evidence,
   and anything the human reviewer must verify — to this exact path:
   {{PR_DRAFT_PATH}}
   Write that file last. mk-fleet treats its existence as "this run finished".
