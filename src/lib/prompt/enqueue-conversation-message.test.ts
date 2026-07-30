import { describe, expect, it } from "vitest";

import { conversationStateSchema } from "@/lib/conversations/schemas";
import type { PendingQueuedMessage } from "@/lib/conversations/message-queue-schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";

import {
  enqueueConversationMessage,
  type EnqueueConversationMessageDeps,
} from "./enqueue-conversation-message";

function makeConversation(agentBackend: AgentBackendId) {
  return conversationStateSchema.parse({
    id: "conv-1",
    transcriptPath: null,
    status: "new",
    promptCount: 0,
    createdAt: "2026-06-29T20:05:15.974Z",
    lastActivityAt: "2026-06-29T20:06:07.072Z",
    agentBackend,
  });
}

function makePendingEntry(): PendingQueuedMessage {
  return {
    id: "q-1",
    content: [{ type: "text", text: "author the charter" }],
    status: "pending",
    enqueuedAt: "2026-06-29T20:06:07.072Z",
    updatedAt: "2026-06-29T20:06:07.072Z",
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

interface Recorder {
  calls: string[];
  queuedBackend: AgentBackendId | null;
  queuedDeliveryPolicy: "next_turn" | null;
  ensuredWith: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
  } | null;
}

function makeDeps(
  recorder: Recorder,
  overrides: Partial<EnqueueConversationMessageDeps>,
  deliveryTiming: "in_turn" | "next_turn",
): EnqueueConversationMessageDeps {
  return {
    async getConversation() {
      return null;
    },
    async readConfig() {
      throw new Error("readConfig should not be called in this test");
    },
    async queueMessage(params) {
      recorder.calls.push("queueMessage");
      recorder.queuedBackend = params.backend;
      recorder.queuedDeliveryPolicy = params.deliveryPolicy ?? null;
      return { entry: makePendingEntry(), deliveryTiming };
    },
    async ensureConversationActorAndDrain(
      projectPath,
      sessionName,
      conversationId,
    ) {
      recorder.calls.push("ensureConversationActorAndDrain");
      recorder.ensuredWith = { projectPath, sessionName, conversationId };
    },
    ...overrides,
  };
}

describe("enqueueConversationMessage", () => {
  it.each([
    { backend: "claude" as const, deliveryTiming: "in_turn" as const },
    { backend: "codex" as const, deliveryTiming: "next_turn" as const },
  ])(
    "ensures the conversation actor after enqueuing so the turn drains ($backend)",
    async ({ backend, deliveryTiming }) => {
      const recorder: Recorder = {
        calls: [],
        queuedBackend: null,
        queuedDeliveryPolicy: null,
        ensuredWith: null,
      };
      const deps = makeDeps(
        recorder,
        { getConversation: async () => makeConversation(backend) },
        deliveryTiming,
      );

      await enqueueConversationMessage(
        {
          projectPath: "/proj",
          sessionName: "sess",
          conversationId: "conv-1",
          message: "author the charter",
        },
        deps,
      );

      // The resolved conversation backend flows into the durable enqueue.
      expect(recorder.queuedBackend).toBe(backend);
      // Backend-agnostic: both the in_turn (claude) and next_turn (codex)
      // delivery paths must end with the actor ensured — that is the only thing
      // that starts a turn for /align on an otherwise-idle conversation.
      expect(recorder.ensuredWith).toEqual({
        projectPath: "/proj",
        sessionName: "sess",
        conversationId: "conv-1",
      });
      // Ordering matters: the row must be durably enqueued before the actor's
      // idle-entry drain runs, or the drain finds nothing to deliver.
      expect(recorder.calls).toEqual([
        "queueMessage",
        "ensureConversationActorAndDrain",
      ]);
    },
  );

  it("forwards an explicit next-turn delivery policy", async () => {
    const recorder: Recorder = {
      calls: [],
      queuedBackend: null,
      queuedDeliveryPolicy: null,
      ensuredWith: null,
    };
    const deps = makeDeps(
      recorder,
      { getConversation: async () => makeConversation("claude") },
      "next_turn",
    );

    await enqueueConversationMessage(
      {
        projectPath: "/proj",
        sessionName: "sess",
        conversationId: "conv-1",
        message: "The user approved the decisions.",
        deliveryPolicy: "next_turn",
      },
      deps,
    );

    expect(recorder.queuedDeliveryPolicy).toBe("next_turn");
    expect(recorder.calls).toEqual([
      "queueMessage",
      "ensureConversationActorAndDrain",
    ]);
  });

  it("falls back to the configured default backend when the conversation is absent", async () => {
    const recorder: Recorder = {
      calls: [],
      queuedBackend: null,
      queuedDeliveryPolicy: null,
      ensuredWith: null,
    };
    const deps = makeDeps(
      recorder,
      {
        getConversation: async () => null,
        readConfig: async () =>
          ({ defaultAgentBackend: "codex" }) as Awaited<
            ReturnType<EnqueueConversationMessageDeps["readConfig"]>
          >,
      },
      "next_turn",
    );

    await enqueueConversationMessage(
      {
        projectPath: "/proj",
        sessionName: "sess",
        conversationId: "conv-1",
        message: "author the charter",
      },
      deps,
    );

    expect(recorder.queuedBackend).toBe("codex");
    expect(recorder.ensuredWith).not.toBeNull();
  });
});
