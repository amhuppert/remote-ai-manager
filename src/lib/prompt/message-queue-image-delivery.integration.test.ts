// @vitest-environment jsdom
//
// Task 7.4 — composed INTEGRATION tests for the queued IMAGE delivery flow. Two
// scenarios, both wiring REAL production modules and faking only at genuine I/O
// boundaries:
//
//  A) Queued image is delivered with its text in one turn (req 8.1, 8.2). The
//     REAL `queueMessage` over the REAL `messageQueueService` (in-memory running
//     CLAUDE `ConversationState`), faking the Claude runtime, the transcript
//     writer, and image persistence. The durable pending row carries BOTH the
//     text and the image; live delivery hands the image (base64) to the running
//     session alongside the text; the appended transcript persists image refs,
//     not base64; the row reaches `delivered`.
//
//  B) Image-queue failure surfaces instead of silently dropping (req 8.3). The
//     REAL `useSendPrompt` hook over the REAL `useSessionDetailStore`, mocking
//     only `fetch`. A failed enqueue rolls back the optimistic image entry but
//     SURFACES the error (the user is informed; the images are not silently
//     dropped), keeps `sending` running, and the attempted POST body carried the
//     images (they were forwarded, then the failure surfaced).
//
// jsdom is required for Scenario B's React hook + `crypto.randomUUID`. The file
// stays `.integration.test.ts`; the provider wrapper uses `createElement`, not
// JSX, because the bundler does not transform JSX in a `.ts` file.

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

import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type PropsWithChildren } from "react";

import type { ConversationState } from "@/lib/conversations/schemas";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import type { SSEEvent } from "@/lib/api/sse-events";
import type { TranscriptEntry } from "@/lib/prompt/transcript";
import type {
  ConversationBackendRuntime,
  ConversationQueuedUserInput,
} from "@/lib/agent-backends/conversation";
import {
  backendCapabilities,
  queueCapabilityForBackend,
} from "@/lib/agent-backends/capabilities-descriptor";
import { imagePayloadSchema, type ImagePayload } from "@/lib/images/schemas";

import {
  createMessageQueueService,
  type MessageQueueServiceDeps,
} from "@/lib/conversations/message-queue-service";

import { useSendPrompt } from "@/hooks/use-send-prompt";
import { useSessionDetailStore } from "@/stores/session-detail.store";

import { queueMessage, type QueueMessageDeps } from "./queue";

const NOW = "2026-06-08T10:00:00.000Z";

const KEY = {
  projectPath: "/repos/my-project",
  sessionName: "csm/feature",
  conversationId: "conv-1",
} as const;

/** A real, schema-valid image attachment (per `imagePayloadSchema`). */
const IMAGE: ImagePayload = imagePayloadSchema.parse({
  attachmentId: "att-1",
  mediaType: "image/png",
  base64Data: "aW1hZ2UtYnl0ZXM=",
});

// ---------------------------------------------------------------------------
// Scenario A helpers — real queueMessage + real service + in-memory store
// ---------------------------------------------------------------------------

/**
 * A running CLAUDE conversation with an empty durable queue, built through the
 * real `conversationStateSchema` so `pendingQueue` defaults correctly and the
 * service exercises real persistence semantics (no hand-rolled shape).
 */
