// @vitest-environment jsdom

import { createElement, type PropsWithChildren } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  checkpointMaintenanceHoldsConversation,
  useCheckpointMaintenanceHold,
} from "./maintenance-hold";
import { checkpointReceiptFixture } from "./testing/receipt-fixture";
import { checkpointKeys } from "./query-keys";

/**
 * The manager owns the conversation while it builds and retires a checkpoint,
 * and refuses an ordinary direct prompt as busy for exactly that window. The
 * conversation's own status stays idle throughout — no ordinary turn is
 * running — so this predicate is the only thing that can tell a composer to
 * queue instead of losing the message to a refusal.
 */
describe("checkpointMaintenanceHoldsConversation", () => {
  it("observes a receipt surface mounting without updating its host during render", async () => {
    const client = new QueryClient();
    const target = {
      scope: "project",
      projectName: "lab",
      conversationId: "mounting",
    } as const;
    const initialData = {
      receipts: [checkpointReceiptFixture({ phase: "building" })],
      nextBefore: null,
    };
    function ReceiptSurface() {
      useQuery({
        queryKey: checkpointKeys.list(target),
        queryFn: async () => initialData,
        initialData,
        staleTime: Infinity,
      });
      return null;
    }
    function Composer({ show }: { show: boolean }) {
      const holds = useCheckpointMaintenanceHold(target);
      return createElement(
        "div",
        null,
        holds ? "queued" : "send",
        show ? createElement(ReceiptSurface) : null,
      );
    }
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const wrapper = ({ children }: PropsWithChildren) =>
      createElement(QueryClientProvider, { client }, children);
    const view = render(createElement(Composer, { show: false }), { wrapper });
    try {
      view.rerender(createElement(Composer, { show: true }));
      await waitFor(() => expect(view.container.textContent).toBe("queued"));
      expect(error).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      error.mockRestore();
      client.clear();
    }
  });

  it("keeps the host query fetchable when reconnect invalidates the cached hold", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const target = {
      scope: "project",
      projectName: "lab",
      conversationId: "c",
    } as const;
    const key = checkpointKeys.list(target);
    const wrapper = ({ children }: PropsWithChildren) =>
      createElement(QueryClientProvider, { client }, children);
    let phase: "building" | "ready" = "building";
    const read = vi.fn(async () => ({
      receipts: [checkpointReceiptFixture({ phase })],
      nextBefore: null,
    }));
    const host = renderHook(() => useQuery({ queryKey: key, queryFn: read }), {
      wrapper,
    });
    await waitFor(() => expect(host.result.current.isSuccess).toBe(true));
    const composer = renderHook(() => useCheckpointMaintenanceHold(target), {
      wrapper,
    });
    expect(composer.result.current).toBe(true);
    try {
      phase = "ready";
      await act(() => client.invalidateQueries({ queryKey: key }));
      await waitFor(() => expect(composer.result.current).toBe(false));
      expect(read).toHaveBeenCalledTimes(2);
      expect(host.result.current.isSuccess).toBe(true);
    } finally {
      composer.unmount();
      host.unmount();
      client.clear();
    }
  });

  it("observes an empty composer without a fetch or missing-query diagnostic", () => {
    const client = new QueryClient();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const wrapper = ({ children }: PropsWithChildren) =>
      createElement(QueryClientProvider, { client }, children);
    try {
      const hook = renderHook(() => useCheckpointMaintenanceHold(null), {
        wrapper,
      });
      expect(hook.result.current).toBe(false);
      expect(client.isFetching()).toBe(0);
      expect(error).not.toHaveBeenCalled();
      hook.unmount();
    } finally {
      error.mockRestore();
      client.clear();
    }
  });

  it("holds while the checkpoint is being built", () => {
    expect(
      checkpointMaintenanceHoldsConversation(
        checkpointReceiptFixture({ phase: "building" }),
      ),
    ).toBe(true);
  });

  it("holds while the runtime is being retired", () => {
    expect(
      checkpointMaintenanceHoldsConversation(
        checkpointReceiptFixture({ phase: "retiring" }),
      ),
    ).toBe(true);
  });

  // Readiness is the whole point of the feature: the next ordinary message is
  // what carries the seed, so holding it back would strand the checkpoint.
  it("does not hold once the checkpoint is ready for the next message", () => {
    expect(
      checkpointMaintenanceHoldsConversation(
        checkpointReceiptFixture({ phase: "ready" }),
      ),
    ).toBe(false);
  });

  it("does not hold for settled or absent operations", () => {
    expect(checkpointMaintenanceHoldsConversation(null)).toBe(false);
    for (const phase of ["applied", "cancelled", "failed"] as const) {
      expect(
        checkpointMaintenanceHoldsConversation(
          checkpointReceiptFixture({ phase }),
        ),
        phase,
      ).toBe(false);
    }
  });

  // `delivering` means a turn attempt is already in flight; ordinary turn
  // state covers that case, and treating it as maintenance would double-count.
  it("leaves an in-flight delivery to ordinary turn state", () => {
    expect(
      checkpointMaintenanceHoldsConversation(
        checkpointReceiptFixture({ phase: "delivering" }),
      ),
    ).toBe(false);
  });
});
