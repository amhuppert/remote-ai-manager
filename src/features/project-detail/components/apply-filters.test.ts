import { describe, it, expect } from "vitest";
import type { SessionListItem } from "@/lib/sessions/schemas";
import { applyFilters, applySort } from "./apply-filters";
import type { FilterToken } from "./filter-tokens";

const baseSession: SessionListItem = {
  sessionName: "alpha",
  worktreePath: "/p/.w/alpha",
  branchName: "csm/alpha",
  targetBranch: "main",
  parentSessionName: null,
  createdAt: "2026-05-22T00:00:00.000Z",
  lastActivityAt: "2026-05-22T00:00:00.000Z",
  archived: false,
  finished: false,
  source: "cc",
  creationMode: "fast",
  tddEnabled: true,
  objective: null,
  derivedStatus: "running",
  promptCount: 0,
  derivedLastActivityAt: "2026-05-22T00:00:00.000Z",
  collabContribution: null,
  hasActiveGraphWorkflow: false,
};

function make(overrides: Partial<SessionListItem>): SessionListItem {
  return { ...baseSession, ...overrides };
}

describe("applyFilters", () => {
  it("filters out archived sessions by default", () => {
    const sessions = [
      make({ sessionName: "a", archived: false }),
      make({ sessionName: "b", archived: true }),
    ];
    const result = applyFilters(sessions, [], "");
    expect(result.map((s) => s.sessionName)).toEqual(["a"]);
  });

  it("includes archived when archived:include token is present", () => {
    const sessions = [
      make({ sessionName: "a", archived: false }),
      make({ sessionName: "b", archived: true }),
    ];
    const tokens: FilterToken[] = [
      { cat: "archived", key: "include", value: "include" },
    ];
    const result = applyFilters(sessions, tokens, "");
    expect(result.map((s) => s.sessionName).sort()).toEqual(["a", "b"]);
  });

  it("shows only archived when archived:only token is present", () => {
    const sessions = [
      make({ sessionName: "a", archived: false }),
      make({ sessionName: "b", archived: true }),
    ];
    const tokens: FilterToken[] = [
      { cat: "archived", key: "only", value: "only", exclusive: true },
    ];
    const result = applyFilters(sessions, tokens, "");
    expect(result.map((s) => s.sessionName)).toEqual(["b"]);
  });

  it("status token filters by derivedStatus", () => {
    const sessions = [
      make({ sessionName: "a", derivedStatus: "running" }),
      make({ sessionName: "b", derivedStatus: "awaiting" }),
      make({ sessionName: "c", derivedStatus: "idle" }),
    ];
    const tokens: FilterToken[] = [
      { cat: "status", key: "is", value: "awaiting" },
    ];
    expect(
      applyFilters(sessions, tokens, "").map((s) => s.sessionName),
    ).toEqual(["b"]);
  });

  it("status:merged matches finished sessions", () => {
    const sessions = [
      make({ sessionName: "a", finished: true }),
      make({ sessionName: "b", finished: false }),
    ];
    const tokens: FilterToken[] = [
      { cat: "status", key: "is", value: "merged" },
    ];
    expect(
      applyFilters(sessions, tokens, "").map((s) => s.sessionName),
    ).toEqual(["a"]);
  });

  it("target token matches exactly", () => {
    const sessions = [
      make({ sessionName: "a", targetBranch: "main" }),
      make({ sessionName: "b", targetBranch: "develop" }),
    ];
    const tokens: FilterToken[] = [
      { cat: "target", key: "target", value: "develop" },
    ];
    expect(
      applyFilters(sessions, tokens, "").map((s) => s.sessionName),
    ).toEqual(["b"]);
  });

  it("branch token substring-matches branchName", () => {
    const sessions = [
      make({ sessionName: "a", branchName: "csm/feature-foo" }),
      make({ sessionName: "b", branchName: "csm/bugfix-bar" }),
    ];
    const tokens: FilterToken[] = [
      { cat: "branch", key: "branch", value: "feature" },
    ];
    expect(
      applyFilters(sessions, tokens, "").map((s) => s.sessionName),
    ).toEqual(["a"]);
  });

  it("free-text draft substring-matches sessionName or branchName (case-insensitive)", () => {
    const sessions = [
      make({ sessionName: "Alpha-Refactor", branchName: "csm/alpha" }),
      make({ sessionName: "Beta", branchName: "csm/refactor-stuff" }),
      make({ sessionName: "Gamma", branchName: "csm/gamma" }),
    ];
    const result = applyFilters(sessions, [], "REFACTOR");
    expect(result.map((s) => s.sessionName).sort()).toEqual([
      "Alpha-Refactor",
      "Beta",
    ]);
  });

  it("ignores slash-prefixed draft for free-text matching", () => {
    const sessions = [
      make({ sessionName: "alpha", archived: false }),
      make({ sessionName: "beta", archived: false }),
    ];
    const result = applyFilters(sessions, [], "/anything");
    expect(result.map((s) => s.sessionName).sort()).toEqual(["alpha", "beta"]);
  });
});

