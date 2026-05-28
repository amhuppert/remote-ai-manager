import { describe, it, expect } from "vitest";
import type { SessionListItem } from "@/lib/sessions/schemas";
import {
  computeSuggestions,
  type ActionSuggestion,
  type FilterSuggestion,
} from "./command-suggestions";
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

describe("computeSuggestions — slash mode", () => {
  it("returns all 4 action suggestions for empty slash", () => {
    const result = computeSuggestions({
      draft: "/",
      tokens: [],
      sessions: [],
      archivedCount: 0,
    });
    const ids = result.map((s) => (s.kind === "action" ? s.id : "FILTER"));
    expect(ids).toEqual([
      "new",
      "install-preset",
      "capabilities",
      "workflow-builder",
    ]);
    expect(result.every((s) => s.kind === "action")).toBe(true);
  });

  it("filters actions by substring of id or label", () => {
    const result = computeSuggestions({
      draft: "/cap",
      tokens: [],
      sessions: [],
      archivedCount: 0,
    });
    expect(result).toHaveLength(1);
    expect((result[0] as ActionSuggestion).id).toBe("capabilities");
  });

  it("never emits filter suggestions when in slash mode", () => {
    const sessions = [make({ derivedStatus: "running" })];
    const result = computeSuggestions({
      draft: "/new",
      tokens: [],
      sessions,
      archivedCount: 5,
    });
    expect(result.every((s) => s.kind === "action")).toBe(true);
  });
});

describe("computeSuggestions — filter mode", () => {
  it("suggests both archived options when no archived token exists", () => {
    const result = computeSuggestions({
      draft: "",
      tokens: [],
      sessions: [],
      archivedCount: 7,
    });
    const archived = result.filter(
      (s): s is FilterSuggestion => s.kind === "filter" && s.cat === "archived",
    );
    expect(archived).toHaveLength(2);
    expect(archived.find((s) => s.exclusive)?.label).toContain("7");
  });

  it("omits archived suggestions once an archived token is present", () => {
    const tokens: FilterToken[] = [
      { cat: "archived", key: "include", value: "include" },
    ];
    const result = computeSuggestions({
      draft: "",
      tokens,
      sessions: [],
      archivedCount: 3,
    });
    expect(
      result.filter((s) => s.kind === "filter" && s.cat === "archived"),
    ).toHaveLength(0);
  });

  it("suggests one status entry per status with per-status counts", () => {
    const sessions = [
      make({ sessionName: "a", derivedStatus: "running" }),
      make({ sessionName: "b", derivedStatus: "running" }),
      make({ sessionName: "c", derivedStatus: "awaiting" }),
      make({ sessionName: "d", derivedStatus: "idle", finished: true }),
    ];
    const result = computeSuggestions({
      draft: "",
      tokens: [],
      sessions,
      archivedCount: 0,
    });
    const status = result.filter(
      (s): s is FilterSuggestion => s.kind === "filter" && s.cat === "status",
    );
    const labelsByValue = Object.fromEntries(
      status.map((s) => [s.value, s.label]),
    );
    expect(labelsByValue["running"]).toContain("· 2");
    expect(labelsByValue["awaiting"]).toContain("· 1");
    expect(labelsByValue["merged"]).toContain("· 1");
  });

  it("omits status suggestions when a status token exists", () => {
    const tokens: FilterToken[] = [
      { cat: "status", key: "is", value: "running" },
    ];
    const result = computeSuggestions({
      draft: "",
      tokens,
      sessions: [make({})],
      archivedCount: 0,
    });
    expect(
      result.filter((s) => s.kind === "filter" && s.cat === "status"),
    ).toHaveLength(0);
  });

  it("suggests unique target branches", () => {
    const sessions = [
      make({ sessionName: "a", targetBranch: "main" }),
      make({ sessionName: "b", targetBranch: "develop" }),
      make({ sessionName: "c", targetBranch: "main" }),
    ];
    const result = computeSuggestions({
      draft: "",
      tokens: [],
      sessions,
      archivedCount: 0,
    });
    const targets = result.filter(
      (s): s is FilterSuggestion => s.kind === "filter" && s.cat === "target",
    );
    expect(targets.map((s) => s.value).sort()).toEqual(["develop", "main"]);
  });

  it("substring-matches against draft (case-insensitive)", () => {
    const sessions = [
      make({ targetBranch: "feature-foo" }),
      make({ targetBranch: "main" }),
    ];
    const result = computeSuggestions({
      draft: "FEATURE",
      tokens: [],
      sessions,
      archivedCount: 0,
    });
    const targets = result.filter(
      (s): s is FilterSuggestion => s.kind === "filter" && s.cat === "target",
    );
    expect(targets.map((s) => s.value)).toEqual(["feature-foo"]);
  });

  it("caps filter suggestions at 12 items (actions kept unconditionally)", () => {
    const sessions = Array.from({ length: 30 }, (_, i) =>
      make({ sessionName: `s-${i}`, targetBranch: `branch-${i}` }),
    );
    const result = computeSuggestions({
      draft: "",
      tokens: [],
      sessions,
      archivedCount: 0,
    });
    const filters = result.filter((s) => s.kind === "filter");
    expect(filters.length).toBeLessThanOrEqual(12);
  });
});

