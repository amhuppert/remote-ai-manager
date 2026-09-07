import { targetFromStoreSessionName } from "@/lib/conversations/conversation-target";
import { createQueueAdmissionFixture } from "@/lib/workflows/conversation/testing/queue-admission-fixture";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

// Logging is module-load-time infrastructure; mocking it is the sanctioned
// exception (CLAUDE.md / engineering-principles). Both the queue service and the
// conversation manager call `createLogger` at module load, so a single mock
// keeps the seam under test free of a real log sink.
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
import type { MessageContentBlock } from "@/lib/conversations/message-content-schemas";
import type { SSEEvent } from "@/lib/api/sse-events";

import {
  createMessageQueueService,
  type MessageQueueService,
  type MessageQueueServiceDeps,
} from "./message-queue-service";

import {
  drainConversationQueue,
  queuedBatchToSubmitPrompt,
  type ConversationQueueDeps,
} from "./message-queue-drain";
import {
  setConversationProfileAdmissionDeps,
  _resetConversationProfileAdmissionDepsForTesting,
} from "./profile-admission";
import type { ConversationContext } from "@/lib/workflows/conversation/types";
import type { ConversationEvent } from "@/lib/workflows/conversation/types";

const NOW = "2026-06-07T12:00:00.000Z";

// The drain settles the conversation's agent profile before it sends. These
// cases are about coalescing, not profiles, so the seam answers as a legacy
// conversation would — no profile, no lock, no write.
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

const KEY = {
  projectPath: "/repos/my-project",
  sessionName: "csm/feature",
  conversationId: "conv-1",
} as const;

function textBlock(text: string): MessageContentBlock {
  return { type: "text", text };
}

/**
 * A running Codex conversation with an empty durable queue, built through the
 * real stored schema (via the shared factory) so `pendingQueue` defaults
 * correctly and the service exercises real persistence semantics (no
 * hand-rolled shape).
 */
