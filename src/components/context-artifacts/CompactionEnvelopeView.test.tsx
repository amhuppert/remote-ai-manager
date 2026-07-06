// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import CompactionEnvelopeView from "./CompactionEnvelopeView";
import {
  buildMaximalEnvelope,
  buildMinimalEnvelope,
  buildProvenance,
} from "./fixtures";

describe("CompactionEnvelopeView", () => {
  it("renders the agent brief and current state", () => {
    render(<CompactionEnvelopeView envelope={buildMaximalEnvelope()} />);
    expect(
      screen.getByText(/Implemented the context_artifacts storage layer/),
    ).toBeInTheDocument();
    expect(screen.getByText("implementation_in_progress")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Ship the per-message compaction UX with an inline envelope viewer",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Wire the MessageActions compact button to useCompactMutation",
      ),
    ).toBeInTheDocument();
  });

  it("renders every anchored section with its items", () => {
    render(<CompactionEnvelopeView envelope={buildMaximalEnvelope()} />);
    // Section headers with counts.
    expect(screen.getByText("Decisions")).toBeInTheDocument();
    expect(screen.getByText("Files")).toBeInTheDocument();
    expect(screen.getByText("Commands")).toBeInTheDocument();
    expect(screen.getByText("Open questions")).toBeInTheDocument();
    expect(screen.getByText("Blockers")).toBeInTheDocument();
    // Items.
    expect(
      screen.getByText("Store envelopes in SQLite, not sidecar files."),
    ).toBeInTheDocument();
    expect(screen.getByText("superseded")).toBeInTheDocument();
    expect(
      screen.getByText("src/lib/context-artifacts/repo.ts"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("bunx vitest run src/lib/context-artifacts"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Should the status chip live in SessionInfoStrip or the info popover?",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Waiting on live verification before merge."),
    ).toBeInTheDocument();
  });

  it("omits sections whose arrays are empty", () => {
    render(<CompactionEnvelopeView envelope={buildMinimalEnvelope()} />);
    expect(screen.queryByText("Decisions")).not.toBeInTheDocument();
    expect(screen.queryByText("Files")).not.toBeInTheDocument();
    expect(screen.queryByText("Commands")).not.toBeInTheDocument();
    expect(screen.queryByText("Open questions")).not.toBeInTheDocument();
    expect(screen.queryByText("Blockers")).not.toBeInTheDocument();
  });

  it("renders sourceRefs as clickable chips that fire onNavigateToMessage", () => {
    const onNavigate = vi.fn();
    render(
      <CompactionEnvelopeView
        envelope={buildMaximalEnvelope()}
        onNavigateToMessage={onNavigate}
      />,
    );
    const chip = screen.getByRole("button", {
      name: "Go to message 9",
    });
    fireEvent.click(chip);
    expect(onNavigate).toHaveBeenCalledWith(9);
  });

  it("renders ref chips as non-interactive spans when no callback is given", () => {
    render(<CompactionEnvelopeView envelope={buildMaximalEnvelope()} />);
    expect(
      screen.queryByRole("button", { name: "Go to message 9" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("#9")).toBeInTheDocument();
  });

  // WCAG AA (1.4.3) pin for the 10.5px chip label on bg-raised (#172033):
  // text-text-secondary #7b899f = 4.59:1 (compliant); the next-darker token
  // text-text-tertiary #738699 = 4.33:1 fails the 4.5:1 threshold (axe:
  // serious, 6 nodes in the live E2E pass).
  it("renders source-ref chips with AA-compliant secondary text, not tertiary", () => {
    render(
      <CompactionEnvelopeView
        envelope={buildMaximalEnvelope()}
        onNavigateToMessage={() => {}}
      />,
    );
    const interactiveChip = screen.getByRole("button", {
      name: "Go to message 9",
    });
    expect(interactiveChip.className).toContain("text-text-secondary");
    expect(interactiveChip.className).not.toContain("text-text-tertiary");
  });

  it("renders non-interactive source-ref chips with AA-compliant secondary text", () => {
    render(<CompactionEnvelopeView envelope={buildMaximalEnvelope()} />);
    const chip = screen.getByText("#9");
    expect(chip.className).toContain("text-text-secondary");
    expect(chip.className).not.toContain("text-text-tertiary");
  });

  it("renders omissions and coverage in the footer", () => {
    render(<CompactionEnvelopeView envelope={buildMaximalEnvelope()} />);
    expect(screen.getByText(/seq 0–421/)).toBeInTheDocument();
    expect(screen.getByText(/57 messages/)).toBeInTheDocument();
    expect(screen.getByText(/reasoning omitted/)).toBeInTheDocument();
    expect(
      screen.getByText(/12 large tool outputs elided/),
    ).toBeInTheDocument();
  });

  it("renders the provenance line when given", () => {
    render(
      <CompactionEnvelopeView
        envelope={buildMaximalEnvelope()}
        provenance={buildProvenance()}
      />,
    );
    expect(screen.getByText(/claude · sonnet · medium/)).toBeInTheDocument();
    expect(
      screen.getByText(/prompt cp-1 · normalizer nv-1 · schema v1/),
    ).toBeInTheDocument();
    expect(screen.getByText(/by user/)).toBeInTheDocument();
  });

  it("toggles the raw JSON view for debugging", () => {
    render(<CompactionEnvelopeView envelope={buildMinimalEnvelope()} />);
    expect(screen.queryByText(/"sourceHash"/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Raw JSON" }));
    expect(
      screen.getByText(/"sourceHash": "sha256:77aa21"/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide raw JSON" }));
    expect(screen.queryByText(/"sourceHash"/)).not.toBeInTheDocument();
  });
});
