// @vitest-environment jsdom
//
// Task 7.3 — composed INTEGRATION tests for the queue failure and cancellation
// flow. Two scenarios, both wiring REAL production modules and faking only at
// genuine I/O boundaries:
//
//  A) Client queue failure (req 5.1, 5.2, 5.3): the REAL `useSendPrompt` hook
//     over the REAL `useSessionDetailStore`, mocking only `fetch`. A failed
//     enqueue must roll back ONLY the failed optimistic entry, surface the
//     error, and leave the running indicator running.
//
//  B) Cancellation excludes the entry from the next drained turn (req 9.1, 9.2,
//     9.3): the REAL `messageQueueService` over an in-memory running
//     `ConversationState`, faking only the state-store mutate boundary. A
//     cancelled entry disappears and never appears in the next coalesced turn;
//     an already-delivering entry cannot be cancelled.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type PropsWithChildren } from "react";

// Logging is module-load-time infrastructure; mocking it is the sanctioned
// exception (CLAUDE.md / engineering-principles). The queue service calls
// `createLogger` at module load, so a single mock keeps the seam under test
// free of a real log sink.
vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

import { useSendPrompt } from "@/hooks/use-send-prompt";
import { useSessionDetailStore } from "@/stores/session-detail.store";

import type { ConversationState } from "@/lib/conversations/schemas";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import type { MessageContentBlock } from "@/lib/conversations/message-content-schemas";
import type { SSEEvent } from "@/lib/api/sse-events";

import {
  createMessageQueueService,
  type MessageQueueServiceDeps,
} from "./message-queue-service";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const NOW = "2026-06-08T12:00:00.000Z";

function textBlock(text: string): MessageContentBlock {
  return { type: "text", text };
}

// ---------------------------------------------------------------------------
// Scenario A — client queue failure (req 5.1, 5.2, 5.3)
// ---------------------------------------------------------------------------

const PROJECT = "proj";
const SESSION = "sess";
const CONVERSATION = "conv-1";

