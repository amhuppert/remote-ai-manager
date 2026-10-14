// @vitest-environment jsdom
// A failed image enqueue surfaces the error and rolls back the optimistic entry.
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type PropsWithChildren } from "react";

import { imagePayloadSchema, type ImagePayload } from "@/lib/images/schemas";

import { useSendPrompt } from "@/hooks/use-send-prompt";
import {
  selectInFlightFor,
  useSessionDetailStore,
} from "@/stores/session-detail.store";

/** The backend image delivery and transcript regression is in queue-acceptance.integration.test.ts. */
const IMAGE: ImagePayload = imagePayloadSchema.parse({
  attachmentId: "att-1",
  mediaType: "image/png",
  base64Data: "aW1hZ2UtYnl0ZXM=",
});

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

function inFlight() {
  return selectInFlightFor(useSessionDetailStore.getState(), CONVERSATION);
}

/** Put the store into a "running turn" state so queue() will proceed. */
function startRunningTurn() {
  act(() => {
    useSessionDetailStore
      .getState()
      .submitPrompt(CONVERSATION, [{ type: "text", text: "turn" }], 0);
  });
  expect(inFlight().sending).toBe(true);
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

    const after = inFlight();

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
