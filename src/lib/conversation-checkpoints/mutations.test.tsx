// @vitest-environment jsdom
import React from "react";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import { createTestQueryClient } from "@/test/component-mocks";
import { checkpointReceiptFixture } from "./testing/receipt-fixture";
import { checkpointKeys, type CheckpointTarget } from "./query-keys";
import {
  checkpointUrl,
  checkpointsBaseUrl,
  useCheckpointList,
  useCheckpointOperation,
} from "./queries";
import {
  checkpointRefusalFromError,
  useStartCheckpointMutation,
  useSkipCheckpointHandoffMutation,
  useReconcileCheckpointMutation,
} from "./mutations";

let api: FetchFixture;
let client: QueryClient;
beforeEach(() => {
  api = installFetchFixture();
  client = createTestQueryClient();
});
afterEach(() => {
  cleanup();
  client.clear();
  api.restore();
});
function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const targets: CheckpointTarget[] = [
  { scope: "session", projectName: "p", sessionName: "s", conversationId: "c" },
  { scope: "project", projectName: "p", conversationId: "c" },
];
describe.each(targets)("checkpoint mutations ($scope)", (target) => {
  it.each([
    undefined,
    false,
    { mode: null },
    { mode: "tool-disabled" },
    { mode: "instruction-only" },
  ] as const)("preserves opt-in %j in its own scope", async (handoff) => {
    const receipt = checkpointReceiptFixture({
      scope: target.scope,
      conversationId: "c",
    });
    const base = checkpointsBaseUrl(target);
    api.json("POST", base, {
      outcome: "admitted",
      receipt,
      statusUrl: `${base}/${receipt.operationId}`,
    });
    const { result } = renderHook(() => useStartCheckpointMutation(target), {
      wrapper,
    });
    await result.current.mutateAsync(handoff === undefined ? {} : { handoff });
    expect(api.requestsTo("POST", base)).toHaveLength(1);
    expect(api.requests[0]?.jsonBody).toEqual({
      requestId: expect.any(String),
      ...(handoff === undefined ? {} : { handoff }),
    });
    expect(api.unmatched).toEqual([]);
    expect(
      client.getQueryData(checkpointKeys.detail(target, receipt.operationId)),
    ).toEqual({ receipt });
  });

  it.each(["stopping", "handoff_already_settled"])(
    "handles skip %s via the scoped control and refreshes authoritative progress",
    async (outcome) => {
      const receipt = checkpointReceiptFixture({
        scope: target.scope,
        conversationId: "c",
        phase: "building",
      });
      const ready = checkpointReceiptFixture({
        scope: target.scope,
        conversationId: "c",
        phase: "ready",
        updatedAt: "2099-01-01T00:00:00.000Z",
      });
      const url = checkpointUrl(target, receipt.operationId);
      const base = checkpointsBaseUrl(target);
      api.json("GET", url, { receipt });
      api.json("GET", base, { receipts: [receipt], nextBefore: null });
      api.json("POST", `${url}/skip-handoff`, { outcome, receipt });
      const { result } = renderHook(
        () => ({
          mutation: useSkipCheckpointHandoffMutation(target),
          detail: useCheckpointOperation(target, receipt.operationId),
          list: useCheckpointList(target),
        }),
        { wrapper },
      );
      await waitFor(() =>
        expect(
          result.current.detail.isSuccess && result.current.list.isSuccess,
        ).toBe(true),
      );
      api.json("GET", url, { receipt: ready });
      api.json("GET", base, { receipts: [ready], nextBefore: null });
      await result.current.mutation.mutateAsync({
        operationId: receipt.operationId,
      });
      await waitFor(() =>
        expect(result.current.detail.data?.receipt.phase).toBe("ready"),
      );
      expect(result.current.list.data?.receipts[0]?.phase).toBe("ready");
      expect(api.requestsTo("GET", url).length).toBeGreaterThan(1);
      expect(api.unmatched).toEqual([]);
    },
  );

  it("retains a reconciliation refusal while adopting its committed receipt and refreshing GETs", async () => {
    const receipt = checkpointReceiptFixture({
      scope: target.scope,
      conversationId: "c",
      phase: "needs_reconciliation",
    });
    const updated = { ...receipt, updatedAt: "2099-01-01T00:00:00.000Z" };
    const url = checkpointUrl(target, receipt.operationId);
    const base = checkpointsBaseUrl(target);
    const refusal = {
      code: "recovery_required",
      reason: "Explicit recovery required",
      operationId: receipt.operationId,
      phase: "needs_reconciliation",
    };
    api.json("GET", url, { receipt });
    api.json("GET", base, { receipts: [receipt], nextBefore: null });
    api.reply("POST", `${url}/reconcile`, {
      status: 409,
      json: {
        error: refusal.reason,
        code: refusal.code,
        details: { refusal, receipt: updated },
      },
    });
    const { result } = renderHook(
      () => ({
        mutation: useReconcileCheckpointMutation(target),
        detail: useCheckpointOperation(target, receipt.operationId),
        list: useCheckpointList(target),
      }),
      { wrapper },
    );
    await waitFor(() =>
      expect(
        result.current.detail.isSuccess && result.current.list.isSuccess,
      ).toBe(true),
    );
    let caught: unknown;
    try {
      await result.current.mutation.mutateAsync({
        operationId: receipt.operationId,
        captureExecutionStopped: true,
      });
    } catch (error) {
      caught = error;
    }
    expect(checkpointRefusalFromError(caught)).toEqual(refusal);
    expect(api.requestsTo("POST", `${url}/reconcile`)[0]?.jsonBody).toEqual({
      captureExecutionStopped: true,
      source: "ui",
    });
    await waitFor(() =>
      expect(api.requestsTo("GET", url).length).toBeGreaterThan(1),
    );
    await waitFor(() =>
      expect(api.requestsTo("GET", base).length).toBeGreaterThan(1),
    );
    expect(result.current.detail.data?.receipt.updatedAt).toBe(
      updated.updatedAt,
    );
    expect(api.unmatched).toEqual([]);
  });
});
