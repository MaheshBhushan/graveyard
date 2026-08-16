// Tests for the pure half of `gm watch`. The verdict fixtures are the real
// text run 02's agent produced, not invented ones -- every parser bug this
// project has hit came from testing against tidy synthetic input.

import { describe, expect, test } from "bun:test";
import {
  clampScroll,
  followSelection,
  parseVerdict,
  renderLogPane,
  renderVerdictPane,
  hints,
  renderWatch,
  renderWatchRows,
  scrollbar,
  type WatchJob,
  type WatchModel,
} from "../src/watch.ts";
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
  return {
    jobs: [job()],
    selected: 0,
    rowOffset: 0,
    rowViewport: 20,
    logTail: "",
    logOffset: null,
    logViewport: 10,
    logSource: "x",
    wip: 3,
    paused: false,
    ...over,
  };
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

  test("keeps a value that ferb wrapped onto indented continuation lines", () => {
    // Reading only the first line silently truncated reason mid-sentence and
    // dropped three of four blockers -- caught by rendering the real run 02.
    const v = parseVerdict(REAL_NOGO);
    expect(v?.reason).toContain("no maintainer has replied");
    expect(v?.blockers).toContain("not-actually-a-bug");
    expect(v?.reason).not.toContain("\n");
  });

  test("a continuation stops at the next label rather than swallowing it", () => {
    const v = parseVerdict("Verdict: GO\nReason: small\n        and safe\nEst. effort: trivial");
    expect(v?.reason).toBe("small and safe");
    expect(v?.effort).toBe("trivial");
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

describe("scrolling", () => {
  test("clampScroll never scrolls past the last full screen", () => {
    expect(clampScroll(99, 30, 10)).toBe(20);
    expect(clampScroll(-5, 30, 10)).toBe(0);
    expect(clampScroll(5, 8, 10)).toBe(0); // everything already fits
  });

  test("followSelection moves by one at the edges and not at all inside", () => {
    expect(followSelection(5, 0, 10)).toBe(0); // already visible
    expect(followSelection(10, 0, 10)).toBe(1); // stepped past the bottom
    expect(followSelection(3, 7, 10)).toBe(3); // jumped above the top
  });

  test("a truncated job list says how many rows are below the fold", () => {
    const jobs = Array.from({ length: 40 }, (_, i) => job({ job_id: `j${i}`, issue_number: 4000 + i }));
    const out = renderWatchRows(model({ jobs, rowOffset: 0, rowViewport: 10 }), Date.now(), ASCII);
    expect(out).toContain("30 more");
    for (const line of out.split("\n")) expect(line.length).toBeLessThanOrEqual(ASCII.width);
  });

  test("the bar is one glyph per visible row, and blank when nothing scrolls", () => {
    expect(scrollbar(8, 0, 10, ASCII)).toEqual(Array(10).fill(" "));
    const bar = scrollbar(100, 0, 10, ASCII);
    expect(bar).toHaveLength(10);
    expect(bar.join("")).toMatch(/^#+\|+$/); // thumb at the top
    expect(scrollbar(100, 90, 10, ASCII).join("")).toMatch(/^\|+#+$/); // and at the bottom
  });

  test("the job list is a window, not the whole list", () => {
    const jobs = Array.from({ length: 40 }, (_, i) => job({ job_id: `j${i}`, issue_number: 4000 + i }));
    const out = renderWatchRows(model({ jobs, selected: 39, rowOffset: 30, rowViewport: 10 }), Date.now(), ASCII);
    const lines = out.split("\n");
    expect(lines).toHaveLength(10); // exactly the window; nothing below it
    expect(out).toContain("rich#4039");
    expect(out).not.toContain("rich#4029");
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(ASCII.width);
  });

  test("rows and the overflow note fit the width", () => {
    const jobs = Array.from({ length: 30 }, (_, i) => job({ job_id: `j${i}`, title: "x".repeat(300) }));
    for (const width of [20, 40, 80, 120]) {
      const out = renderWatchRows(model({ jobs, rowViewport: 10 }), Date.now(), { ...ASCII, width });
      for (const line of out.split("\n")) expect(line.length).toBeLessThanOrEqual(width);
    }
  });
});

describe("renderLogPane", () => {
  const long = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");

  test("a null offset sticks to the newest line", () => {
    const out = renderLogPane(model({ logTail: long, logOffset: null, logViewport: 5 }), ASCII);
    expect(out).toContain("line 99");
    expect(out).not.toContain("line 94");
    expect(out).toContain("96-100/100");
  });

  test("scrolling up shows older lines and says where you are", () => {
    const out = renderLogPane(model({ logTail: long, logOffset: 0, logViewport: 5 }), ASCII);
    expect(out).toContain("line 0");
    expect(out).not.toContain("line 99");
    expect(out).toContain("1-5/100");
  });

  test("a trailing newline is not counted as a line you can scroll to", () => {
    const out = renderLogPane(model({ logTail: "a\nb\n", logOffset: null, logViewport: 5 }), ASCII);
    expect(out).not.toContain("3/");
    expect(out).toContain("b");
  });

  test("no position readout when the whole log already fits", () => {
    expect(renderLogPane(model({ logTail: "a\nb", logViewport: 20 }), ASCII)).not.toContain("/2");
  });
});

describe("hints", () => {
  test("fit the terminal at every width, dropping the least useful first", () => {
    for (const width of [20, 40, 76, 80, 120]) {
      const line = hints({ ...ASCII, width });
      expect(line.length).toBeLessThanOrEqual(width);
      expect(line).toContain("select"); // the one hint that always survives
    }
    expect(hints({ ...ASCII, width: 120 })).toContain("q quit");
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

  // A refused job has no verdict and is not queued, so it used to render as
  // "phase 0 in progress" forever -- the queue looked stuck when it was
  // actually just holding a job it had already decided never to run.
  test("a blocked job shows why it was refused, not fake progress", () => {
    const out = renderVerdictPane(
      job({
        state: "blocked",
        last_error: "repo anomalyco/opencode is absent from repos.yaml; refusing to dispatch",
      }),
      ASCII,
    );
    expect(out).toContain("blocked");
    expect(out).toContain("absent from repos.yaml");
    expect(out).not.toContain("phase 0");
  });
});

describe("renderWatch header", () => {
  test("counts refused jobs so the header adds up to the list below it", () => {
    const out = renderWatch(
      model({
        jobs: [
          job({ job_id: "a-1", state: "blocked", last_error: "no repos.yaml entry" }),
          job({ job_id: "a-2", state: "running", alive: true }),
        ],
      }),
      Date.parse("2026-08-16T13:21:00.000Z"),
      ASCII,
    );
    expect(out).toContain("wip 1/3");
    expect(out).toContain("stuck 1");
  });

  test("no stuck counter when nothing is stuck", () => {
    const out = renderWatch(model(), Date.parse("2026-08-16T13:21:00.000Z"), ASCII);
    expect(out).not.toContain("stuck");
  });
});
