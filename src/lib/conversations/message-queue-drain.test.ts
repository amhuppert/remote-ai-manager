/**
 * Tests for the conversation message-queue drain engine.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  drainConversationQueue,
  queuedBatchToSubmitPrompt,
  type ConversationQueueDeps,
  type DrainSelf,
} from "./message-queue-drain";
import type { ConversationEvent } from "@/lib/workflows/conversation/types";
import type { MessageContentBlock } from "@/lib/conversations/schemas";
import type { ClaimedQueuedBatch } from "@/lib/conversations/message-queue-service";
import { createMessageQueueService } from "@/lib/conversations/message-queue-service";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import {
  setConversationProfileAdmissionDeps,
  _resetConversationProfileAdmissionDepsForTesting,
} from "@/lib/conversations/profile-admission";
import type { ConversationState } from "@/lib/conversations/schemas";

// Infrastructure mock — createLogger is called at module level
vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

/**
 * The drain settles the conversation's agent profile before it sends. These
 * cases exercise the queue engine, not the store, so the seam answers as a
 * legacy conversation would — no profile, no lock, no write.
 */
beforeEach(() => {
  setConversationProfileAdmissionDeps({
    mutateConversation: async (_p, _s, _c, _label, mutate) =>
      mutate({
        profileSnapshot: null,
        profileLockedAt: null,
      } as unknown as ConversationState),
  });
});

afterEach(() => {
  _resetConversationProfileAdmissionDepsForTesting();
});

const DRAIN_CONTEXT = {
  projectPath: "/test/project",
  projectName: "test-project",
  sessionName: "test-session",
  conversationId: "conv-drain",
};

function makeQueueDeps(
  overrides: Partial<ConversationQueueDeps> = {},
): ConversationQueueDeps {
  return {
    claimNextTurnBatch: vi.fn(async () => null),
    markPending: vi.fn(async () => {}),
    markDelivered: vi.fn(async () => {}),
    markFailed: vi.fn(async () => {}),
    recoverAbandonedDeliveries: vi.fn(async () => 0),
    runConversationCommand: vi.fn(async () => ({
      status: "dispatched" as const,
      jobId: "job-1",
      usedFallback: false,
    })),
    ...overrides,
  };
}

function makeDrainSelf(canAccept: boolean) {
  const send = vi.fn<DrainSelf["send"]>();
  const self: DrainSelf = {
    getSnapshot: () => ({ can: () => canAccept }),
    send,
  };
  return { self, send };
}

