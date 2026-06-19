import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { NextRequest } from "next/server";
import {
  createMessagesRouteHandlers,
  parseSinceParam,
  type MessagesRouteDeps,
} from "./messages-route-handlers";
import { transcriptMessageSchema } from "@/lib/conversations/schemas";
import type {
  ConversationState,
  TranscriptMessage,
} from "@/lib/conversations/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
function makeConvo(
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return {
    id: "convo-1",
    scope: "session",
    name: null,
    transcriptPath: "/tmp/convo-1.jsonl",
    status: "new",
    promptCount: 0,
    createdAt: "2024-01-01T00:00:00Z",
    lastActivityAt: "2024-01-01T00:00:00Z",
    source: "cc",
    summary: null,
    archived: false,
    totalCostUsd: null,
    totalDurationMs: null,
    totalTurns: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    pendingPromptText: null,
    forkedFrom: null,
    role: null,
    activeTurnSource: null,
    contextTokens: null,
    contextWindowMax: null,
    debugMode: null,
    machineSnapshot: null,
    agentBackend: "claude",
    backendRef: null,
    unread: false,
    pendingQueue: [],
    ...overrides,
  };
}

function makeSession(conversations: ConversationState[]): SessionState {
  return {
    sessionName: "test",
    worktreePath: "/proj/.worktrees/test",
    branchName: "csm/test",
    createdAt: "2024-01-01T00:00:00Z",
    lastActivityAt: "2024-01-01T00:00:00Z",
    archived: false,
    finished: false,
    conversations,
    source: "cc",
    objective: null,
    creationMode: "fast",
    tddEnabled: true,
    targetBranch: "main",
    parentSessionName: null,
    graphWorkflowExecution: null,
    referenceDocuments: [],
  };
}

function makeMsg(
  role: "user" | "assistant",
  seq: number,
  text: string,
): TranscriptMessage & { seq: number } {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp: null,
    seq,
  };
}

function createTestDeps(
  overrides: Partial<MessagesRouteDeps> = {},
): MessagesRouteDeps {
  const convo = makeConvo({ id: "convo-1" });
  return {
    resolveProjectPath: vi.fn().mockResolvedValue("/home/projects/test-proj"),
    getSession: vi.fn().mockResolvedValue(makeSession([convo])),
    getConversation: vi.fn().mockResolvedValue(convo),
    readConversationMessagesWithSeq: vi
      .fn()
      .mockResolvedValue([
        makeMsg("user", 0, "hi"),
        makeMsg("assistant", 1, "hello"),
        makeMsg("user", 2, "more"),
        makeMsg("assistant", 3, "ok"),
      ]),
    ...overrides,
  };
}

function makeRequest(query = ""): NextRequest {
  return new Request(
    `http://localhost/api/projects/test-proj/sessions/test/conversations/convo-1/messages${query}`,
  ) as unknown as NextRequest;
}

function makeParams(
  name = "test-proj",
  session = "test",
  conversationId = "convo-1",
) {
  return { params: Promise.resolve({ name, session, conversationId }) };
}

let deps: MessagesRouteDeps;
let handlers: ReturnType<typeof createMessagesRouteHandlers>;

beforeEach(() => {
  vi.clearAllMocks();
  deps = createTestDeps();
  handlers = createMessagesRouteHandlers(deps);
});

// ===========================================================================
// parseSinceParam
// ===========================================================================

describe("parseSinceParam", () => {
  it.each([
    ["http://x/?since=0", 0],
    ["http://x/?since=5", 5],
    ["http://x/?since=42", 42],
  ])("returns the integer for valid non-negative input %s", (url, expected) => {
    expect(parseSinceParam(url)).toBe(expected);
  });

  it.each([
    "http://x/",
    "http://x/?since=",
    "http://x/?since=-1",
    "http://x/?since=foo",
    "http://x/?since=1.5",
    "http://x/?since=NaN",
  ])("returns null for invalid or missing input %s", (url) => {
    expect(parseSinceParam(url)).toBeNull();
  });
});

// ===========================================================================
// GET handler
// ===========================================================================

