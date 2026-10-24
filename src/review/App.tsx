// Read-only task review UI. Presentational components take plain API data so
// fixture tests can render them without a browser or server.
import { useEffect, useState } from "react";
import type { TaskReview, TestRun } from "../review-api.ts";

export function testVerdict(run: TestRun | undefined): "pass" | "fail" | "none" {
  if (!run) return "none";
  return run.checks.length > 0 && run.checks.every((c) => c.exit_code === 0 && !c.timed_out) ? "pass" : "fail";
}

export function TaskTable({ tasks, onSelect }: { tasks: TaskReview[]; onSelect?: (id: string) => void }) {
  if (tasks.length === 0) return <p>No jobs in the queue.</p>;
  return (
    <table>
      <thead><tr><th>Job</th><th>State</th><th>Attempts</th><th>Tests</th><th>Review notes</th></tr></thead>
      <tbody>
        {tasks.map((task) => {
          const latest = task.tests.at(-1);
          const verdict = testVerdict(latest);
          return (
            <tr key={task.job_id} data-job={task.job_id}>
              <td><a href={`#${encodeURIComponent(task.job_id)}`} onClick={() => onSelect?.(task.job_id)}>{task.job_id}</a>
                {task.title ? <div>{task.title}</div> : null}</td>
              <td className={`state-${task.state}`}>{task.state}</td>
              <td>{task.attempts}</td>
              <td className={verdict}>{latest ? `${verdict} (iteration ${latest.iteration}, ${latest.decision})` : "no runs"}</td>
              <td>{task.reviews.length}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function TaskDetail({ task }: { task: TaskReview }) {
  return (
    <section data-detail={task.job_id}>
      <h2>{task.job_id} <span className={`state-${task.state}`}>{task.state}</span></h2>
      {task.url ? <p><a href={task.url}>{task.url}</a></p> : null}
      {task.last_error ? <p className="fail">Last error: {task.last_error}</p> : null}
      <h3>Regression tests</h3>
      {task.tests.length === 0 ? <p>No verification runs.</p> : (
        <ol>
          {task.tests.map((run) => (
            <li key={run.iteration}>
              <span className={testVerdict(run)}>{run.decision}</span> at {run.git_commit.slice(0, 12)}: {run.reason}
              <ul>{run.checks.map((c) => (
                <li key={c.id} className={c.exit_code === 0 && !c.timed_out ? "pass" : "fail"}>
                  {c.id}: {c.timed_out ? "timed out" : `exit ${c.exit_code ?? "none"}`} ({c.elapsed_ms} ms)
                </li>
              ))}</ul>
            </li>
          ))}
        </ol>
      )}
      <h3>Review notes</h3>
      {task.reviews.length === 0 ? <p>No maintainer review notes.</p> : (
        <ul>
          {task.reviews.map((note, i) => (
            <li key={`${note.pr_number}-${i}`}>
              <a href={note.url ?? note.pr_url}>{note.repo}#{note.pr_number}</a> {note.kind} by {note.actor ?? "unknown"}
              {" "}({note.occurred_at}){note.body ? <blockquote>{note.body}</blockquote> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ReviewApp() {
  const [tasks, setTasks] = useState<TaskReview[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(() => decodeURIComponent(location.hash.slice(1)));
  useEffect(() => {
    fetch("/api/tasks").then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(setTasks, (e: Error) => setError(e.message));
  }, []);
  if (error) return <p className="fail">Failed to load tasks: {error}</p>;
  if (!tasks) return <p>Loading…</p>;
  const task = tasks.find((t) => t.job_id === selected);
  return (
    <main>
      <h1>Task review</h1>
      <TaskTable tasks={tasks} onSelect={setSelected} />
      {task ? <TaskDetail task={task} /> : null}
    </main>
  );
}