describe("applySort", () => {
  function makeSorted(
    overrides: Partial<SessionListItem>[],
  ): SessionListItem[] {
    return overrides.map((o, i) => make({ sessionName: `s-${i}`, ...o }));
  }

  it("sorts by status using fixed order", () => {
    const sessions = makeSorted([
      { derivedStatus: "idle" },
      { derivedStatus: "running" },
      { derivedStatus: "new" },
      { derivedStatus: "awaiting" },
    ]);
    const result = applySort(sessions, { id: "status", desc: false });
    expect(result.map((s) => s.derivedStatus)).toEqual([
      "new",
      "running",
      "awaiting",
      "idle",
    ]);
  });

  it("places finished sessions at end of status sort", () => {
    const sessions = makeSorted([
      { finished: true, derivedStatus: "idle" },
      { derivedStatus: "running" },
      { derivedStatus: "new" },
    ]);
    const result = applySort(sessions, { id: "status", desc: false });
    expect(result.map((s) => s.finished)).toEqual([false, false, true]);
  });

  it("sorts by lastActivityAt asc and desc", () => {
    const sessions = makeSorted([
      { lastActivityAt: "2026-05-22T03:00:00.000Z" },
      { lastActivityAt: "2026-05-22T01:00:00.000Z" },
      { lastActivityAt: "2026-05-22T02:00:00.000Z" },
    ]);
    const asc = applySort(sessions, { id: "lastActivityAt", desc: false });
    expect(asc.map((s) => s.lastActivityAt)).toEqual([
      "2026-05-22T01:00:00.000Z",
      "2026-05-22T02:00:00.000Z",
      "2026-05-22T03:00:00.000Z",
    ]);
    const desc = applySort(sessions, { id: "lastActivityAt", desc: true });
    expect(desc.map((s) => s.lastActivityAt)).toEqual([
      "2026-05-22T03:00:00.000Z",
      "2026-05-22T02:00:00.000Z",
      "2026-05-22T01:00:00.000Z",
    ]);
  });

  it("sorts by promptCount numerically", () => {
    const sessions = makeSorted([
      { promptCount: 10 },
      { promptCount: 2 },
      { promptCount: 5 },
    ]);
    const asc = applySort(sessions, { id: "promptCount", desc: false });
    expect(asc.map((s) => s.promptCount)).toEqual([2, 5, 10]);
  });

  it("sorts by sessionName / branchName / targetBranch via localeCompare", () => {
    const sessions = makeSorted([
      { sessionName: "charlie", branchName: "csm/c", targetBranch: "z" },
      { sessionName: "alpha", branchName: "csm/a", targetBranch: "a" },
      { sessionName: "bravo", branchName: "csm/b", targetBranch: "m" },
    ]);
    const cols: Array<"sessionName" | "branchName" | "targetBranch"> = [
      "sessionName",
      "branchName",
      "targetBranch",
    ];
    for (const id of cols) {
      const sorted = applySort(sessions, { id, desc: false });
      const values = sorted.map((s) => s[id]);
      const expected = [...values].sort((a, b) => a.localeCompare(b));
      expect(values).toEqual(expected);
    }
  });

  it("does not mutate the input array", () => {
    const sessions = makeSorted([
      { promptCount: 3 },
      { promptCount: 1 },
      { promptCount: 2 },
    ]);
    const snapshot = sessions.map((s) => s.promptCount);
    applySort(sessions, { id: "promptCount", desc: false });
    expect(sessions.map((s) => s.promptCount)).toEqual(snapshot);
  });
});
