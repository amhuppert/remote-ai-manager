/**
 * Tests for POST /conversations/[id]/mark-read.
 *
 * Verifies behavioral contract: 404 chains for missing project/session/conv,
 * 200 + unread=false mutation + conversation-unread broadcast on success.
 *
 * No vi.mock on internal modules — deps are injected via the factory.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createMarkReadRouteHandlers,
  type MarkReadRouteDeps,
} from "./mark-read-route-handlers";
import { conversationUnreadEventSchema } from "@/lib/conversations/schemas";
import type { SSEEvent } from "@/lib/api/sse-events";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { SessionState } from "@/lib/sessions/schemas";

function makeConversation(
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return {
    id: "conv-1",
    name: null,
    transcriptPath: null,
    status: "awaiting",
    promptCount: 1,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:01:00Z",
    source: "cc",
    summary: null,
    archived: false,
    unread: true,
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
    ...overrides,
  } as unknown as ConversationState;
}

function makeSession(conversations: ConversationState[] = []): SessionState {
  return {
    name: "s1",
    branch: "csm/s1",
    worktreePath: "/tmp/worktree",
    archived: false,
    pinned: false,
    tddEnabled: false,
    objective: null,
    conversations,
    referenceDocuments: [],
    createdAt: "2026-01-01T00:00:00Z",
  } as unknown as SessionState;
}

function makeDeps(overrides: Partial<MarkReadRouteDeps> = {}): {
  deps: MarkReadRouteDeps;
  mutationResult: { unread: boolean | null };
  broadcastedEvents: SSEEvent[];
} {
  const conversation = makeConversation();
  const session = makeSession([conversation]);
  const mutationResult: { unread: boolean | null } = { unread: null };
  const broadcastedEvents: SSEEvent[] = [];

  const deps: MarkReadRouteDeps = {
    resolveProjectPath: vi.fn(async () => "/repos/demo"),
    getProjectDisplayName: vi.fn(() => "demo"),
    getSession: vi.fn(async () => session),
    mutateConversation: vi.fn(
      async (_projectPath, _sessionName, _conversationId, _label, mutator) => {
        const c = makeConversation();
        await mutator(c);
        mutationResult.unread = c.unread;
      },
    ),
    broadcast: vi.fn((event: SSEEvent) => {
      broadcastedEvents.push(event);
    }),
    ...overrides,
  };
  return { deps, mutationResult, broadcastedEvents };
}

function context(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

function plainRequest(): Request {
  return new Request("http://cc.test/mark-read", { method: "POST" });
}

describe("POST /conversations/[id]/mark-read", () => {
  it("returns 200, sets unread=false, broadcasts conversation-unread event with unread=false", async () => {
    const { deps, mutationResult, broadcastedEvents } = makeDeps();
    const { POST } = createMarkReadRouteHandlers(deps);

    const response = await POST(
      plainRequest(),
      context({ name: "demo", session: "s1", conversationId: "conv-1" }),
    );

    expect(response.status).toBe(200);
    expect(mutationResult.unread).toBe(false);
    expect(broadcastedEvents).toHaveLength(1);
    const parsed = conversationUnreadEventSchema.safeParse(
      broadcastedEvents[0],
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({
        type: "conversation-unread",
        projectName: "demo",
        sessionName: "s1",
        conversationId: "conv-1",
        unread: false,
      });
    }
  });

  it("returns 404 when the project does not resolve", async () => {
    const { deps } = makeDeps({
      resolveProjectPath: vi.fn(async () => null),
    });
    const { POST } = createMarkReadRouteHandlers(deps);

    const response = await POST(
      plainRequest(),
      context({ name: "unknown", session: "s1", conversationId: "conv-1" }),
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 when the session does not exist", async () => {
    const { deps } = makeDeps({
      getSession: vi.fn(async () => null),
    });
    const { POST } = createMarkReadRouteHandlers(deps);

    const response = await POST(
      plainRequest(),
      context({
        name: "demo",
        session: "missing",
        conversationId: "conv-1",
      }),
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 when the conversation does not exist in the session", async () => {
    const { deps, broadcastedEvents } = makeDeps({
      getSession: vi.fn(async () => makeSession([makeConversation()])),
    });
    const { POST } = createMarkReadRouteHandlers(deps);

    const response = await POST(
      plainRequest(),
      context({
        name: "demo",
        session: "s1",
        conversationId: "does-not-exist",
      }),
    );
    expect(response.status).toBe(404);
    expect(broadcastedEvents).toHaveLength(0);
  });
});
