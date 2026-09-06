import { describe, expect, it } from "vitest";
import {
  activeConversationSchema,
  type ActiveConversation,
} from "@/lib/active-conversations/schemas";
import {
  buildSessionGroups,
  buildSidebarContent,
  needsAttention,
  type SessionGroupOptions,
} from "./conversation-session-groups";

const options: SessionGroupOptions = {
  query: "",
  project: null,
  includeArchived: false,
  includeGraphWorkflows: false,
  filter: "all",
  sessionScope: null,
  expandedKeys: new Set(),
  activeConversationId: "",
};
function row(
  id: string,
  extra: Record<string, unknown> = {},
): ActiveConversation {
  return activeConversationSchema.parse({
    scope: "session",
    id,
    name: id,
    status: "awaiting",
    lastActivityAt: "2026-09-06T12:00:00Z",
    projectName: "cc",
    projectPath: "/cc",
    sessionName: "panel",
    agentBackend: "codex",
    summary: null,
    pendingQuestion: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    forkedFrom: null,
    debugActive: false,
    role: null,
    branchName: "panel",
    worktreePath: "/cc/panel",
    lastActivitySummary: null,
    unread: false,
    ...extra,
  });
}
const rows = [
  row("old", { lastActivityAt: "2026-09-01T12:00:00Z" }),
  row("latest"),
  row("running", { status: "running" }),
  row("question", { status: "waiting_for_input" }),
  row("unread", { unread: true }),
];

describe("session previews", () => {
  it("collapses to latest and running while keeping input in the pinned section", () => {
    const groups = buildSessionGroups(rows, options);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.items.map((r) => r.id)).toEqual(["latest", "running"]);
    expect(groups[0]).toMatchObject({
      total: 4,
      expanded: false,
    });
  });
  it("expands a session to every conversation and keeps other sessions collapsed", () => {
    const groups = buildSessionGroups(
      [...rows, row("other", { sessionName: "other" })],
      options,
    );
    const expanded = buildSessionGroups(
      [...rows, row("other", { sessionName: "other" })],
      { ...options, expandedKeys: new Set([groups[0]!.groupKey]) },
    );
    expect(expanded[0]?.items).toHaveLength(4);
    expect(expanded[1]?.expanded).toBe(false);
  });
  it("reveals old search matches inside collapsed sessions", () => {
    expect(
      buildSessionGroups(rows, { ...options, query: "old" })[0]?.items.map(
        (r) => r.id,
      ),
    ).toEqual(["old"]);
  });
  it("filters by project and separates equal session names across projects", () => {
    const other = row("other", {
      projectName: "recall",
      projectPath: "/recall",
    });
    expect(buildSessionGroups([...rows, other], options)).toHaveLength(2);
    expect(
      buildSessionGroups([...rows, other], {
        ...options,
        project: "recall",
      })[0]?.items.map((r) => r.id),
    ).toEqual(["other"]);
  });
  it("includes archived conversations only on request and reveals them in previews", () => {
    const archived = { ...row("archive"), archived: true };
    expect(buildSessionGroups([...rows, archived], options)[0]?.total).toBe(4);
    expect(
      buildSessionGroups([...rows, archived], {
        ...options,
        includeArchived: true,
      })[0]?.items.map((r) => r.id),
    ).toContain("archive");
  });
  it("keeps a selected older conversation visible", () => {
    expect(
      buildSessionGroups(rows, {
        ...options,
        activeConversationId: "old",
      })[0]?.items.map((r) => r.id),
    ).toContain("old");
  });
  it("keeps input and running filters grouped by session", () => {
    const groups = buildSessionGroups(rows, { ...options, filter: "needs" });
    expect(groups).toEqual([]);
    expect(
      buildSidebarContent(rows, { ...options, filter: "needs" }).needsInput.map(
        (r) => r.id,
      ),
    ).toEqual(["question"]);
  });
});

describe("input pinning and workflow visibility", () => {
  it("pins actual input requests while unread results stay in their session", () => {
    const view = buildSidebarContent(rows, {
      ...options,
      expandedKeys: new Set(["/cc::panel"]),
    });
    expect(view.needsInput.map((r) => r.id)).toEqual(["question"]);
    expect(view.groups.flatMap((g) => g.items.map((r) => r.id))).toEqual([
      "latest",
      "running",
      "unread",
      "old",
    ]);
    expect(needsAttention(row("unread", { unread: true }))).toBe(false);
  });
  it("hides workflow rows by default but always exposes their questions and approvals", () => {
    const workflowRows = [
      row("ordinary"),
      row("lane", { role: "iteration" }),
      row("validator-question", {
        role: "validator",
        status: "waiting_for_input",
      }),
    ];
    const view = buildSidebarContent(workflowRows, options);
    expect(view.needsInput.map((r) => r.id)).toEqual(["validator-question"]);
    expect(view.groups.flatMap((g) => g.items.map((r) => r.id))).toEqual([
      "ordinary",
    ]);
    const shown = buildSidebarContent(workflowRows, {
      ...options,
      includeGraphWorkflows: true,
      expandedKeys: new Set(["/cc::panel"]),
    });
    expect(shown.groups.flatMap((g) => g.items.map((r) => r.id))).toEqual([
      "ordinary",
      "lane",
    ]);
    expect(shown.needsInput.map((r) => r.id)).toEqual(["validator-question"]);
  });
  it("does not let workflow visibility bypass project, search, or archival filters", () => {
    const input = row("lane-question", {
      role: "validator",
      status: "waiting_for_input",
    });
    expect(
      buildSidebarContent([input], { ...options, project: "other" }).needsInput,
    ).toEqual([]);
    expect(
      buildSidebarContent([input], { ...options, query: "absent" }).needsInput,
    ).toEqual([]);
    expect(
      buildSidebarContent([{ ...input, archived: true }], options).needsInput,
    ).toEqual([]);
  });
});

it("Unread reveals an older unread result without promoting it in the default preview", () => {
  const input = [
    row("latest"),
    row("old-unread", { unread: true, lastActivityAt: "2026-08-01T12:00:00Z" }),
  ];
  expect(buildSessionGroups(input, options)[0]?.items.map((r) => r.id)).toEqual(
    ["latest"],
  );
  expect(
    buildSessionGroups(input, { ...options, filter: "unread" })[0]?.items.map(
      (r) => r.id,
    ),
  ).toEqual(["old-unread"]);
});
it("keeps ordinary planner and initialization conversations visible when graph lanes are hidden", () => {
  const input = [
    row("planner", { role: "planner" }),
    row("setup", { role: "initialization" }),
  ];
  expect(
    buildSessionGroups(input, {
      ...options,
      expandedKeys: new Set(["/cc::panel"]),
    })[0]?.items.map((r) => r.id),
  ).toEqual(["planner", "setup"]);
});