describe("queuedBatchToSubmitPrompt", () => {
  it("joins text blocks and yields no images for text-only content", () => {
    const content: MessageContentBlock[] = [
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ];
    const result = queuedBatchToSubmitPrompt(content);
    expect(result.promptText).toBe("first\nsecond");
    expect(result.images).toEqual([]);
  });

  it("returns empty promptText when there are no text blocks", () => {
    const content: MessageContentBlock[] = [
      { type: "image", mediaType: "image/png", base64Data: "abc" },
    ];
    expect(queuedBatchToSubmitPrompt(content).promptText).toBe("");
  });

  it("maps an image block to one ImagePayload with a synthetic attachmentId", () => {
    const content: MessageContentBlock[] = [
      { type: "image", mediaType: "image/png", base64Data: "PNGDATA" },
    ];
    const { images } = queuedBatchToSubmitPrompt(content);
    expect(images).toHaveLength(1);
    expect(images[0]).toEqual({
      attachmentId: "queued-0",
      mediaType: "image/png",
      base64Data: "PNGDATA",
    });
    // Queued images deliver as appended strip images, never inline markers.
    expect(images[0]?.inlineMarkerIndex).toBeUndefined();
  });

  it("preserves mixed text+image order and gives each image a unique id", () => {
    const content: MessageContentBlock[] = [
      { type: "text", text: "look" },
      { type: "image", mediaType: "image/png", base64Data: "A" },
      { type: "text", text: "here" },
      { type: "image", mediaType: "image/jpeg", base64Data: "B" },
    ];
    const { promptText, images } = queuedBatchToSubmitPrompt(content);
    expect(promptText).toBe("look\nhere");
    expect(images.map((img) => img.attachmentId)).toEqual([
      "queued-0",
      "queued-1",
    ]);
    expect(images.map((img) => img.mediaType)).toEqual([
      "image/png",
      "image/jpeg",
    ]);
    expect(images.map((img) => img.base64Data)).toEqual(["A", "B"]);
  });

  it("skips non-text, non-image blocks", () => {
    const content: MessageContentBlock[] = [
      { type: "text", text: "hi" },
      { type: "tool_use", name: "Read" },
      { type: "image", mediaType: "image/webp", base64Data: "W" },
    ];
    const { promptText, images } = queuedBatchToSubmitPrompt(content);
    expect(promptText).toBe("hi");
    expect(images).toHaveLength(1);
  });

  it("extracts documentFeedback from a document_feedback block so the drained submit re-emits it", () => {
    const items = [
      {
        docPath: "design.md",
        path: "design.md",
        headingLabel: "Intro",
        line: 4,
        quote: "the passage",
        note: "reconsider",
      },
    ];
    const content: MessageContentBlock[] = [
      { type: "document_feedback", items },
    ];
    const result = queuedBatchToSubmitPrompt(content);
    expect(result.documentFeedback).toEqual({ items });
    // No prose text block was persisted; the actor re-derives the agent text.
    expect(result.promptText).toBe("");
  });

  it("extracts notepadFeedback from a notepad_feedback block so the drained submit re-emits it", () => {
    const block = {
      type: "notepad_feedback" as const,
      notepadId: "np-1",
      notepadName: "Release plan",
      notepadRefXml: '<notepad-ref notepad-id="np-1" name="Release plan" />',
      items: [
        {
          commentId: "c-1",
          location: "§ Rollout · L12",
          quote: "ship on Friday",
          body: "deploys are frozen on Friday",
        },
      ],
    };
    const result = queuedBatchToSubmitPrompt([block]);
    expect(result.notepadFeedback).toEqual([
      {
        notepadId: block.notepadId,
        notepadName: block.notepadName,
        notepadRefXml: block.notepadRefXml,
        items: block.items,
      },
    ]);
    // No prose text block was persisted; the actor re-derives the agent text.
    expect(result.promptText).toBe("");
  });

  it("keeps each coalesced notepad dispatch rather than merging two notepads", () => {
    const dispatch = (notepadId: string, commentId: string) => ({
      type: "notepad_feedback" as const,
      notepadId,
      notepadName: notepadId,
      notepadRefXml: `<notepad-ref notepad-id="${notepadId}" />`,
      items: [{ commentId, location: "L1", quote: "q", body: "b" }],
    });
    const result = queuedBatchToSubmitPrompt([
      dispatch("np-1", "c-1"),
      dispatch("np-2", "c-2"),
    ]);
    expect(result.notepadFeedback?.map((f) => f.notepadId)).toEqual([
      "np-1",
      "np-2",
    ]);
  });

  it("merges items from multiple coalesced document_feedback blocks", () => {
    const a = {
      docPath: "a.md",
      path: "a.md",
      headingLabel: "A",
      line: 1,
      quote: "qa",
      note: "na",
    };
    const b = {
      docPath: "b.md",
      path: "b.md",
      headingLabel: "B",
      line: 2,
      quote: "qb",
      note: "nb",
    };
    const content: MessageContentBlock[] = [
      { type: "document_feedback", items: [a] },
      { type: "document_feedback", items: [b] },
    ];
    expect(queuedBatchToSubmitPrompt(content).documentFeedback).toEqual({
      items: [a, b],
    });
  });

  it("omits documentFeedback when no feedback block is present", () => {
    const content: MessageContentBlock[] = [{ type: "text", text: "hi" }];
    expect(queuedBatchToSubmitPrompt(content).documentFeedback).toBeUndefined();
  });

  it("surfaces both promptText and documentFeedback for a coalesced mixed batch", () => {
    const items = [
      {
        docPath: "design.md",
        path: "design.md",
        headingLabel: "Intro",
        line: 4,
        quote: "the passage",
        note: "reconsider",
      },
    ];
    // A normal queued text message coalesced with a queued feedback message.
    const content: MessageContentBlock[] = [
      { type: "text", text: "also handle the empty-state case" },
      { type: "document_feedback", items },
    ];
    const result = queuedBatchToSubmitPrompt(content);
    expect(result.promptText).toBe("also handle the empty-state case");
    expect(result.documentFeedback).toEqual({ items });
  });
});

