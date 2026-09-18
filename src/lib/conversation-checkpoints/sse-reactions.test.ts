import { checkpointReceiptFixture } from "./testing/receipt-fixture";
import { capturedHandoff } from "./handoff-fixture";
import { checkpointHandoffReceipt } from "./receipt";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { checkpointKeys, type CheckpointTarget } from "./query-keys";
import { registerConversationCheckpointSseReactions } from "./sse-reactions";

/**
 * A minimal stand-in for the shared EventSource: `addSseListener` only needs
 * `addEventListener`, and driving it directly is what lets these tests assert
 * on the real listener registration rather than on a fake of it.
 */
class FakeEventSource {
  private readonly listeners = new Map<
    string,
    ((event: MessageEvent) => void)[]
  >();

  addEventListener(type: string, handler: (event: MessageEvent) => void): void {
    const existing = this.listeners.get(type) ?? [];
    this.listeners.set(type, [...existing, handler]);
  }

  emit(type: string, payload: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) {
      handler({ data: JSON.stringify(payload) } as MessageEvent);
    }
  }
}

const sessionTarget: CheckpointTarget = {
  scope: "session",
  projectName: "proj",
  sessionName: "sess",
  conversationId: "conv-1",
};

const otherTarget: CheckpointTarget = {
  scope: "session",
  projectName: "proj",
  sessionName: "sess",
  conversationId: "conv-2",
};

function seeded(): { client: QueryClient; es: FakeEventSource } {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(checkpointKeys.eligibility(sessionTarget), {
    eligible: false,
    refusals: [],
    active: null,
    hosted: true,
  });
  client.setQueryData(checkpointKeys.eligibility(otherTarget), {
    eligible: true,
    refusals: [],
    active: null,
    hosted: true,
  });
  const es = new FakeEventSource();
  registerConversationCheckpointSseReactions(es as unknown as EventSource, {
    queryClient: client,
  });
  return { client, es };
}

/**
 * Eligibility is a server predicate over ordinary conversation state — a
 * running turn, a parked question — none of which the checkpoint receipt
 * reports. Without these reactions a menu keeps offering (or refusing) an
 * action on a conversation whose state moved on minutes ago.
 */
describe("checkpoint eligibility freshness", () => {
  it.each(["session", "project"] as const)(
    "refreshes addressed recovery after queue review in %s scope",
    (scope) => {
      const { client, es } = seeded();
      const target: CheckpointTarget =
        scope === "session"
          ? sessionTarget
          : { scope, projectName: "proj", conversationId: "conv-1" };
      client.setQueryData(checkpointKeys.eligibility(target), {
        eligible: false,
        refusals: [{ code: "queue_review_required" }],
      });

      es.emit("message-queue-updated", {
        type: "message-queue-updated",
        ...target,
        message: {
          id: "queued-1",
          content: [{ type: "text", text: "Pending input" }],
          status: "cancelled",
          enqueuedAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:01.000Z",
          deliveredAt: null,
          cancelledAt: "2026-09-01T00:00:01.000Z",
          failedAt: null,
          error: null,
        },
      });

      expect(
        client.getQueryState(checkpointKeys.eligibility(target))?.isInvalidated,
      ).toBe(true);
      expect(
        client.getQueryState(checkpointKeys.eligibility(otherTarget))
          ?.isInvalidated,
      ).toBe(false);
    },
  );

  it("re-reads eligibility for the conversation whose turn state changed", () => {
    const { client, es } = seeded();

    es.emit("conversation-status", {
      type: "conversation-status",
      scope: "session",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      status: "awaiting",
    });

    expect(
      client.getQueryState(checkpointKeys.eligibility(sessionTarget))
        ?.isInvalidated,
    ).toBe(true);
    // A sibling conversation's slot did not change.
    expect(
      client.getQueryState(checkpointKeys.eligibility(otherTarget))
        ?.isInvalidated,
    ).toBe(false);
  });

  it("re-reads eligibility when a question parks the conversation", () => {
    const { client, es } = seeded();

    es.emit("ask-question", {
      type: "ask-question",
      scope: "session",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      questionId: "q-1",
      questions: [],
    });

    expect(
      client.getQueryState(checkpointKeys.eligibility(sessionTarget))
        ?.isInvalidated,
    ).toBe(true);
  });

  // Background work is a checkpoint admission predicate, but its event is a
  // PROGRESS feed. Re-reading eligibility on every tick would be pure waste,
  // and a stale "eligible" is harmless — the server still refuses and that
  // typed refusal is what the surfaces show. The harmful direction is the
  // other one: work that ended leaving the action disabled forever.
  it("re-reads eligibility when background work ends", () => {
    const { client, es } = seeded();

    es.emit("conversation-background-activity", {
      type: "conversation-background-activity",
      scope: "session",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      activity: null,
    });

    expect(
      client.getQueryState(checkpointKeys.eligibility(sessionTarget))
        ?.isInvalidated,
    ).toBe(true);
  });

  it("ignores background progress ticks", () => {
    const { client, es } = seeded();

    es.emit("conversation-background-activity", {
      type: "conversation-background-activity",
      scope: "session",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      activity: {
        tasks: [
          {
            taskId: "task-1",
            description: "running tests",
            taskType: null,
            workflowName: null,
            subagentType: null,
            lastToolName: "bash",
            totalTokens: null,
            toolUses: 3,
            startedAt: "2026-09-01T00:00:00.000Z",
            lastActivityAt: "2026-09-01T00:00:05.000Z",
          },
        ],
        updatedAt: "2026-09-01T00:00:05.000Z",
      },
    });

    expect(
      client.getQueryState(checkpointKeys.eligibility(sessionTarget))
        ?.isInvalidated,
    ).toBe(false);
  });

  it("addresses a project conversation at the project scope", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const projectTarget: CheckpointTarget = {
      scope: "project",
      projectName: "proj",
      conversationId: "plc-1",
    };
    client.setQueryData(checkpointKeys.eligibility(projectTarget), {
      eligible: true,
      refusals: [],
      active: null,
      hosted: true,
    });
    const es = new FakeEventSource();
    registerConversationCheckpointSseReactions(es as unknown as EventSource, {
      queryClient: client,
    });

    es.emit("conversation-status", {
      type: "conversation-status",
      scope: "project",
      projectName: "proj",
      conversationId: "plc-1",
      status: "running",
    });

    expect(
      client.getQueryState(checkpointKeys.eligibility(projectTarget))
        ?.isInvalidated,
    ).toBe(true);
  });
});

it.each(["session", "project"] as const)(
  "receives typed capture progress through the SSE listener (%s)",
  (scope) => {
    const { client, es } = seeded();
    const target: CheckpointTarget =
      scope === "session"
        ? sessionTarget
        : { scope, projectName: "proj", conversationId: "conv-1" };
    const receipt = checkpointReceiptFixture({
      scope,
      handoff: checkpointHandoffReceipt(capturedHandoff()),
    });
    es.emit("conversation-checkpoint-updated", {
      type: "conversation-checkpoint-updated",
      ...target,
      receipt,
    });
    expect(
      client.getQueryData(checkpointKeys.detail(target, receipt.operationId)),
    ).toEqual({ receipt });
  },
);
