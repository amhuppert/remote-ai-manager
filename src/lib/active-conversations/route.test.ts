import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createActiveConversationsRouteHandlers,
  type ActiveConversationsRouteDeps,
} from "./route-handlers";
import type { ConversationStatus } from "@/lib/conversations/schemas";
import type { ManagerState } from "@/lib/projects/schemas";
import type { SessionConversationListItem } from "@/lib/state-store";

/**
 * Internal fixture source shared by the derived accessors. Tests reconfigure it
 * via `deps.readState.mockResolvedValue(makeState(...))`; the handler itself
 * never receives it — the list-item and archived-project accessors project from
 * it, mirroring how the production accessors read the same rows.
 */
type TestDeps = ActiveConversationsRouteDeps & {
  readState: ReturnType<typeof vi.fn>;
};
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
    transcriptPath?: string | null;
    pendingQuestionId?: string | null;
    pendingQuestions?: { question: string }[] | null;
    forkedFrom?: {
      sourceConversationId: string;
      messageIndex: number;
      forkMode: "native" | "synthetic" | null;
    } | null;
    debugMode?: { active: boolean } | null;
  } = {},
) {
  return {
    id: overrides.id ?? "conv-1",
    name: overrides.name ?? null,
    transcriptPath: overrides.transcriptPath ?? null,
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
    pendingQuestionId: overrides.pendingQuestionId ?? null,
    pendingQuestions: overrides.pendingQuestions ?? null,
    pendingPromptText: null,
    forkedFrom: overrides.forkedFrom ?? null,
    role: overrides.role ?? null,
    contextTokens: null,
    contextWindowMax: null,
    debugMode: overrides.debugMode ?? null,
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
      },
    },
    archivedProjects: overrides.archivedProjects ?? [],
    pinnedProjects: overrides.pinnedProjects ?? [],
  } as ManagerState;
}

// ---------------------------------------------------------------------------
// Mock deps
// ---------------------------------------------------------------------------

