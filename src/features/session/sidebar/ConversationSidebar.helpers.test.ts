import { describe, it, expect } from "vitest";
import {
  describeActiveRow,
  filterConversations,
  filterBySession,
  splitNeedsYou,
  clusterBySession,
  annotateSessionPos,
  groupByKey,
  buildConversationSidebarSections,
  type ActiveSidebarConversation,
  type SidebarConversation,
} from "@/features/session/sidebar/ConversationSidebar.helpers";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeRow(
  overrides: Partial<SidebarConversation> = {},
): SidebarConversation {
  return {
    scope: "session",
    id: "id-1",
    name: "Conversation One",
    summary: null,
    status: "running",
    lastActivityAt: "2025-01-01T00:00:00.000Z",
    projectName: "proj-a",
    projectPath: "/repos/proj-a",
    sessionName: "session-a",
    branchName: "csm/session-a",
    worktreePath: "/repos/proj-a/.worktrees/session-a",
    agentBackend: "claude",
    pendingQuestion: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    forkedFrom: null,
    debugActive: false,
    role: null,
    lastActivitySummary: null,
    unread: false,
    ...overrides,
  };
}

function makeProjectRow(
  overrides: Partial<Extract<ActiveSidebarConversation, { scope: "project" }>> = {},
): Extract<ActiveSidebarConversation, { scope: "project" }> {
  return {
    scope: "project",
    id: "project-id-1",
    name: "Project Conversation One",
    summary: null,
    status: "running",
    lastActivityAt: "2025-01-01T00:00:00.000Z",
    projectName: "proj-a",
    projectPath: "/repos/proj-a",
    worktreePath: "/repos/proj-a",
    agentBackend: "claude",
    pendingQuestion: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    forkedFrom: null,
    debugActive: false,
    role: null,
    lastActivitySummary: null,
    unread: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// describeActiveRow
// ---------------------------------------------------------------------------

describe("describeActiveRow", () => {
  it("derives project rows as owning project / main without a synthetic session name", () => {
    const row = makeProjectRow({
      id: "plc-1",
      name: "Repo health check",
      summary: "Review root-level CI failures",
      projectName: "remote-ai-manager",
      projectPath: "/repos/remote-ai-manager",
    });

    const descriptor = describeActiveRow(row);

    expect(descriptor).toEqual({
      groupKey: "/repos/remote-ai-manager::main",
      groupLabel: "remote-ai-manager / main",
      projectLabel: "remote-ai-manager",
      contextLabel: "main",
      href: "/projects/remote-ai-manager?focus=plc-1",
      actionScope: {
        scope: "project",
        projectName: "remote-ai-manager",
        conversationId: "plc-1",
      },
      supportsSessionPeek: false,
      searchFields: [
        "Repo health check",
        "Review root-level CI failures",
        "remote-ai-manager",
        "main",
      ],
    });
    expect("sessionName" in descriptor.actionScope).toBe(false);
    expect("sessionName" in row).toBe(false);
  });

  it("preserves session row grouping, searchable context, action scope, and detail-route href", () => {
    const row = makeRow({
      id: "session-convo-1",
      name: "Session rollout",
      summary: "Plan the session scoped release",
      projectName: "creative-ai",
      projectPath: "/repos/creative-ai",
      sessionName: "feature-session",
    });

    expect(describeActiveRow(row)).toEqual({
      groupKey: "/repos/creative-ai::feature-session",
      groupLabel: "creative-ai / feature-session",
      projectLabel: "creative-ai",
      contextLabel: "feature-session",
      href: "/projects/creative-ai/feature-session/session-convo-1",
      actionScope: {
        scope: "session",
        projectName: "creative-ai",
        sessionName: "feature-session",
        conversationId: "session-convo-1",
      },
      supportsSessionPeek: true,
      searchFields: [
        "Session rollout",
        "Plan the session scoped release",
        "creative-ai",
        "feature-session",
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// filterConversations
// ---------------------------------------------------------------------------

describe("filterConversations", () => {
  it("returns rows unchanged when query is empty", () => {
    const rows = [makeRow({ id: "a" }), makeRow({ id: "b" })];
    expect(filterConversations(rows, "")).toEqual(rows);
  });

  it("returns rows unchanged when query is whitespace", () => {
    const rows = [makeRow({ id: "a" }), makeRow({ id: "b" })];
    expect(filterConversations(rows, "   \t\n  ")).toEqual(rows);
  });

  it("matches against name case-insensitively", () => {
    const rows = [
      makeRow({ id: "a", name: "Refactor Auth Module" }),
      makeRow({ id: "b", name: "Fix dev server bug" }),
    ];
    expect(filterConversations(rows, "auth").map((r) => r.id)).toEqual(["a"]);
    expect(filterConversations(rows, "AUTH").map((r) => r.id)).toEqual(["a"]);
  });

  it("matches against summary", () => {
    const rows = [
      makeRow({ id: "a", summary: "Investigating SSE drops" }),
      makeRow({ id: "b", summary: null }),
    ];
    expect(filterConversations(rows, "sse").map((r) => r.id)).toEqual(["a"]);
  });

  it("matches against projectName and sessionName, but not branchName", () => {
    const rows = [
      makeRow({
        id: "a",
        projectName: "alpha",
        sessionName: "x",
        branchName: "csm/x",
      }),
      makeRow({
        id: "b",
        projectName: "beta",
        sessionName: "y",
        branchName: "csm/y",
      }),
      makeRow({
        id: "c",
        projectName: "gamma",
        sessionName: "alpha-z",
        branchName: "csm/alpha-z",
      }),
    ];
    expect(
      filterConversations(rows, "alpha")
        .map((r) => r.id)
        .sort(),
    ).toEqual(["a", "c"]);
    expect(filterConversations(rows, "csm/y").map((r) => r.id)).toEqual([]);
  });

  it("returns empty array when no matches", () => {
    const rows = [makeRow({ id: "a", name: "foo" })];
    expect(filterConversations(rows, "zzz")).toEqual([]);
  });

  it("treats null name/summary/branchName as no-match (not throw)", () => {
    const rows = [
      makeRow({ id: "a", name: null, summary: null, branchName: null }),
      makeRow({ id: "b", name: "match me" }),
    ];
    expect(filterConversations(rows, "match").map((r) => r.id)).toEqual(["b"]);
  });

  it("searches project rows by project/main context without requiring session fields", () => {
    const rows: ActiveSidebarConversation[] = [
      makeProjectRow({
        id: "project-row",
        projectName: "root-tools",
        name: "Dependency audit",
      }),
      makeRow({
        id: "session-row",
        projectName: "root-tools",
        sessionName: "feature-session",
      }),
    ];

    expect(filterConversations(rows, "main").map((r) => r.id)).toEqual([
      "project-row",
    ]);
    expect(filterConversations(rows, "feature-session").map((r) => r.id)).toEqual([
      "session-row",
    ]);
  });
});

// ---------------------------------------------------------------------------
// filterBySession
// ---------------------------------------------------------------------------

describe("filterBySession", () => {
  it("returns rows unchanged when scope is null", () => {
    const rows = [
      makeRow({ id: "a", projectName: "p1", sessionName: "s1" }),
      makeRow({ id: "b", projectName: "p2", sessionName: "s2" }),
    ];
    expect(filterBySession(rows, null)).toEqual(rows);
  });

  it("keeps only rows whose projectName + sessionName match the scope", () => {
    const rows = [
      makeRow({ id: "a", projectName: "p1", sessionName: "s1" }),
      makeRow({ id: "b", projectName: "p1", sessionName: "s2" }),
      makeRow({ id: "c", projectName: "p2", sessionName: "s1" }),
      makeRow({ id: "d", projectName: "p1", sessionName: "s1" }),
    ];
    expect(
      filterBySession(rows, { projectName: "p1", sessionName: "s1" }).map(
        (r) => r.id,
      ),
    ).toEqual(["a", "d"]);
  });

  it("returns empty array when nothing matches", () => {
    const rows = [makeRow({ projectName: "p1", sessionName: "s1" })];
    expect(
      filterBySession(rows, { projectName: "px", sessionName: "sx" }),
    ).toEqual([]);
  });

  it("does not treat project rows as members of a synthetic session", () => {
    const projectRow = makeProjectRow({ id: "project-row", projectName: "p1" });
    const sessionRow = makeRow({
      id: "session-row",
      projectName: "p1",
      sessionName: "main",
    });
    const rows: ActiveSidebarConversation[] = [projectRow, sessionRow];

    expect(
      filterBySession(rows, { projectName: "p1", sessionName: "main" }).map(
        (r) => r.id,
      ),
    ).toEqual(["session-row"]);
  });
});

// ---------------------------------------------------------------------------
// splitNeedsYou
// ---------------------------------------------------------------------------

describe("splitNeedsYou", () => {
  it("splits waiting_for_input into questions, unread non-questions into finished, rest into others", () => {
    const rows = [
      makeRow({ id: "a", status: "running" }),
      makeRow({ id: "b", status: "awaiting" }),
      makeRow({ id: "c", status: "waiting_for_input" }),
      makeRow({ id: "d", status: "new" }),
      makeRow({ id: "e", status: "awaiting", unread: true }),
      makeRow({ id: "f", status: "running", unread: true }),
    ];
    const { questions, finished, others } = splitNeedsYou(rows);
    expect(questions.map((r) => r.id)).toEqual(["c"]);
    expect(finished.map((r) => r.id)).toEqual(["e", "f"]);
    expect(others.map((r) => r.id)).toEqual(["a", "b", "d"]);
  });

  it("classifies an unread waiting_for_input row as a question, never finished", () => {
    const rows = [
      makeRow({ id: "a", status: "waiting_for_input", unread: true }),
    ];
    const { questions, finished, others } = splitNeedsYou(rows);
    expect(questions.map((r) => r.id)).toEqual(["a"]);
    expect(finished).toEqual([]);
    expect(others).toEqual([]);
  });

  it("preserves input order in each bucket", () => {
    const rows = [
      makeRow({ id: "c", status: "waiting_for_input" }),
      makeRow({ id: "a", status: "waiting_for_input" }),
      makeRow({ id: "b", status: "running" }),
      makeRow({ id: "e", status: "awaiting", unread: true }),
      makeRow({ id: "d", status: "running", unread: true }),
    ];
    const { questions, finished, others } = splitNeedsYou(rows);
    expect(questions.map((r) => r.id)).toEqual(["c", "a"]);
    expect(finished.map((r) => r.id)).toEqual(["e", "d"]);
    expect(others.map((r) => r.id)).toEqual(["b"]);
  });

  it("returns empty arrays for empty input", () => {
    const { questions, finished, others } = splitNeedsYou([]);
    expect(questions).toEqual([]);
    expect(finished).toEqual([]);
    expect(others).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// clusterBySession
// ---------------------------------------------------------------------------

describe("clusterBySession", () => {
  it("groups rows sharing the same projectPath::sessionName together", () => {
    const rows = [
      makeRow({
        id: "a1",
        projectPath: "/p/a",
        sessionName: "s1",
        lastActivityAt: "2025-01-01T00:00:00Z",
      }),
      makeRow({
        id: "b1",
        projectPath: "/p/b",
        sessionName: "s2",
        lastActivityAt: "2025-01-02T00:00:00Z",
      }),
      makeRow({
        id: "a2",
        projectPath: "/p/a",
        sessionName: "s1",
        lastActivityAt: "2025-01-03T00:00:00Z",
      }),
    ];
    const result = clusterBySession(rows);
    const idxA1 = result.findIndex((r) => r.id === "a1");
    const idxA2 = result.findIndex((r) => r.id === "a2");
    expect(Math.abs(idxA1 - idxA2)).toBe(1);
  });

  it("orders clusters by the most-recent lastActivityAt in each cluster (descending)", () => {
    const rows = [
      makeRow({
        id: "a1",
        projectPath: "/p/a",
        sessionName: "s1",
        lastActivityAt: "2025-01-05T00:00:00Z",
      }),
      makeRow({
        id: "b1",
        projectPath: "/p/b",
        sessionName: "s2",
        lastActivityAt: "2025-01-10T00:00:00Z",
      }),
      makeRow({
        id: "a2",
        projectPath: "/p/a",
        sessionName: "s1",
        lastActivityAt: "2025-01-01T00:00:00Z",
      }),
    ];
    const result = clusterBySession(rows);
    // Cluster b (max 01-10) should come before cluster a (max 01-05)
    expect(result.map((r) => r.id)).toEqual(["b1", "a1", "a2"]);
  });

  it("preserves intra-cluster input order", () => {
    const rows = [
      makeRow({
        id: "a1",
        projectPath: "/p/a",
        sessionName: "s1",
        lastActivityAt: "2025-01-01T00:00:00Z",
      }),
      makeRow({
        id: "a2",
        projectPath: "/p/a",
        sessionName: "s1",
        lastActivityAt: "2025-01-03T00:00:00Z",
      }),
      makeRow({
        id: "a3",
        projectPath: "/p/a",
        sessionName: "s1",
        lastActivityAt: "2025-01-02T00:00:00Z",
      }),
    ];
    expect(clusterBySession(rows).map((r) => r.id)).toEqual(["a1", "a2", "a3"]);
  });

  it("distinguishes same sessionName under different projectPath", () => {
    const rows = [
      makeRow({
        id: "a",
        projectPath: "/p/a",
        sessionName: "shared",
        lastActivityAt: "2025-01-02T00:00:00Z",
      }),
      makeRow({
        id: "b",
        projectPath: "/p/b",
        sessionName: "shared",
        lastActivityAt: "2025-01-01T00:00:00Z",
      }),
    ];
    const result = clusterBySession(rows);
    expect(result.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// annotateSessionPos
// ---------------------------------------------------------------------------

describe("annotateSessionPos", () => {
  it("marks a single row in its session as 'only'", () => {
    const rows = [makeRow({ id: "a", projectPath: "/p", sessionName: "s" })];
    const annotated = annotateSessionPos(rows);
    expect(annotated[0]).toMatchObject({
      isFirstInSession: true,
      isLastInSession: true,
      sessionPosition: "only",
    });
  });

  it("marks first, middle, and last rows in a session cluster", () => {
    const rows = [
      makeRow({ id: "a1", projectPath: "/p", sessionName: "s" }),
      makeRow({ id: "a2", projectPath: "/p", sessionName: "s" }),
      makeRow({ id: "a3", projectPath: "/p", sessionName: "s" }),
    ];
    const annotated = annotateSessionPos(rows);
    expect(annotated[0]).toMatchObject({
      isFirstInSession: true,
      isLastInSession: false,
      sessionPosition: "first",
    });
    expect(annotated[1]).toMatchObject({
      isFirstInSession: false,
      isLastInSession: false,
      sessionPosition: "middle",
    });
    expect(annotated[2]).toMatchObject({
      isFirstInSession: false,
      isLastInSession: true,
      sessionPosition: "last",
    });
  });

  it("does not re-cluster — operates on input order as-is", () => {
    const rows = [
      makeRow({ id: "a", projectPath: "/p", sessionName: "s1" }),
      makeRow({ id: "b", projectPath: "/p", sessionName: "s2" }),
      makeRow({ id: "c", projectPath: "/p", sessionName: "s1" }),
    ];
    const annotated = annotateSessionPos(rows);
    // a and c are both "only" because they're not adjacent
    expect(annotated[0]?.sessionPosition).toBe("only");
    expect(annotated[1]?.sessionPosition).toBe("only");
    expect(annotated[2]?.sessionPosition).toBe("only");
  });

  it("treats two adjacent rows as first/last", () => {
    const rows = [
      makeRow({ id: "a", projectPath: "/p", sessionName: "s" }),
      makeRow({ id: "b", projectPath: "/p", sessionName: "s" }),
    ];
    const annotated = annotateSessionPos(rows);
    expect(annotated[0]?.sessionPosition).toBe("first");
    expect(annotated[1]?.sessionPosition).toBe("last");
  });
});

// ---------------------------------------------------------------------------
// groupByKey
// ---------------------------------------------------------------------------

describe("groupByKey", () => {
  it("groups by session using projectPath::sessionName", () => {
    const rows = [
      makeRow({ id: "a", projectPath: "/p/a", sessionName: "s1" }),
      makeRow({ id: "b", projectPath: "/p/b", sessionName: "s2" }),
      makeRow({ id: "c", projectPath: "/p/a", sessionName: "s1" }),
    ];
    const groups = groupByKey(rows, "session");
    const keys = groups.map((g) => g.groupKey).sort();
    expect(keys).toEqual(["/p/a::s1", "/p/b::s2"]);
    const sessionA = groups.find((g) => g.groupKey === "/p/a::s1");
    expect(sessionA?.items.map((r) => r.id)).toEqual(["a", "c"]);
    expect(sessionA).toMatchObject({
      projectLabel: "proj-a",
      sessionLabel: "s1",
    });
  });

  it("groups by project using projectName", () => {
    const rows = [
      makeRow({ id: "a", projectName: "alpha" }),
      makeRow({ id: "b", projectName: "beta" }),
      makeRow({ id: "c", projectName: "alpha" }),
    ];
    const groups = groupByKey(rows, "project");
    const alpha = groups.find((g) => g.groupKey === "alpha");
    expect(alpha?.items.map((r) => r.id)).toEqual(["a", "c"]);
    expect(alpha?.label).toBe("alpha");
  });

  it("preserves group order by first appearance", () => {
    const rows = [
      makeRow({ id: "a", projectName: "beta" }),
      makeRow({ id: "b", projectName: "alpha" }),
      makeRow({ id: "c", projectName: "beta" }),
    ];
    const groups = groupByKey(rows, "project");
    expect(groups.map((g) => g.groupKey)).toEqual(["beta", "alpha"]);
  });

  it("groups project rows by projectPath::main and labels them as project / main", () => {
    const rows: ActiveSidebarConversation[] = [
      makeProjectRow({
        id: "project-row",
        projectName: "alpha",
        projectPath: "/repos/alpha",
      }),
      makeRow({
        id: "session-row",
        projectName: "alpha",
        projectPath: "/repos/alpha",
        sessionName: "session-a",
      }),
    ];

    const groups = groupByKey(rows, "session");

    expect(groups.map((g) => g.groupKey)).toEqual([
      "/repos/alpha::main",
      "/repos/alpha::session-a",
    ]);
    expect(groups[0]).toMatchObject({
      label: "alpha / main",
      projectLabel: "alpha",
    });
    expect(groups[0]?.sessionLabel).toBeUndefined();
    expect(groups[1]).toMatchObject({
      label: "alpha / session-a",
      projectLabel: "alpha",
      sessionLabel: "session-a",
    });
  });
});

// ---------------------------------------------------------------------------
// buildConversationSidebarSections
// ---------------------------------------------------------------------------

describe("buildConversationSidebarSections", () => {
  it("pins questions and finished sections above the grouped non-needs conversations", () => {
    const rows = [
      makeRow({
        id: "running",
        status: "running",
        projectName: "ground-control-ui",
      }),
      makeRow({
        id: "asks",
        status: "waiting_for_input",
        projectName: "ground-control-ui",
      }),
      makeRow({
        id: "finished",
        status: "awaiting",
        unread: true,
        projectName: "creative-ai",
      }),
      makeRow({
        id: "awaiting-ready",
        status: "awaiting",
        projectName: "creative-ai",
      }),
      makeRow({ id: "new", status: "new", projectName: "creative-ai" }),
    ];

    const sections = buildConversationSidebarSections(rows, {
      filter: "all",
      groupBy: "project",
      sessionScope: null,
    });

    expect(sections.map((section) => section.kind)).toEqual([
      "needs",
      "needs",
      "project",
      "project",
    ]);
    expect(sections[0]?.tone).toBe("question");
    expect(sections[0]?.label).toBe("Needs you");
    expect(sections[0]?.items.map((row) => row.id)).toEqual(["asks"]);
    expect(sections[1]?.tone).toBe("finished");
    expect(sections[1]?.label).toBe("Finished \u2014 unread");
    expect(sections[1]?.items.map((row) => row.id)).toEqual(["finished"]);
    expect(
      sections
        .slice(2)
        .flatMap((section) => section.items.map((row) => row.id)),
    ).toEqual(["running", "awaiting-ready", "new"]);
  });

  it("omits each pinned section when its bucket is empty", () => {
    const onlyQuestions = buildConversationSidebarSections(
      [makeRow({ id: "q", status: "waiting_for_input" })],
      { filter: "all", groupBy: "project", sessionScope: null },
    );
    expect(
      onlyQuestions.filter((s) => s.kind === "needs").map((s) => s.tone),
    ).toEqual(["question"]);

    const onlyFinished = buildConversationSidebarSections(
      [makeRow({ id: "f", status: "awaiting", unread: true })],
      { filter: "all", groupBy: "project", sessionScope: null },
    );
    expect(
      onlyFinished.filter((s) => s.kind === "needs").map((s) => s.tone),
    ).toEqual(["finished"]);
  });

  it("keeps both pinned sections inside the current-session filter", () => {
    const rows = [
      makeRow({
        id: "current-need",
        status: "waiting_for_input",
        projectName: "remote-ai-manager",
        sessionName: "current",
      }),
      makeRow({
        id: "current-finished",
        status: "awaiting",
        unread: true,
        projectName: "remote-ai-manager",
        sessionName: "current",
      }),
      makeRow({
        id: "other-need",
        status: "waiting_for_input",
        projectName: "remote-ai-manager",
        sessionName: "other",
      }),
      makeRow({
        id: "current-running",
        status: "running",
        projectName: "remote-ai-manager",
        sessionName: "current",
      }),
    ];

    const sections = buildConversationSidebarSections(rows, {
      filter: "session",
      groupBy: "project",
      sessionScope: {
        projectName: "remote-ai-manager",
        sessionName: "current",
      },
    });

    expect(sections.map((s) => `${s.kind}:${s.tone ?? "_"}`)).toEqual([
      "needs:question",
      "needs:finished",
      "project:_",
    ]);
    expect(
      sections.flatMap((section) => section.items.map((row) => row.id)),
    ).toEqual(["current-need", "current-finished", "current-running"]);
  });

  it("renders both pinned sections when the needs filter is active", () => {
    const rows = [
      makeRow({ id: "q", status: "waiting_for_input" }),
      makeRow({ id: "f", status: "awaiting", unread: true }),
      makeRow({ id: "r", status: "running" }),
    ];

    const sections = buildConversationSidebarSections(rows, {
      filter: "needs",
      groupBy: "project",
      sessionScope: null,
    });

    expect(sections.map((s) => `${s.kind}:${s.tone ?? "_"}`)).toEqual([
      "needs:question",
      "needs:finished",
    ]);
    expect(sections[0]?.items.map((row) => row.id)).toEqual(["q"]);
    expect(sections[1]?.items.map((row) => row.id)).toEqual(["f"]);
  });

  it("preserves Needs-you, unread-finished, and running grouping for mixed session/project rows", () => {
    const rows: ActiveSidebarConversation[] = [
      makeProjectRow({
        id: "project-question",
        status: "waiting_for_input",
        projectName: "alpha",
        projectPath: "/repos/alpha",
      }),
      makeRow({
        id: "session-question",
        status: "waiting_for_input",
        projectName: "alpha",
        projectPath: "/repos/alpha",
        sessionName: "session-a",
      }),
      makeProjectRow({
        id: "project-unread",
        status: "awaiting",
        unread: true,
        projectName: "beta",
        projectPath: "/repos/beta",
      }),
      makeRow({
        id: "session-running",
        status: "running",
        projectName: "beta",
        projectPath: "/repos/beta",
        sessionName: "session-b",
      }),
      makeProjectRow({
        id: "project-running",
        status: "running",
        projectName: "gamma",
        projectPath: "/repos/gamma",
      }),
    ];

    const allSections = buildConversationSidebarSections(rows, {
      filter: "all",
      groupBy: "session",
      sessionScope: null,
    });

    expect(allSections.map((s) => `${s.kind}:${s.tone ?? s.label}`)).toEqual([
      "needs:question",
      "needs:finished",
      "session:beta / session-b",
      "session:gamma / main",
    ]);
    expect(allSections[0]?.items.map((row) => row.id)).toEqual([
      "project-question",
      "session-question",
    ]);
    expect(allSections[1]?.items.map((row) => row.id)).toEqual([
      "project-unread",
    ]);

    const runningSections = buildConversationSidebarSections(rows, {
      filter: "running",
      groupBy: "session",
      sessionScope: null,
    });

    expect(runningSections.map((s) => `${s.label}:${s.items[0]?.id}`)).toEqual([
      "beta / session-b:session-running",
      "gamma / main:project-running",
    ]);
  });
});
