import { describe, it, expect } from "vitest";
import {
  messageQueuedEventSchema,
  messageQueueUpdatedEventSchema,
  type MessageQueuedEvent,
  type MessageQueueUpdatedEvent,
} from "@/lib/conversations/schemas";
import type { QueuedMessageView } from "@/lib/conversations/message-queue-schemas";
import {
  specApprovalChangedEventSchema,
  specAttentionChangedEventSchema,
  specChangedEventSchema,
  specEvidenceChangedEventSchema,
  specExecutionChangedEventSchema,
  specRevisionChangedEventSchema,
  specSseEventSchema,
  type SpecSseEvent,
  type SSEEvent,
} from "./sse-events";

const sampleQueuedMessageView: QueuedMessageView = {
  id: "q1",
  content: [{ type: "text", text: "follow up" }],
  status: "pending",
  enqueuedAt: "2026-06-07T00:00:00.000Z",
  updatedAt: "2026-06-07T00:00:00.000Z",
  deliveredAt: null,
  cancelledAt: null,
  failedAt: null,
  error: null,
  metadata: null,
};

describe("SSEEvent union — queue events", () => {
  it("includes the queue-created (message-queued) event and validates a sample payload", () => {
    const sample: MessageQueuedEvent = {
      type: "message-queued",
      scope: "session",
      projectName: "p",
      sessionName: "s",
      conversationId: "c1",
      text: "follow up",
      message: sampleQueuedMessageView,
    };

    // Compile-time inclusion proof: a MessageQueuedEvent is assignable to SSEEvent.
    const asUnion: SSEEvent = sample;
    expect(asUnion.type).toBe("message-queued");

    const parsed = messageQueuedEventSchema.safeParse(sample);
    expect(parsed.success).toBe(true);
  });

  it("includes the queue-updated (message-queue-updated) event and validates a sample payload", () => {
    const sample: MessageQueueUpdatedEvent = {
      type: "message-queue-updated",
      scope: "session",
      projectName: "p",
      sessionName: "s",
      conversationId: "c1",
      message: sampleQueuedMessageView,
    };

    // Compile-time inclusion proof: a MessageQueueUpdatedEvent is assignable to SSEEvent.
    const asUnion: SSEEvent = sample;
    expect(asUnion.type).toBe("message-queue-updated");

    const parsed = messageQueueUpdatedEventSchema.safeParse(sample);
    expect(parsed.success).toBe(true);
  });
});

describe("SSEEvent union — strict spec events", () => {
  const common = {
    projectPath: "/repos/command-center",
    specId: "spec-1",
    specSlug: "native-sdd",
    occurredAt: "2026-07-18T14:00:00.000Z",
  };
  const samples: Array<{
    schema:
      | typeof specChangedEventSchema
      | typeof specRevisionChangedEventSchema
      | typeof specApprovalChangedEventSchema
      | typeof specExecutionChangedEventSchema
      | typeof specEvidenceChangedEventSchema
      | typeof specAttentionChangedEventSchema;
    event: SpecSseEvent;
  }> = [
    {
      schema: specChangedEventSchema,
      event: {
        type: "spec-changed",
        kind: "content-changed",
        ...common,
        revisionId: "revision-1",
        elementIds: ["requirement-1"],
      },
    },
    {
      schema: specRevisionChangedEventSchema,
      event: {
        type: "spec-revision-changed",
        kind: "proposed",
        ...common,
        revisionId: "revision-1",
        elementIds: ["requirement-1"],
      },
    },
    {
      schema: specApprovalChangedEventSchema,
      event: {
        type: "spec-approval-changed",
        kind: "approval-granted",
        ...common,
        revisionId: "revision-1",
        subjectId: "requirement-1",
      },
    },
    {
      schema: specExecutionChangedEventSchema,
      event: {
        type: "spec-execution-changed",
        kind: "running",
        ...common,
        revisionId: "revision-1",
        executionId: "execution-1",
      },
    },
    {
      schema: specEvidenceChangedEventSchema,
      event: {
        type: "spec-evidence-changed",
        kind: "proof-verdict-recorded",
        ...common,
        revisionId: "revision-1",
        criterionId: "criterion-1",
        executionId: "execution-1",
      },
    },
    {
      schema: specAttentionChangedEventSchema,
      event: {
        type: "spec-attention-changed",
        kind: "needs-you-added",
        ...common,
        attentionId: "attention-1",
        active: true,
      },
    },
  ];

  it.each(samples)("includes and accepts $event.type", ({ schema, event }) => {
    const asUnion: SSEEvent = event;

    expect(asUnion.type).toBe(event.type);
    expect(schema.safeParse(event).success).toBe(true);
    expect(specSseEventSchema.safeParse(event).success).toBe(true);
  });

  it.each(samples)(
    "$event.type rejects transport metadata before the SSE envelope strips it",
    ({ schema, event }) => {
      expect(schema.safeParse({ ...event, _sentAt: 123 }).success).toBe(false);
    },
  );
});