describe("drainConversationQueue", () => {
  const BATCH: ClaimedQueuedBatch = {
    deliveryAttemptId: "att-9",
    messageIds: ["m1", "m2"],
    content: [{ type: "text", text: "hello" }],
    command: null,
  };

  // Transient lanes (compaction's synthetic `compaction-<artifactId>`
  // conversations) have no message-queue rows; claiming used to throw and
  // emit error-level `queue.drain_failed` on every teardown.
  it("skips claiming entirely for a transient conversation context", async () => {
    const claimNextTurnBatch = vi.fn(async () => BATCH);
    const deps = makeQueueDeps({ claimNextTurnBatch });
    const { self, send } = makeDrainSelf(true);

    await drainConversationQueue(
      self,
      { ...DRAIN_CONTEXT, transient: true },
      deps,
    );

    expect(claimNextTurnBatch).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(deps.markPending).not.toHaveBeenCalled();
  });

  it("dispatches exactly one SUBMIT_PROMPT carrying the claimed delivery metadata", async () => {
    const claimNextTurnBatch = vi.fn(async () => BATCH);
    const deps = makeQueueDeps({ claimNextTurnBatch });
    const { self, send } = makeDrainSelf(true);

    await drainConversationQueue(self, DRAIN_CONTEXT, deps);

    expect(claimNextTurnBatch).toHaveBeenCalledWith({
      projectPath: DRAIN_CONTEXT.projectPath,
      sessionName: DRAIN_CONTEXT.sessionName,
      conversationId: DRAIN_CONTEXT.conversationId,
    });
    expect(send).toHaveBeenCalledTimes(1);
    const event = send.mock.calls[0]?.[0] as ConversationEvent;
    expect(event.type).toBe("SUBMIT_PROMPT");
    if (event.type !== "SUBMIT_PROMPT") throw new Error("wrong event");
    expect(event.promptText).toBe("hello");
    expect(event.queuedDelivery).toEqual({
      messageIds: ["m1", "m2"],
      deliveryAttemptId: "att-9",
    });
    expect(deps.markPending).not.toHaveBeenCalled();
  });

  it("dispatches the complete enqueue-time model selection without reconstructing it", async () => {
    const modelSelection = {
      modelId: "claude-opus-5",
      parameters: { effort: "xhigh", thinking: "true" },
    };
    const claimNextTurnBatch = vi.fn(async () => ({
      ...BATCH,
      modelSelection,
    }));
    const deps = makeQueueDeps({ claimNextTurnBatch });
    const { self, send } = makeDrainSelf(true);

    await drainConversationQueue(self, DRAIN_CONTEXT, deps);

    const event = send.mock.calls[0]?.[0];
    expect(event?.type).toBe("SUBMIT_PROMPT");
    if (event?.type !== "SUBMIT_PROMPT") throw new Error("wrong event");
    expect(event.modelSelection).toEqual(modelSelection);
  });

  it("dispatches a SUBMIT_PROMPT carrying documentFeedback for a queued feedback batch", async () => {
    const items = [
      {
        docPath: "design.md",
        path: "design.md",
        headingLabel: "Intro",
        line: 4,
        quote: "the passage",
        note: "reconsider",
      },
    ];
    const feedbackBatch: ClaimedQueuedBatch = {
      deliveryAttemptId: "att-fb",
      messageIds: ["mfb"],
      content: [{ type: "document_feedback", items }],
      command: null,
    };
    const claimNextTurnBatch = vi.fn(async () => feedbackBatch);
    const deps = makeQueueDeps({ claimNextTurnBatch });
    const { self, send } = makeDrainSelf(true);

    await drainConversationQueue(self, DRAIN_CONTEXT, deps);

    expect(send).toHaveBeenCalledTimes(1);
    const event = send.mock.calls[0]?.[0] as ConversationEvent;
    if (event.type !== "SUBMIT_PROMPT") throw new Error("wrong event");
    expect(event.documentFeedback).toEqual({ items });
  });

  it("dispatches a SUBMIT_PROMPT carrying BOTH text and documentFeedback for a coalesced mixed batch", async () => {
    const items = [
      {
        docPath: "design.md",
        path: "design.md",
        headingLabel: "Intro",
        line: 4,
        quote: "the passage",
        note: "reconsider",
      },
    ];
    const mixedBatch: ClaimedQueuedBatch = {
      deliveryAttemptId: "att-mix",
      messageIds: ["mtext", "mfb"],
      content: [
        { type: "text", text: "also handle the empty-state case" },
        { type: "document_feedback", items },
      ],
      command: null,
    };
    const claimNextTurnBatch = vi.fn(async () => mixedBatch);
    const deps = makeQueueDeps({ claimNextTurnBatch });
    const { self, send } = makeDrainSelf(true);

    await drainConversationQueue(self, DRAIN_CONTEXT, deps);

    expect(send).toHaveBeenCalledTimes(1);
    const event = send.mock.calls[0]?.[0] as ConversationEvent;
    if (event.type !== "SUBMIT_PROMPT") throw new Error("wrong event");
    expect(event.promptText).toBe("also handle the empty-state case");
    expect(event.documentFeedback).toEqual({ items });
  });

  it("returns the batch to pending when the actor cannot accept the prompt", async () => {
    const claimNextTurnBatch = vi.fn(async () => BATCH);
    const markPending = vi.fn(async () => {});
    const deps = makeQueueDeps({ claimNextTurnBatch, markPending });
    const { self, send } = makeDrainSelf(false);

    await drainConversationQueue(self, DRAIN_CONTEXT, deps);

    expect(send).not.toHaveBeenCalled();
    expect(markPending).toHaveBeenCalledTimes(1);
    expect(markPending).toHaveBeenCalledWith(
      expect.objectContaining({
        ids: ["m1", "m2"],
        deliveryAttemptId: "att-9",
      }),
    );
  });

  it("no-ops on an empty queue: neither dispatches nor returns to pending", async () => {
    const claimNextTurnBatch = vi.fn(async () => null);
    const markPending = vi.fn(async () => {});
    const deps = makeQueueDeps({ claimNextTurnBatch, markPending });
    const { self, send } = makeDrainSelf(true);

    await drainConversationQueue(self, DRAIN_CONTEXT, deps);

    expect(send).not.toHaveBeenCalled();
    expect(markPending).not.toHaveBeenCalled();
  });

  it("returns the batch to pending when an unexpected claim handler error occurs after claim", async () => {
    // Claim succeeds, then send throws — exercises the catch path that must
    // not let the fire-and-forget action reject and must reclaim the rows.
    const claimNextTurnBatch = vi.fn(async () => BATCH);
    const markPending = vi.fn(async () => {});
    const deps = makeQueueDeps({ claimNextTurnBatch, markPending });
    const send = vi.fn<DrainSelf["send"]>(() => {
      throw new Error("send boom");
    });
    const self: DrainSelf = {
      getSnapshot: () => ({ can: () => true }),
      send,
    };

    await expect(
      drainConversationQueue(self, DRAIN_CONTEXT, deps),
    ).resolves.toBeUndefined();

    expect(markPending).toHaveBeenCalledWith(
      expect.objectContaining({
        ids: ["m1", "m2"],
        deliveryAttemptId: "att-9",
      }),
    );
  });
});

