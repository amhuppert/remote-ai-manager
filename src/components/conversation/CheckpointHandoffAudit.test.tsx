// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { capturedHandoff } from "@/lib/conversation-checkpoints/handoff-fixture";
import { checkpointReceiptFixture } from "@/lib/conversation-checkpoints/testing/receipt-fixture";
import { checkpointHandoffReceiptSchema } from "@/lib/conversation-checkpoints/schemas";
import type { CheckpointReceipt } from "@/lib/conversation-checkpoints/receipt";
import CheckpointHandoffAudit from "./CheckpointHandoffAudit";

function receipt(
  overrides: Partial<NonNullable<CheckpointReceipt["handoff"]>> = {},
): CheckpointReceipt {
  return checkpointReceiptFixture({
    handoff: {
      ...checkpointHandoffReceiptSchema.strip().parse(capturedHandoff()),
      finalSourceBasis: null,
      requested: true,
      stage: "included",
      categoryCounts: {
        plan: 1,
        hypotheses: 0,
        failedApproaches: 2,
        blockers: 0,
        nextStep: 1,
      },
      policy: null,
      ...overrides,
    },
  });
}
function open() {
  fireEvent.click(
    screen.getByRole("button", { name: "Agent handoff — advisory" }),
  );
}
afterEach(cleanup);
describe("capture audit", () => {
  it("separates advisory inclusion, actual counts and estimated capture-only usage", () => {
    render(<CheckpointHandoffAudit receipt={receipt()} />);
    expect(screen.getByText("Handoff included")).toBeDefined();
    open();
    expect(screen.getByText(/Tools remain available/)).toBeDefined();
    expect(screen.getByText("Plan: 1 retained, 0 omitted")).toBeDefined();
    expect(screen.getByText("Hypotheses: 0 retained, 0 omitted")).toBeDefined();
    expect(screen.getByText(/0.2 USD \(pricing estimate\)/)).toBeDefined();
    expect(screen.getByText(/Capture usage only/)).toBeDefined();
  });
  it("keeps seed-budget omission audit-only with observed counts and unknown usage", () => {
    render(
      <CheckpointHandoffAudit
        receipt={receipt({
          stage: "omitted",
          omissionReason: "seed_budget",
          usage: null,
        })}
      >
        <a href="/original-entry">Original audit entry</a>
      </CheckpointHandoffAudit>,
    );
    expect(screen.getByText(/Handoff omitted/)).toBeDefined();
    open();
    expect(screen.getByText("Plan: 0 retained, 1 omitted")).toBeDefined();
    expect(screen.getByText(/Capture usage unavailable/)).toBeDefined();
    expect(
      screen
        .getByRole("link", { name: "Original audit entry" })
        .getAttribute("href"),
    ).toBe("/original-entry");
  });
  it("does not invent category counts, established mode or complete native coverage", () => {
    render(
      <CheckpointHandoffAudit
        receipt={receipt({
          stage: "omitted",
          omissionReason: "mode_establishment_failed",
          modeEstablished: false,
          categoryCounts: null,
          activity: {
            transport: "complete",
            native: "unavailable",
            prohibited: "unknown",
            inspectedBytes: null,
          },
        })}
      />,
    );
    open();
    expect(screen.getByText("Established mode: Not established")).toBeDefined();
    expect(screen.getByText(/Category counts unavailable/)).toBeDefined();
    expect(screen.getByText(/Native coverage: unavailable/)).toBeDefined();
  });
  it("preserves original audit coordinates, hashes and provider-reported attribution", () => {
    const original = receipt();
    const usage = original.handoff?.usage;
    if (!usage) throw new Error("fixture usage missing");
    render(
      <CheckpointHandoffAudit
        receipt={receipt({
          usage: {
            ...usage,
            costBasis: "provider_reported",
            inputTokens: null,
          },
        })}
      />,
    );
    open();
    expect(screen.getByText("Content hash: sha256:handoff")).toBeDefined();
    expect(screen.getByText("Source coverage: seq 411–413")).toBeDefined();
    expect(
      screen.getByText(/capture-control\s+capture-output\s+capture-settlement/),
    ).toBeDefined();
    expect(screen.getByText(/0.2 USD \(provider reported\)/)).toBeDefined();
    expect(screen.getByText(/Input tokens: Unavailable/)).toBeDefined();
  });
  it("renders legacy checkpoints without invented capture metrics", () => {
    render(<CheckpointHandoffAudit receipt={checkpointReceiptFixture()} />);
    expect(screen.getByText("Handoff not requested")).toBeDefined();
    expect(screen.queryByText(/Capture usage/)).toBeNull();
  });
});
