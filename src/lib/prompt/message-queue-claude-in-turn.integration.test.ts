import { describe, it, expect, vi } from "vitest";

// Logging is module-load-time infrastructure; mocking it is the sanctioned
// exception (CLAUDE.md / engineering-principles). Both `queueMessage` and the
// queue service call `createLogger` at module load, so a single mock keeps the
// seam under test free of a real log sink.
vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

import type { ConversationState } from "@/lib/conversations/schemas";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import type { SSEEvent } from "@/lib/api/sse-events";
import type { TranscriptEntry } from "@/lib/prompt/transcript";
import type {
  ConversationBackendRuntime,
  ConversationQueuedUserInput,
} from "@/lib/agent-backends/conversation";
import { queueCapabilityForBackend } from "@/lib/agent-backends/catalog";

import {
  createMessageQueueService,
  type MessageQueueServiceDeps,
} from "@/lib/conversations/message-queue-service";

import { queueMessage, type QueueMessageDeps } from "./queue";
import { InputDeliveryUncertainError } from "@/lib/agent-backends/errors";

const NOW = "2026-06-08T09:00:00.000Z";

const KEY = {
  projectPath: "/repos/my-project",
  sessionName: "csm/feature",
  conversationId: "conv-1",
} as const;

/**
 * A running CLAUDE conversation with an empty durable queue, built through the
 * real stored-conversation schema (via the shared factory) so `pendingQueue`
 * defaults correctly and the service exercises real persistence semantics.
 */
function makeRunningClaudeConversation(): ConversationState {
  return makeConversationState({
    id: "conv-1",
    status: "running",
    agentBackend: "claude",
    createdAt: NOW,
    lastActivityAt: NOW,
  });
}

interface FakeStore {
  conversation: ConversationState | null;
}

/**
 * Real queue-service deps wired to an in-memory `ConversationState`. The
 * `mutateConversation` fake stands in only for the state-store I/O boundary: it
 * applies the REAL production mutate callback to the backing object so every
 * enqueue/claim/mark transform under test is the production transform.
 */
function makeQueueServiceDeps(store: FakeStore): {
  deps: MessageQueueServiceDeps;
  broadcasts: SSEEvent[];
} {
  const broadcasts: SSEEvent[] = [];
  let idCounter = 0;
  const deps: MessageQueueServiceDeps = {
    async mutateConversation(
      _projectPath,
      _sessionName,
      _conversationId,
      _label,
      mutate,
    ) {
      if (!store.conversation) {
        throw new Error("conversation not found");
      }
      return mutate(store.conversation);
    },
    async getConversation() {
      return store.conversation;
    },
    getProjectDisplayName() {
      return "my-project";
    },
    broadcast(event) {
      broadcasts.push(event);
    },
    now() {
      return NOW;
    },
    newId() {
      idCounter += 1;
      return `id-${idCounter}`;
    },
  };
  return { deps, broadcasts };
}

/**
 * A live Claude session at the runtime I/O boundary that ACCEPTS in-turn input.
 * Only `queueUserInput` is exercised by the live-delivery path under test; the
 * other runtime members exist to satisfy the `ConversationBackendRuntime`
 * contract and throw if the path unexpectedly touches them.
 */
function makeAcceptingClaudeRuntime(): {
  runtime: ConversationBackendRuntime;
  received: ConversationQueuedUserInput[];
  callOrder: string[];
} {
  const received: ConversationQueuedUserInput[] = [];
  const callOrder: string[] = [];
  const runtime: ConversationBackendRuntime = {
    backend: "claude",
    status: "alive",
    modelSelection: {
      modelId: "opus",
      parameters: { effort: "high" },
    },

    sendTurn: vi.fn(async () => {
      throw new Error("sendTurn must not run in the live in-turn path");
    }),
    queueUserInput: vi.fn(async (input: ConversationQueuedUserInput) => {
      callOrder.push("queueUserInput");
      received.push(input);
      await input.onAccepted?.();
    }),
    close: vi.fn(async () => {}),
  };
  return { runtime, received, callOrder };
}

