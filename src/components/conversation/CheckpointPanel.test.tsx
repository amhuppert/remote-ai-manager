// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import CheckpointPanel from "./CheckpointPanel";
import { checkpointSurfaceFixture } from "./checkpoint-story-fixtures";
import { checkpointHandoffEligibilityFixture } from "@/lib/conversation-checkpoints/testing/receipt-fixture";

afterEach(cleanup);

it("discloses callable tools before submitting the displayed mode and keeps baseline separate", () => {
  const startHandoff = vi.fn();
  const start = vi.fn();
  const surface = {
    ...checkpointSurfaceFixture({ receipts: [] }),
    handoff: checkpointHandoffEligibilityFixture({ mode: "instruction-only" }),
    startHandoff,
    start,
  };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CheckpointPanel
        open
        preparation
        onOpenChange={() => {}}
        surface={surface}
      />
    </QueryClientProvider>,
  );
  expect(screen.getByText(/tools remain available/i)).toBeTruthy();
  expect(startHandoff).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Capture handoff and compact" }),
  );
  expect(startHandoff).toHaveBeenCalledWith("instruction-only");
  fireEvent.click(
    screen.getByRole("button", { name: "Compact without handoff" }),
  );
  expect(start).toHaveBeenCalledOnce();
});

it("allows whole cancel to supersede skip while durable capture is settling", async () => {
  const { pendingHandoff } =
    await import("@/lib/conversation-checkpoints/handoff-fixture");
  const { checkpointHandoffReceipt } =
    await import("@/lib/conversation-checkpoints/receipt");
  const { checkpointReceiptFixture } =
    await import("@/lib/conversation-checkpoints/testing/receipt-fixture");
  const cancel = vi.fn();
  const receipt = checkpointReceiptFixture({
    phase: "building",
    frozen: false,
    handoff: checkpointHandoffReceipt(
      pendingHandoff({
        stage: "settling",
        startedAt: "2026-09-07T12:04:01.000Z",
        stopIntent: "skip",
      }),
    ),
  });
  const surface = {
    ...checkpointSurfaceFixture({ receipts: [receipt] }),
    cancel,
  };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CheckpointPanel open onOpenChange={() => {}} surface={surface} />
    </QueryClientProvider>,
  );
  const skip = screen.getByRole("button", { name: "Skip handoff" });
  expect(skip.hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel checkpoint" }));
  expect(cancel).toHaveBeenCalledWith(receipt.operationId);
});

it("offers explicit stopped-execution testimony only for a capture cleanup hold and keeps recovery separate", async () => {
  const { pendingHandoff } =
    await import("@/lib/conversation-checkpoints/handoff-fixture");
  const { checkpointHandoffReceipt } =
    await import("@/lib/conversation-checkpoints/receipt");
  const { checkpointReceiptFixture } =
    await import("@/lib/conversation-checkpoints/testing/receipt-fixture");
  const acknowledgeCaptureStopped = vi.fn();
  const startRecovery = vi.fn();
  const receipt = checkpointReceiptFixture({
    phase: "needs_reconciliation",
    lastStablePhase: "building",
    frozen: false,
    handoff: checkpointHandoffReceipt(
      pendingHandoff({
        stage: "omitted",
        omissionReason: "interrupted",
        finalizedAt: "2026-09-07T12:05:00.000Z",
        continuationDisposition: "clear",
      }),
    ),
  });
  const surface = {
    ...checkpointSurfaceFixture({ receipts: [receipt] }),
    acknowledgeCaptureStopped,
    startRecovery,
  };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CheckpointPanel open onOpenChange={() => {}} surface={surface} />
    </QueryClientProvider>,
  );
  expect(screen.getByText(/Inspect and stop prior backend work/i)).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "I have stopped the prior execution" }),
  );
  expect(acknowledgeCaptureStopped).toHaveBeenCalledWith(receipt.operationId);
  expect(startRecovery).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: /Recovery checkpoint/ }),
  ).toBeNull();
});
