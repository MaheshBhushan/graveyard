# Specification-to-test task contracts

A task contract stores a specification, acceptance criteria and executable checks.
Each criterion references one or more check IDs. Every check must belong to a
criterion. A criterion passes only when all its checks exit zero without a
timeout or execution error.

Create a JSON file such as `contract.json`:

```json
{
  "specification": "Reject a queue entry whose acceptance criteria reference an unknown check.",
  "max_iterations": 3,
  "criteria": [
    {
      "id": "valid-links",
      "description": "Unknown check references fail validation before enqueue.",
      "checks": ["contracts"]
    }
  ],
  "checks": [
    {
      "id": "contracts",
      "command": ["bun", "test", "test/contracts.test.ts"],
      "timeout_ms": 30000
    }
  ]
}
```

Queue one issue with the contract attached in the same database transaction:

```bash
gm add --repo owner/repo --issue 42 --title "Validate check links" --contract contract.json
```

This prevents a supervisor from launching the task before its contract exists.
Bulk `--from-gh` does not accept `--contract`. To attach a contract to an existing
queued job, use `gm contract owner__repo-42 --file contract.json`.
Contracts remain immutable after attachment. A changed specification requires
a separate task. Invalid contracts roll back enqueueing.

The dispatcher includes the contract and the verification command in the agent
prompt. After committing a change, run verification inside its clean Git worktree:

```bash
gm verify owner__repo-42 --cwd /path/to/worktree --effort-ms 180000 --db /path/to/fleet.sqlite
gm contract owner__repo-42 --db /path/to/fleet.sqlite
```

`verify` prints JSON to stdout and progress to stderr. It runs argv arrays directly
without a shell. The working directory must match the job's assigned worktree
when one exists. A check defaults to a 30-second timeout and cannot exceed it.
Checks run sequentially and retain the last 8,000 characters of output per check.
Only attach executable commands that you intend to run in that checkout.

Each verification appends an iteration with the criterion results, command argv,
exit codes, timeouts, errors, output, timestamps, elapsed verification time, session
identity and Git commit. `reported_effort_ms` stores optional implementation effort
since the preceding verification. It remains null when omitted. Elapsed time
measures verification work; it does not measure implementation effort or code
quality. The history supports comparison of generated revisions against the
specified behavior. Check coverage determines the strength of that comparison.

The decision follows these rules:

- `complete`: all criteria passed and the worktree stayed clean at the same commit.
- `retry`: verification failed and the iteration budget permits another attempt.
- `stop`: verification failed at the iteration limit, or the operator supplied
  `--stop-reason "reason"` to end work deliberately.

`verify` exits zero only for `complete`. Repair the change, commit it and verify
again after `retry`. A `stop` closes the verification budget. The default budget
is three iterations; contracts accept values from one to twenty. A timed-out or
missing executable produces failing evidence. Invalid inputs and a dirty initial
worktree fail before creating an iteration.

Before shipping, the agent must obtain `complete` for its final commit. The
dispatcher blocks completion when the latest evidence failed, belongs to another
session/worktree, or became stale after a change. It does not prevent an agent
from publishing through another tool before reconciliation. A declined task with
an unmet contract remains blocked for inspection.

SQLite retains contracts and iteration history through queue clear and requeue.
Requeue does not reset the contract's verification budget. `gm contract <job-id>`
can read archived history after a job leaves the queue. Jobs without an attached
contract keep their existing completion behavior.
