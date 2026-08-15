import { describe, expect, test } from "bun:test";
import {
  cells,
  fmtDuration,
  renderDashboard,
  renderFleetBox,
  renderFooter,
  renderJobRows,
  repoIssue,
  shortRepo,
  stateGlyph,
  stripAnsi,
  type JobRow,
} from "../src/render.ts";
import type { Theme } from "../src/theme.ts";

const plain: Theme = { color: false, unicode: true, width: 80 };
const ascii: Theme = { color: false, unicode: false, width: 80 };
const painted: Theme = { color: true, unicode: true, width: 80 };

function job(over: Partial<JobRow>): JobRow {
  return {
    job_id: "x-1",
    repo: "Textualize/rich",
    issue_number: 1,
    title: "a title",
    state: "queued",
    priority: 0,
    queued_at: "2026-01-01T00:00:00.000Z",
    started_at: null,
    ended_at: null,
    ...over,
  };
}

describe("shortRepo / repoIssue", () => {
  test("drops the owner", () => {
    expect(shortRepo("Textualize/rich")).toBe("rich");
    expect(repoIssue(job({ repo: "Textualize/rich", issue_number: 4207 }))).toBe("rich#4207");
  });

  test("degrades a repo with no slash", () => {
    expect(shortRepo("standalone")).toBe("standalone");
  });

  test("degrades a null issue number", () => {
    expect(repoIssue(job({ repo: "owner/name", issue_number: null }))).toBe("name");
  });
});

describe("stateGlyph", () => {
  test("every state carries a glyph that survives ascii fallback", () => {
    for (const s of ["running", "parked", "queued", "done", "failed", "blocked"]) {
      expect(stripAnsi(stateGlyph(s, painted))).not.toBe("");
      expect(stripAnsi(stateGlyph(s, ascii))).toMatch(/^[a-z.=#+x]$/);
    }
  });
});

describe("fmtDuration", () => {
  test("seconds only under a minute", () => {
    expect(fmtDuration(47_000)).toBe("47s");
  });
  test("minutes and seconds above a minute", () => {
    expect(fmtDuration(134_000)).toBe("2m14s");
  });
});

describe("renderJobRows", () => {
  test("aligns columns by cells, not length, across CJK and emoji titles", () => {
    const now = Date.parse("2026-01-01T00:02:00.000Z");
    const rows = [
      job({ job_id: "a", state: "running", title: "plain title", started_at: "2026-01-01T00:00:00.000Z" }),
      job({ job_id: "b", state: "running", title: "修复 CJK 宽度处理", started_at: "2026-01-01T00:01:00.000Z" }),
      job({ job_id: "c", state: "running", title: "🎉 emoji case", started_at: "2026-01-01T00:01:30.000Z" }),
    ];
    const lines = renderJobRows(rows, now, plain).split("\n");
    // The elapsed column is right-aligned, so every line must end at the same
    // cell width regardless of how wide the title's graphemes render.
    const widths = new Set(lines.map((l) => cells(l)));
    expect(widths.size).toBe(1);
  });

  test("a null title falls back to the state word", () => {
    const rows = [job({ state: "queued", title: null })];
    expect(renderJobRows(rows, 0, plain)).toContain("queued");
  });

  test("parked shows a resume clock instead of a live elapsed time", () => {
    const rows = [job({ state: "parked", resume_after: "2026-01-01T23:00:00.000Z" })];
    const line = stripAnsi(renderJobRows(rows, 0, plain));
    expect(line).toContain("resets 23:00");
    expect(line.trim().endsWith("—")).toBe(true);
  });

  test("empty input renders nothing", () => {
    expect(renderJobRows([], 0, plain)).toBe("");
  });
});

describe("renderFleetBox", () => {
  test("frames content within the theme width", () => {
    const box = renderFleetBox("  wip 2/3   parked 1   queued 4", { ...plain, width: 60 });
    for (const line of box.split("\n")) expect(cells(line)).toBeLessThanOrEqual(60);
  });

  test("degrades to a plain line without unicode box drawing", () => {
    const box = renderFleetBox("wip 2/3", ascii);
    expect(box).not.toMatch(/[╭╮╰╯│─]/);
  });

  test("never exceeds the width even when narrow", () => {
    const box = renderFleetBox("wip 2/3   parked 1   queued 4", { ...plain, width: 20 });
    for (const line of box.split("\n")) expect(cells(line)).toBeLessThanOrEqual(20);
  });
});

describe("renderFooter", () => {
  test("omits states with a zero count", () => {
    expect(renderFooter({ done: 3 }, plain)).toBe(" └─ 3 done");
  });

  test("returns empty when nothing to report", () => {
    expect(renderFooter({}, plain)).toBe("");
  });

  test("tags a blocked count with the sample's reason", () => {
    const sample = job({ state: "blocked", last_error: "diff ceiling breached: 12 files / 900 lines" });
    expect(renderFooter({ blocked: 1 }, plain, sample)).toBe(" └─ 1 blocked (diff ceiling breached)");
  });
});

describe("renderDashboard", () => {
  test("rolls done/failed/blocked into the footer instead of rows", () => {
    const rows = [
      job({ job_id: "a", state: "running" }),
      job({ job_id: "b", state: "done" }),
      job({ job_id: "c", state: "blocked", last_error: "diff ceiling breached" }),
    ];
    const out = stripAnsi(renderDashboard(rows, 0, plain, { wip: 3 }));
    expect(out).toContain("wip 1/3");
    expect(out).toContain("1 done");
    expect(out).toContain("1 blocked (diff ceiling breached)");
    // Terminal-state jobs are summarised, not rendered as their own row.
    expect(out).not.toContain(" b ");
  });
});
