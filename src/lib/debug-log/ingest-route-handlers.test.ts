import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createDebugLogsIngestHandlers,
  type DebugLogsIngestDeps,
} from "./ingest-route-handlers";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { ManagerState } from "@/lib/projects/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
const BASE_CONVERSATION: ConversationState = {
  id: "conv-1",
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
    logFilePath: "/tmp/.debug/conv-1/logs.jsonl",
    enteredAt: "2025-01-01T00:00:00Z",
    hypotheses: [],
    reproductionSteps: [],
    instructionsDelivered: false,
    phase: "hypothesizing",
    fixSummary: null,
    verificationSteps: [],
    lastTurnFailed: false,
  },
  machineSnapshot: null,
  agentBackend: "claude" as const,
  backendRef: null,
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
  objective: null,
  creationMode: "fast",
  tddEnabled: false,
  targetBranch: "main",
  parentSessionName: null,
  graphWorkflowExecution: null,
  graphWorkflowExecutionHistory: [],
  referenceDocuments: [],
};

const BASE_STATE: ManagerState = {
  projects: {
    "test-proj": {
      rootPath: "/home/projects/test-proj",
      sessions: { "test-session": BASE_SESSION },
    },
  },
  archivedProjects: [],
  pinnedProjects: [],
};

function createTestDeps(
  overrides: Partial<DebugLogsIngestDeps> = {},
): DebugLogsIngestDeps {
  return {
    readState: vi.fn().mockResolvedValue(BASE_STATE),
    getSession: vi.fn().mockResolvedValue(BASE_SESSION),
    resolveProjectPath: vi.fn().mockResolvedValue("/home/projects/test-proj"),
    appendDebugLogEntry: vi.fn(),
    getDebugLogStats: vi
      .fn()
      .mockReturnValue({ entryCount: 1, hypothesesSeen: [] }),
    publishDebugLogReceived: vi.fn(),
    ...overrides,
  };
}