function makeRunningClaudeConversation(): ConversationState {
  return conversationStateSchema.parse({
    id: "conv-1",
    transcriptPath: null,
    status: "running",
    role: null,
    agentBackend: "claude",
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
    capabilities: backendCapabilities("claude"),
    modelId: undefined,
    reasoningEffort: undefined,
    outputFormat: undefined,
    sendTurn: vi.fn(async () => {
      throw new Error("sendTurn must not run in the live in-turn path");
    }),
    queueUserInput: vi.fn(async (input: ConversationQueuedUserInput) => {
      callOrder.push("queueUserInput");
      received.push(input);
    }),
    close: vi.fn(() => {}),
  };
  return { runtime, received, callOrder };
}

describe("Task 7.4 Scenario A — queued image delivered with its text in one turn (req 8.1, 8.2)", () => {
  it("queues image+text, persists image refs (not base64) in transcript, and delivers the image base64 to the live session", async () => {
    // --- Compose the REAL queue service over an in-memory running Claude
    //     conversation, and the REAL queueMessage over that same service.
    const store: FakeStore = { conversation: makeRunningClaudeConversation() };
    const { deps: serviceDeps, broadcasts } = makeQueueServiceDeps(store);
    const service = createMessageQueueService(serviceDeps);

    const { runtime, received, callOrder } = makeAcceptingClaudeRuntime();

    // Capture transcript appends + image persistence at their I/O boundaries.
    const appendedEntries: TranscriptEntry[] = [];
    const persistedImages: Array<{
      conversationId: string;
      index: number;
      mediaType: string;
      base64Data: string;
    }> = [];
    const PERSISTED_PATH = "/repos/my-project/.cc/images/conv-1/0.png";

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
      // Image persistence at its I/O boundary: a fake start index and a fake
      // on-disk path. This is the "existing image handling" persistence path.
      getNextImageIndex: async () => 0,
      saveTranscriptImage: async (
        conversationId,
        index,
        mediaType,
        base64Data,
      ) => {
        callOrder.push("saveTranscriptImage");
        persistedImages.push({ conversationId, index, mediaType, base64Data });
        return PERSISTED_PATH;
      },
    };

    // --- Queue a message that includes an image during the running turn ---
    const result = await queueMessage({
      ...KEY,
      text: "look at this",
      images: [IMAGE],
      backend: "claude",
      deps: queueDeps,
    });

    // --- 1. Image queued WITH text (req 8.1) ---
    // The durable pending row's content carried BOTH a text block and an image
    // block (with base64) — confirmed via the message-queued event the enqueue
    // produced (published while the row was still `pending`).
    const queuedEvent = broadcasts.find((e) => e.type === "message-queued");
    expect(queuedEvent).toBeDefined();
    if (!queuedEvent || queuedEvent.type !== "message-queued") {
      throw new Error("expected a message-queued event");
    }
    // The event's queued-message projection (optional on the schema) must be
    // present — enqueue always populates it.
    const queuedView = queuedEvent.message;
    expect(queuedView).toBeDefined();
    if (!queuedView) throw new Error("expected a queued-message view");
    expect(queuedView.content).toEqual([
      { type: "text", text: "look at this" },
      {
        type: "image",
        mediaType: "image/png",
        base64Data: IMAGE.base64Data,
      },
    ]);

    // --- 2. Pending display: the row was `pending` at enqueue, before live
    //     delivery claimed it (the message-queued event carries the pending
    //     projection, and the enqueue return is pending).
    expect(result.entry.status).toBe("pending");
    expect(queuedView.status).toBe("pending");
    expect(result.deliveryTiming).toBe("in_turn");

    // --- 3. Image delivered through existing handling (req 8.2) ---
    // The live session received content that INCLUDES the image block carrying
    // the base64 data, alongside the text — the in-turn delivery path.
    const queueUserInput = runtime.queueUserInput;
    expect(queueUserInput).toBeDefined();
    if (!queueUserInput) throw new Error("expected a live queueUserInput");
    expect(queueUserInput).toHaveBeenCalledTimes(1);
    expect(received).toHaveLength(1);
    expect(received[0]?.content).toEqual([
      { type: "text", text: "look at this" },
      {
        type: "image",
        mediaType: "image/png",
        base64Data: IMAGE.base64Data,
      },
    ]);

    // --- 4. Transcript persists image refs, NOT base64 (req 8.2) ---
    // saveTranscriptImage was invoked for the image (persisted to disk).
    expect(persistedImages).toEqual([
      {
        conversationId: "conv-1",
        index: 0,
        mediaType: "image/png",
        base64Data: IMAGE.base64Data,
      },
    ]);

    // Exactly one transcript entry was appended, after acceptance.
    expect(appendedEntries).toHaveLength(1);
    const delivered = appendedEntries[0];
    expect(delivered?.type).toBe("user");
    expect(delivered?.role).toBe("user");

    // The appended entry uses image_ref/image_marker blocks (from
    // buildUserTranscriptBlocks) referencing the persisted path, NOT raw base64.
    expect(delivered?.content).toEqual([
      { type: "text", text: "look at this" },
      {
        type: "image_marker",
        index: 0,
        mediaType: "image/png",
        imagePath: PERSISTED_PATH,
      },
      {
        type: "image_ref",
        mediaType: "image/png",
        imagePath: PERSISTED_PATH,
      },
    ]);
    // The raw base64 never lands in the JSONL transcript entry.
    const serializedEntry = JSON.stringify(delivered);
    expect(serializedEntry).not.toContain(IMAGE.base64Data);

    // The queue row reached `delivered`, only after the append succeeded.
    const finalRow = store.conversation?.pendingQueue.find(
      (r) => r.id === result.entry.id,
    );
    expect(finalRow?.status).toBe("delivered");

    // listActive is now empty — the delivered entry is no longer pending.
    const active = await service.listActive(KEY);
    expect(active).toEqual([]);

    // Order: live acceptance, then image persisted, then transcript append,
    // then the row is marked delivered.
    expect(callOrder).toEqual([
      "queueUserInput",
      "saveTranscriptImage",
      "append",
      "markDelivered",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Scenario B helpers — real hook + real store + fetch mock
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

function renderQueueHook() {
  return renderHook(() => useSendPrompt(PROJECT, SESSION, CONVERSATION), {
    wrapper: wrapperFor(makeQueryClient()),
  });
}

/** Put the store into a "running turn" state so queue() will proceed. */
function startRunningTurn() {
  act(() => {
    useSessionDetailStore
      .getState()
      .submitPrompt([{ type: "text", text: "turn" }], 0);
  });
  expect(useSessionDetailStore.getState().sending).toBe(true);
}

describe("Task 7.4 Scenario B — image-queue failure surfaces instead of silently dropping (req 8.3)", () => {
  beforeEach(() => {
    useSessionDetailStore.getState().resetStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards the images then, on enqueue failure, rolls back the entry, surfaces the error, and keeps sending running", async () => {
    startRunningTurn();

    // Capture the attempted POST body, then FAIL the enqueue at the transport
    // boundary — the only fake in this scenario.
    const bodies: unknown[] = [];
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => {
        bodies.push(
          init?.body ? (JSON.parse(init.body as string) as unknown) : undefined,
        );
        throw new TypeError("network down");
      });

    const { result } = renderQueueHook();

    await act(async () => {
      await result.current.queue("with image", [IMAGE]);
    });

    const after = useSessionDetailStore.getState();

    // The optimistic image entry was rolled back (removed) — the failed item is
    // not left displayed as queued.
    expect(after.optimisticQueue).toHaveLength(0);

    // The failure SURFACED: the user is informed via promptError. The images
    // are NOT silently dropped (req 8.3).
    expect(after.promptError).not.toBeNull();

    // The running indicator stays running — the queue path never touches
    // `sending` (req 5.2 preserved on the image failure path).
    expect(after.sending).toBe(true);

    // The images were forwarded in the attempted POST body BEFORE the failure
    // surfaced — they were sent, not dropped before sending (req 8.3).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodies).toHaveLength(1);
    const body = bodies[0] as { text?: string; images?: ImagePayload[] };
    expect(body.text).toBe("with image");
    expect(body.images).toEqual([IMAGE]);
  });
});
