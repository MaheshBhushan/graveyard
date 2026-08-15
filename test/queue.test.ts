// Tests for the pure parsing in the queue layer. `parseIssueRef` exists so
// `gm add <pasted url>` works; the cases below are the shapes a browser tab,
// a `gh` output line, or an issue comment actually hand you.

import { describe, expect, test } from "bun:test";
import { parseIssueRef } from "../src/queue.ts";

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