describe("drainConversationQueue command routing", () => {
  const COMMAND_BATCH: ClaimedQueuedBatch = {
    deliveryAttemptId: "att-cmd",
    messageIds: ["c1"],
    content: [{ type: "text", text: "/commit focus on the API" }],
    command: { command: "commit", hint: "focus on the API" },
    modelSelection: {
      modelId: "opus",
      parameters: { effort: "high" },
    },
  };

  it("routes a command batch to the command service with the direct-path input shape and never sends SUBMIT_PROMPT", async () => {
    const deps = makeQueueDeps({
      claimNextTurnBatch: vi.fn(async () => COMMAND_BATCH),
    });
    const { self, send } = makeDrainSelf(true);

    await drainConversationQueue(self, DRAIN_CONTEXT, deps);

    expect(send).not.toHaveBeenCalled();
    expect(deps.runConversationCommand).toHaveBeenCalledTimes(1);
    expect(deps.runConversationCommand).toHaveBeenCalledWith({
      projectPath: DRAIN_CONTEXT.projectPath,
      projectName: DRAIN_CONTEXT.projectName,
      sessionName: DRAIN_CONTEXT.sessionName,
      conversationId: DRAIN_CONTEXT.conversationId,
      parsed: { command: "commit", hint: "focus on the API" },
      rawText: "/commit focus on the API",
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "high" },
      },
    });
    expect(deps.markPending).not.toHaveBeenCalled();
    expect(deps.markFailed).not.toHaveBeenCalled();
  });

  it("marks the command row delivered only after the run resolves", async () => {
    const order: string[] = [];
    let resolveRun!: (outcome: {
      status: "dispatched";
      jobId: string;
      usedFallback: boolean;
    }) => void;
    const runConversationCommand = vi.fn(() => {
      order.push("run-start");
      return new Promise<{
        status: "dispatched";
        jobId: string;
        usedFallback: boolean;
      }>((resolve) => {
        resolveRun = resolve;
      });
    });
    const markDelivered = vi.fn(async () => {
      order.push("delivered");
    });
    const deps = makeQueueDeps({
      claimNextTurnBatch: vi.fn(async () => COMMAND_BATCH),
      runConversationCommand,
      markDelivered,
    });
    const { self } = makeDrainSelf(true);

    const drain = drainConversationQueue(self, DRAIN_CONTEXT, deps);
    // Let the drain reach the awaited run before resolving it.
    await vi.waitFor(() => expect(runConversationCommand).toHaveBeenCalled());
    expect(markDelivered).not.toHaveBeenCalled();

    resolveRun({ status: "dispatched", jobId: "job-7", usedFallback: false });
    await drain;

    expect(order).toEqual(["run-start", "delivered"]);
    expect(markDelivered).toHaveBeenCalledWith({
      projectPath: DRAIN_CONTEXT.projectPath,
      sessionName: DRAIN_CONTEXT.sessionName,
      conversationId: DRAIN_CONTEXT.conversationId,
      ids: ["c1"],
      deliveryAttemptId: "att-cmd",
    });
  });

  it("maps the project sentinel to sessionName null + noticeSessionName, like the direct path", async () => {
    const deps = makeQueueDeps({
      claimNextTurnBatch: vi.fn(async () => COMMAND_BATCH),
    });
    const { self } = makeDrainSelf(true);

    await drainConversationQueue(
      self,
      {
        ...DRAIN_CONTEXT,
        sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
      },
      deps,
    );

    expect(deps.runConversationCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionName: null,
        noticeSessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
      }),
    );
  });

  it("marks the row failed (terminal, error recorded) when the run throws, never returning it to pending", async () => {
    // A service throw is a system error: rejections and fallbacks resolve as
    // outcomes. Returning the row to pending would retry a deterministic
    // failure on every idle entry, so the drain must settle it terminally.
    const deps = makeQueueDeps({
      claimNextTurnBatch: vi.fn(async () => COMMAND_BATCH),
      runConversationCommand: vi.fn(async () => {
        throw new Error("command run boom");
      }),
    });
    const { self, send } = makeDrainSelf(true);

    await expect(
      drainConversationQueue(self, DRAIN_CONTEXT, deps),
    ).resolves.toBeUndefined();

    expect(send).not.toHaveBeenCalled();
    expect(deps.markDelivered).not.toHaveBeenCalled();
    expect(deps.markPending).not.toHaveBeenCalled();
    expect(deps.markFailed).toHaveBeenCalledWith({
      projectPath: DRAIN_CONTEXT.projectPath,
      sessionName: DRAIN_CONTEXT.sessionName,
      conversationId: DRAIN_CONTEXT.conversationId,
      ids: ["c1"],
      deliveryAttemptId: "att-cmd",
      error: "command run boom",
    });
  });

  it("records the committed ticket identifier when a queued confirmation could not be persisted", async () => {
    const deps = makeQueueDeps({
      claimNextTurnBatch: vi.fn(async () => ({
        ...COMMAND_BATCH,
        content: [{ type: "text" as const, text: "/ticket retry bug" }],
        command: { command: "ticket" as const, hint: "retry bug" },
      })),
      runConversationCommand: vi.fn(async () => ({
        status: "ticket_created" as const,
        identifier: "test-project#12",
        confirmationPersisted: false,
      })),
    });
    const { self } = makeDrainSelf(true);

    await drainConversationQueue(self, DRAIN_CONTEXT, deps);

    expect(deps.markDelivered).not.toHaveBeenCalled();
    expect(deps.markFailed).toHaveBeenCalledWith({
      projectPath: DRAIN_CONTEXT.projectPath,
      sessionName: DRAIN_CONTEXT.sessionName,
      conversationId: DRAIN_CONTEXT.conversationId,
      ids: ["c1"],
      deliveryAttemptId: "att-cmd",
      error:
        "Created ticket test-project#12, but its confirmation could not be saved to this conversation.",
    });
  });

  it("records the root ticket failure when its queued failure notice could not be persisted", async () => {
    const runConversationCommand = vi.fn(async () => ({
      status: "ticket_failed" as const,
      reason: "generation turn failed: turn timed out",
      failureNoticePersisted: false,
    }));
    const deps = makeQueueDeps({
      claimNextTurnBatch: vi.fn(async () => ({
        ...COMMAND_BATCH,
        content: [{ type: "text" as const, text: "/ticket retry bug" }],
        command: { command: "ticket" as const, hint: "retry bug" },
      })),
      runConversationCommand,
    });
    const { self } = makeDrainSelf(true);

    await drainConversationQueue(self, DRAIN_CONTEXT, deps);

    expect(runConversationCommand).toHaveBeenCalledTimes(1);
    expect(deps.markDelivered).not.toHaveBeenCalled();
    expect(deps.markPending).not.toHaveBeenCalled();
    expect(deps.markFailed).toHaveBeenCalledWith({
      projectPath: DRAIN_CONTEXT.projectPath,
      sessionName: DRAIN_CONTEXT.sessionName,
      conversationId: DRAIN_CONTEXT.conversationId,
      ids: ["c1"],
      deliveryAttemptId: "att-cmd",
      error:
        "/ticket failed: generation turn failed: turn timed out — no ticket was created. The failure notice could not be saved to this conversation.",
    });
  });
});

