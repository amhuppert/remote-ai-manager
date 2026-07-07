import { describe, expect, it } from "vitest";

import type {
  ConversationEvent,
  ConversationTurnActive,
  ExecutePromptInput,
  QueuedDeliveryMetadata,
} from "./types";

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
      modelId: null,
      effort: null,
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
      projectPath: "/p",
      projectName: "p",
      sessionName: "s",
      worktreePath: "/w",
      conversationId: "c1",
      transcriptPath: "/t.jsonl",
      agentBackend: "claude",
      backendRef: null,
      promptCount: 0,
      forkedFrom: null,
      role: null,
      promptText: "hello",
      images: [],
      streamId: "stream-1",
      modelId: null,
      effort: null,
      autonomous: false,
      debugMode: null,
      queuedDelivery,
    };

    expect(input.queuedDelivery?.messageIds).toEqual(["m1", "m2"]);
    expect(input.queuedDelivery?.deliveryAttemptId).toBe("att-1");
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
      modelId: null,
      effort: null,
      autonomous: false,
      startedAt: null,
      streamId: "stream-1",
    };
    const input: ExecutePromptInput = {
      projectPath: "/p",
      projectName: "p",
      sessionName: "s",
      worktreePath: "/w",
      conversationId: "c1",
      transcriptPath: "/t.jsonl",
      agentBackend: "claude",
      backendRef: null,
      promptCount: 0,
      forkedFrom: null,
      role: null,
      promptText: "hello",
      images: [],
      streamId: "stream-1",
      modelId: null,
      effort: null,
      autonomous: false,
      debugMode: null,
    };

    expect(event.queuedDelivery).toBeUndefined();
    expect(turn.queuedDelivery).toBeUndefined();
    expect(input.queuedDelivery).toBeUndefined();
  });
});