describe("computeSuggestions — free-text mode (no slash)", () => {
  it("includes all actions on empty draft", () => {
    const result = computeSuggestions({
      draft: "",
      tokens: [],
      sessions: [],
      archivedCount: 0,
    });
    const actionIds = result
      .filter((s): s is ActionSuggestion => s.kind === "action")
      .map((s) => s.id);
    expect(actionIds).toEqual([
      "new",
      "install-preset",
      "capabilities",
      "workflow-builder",
    ]);
  });

  it("orders actions before filters on empty draft", () => {
    const result = computeSuggestions({
      draft: "",
      tokens: [],
      sessions: [make({})],
      archivedCount: 1,
    });
    const firstFilterIdx = result.findIndex((s) => s.kind === "filter");
    const lastActionIdx = result.reduce(
      (acc, s, i) => (s.kind === "action" ? i : acc),
      -1,
    );
    expect(lastActionIdx).toBeGreaterThanOrEqual(0);
    expect(firstFilterIdx).toBeGreaterThan(lastActionIdx);
  });

  it("matches actions by free-text substring without slash", () => {
    const result = computeSuggestions({
      draft: "workflow",
      tokens: [],
      sessions: [],
      archivedCount: 0,
    });
    const actions = result.filter(
      (s): s is ActionSuggestion => s.kind === "action",
    );
    expect(actions.map((a) => a.id)).toEqual(["workflow-builder"]);
  });

  it("matches actions by label substring", () => {
    const result = computeSuggestions({
      draft: "builder",
      tokens: [],
      sessions: [],
      archivedCount: 0,
    });
    const actions = result.filter(
      (s): s is ActionSuggestion => s.kind === "action",
    );
    expect(actions.map((a) => a.id)).toEqual(["workflow-builder"]);
  });

  it("excludes non-matching actions when free text is given", () => {
    const result = computeSuggestions({
      draft: "workflow",
      tokens: [],
      sessions: [make({ targetBranch: "main" })],
      archivedCount: 0,
    });
    const actionIds = result
      .filter((s): s is ActionSuggestion => s.kind === "action")
      .map((s) => s.id);
    expect(actionIds).not.toContain("new");
    expect(actionIds).not.toContain("install-preset");
    expect(actionIds).not.toContain("capabilities");
  });

  it("still surfaces filters alongside matching actions", () => {
    const result = computeSuggestions({
      draft: "",
      tokens: [],
      sessions: [make({ derivedStatus: "running" })],
      archivedCount: 2,
    });
    expect(
      result.some((s) => s.kind === "filter" && s.cat === "archived"),
    ).toBe(true);
    expect(result.some((s) => s.kind === "filter" && s.cat === "status")).toBe(
      true,
    );
  });
});
