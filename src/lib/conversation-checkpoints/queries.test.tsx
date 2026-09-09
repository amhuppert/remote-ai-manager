// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CHECKPOINT_RECENT_LIMIT,
  useCheckpointList,
  useCheckpointOperation,
} from "./queries";
import { checkpointKeys, type CheckpointTarget } from "./query-keys";
import { publishCheckpointReceipt } from "./sse-cache";
import { checkpointReceiptFixture } from "./testing/receipt-fixture";

const target: CheckpointTarget = {
  scope: "session",
  projectName: "p1",
  sessionName: "s1",
  conversationId: "c1",
};

const EARLIER = "2026-09-01T00:01:00.000Z";
const LATER = "2026-09-01T00:02:00.000Z";

/** The phase the server has already moved past by the time a GET lands. */
const staleBuilding = () =>
  checkpointReceiptFixture({
    operationId: "op-1",
    phase: "building",
    frozen: false,
    updatedAt: EARLIER,
  });

/** The newer truth, published by the event the GET raced. */
const freshReady = () =>
  checkpointReceiptFixture({
    operationId: "op-1",
    phase: "ready",
    updatedAt: LATER,
  });

const fetchSpy = vi.fn<typeof fetch>();

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function renderWithClient<T>(hook: () => T) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = renderHook(hook, {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return { ...view, client };
}

/**
 * A GET that started before an event and finished after it carries the OLDER
 * phase. Arrival order cannot decide the winner, so both read paths reconcile
 * what they fetched against the newest receipt this client already holds.
 */
describe("checkpoint reads reconciled against newer state", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("does not let an outstanding list GET restore a phase the server left", async () => {
    let release: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    fetchSpy.mockImplementation(async () => {
      await inFlight;
      return jsonResponse({ receipts: [staleBuilding()], nextBefore: null });
    });

    const { result, client } = renderWithClient(() =>
      useCheckpointList(target, { limit: CHECKPOINT_RECENT_LIMIT }),
    );

    // The event lands while the read is still in flight, so there is no cached
    // page for it to fold into — only the per-operation ledger.
    publishCheckpointReceipt(client, target, freshReady());
    release();

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.receipts[0]?.phase).toBe("ready");
  });

  it("does not let an outstanding detail GET restore a phase the server left", async () => {
    let release: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    fetchSpy.mockImplementation(async () => {
      await inFlight;
      return jsonResponse({ receipt: staleBuilding() });
    });

    const { result, client } = renderWithClient(() =>
      useCheckpointOperation(target, "op-1"),
    );

    publishCheckpointReceipt(client, target, freshReady());
    release();

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.receipt.phase).toBe("ready");
  });

  // The other direction must still work: a GET that genuinely knows more than
  // the cache has to win, or a reconnect could never recover a missed phase.
  it("adopts a newer receipt a read recovers after reconnect", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ receipts: [freshReady()], nextBefore: null }),
    );
    const { result, client } = renderWithClient(() =>
      useCheckpointList(target, { limit: CHECKPOINT_RECENT_LIMIT }),
    );
    client.setQueryData(checkpointKeys.detail(target, "op-1"), {
      receipt: staleBuilding(),
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.receipts[0]?.phase).toBe("ready");
    // The ledger moves forward with it, so the next read starts from the truth.
    expect(
      client.getQueryData<{ receipt: { phase: string } }>(
        checkpointKeys.detail(target, "op-1"),
      )?.receipt.phase,
    ).toBe("ready");
  });
});

/**
 * Freshness alone is not enough: a GET can be stale by OMISSION.
 *
 * A list read that left the server before an operation was admitted returns a
 * page that never mentions it. Reconciling only the rows the response happens
 * to contain therefore publishes a page missing an operation this client has
 * already been told about, and the chip and the composer lose the hold until
 * some later event or refetch happens to restore it.
 */
describe("a list read cannot erase an operation the client already knows", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("keeps a newly announced operation the in-flight page never saw", async () => {
    let release: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The page the server built before op-2 existed.
    fetchSpy.mockImplementation(async () => {
      await inFlight;
      return jsonResponse({
        receipts: [
          checkpointReceiptFixture({
            operationId: "op-1",
            ordinal: 1,
            phase: "applied",
            updatedAt: EARLIER,
          }),
        ],
        nextBefore: null,
      });
    });

    const { result, client } = renderWithClient(() =>
      useCheckpointList(target, { limit: CHECKPOINT_RECENT_LIMIT }),
    );

    publishCheckpointReceipt(
      client,
      target,
      checkpointReceiptFixture({
        operationId: "op-2",
        ordinal: 2,
        phase: "building",
        frozen: false,
        updatedAt: LATER,
      }),
    );
    release();

    await waitFor(() => expect(result.current.data).toBeDefined());
    // Newest first: the admitted operation still leads the page the GET
    // returned, so the surfaces that read receipts[0] still see it building.
    expect(result.current.data?.receipts.map((r) => r.operationId)).toEqual([
      "op-2",
      "op-1",
    ]);
    expect(result.current.data?.receipts[0]?.phase).toBe("building");
  });

  it("does not invent rows on a cursored page", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        receipts: [
          checkpointReceiptFixture({
            operationId: "op-1",
            ordinal: 1,
            phase: "applied",
          }),
        ],
        nextBefore: null,
      }),
    );

    const { result, client } = renderWithClient(() =>
      useCheckpointList(target, { before: 2, limit: CHECKPOINT_RECENT_LIMIT }),
    );
    // A newer operation belongs at the head, never inside a window the caller
    // explicitly asked to end before it.
    publishCheckpointReceipt(
      client,
      target,
      checkpointReceiptFixture({
        operationId: "op-9",
        ordinal: 9,
        phase: "building",
        frozen: false,
        updatedAt: LATER,
      }),
    );

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.receipts.map((r) => r.operationId)).toEqual([
      "op-1",
    ]);
  });
});
