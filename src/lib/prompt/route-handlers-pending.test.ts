import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import {
  createPendingPromptRouteHandlers,
  type PendingPromptRouteDeps,
} from "./route-handlers";
import type { ConversationState } from "@/lib/conversations/schemas";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import type { SessionState } from "@/lib/sessions/schemas";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
// ---------------------------------------------------------------------------
// Mock deps (no vi.mock needed)
// ---------------------------------------------------------------------------

function makeConvo(
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return makeConversationState({
    id: "convo-1",
    transcriptPath: null,
    status: "new",
    promptCount: 0,
    createdAt: "2024-01-01T00:00:00Z",
    lastActivityAt: "2024-01-01T00:00:00Z",
    ...overrides,
  });
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
    creationMode: "normal",
    tddEnabled: true,
    targetBranch: "main",
    parentSessionName: null,
    graphWorkflowExecution: null,
    referenceDocuments: [],
  };
}

function createTestDeps(
  overrides: Partial<PendingPromptRouteDeps> = {},
): PendingPromptRouteDeps {
  return {
    resolveProjectPath: vi.fn().mockResolvedValue("/home/projects/test-proj"),
    getSession: vi
      .fn()
      .mockResolvedValue(makeSession([makeConvo({ id: "convo-1" })])),
    setConversationPendingPromptText: vi.fn().mockResolvedValue(undefined),
    clearConversationPendingPromptTextIfMatches: vi
      .fn()
      .mockResolvedValue(true),
    log: createCapturingLogger(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(body: unknown): NextRequest {
  return new Request(
    "http://localhost/api/projects/test-proj/sessions/test/conversations/convo-1/pending-prompt",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  ) as unknown as NextRequest;
}

function makeParams(
  name = "test-proj",
  session = "test",
  conversationId = "convo-1",
) {
  return { params: Promise.resolve({ name, session, conversationId }) };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let deps: PendingPromptRouteDeps;
let handlers: ReturnType<typeof createPendingPromptRouteHandlers>;

beforeEach(() => {
  vi.clearAllMocks();
  deps = createTestDeps();
  handlers = createPendingPromptRouteHandlers(deps);
});

// ===========================================================================
// API route tests
// ===========================================================================

describe("POST /api/projects/[name]/sessions/[session]/conversations/[conversationId]/pending-prompt", () => {
  it("persists a string value via setConversationPendingPromptText", async () => {
    const response = await handlers.POST(
      makeRequest({ text: "hello world" }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    expect(deps.setConversationPendingPromptText).toHaveBeenCalledWith(
      "/home/projects/test-proj",
      "test",
      "convo-1",
      "hello world",
    );
  });

  it("clears the pending prompt when text is null", async () => {
    const response = await handlers.POST(
      makeRequest({ text: null }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    expect(deps.setConversationPendingPromptText).toHaveBeenCalledWith(
      "/home/projects/test-proj",
      "test",
      "convo-1",
      null,
    );
  });

  it("clears only the pending prompt that matches the submitted draft", async () => {
    const response = await handlers.POST(
      makeRequest({ text: null, expectedText: "submitted draft" }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    expect(
      deps.clearConversationPendingPromptTextIfMatches,
    ).toHaveBeenCalledWith(
      "/home/projects/test-proj",
      "test",
      "convo-1",
      "submitted draft",
    );
    expect(deps.setConversationPendingPromptText).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ ok: true, updated: true });
  });

  it("accepts an empty string and persists it as-is", async () => {
    const response = await handlers.POST(
      makeRequest({ text: "" }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    expect(deps.setConversationPendingPromptText).toHaveBeenCalledWith(
      "/home/projects/test-proj",
      "test",
      "convo-1",
      "",
    );
  });

  it("returns 400 when text field is missing", async () => {
    const response = await handlers.POST(makeRequest({}), makeParams());

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("text");
    expect(deps.setConversationPendingPromptText).not.toHaveBeenCalled();
  });

  it("returns 400 when text field is a non-string non-null value", async () => {
    const response = await handlers.POST(
      makeRequest({ text: 42 }),
      makeParams(),
    );

    expect(response.status).toBe(400);
    expect(deps.setConversationPendingPromptText).not.toHaveBeenCalled();
  });

  it("returns 404 when project is unknown", async () => {
    deps = createTestDeps({
      resolveProjectPath: vi.fn().mockResolvedValue(null),
    });
    handlers = createPendingPromptRouteHandlers(deps);

    const response = await handlers.POST(
      makeRequest({ text: "hi" }),
      makeParams("nonexistent"),
    );

    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("Project not found");
  });

  it("returns 404 when session is unknown", async () => {
    deps = createTestDeps({
      getSession: vi.fn().mockResolvedValue(null),
    });
    handlers = createPendingPromptRouteHandlers(deps);

    const response = await handlers.POST(
      makeRequest({ text: "hi" }),
      makeParams("test-proj", "missing"),
    );

    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("Session not found");
  });

  it("returns 404 when conversation is unknown", async () => {
    const response = await handlers.POST(
      makeRequest({ text: "hi" }),
      makeParams("test-proj", "test", "missing-id"),
    );

    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("Conversation not found");
  });

  it("URL-decodes the session slug before lookup", async () => {
    await handlers.POST(makeRequest({ text: "hi" }), {
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

  it("returns 500 when persistence fails", async () => {
    deps = createTestDeps({
      setConversationPendingPromptText: vi
        .fn()
        .mockRejectedValue(new Error("disk full")),
    });
    handlers = createPendingPromptRouteHandlers(deps);

    const response = await handlers.POST(
      makeRequest({ text: "hi" }),
      makeParams(),
    );

    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe("disk full");
  });
});