function wrapperFor(queryClient: QueryClient) {
  // `createElement` (not JSX) keeps this hook-composing test in the required
  // `.integration.test.ts` filename, which the bundler does not transform JSX in.
  return function Wrapper({ children }: PropsWithChildren) {
    return createElement(
      QueryClientProvider,
      { client: queryClient },
      children,
    );
  };
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderQueueHook() {
  return renderHook(() => useSendPrompt(PROJECT, SESSION, CONVERSATION), {
    wrapper: wrapperFor(makeQueryClient()),
  });
}

/** Put the store into a "running turn" state so queue() will proceed. */
function startRunningTurn() {
  act(() => {
    useSessionDetailStore.getState().submitPrompt([textBlock("turn")], 0);
  });
  expect(useSessionDetailStore.getState().sending).toBe(true);
}

describe("Task 7.3 Scenario A — client queue failure (real hook + real store)", () => {
  beforeEach(() => {
    useSessionDetailStore.getState().resetStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rolls back only the failed item, surfaces the error, and keeps sending running", async () => {
    startRunningTurn();

    // First queue POST succeeds (the survivor); the second is forced to FAIL
    // at the transport boundary — the only fake in this scenario.
    let call = 0;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        call += 1;
        if (call === 1) {
          return jsonResponse(200, {
            queued: true,
            message: {
              id: "srv-survivor",
              content: [textBlock("keep")],
              status: "pending",
              enqueuedAt: NOW,
              updatedAt: NOW,
              deliveredAt: null,
              cancelledAt: null,
              failedAt: null,
              error: null,
            },
            deliveryTiming: "next_turn",
          });
        }
        throw new TypeError("network down");
      });

    const { result } = renderQueueHook();

    // Queue a message that succeeds, then one that fails.
    await act(async () => {
      await result.current.queue("keep");
    });
    await act(async () => {
      await result.current.queue("oops");
    });

    const after = useSessionDetailStore.getState();

    // Rollback removes ONLY the failed item: the accepted survivor remains.
    expect(after.optimisticQueue).toHaveLength(1);
    const [survivor] = after.optimisticQueue;
    expect(survivor?.queueId).toBe("srv-survivor");
    expect(survivor?.status).toBe("accepted");

    // The error is surfaced via setQueueError (req 5.1).
    expect(after.promptError).not.toBeNull();

    // The running indicator stays running — the queue path never touches
    // `sending` (req 5.2). failPrompt/completePrompt were not used here.
    expect(after.sending).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a single failed enqueue removes the entry, surfaces the error, and preserves running", async () => {
    startRunningTurn();

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("network down"));

    const { result } = renderQueueHook();

    await act(async () => {
      await result.current.queue("oops");
    });

    const after = useSessionDetailStore.getState();
    // The optimistic queue entry was rolled back (removed) — req 5.3.
    expect(after.optimisticQueue).toHaveLength(0);
    // The error is surfaced — req 5.1.
    expect(after.promptError).not.toBeNull();
    // The running indicator stays running — req 5.2.
    expect(after.sending).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Scenario B — cancellation excludes the entry from the next drained turn
// (req 9.1, 9.2, 9.3)
// ---------------------------------------------------------------------------

const KEY = {
  projectPath: "/repos/my-project",
  sessionName: "csm/feature",
  conversationId: "conv-1",
} as const;

/**
 * A running conversation with an empty durable queue, built through the real
 * `conversationStateSchema` so `pendingQueue` defaults correctly and the
 * service exercises real persistence semantics (no hand-rolled shape).
 */
function makeRunningConversation(): ConversationState {
  return conversationStateSchema.parse({
    id: "conv-1",
    transcriptPath: null,
    status: "running",
    role: null,
    agentBackend: "codex",
    promptCount: 0,
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
 * enqueue/claim/cancel transform under test is the production transform, not a
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

describe("Task 7.3 Scenario B — cancellation excludes the entry from the next turn (real service)", () => {
  it("cancels a pending entry, removes it from active, and excludes it from the next coalesced turn", async () => {
    const store: FakeStore = { conversation: makeRunningConversation() };
    const { deps } = makeQueueDeps(store);
    const service = createMessageQueueService(deps);

    // --- Step 1: enqueue TWO messages A and B → both pending ---
    const a = await service.enqueue({ ...KEY, content: [textBlock("A")] });
    const b = await service.enqueue({ ...KEY, content: [textBlock("B")] });

    const activeAfterEnqueue = await service.listActive(KEY);
    expect(activeAfterEnqueue.map((e) => e.id)).toEqual([a.id, b.id]);
    expect(activeAfterEnqueue.map((e) => e.status)).toEqual([
      "pending",
      "pending",
    ]);

    // --- Step 2: cancel A (req 9.1, 9.2) ---
    const cancelResult = await service.cancel({ ...KEY, id: a.id });
    expect(cancelResult).toBe("cancelled");

    // A disappears from the active (pending/delivering) view.
    const activeAfterCancel = await service.listActive(KEY);
    expect(activeAfterCancel.map((e) => e.id)).toEqual([b.id]);

    // A's row is pruned on cancel (terminal entries are not retained); B is
    // still `pending`.
    const rowsAfterCancel = store.conversation?.pendingQueue ?? [];
    expect(rowsAfterCancel.find((r) => r.id === a.id)).toBeUndefined();
    expect(rowsAfterCancel.find((r) => r.id === b.id)?.status).toBe("pending");

    // --- Step 3: drain the next turn — only B is delivered (req 9.2) ---
    const batch = await service.claimNextTurnBatch(KEY);
    expect(batch).not.toBeNull();
    if (!batch) throw new Error("expected a claimed batch");

    // The cancelled A is EXCLUDED from the next drained turn: only B's id is
    // claimed, and the coalesced content is only B's content.
    expect(batch.messageIds).toEqual([b.id]);
    expect(batch.content).toEqual([textBlock("B")]);

    // A never appears in the next turn: it stays cancelled, only B went
    // delivering under the claim.
    const rowsAfterClaim = store.conversation?.pendingQueue ?? [];
    // A was pruned on cancel and never reappears; only B went delivering.
    expect(rowsAfterClaim.find((r) => r.id === a.id)).toBeUndefined();
    expect(rowsAfterClaim.find((r) => r.id === b.id)?.status).toBe(
      "delivering",
    );
  });

  it("cannot cancel an already-delivering entry — returns not_cancellable (req 9.3)", async () => {
    const store: FakeStore = { conversation: makeRunningConversation() };
    const { deps } = makeQueueDeps(store);
    const service = createMessageQueueService(deps);

    const a = await service.enqueue({ ...KEY, content: [textBlock("A")] });
    const b = await service.enqueue({ ...KEY, content: [textBlock("B")] });

    // Cancel A so it is excluded, then claim the next turn — B becomes
    // `delivering`.
    expect(await service.cancel({ ...KEY, id: a.id })).toBe("cancelled");
    const batch = await service.claimNextTurnBatch(KEY);
    expect(batch?.messageIds).toEqual([b.id]);

    // B is now `delivering`; it can no longer be cancelled (delivery may
    // already be visible to the agent) — req 9.3.
    const cancelB = await service.cancel({ ...KEY, id: b.id });
    expect(cancelB).toBe("not_cancellable");

    // A was pruned on cancel, so re-cancelling it now returns `not_found` (the
    // terminal entry is no longer retained).
    const recancelA = await service.cancel({ ...KEY, id: a.id });
    expect(recancelA).toBe("not_found");

    // B remains `delivering` — the failed cancel did not mutate its status.
    const bRow = store.conversation?.pendingQueue.find((r) => r.id === b.id);
    expect(bRow?.status).toBe("delivering");
  });
});
