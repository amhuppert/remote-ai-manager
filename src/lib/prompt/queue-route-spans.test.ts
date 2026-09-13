import { describe, it, expect, vi, beforeEach } from "vitest";

// Infrastructure-only mock: capture the module logger so interior timed() spans
// are observable. `timed` itself is imported from @/lib/logging/timed (the
// submodule) inside the handler, so it stays real and runs against this spy.
// withTracing passes through so tests exercise the raw POST.
const logSpies = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("@/lib/logging", () => ({
  createLogger: () => logSpies,
  withTracing: <T>(handler: T) => handler,
}));

import type { NextRequest } from "next/server";
import {
  createQueueRouteHandlers,
  type QueueRouteDeps,
} from "./queue-route-handlers";
import type { PendingQueuedMessage } from "@/lib/conversations/message-queue-schemas";

/** Any event whose `<base>.complete` landed on any logger level. */
function spanCompleteFired(base: string): boolean {
  const event = `${base}.complete`;
  return [logSpies.debug, logSpies.info, logSpies.warn].some((spy) =>
    spy.mock.calls.some(([name]) => name === event),
  );
}

function makePendingEntry(): PendingQueuedMessage {
  return {
    id: "q-1",
    content: [{ type: "text", text: "follow up" }],
    status: "pending",
    enqueuedAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
    deliveryStartedAt: null,
    deliveredAt: null,
    cancelledAt: null,
    failedAt: null,
    deliveryAttemptId: null,
    attemptCount: 0,
    error: null,
    metadata: null,
  };
}

function createTestDeps(
  overrides: Partial<QueueRouteDeps> = {},
): QueueRouteDeps {
  const entry = makePendingEntry();
  return {
    admitCheckpointForkSelection: async ({ modelSelection }) =>
      modelSelection ?? { modelId: "claude-opus-5", parameters: {} },
    checkpointAcceptsQueuedInput: () => false,
    admitModelSelection: vi.fn(async ({ modelSelection }) => ({
      ok: true as const,
      modelSelection,
    })),
    resolveProjectPath: vi.fn().mockResolvedValue("/projects/my-project"),
    getSession: vi.fn().mockResolvedValue({
      sessionName: "test-session",
      conversations: [],
    }),
    getConversation: vi.fn().mockResolvedValue({
      id: "conv-123",
      status: "running",
      role: null,
      agentBackend: "claude",
    }),
    getProjectDisplayName: vi.fn((p: string) => p.split("/").pop() ?? p),
    queueMessage: vi
      .fn()
      .mockResolvedValue({ entry, deliveryTiming: "in_turn" as const }),
    queueCapabilityForBackend: vi.fn().mockReturnValue({
      acceptsWhileRunning: true,
      deliveryTiming: "in_turn",
    }),
    toQueuedMessageView: vi.fn(() => ({ id: entry.id })),
    clearConversationPendingPromptTextIfMatches: vi
      .fn()
      .mockResolvedValue(true),
    resolveDelivery: async () => "not_found",
    ensureConversationActorAndDrain: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue("cancelled"),
    ...overrides,
  } as QueueRouteDeps;
}

function makeRequest(body: unknown): NextRequest {
  return new Request(
    "http://localhost/api/projects/my-project/sessions/test-session/conversations/conv-123/queue",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  ) as unknown as NextRequest;
}

function makeParams() {
  return {
    params: Promise.resolve({
      name: "my-project",
      session: "test-session",
      conversationId: "conv-123",
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("queue POST interior timed() spans", () => {
  it("times the state read, the enqueue, and the post-enqueue drain", async () => {
    const handlers = createQueueRouteHandlers(createTestDeps());

    const response = await handlers.POST(
      makeRequest({ text: "follow up" }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    expect(spanCompleteFired("queue.post.load_conversation")).toBe(true);
    expect(spanCompleteFired("queue.post.enqueue")).toBe(true);
    expect(spanCompleteFired("queue.post.drain")).toBe(true);
  });

  it("does not emit the enqueue/drain spans when the conversation is not running", async () => {
    const handlers = createQueueRouteHandlers(
      createTestDeps({
        getConversation: vi.fn().mockResolvedValue({
          id: "conv-123",
          status: "awaiting",
          role: null,
          agentBackend: "claude",
        }),
      }),
    );

    const response = await handlers.POST(
      makeRequest({ text: "follow up" }),
      makeParams(),
    );

    expect(response.status).toBe(409);
    // The conversation read still runs and is timed…
    expect(spanCompleteFired("queue.post.load_conversation")).toBe(true);
    // …but the enqueue and drain phases are skipped, so no span for them.
    expect(spanCompleteFired("queue.post.enqueue")).toBe(false);
    expect(spanCompleteFired("queue.post.drain")).toBe(false);
  });
});