describe("Claude in-turn live-delivery flow (integration)", () => {
  it("holds a lost live acknowledgement for review without next-turn redelivery", async () => {
    const store: FakeStore = { conversation: makeRunningClaudeConversation() };
    const { deps: serviceDeps } = makeQueueServiceDeps(store);
    const service = createMessageQueueService(serviceDeps);
    const { runtime } = makeAcceptingClaudeRuntime();
    runtime.queueUserInput = async () => {
      throw new InputDeliveryUncertainError("acknowledgement lost");
    };
    const appended: TranscriptEntry[] = [];
    await queueMessage({
      ...KEY,
      backend: "claude",
      text: "only once",
      deps: {
        enqueue: service.enqueue,
        claimLiveDelivery: service.claimLiveDelivery,
        markPending: service.markPending,
        markDelivered: service.markDelivered,
        markUncertain: service.markUncertain,
        getRuntime: () => runtime,
        appendTranscriptEntry: async (_id, entry) => {
          appended.push(entry);
        },
        getProjectDisplayName: () => "my-project",
      },
    });
    expect(store.conversation?.pendingQueue).toMatchObject([
      { status: "uncertain", error: "acknowledgement lost" },
    ]);
    expect(appended).toEqual([]);
    expect(await service.claimNextTurnBatch(KEY)).toBeNull();
  });
  it("queues during a running Claude turn, accepts live delivery, appends once after acceptance, and transitions pending -> delivered", async () => {
    // --- Compose the REAL queue service over an in-memory running Claude
    //     conversation, and the REAL queueMessage over that same service.
    const store: FakeStore = { conversation: makeRunningClaudeConversation() };
    const { deps: serviceDeps } = makeQueueServiceDeps(store);
    const service = createMessageQueueService(serviceDeps);

    const { runtime, received, callOrder } = makeAcceptingClaudeRuntime();

    // Capture transcript appends at the transcript-writer I/O boundary, and
    // record their position relative to the markDelivered transition so order
    // can be asserted.
    const appendedEntries: TranscriptEntry[] = [];

    const queueDeps: Partial<QueueMessageDeps> = {
      // Bind the live-delivery lifecycle methods to the REAL service instance
      // operating on the same in-memory store the enqueue mutates.
      enqueue: (input) => service.enqueue(input),
      claimLiveDelivery: (input) => service.claimLiveDelivery(input),
      markDelivered: async (input) => {
        callOrder.push("markDelivered");
        return service.markDelivered(input);
      },
      markPending: (input) => service.markPending(input),
      // Live Claude session that accepts the in-turn input.
      getRuntime: () => runtime,
      // Real capability resolver: claude -> in_turn.
      queueCapabilityForBackend: (backend) =>
        queueCapabilityForBackend(backend),
      // Capturing transcript writer (the JSONL I/O boundary).
      appendTranscriptEntry: async (_conversationId, entry) => {
        callOrder.push("append");
        appendedEntries.push(entry);
      },
      getProjectDisplayName: () => "my-project",
      // No images in this scenario.
      getNextImageIndex: async () => 0,
      saveTranscriptImage: async () => {
        throw new Error("no images in this scenario");
      },
    };

    // --- Step 1: queue a message during the running Claude turn (req 2.1) ---
    const result = await queueMessage({
      ...KEY,
      text: "live message",
      backend: "claude",
      deps: queueDeps,
    });

    // --- Step 2: the durable queue — not the JSONL transcript — owns the
    //     message. `queueMessage` returns the row as `pending` from enqueue; the
    //     in-turn flow then delivers it and prunes the terminal entry, so the
    //     durable queue is empty once the flow completes.
    expect(result.entry.status).toBe("pending");
    expect(store.conversation?.pendingQueue).toEqual([]);
    // Exactly one transcript append occurred across the whole flow, and Step 5
    // pins that it happened only AFTER backend acceptance — never at enqueue.
    expect(appendedEntries).toHaveLength(1);

    // --- Step 3: live delivery accepted (req 2.1) ---
    expect(result.deliveryTiming).toBe("in_turn");
    const queueUserInput = runtime.queueUserInput;
    expect(queueUserInput).toBeDefined();
    if (!queueUserInput) throw new Error("expected a live queueUserInput");
    expect(queueUserInput).toHaveBeenCalledTimes(1);
    // The exact live input handed to the running session.
    expect(received).toHaveLength(1);
    expect(received[0]?.content).toEqual([
      { type: "text", text: "live message" },
    ]);

    // --- Step 4: append-after-acceptance + delivered (req 2.4, 4.1) ---
    // Exactly one delivered user transcript entry, written AFTER queueUserInput
    // resolved (the order assertion in Step 5 pins this), carrying the live text.
    expect(appendedEntries).toHaveLength(1);
    const delivered = appendedEntries[0];
    expect(delivered?.type).toBe("user");
    expect(delivered?.role).toBe("user");
    expect(delivered?.content).toEqual([
      { type: "text", text: "live message" },
    ]);

    // The queue row transitioned to `delivered` (shown by its transcript row
    // and the markDelivered call in Step 5) and was then pruned — terminal
    // entries are not retained, so the durable queue holds it no longer.
    const finalRow = store.conversation?.pendingQueue.find(
      (r) => r.id === result.entry.id,
    );
    expect(finalRow).toBeUndefined();

    // `listActive` is now EMPTY — the pending entry is gone because it is
    // delivered (req 4.1: the queue is source of truth only until confirmed).
    const active = await service.listActive(KEY);
    expect(active).toEqual([]);

    // --- Step 5: order — acceptance, then transcript append, then delivered ---
    // The row is marked `delivered` only after the transcript append succeeds,
    // and the append happens only after the backend accepts the live input.
    expect(callOrder).toEqual(["queueUserInput", "append", "markDelivered"]);

    // NOTE: "the agent response appears in the current turn" is produced by the
    // live Claude turn's external/virtual-turn machinery (the `input_accepted`
    // /`sendTurn` path, covered by tasks 3.2 and the Claude runtime suite). This
    // integration test owns the durable-queue + live-delivery-acceptance +
    // delivered-transition + single-transcript-append seam.
  });
});
