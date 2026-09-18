import { checkpointHandoffEligibilityFixture } from "@/lib/conversation-checkpoints/testing/receipt-fixture";
// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCheckpointMaintenanceHold } from "@/lib/conversation-checkpoints/maintenance-hold";
import { CHECKPOINT_RECENT_LIMIT } from "@/lib/conversation-checkpoints/queries";
import {
  checkpointKeys,
  type CheckpointTarget,
} from "@/lib/conversation-checkpoints/query-keys";
import type { CheckpointReceipt } from "@/lib/conversation-checkpoints/receipt";
import { checkpointReceiptFixture } from "@/lib/conversation-checkpoints/testing/receipt-fixture";

import { useConversationCheckpoint } from "./use-conversation-checkpoint";

const target: CheckpointTarget = {
  scope: "session",
  projectName: "p1",
  sessionName: "s1",
  conversationId: "c1",
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const fetchSpy = vi.fn<typeof fetch>();

interface Pages {
  /** The newest page, as the server answers it with no cursor. */
  head: { receipts: CheckpointReceipt[]; nextBefore: number | null };
  /** Cursored pages keyed by their `before` ordinal. */
  older: Record<
    number,
    { receipts: CheckpointReceipt[]; nextBefore: number | null }
  >;
}

function stubApi(pages: Pages) {
  fetchSpy.mockImplementation((input) => {
    const url = String(input);
    if (url.includes("/eligibility")) {
      return Promise.resolve(
        jsonResponse({
          eligible: true,
          refusals: [],
          active: null,
          hosted: true,
          handoff: checkpointHandoffEligibilityFixture(),
        }),
      );
    }
    const before = new URL(url, "http://localhost").searchParams.get("before");
    if (before !== null) {
      return Promise.resolve(
        jsonResponse(
          pages.older[Number(before)] ?? { receipts: [], nextBefore: null },
        ),
      );
    }
    return Promise.resolve(jsonResponse(pages.head));
  });
}

/** Both readers a host mounts: the panel's surface and the composer's hold. */
function useHost() {
  return {
    surface: useConversationCheckpoint(target),
    hold: useCheckpointMaintenanceHold(target, {
      limit: CHECKPOINT_RECENT_LIMIT,
    }),
  };
}

function renderHost() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = renderHook(() => useHost(), {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return { ...view, client };
}

function receipt(
  operationId: string,
  ordinal: number,
  phase: CheckpointReceipt["phase"],
  seq: number,
): CheckpointReceipt {
  return checkpointReceiptFixture({
    operationId,
    ordinal,
    phase,
    capturedThroughSeq: seq,
  });
}

describe("useConversationCheckpoint", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  // Reading history further back must not move the query the COMPOSER watches.
  // If paging swapped the active key, the newest page would stop being
  // refetched, and a build that started during a stream interruption would
  // reach the panel while the composer still sent directly into a refusal.
  it("keeps the composer's hold on the newest page after older history is read", async () => {
    stubApi({
      head: { receipts: [receipt("op-9", 9, "ready", 148)], nextBefore: 9 },
      older: {
        9: { receipts: [receipt("op-8", 8, "applied", 96)], nextBefore: null },
      },
    });
    const { result, client } = renderHost();
    await waitFor(() => expect(result.current.surface.recent).toHaveLength(1));

    act(() => result.current.surface.loadOlder());
    await waitFor(() => expect(result.current.surface.recent).toHaveLength(2));
    expect(result.current.hold).toBe(false);

    // A checkpoint starts while the panel is paged back, and the client
    // recovers it the way a reconnect does: by re-reading the index.
    stubApi({
      head: {
        receipts: [receipt("op-10", 10, "building", 148)],
        nextBefore: 9,
      },
      older: {
        9: { receipts: [receipt("op-8", 8, "applied", 96)], nextBefore: null },
      },
    });
    await act(async () => {
      await client.invalidateQueries({ queryKey: checkpointKeys.all });
    });

    await waitFor(() => expect(result.current.hold).toBe(true));
    expect(result.current.surface.latest?.operationId).toBe("op-10");
  });

  // The server caps one page at 100 receipts. A conversation with more saved
  // operations than that still has them, and `nextBefore` says so — hiding the
  // control at the cap would make the oldest checkpoints unreachable.
  it("keeps reading further back past the server's page cap", async () => {
    const page = (start: number, count: number) =>
      Array.from({ length: count }, (_, index) =>
        receipt(`op-${start - index}`, start - index, "applied", start - index),
      );
    stubApi({
      head: { receipts: page(120, 5), nextBefore: 116 },
      older: {
        116: { receipts: page(115, 5), nextBefore: 111 },
        111: { receipts: page(110, 5), nextBefore: null },
      },
    });
    const { result } = renderHost();
    await waitFor(() => expect(result.current.surface.recent).toHaveLength(5));
    expect(result.current.surface.hasOlder).toBe(true);

    act(() => result.current.surface.loadOlder());
    await waitFor(() => expect(result.current.surface.recent).toHaveLength(10));
    expect(result.current.surface.hasOlder).toBe(true);

    act(() => result.current.surface.loadOlder());
    await waitFor(() => expect(result.current.surface.recent).toHaveLength(15));
    // The last page said there is nothing older, and only then does the
    // control disappear.
    expect(result.current.surface.hasOlder).toBe(false);
  });
});

/**
 * A paging server: the newest `limit` rows with no cursor, and the next
 * `limit` rows strictly below a `before` ordinal. Serving from one ordered
 * index means the pages MOVE when the index grows, which is exactly the
 * condition the cursor chain has to survive.
 */
function stubIndex(all: () => CheckpointReceipt[]) {
  fetchSpy.mockImplementation((input) => {
    const url = String(input);
    if (url.includes("/eligibility")) {
      return Promise.resolve(
        jsonResponse({
          eligible: true,
          refusals: [],
          active: null,
          hosted: true,
          handoff: checkpointHandoffEligibilityFixture(),
        }),
      );
    }
    const params = new URL(url, "http://localhost").searchParams;
    const before = params.get("before");
    const descending = [...all()].sort((a, b) => b.ordinal - a.ordinal);
    const window =
      before === null
        ? descending
        : descending.filter((r) => r.ordinal < Number(before));
    const receipts = window.slice(0, CHECKPOINT_RECENT_LIMIT);
    const last = receipts[receipts.length - 1];
    const more = last !== undefined && window.length > receipts.length;
    return Promise.resolve(
      jsonResponse({
        receipts,
        nextBefore: more ? (last?.ordinal ?? null) : null,
      }),
    );
  });
}

describe("history paging stays continuous", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("loses no row when a new operation arrives after paging", async () => {
    const index = Array.from({ length: 10 }, (_, i) =>
      receipt(`op-${i + 1}`, i + 1, "applied", (i + 1) * 10),
    );
    stubIndex(() => index);
    const { result, client } = renderHost();

    await waitFor(() =>
      expect(result.current.surface.recent).toHaveLength(
        CHECKPOINT_RECENT_LIMIT,
      ),
    );
    act(() => result.current.surface.loadOlder());
    await waitFor(() => expect(result.current.surface.recent).toHaveLength(10));

    // A new checkpoint is admitted. The head page slides, evicting its own
    // oldest row into the window the first cursor covers.
    index.push(receipt("op-11", 11, "building", 110));
    await act(async () => {
      await client.invalidateQueries({
        queryKey: checkpointKeys.lists(target),
      });
    });

    await waitFor(() =>
      expect(result.current.surface.recent[0]?.operationId).toBe("op-11"),
    );
    // Every ordinal from 11 down to the oldest loaded one is still present:
    // a fixed cursor would have left a hole where the head used to end.
    const ordinals = result.current.surface.recent.map((r) => r.ordinal);
    expect(ordinals).toEqual([...ordinals].sort((a, b) => b - a));
    const lowest = ordinals[ordinals.length - 1] ?? 0;
    for (let ordinal = 11; ordinal >= lowest; ordinal -= 1) {
      expect(ordinals).toContain(ordinal);
    }
  });

  it("starts paging over for a different conversation", async () => {
    const first = Array.from({ length: 10 }, (_, i) =>
      receipt(`a-${i + 1}`, i + 1, "applied", (i + 1) * 10),
    );
    const second = Array.from({ length: 3 }, (_, i) =>
      receipt(`b-${i + 1}`, i + 101, "applied", (i + 1) * 10),
    );
    let current = first;
    stubIndex(() => current);

    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const view = renderHook(
      ({ conversationId }: { conversationId: string }) =>
        useConversationCheckpoint({ ...target, conversationId }),
      {
        initialProps: { conversationId: "c1" },
        wrapper: ({ children }: { children: React.ReactNode }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );

    await waitFor(() =>
      expect(view.result.current.recent).toHaveLength(CHECKPOINT_RECENT_LIMIT),
    );
    act(() => view.result.current.loadOlder());
    await waitFor(() => expect(view.result.current.recent).toHaveLength(10));

    current = second;
    view.rerender({ conversationId: "c2" });

    await waitFor(() =>
      expect(view.result.current.recent.map((r) => r.operationId)).toEqual([
        "b-3",
        "b-2",
        "b-1",
      ]),
    );
    // The new conversation is three operations long; a retained cursor from
    // the previous one would claim more history than it has.
    expect(view.result.current.hasOlder).toBe(false);
  });
});

describe("explicit handoff controls", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
  it.each(["tool-disabled", "instruction-only", null] as const)(
    "submits the explicitly bound mode %s",
    async (mode) => {
      stubApi({ head: { receipts: [], nextBefore: null }, older: {} });
      const view = renderHost();
      await waitFor(() =>
        expect(view.result.current.surface.isLoading).toBe(false),
      );
      expect(view.result.current.surface.handoff?.mode).toBe("tool-disabled");
      act(() => view.result.current.surface.startHandoff(mode));
      await waitFor(() =>
        expect(
          fetchSpy.mock.calls.some(
            ([, init]) =>
              init?.method === "POST" &&
              JSON.parse(String(init.body)).handoff?.mode === mode,
          ),
        ).toBe(true),
      );
    },
  );
  it("keeps the baseline request capture-free and exposes distinct skip and acknowledgement actions", async () => {
    stubApi({ head: { receipts: [], nextBefore: null }, older: {} });
    const view = renderHost();
    await waitFor(() =>
      expect(view.result.current.surface.isLoading).toBe(false),
    );
    act(() => view.result.current.surface.start());
    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.some(([, init]) => init?.method === "POST"),
      ).toBe(true),
    );
    const first = fetchSpy.mock.calls.find(
      ([, init]) => init?.method === "POST",
    );
    expect(JSON.parse(String(first?.[1]?.body))).not.toHaveProperty("handoff");
    act(() => view.result.current.surface.skipHandoff("operation-1"));
    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.some(([url]) =>
          String(url).endsWith("/operation-1/skip-handoff"),
        ),
      ).toBe(true),
    );
    act(() =>
      view.result.current.surface.acknowledgeCaptureStopped("operation-1"),
    );
    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith("/operation-1/reconcile") &&
            JSON.parse(String(init?.body)).captureExecutionStopped === true,
        ),
      ).toBe(true),
    );
  });
});
