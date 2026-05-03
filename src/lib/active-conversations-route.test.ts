import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createActiveConversationsRouteHandlers,
  type ActiveConversationsRouteDeps,
} from "./active-conversations-route-handlers";
import type { ManagerState, ConversationStatus } from "@/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConversation(
  overrides: {
    id?: string;
    status?: ConversationStatus;
    archived?: boolean;
    name?: string | null;
    summary?: string | null;
    role?: string | null;
    agentBackend?: "claude" | "codex";
  } = {},
) {
  return {
    id: overrides.id ?? "conv-1",
    name: overrides.name ?? null,
    transcriptPath: null,
    status: overrides.status ?? "new",
    promptCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    source: "cc" as const,
    summary: overrides.summary ?? null,
    archived: overrides.archived ?? false,
    totalCostUsd: null,
    totalDurationMs: null,
    totalTurns: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    forkedFrom: null,
    role: overrides.role ?? null,
    contextTokens: null,
    contextWindowMax: null,
    agentBackend: overrides.agentBackend ?? ("claude" as const),
  };
}

function makeState(
  overrides: Partial<ManagerState> & {
    sessions?: Record<
      string,
      {
        sessionName: string;
        archived?: boolean;
        conversations: ReturnType<typeof makeConversation>[];
        graphWorkflowExecution?: unknown;
        workflowEnvelopes?: Record<string, unknown>;
      }
    >;
  } = {},
): ManagerState {
  const sessions: Record<string, unknown> = {};
  for (const [key, s] of Object.entries(overrides.sessions ?? {})) {
    sessions[key] = {
      sessionName: s.sessionName,
      worktreePath: `/tmp/${s.sessionName}`,
      branchName: `csm/${s.sessionName}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-01T00:00:00.000Z",
      archived: s.archived ?? false,
      finished: false,
      conversations: s.conversations,
      source: "cc",
      objective: null,
      creationMode: "fast",
      tddEnabled: true,
      graphWorkflowExecution: s.graphWorkflowExecution ?? null,
      graphWorkflowExecutionHistory: [],
      ...(s.workflowEnvelopes
        ? { workflowEnvelopes: s.workflowEnvelopes }
        : {}),
    };
  }

  return {
    projects: {
      "/home/user/my-project": {
        rootPath: "/home/user/my-project",
        sessions,
        roadmapItems: [],
      },
    },
    archivedProjects: overrides.archivedProjects ?? [],
    pinnedProjects: overrides.pinnedProjects ?? [],
  } as ManagerState;
}

// ---------------------------------------------------------------------------
// Mock deps
// ---------------------------------------------------------------------------

function createTestDeps(): ActiveConversationsRouteDeps {
  return {
    readState: vi.fn().mockResolvedValue(makeState()),
    getProjectDisplayName: vi.fn().mockReturnValue("my-project"),
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let deps: ActiveConversationsRouteDeps;
let handlers: ReturnType<typeof createActiveConversationsRouteHandlers>;

beforeEach(() => {
  vi.clearAllMocks();
  deps = createTestDeps();
  handlers = createActiveConversationsRouteHandlers(deps);
});

// ===========================================================================
// Tests
// ===========================================================================

describe("GET /api/conversations/active", () => {
  it("includes conversations with 'new' status", async () => {
    vi.mocked(deps.readState).mockResolvedValue(
      makeState({
        sessions: {
          "my-session": {
            sessionName: "my-session",
            conversations: [
              makeConversation({ id: "conv-new", status: "new" }),
            ],
          },
        },
      }),
    );

    const response = await handlers.GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0].id).toBe("conv-new");
    expect(body.conversations[0].status).toBe("new");
  });

  it("includes all active statuses: new, running, awaiting, waiting_for_input", async () => {
    vi.mocked(deps.readState).mockResolvedValue(
      makeState({
        sessions: {
          "my-session": {
            sessionName: "my-session",
            conversations: [
              makeConversation({ id: "c1", status: "new" }),
              makeConversation({ id: "c2", status: "running" }),
              makeConversation({ id: "c3", status: "awaiting" }),
              makeConversation({ id: "c4", status: "waiting_for_input" }),
            ],
          },
        },
      }),
    );

    const response = await handlers.GET();
    const body = await response.json();

    expect(body.conversations).toHaveLength(4);
    const statuses = body.conversations.map(
      (c: { status: string }) => c.status,
    );
    expect(statuses).toContain("new");
    expect(statuses).toContain("running");
    expect(statuses).toContain("awaiting");
    expect(statuses).toContain("waiting_for_input");
  });

  it("excludes archived conversations", async () => {
    vi.mocked(deps.readState).mockResolvedValue(
      makeState({
        sessions: {
          "my-session": {
            sessionName: "my-session",
            conversations: [
              makeConversation({ id: "c1", status: "new", archived: true }),
              makeConversation({ id: "c2", status: "awaiting" }),
            ],
          },
        },
      }),
    );

    const response = await handlers.GET();
    const body = await response.json();

    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0].id).toBe("c2");
  });

  it("excludes conversations in archived sessions", async () => {
    vi.mocked(deps.readState).mockResolvedValue(
      makeState({
        sessions: {
          "archived-session": {
            sessionName: "archived-session",
            archived: true,
            conversations: [makeConversation({ id: "c1", status: "new" })],
          },
        },
      }),
    );

    const response = await handlers.GET();
    const body = await response.json();

    expect(body.conversations).toHaveLength(0);
  });

  it("sorts conversations by most recent activity first", async () => {
    vi.mocked(deps.readState).mockResolvedValue(
      makeState({
        sessions: {
          "my-session": {
            sessionName: "my-session",
            conversations: [
              {
                ...makeConversation({ id: "older", status: "new" }),
                lastActivityAt: "2026-01-01T00:00:00.000Z",
              },
              {
                ...makeConversation({ id: "newer", status: "awaiting" }),
                lastActivityAt: "2026-01-02T00:00:00.000Z",
              },
            ],
          },
        },
      }),
    );

    const response = await handlers.GET();
    const body = await response.json();

    expect(body.conversations[0].id).toBe("newer");
    expect(body.conversations[1].id).toBe("older");
  });

  it("returns active graph workflow executions", async () => {
    vi.mocked(deps.readState).mockResolvedValue(
      makeState({
        sessions: {
          "my-session": {
            sessionName: "my-session",
            conversations: [makeConversation({ id: "c1", status: "running" })],
            graphWorkflowExecution: {
              id: "exec-1",
              seedDefinitionId: "def-1",
              seedDefinitionRevision: 1,
              workingDefinition: {
                schemaVersion: 1,
                executionContexts: [
                  {
                    id: "ctx-1",
                    title: "Plan",
                    description: "Plan the work",
                    agent: { model: "opus", reasoningEffort: "high" },
                    mutability: { allowAgentTaskAdd: false },
                    circuitBreaker: {},
                    iterationPolicy: { maxIterations: 3 },
                  },
                  {
                    id: "ctx-2",
                    title: "Implement",
                    description: "Do the work",
                    agent: { model: "sonnet", reasoningEffort: "medium" },
                    mutability: { allowAgentTaskAdd: false },
                    circuitBreaker: {},
                    iterationPolicy: { maxIterations: 3 },
                  },
                ],
                tasks: [],
                edges: [],
              },
              status: "running",
              activeContextId: "ctx-1",
              contextStates: {
                "ctx-1": {
                  contextId: "ctx-1",
                  status: "running",
                  totalTaskCount: 2,
                  completedTaskCount: 1,
                  iterationCount: 1,
                  consecutiveFailureCount: 0,
                },
                "ctx-2": {
                  contextId: "ctx-2",
                  status: "pending",
                  totalTaskCount: 1,
                  completedTaskCount: 0,
                  iterationCount: 0,
                  consecutiveFailureCount: 0,
                },
              },
              taskStates: {},
              sharedDocuments: [],
              machineSnapshot: null,
              history: [],
              startedAt: "2026-01-01T12:00:00.000Z",
              completedAt: null,
              haltReason: null,
            },
          },
        },
      }),
    );

    const response = await handlers.GET();
    const body = await response.json();

    expect(body.conversations).toHaveLength(1);
    expect(body.graphWorkflowExecutions).toHaveLength(1);
    expect(body.graphWorkflowExecutions[0]).toEqual({
      executionId: "exec-1",
      status: "running",
      projectName: "my-project",
      projectPath: "/home/user/my-project",
      sessionName: "my-session",
      activeContextTitle: "Plan",
      completedContexts: 0,
      totalContexts: 2,
      startedAt: "2026-01-01T12:00:00.000Z",
    });
  });

  it("excludes conversations with role 'iteration' (graph workflow)", async () => {
    vi.mocked(deps.readState).mockResolvedValue(
      makeState({
        sessions: {
          "my-session": {
            sessionName: "my-session",
            conversations: [
              makeConversation({ id: "c1", status: "running" }),
              makeConversation({
                id: "c2",
                status: "running",
                role: "iteration",
              }),
              makeConversation({
                id: "c3",
                status: "awaiting",
                role: "validator",
              }),
            ],
          },
        },
      }),
    );

    const response = await handlers.GET();
    const body = await response.json();

    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0].id).toBe("c1");
  });

  it("returns active collaboration executions read from session.workflowEnvelopes", async () => {
    vi.mocked(deps.readState).mockResolvedValue(
      makeState({
        sessions: {
          "my-session": {
            sessionName: "my-session",
            conversations: [makeConversation({ id: "c1", status: "running" })],
            workflowEnvelopes: {
              "collab-running": {
                workflowId: "collab-running",
                workflowType: "collaboration",
                status: "running",
                phase: "round_2",
                createdAt: "2026-01-01T10:00:00.000Z",
                updatedAt: "2026-01-01T10:30:00.000Z",
                featureSnapshot: {
                  rounds: 2,
                  conversationId: "conv-x",
                },
              },
              "collab-paused": {
                workflowId: "collab-paused",
                workflowType: "collaboration",
                status: "paused",
                phase: "paused_round_2",
                createdAt: "2026-01-01T11:00:00.000Z",
                updatedAt: "2026-01-01T11:15:00.000Z",
                featureSnapshot: { rounds: 2, conversationId: "conv-y" },
              },
              "collab-completed": {
                workflowId: "collab-completed",
                workflowType: "collaboration",
                status: "completed",
                phase: "completed_converged",
                createdAt: "2026-01-01T09:00:00.000Z",
                updatedAt: "2026-01-01T09:30:00.000Z",
                featureSnapshot: {},
              },
              "graph-wf-1": {
                workflowId: "graph-wf-1",
                workflowType: "graph_workflow",
                status: "running",
                phase: "iteration",
                createdAt: "2026-01-01T12:00:00.000Z",
                updatedAt: "2026-01-01T12:00:00.000Z",
                featureSnapshot: {},
              },
            },
          },
        },
      }),
    );

    const response = await handlers.GET();
    const body = await response.json();

    expect(body.activeCollaborationExecutions).toHaveLength(2);
    const ids = body.activeCollaborationExecutions
      .map((e: { workflowId: string }) => e.workflowId)
      .sort();
    expect(ids).toEqual(["collab-paused", "collab-running"]);

    const running = body.activeCollaborationExecutions.find(
      (e: { workflowId: string }) => e.workflowId === "collab-running",
    );
    expect(running).toEqual({
      workflowId: "collab-running",
      status: "running",
      phase: "round_2",
      projectName: "my-project",
      projectPath: "/home/user/my-project",
      sessionName: "my-session",
      conversationId: "conv-x",
      createdAt: "2026-01-01T10:00:00.000Z",
      updatedAt: "2026-01-01T10:30:00.000Z",
    });
  });

  it("returns an empty activeCollaborationExecutions array when no envelopes exist", async () => {
    vi.mocked(deps.readState).mockResolvedValue(
      makeState({
        sessions: {
          "my-session": {
            sessionName: "my-session",
            conversations: [makeConversation({ id: "c1", status: "running" })],
          },
        },
      }),
    );

    const response = await handlers.GET();
    const body = await response.json();

    expect(body.activeCollaborationExecutions).toEqual([]);
  });

  it("ignores non-collaboration workflow envelopes when computing activeCollaborationExecutions", async () => {
    vi.mocked(deps.readState).mockResolvedValue(
      makeState({
        sessions: {
          "my-session": {
            sessionName: "my-session",
            conversations: [makeConversation({ id: "c1", status: "running" })],
            workflowEnvelopes: {
              "graph-wf-1": {
                workflowId: "graph-wf-1",
                workflowType: "graph_workflow",
                status: "running",
                phase: "iteration",
                createdAt: "2026-01-01T12:00:00.000Z",
                updatedAt: "2026-01-01T12:00:00.000Z",
                featureSnapshot: {},
              },
            },
          },
        },
      }),
    );

    const response = await handlers.GET();
    const body = await response.json();

    expect(body.activeCollaborationExecutions).toEqual([]);
  });

  it("excludes collaboration envelopes from archived sessions", async () => {
    vi.mocked(deps.readState).mockResolvedValue(
      makeState({
        sessions: {
          "archived-session": {
            sessionName: "archived-session",
            archived: true,
            conversations: [],
            workflowEnvelopes: {
              "collab-1": {
                workflowId: "collab-1",
                workflowType: "collaboration",
                status: "running",
                phase: "round_1",
                createdAt: "2026-01-01T10:00:00.000Z",
                updatedAt: "2026-01-01T10:00:00.000Z",
                featureSnapshot: {},
              },
            },
          },
        },
      }),
    );

    const response = await handlers.GET();
    const body = await response.json();

    expect(body.activeCollaborationExecutions).toEqual([]);
  });

  it("returns 500 when readState fails", async () => {
    vi.mocked(deps.readState).mockRejectedValue(new Error("Disk error"));

    const response = await handlers.GET();
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Disk error");
  });
});
