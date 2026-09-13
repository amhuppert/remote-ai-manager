// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { sourceCheckpointSurface } from "./CheckpointForkProvenance";
import { checkpointSurfaceFixture } from "./checkpoint-story-fixtures";
import { checkpointReceiptFixture } from "@/lib/conversation-checkpoints/testing/receipt-fixture";
it("pins a historical source receipt without retargeting live recovery controls or reversing evidence intervals", () => {
  const latest = checkpointReceiptFixture({
    ordinal: 3,
    operationId: "latest",
    capturedThroughSeq: 300,
  });
  const middle = checkpointReceiptFixture({
    ordinal: 2,
    operationId: "middle",
    capturedThroughSeq: 200,
  });
  const historical = checkpointReceiptFixture({
    ordinal: 1,
    operationId: "historical",
    capturedThroughSeq: 100,
  });
  const surface = checkpointSurfaceFixture({ receipts: [latest, middle] });
  const merged = sourceCheckpointSurface(surface, historical);
  expect(merged.latest).toBe(latest);
  expect(merged.recent.map((item) => item.boundary.capturedThroughSeq)).toEqual(
    [300, 200, 100],
  );
  expect(merged.action).toEqual(surface.action);
  expect(sourceCheckpointSurface(surface, null).recent).toEqual([
    latest,
    middle,
  ]);
});

import { renderWithQuery } from "@/test/component-mocks";
import { screen } from "@testing-library/react";
import CheckpointForkProvenance from "./CheckpointForkProvenance";
import { checkpointForkOriginFixture } from "@/lib/conversation-checkpoints/testing/fork-origin-fixture";
afterEach(() => vi.unstubAllGlobals());
it.each([
  ["ready", false, "Ready for first message"],
  ["applied", true, "Accepted"],
  ["needs_reconciliation", false, "Delivery needs review"],
] as const)(
  "shows durable %s delivery on the provenance row",
  async (phase, accepted, label) => {
    const origin = checkpointForkOriginFixture();
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            receipt: checkpointReceiptFixture({
              operationId: origin.operationId,
              phase,
              hasAcceptedContinuation: accepted,
            }),
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    );
    renderWithQuery(<CheckpointForkProvenance origin={origin} />);
    expect(await screen.findByText(label)).toBeVisible();
  },
);