describe("GET /api/projects/[name]/sessions/[session]/conversations/[conversationId]/messages", () => {
  it("returns seq-stamped array in order when ?since is omitted", async () => {
    const response = await handlers.GET(makeRequest(), makeParams());
    expect(response.status).toBe(200);
    const body = (await response.json()) as Array<{ seq: number }>;
    expect(body.map((m) => m.seq)).toEqual([0, 1, 2, 3]);
  });

  it("returns all messages with seq > 0 when ?since=0", async () => {
    const response = await handlers.GET(makeRequest("?since=0"), makeParams());
    expect(response.status).toBe(200);
    const body = (await response.json()) as Array<{ seq: number }>;
    expect(body.map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it("returns only newer entries when ?since=N is in the middle of the transcript", async () => {
    const response = await handlers.GET(makeRequest("?since=1"), makeParams());
    expect(response.status).toBe(200);
    const body = (await response.json()) as Array<{ seq: number }>;
    expect(body.map((m) => m.seq)).toEqual([2, 3]);
  });

  it("returns the full transcript when ?since is negative", async () => {
    const response = await handlers.GET(makeRequest("?since=-1"), makeParams());
    expect(response.status).toBe(200);
    const body = (await response.json()) as Array<{ seq: number }>;
    expect(body.map((m) => m.seq)).toEqual([0, 1, 2, 3]);
  });

  it("returns the full transcript when ?since is a non-integer string", async () => {
    const response = await handlers.GET(
      makeRequest("?since=foo"),
      makeParams(),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Array<{ seq: number }>;
    expect(body.map((m) => m.seq)).toEqual([0, 1, 2, 3]);
  });

  it("returns the full transcript when ?since is empty", async () => {
    const response = await handlers.GET(makeRequest("?since="), makeParams());
    expect(response.status).toBe(200);
    const body = (await response.json()) as Array<{ seq: number }>;
    expect(body.map((m) => m.seq)).toEqual([0, 1, 2, 3]);
  });

  it("returns [] for an empty conversation", async () => {
    deps = createTestDeps({
      readConversationMessagesWithSeq: vi.fn().mockResolvedValue([]),
    });
    handlers = createMessagesRouteHandlers(deps);

    const response = await handlers.GET(makeRequest(), makeParams());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it("returns an array that parses against the updated transcriptMessageSchema", async () => {
    const response = await handlers.GET(makeRequest(), makeParams());
    const body = await response.json();
    const parsed = z.array(transcriptMessageSchema).safeParse(body);
    expect(parsed.success).toBe(true);
  });

  it("sorts returned messages ascending by seq even when the underlying read returns them out of order", async () => {
    deps = createTestDeps({
      readConversationMessagesWithSeq: vi
        .fn()
        .mockResolvedValue([
          makeMsg("assistant", 3, "d"),
          makeMsg("user", 0, "a"),
          makeMsg("assistant", 1, "b"),
          makeMsg("user", 2, "c"),
        ]),
    });
    handlers = createMessagesRouteHandlers(deps);

    const response = await handlers.GET(makeRequest(), makeParams());
    const body = (await response.json()) as Array<{ seq: number }>;
    expect(body.map((m) => m.seq)).toEqual([0, 1, 2, 3]);
  });

  it("returns 404 when project is unknown", async () => {
    deps = createTestDeps({
      resolveProjectPath: vi.fn().mockResolvedValue(null),
    });
    handlers = createMessagesRouteHandlers(deps);

    const response = await handlers.GET(makeRequest(), makeParams("nope"));
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("Project not found");
  });

  it("returns 404 when session is unknown", async () => {
    deps = createTestDeps({
      getSession: vi.fn().mockResolvedValue(null),
    });
    handlers = createMessagesRouteHandlers(deps);

    const response = await handlers.GET(
      makeRequest(),
      makeParams("test-proj", "missing"),
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("Session not found");
  });

  it("returns 404 when conversation is unknown", async () => {
    deps = createTestDeps({
      getConversation: vi.fn().mockResolvedValue(null),
    });
    handlers = createMessagesRouteHandlers(deps);

    const response = await handlers.GET(
      makeRequest(),
      makeParams("test-proj", "test", "missing-id"),
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("Conversation not found");
  });

  it("returns 500 when reading the transcript fails", async () => {
    deps = createTestDeps({
      readConversationMessagesWithSeq: vi
        .fn()
        .mockRejectedValue(new Error("disk read failed")),
    });
    handlers = createMessagesRouteHandlers(deps);

    const response = await handlers.GET(makeRequest(), makeParams());
    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe("disk read failed");
  });

  it("URL-decodes the session slug before lookup", async () => {
    await handlers.GET(makeRequest(), {
      params: Promise.resolve({
        name: "test-proj",
        session: "session%20with%20space",
        conversationId: "convo-1",
      }),
    });
    expect(deps.getSession).toHaveBeenCalledWith(
      "/home/projects/test-proj",
      "session with space",
    );
  });
});
