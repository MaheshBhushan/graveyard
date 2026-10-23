// The live agent command must never bypass permissions and must carry a
// scoped allowlist plus a scrubbed environment (issue text is untrusted).

import { describe, expect, test } from "bun:test";
import { agentCommand } from "../src/dispatch.ts";
import { agentAllowedTools, resumeAgentCommand, type AgentScope } from "../src/recover.ts";

const scope: AgentScope = {
  repo: "acme/widgets",
  branch: "fix/issue-42",
  issue: 42,
  runDir: "/tmp/run dir",
  testCommand: ".venv/bin/pytest -q",
};

describe("agent permission policy", () => {
  const prev = process.env.MK_FLEET_AGENT_CMD;
  delete process.env.MK_FLEET_AGENT_CMD;
  const fresh = agentCommand("/tmp/p.md", "/tmp/a.log", true, scope);
  const resume = resumeAgentCommand("/tmp/a.log", true, scope);
  if (prev !== undefined) process.env.MK_FLEET_AGENT_CMD = prev;

  for (const [name, cmd] of [["fresh", fresh], ["resume", resume]] as const) {
    test(`${name}: no permission bypass, scoped allowlist, scrubbed env`, () => {
      expect(cmd).not.toContain("dangerously");
      expect(cmd).not.toContain("bypassPermissions");
      expect(cmd).toContain("--permission-mode acceptEdits");
      expect(cmd).toContain("--permission-prompts none");
      expect(cmd).toContain("--allowedTools");
      expect(cmd).toContain("--disallowedTools");
      expect(cmd).toContain("'Bash(git push origin:*)'");
      expect(cmd.startsWith("env -i ")).toBe(true);
      expect(cmd).toContain("--add-dir '/tmp/run dir'");
    });
  }

  test("only this job's branch, repo and issue are writable upstream", () => {
    const allow = agentAllowedTools(scope);
    expect(allow).toContain("Bash(git push -u fork fix/issue-42)");
    expect(allow).toContain("Bash(gh pr create --repo acme/widgets --head:*)");
    expect(allow).toContain("Bash(gh issue comment 42 --repo acme/widgets:*)");
    expect(allow.some((a) => a === "Bash" || a.startsWith("Bash(git push:") || a.startsWith("Bash(gh pr create:"))).toBe(false);
    expect(allow).not.toContain("WebFetch");
  });
});
