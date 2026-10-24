import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProcessTimings, renderProcessModel } from "../src/process-model.ts";

const root = join(import.meta.dir, "..");
const schema = readFileSync(join(root, "schema.sql"), "utf8");
const time = (seconds: number) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();

function seed(db: Database, id: string, queued: string, started: string | null,
  ended: string | null, state = "done", attempts = 1, resumes = 0): void {
  db.query(`INSERT INTO jobs (job_id, repo, task_source, state, queued_at, started_at,
    ended_at, attempts, resume_count) VALUES (?, 'a/b', 'test', ?, ?, ?, ?, ?, ?)`)
    .run(id, state, queued, started, ended, attempts, resumes);
}

describe("process timing measurements", () => {
  test("uses real intervals, first attempts, terminal runs and one verified first PR per job", () => {
    const db = new Database(":memory:");
    try {
      db.exec(schema);
      seed(db, "a", time(0), time(1), time(11));
      seed(db, "b", time(0), time(3), time(23), "failed");
      seed(db, "c", time(0), time(5), time(35), "running"); // stale ended_at must not count
      seed(db, "retry", time(0), time(100), time(200), "done", 2);
      seed(db, "resume", time(0), time(100), time(200), "done", 1, 1);
      seed(db, "not-started", time(0), null, time(50), "blocked");
      seed(db, "bad-date", "invalid", time(1), time(10));
      seed(db, "reversed", time(10), time(1), time(20));
      seed(db, "bad-end", time(0), time(7), time(6));
      seed(db, "local-date", "2026-01-01T00:00:00", time(1), time(10));
      db.query(`INSERT INTO pull_requests (repo, pr_number, job_id, url, state, created_at)
        VALUES (?, ?, ?, 'https://github.com/a/b/pull/1', ?, ?)`).run("a/b", 1, "a", "open", time(8));
      db.query(`INSERT INTO pull_requests (repo, pr_number, job_id, url, state, created_at)
        VALUES ('a/b', 2, 'a', 'url', 'open', ?)`).run(time(6));
      db.query(`INSERT INTO pull_requests (repo, pr_number, job_id, url, state, created_at)
        VALUES ('other/repo', 1, 'b', 'url', 'open', ?),
        ('a/b', 3, 'b', 'url', NULL, ?), ('a/b', 4, 'a', 'url', 'open', ?)`).run(time(9), time(9), time(0));
      const before = db.query("SELECT * FROM jobs").all();
      const t = readProcessTimings(db);
      expect(t.jobs).toBe(10);
      expect(t.eligible_jobs).toBe(8);
      expect(t.queue).toEqual({ n: 4, median_ms: 4000, p95_ms: 7000, max_ms: 7000 });
      expect(t.run).toEqual({ n: 2, median_ms: 15000, p95_ms: 20000, max_ms: 20000 });
      expect(t.pr).toEqual({ n: 1, median_ms: 5000, p95_ms: 5000, max_ms: 5000 });
      expect(db.query("SELECT * FROM jobs").all()).toEqual(before);
    } finally { db.close(); }
  });

  test("empty and legacy logs report unavailable measurements without migrations", () => {
    const db = new Database(":memory:");
    try {
      db.exec(schema);
      expect(readProcessTimings(db).queue).toEqual({ n: 0, median_ms: null, p95_ms: null, max_ms: null });
      db.exec("DROP TABLE pr_decisions; DROP TABLE pull_requests; ALTER TABLE jobs DROP COLUMN resume_count;");
      db.exec(`INSERT INTO jobs (job_id, repo, task_source, state, queued_at, started_at, attempts)
        VALUES ('legacy', 'a/b', 'test', 'running', '${time(0)}', '${time(1)}', 1)`);
      const t = readProcessTimings(db);
      expect(t.has_pr_log).toBe(false);
      expect(t.queue.n).toBe(0); // missing resume history cannot establish first launch
      const xml = renderProcessModel(t, "fleet.sqlite", time(0));
      expect(xml).toContain("pull_requests table absent");
      expect(xml).toContain("n=0; unavailable");
      expect(db.query("SELECT name FROM sqlite_master WHERE name='pull_requests'").get()).toBeNull();
    } finally { db.close(); }
  });
});

