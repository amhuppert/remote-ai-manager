// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PropsWithChildren } from "react";

import { useSendPrompt } from "./use-send-prompt";
import {
  selectInFlightFor,
  useSessionDetailStore,
} from "@/stores/session-detail.store";
import type { MessageContentBlock } from "@/lib/conversations/schemas";
import type { ImagePayload } from "@/lib/images/schemas";

function wrapperFor(queryClient: QueryClient) {
  return function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
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

function textBlock(text: string): MessageContentBlock[] {
  return [{ type: "text", text }];
}

const PROJECT = "proj";
const SESSION = "sess";
const CONVERSATION = "conv-1";

function renderQueueHook() {
  return renderHook(() => useSendPrompt(PROJECT, SESSION, CONVERSATION), {
    wrapper: wrapperFor(makeQueryClient()),
  });
}

/** Read the test conversation's keyed in-flight state off the store. */
function inFlight() {
  return selectInFlightFor(useSessionDetailStore.getState(), CONVERSATION);
}

/** Put the store into a "running turn" state so queue() will proceed. */
function startRunningTurn() {
  act(() => {
    useSessionDetailStore
      .getState()
      .submitPrompt(CONVERSATION, textBlock("turn"), 0);
  });
  expect(inFlight().sending).toBe(true);
}

beforeEach(() => {
  useSessionDetailStore.getState().resetStore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useSendPrompt — send()", () => {
  it("stamps the optimistic user and streaming assistant rows with the turn's model/effort", async () => {
    const sse =
      'event: content\ndata: {"type":"text","text":"partial answer"}\n\n' +
      "event: done\ndata: {}\n\n";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(sse, { status: 200 }),
    );

    const { result } = renderQueueHook();

    await act(async () => {
      await result.current.send("hi", 0, "fable", undefined, "max", "claude");
    });

    const messages = inFlight().optimisticMessages;
    expect(messages[0]).toMatchObject({
      role: "user",
      model: "fable",
      effort: "max",
    });
    expect(messages[1]).toMatchObject({
      role: "assistant",
      model: "fable",
      effort: "max",
    });
  });
});

describe("useSendPrompt — queue()", () => {
  it("queue failure removes only the failed item and leaves sending running (THE OBSERVABLE)", async () => {
    startRunningTurn();

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("network down"));

    const { result } = renderQueueHook();

    await act(async () => {
      await result.current.queue("hi");
    });

    const after = inFlight();
    // The optimistic entry was rolled back.
    expect(after.optimisticQueue).toHaveLength(0);
    // The running indicator stays running (req 5.2).
    expect(after.sending).toBe(true);
    // The error is surfaced (req 5.1).
    expect(after.promptError).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("when two items are queued and one fails, only the failed one is removed", async () => {
    startRunningTurn();

    let call = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      call += 1;
      // First queue succeeds, second fails.
      if (call === 1) {
        return jsonResponse(200, {
          queued: true,
          message: {
            id: "srv-keep",
            content: textBlock("keep"),
            status: "pending",
            enqueuedAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            deliveredAt: null,
            cancelledAt: null,
            failedAt: null,
            error: null,
          },
          deliveryTiming: "next_turn",
        });
      }
      return jsonResponse(500, { error: "boom" });
    });

    const { result } = renderQueueHook();

    await act(async () => {
      await result.current.queue("keep");
    });
    await act(async () => {
      await result.current.queue("fail");
    });

    const after = inFlight();
    expect(after.optimisticQueue).toHaveLength(1);
    const [survivor] = after.optimisticQueue;
    expect(survivor?.queueId).toBe("srv-keep");
    expect(survivor?.status).toBe("accepted");
    expect(after.sending).toBe(true);
    expect(after.promptError).not.toBeNull();
  });

  it("success tracks the accepted server queue id", async () => {
    startRunningTurn();

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        queued: true,
        message: {
          id: "srv-1",
          content: textBlock("hi"),
          status: "pending",
          enqueuedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          deliveredAt: null,
          cancelledAt: null,
          failedAt: null,
          error: null,
        },
        deliveryTiming: "next_turn",
      }),
    );

    const { result } = renderQueueHook();

    await act(async () => {
      await result.current.queue("hi");
    });

    const after = inFlight();
    expect(after.optimisticQueue).toHaveLength(1);
    const [entry] = after.optimisticQueue;
    expect(entry?.queueId).toBe("srv-1");
    expect(entry?.status).toBe("accepted");
    expect(after.promptError).toBeNull();
    expect(after.sending).toBe(true);
  });

  it("forwards serialized images in the POST body (req 8.1)", async () => {
    startRunningTurn();

    const bodies: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      bodies.push(
        init?.body ? (JSON.parse(init.body as string) as unknown) : undefined,
      );
      return jsonResponse(200, {
        queued: true,
        message: {
          id: "srv-img",
          content: textBlock("hi"),
          status: "pending",
          enqueuedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          deliveredAt: null,
          cancelledAt: null,
          failedAt: null,
          error: null,
        },
        deliveryTiming: "next_turn",
      });
    });

    const image: ImagePayload = {
      attachmentId: "att-1",
      mediaType: "image/png",
      base64Data: "abc123",
    };

    const { result } = renderQueueHook();

    await act(async () => {
      await result.current.queue("hi", [image]);
    });

    expect(bodies).toHaveLength(1);
    const body = bodies[0] as { text?: string; images?: ImagePayload[] };
    expect(body.text).toBe("hi");
    expect(body.images).toEqual([image]);
  });

  it("posts to the queue endpoint even when this tab's sending flag is false", async () => {
    // A running turn is not always one this tab started (drained Codex
    // next-turn delivery, reload, another client), so queue() must not
    // silently drop on the tab-local flag — routing is the caller's job.
    expect(inFlight().sending).toBe(false);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        queued: true,
        message: {
          id: "srv-ext",
          content: textBlock("hi"),
          status: "pending",
          enqueuedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          deliveredAt: null,
          cancelledAt: null,
          failedAt: null,
          error: null,
        },
        deliveryTiming: "next_turn",
      }),
    );

    const { result } = renderQueueHook();

    await act(async () => {
      await result.current.queue("hi");
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      `/api/projects/${PROJECT}/sessions/${SESSION}/conversations/${CONVERSATION}/queue`,
    );
    const after = inFlight();
    expect(after.optimisticQueue).toHaveLength(1);
    expect(after.optimisticQueue[0]).toMatchObject({
      queueId: "srv-ext",
      status: "accepted",
    });
  });
});

describe("useSendPrompt — client abort", () => {
  it("clears the conversation's sending flag when the request is aborted client-side", async () => {
    // In-flight state is keyed per conversation and survives workspace swaps,
    // so an aborted client stream must not strand sending=true — nothing else
    // resets it anymore (the server turn keeps indicators alive via status).
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new DOMException("aborted", "AbortError"),
    );

    const { result } = renderQueueHook();

    await act(async () => {
      await result.current.send("hi", 0);
    });

    expect(inFlight().sending).toBe(false);
    expect(inFlight().promptError).toBeNull();
  });
});
