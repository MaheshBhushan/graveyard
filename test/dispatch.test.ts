// Branch naming is the one part of a dispatch that becomes public the moment
// the agent pushes, so a repo that publishes a convention has to be obeyed
// before the run, not apologised for after it.

import { describe, expect, test } from "bun:test";
import { branchName } from "../src/dispatch.ts";

const job = (over: Record<string, unknown> = {}) =>
  ({ issue_number: 42898, job_id: "anomalyco__opencode-42898", ...over }) as never;

describe("branchName", () => {
  test("defaults to fix/issue-<n> when a repo states no preference", () => {
    expect(branchName(job(), null)).toBe("fix/issue-42898");
    expect(branchName(job())).toBe("fix/issue-42898");
  });

  test("honours a repo's own convention", () => {
    // opencode's AGENTS.md: at most three hyphenated words, no slashes, no
    // `fix/` prefix. The default would be closed on sight.
    const b = branchName(job(), "issue-{n}");
    expect(b).toBe("issue-42898");
    expect(b).not.toContain("/");
    expect(b.split("-")).toHaveLength(2);
  });

  test("falls back to the job id when there is no issue number", () => {
    expect(branchName(job({ issue_number: null }), null)).toBe("fix/anomalyco__opencode-42898");
    expect(branchName(job({ issue_number: null }), "issue-{n}")).toBe(
      "issue-anomalyco__opencode-42898",
    );
  });
});
