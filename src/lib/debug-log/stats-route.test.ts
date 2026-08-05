import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createDebugLogStatsHandlers,
  type DebugLogStatsDeps,
} from "./stats-route-handlers";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_CONVERSATION: ConversationState = {
  id: "conv-1",
  scope: "session",
  nameOrigin: "default",
  status: "awaiting",
  transcriptPath: "/tmp/transcript.jsonl",
  totalCostUsd: 0,
  totalDurationMs: 0,
  totalTurns: 0,
  promptCount: 0,
  createdAt: "2025-01-01T00:00:00Z",
  lastActivityAt: "2025-01-01T00:00:00Z",
  archived: false,
  name: null,
  source: "cc",
  summary: null,
  pendingQuestionId: null,
  pendingQuestions: null,
  pendingPromptText: null,
  forkedFrom: null,
  role: null,
  activeTurnSource: null,
  contextTokens: null,
  contextWindowMax: null,
  debugMode: {
    active: true,
    recording: true,
    logFilePath: "/tmp/.debug/logs.jsonl",
    enteredAt: "2025-01-01T00:00:00Z",
    hypotheses: [],
    reproductionSteps: [],
    instructionsDelivered: false,
    phase: "hypothesizing",
    fixSummary: null,
    verificationSteps: [],
    lastTurnFailed: false,
  },
  agentBackend: "claude" as const,
  backendRef: null,
  unread: false,
  lastSeenAlignmentVersion: null,
  pendingAgentNotices: [],
  pendingQueue: [],
};

const BASE_SESSION: SessionState = {
  sessionName: "test-session",
  branchName: "csm/test-session",
  worktreePath: "/tmp/worktree",
  conversations: [BASE_CONVERSATION],
  createdAt: "2025-01-01T00:00:00Z",
  lastActivityAt: "2025-01-01T00:00:00Z",
  archived: false,
  finished: false,
  source: "cc",
  creationMode: "normal",
  tddEnabled: false,
  targetBranch: "main",
  parentSessionName: null,
  graphWorkflowExecution: null,
  referenceDocuments: [],
};

function createTestDeps(
  overrides: Partial<DebugLogStatsDeps> = {},
): DebugLogStatsDeps {
  return {
    resolveProjectPath: vi.fn().mockResolvedValue("/home/projects/test-proj"),
    getSession: vi.fn().mockResolvedValue(BASE_SESSION),
    getDebugLogStats: vi
      .fn()
      .mockReturnValue({ entryCount: 5, hypothesesSeen: ["H1", "H2"] }),
    ...overrides,
  };
}

function makeRequest(): Request {
  return new Request("http://localhost/api/debug-mode/logs", {
    method: "GET",
  });
}

function makeParams(overrides: Record<string, string> = {}): {
  params: Promise<Record<string, string>>;
} {
  return {
    params: Promise.resolve({
      name: "test-proj",
      session: "test-session",
      conversationId: "conv-1",
      ...overrides,
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let deps: DebugLogStatsDeps;
let handlers: ReturnType<typeof createDebugLogStatsHandlers>;

beforeEach(() => {
  vi.clearAllMocks();
  deps = createTestDeps();
  handlers = createDebugLogStatsHandlers(deps);
});

describe("GET debug-mode/logs (stats)", () => {
  it("returns entryCount for an active debug conversation", async () => {
    const response = await handlers.GET(makeRequest(), makeParams());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ entryCount: 5 });
    expect(deps.getDebugLogStats).toHaveBeenCalledWith(
      "/tmp/.debug/logs.jsonl",
    );
  });

  it("returns 404 when project is not found", async () => {
    deps = createTestDeps({
      resolveProjectPath: vi.fn().mockResolvedValue(null),
    });
    handlers = createDebugLogStatsHandlers(deps);

    const response = await handlers.GET(makeRequest(), makeParams());

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Project not found");
  });

  it("returns 404 when session is not found", async () => {
    deps = createTestDeps({
      getSession: vi.fn().mockResolvedValue(null),
    });
    handlers = createDebugLogStatsHandlers(deps);

    const response = await handlers.GET(makeRequest(), makeParams());

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Session not found");
  });

  it("returns 404 when conversation is not found", async () => {
    const response = await handlers.GET(
      makeRequest(),
      makeParams({ conversationId: "nonexistent" }),
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Conversation not found");
  });

  it("returns 409 when debug mode is not active", async () => {
    deps = createTestDeps({
      getSession: vi.fn().mockResolvedValue({
        ...BASE_SESSION,
        conversations: [{ ...BASE_CONVERSATION, debugMode: null }],
      }),
    });
    handlers = createDebugLogStatsHandlers(deps);

    const response = await handlers.GET(makeRequest(), makeParams());

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe("Conversation is not in debug mode");
  });

  it("returns entryCount 0 when log file is empty", async () => {
    deps = createTestDeps({
      getDebugLogStats: vi
        .fn()
        .mockReturnValue({ entryCount: 0, hypothesesSeen: [] }),
    });
    handlers = createDebugLogStatsHandlers(deps);

    const response = await handlers.GET(makeRequest(), makeParams());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ entryCount: 0 });
  });
});