// Python's standard XML parser provides an independent parse and graph/DI check.
const validateXml = String.raw`
import sys, xml.etree.ElementTree as E
r = E.fromstring(sys.stdin.read())
b = '{http://www.omg.org/spec/BPMN/20100524/MODEL}'
bd = '{http://www.omg.org/spec/BPMN/20100524/DI}'
ids = [e.attrib['id'] for e in r.iter() if 'id' in e.attrib]
assert len(ids) == len(set(ids)), 'duplicate IDs'
byid = {e.attrib['id']: e for e in r.iter() if 'id' in e.attrib}
parent = {c: p for p in r.iter() for c in p}
shapes = {e.attrib['bpmnElement'] for e in r.iter(bd+'BPMNShape')}
edges = {e.attrib['bpmnElement'] for e in r.iter(bd+'BPMNEdge')}
assert r.find(b+'process').attrib['isExecutable'] == 'false'
for e in r.iter():
    tag = e.tag.removeprefix(b)
    if tag in ('task', 'subProcess', 'startEvent', 'endEvent', 'boundaryEvent', 'exclusiveGateway', 'textAnnotation'):
        assert e.attrib['id'] in shapes, e.attrib['id']
    if tag in ('task', 'subProcess'):
        assert 'Note_'+e.attrib['id'] in byid, 'missing wait annotation'
    if tag in ('sequenceFlow', 'association'):
        assert e.attrib['id'] in edges
        assert e.attrib['sourceRef'] in byid and e.attrib['targetRef'] in byid
        assert parent[e] is parent[byid[e.attrib['sourceRef']]]
        assert parent[e] is parent[byid[e.attrib['targetRef']]]
    if tag == 'sequenceFlow':
        assert e.attrib['id'] in [x.text for x in byid[e.attrib['sourceRef']].findall(b+'outgoing')]
        assert e.attrib['id'] in [x.text for x in byid[e.attrib['targetRef']].findall(b+'incoming')]
for p in [r.find(b+'process'), byid['Agent']]:
    flows = p.findall(b+'sequenceFlow')
    reached = {e.attrib['id'] for e in p if e.tag in (b+'startEvent', b+'boundaryEvent')}
    while True:
        new = reached | {f.attrib['targetRef'] for f in flows if f.attrib['sourceRef'] in reached}
        if new == reached: break
        reached = new
    assert all(e.attrib['id'] in reached for e in p if e.tag in (b+'task', b+'subProcess', b+'endEvent', b+'exclusiveGateway'))
`;

test("generated and checked-in BPMN have valid XML, references, phase annotations and complete DI", () => {
  const db = new Database(":memory:");
  try {
    db.exec(schema);
    seed(db, "a", time(0), time(2), time(12));
    const generated = renderProcessModel(readProcessTimings(db), 'test <source> & "quoted"', time(0));
    expect(generated).toContain("median=2000 ms");
    expect(generated).toContain("test &lt;source&gt; &amp; &quot;quoted&quot;");
    for (const xml of [generated, readFileSync(join(root, "docs/issue-to-pr.bpmn"), "utf8")]) {
      const result = Bun.spawnSync(["python3", "-c", validateXml], { stdin: Buffer.from(xml) });
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
    }
  } finally { db.close(); }
});

test("CLI reads an existing database without writes and fails without creating a missing database", () => {
  const dir = mkdtempSync(join(tmpdir(), "graveyard-bpmn-"));
  try {
    const file = join(dir, "source.sqlite");
    const db = new Database(file);
    db.exec(schema);
    seed(db, "a", time(0), time(2), time(12));
    db.close();
    const before = readFileSync(file);
    const run = (...args: string[]) => Bun.spawnSync([process.execPath, "run", join(root, "src/process-model.ts"), ...args]);
    const result = run("--db", file);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("median=2000 ms");
    expect(readFileSync(file)).toEqual(before);
    const missing = join(dir, "missing.sqlite");
    expect(run("--db", missing).exitCode).toBe(1);
    expect(Bun.file(missing).size).toBe(0);
    expect(run("--help").exitCode).toBe(0);
    expect(run("--db").exitCode).toBe(1);
    expect(run("--unknown").exitCode).toBe(1);
    expect(run("--db", file, "extra").exitCode).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