function makeRunningConversation(): ConversationState {
  return makeConversationState({
    status: "running",
    agentBackend: "codex",
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
 * enqueue/claim/mark transform under test is the production transform, not a
 * mock of it.
 */
function makeQueueDeps(store: FakeStore): {
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
 * Drain deps wired to the SAME real service instance — the drain therefore runs
 * the real `claimNextTurnBatch` (coalesce + claim) against the same in-memory
 * queue the enqueues mutated. Only the actor `self` is faked, at the genuine
 * actor-dispatch I/O boundary.
 */
function makeDrainDeps(
  service: MessageQueueService,
  dispatched: ConversationEvent[],
): ConversationQueueDeps {
  return {
    submitTurn: createQueueAdmissionFixture((input) => {
      if (input.turn.kind === "task_run")
        throw new Error("Expected queued conversation turn");
      dispatched.push({
        ...input.turn,
        type: "SUBMIT_PROMPT",
        streamId: input.transport?.streamId ?? null,
      });
    }),
    claimNextTurnBatch: (input) => service.claimNextTurnBatch(input),
    markPending: (input) => service.markPending(input),
    markDelivered: (input) => service.markDelivered(input),
    markFailed: (input) => service.markFailed(input),
    recoverAbandonedDeliveries: (input) =>
      service.recoverAbandonedDeliveries(input),
    runConversationCommand: async () => {
      throw new Error("not used in coalescing tests");
    },
  };
}

const DRAIN_CONTEXT: Pick<ConversationContext, "projectPath" | "target"> = {
  projectPath: KEY.projectPath,
  target: targetFromStoreSessionName(
    "my-project",
    KEY.sessionName,
    KEY.conversationId,
  ),
};

describe("Codex next-turn coalescing flow (integration)", () => {
  it("queues two messages, drains exactly one coalesced turn, and clears the pending entries on delivery", async () => {
    // Compose the REAL queue service over an in-memory running Codex
    // conversation, and the REAL drain over the same service instance.
    const store: FakeStore = { conversation: makeRunningConversation() };
    const { deps, broadcasts } = makeQueueDeps(store);
    const service = createMessageQueueService(deps);
    const dispatched: ConversationEvent[] = [];
    const drainDeps = makeDrainDeps(service, dispatched);

    // --- Step 1: two messages queued during a running Codex turn (req 1.3) ---
    const first = await service.enqueue({
      ...KEY,
      content: [textBlock("first")],
    });
    const second = await service.enqueue({
      ...KEY,
      content: [textBlock("second")],
    });

    const activeAfterEnqueue = await service.listActive(KEY);
    // Both display as pending, in enqueue order.
    expect(activeAfterEnqueue.map((e) => e.id)).toEqual([first.id, second.id]);
    expect(activeAfterEnqueue.map((e) => e.status)).toEqual([
      "pending",
      "pending",
    ]);

    // --- Step 2: turn finishes → drain runs (req 2.2, 2.3, 3.1, 3.2) ---
    await drainConversationQueue(DRAIN_CONTEXT, drainDeps);

    // Exactly ONE next turn started.
    expect(dispatched).toHaveLength(1);
    const event = dispatched[0];
    expect(event?.type).toBe("SUBMIT_PROMPT");
    if (event?.type !== "SUBMIT_PROMPT") {
      throw new Error("expected SUBMIT_PROMPT");
    }

    // The single turn coalesces both messages under ONE delivery attempt id,
    // preserving enqueue order (req 3.1, 3.2).
    expect(event.queuedDelivery).toBeDefined();
    expect(event.queuedDelivery?.messageIds).toEqual([first.id, second.id]);
    const deliveryAttemptId = event.queuedDelivery?.deliveryAttemptId;
    expect(deliveryAttemptId).toBeTruthy();

    // The coalesced prompt is the order-preserving join of "first" then
    // "second" — exactly what queuedBatchToSubmitPrompt produces (req 3.1).
    expect(event.promptText).toBe("first\nsecond");
    expect(event.promptText).toBe(
      queuedBatchToSubmitPrompt([textBlock("first"), textBlock("second")])
        .promptText,
    );
    // Text-only batch carries no images.
    expect(event.images).toBeUndefined();

    // Both queue rows are now delivering under that one attempt id.
    const claimedRows = store.conversation?.pendingQueue ?? [];
    expect(claimedRows.map((r) => r.status)).toEqual([
      "delivering",
      "delivering",
    ]);
    expect(
      claimedRows.every((r) => r.deliveryAttemptId === deliveryAttemptId),
    ).toBe(true);
    // They are still active (delivering) until acceptance is confirmed.
    const activeWhileDelivering = await service.listActive(KEY);
    expect(activeWhileDelivering.map((e) => e.id)).toEqual([
      first.id,
      second.id,
    ]);

    // --- Step 3: delivery confirmed → pending entries disappear (req 7.3) ---
    if (!deliveryAttemptId) throw new Error("missing deliveryAttemptId");
    await service.markDelivered({
      ...KEY,
      ids: [first.id, second.id],
      deliveryAttemptId,
    });

    const activeAfterDelivered = await service.listActive(KEY);
    // No leftover pending entries.
    expect(activeAfterDelivered).toEqual([]);
    // Delivered entries are pruned from the persisted queue.
    expect(store.conversation?.pendingQueue).toEqual([]);

    // --- Step 4: exactly ONE coalesced payload was produced for the turn ---
    // The single SUBMIT_PROMPT carried one coalesced prompt; there was no
    // second dispatch (no two separate turns).
    const submitPrompts = dispatched.filter((e) => e.type === "SUBMIT_PROMPT");
    expect(submitPrompts).toHaveLength(1);

    // Exactly one claim happened: one delivering broadcast per row, all sharing
    // the single delivery attempt id (no second next-turn claim).
    const claimUpdates = broadcasts.filter(
      (e) =>
        e.type === "message-queue-updated" && e.message.status === "delivering",
    );
    expect(claimUpdates).toHaveLength(2);

    // The one coalesced user TRANSCRIPT entry written after backend acceptance
    // is covered by task 4.3's actor test (actor-implementations.test.ts:
    // "queued delivery appends exactly one user transcript entry after backend
    // acceptance"); this test owns the coalescing + single-turn + pending-cleared
    // seam rather than re-wiring executePromptForMachine.
  });
});
