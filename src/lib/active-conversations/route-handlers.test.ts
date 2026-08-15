import { describe, it, expect, vi } from "vitest";
import {
  createActiveConversationsRouteHandlers,
  deriveLastActivitySummary,
  type ActiveConversationsRouteDeps,
} from "./route-handlers";
import { activeConversationsResponseSchema } from "./schemas";
import {
  type AskQuestionItem,
  type ConversationBackgroundActivity,
  type ConversationState,
} from "@/lib/conversations/schemas";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import type {
  TranscriptMessage,
  ConversationStatus,
} from "@/lib/conversations/schemas";
import { managerStateSchema, type ManagerState } from "@/lib/projects/schemas";
import type { SessionConversationListItem } from "@/lib/state-store";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import type {
  GraphWorkflowAbandonment,
  GraphWorkflowApprovalDecision,
  GraphWorkflowApprovalScope,
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
} from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowStatus } from "@/lib/workflow-graph/definition-schemas";

function convo(
  status: ConversationStatus,
  pendingQuestions: { question: string }[] | null = null,
) {
  return { status, pendingQuestions };
}

function assistantMessage(
  content: TranscriptMessage["content"],
): TranscriptMessage {
  return {
    role: "assistant",
    content,
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

const STRUCTURED_QUESTIONS: AskQuestionItem[] = [
  {
    header: "Deploy",
    question: "Deploy to production now?",
    options: [
      {
        label: "Deploy",
        description: "Start the production deploy.",
        recommended: false,
      },
      { label: "Wait", description: "Do not deploy yet.", recommended: false },
    ],
    multiSelect: false,
    required: true,
    allowNote: true,
  },
];

function makeConversation(
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return makeConversationState({
    status: "new",
    ...overrides,
  });
}

function makeState(
  conversations: ConversationState[],
  graphWorkflowExecution: GraphWorkflowExecution | null = null,
): ManagerState {
  return managerStateSchema.parse({
    projects: {
      "/repo/project": {
        rootPath: "/repo/project",
        sessions: {
          "session-a": {
            sessionName: "session-a",
            worktreePath: "/repo/project/.worktrees/session-a",
            branchName: "cc/session-a",
            createdAt: "2026-01-01T00:00:00.000Z",
            lastActivityAt: "2026-01-01T00:00:00.000Z",
            archived: false,
            finished: false,
            conversations,
            source: "cc",
            creationMode: "normal",
            tddEnabled: true,
            targetBranch: "main",
            parentSessionName: null,
            graphWorkflowExecution,
            referenceDocuments: [],
          },
        },
      },
    },
    archivedProjects: [],
    pinnedProjects: [],
  });
}

/**
 * Project a `ManagerState` fixture into the two focused accessors the handler
 * now consumes. The full session/conversation fixtures carry every field the
 * feed reads, so a controlled cast to the list-item projection keeps the
 * fixtures faithful without re-declaring the projection shapes here.
 */
function stateToActiveDeps(
  state: ManagerState,
): Pick<
  ActiveConversationsRouteDeps,
  "listSessionConversationListItems" | "getArchivedProjects"
> {
  return {
    getArchivedProjects: async () => new Set(state.archivedProjects),
    listSessionConversationListItems: async () =>
      Object.entries(state.projects).flatMap(([projectPath, project]) =>
        Object.values(project.sessions).map(
          (session) =>
            ({
              projectPath,
              session,
              conversations: session.conversations,
            }) as unknown as SessionConversationListItem,
        ),
      ),
  };
}

/**
 * Build the active-executions map the handlers read, keyed by the NUL-separated
 * `${projectPath} ${sessionName}` the production accessor emits. The fixture
 * state's single session is `/repo/project` :: `session-a`.
 */
function activeExecutionsMap(
  graphWorkflowExecution: GraphWorkflowExecution | null,
): Map<string, GraphWorkflowExecution> {
  const map = new Map<string, GraphWorkflowExecution>();
  if (graphWorkflowExecution) {
    map.set(
      `/repo/project${String.fromCharCode(0)}session-a`,
      graphWorkflowExecution,
    );
  }
  return map;
}

async function listRows(
  conversations: ConversationState[],
  graphWorkflowExecution: GraphWorkflowExecution | null = null,
  overrides: Partial<ActiveConversationsRouteDeps> = {},
) {
  const deps: ActiveConversationsRouteDeps = {
    ...stateToActiveDeps(makeState(conversations, graphWorkflowExecution)),
    getProjectDisplayName: vi.fn().mockReturnValue("project"),
    readLastAssistantContent: vi.fn().mockResolvedValue(null),
    listProjectConversations: vi.fn().mockResolvedValue([]),
    listActiveGraphWorkflowExecutions: vi
      .fn()
      .mockResolvedValue(activeExecutionsMap(graphWorkflowExecution)),
    listActiveSpecExecutions: vi.fn().mockResolvedValue([]),
    getBackgroundActivity: () => null,
    ...overrides,
  };
  const handlers = createActiveConversationsRouteHandlers(deps);
  const response = await handlers.GET();
  expect(response.status).toBe(200);
  const body = activeConversationsResponseSchema.parse(await response.json());
  return body.conversations;
}

describe("GET — active spec executions", () => {
  it("serves feed items and drops executions in archived projects", async () => {
    const liveItem = {
      executionId: "spec-execution-live",
      state: "definition_review" as const,
      specSlug: "native-sdd",
      specName: "Native SDD",
      projectPath: "/repo/project",
      projectName: "project",
      sessionName: "session-a",
      createdAt: "2026-07-19T09:00:00.000Z",
    };
    const archivedItem = {
      ...liveItem,
      executionId: "spec-execution-archived",
      projectPath: "/repo/archived",
      projectName: "archived",
    };
    const deps: ActiveConversationsRouteDeps = {
      ...stateToActiveDeps({
        ...makeState([]),
        archivedProjects: ["/repo/archived"],
      }),
      getProjectDisplayName: vi.fn().mockReturnValue("project"),
      readLastAssistantContent: vi.fn().mockResolvedValue(null),
      listProjectConversations: vi.fn().mockResolvedValue([]),
      listActiveGraphWorkflowExecutions: vi
        .fn()
        .mockResolvedValue(activeExecutionsMap(null)),
      listActiveSpecExecutions: vi
        .fn()
        .mockResolvedValue([liveItem, archivedItem]),
      getBackgroundActivity: () => null,
    };

    const handlers = createActiveConversationsRouteHandlers(deps);
    const response = await handlers.GET();
    expect(response.status).toBe(200);
    const body = activeConversationsResponseSchema.parse(await response.json());

    expect(body.specExecutions).toEqual([liveItem]);
  });
});

describe("GET — top-level read concurrency", () => {
  it("does not serialize the project-conversation and workflow reads behind the session-list read", async () => {
    let releaseSessions!: () => void;
    const sessionsGate = new Promise<void>((resolve) => {
      releaseSessions = resolve;
    });
    const listProjectConversations = vi.fn().mockResolvedValue([]);
    const listActiveGraphWorkflowExecutions = vi
      .fn()
      .mockResolvedValue(activeExecutionsMap(null));
    const deps: ActiveConversationsRouteDeps = {
      ...stateToActiveDeps(makeState([])),
      listSessionConversationListItems: vi.fn().mockImplementation(async () => {
        await sessionsGate;
        return [];
      }),
      getProjectDisplayName: vi.fn().mockReturnValue("project"),
      readLastAssistantContent: vi.fn().mockResolvedValue(null),
      listProjectConversations,
      listActiveGraphWorkflowExecutions,
      listActiveSpecExecutions: vi.fn().mockResolvedValue([]),
      getBackgroundActivity: () => null,
    };
    const handlers = createActiveConversationsRouteHandlers(deps);

    const pending = handlers.GET();
    await Promise.resolve();
    await Promise.resolve();
    // All reads are independent; the two list reads must be in flight while the
    // session-list read is still unresolved.
    expect(listProjectConversations).toHaveBeenCalledTimes(1);
    expect(listActiveGraphWorkflowExecutions).toHaveBeenCalledTimes(1);

    releaseSessions();
    const response = await pending;
    expect(response.status).toBe(200);
  });
});

describe("deriveLastActivitySummary", () => {
  it("returns null for status 'new'", () => {
    expect(deriveLastActivitySummary(convo("new"), null)).toBeNull();
  });

  it("returns the truncated first pending question for status 'awaiting'", () => {
    const result = deriveLastActivitySummary(
      convo("awaiting", [{ question: "Do you want to proceed with this?" }]),
      null,
    );
    expect(result).toBe("Do you want to proceed with this?");
  });

  it("returns the truncated first pending question for status 'waiting_for_input'", () => {
    const result = deriveLastActivitySummary(
      convo("waiting_for_input", [
        { question: "Which option fits your goal?" },
      ]),
      null,
    );
    expect(result).toBe("Which option fits your goal?");
  });

  it("returns null for an awaiting conversation that has no pending question text", () => {
    expect(deriveLastActivitySummary(convo("awaiting", null), null)).toBeNull();
  });

  it("truncates pending question text to <=80 characters", () => {
    const longQ = "x".repeat(200);
    const result = deriveLastActivitySummary(
      convo("awaiting", [{ question: longQ }]),
      null,
    );
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(80);
  });

  it("collapses newlines into single spaces in pending question text", () => {
    const result = deriveLastActivitySummary(
      convo("awaiting", [{ question: "Line one\nLine two\n  Line three" }]),
      null,
    );
    expect(result).toBe("Line one Line two Line three");
    expect(result!).not.toMatch(/\n/);
  });

  it("returns null for a running conversation with no transcript message", () => {
    expect(deriveLastActivitySummary(convo("running"), null)).toBeNull();
  });

  it("summarizes a running conversation's latest Edit tool_use as 'Editing <path>'", () => {
    const msg = assistantMessage([
      {
        type: "tool_use",
        name: "Edit",
        input: { file_path: "src/foo.ts", old_string: "a", new_string: "b" },
      },
    ]);
    expect(deriveLastActivitySummary(convo("running"), msg)).toBe(
      "Editing src/foo.ts",
    );
  });

  it("summarizes a Write tool_use as 'Editing <path>'", () => {
    const msg = assistantMessage([
      { type: "tool_use", name: "Write", input: { file_path: "src/bar.ts" } },
    ]);
    expect(deriveLastActivitySummary(convo("running"), msg)).toBe(
      "Editing src/bar.ts",
    );
  });

  it("summarizes a Read tool_use as 'Reading <path>'", () => {
    const msg = assistantMessage([
      { type: "tool_use", name: "Read", input: { file_path: "src/baz.ts" } },
    ]);
    expect(deriveLastActivitySummary(convo("running"), msg)).toBe(
      "Reading src/baz.ts",
    );
  });

  it("summarizes a Bash tool_use as 'Running: <command>'", () => {
    const msg = assistantMessage([
      {
        type: "tool_use",
        name: "Bash",
        input: { command: "bun run test" },
      },
    ]);
    expect(deriveLastActivitySummary(convo("running"), msg)).toBe(
      "Running: bun run test",
    );
  });

  it("summarizes a Grep tool_use as 'Searching <pattern>'", () => {
    const msg = assistantMessage([
      { type: "tool_use", name: "Grep", input: { pattern: "useState" } },
    ]);
    expect(deriveLastActivitySummary(convo("running"), msg)).toBe(
      "Searching useState",
    );
  });

  it("falls back to the latest text block when no tool_use exists", () => {
    const msg = assistantMessage([
      { type: "text", text: "Working through the plan now." },
    ]);
    expect(deriveLastActivitySummary(convo("running"), msg)).toBe(
      "Working through the plan now.",
    );
  });

  it("prefers the last tool_use over an earlier text block", () => {
    const msg = assistantMessage([
      { type: "text", text: "Thinking out loud." },
      { type: "tool_use", name: "Edit", input: { file_path: "src/foo.ts" } },
    ]);
    expect(deriveLastActivitySummary(convo("running"), msg)).toBe(
      "Editing src/foo.ts",
    );
  });

  it("truncates long running-status summaries to <=80 characters with an ellipsis", () => {
    const cmd = "very-long-command ".repeat(20);
    const msg = assistantMessage([
      { type: "tool_use", name: "Bash", input: { command: cmd } },
    ]);
    const result = deriveLastActivitySummary(convo("running"), msg);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(80);
    expect(result!.endsWith("…")).toBe(true);
  });

  it("returns null when the latest assistant message has no recognizable content", () => {
    const msg = assistantMessage([
      { type: "tool_result", tool_use_id: "x", content: "hidden" },
    ]);
    expect(deriveLastActivitySummary(convo("running"), msg)).toBeNull();
  });

  it("never contains newlines in the derived summary", () => {
    const msg = assistantMessage([
      { type: "text", text: "Line A\nLine B\nLine C" },
    ]);
    const result = deriveLastActivitySummary(convo("running"), msg);
    expect(result).not.toBeNull();
    expect(result!).not.toMatch(/\n/);
  });
});

describe("GET /api/conversations/active pending question fields", () => {
  it("populates pendingQuestionId and pendingQuestions for waiting_for_input with a structured Ask-User-Question payload", async () => {
    const rows = await listRows([
      makeConversation({
        id: "structured",
        status: "waiting_for_input",
        pendingQuestionId: "question-123",
        pendingQuestions: STRUCTURED_QUESTIONS,
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.pendingQuestionId).toBe("question-123");
    expect(rows[0]?.pendingQuestions).toEqual(STRUCTURED_QUESTIONS);
  });

  it("returns null pending fields for waiting_for_input with no structured Ask-User-Question payload", async () => {
    const rows = await listRows([
      makeConversation({
        id: "legacy",
        status: "waiting_for_input",
        pendingPromptText: "Please answer in free text.",
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.pendingQuestionId).toBeNull();
    expect(rows[0]?.pendingQuestions).toBeNull();
  });

  it.each(["running", "awaiting", "new"] as const)(
    "returns null pending fields for %s conversations",
    async (status) => {
      const rows = await listRows([
        makeConversation({
          id: status,
          status,
          pendingQuestionId: "question-123",
          pendingQuestions: STRUCTURED_QUESTIONS,
        }),
      ]);

      expect(rows).toHaveLength(1);
      expect(rows[0]?.pendingQuestionId).toBeNull();
      expect(rows[0]?.pendingQuestions).toBeNull();
    },
  );
});

describe("GET /api/conversations/active pending approval standing", () => {
  const GATED_CONVERSATION_ID = "conv-gated";
  const GATED_CONTEXT_ID = "context-implement";
  const REQUESTED_AT = "2026-06-10T09:00:00.000Z";

  const EXPECTED_STANDING = {
    contextId: GATED_CONTEXT_ID,
    contextTitle: "Implement",
    requestedAt: REQUESTED_AT,
    workflowName: null,
    executionSuspended: false,
    enveloped: false,
    tasksCompleted: 0,
    tasksTotal: 1,
  };

  function gatedExecution(
    opts: {
      executionStatus?: GraphWorkflowStatus;
      decision?: GraphWorkflowApprovalDecision | null;
      approvalScope?: GraphWorkflowApprovalScope;
      haltReason?: GraphWorkflowHaltReason | null;
      abandonment?: GraphWorkflowAbandonment | null;
    } = {},
  ): GraphWorkflowExecution {
    // A halted fixture defaults to a resumable reason: the halt event types its
    // reason as non-nullable, so production cannot produce a reasonless halt,
    // and the lease predicate behind this feed reads that reason.
    const haltReason =
      opts.haltReason ??
      (opts.executionStatus === "halted"
        ? ({
            type: "circuit_breaker",
            contextId: GATED_CONTEXT_ID,
            condition: "retry_exhaustion",
            summary: null,
          } as const)
        : null);
    const execution = createWorkflowExecution({
      status: opts.executionStatus ?? "running",
      ...(haltReason ? { haltReason } : {}),
      ...(opts.abandonment ? { abandonment: opts.abandonment } : {}),
    });
    const contextState = execution.contextStates[GATED_CONTEXT_ID];
    if (!contextState) throw new Error("fixture missing gated context");
    contextState.status = "awaiting_approval";
    contextState.pendingApproval = {
      conversationId: GATED_CONVERSATION_ID,
      requestedAt: REQUESTED_AT,
      decision: opts.decision ?? null,
      approvalScope: opts.approvalScope ?? { kind: "whole_tree" },
    };
    return execution;
  }

  function gatedConversation(overrides: Partial<ConversationState> = {}) {
    return makeConversation({
      id: GATED_CONVERSATION_ID,
      status: "awaiting",
      role: "iteration",
      ...overrides,
    });
  }

  it("includes a gated iteration conversation despite the role filter, carrying the standing payload", async () => {
    const rows = await listRows([gatedConversation()], gatedExecution());

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(GATED_CONVERSATION_ID);
    expect(rows[0]?.pendingApproval).toEqual(EXPECTED_STANDING);
  });

  it("marks the standing enveloped from the gate's FROZEN scope", async () => {
    // The sidebar peek decides from this flag whether to fetch the frozen
    // owned-path artifact, so it has to follow the parked record rather than a
    // placement that can be edited while the gate stands (R15.2).
    const rows = await listRows(
      [gatedConversation()],
      gatedExecution({
        approvalScope: {
          kind: "scoped",
          ownedPaths: ["src/api"],
          treeHash: "owned-digest",
          headSha: "base-sha",
        },
      }),
    );

    expect(rows[0]?.pendingApproval?.enveloped).toBe(true);
  });

  it("keeps non-gated iteration and validator conversations hidden", async () => {
    const rows = await listRows(
      [
        gatedConversation(),
        makeConversation({ id: "conv-other-iter", role: "iteration" }),
        makeConversation({ id: "conv-validator", role: "validator" }),
      ],
      gatedExecution(),
    );

    expect(rows.map((r) => r.id)).toEqual([GATED_CONVERSATION_ID]);
  });

  it.each(["new", "running", "awaiting", "waiting_for_input"] as const)(
    "keeps standing independent of conversation status %s",
    async (status) => {
      const rows = await listRows(
        [gatedConversation({ status })],
        gatedExecution(),
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.pendingApproval).toEqual(EXPECTED_STANDING);
    },
  );

  it.each([
    { type: "approved", decidedAt: "2026-06-10T10:00:00.000Z" } as const,
    {
      type: "rejected",
      message: "needs rework",
      decidedAt: "2026-06-10T10:00:00.000Z",
    } as const,
  ])(
    "drops standing the moment a $type decision is recorded",
    async (decision) => {
      const rows = await listRows(
        [gatedConversation()],
        gatedExecution({ decision }),
      );

      expect(rows).toHaveLength(0);
    },
  );

  it.each(["aborted", "completed"] as const)(
    "drops standing when the execution is %s",
    async (executionStatus) => {
      const rows = await listRows(
        [gatedConversation()],
        gatedExecution({ executionStatus }),
      );

      expect(rows).toHaveLength(0);
    },
  );

  it.each(["paused", "halted"] as const)(
    "keeps standing while the execution is %s and flags it suspended",
    async (executionStatus) => {
      const rows = await listRows(
        [gatedConversation()],
        gatedExecution({ executionStatus }),
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.pendingApproval).toEqual({
        ...EXPECTED_STANDING,
        executionSuspended: true,
        enveloped: false,
      });
    },
  );

  /**
   * A gate's standing is lease tenure, not a status set.
   *
   * These two halts are the cases a status set cannot see: the run can never
   * continue, so the approval it is parked on can never be acted on. Keeping it
   * in the Needs-Input feed asks the operator for a decision that would change
   * nothing, forever, with no act available to clear it.
   */
  it("drops standing when a halt is not resumable", async () => {
    const rows = await listRows(
      [gatedConversation()],
      gatedExecution({
        executionStatus: "halted",
        haltReason: { type: "recovery_error", message: "unrecoverable" },
      }),
    );

    expect(rows).toHaveLength(0);
  });

  it("drops standing when a resumable halt has been abandoned", async () => {
    const rows = await listRows(
      [gatedConversation()],
      gatedExecution({
        executionStatus: "halted",
        haltReason: {
          type: "circuit_breaker",
          contextId: GATED_CONTEXT_ID,
          condition: "retry_exhaustion",
          summary: null,
        },
        abandonment: {
          abandonedAt: "2026-06-10T11:00:00.000Z",
          actor: { kind: "human" },
          reason: "superseded",
        },
      }),
    );

    expect(rows).toHaveLength(0);
  });

  it("drops standing for a pending execution that has not started", async () => {
    // `pending` holds the lease but is still awaiting its own definition
    // approval, so no context of it is running and a park on one is not yet a
    // fact. Both halves of that are why the gate predicate is
    // `holdsActionableGate`, not the lease alone.
    const rows = await listRows(
      [gatedConversation()],
      gatedExecution({ executionStatus: "pending" }),
    );

    expect(rows).toHaveLength(0);
  });

  it("keeps archived conversations excluded even when gated", async () => {
    const rows = await listRows(
      [gatedConversation({ archived: true })],
      gatedExecution(),
    );

    expect(rows).toHaveLength(0);
  });

  it("returns null pendingApproval for non-gated rows", async () => {
    const rows = await listRows(
      [makeConversation({ id: "conv-plain", status: "running" })],
      gatedExecution(),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.pendingApproval).toBeNull();
  });

  it("returns null pendingApproval for project-scope rows", async () => {
    const deps: ActiveConversationsRouteDeps = {
      ...stateToActiveDeps(makeState([])),
      getProjectDisplayName: vi.fn().mockReturnValue("project"),
      readLastAssistantContent: vi.fn().mockResolvedValue(null),
      listProjectConversations: vi.fn().mockResolvedValue([
        {
          projectPath: "/repo/project",
          conversation: makeConversation({ id: "proj-conv", status: "new" }),
        },
      ]),
      listActiveGraphWorkflowExecutions: vi
        .fn()
        .mockResolvedValue(activeExecutionsMap(null)),
      listActiveSpecExecutions: vi.fn().mockResolvedValue([]),
      getBackgroundActivity: () => null,
    };
    const handlers = createActiveConversationsRouteHandlers(deps);
    const response = await handlers.GET();
    expect(response.status).toBe(200);
    const body = activeConversationsResponseSchema.parse(await response.json());

    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]?.pendingApproval).toBeNull();
  });
});

describe("GET /api/conversations/active background activity", () => {
  const ACTIVITY: ConversationBackgroundActivity = {
    updatedAt: "2026-07-28T10:00:01.000Z",
    tasks: [
      {
        taskId: "task-a",
        description: "full regression suite",
        taskType: "local_workflow",
        workflowName: "spec",
        subagentType: null,
        lastToolName: "Bash",
        totalTokens: 4200,
        toolUses: 7,
        startedAt: "2026-07-28T10:00:00.000Z",
        lastActivityAt: "2026-07-28T10:00:01.000Z",
      },
    ],
  };

  it("carries the live snapshot onto the session row", async () => {
    const rows = await listRows(
      [makeConversation({ id: "conv-1", status: "awaiting" })],
      null,
      { getBackgroundActivity: (id) => (id === "conv-1" ? ACTIVITY : null) },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.backgroundActivity).toEqual(ACTIVITY);
  });

  it("is null when the conversation has no live background work", async () => {
    const rows = await listRows([
      makeConversation({ id: "conv-1", status: "awaiting" }),
    ]);

    expect(rows[0]?.backgroundActivity).toBeNull();
  });

  it("carries the live snapshot onto a project-scope row", async () => {
    const deps: ActiveConversationsRouteDeps = {
      ...stateToActiveDeps(makeState([])),
      getProjectDisplayName: vi.fn().mockReturnValue("project"),
      readLastAssistantContent: vi.fn().mockResolvedValue(null),
      listProjectConversations: vi.fn().mockResolvedValue([
        {
          projectPath: "/repo/project",
          conversation: makeConversation({
            id: "proj-conv",
            status: "awaiting",
          }),
        },
      ]),
      listActiveGraphWorkflowExecutions: vi
        .fn()
        .mockResolvedValue(activeExecutionsMap(null)),
      listActiveSpecExecutions: vi.fn().mockResolvedValue([]),
      getBackgroundActivity: (id) => (id === "proj-conv" ? ACTIVITY : null),
    };
    const handlers = createActiveConversationsRouteHandlers(deps);
    const body = activeConversationsResponseSchema.parse(
      await (await handlers.GET()).json(),
    );

    expect(body.conversations[0]?.backgroundActivity).toEqual(ACTIVITY);
  });
});