describe("drain integration over the real-store queue (text → command → text)", () => {
  it("drains as turn, command run, turn — in order, with direct-path command semantics", async () => {
    const fixture = createPersistenceFixture();
    try {
      const projectPath = "/repos/proj";
      const sessionName = "feat";
      const conversationId = "conv-int";
      fixture.seedProject(projectPath);
      fixture.seedSession(projectPath, sessionName);
      await fixture.seedConversation(
        projectPath,
        sessionName,
        conversationStateSchema.parse({
          id: conversationId,
          transcriptPath: null,
          status: "running",
          promptCount: 0,
          createdAt: "2026-06-01T00:00:00.000Z",
          lastActivityAt: "2026-06-01T00:00:00.000Z",
        }),
      );

      const queueService = createMessageQueueService({
        mutateConversation: (p, s, c, label, mutate) =>
          fixture.deps.mutateConversation(p, s, c, label, mutate),
        getConversation: (p, s, c) => fixture.deps.getConversation(p, s, c),
        getProjectDisplayName: () => "proj",
        broadcast: () => {},
        now: () => new Date().toISOString(),
        newId: () => crypto.randomUUID(),
      });

      const key = { projectPath, sessionName, conversationId };
      const first = await queueService.enqueue({
        ...key,
        content: [{ type: "text", text: "first message" }],
      });
      const command = await queueService.enqueue({
        ...key,
        content: [{ type: "text", text: "/commit tighten the API" }],
      });
      const last = await queueService.enqueue({
        ...key,
        content: [{ type: "text", text: "last message" }],
      });

      const runInputs: unknown[] = [];
      const commandRowStatusDuringRun: string[] = [];
      const deps: ConversationQueueDeps = {
        claimNextTurnBatch: (input) => queueService.claimNextTurnBatch(input),
        markPending: (input) => queueService.markPending(input),
        markDelivered: (input) => queueService.markDelivered(input),
        markFailed: (input) => queueService.markFailed(input),
        recoverAbandonedDeliveries: (input) =>
          queueService.recoverAbandonedDeliveries(input),
        async runConversationCommand(input) {
          runInputs.push(input);
          // The row must not be marked delivered while the run is in flight.
          const conv = await fixture.deps.getConversation(
            projectPath,
            sessionName,
            conversationId,
          );
          commandRowStatusDuringRun.push(
            conv?.pendingQueue.find((r) => r.id === command.id)?.status ??
              "missing",
          );
          return {
            status: "dispatched",
            jobId: "job-int",
            usedFallback: false,
          };
        },
      };

      const sent: ConversationEvent[] = [];
      const self: DrainSelf = {
        getSnapshot: () => ({ can: () => true }),
        send: (event) => {
          sent.push(event);
        },
      };
      const context = {
        projectPath,
        projectName: "proj",
        sessionName,
        conversationId,
      };

      // Drain 1: the plain prefix before the command becomes one turn.
      await drainConversationQueue(self, context, deps);
      expect(sent).toHaveLength(1);
      const firstEvent = sent[0];
      if (firstEvent?.type !== "SUBMIT_PROMPT") {
        throw new Error("expected SUBMIT_PROMPT");
      }
      expect(firstEvent.promptText).toBe("first message");
      expect(firstEvent.queuedDelivery?.messageIds).toEqual([first.id]);
      // Simulate backend acceptance of the dispatched turn.
      await queueService.markDelivered({
        ...key,
        ids: [first.id],
        deliveryAttemptId: firstEvent.queuedDelivery!.deliveryAttemptId,
      });

      // Drain 2: the command at the head runs through the command service.
      await drainConversationQueue(self, context, deps);
      expect(sent).toHaveLength(1);
      expect(runInputs).toEqual([
        {
          projectPath,
          projectName: "proj",
          sessionName,
          conversationId,
          parsed: { command: "commit", hint: "tighten the API" },
          rawText: "/commit tighten the API",
        },
      ]);
      expect(commandRowStatusDuringRun).toEqual(["delivering"]);
      // Read back the RELOADED state: command delivered then pruned, trailing
      // text still pending.
      const afterCommand = await fixture.deps.getConversation(
        projectPath,
        sessionName,
        conversationId,
      );
      expect(
        afterCommand?.pendingQueue.find((r) => r.id === command.id),
      ).toBeUndefined();
      expect(
        afterCommand?.pendingQueue.find((r) => r.id === last.id)?.status,
      ).toBe("pending");

      // Drain 3: the trailing text drains as a normal turn.
      await drainConversationQueue(self, context, deps);
      expect(sent).toHaveLength(2);
      const lastEvent = sent[1];
      if (lastEvent?.type !== "SUBMIT_PROMPT") {
        throw new Error("expected SUBMIT_PROMPT");
      }
      expect(lastEvent.promptText).toBe("last message");
      expect(lastEvent.queuedDelivery?.messageIds).toEqual([last.id]);
    } finally {
      fixture.close();
    }
  });
});
