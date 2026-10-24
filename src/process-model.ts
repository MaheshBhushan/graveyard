// Read-only BPMN documentation export; never launches jobs or contacts GitHub.
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export interface Timing {
  n: number;
  median_ms: number | null;
  p95_ms: number | null;
  max_ms: number | null;
}

export interface ProcessTimings {
  jobs: number;
  eligible_jobs: number;
  queue: Timing;
  run: Timing;
  pr: Timing;
  has_pr_log: boolean;
}

function summarize(values: number[]): Timing {
  values.sort((a, b) => a - b);
  const n = values.length;
  return {
    n,
    median_ms: n ? (values[Math.floor((n - 1) / 2)] + values[Math.floor(n / 2)]) / 2 : null,
    p95_ms: n ? values[Math.ceil(n * 0.95) - 1] : null,
    max_ms: n ? values[n - 1] : null,
  };
}

function elapsed(start: string | null, end: string | null): number | null {
  // Require an explicit timezone so reports do not depend on the host timezone.
  const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  if (!start || !end || !timestamp.test(start) || !timestamp.test(end)) return null;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

export function readProcessTimings(db: Database): ProcessTimings {
  // One consistent snapshot, including when the supervisor is writing in WAL mode.
  return db.transaction(() => {
    const columns = new Set((db.query("PRAGMA table_info(jobs)").all() as { name: string }[]).map((c) => c.name));
    const rows = db.query(`SELECT job_id, repo, state, queued_at, started_at, ended_at,
      ${columns.has("attempts") ? "attempts" : "NULL AS attempts"},
      ${columns.has("resume_count") ? "resume_count" : "NULL AS resume_count"} FROM jobs`).all() as {
      job_id: string; repo: string; state: string; queued_at: string;
      started_at: string | null; ended_at: string | null;
      attempts: number | null; resume_count: number | null;
    }[];
    const hasPrLog = !!db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pull_requests'").get();
    const prs = hasPrLog ? db.query(`SELECT job_id, repo, created_at FROM pull_requests
      WHERE state IS NOT NULL AND created_at IS NOT NULL`).all() as {
        job_id: string; repo: string; created_at: string;
      }[] : [];
    const queue: number[] = [], run: number[] = [], pr: number[] = [];
    // started_at is overwritten on retry/resume; these rows cannot measure initial wait.
    const eligible = rows.filter((r) => r.attempts === 1 && r.resume_count === 0);
    for (const row of eligible) {
      const wait = elapsed(row.queued_at, row.started_at);
      if (wait === null) continue;
      queue.push(wait);
      if (["done", "failed", "blocked"].includes(row.state)) {
        const duration = elapsed(row.started_at, row.ended_at);
        if (duration !== null) run.push(duration);
      }
      const firstPr = prs.filter((p) => p.job_id === row.job_id && p.repo === row.repo)
        .map((p) => elapsed(row.started_at, p.created_at)).filter((ms): ms is number => ms !== null);
      if (firstPr.length) pr.push(Math.min(...firstPr));
    }
    return { jobs: rows.length, eligible_jobs: eligible.length, queue: summarize(queue),
      run: summarize(run), pr: summarize(pr), has_pr_log: hasPrLog };
  })();
}

function describe(t: Timing): string {
  return t.n ? `n=${t.n}; median=${t.median_ms} ms; p95=${t.p95_ms} ms; max=${t.max_ms} ms`
    : "n=0; unavailable (no valid observations)";
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

type Node = {
  id: string; tag: string; name: string; x: number; y: number; w: number; h: number;
  note?: string; agent?: boolean;
};
type Flow = { from: string; to: string; name?: string; via?: number[][] };

export function renderProcessModel(t: ProcessTimings, source: string, generatedAt: string): string {
  const unmeasured = "Wait: unmeasured. SQLite has no per-step start/end timestamps.";
  const nodes: Node[] = [];
  const task = (id: string, name: string, x: number, y: number, note = unmeasured, agent = false) =>
    nodes.push({ id, tag: "task", name, x, y, w: 160, h: 80, note, agent });
  const event = (id: string, tag: string, name: string, x: number, y: number, agent = false) =>
    nodes.push({ id, tag, name, x, y, w: 36, h: 36, agent });
  const gateway = (id: string, name: string, x: number, y: number, agent = false) =>
    nodes.push({ id, tag: "exclusiveGateway", name, x, y, w: 50, h: 50, agent });

  event("Issue", "startEvent", "Issue selected", 40, 112);
  task("Enqueue", "Enqueue issue (gm add)", 120, 90,
    "Wait: unmeasured. Issue creation/discovery time is not recorded; queued_at marks insertion.");
  task("Queue", "Wait for WIP slot / dispatch", 330, 90,
    `Queue + dispatch delay: ${describe(t.queue)}. jobs.started_at - queued_at; includes preparation and launch. First launch only.`);
  task("Prepare", "Validate config / isolate worktree", 540, 90);
  gateway("Ready", "Plan ready?", 750, 105);
  task("Launch", "Launch detached agent", 860, 90);
  nodes.push({ id: "LaunchFailed", tag: "boundaryEvent", name: "Launch failed",
    x: 984, y: 152, w: 36, h: 36 });
  nodes.push({ id: "Agent", tag: "subProcess", name: "Contribution workflow (ferb)",
    x: 1100, y: 40, w: 2040, h: 550,
    note: `Observed run elapsed: ${describe(t.run)}. jobs.ended_at - started_at; terminal first-launch jobs only. Includes work and reconciliation lag; not phase wait time. done does not imply a PR.` });
  event("AgentStart", "startEvent", "Agent running", 1140, 112, true);
  task("Phase0", "Assess issue (Phase 0)", 1220, 90, unmeasured, true);
  gateway("Go", "GO?", 1430, 105, true);
  task("Analyze", "Analyze / reproduce", 1540, 90, unmeasured, true);
  gateway("Reproduced", "Fix needed?", 1705, 105, true);
  nodes[nodes.length - 1].w = 35;
  nodes[nodes.length - 1].h = 35;
  task("Fix", "Implement fix", 1750, 90, unmeasured, true);
  task("Test", "Run regression tests", 1960, 90, unmeasured, true);
  gateway("TestsPass", "Tests pass?", 2170, 105, true);
  task("Review", "Adversarial review", 2280, 90, unmeasured, true);
  gateway("ReviewPass", "Review passes?", 2490, 105, true);
  task("Publish", "Push fork / open PR / comment", 2600, 90,
    `${unmeasured} Launch-to-first-PR elapsed (not publishing wait): ${describe(t.pr)}. ${t.has_pr_log ? "Verified pull_requests.created_at - jobs.started_at; one first PR per job." : "pull_requests table absent in source."}`, true);
  task("Record", "Write final run record", 2810, 90, unmeasured, true);
  event("AgentEnd", "endEvent", "Record written", 3020, 112, true);
  nodes.push({ id: "Interrupted", tag: "boundaryEvent", name: "Session vanished / stalled",
    x: 3080, y: 572, w: 36, h: 36 });
  task("Reconcile", "Reconcile record / measure diff", 3260, 90,
    "Wait: unmeasured. ended_at records observation, not actual agent exit. Lag can include a supervisor tick or longer downtime; diff ceilings can block after publication.");
  event("Finished", "endEvent", "Reconciled (done / blocked)", 3490, 112);
  event("Blocked", "endEvent", "Blocked / failed", 750, 520);
  task("Classify", "Classify interruption", 3020, 840);
  gateway("Recovery", "Recovery decision", 2790, 855);
  task("Park", "Park until reset / WIP available", 2520, 840,
    "Wait: unmeasured. resume_after is planned eligibility, not measured parked duration. No transition history exists.");
  task("Resume", "Resume existing session", 2520, 1150);

  const flows: Flow[] = [
    { from: "Issue", to: "Enqueue" }, { from: "Enqueue", to: "Queue" },
    { from: "Queue", to: "Prepare" }, { from: "Prepare", to: "Ready" },
    { from: "Ready", to: "Launch", name: "Ready" },
    { from: "Ready", to: "Blocked", name: "Missing config / source clone", via: [[775, 470], [768, 470]] },
    { from: "LaunchFailed", to: "Blocked", name: "Worktree / tmux failure", via: [[1030, 520], [810, 520]] },
    { from: "Launch", to: "Agent" }, { from: "Agent", to: "Reconcile" },
    { from: "Reconcile", to: "Finished" },
    { from: "AgentStart", to: "Phase0" }, { from: "Phase0", to: "Go" },
    { from: "Go", to: "Analyze", name: "GO" },
    { from: "Go", to: "Record", name: "NO-GO / ASK", via: [[1455, 480], [2890, 480]] },
    { from: "Analyze", to: "Reproduced" }, { from: "Reproduced", to: "Fix", name: "Yes" },
    { from: "Reproduced", to: "Record", name: "No reproduction / stop", via: [[1722, 510], [2920, 510]] },
    { from: "Fix", to: "Test" },
    { from: "Test", to: "TestsPass" }, { from: "TestsPass", to: "Review", name: "Pass" },
    { from: "TestsPass", to: "Fix", name: "Fail", via: [[2195, 430], [1830, 430]] },
    { from: "Review", to: "ReviewPass" }, { from: "ReviewPass", to: "Publish", name: "Pass" },
    { from: "ReviewPass", to: "Fix", name: "Changes needed", via: [[2515, 455], [1800, 455]] },
    { from: "Publish", to: "Record" }, { from: "Record", to: "AgentEnd" },
    { from: "Interrupted", to: "Classify", via: [[3098, 780], [3100, 780]] },
    { from: "Classify", to: "Recovery" },
    { from: "Recovery", to: "Park", name: "Transient / quota window; below cap" },
    { from: "Park", to: "Resume", via: [[2600, 1100]] },
    { from: "Resume", to: "Agent", via: [[3210, 1190], [3210, 530]] },
    { from: "Recovery", to: "Queue", name: "Died; fresh attempts remain", via: [[2815, 1510], [410, 1510]] },
    { from: "Recovery", to: "Blocked", name: "Needs human / cap / missing worktree", via: [[2815, 1450], [768, 1450]] },
  ];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const agentFlow = (f: Flow) => byId.get(f.from)!.agent && byId.get(f.to)!.agent;
  const flowId = (f: Flow) => `Flow_${f.from}_${f.to}`;
  const renderNode = (n: Node): string => {
    const incoming = flows.filter((f) => f.to === n.id).map((f) => `<bpmn:incoming>${flowId(f)}</bpmn:incoming>`).join("");
    const outgoing = flows.filter((f) => f.from === n.id).map((f) => `<bpmn:outgoing>${flowId(f)}</bpmn:outgoing>`).join("");
    const attrs = n.tag === "boundaryEvent" ? ` attachedToRef="${n.id === "Interrupted" ? "Agent" : "Launch"}" cancelActivity="true"` : "";
    const children = n.id === "Agent" ? nodes.filter((v) => v.agent).map(renderNode).join("\n") +
      flows.filter(agentFlow).map(renderFlow).join("\n") + notes.filter((v) => v.agent).map(annotation).join("\n") : n.tag === "boundaryEvent" ?
        `<bpmn:errorEventDefinition id="Error_${n.id}" />` : "";
    return `<bpmn:${n.tag} id="${n.id}" name="${xml(n.name)}"${attrs}>${incoming}${outgoing}${children}</bpmn:${n.tag}>`;
  };
  function renderFlow(f: Flow): string {
    return `<bpmn:sequenceFlow id="${flowId(f)}" sourceRef="${f.from}" targetRef="${f.to}"${f.name ? ` name="${xml(f.name)}"` : ""} />`;
  }
  const shape = (id: string, x: number, y: number, w: number, h: number, attrs = "") =>
    `<bpmndi:BPMNShape id="Shape_${id}" bpmnElement="${id}"${attrs}><dc:Bounds x="${x}" y="${y}" width="${w}" height="${h}" /></bpmndi:BPMNShape>`;
  const edge = (id: string, points: number[][]) => `<bpmndi:BPMNEdge id="Edge_${id}" bpmnElement="${id}">${points.map(([x, y]) => `<di:waypoint x="${x}" y="${y}" />`).join("")}</bpmndi:BPMNEdge>`;
  const docking = (n: Node, target: number[]): number[] => {
    const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
    const dx = target[0] - cx, dy = target[1] - cy;
    const scale = 1 / Math.max(Math.abs(dx) / (n.w / 2), Math.abs(dy) / (n.h / 2));
    return [Math.round(cx + dx * scale), Math.round(cy + dy * scale)];
  };
  const notes = nodes.filter((n) => n.note);
  // Annotations for agent steps stay inside the expanded subprocess.
  const noteY = (n: Node) => n.id === "Agent" ? 640 : n.y + n.h + 60;
  const annotation = (n: Node) => `<bpmn:textAnnotation id="Note_${n.id}"><bpmn:text>${xml(n.note!)}</bpmn:text></bpmn:textAnnotation>
<bpmn:association id="Assoc_${n.id}" sourceRef="${n.id}" targetRef="Note_${n.id}" />`;
  const metadata = `Source: ${source}; exported: ${generatedAt}; jobs=${t.jobs}; first-launch/no-resume rows=${t.eligible_jobs}. Units: milliseconds. p95: nearest rank. Missing/invalid/reversed timestamps excluded. Phase waits are unavailable, never assumed zero. This descriptive model does not execute jobs.`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" id="GraveyardDefinitions" targetNamespace="https://github.com/MaheshBhushan/graveyard/process">
<bpmn:process id="IssueToPR" name="graveyard: issue to pull request" isExecutable="false">
<bpmn:documentation>${xml(metadata)}</bpmn:documentation>
${nodes.filter((n) => !n.agent).map(renderNode).join("\n")}
${flows.filter((f) => !agentFlow(f)).map(renderFlow).join("\n")}
${notes.filter((n) => !n.agent).map(annotation).join("\n")}
</bpmn:process>
<bpmndi:BPMNDiagram id="IssueToPRDiagram"><bpmndi:BPMNPlane id="IssueToPRPlane" bpmnElement="IssueToPR">
${nodes.map((n) => shape(n.id, n.x, n.y, n.w, n.h, n.id === "Agent" ? ' isExpanded="true"' : "")).join("\n")}
${flows.map((f) => {
    const a = byId.get(f.from)!, b = byId.get(f.to)!;
    const via = f.via ?? [];
    return edge(flowId(f), [docking(a, via[0] ?? [b.x + b.w / 2, b.y + b.h / 2]), ...via,
      docking(b, via.at(-1) ?? [a.x + a.w / 2, a.y + a.h / 2])]);
  }).join("\n")}
${notes.map((n) => shape(`Note_${n.id}`, n.x, noteY(n), n.id === "Agent" ? 700 : 180, n.id === "Agent" ? 140 : 170) +
    edge(`Assoc_${n.id}`, [[n.x + n.w / 2, n.y + n.h], [n.x + 80, noteY(n)]])).join("\n")}
</bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>
`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    console.log("Usage: bun run src/process-model.ts [--db <existing fleet.sqlite>] > issue-to-pr.bpmn\nReads SQLite without migrations or writes. Defaults to ~/.local/share/mk-fleet/fleet.sqlite.");
  } else if (args.length && !(args.length === 2 && args[0] === "--db" && !args[1].startsWith("--"))) {
    console.error("Expected --db <existing SQLite path> or --help");
    process.exitCode = 1;
  } else {
    let db: Database | undefined;
    try {
      const dbPath = args[1] ?? join(homedir(), ".local", "share", "mk-fleet", "fleet.sqlite");
      db = new Database(dbPath, { readonly: true });
      console.log(renderProcessModel(readProcessTimings(db), basename(dbPath), new Date().toISOString()));
    } catch (error) {
      console.error(`Cannot export process model: ${error instanceof Error ? error.message : error}`);
      process.exitCode = 1;
    } finally {
      db?.close();
    }
  }
}
