import { describe, it, expect } from "vitest";
import {
  createProjectQueueRouteHandlers,
  type ProjectQueueRouteDeps,
} from "./queue-route-handlers";
import {
  createProjectConversationRouteHandlers,
  type ProjectConversationRouteDeps,
} from "./route-handlers";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import type { ConversationState } from "@/lib/conversations/schemas";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import type { PendingQueuedMessage } from "@/lib/conversations/message-queue-schemas";
import type {
  QueueCancellationResponse,
  QueueEnqueueResponse,
} from "@/lib/prompt/schemas";

/**
 * The project adapter of the queue routes (R6.1, R6.2, R6.4).
 *
 * The durable queue column and the sentinel-aware drain already exist; what a
 * project conversation had no way to reach was a ROUTE. These drive the project
 * handlers directly so the guards, the enqueue, and the cancellation are proved
 * at the boundary a client actually calls — including that a project conversation
 * is addressed by project + conversation with no session segment anywhere.
 */

const ts = "2026-01-01T00:00:00.000Z";

function makeConv(
  overrides: Partial<ConversationState> & { id: string },
): ConversationState {
  return makeConversationState({
    scope: "project",
    name: "Repo chat",
    transcriptPath: null,
    status: "running",
    promptCount: 1,
    createdAt: ts,
    lastActivityAt: ts,
    open: true,
    ...overrides,
  });
}

