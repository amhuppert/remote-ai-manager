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
  } = {},
) {
  return {
    id: overrides.id ?? "conv-1",
    name: overrides.name ?? null,
    claudeSessionId: null,
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
    role: null,
    contextTokens: null,
    contextWindowMax: null,
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
      workflow: null,
      workflowHistory: [],
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

  it("returns 500 when readState fails", async () => {
    vi.mocked(deps.readState).mockRejectedValue(new Error("Disk error"));

    const response = await handlers.GET();
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Disk error");
  });
});
