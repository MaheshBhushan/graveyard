# Issue-to-pull-request process

[issue-to-pr.bpmn](issue-to-pr.bpmn) documents graveyard's issue-to-PR workflow.
Import the file into a BPMN 2.0 modeler that supports BPMN Diagram Interchange.
The expanded contribution subprocess shows assessment, reproduction, fixing,
testing, adversarial review and publication. Each task has an attached timing
annotation. The model is descriptive and has `isExecutable="false"`.
The XML uses the namespaces and diagram interchange format from the
[OMG BPMN 2.0.2 specification](https://www.omg.org/spec/BPMN/2.0.2/).

## Regenerate from the SQLite job log

```bash
bun run src/process-model.ts --db ~/.local/share/mk-fleet/fleet.sqlite > issue-to-pr.bpmn
# Equivalent package script; the default database is the same path:
bun run process-model > issue-to-pr.bpmn
```

The exporter opens an existing database read-only, reads a consistent transaction
snapshot and writes XML to stdout. It performs no migrations, job dispatch,
run-record reads or GitHub requests. A missing database or required jobs schema
produces a nonzero exit and an error on stderr. `--help` explains the command.
Keep the output path separate from the database path.

## Recorded measurements

The checked-in model was exported on 2026-10-18 from the local `fleet.sqlite` job
log. Its documentation element records the exact export time and row counts.
The source contains four jobs from 2026-08-16. All four have `attempts=1` and
`resume_count=0`. All four have state `done`. The database has no
`pull_requests` table. These measurements describe those stored jobs; they do
not establish PR throughput or distinguish live agents from custom/dry agents.
The job table does not record that distinction.

| Interval | Source | n | Median (ms) | p95 (ms) | Maximum (ms) |
| --- | --- | ---: | ---: | ---: | ---: |
| Queue plus dispatch delay | `jobs.started_at - jobs.queued_at` | 4 | 66,247 | 926,853 | 926,853 |
| Observed run elapsed | `jobs.ended_at - jobs.started_at` | 4 | 129,038 | 581,663 | 581,663 |
| Launch to first verified PR | `pull_requests.created_at - jobs.started_at` | 0 | unavailable | unavailable | unavailable |
| Individual phase waits, parking and reconciliation lag | No transition timestamps | 0 | unavailable | unavailable | unavailable |

The following read-only query retrieves the source timestamps for an independent
recalculation. The exporter calculates intervals in TypeScript using UTC-aware
timestamp parsing.

```sql
SELECT job_id, state, queued_at, started_at, ended_at, attempts, resume_count
FROM jobs
ORDER BY queued_at;
```

The median averages the two central values for even sample sizes. The p95 uses
nearest rank (`ceil(0.95 * n)`). All durations use milliseconds. Missing,
unparseable, timezone-free and reversed intervals are excluded. An empty
sample produces `n=0` and `unavailable`; it never produces a zero duration.

`started_at` is written after worktree preparation and tmux launch. Queue delay
therefore includes preparation and launch overhead. A job's initial wait cannot
be recovered after retries or resumes overwrite `started_at`. The exporter
excludes jobs with `attempts != 1` or `resume_count != 0` from all intervals.
Missing counters in older schemas also exclude those rows. Manual requeue resets
the counters without updating `queued_at`; such rows cannot be distinguished
from first launches, so their delay may include time before the manual requeue.

Only terminal jobs (`done`, `failed`, `blocked`) contribute run elapsed time.
`ended_at` records when reconciliation observes completion. This interval
includes active work and observation lag. A supervisor tick or supervisor downtime
can increase that lag. The model attaches this aggregate to the contribution
subprocess and does not distribute it among individual phases.

When the PR table exists, the exporter uses the earliest valid `created_at`
for each eligible job and matching repository. It requires a non-null PR state,
which the outcome synchronizer writes after GitHub verifies the repository and
branch. PRs before launch and orphan PRs left after queue cleanup are excluded.
This interval includes earlier phases and does not measure publication wait.

## Process paths and evidence

- `src/queue.ts` inserts each issue once using a deterministic ID. The supervisor
  dispatches queued work when a WIP slot becomes available.
- `src/dispatch.ts` checks repository configuration and the source clone,
  creates a worktree, launches the agent and records `started_at`. Setup failures
  produce a blocked job.
- `prompts/dispatch-agent.md` delegates assessment and contribution to `ferb`.
  NO-GO, ASK, no reproduction and other justified stops write a final run record
  without opening a PR. Passing tests and review lead to a fork push, PR creation
  and issue comment before the final record.
- Reconciliation requires the session to disappear and the run record to exist.
  It measures the diff independently. A missing diff or breached ceiling can
  block a job after a PR has already opened. `done` means the record passed these
  checks; it does not prove publication.
- The interrupting boundary event represents a vanished session without a final
  record. Reconciliation classifies it, parks transient stalls, resumes the
  existing worktree when eligible, retries ordinary deaths within the attempt
  cap, or stops for human action/exhausted caps. A missing resume worktree or
  failed resume launch also stops the job. The diagram groups these stop paths.
  The boundary event documents this classification and does not imply a BPMN
  engine receives an error from the agent.
- Failed tests and requested review changes loop to the fix. Any justified stop
  can finish with a run record. The phase diagram summarizes the instructed
  workflow; SQLite does not prove that each phase ran for every job.

## Optimization opportunities

The longest observed queue-plus-dispatch delay was 926,853 ms, compared with a
66,247 ms median across four jobs. Inspect WIP occupancy, supervisor uptime and
preparation overhead before changing concurrency. These timestamps cannot
separate those causes, and four observations cannot establish a stable trend.

The next useful instrumentation would record immutable transition timestamps
for queue entry, preparation, phase starts/ends, park/resume, agent exit and
reconciliation. That would separate waiting from active work and preserve retry
history. The current export leaves those measurements unavailable. It does not
add instrumentation or change scheduler behavior.

## Verification

```bash
bun test test/process-model.test.ts
```

The tests use synthetic in-memory SQLite rows to check interval selection,
percentiles, missing data and PR deduplication. Synthetic values never enter the
checked-in model. The tests also parse both generated and checked-in XML with
Python 3's standard library, verify graph references and diagram coverage, and
check that the CLI leaves its database unchanged and refuses missing files.
