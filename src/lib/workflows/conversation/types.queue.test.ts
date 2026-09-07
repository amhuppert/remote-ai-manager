import { targetFromStoreSessionName } from "@/lib/conversations/conversation-target";
import { describe, expect, it } from "vitest";

import type {
  ConversationEvent,
  ConversationTurnActive,
  ExecutePromptInput,
} from "./types";
import type { QueuedDeliveryMetadata } from "./turn-spec";

/**
 * Type-level proof that queued delivery metadata threads through the
 * conversation turn types end to end. The typed constructions below fail to
 * compile if `queuedDelivery` is missing from any of the three carriers; the
 * runtime assertions guard against the field being silently dropped.
 */
describe("queued delivery metadata on conversation turn types", () => {
  const queuedDelivery: QueuedDeliveryMetadata = {
    messageIds: ["m1", "m2"],
    deliveryAttemptId: "att-1",
  };

  it("carries queuedDelivery on a SUBMIT_PROMPT event", () => {
    const event: Extract<ConversationEvent, { type: "SUBMIT_PROMPT" }> = {
      type: "SUBMIT_PROMPT",
      promptText: "hello",
      streamId: "stream-1",
      queuedDelivery,
    };

    expect(event.queuedDelivery?.messageIds).toEqual(["m1", "m2"]);
    expect(event.queuedDelivery?.deliveryAttemptId).toBe("att-1");
  });

  it("carries queuedDelivery on a ConversationTurnActive context entry", () => {
    const turn: ConversationTurnActive = {
      kind: "conversation_turn",
      promptText: "hello",
      images: [],
      backend: "claude",
      modelSelection: null,
      autonomous: false,
      startedAt: null,
      streamId: "stream-1",
      queuedDelivery,
    };

    expect(turn.queuedDelivery?.messageIds).toEqual(["m1", "m2"]);
    expect(turn.queuedDelivery?.deliveryAttemptId).toBe("att-1");
  });

  it("carries queuedDelivery on an ExecutePromptInput", () => {
    const input: ExecutePromptInput = {
      turn: {
        kind: "conversation_turn",
        backend: "claude",
        promptText: "hello",
        images: [],
        modelSelection: null,
        autonomous: false,
        queuedDelivery,
      },
      persistence: "durable",
      projectPath: "/p",
      target: targetFromStoreSessionName("p", "s", "c1"),

      worktreePath: "/w",

      transcriptPath: "/t.jsonl",
      agentBackend: "claude",
      backendRef: null,
      promptCount: 0,
      forkedFrom: null,
      role: null,
      streamId: "stream-1",
      onModelSelectionResolved: async () => {},
      debugMode: null,
    };

    expect(input.turn.queuedDelivery?.messageIds).toEqual(["m1", "m2"]);
    expect(input.turn.queuedDelivery?.deliveryAttemptId).toBe("att-1");
  });

  it("leaves queuedDelivery optional on every carrier", () => {
    const event: Extract<ConversationEvent, { type: "SUBMIT_PROMPT" }> = {
      type: "SUBMIT_PROMPT",
      promptText: "hello",
      streamId: "stream-1",
    };
    const turn: ConversationTurnActive = {
      kind: "conversation_turn",
      promptText: "hello",
      images: [],
      backend: "claude",
      modelSelection: null,
      autonomous: false,
      startedAt: null,
      streamId: "stream-1",
    };
    const input: ExecutePromptInput = {
      turn: {
        kind: "conversation_turn",
        backend: "claude",
        promptText: "hello",
        images: [],
        modelSelection: null,
        autonomous: false,
      },
      persistence: "durable",
      projectPath: "/p",
      target: targetFromStoreSessionName("p", "s", "c1"),

      worktreePath: "/w",

      transcriptPath: "/t.jsonl",
      agentBackend: "claude",
      backendRef: null,
      promptCount: 0,
      forkedFrom: null,
      role: null,
      streamId: "stream-1",
      onModelSelectionResolved: async () => {},
      debugMode: null,
    };

    expect(event.queuedDelivery).toBeUndefined();
    expect(turn.queuedDelivery).toBeUndefined();
    expect(input.turn.queuedDelivery).toBeUndefined();
  });
});
