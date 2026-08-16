// Tests for the pure parsing in the queue layer. `parseIssueRef` exists so
// `gm add <pasted url>` works; the cases below are the shapes a browser tab,
// a `gh` output line, or an issue comment actually hand you.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addJob, clearJobs, countByState, parseIssueRef, transitionJob } from "../src/queue.ts";

describe("parseIssueRef", () => {
  test("the plain copied URL", () => {
    expect(parseIssueRef("https://github.com/NousResearch/hermes-agent/issues/87272")).toEqual({
      repo: "NousResearch/hermes-agent",
      issue_number: 87272,
      url: "https://github.com/NousResearch/hermes-agent/issues/87272",
    });
  });

  test("tolerates scheme, www, trailing slash, anchor and query", () => {
    const want = {
      repo: "Textualize/rich",
      issue_number: 4199,
      url: "https://github.com/Textualize/rich/issues/4199",
    };
    for (const s of [
      "github.com/Textualize/rich/issues/4199",
      "http://www.github.com/Textualize/rich/issues/4199/",
      "https://github.com/Textualize/rich/issues/4199#issuecomment-123",
      "https://github.com/Textualize/rich/issues/4199?foo=bar",
      "  https://github.com/Textualize/rich/issues/4199  ",
    ]) {
      expect(parseIssueRef(s)).toEqual(want);
    }
  });

  test("a PR URL resolves to the same number", () => {
    // Deliberate: someone pasting a PR link means that number, and GitHub
    // numbers issues and PRs from one sequence.
    expect(parseIssueRef("https://github.com/Textualize/rich/pull/3686")?.issue_number).toBe(3686);
  });

  test("the short owner/name#n form", () => {
    expect(parseIssueRef("Textualize/rich#4196")).toEqual({
      repo: "Textualize/rich",
      issue_number: 4196,
      url: "https://github.com/Textualize/rich/issues/4196",
    });
  });

  test("repo names with dots and dashes survive", () => {
    expect(parseIssueRef("https://github.com/foo-bar/baz.js/issues/7")?.repo).toBe("foo-bar/baz.js");
  });

  test("rejects what is not an issue reference", () => {
    for (const s of [
      "",
      "Textualize/rich",
      "https://github.com/Textualize/rich",
      "https://gitlab.com/Textualize/rich/issues/1",
      "https://github.com/Textualize/rich/issues/0",
      "https://github.com/Textualize/rich/issues/abc",
      "--repo",
    ]) {
      expect(parseIssueRef(s)).toBeNull();
    }
  });
});

// `gm clear` operates on a real database, so these use an in-memory one rather
// than mocking it -- the guard that matters (never drop a live job) is enforced
// by the query, not by the caller.
function seeded(): Database {
  const db = new Database(":memory:");
  db.exec(readFileSync(join(import.meta.dir, "..", "schema.sql"), "utf8"));
  const states: Record<string, string> = {
    "a/b-1": "done",
    "a/b-2": "done",
    "a/b-3": "failed",
    "a/b-4": "blocked",
    "a/b-5": "queued",
    "a/b-6": "running",
  };
  let n = 0;
  for (const state of Object.values(states)) {
    const res = addJob(db, { repo: "a/b", issue_number: ++n, task_source: "test" });
    if (state !== "queued") transitionJob(db, res.job_id, state as never);
  }
  return db;
}

describe("clearJobs", () => {
  test("clears every finished job and leaves the live ones alone", () => {
    const db = seeded();
    const res = clearJobs(db);
    expect(res.cleared).toHaveLength(4); // 2 done + 1 failed + 1 blocked
    const after = countByState(db);
    expect(after.done).toBeUndefined();
    expect(after.failed).toBeUndefined();
    expect(after.blocked).toBeUndefined();
    expect(after.queued).toBe(1);
    expect(after.running).toBe(1);
  });

  test("a running job is refused even when asked for by name", () => {
    // Deleting it would orphan a live agent and its worktree.
    const db = seeded();
    const res = clearJobs(db, { states: ["running", "done"] });
    expect(res.kept.map((k) => k.state)).toEqual(["running"]);
    expect(res.cleared.every((c) => c.state === "done")).toBe(true);
    expect(countByState(db).running).toBe(1);
  });

  test("--state narrows it to one kind", () => {
    const db = seeded();
    clearJobs(db, { states: ["failed"] });
    const after = countByState(db);
    expect(after.failed).toBeUndefined();
    expect(after.done).toBe(2); // untouched
  });

  test("dry run reports without deleting", () => {
    const db = seeded();
    const res = clearJobs(db, { dryRun: true });
    expect(res.cleared).toHaveLength(4);
    expect(countByState(db).done).toBe(2);
  });

  test("clearing an already-clean queue is a no-op, not an error", () => {
    const db = seeded();
    clearJobs(db);
    expect(clearJobs(db).cleared).toHaveLength(0);
  });
});
