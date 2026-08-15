// Tests for the pure half of `gm watch`. The verdict fixtures are the real
// text run 02's agent produced, not invented ones -- every parser bug this
// project has hit came from testing against tidy synthetic input.

import { describe, expect, test } from "bun:test";
import { parseVerdict, renderVerdictPane, renderWatchRows, type WatchJob, type WatchModel } from "../src/watch.ts";
import type { Theme } from "../src/theme.ts";

const ASCII: Theme = { color: false, unicode: false, width: 80 };

// Verbatim from runs/Textualize__rich-4199/pr-draft.md, fenced block and all.
const REAL_NOGO = `
# Textualize/rich#4199 — Fix ambiguous-width character handling for CJK terminals

**Outcome: NO-GO (Phase 0 gate). No branch pushed, no PR opened.**

\`\`\`
Issue: Textualize/rich#4199 - Fix ambiguous-width character handling for CJK terminals
Verdict: NO-GO
Reason: Undecided design question, not a defect. The reporter explicitly asked
        maintainers for direction and no maintainer has replied.
Blockers: maintainer-has-not-decided; not-actually-a-bug (design discussion)
Est. effort: heavy
Confidence a correct fix is achievable and verifiable here: low
\`\`\`
`;

function job(over: Partial<WatchJob> = {}): WatchJob {
  return {
    job_id: "Textualize__rich-4199",
    repo: "Textualize/rich",
    issue_number: 4199,
    title: "Fix ambiguous-width character handling",
    state: "done",
    priority: 0,
    queued_at: "2026-08-15T19:00:00.000Z",
    started_at: "2026-08-15T19:29:49.000Z",
    ended_at: "2026-08-15T19:30:58.000Z",
    verdict: null,
    alive: false,
    ...over,
  };
}

function model(over: Partial<WatchModel> = {}): WatchModel {
  return { jobs: [job()], selected: 0, logTail: "", logSource: "x", wip: 3, paused: false, ...over };
}

describe("parseVerdict", () => {
  test("reads a real NO-GO out of the surrounding markdown", () => {
    const v = parseVerdict(REAL_NOGO);
    expect(v?.kind).toBe("NO-GO");
    expect(v?.effort).toBe("heavy");
    expect(v?.confidence).toBe("low");
    expect(v?.blockers).toContain("maintainer-has-not-decided");
    expect(v?.reason).toContain("Undecided design question");
  });

  test("NO-GO is not misread as GO despite containing it as a substring", () => {
    expect(parseVerdict("Verdict: NO-GO")?.kind).toBe("NO-GO");
    expect(parseVerdict("Verdict: GO")?.kind).toBe("GO");
    expect(parseVerdict("Verdict: ASK")?.kind).toBe("ASK");
  });

  test("tolerates bold markdown labels", () => {
    const v = parseVerdict("**Verdict**: GO\n**Reason**: small, reproducible");
    expect(v?.kind).toBe("GO");
    expect(v?.reason).toBe("small, reproducible");
  });

  test("returns null while phase 0 is still undecided", () => {
    expect(parseVerdict("")).toBeNull();
    expect(parseVerdict("# rich#4199\n\nreading the issue thread...")).toBeNull();
  });

  test("a prose mention of the word verdict is not a verdict", () => {
    expect(parseVerdict("I will write the Verdict: once I have read the thread")).toBeNull();
  });
});

describe("renderWatchRows", () => {
  test("shows the verdict badge and marks the selected row", () => {
    const out = renderWatchRows(
      model({ jobs: [job({ verdict: parseVerdict(REAL_NOGO) }), job({ job_id: "b", issue_number: 4196 })] }),
      Date.parse("2026-08-15T19:31:00.000Z"),
      ASCII,
    );
    const lines = out.split("\n");
    expect(lines[0]).toContain(">"); // caret on the selected row
    expect(lines[0]).toContain("rich#4199");
    expect(lines[0]).toContain("NO-GO");
    expect(lines[1]).not.toContain(">");
    expect(lines[1]).toContain("-"); // no verdict yet
  });

  test("every row fits the terminal width", () => {
    const long = job({ title: "x".repeat(300), verdict: parseVerdict("Verdict: GO") });
    for (const width of [20, 40, 80, 120]) {
      const out = renderWatchRows(model({ jobs: [long] }), Date.now(), { ...ASCII, width });
      for (const line of out.split("\n")) expect(line.length).toBeLessThanOrEqual(width);
    }
  });

  test("empty fleet says so rather than rendering nothing", () => {
    expect(renderWatchRows(model({ jobs: [] }), Date.now(), ASCII)).toContain("no jobs");
  });
});

describe("renderVerdictPane", () => {
  test("spells out the grounds for a decline", () => {
    const out = renderVerdictPane(job({ verdict: parseVerdict(REAL_NOGO) }), ASCII);
    expect(out).toContain("NO-GO");
    expect(out).toContain("maintainer-has-not-decided");
    expect(out).toContain("heavy");
  });

  test("distinguishes not-started from still-deciding", () => {
    expect(renderVerdictPane(job({ state: "queued" }), ASCII)).toContain("not started");
    expect(renderVerdictPane(job({ state: "running" }), ASCII)).toContain("phase 0");
  });
});