function createTestDeps(): TestDeps {
  const readState = vi.fn().mockResolvedValue(makeState());
  return {
    readState,
    listSessionConversationListItems: vi.fn(async () => {
      const state: ManagerState = await readState();
      return Object.entries(state.projects).flatMap(([projectPath, project]) =>
        Object.values(project.sessions).map(
          (session) =>
            ({
              projectPath,
              session,
              conversations: session.conversations,
            }) as unknown as SessionConversationListItem,
        ),
      );
    }),
    getArchivedProjects: vi.fn(async (): Promise<Set<string>> => {
      const state: ManagerState = await readState();
      return new Set(state.archivedProjects);
    }),
    getProjectDisplayName: vi.fn().mockReturnValue("my-project"),
    readLastAssistantContent: vi.fn().mockResolvedValue(null),
    listProjectConversations: vi.fn().mockResolvedValue([]),
    getBackgroundActivity: () => null,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let deps: TestDeps;
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
  it("sidebar includes archived conversations only from active sessions and projects", async () => {
    deps.readState.mockResolvedValue(
      makeState({
        sessions: {
          active: {
            sessionName: "active",
            conversations: [
              makeConversation({ id: "live" }),
              makeConversation({ id: "archived", archived: true }),
              makeConversation({ id: "validator", role: "validator" }),
            ],
          },
          hidden: {
            sessionName: "hidden",
            archived: true,
            conversations: [makeConversation({ id: "hidden", archived: true })],
          },
        },
      }),
    );
    const response = await handlers.GET(
      new Request(
        "http://localhost/api/conversations/active?view=sidebar&includeArchived=true",
      ),
    );
    const body = await response.json();
    expect(body.conversations.map((row: { id: string }) => row.id)).toEqual([
      "live",
      "archived",
      "validator",
    ]);
    expect(
      body.conversations.find((row: { id: string }) => row.id === "archived")
        .archived,
    ).toBe(true);
    const withoutArchive = await handlers.GET(
      new Request("http://localhost/api/conversations/active?view=sidebar"),
    );
    expect(
      (await withoutArchive.json()).conversations.map(
        (row: { id: string }) => row.id,
      ),
    ).toEqual(["live", "validator"]);
    const ordinary = await handlers.GET();
    expect(
      (await ordinary.json()).conversations.map(
        (row: { id: string }) => row.id,
      ),
    ).toEqual(["live"]);
    deps.getArchivedProjects = async () => new Set(["/home/user/my-project"]);
    const hidden = await handlers.GET(
      new Request(
        "http://localhost/api/conversations/active?view=sidebar&includeArchived=true",
      ),
    );
    expect((await hidden.json()).conversations).toEqual([]);
  });
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

  it("includes a graph workflow lane when it has a pending question", async () => {
    vi.mocked(deps.readState).mockResolvedValue(
      makeState({
        sessions: {
          "my-session": {
            sessionName: "my-session",
            conversations: [
              makeConversation({
                id: "workflow-question",
                status: "waiting_for_input",
                role: "iteration",
                pendingQuestionId: "question-batch-1",
                pendingQuestions: [{ question: "Which API should I use?" }],
              }),
            ],
          },
        },
      }),
    );

    const response = await handlers.GET();
    const body = await response.json();

    expect(body.conversations).toEqual([
      expect.objectContaining({
        id: "workflow-question",
        status: "waiting_for_input",
        role: "iteration",
        pendingQuestion: "Which API should I use?",
        pendingQuestionId: "question-batch-1",
        pendingQuestions: [{ question: "Which API should I use?" }],
      }),
    ]);
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

  // ---------------------------------------------------------------------------
  // Per-field round-trip tests for the enriched conversation shape
  // ---------------------------------------------------------------------------

  it("returns lastActivitySummary derived from the latest assistant tool_use for a running conversation, and pendingQuestion null", async () => {
    vi.mocked(deps.readState).mockResolvedValue(
      makeState({
        sessions: {
          "my-session": {
            sessionName: "my-session",
            conversations: [
              makeConversation({
                id: "running-conv",
                status: "running",
                transcriptPath: "/tmp/transcripts/running-conv.jsonl",
              }),
            ],
          },
        },
      }),
    );
    vi.mocked(deps.readLastAssistantContent).mockResolvedValue([
      {
        type: "tool_use" as const,
        name: "Edit",
        input: { file_path: "src/foo.ts" },
      },
    ]);

    const response = await handlers.GET();
    const body = await response.json();

    expect(body.conversations).toHaveLength(1);
    const c = body.conversations[0];
    expect(c.status).toBe("running");
    expect(c.lastActivitySummary).toBe("Editing src/foo.ts");
    expect(c.pendingQuestion).toBeNull();
  });

  it("returns pendingQuestion populated and lastActivitySummary derived for an awaiting conversation", async () => {
    vi.mocked(deps.readState).mockResolvedValue(
      makeState({
        sessions: {
          "my-session": {
            sessionName: "my-session",
            conversations: [
              makeConversation({
                id: "awaiting-conv",
                status: "awaiting",
                pendingQuestions: [{ question: "Do you want to deploy now?" }],
              }),
            ],
          },
        },
      }),
    );

    const response = await handlers.GET();
    const body = await response.json();

    expect(body.conversations).toHaveLength(1);
    const c = body.conversations[0];
    expect(c.pendingQuestion).toBe("Do you want to deploy now?");
    expect(c.lastActivitySummary).toBe("Do you want to deploy now?");
  });

  it("surfaces forkedFrom with mode 'synthetic' for a synthetic-forked conversation", async () => {
    vi.mocked(deps.readState).mockResolvedValue(
      makeState({
        sessions: {
          "my-session": {
            sessionName: "my-session",
            conversations: [
              makeConversation({
                id: "fork-syn",
                status: "running",
                forkedFrom: {
                  sourceConversationId: "parent-id",
                  messageIndex: 7,
                  forkMode: "synthetic",
                },
              }),
            ],
          },
        },
      }),
    );

    const response = await handlers.GET();
    const body = await response.json();

    expect(body.conversations[0].forkedFrom).toEqual({
      conversationId: "parent-id",
      messageIndex: 7,
      mode: "synthetic",
    });
  });

  it("surfaces forkedFrom with mode 'native' for a native-forked conversation", async () => {
    vi.mocked(deps.readState).mockResolvedValue(
      makeState({
        sessions: {
          "my-session": {
            sessionName: "my-session",
            conversations: [
              makeConversation({
                id: "fork-nat",
                status: "running",
                forkedFrom: {
                  sourceConversationId: "parent-id",
                  messageIndex: 3,
                  forkMode: "native",
                },
              }),
            ],
          },
        },
      }),
    );

    const response = await handlers.GET();
    const body = await response.json();

    expect(body.conversations[0].forkedFrom).toEqual({
      conversationId: "parent-id",
      messageIndex: 3,
      mode: "native",
    });
  });

  it("exposes debugActive=true for a conversation in debug mode", async () => {
    vi.mocked(deps.readState).mockResolvedValue(
      makeState({
        sessions: {
          "my-session": {
            sessionName: "my-session",
            conversations: [
              makeConversation({
                id: "dbg",
                status: "running",
                debugMode: { active: true },
              }),
            ],
          },
        },
      }),
    );

    const response = await handlers.GET();
    const body = await response.json();

    expect(body.conversations[0].debugActive).toBe(true);
  });

  it("returns role=null and branchName from the session for a normal (no-role) conversation", async () => {
    vi.mocked(deps.readState).mockResolvedValue(
      makeState({
        sessions: {
          "my-session": {
            sessionName: "my-session",
            conversations: [
              makeConversation({ id: "plain", status: "running" }),
            ],
          },
        },
      }),
    );

    const response = await handlers.GET();
    const body = await response.json();

    expect(body.conversations[0].role).toBeNull();
    expect(body.conversations[0].branchName).toBe("csm/my-session");
  });

  it("returns worktreePath from the session for a conversation", async () => {
    vi.mocked(deps.readState).mockResolvedValue(
      makeState({
        sessions: {
          "my-session": {
            sessionName: "my-session",
            conversations: [
              makeConversation({ id: "plain", status: "running" }),
            ],
          },
        },
      }),
    );

    const response = await handlers.GET();
    const body = await response.json();

    expect(body.conversations[0].worktreePath).toBe("/tmp/my-session");
  });

  it("returns lastActivitySummary=null when no excerpt is derivable (running, empty transcript)", async () => {
    vi.mocked(deps.readState).mockResolvedValue(
      makeState({
        sessions: {
          "my-session": {
            sessionName: "my-session",
            conversations: [
              makeConversation({
                id: "no-derivable",
                status: "running",
                transcriptPath: "/tmp/transcripts/empty.jsonl",
              }),
            ],
          },
        },
      }),
    );
    vi.mocked(deps.readLastAssistantContent).mockResolvedValue(null);

    const response = await handlers.GET();
    const body = await response.json();

    expect(body.conversations[0].lastActivitySummary).toBeNull();
  });

  it("preserves the iteration/validator role filter — those conversations do not appear in the response", async () => {
    vi.mocked(deps.readState).mockResolvedValue(
      makeState({
        sessions: {
          "my-session": {
            sessionName: "my-session",
            conversations: [
              makeConversation({ id: "keep", status: "running" }),
              makeConversation({
                id: "skip-iter",
                status: "running",
                role: "iteration",
              }),
              makeConversation({
                id: "skip-validator",
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

    const ids = body.conversations.map((c: { id: string }) => c.id);
    expect(ids).toEqual(["keep"]);
    expect(ids).not.toContain("skip-iter");
    expect(ids).not.toContain("skip-validator");
  });

  it("returns 500 when readState fails", async () => {
    vi.mocked(deps.readState).mockRejectedValue(new Error("Disk error"));

    const response = await handlers.GET();
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Disk error");
  });

  it("parallelizes per-conversation transcript reads", async () => {
    const N = 10;
    const LATENCY_MS = 20;

    const sessions: Record<
      string,
      {
        sessionName: string;
        conversations: ReturnType<typeof makeConversation>[];
      }
    > = {};
    for (let i = 0; i < N; i++) {
      const sessionName = `session-${i}`;
      sessions[sessionName] = {
        sessionName,
        conversations: [
          makeConversation({
            id: `conv-${i}`,
            status: "running",
            transcriptPath: `/tmp/transcripts/conv-${i}.jsonl`,
          }),
        ],
      };
    }

    vi.mocked(deps.readState).mockResolvedValue(makeState({ sessions }));
    vi.mocked(deps.readLastAssistantContent).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, LATENCY_MS));
      return null;
    });

    const start = performance.now();
    const response = await handlers.GET();
    const elapsed = performance.now() - start;

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.conversations).toHaveLength(N);
    expect(deps.readLastAssistantContent).toHaveBeenCalledTimes(N);
    expect(elapsed).toBeLessThan(60);
  });
});