function makeRequest(
  search: string,
  body?: unknown,
  init?: { invalidJson?: boolean; headers?: Record<string, string> },
): Request {
  const url = `http://localhost/api/debug-logs${search}`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(init?.headers ?? {}),
  };
  if (init?.invalidJson) {
    return new Request(url, {
      method: "POST",
      headers,
      body: "{not json",
    });
  }
  return new Request(url, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const VALID_ENTRY = {
  timestamp: "2025-01-01T00:00:00.000Z",
  hypothesisId: "H1",
  message: "hello",
};

let deps: DebugLogsIngestDeps;
let handlers: ReturnType<typeof createDebugLogsIngestHandlers>;

beforeEach(() => {
  vi.clearAllMocks();
  deps = createTestDeps();
  handlers = createDebugLogsIngestHandlers(deps);
});

describe("OPTIONS /api/debug-logs", () => {
  it("returns 204 with open CORS headers", () => {
    const response = handlers.OPTIONS();
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toContain(
      "POST",
    );
    expect(response.headers.get("access-control-allow-headers")).toContain(
      "content-type",
    );
  });
});

describe("POST /api/debug-logs", () => {
  it("drops with self_log reason when X-CC-Debug-Log header is present", async () => {
    const response = await handlers.POST(
      makeRequest(
        "?conversationId=conv-1&projectName=test-proj&sessionName=test-session",
        [VALID_ENTRY],
        { headers: { "X-CC-Debug-Log": "1" } },
      ),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      accepted: 0,
      dropped: 1,
      reason: "self_log",
    });
    expect(deps.appendDebugLogEntry).not.toHaveBeenCalled();
    expect(deps.readState).not.toHaveBeenCalled();
    expect(deps.getSession).not.toHaveBeenCalled();
  });

  it("drops with 202 + missing_conversation_id when no id is supplied", async () => {
    const response = await handlers.POST(makeRequest("", [VALID_ENTRY]));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      accepted: 0,
      dropped: 1,
      reason: "missing_conversation_id",
    });
    expect(deps.appendDebugLogEntry).not.toHaveBeenCalled();
  });

  it("uses hint fast path without scanning state", async () => {
    const response = await handlers.POST(
      makeRequest(
        "?conversationId=conv-1&projectName=test-proj&sessionName=test-session",
        [VALID_ENTRY],
      ),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: 1, dropped: 0 });
    expect(deps.resolveProjectPath).toHaveBeenCalledWith("test-proj");
    expect(deps.getSession).toHaveBeenCalledWith(
      "/home/projects/test-proj",
      "test-session",
    );
    expect(deps.readState).not.toHaveBeenCalled();
    expect(deps.appendDebugLogEntry).toHaveBeenCalledWith(
      "/tmp/.debug/conv-1/logs.jsonl",
      expect.objectContaining({ hypothesisId: "H1" }),
    );
    expect(deps.publishDebugLogReceived).toHaveBeenCalledWith({
      projectName: "test-proj",
      sessionName: "test-session",
      conversationId: "conv-1",
      entryCount: 1,
    });
  });

  it("falls back to scanForConversation when hints go stale", async () => {
    deps = createTestDeps({
      resolveProjectPath: vi.fn().mockResolvedValue(null),
    });
    handlers = createDebugLogsIngestHandlers(deps);

    const response = await handlers.POST(
      makeRequest(
        "?conversationId=conv-1&projectName=stale-proj&sessionName=stale",
        [VALID_ENTRY],
      ),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: 1, dropped: 0 });
    expect(deps.readState).toHaveBeenCalled();
    expect(deps.appendDebugLogEntry).toHaveBeenCalled();
  });

  it("drops with unknown_conversation when nothing matches", async () => {
    const response = await handlers.POST(
      makeRequest("?conversationId=missing", [VALID_ENTRY]),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      accepted: 0,
      dropped: 1,
      reason: "unknown_conversation",
    });
  });

  it("drops with debug_mode_inactive when conversation isn't in debug mode", async () => {
    const inactiveSession: SessionState = {
      ...BASE_SESSION,
      conversations: [{ ...BASE_CONVERSATION, debugMode: null }],
    };
    deps = createTestDeps({
      getSession: vi.fn().mockResolvedValue(inactiveSession),
      readState: vi.fn().mockResolvedValue({
        ...BASE_STATE,
        projects: {
          "test-proj": {
            ...BASE_STATE.projects["test-proj"]!,
            sessions: { "test-session": inactiveSession },
          },
        },
      }),
    });
    handlers = createDebugLogsIngestHandlers(deps);

    const response = await handlers.POST(
      makeRequest(
        "?conversationId=conv-1&projectName=test-proj&sessionName=test-session",
        [VALID_ENTRY],
      ),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      accepted: 0,
      dropped: 1,
      reason: "debug_mode_inactive",
    });
    expect(deps.appendDebugLogEntry).not.toHaveBeenCalled();
  });

  it("drops with recording_paused when recording is off", async () => {
    const pausedSession: SessionState = {
      ...BASE_SESSION,
      conversations: [
        {
          ...BASE_CONVERSATION,
          debugMode: { ...BASE_CONVERSATION.debugMode!, recording: false },
        },
      ],
    };
    deps = createTestDeps({
      getSession: vi.fn().mockResolvedValue(pausedSession),
    });
    handlers = createDebugLogsIngestHandlers(deps);

    const response = await handlers.POST(
      makeRequest(
        "?conversationId=conv-1&projectName=test-proj&sessionName=test-session",
        [VALID_ENTRY],
      ),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      accepted: 0,
      dropped: 1,
      reason: "recording_paused",
    });
    expect(deps.appendDebugLogEntry).not.toHaveBeenCalled();
  });

  it("drops with invalid_json when the body cannot be parsed", async () => {
    const response = await handlers.POST(
      makeRequest(
        "?conversationId=conv-1&projectName=test-proj&sessionName=test-session",
        undefined,
        { invalidJson: true },
      ),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      accepted: 0,
      dropped: 1,
      reason: "invalid_json",
    });
  });

  it("accepts a single entry (not wrapped in an array)", async () => {
    const response = await handlers.POST(
      makeRequest(
        "?conversationId=conv-1&projectName=test-proj&sessionName=test-session",
        VALID_ENTRY,
      ),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: 1, dropped: 0 });
    expect(deps.appendDebugLogEntry).toHaveBeenCalledTimes(1);
  });

  it("silently skips entries that fail schema validation but accepts the request", async () => {
    const response = await handlers.POST(
      makeRequest(
        "?conversationId=conv-1&projectName=test-proj&sessionName=test-session",
        [VALID_ENTRY, { not: "valid" }],
      ),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: 1, dropped: 1 });
    expect(deps.appendDebugLogEntry).toHaveBeenCalledTimes(1);
  });

  it("does not publish when no entries were written", async () => {
    const response = await handlers.POST(
      makeRequest(
        "?conversationId=conv-1&projectName=test-proj&sessionName=test-session",
        [{ totally: "invalid" }],
      ),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: 0, dropped: 1 });
    expect(deps.publishDebugLogReceived).not.toHaveBeenCalled();
  });
});