function ctx(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

function postRequest(body: unknown): Request {
  return new Request("http://test/", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function deleteRequest(): Request {
  return new Request("http://test/", { method: "DELETE" });
}

function pendingEntry(id: string, text: string): PendingQueuedMessage {
  return {
    id,
    content: [{ type: "text", text }],
    status: "pending",
    enqueuedAt: ts,
    updatedAt: ts,
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

interface Harness {
  handlers: ReturnType<typeof createProjectQueueRouteHandlers>;
  store: Map<string, ConversationState>;
  /** Store keys every queue write was addressed with, in call order. */
  writes: Array<{
    op: string;
    sessionName: string;
    conversationId: string;
  }>;
  drains: string[];
}

function harness(overrides: Partial<ProjectQueueRouteDeps> = {}): Harness {
  const store = new Map<string, ConversationState>();
  const writes: Harness["writes"] = [];
  const drains: string[] = [];
  let nextId = 0;

  const deps: ProjectQueueRouteDeps = {
    admitModelSelection: async ({ modelSelection }) => ({
      ok: true,
      modelSelection,
    }),
    resolveProjectPath: async (name) => (name === "demo" ? "/repo" : null),
    getProjectDisplayName: () => "demo",
    getProjectConversation: async (_projectPath, id) => store.get(id) ?? null,
    queueMessage: async (input) => {
      writes.push({
        op: "enqueue",
        sessionName: input.sessionName,
        conversationId: input.conversationId,
      });
      nextId += 1;
      const entry = pendingEntry(`q-${nextId}`, input.text ?? "");
      const conversation = store.get(input.conversationId);
      if (conversation) {
        conversation.pendingQueue = [...conversation.pendingQueue, entry];
      }
      return { entry, deliveryTiming: "next_turn" };
    },
    queueCapabilityForBackend: () => ({
      acceptsWhileRunning: true,
      deliveryTiming: "next_turn",
    }),
    toQueuedMessageView: (entry) => ({
      id: entry.id,
      content: entry.content,
      status: entry.status,
      enqueuedAt: entry.enqueuedAt,
      updatedAt: entry.updatedAt,
      deliveredAt: entry.deliveredAt,
      cancelledAt: entry.cancelledAt,
      failedAt: entry.failedAt,
      error: entry.error,
      metadata: entry.metadata,
    }),
    clearConversationPendingPromptTextIfMatches: async () => true,
    resolveDelivery: async () => "not_found",
    ensureConversationActorAndDrain: async (
      _projectPath,
      _sessionName,
      conversationId,
    ) => {
      drains.push(conversationId);
    },
    cancel: async (input) => {
      writes.push({
        op: "cancel",
        sessionName: input.sessionName,
        conversationId: input.conversationId,
      });
      const conversation = store.get(input.conversationId);
      const entry = conversation?.pendingQueue.find((e) => e.id === input.id);
      if (!conversation || !entry) return "not_found";
      if (entry.status !== "pending") return "not_cancellable";
      conversation.pendingQueue = conversation.pendingQueue.filter(
        (e) => e.id !== input.id,
      );
      return "cancelled";
    },
    ...overrides,
  };

  return {
    handlers: createProjectQueueRouteHandlers(deps),
    store,
    writes,
    drains,
  };
}

/**
 * The project prompt/lifecycle deps, over the same conversation store the queue
 * harness uses — so one test can address both routes and see them agree about
 * which conversation is busy.
 */
function projectRouteDeps(
  store: Map<string, ConversationState>,
): ProjectConversationRouteDeps {
  return {
    resolveProjectPath: async (name) => (name === "demo" ? "/repo" : null),
    getProjectDisplayName: () => "demo",
    createProjectConversation: async () => {
      throw new Error("not used");
    },
    getProjectConversation: async (_projectPath, id) => store.get(id) ?? null,
    listProjectConversations: async () => [...store.values()],
    readConversationMessagesWithSeq: async () => [],
    renameProjectConversation: async () => {},
    resolveConversationNamingContent: async () => null,
    resolveMessageNamingContent: async () => null,
    generateAndApplyConversationName: async () => null,
    setProjectConversationArchived: async () => {},
    setProjectConversationOpen: async () => {},
    markProjectConversationRead: async () => {},
    executeProjectPromptStream: async (input) => {
      input.emit("status", { status: "running" });
      return {
        conversationId: input.conversationId ?? "new-1",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    },
    isConversationBusy: () => false,
    changeConversationProfile: async () => {
      throw new Error("not used");
    },
    broadcast: () => ({ delivered: true }),
  };
}

describe("project conversation queue routes", () => {
  describe("enqueue (R6.1)", () => {
    it("queues a follow-up into a running project conversation and returns the pending view", async () => {
      const h = harness();
      h.store.set("c1", makeConv({ id: "c1", status: "running" }));

      const res = await h.handlers.POST(
        postRequest({ text: "and also update the README" }),
        ctx({ name: "demo", conversationId: "c1" }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as QueueEnqueueResponse;
      expect(body.queued).toBe(true);
      expect(body.message.status).toBe("pending");
      expect(body.message.content).toEqual([
        { type: "text", text: "and also update the README" },
      ]);
      expect(body.deliveryTiming).toBe("next_turn");
    });

    it("addresses the project conversation repository through the store key", async () => {
      const h = harness();
      h.store.set("c1", makeConv({ id: "c1", status: "running" }));

      await h.handlers.POST(
        postRequest({ text: "follow-up" }),
        ctx({ name: "demo", conversationId: "c1" }),
      );

      expect(h.writes).toEqual([
        {
          op: "enqueue",
          sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
          conversationId: "c1",
        },
      ]);
    });

    it("never emits the internal sentinel in the response payload", async () => {
      const h = harness();
      h.store.set("c1", makeConv({ id: "c1", status: "running" }));

      const res = await h.handlers.POST(
        postRequest({ text: "follow-up" }),
        ctx({ name: "demo", conversationId: "c1" }),
      );

      expect(await res.text()).not.toContain(
        PROJECT_CONVERSATION_SESSION_SENTINEL,
      );
    });

    it("rejects an empty submission with the typed EMPTY_MESSAGE error", async () => {
      const h = harness();
      h.store.set("c1", makeConv({ id: "c1", status: "running" }));

      const res = await h.handlers.POST(
        postRequest({ text: "   " }),
        ctx({ name: "demo", conversationId: "c1" }),
      );

      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe(
        "EMPTY_MESSAGE",
      );
    });

    it("refuses to queue into a conversation that is not running", async () => {
      const h = harness();
      h.store.set("c1", makeConv({ id: "c1", status: "awaiting" }));

      const res = await h.handlers.POST(
        postRequest({ text: "follow-up" }),
        ctx({ name: "demo", conversationId: "c1" }),
      );

      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe("NOT_RUNNING");
      expect(h.writes).toEqual([]);
    });

    it("refuses a backend that cannot accept a message while running", async () => {
      const h = harness({
        queueCapabilityForBackend: () => ({
          acceptsWhileRunning: false,
          deliveryTiming: "next_turn",
        }),
      });
      h.store.set("c1", makeConv({ id: "c1", status: "running" }));

      const res = await h.handlers.POST(
        postRequest({ text: "follow-up" }),
        ctx({ name: "demo", conversationId: "c1" }),
      );

      expect(res.status).toBe(422);
      expect(((await res.json()) as { code: string }).code).toBe(
        "UNSUPPORTED_BACKEND",
      );
    });

    it("404s an unknown project and an unknown conversation", async () => {
      const h = harness();
      h.store.set("c1", makeConv({ id: "c1", status: "running" }));

      expect(
        (
          await h.handlers.POST(
            postRequest({ text: "x" }),
            ctx({ name: "nope", conversationId: "c1" }),
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await h.handlers.POST(
            postRequest({ text: "x" }),
            ctx({ name: "demo", conversationId: "missing" }),
          )
        ).status,
      ).toBe(404);
    });

    it("closes the enqueue/turn-end race by draining after the commit", async () => {
      const h = harness();
      h.store.set("c1", makeConv({ id: "c1", status: "running" }));

      await h.handlers.POST(
        postRequest({ text: "follow-up" }),
        ctx({ name: "demo", conversationId: "c1" }),
      );

      expect(h.drains).toEqual(["c1"]);
    });
  });

  describe("cancellation (R6.2)", () => {
    it("cancels a queued project message before delivery", async () => {
      const h = harness();
      const conversation = makeConv({ id: "c1", status: "running" });
      conversation.pendingQueue = [pendingEntry("q-1", "follow-up")];
      h.store.set("c1", conversation);

      const res = await h.handlers.DELETE(
        deleteRequest(),
        ctx({ name: "demo", conversationId: "c1", messageId: "q-1" }),
      );

      expect(res.status).toBe(200);
      expect((await res.json()) as QueueCancellationResponse).toEqual({
        cancelled: true,
        id: "q-1",
      });
      expect(h.store.get("c1")?.pendingQueue).toEqual([]);
    });

    it("404s a queued message that is not in the queue", async () => {
      const h = harness();
      h.store.set("c1", makeConv({ id: "c1", status: "running" }));

      const res = await h.handlers.DELETE(
        deleteRequest(),
        ctx({ name: "demo", conversationId: "c1", messageId: "ghost" }),
      );

      expect(res.status).toBe(404);
    });

    it("409s a message whose delivery was already claimed", async () => {
      const h = harness();
      const conversation = makeConv({ id: "c1", status: "running" });
      conversation.pendingQueue = [
        { ...pendingEntry("q-1", "follow-up"), status: "delivering" },
      ];
      h.store.set("c1", conversation);

      const res = await h.handlers.DELETE(
        deleteRequest(),
        ctx({ name: "demo", conversationId: "c1", messageId: "q-1" }),
      );

      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe(
        "NOT_CANCELLABLE",
      );
    });
  });

  describe("per-conversation serialization only (R6.4)", () => {
    it("leaves a sibling free to START A TURN while another conversation queues", async () => {
      const h = harness();
      h.store.set("busy", makeConv({ id: "busy", status: "running" }));
      h.store.set("idle", makeConv({ id: "idle", status: "awaiting" }));

      // The prompt route's own busy check, keyed by conversation exactly as
      // production keys it. If queueing serialized project-wide, the sibling's
      // turn would be refused here instead of streaming.
      const promptHandlers = createProjectConversationRouteHandlers({
        ...projectRouteDeps(h.store),
        isConversationBusy: (_projectPath, _sessionName, conversationId) =>
          h.store.get(conversationId)?.status === "running",
      });

      const queued = await h.handlers.POST(
        postRequest({ text: "follow-up for busy" }),
        ctx({ name: "demo", conversationId: "busy" }),
      );
      expect(queued.status).toBe(200);

      const siblingTurn = await promptHandlers.promptPOST(
        postRequest({ prompt: "start a turn here" }),
        ctx({ name: "demo", conversationId: "idle" }),
      );
      expect(siblingTurn.status).toBe(200);
      expect(siblingTurn.headers.get("Content-Type")).toBe("text/event-stream");

      // And the conversation that IS running still refuses a direct turn, which
      // is what makes queueing the right route for it.
      const busyTurn = await promptHandlers.promptPOST(
        postRequest({ prompt: "no direct turn while running" }),
        ctx({ name: "demo", conversationId: "busy" }),
      );
      expect(busyTurn.status).toBe(409);
    });

    it("queues into the running conversation without touching a sibling that is idle", async () => {
      const h = harness();
      h.store.set("busy", makeConv({ id: "busy", status: "running" }));
      h.store.set("idle", makeConv({ id: "idle", status: "awaiting" }));

      const queued = await h.handlers.POST(
        postRequest({ text: "follow-up for busy" }),
        ctx({ name: "demo", conversationId: "busy" }),
      );

      expect(queued.status).toBe(200);
      // The idle sibling gained no queue row and was never addressed: its next
      // submission is a turn, not a queued follow-up.
      expect(h.store.get("idle")?.pendingQueue).toEqual([]);
      expect(h.writes.map((w) => w.conversationId)).toEqual(["busy"]);
      expect(h.drains).toEqual(["busy"]);
    });

    it("queues concurrently into two running project conversations, each into its own queue", async () => {
      const h = harness();
      h.store.set("a", makeConv({ id: "a", status: "running" }));
      h.store.set("b", makeConv({ id: "b", status: "running" }));

      const [resA, resB] = await Promise.all([
        h.handlers.POST(
          postRequest({ text: "for a" }),
          ctx({ name: "demo", conversationId: "a" }),
        ),
        h.handlers.POST(
          postRequest({ text: "for b" }),
          ctx({ name: "demo", conversationId: "b" }),
        ),
      ]);

      expect([resA.status, resB.status]).toEqual([200, 200]);
      expect(h.store.get("a")?.pendingQueue.map((e) => e.content)).toEqual([
        [{ type: "text", text: "for a" }],
      ]);
      expect(h.store.get("b")?.pendingQueue.map((e) => e.content)).toEqual([
        [{ type: "text", text: "for b" }],
      ]);
    });
  });
});
