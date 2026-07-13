// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import CompactionEnvelopeView from "./CompactionEnvelopeView";
import {
  buildMaximalEnvelope,
  buildMinimalEnvelope,
  buildProvenance,
} from "./fixtures";

describe("CompactionEnvelopeView", () => {
  beforeEach(() => {
    // jsdom has no scrollIntoView; the TOC uses it for section jumps.
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it("renders the agent brief split into paragraphs on blank lines", async () => {
    const envelope = {
      ...buildMaximalEnvelope(),
      agentBrief: "First paragraph of the brief.\n\nSecond paragraph.",
    };
    render(<CompactionEnvelopeView envelope={envelope} />);
    // The agent brief renders through the deferred DocumentMarkdown adapter,
    // whose dynamic import can exceed the default 1s findBy budget under load.
    const first = await screen.findByText(
      "First paragraph of the brief.",
      undefined,
      {
        timeout: 15000,
      },
    );
    const second = await screen.findByText("Second paragraph.");
    expect(first.tagName).toBe("P");
    expect(second.tagName).toBe("P");
    expect(first).not.toBe(second);
  });

  it("renders the agent brief through the canonical document adapter", async () => {
    const envelope = {
      ...buildMaximalEnvelope(),
      agentBrief:
        "Lead sentence.\n\n### What shipped\n\n" +
        "Persisted through `repo.ts`.\n\n- one\n- two",
    };
    render(<CompactionEnvelopeView envelope={envelope} />);
    const heading = await screen.findByRole(
      "heading",
      { name: "What shipped" },
      { timeout: 15000 },
    );
    expect(heading.tagName).toBe("H3");
    // The canonical DocumentMarkdown adapter stamps a document-intent root.
    expect(heading.closest("[data-markdown-intent='document']")).not.toBeNull();
    expect(screen.getByText("repo.ts").tagName).toBe("CODE");
    expect(screen.getByText("one").closest("li")).not.toBeNull();
    // Raw markdown markers must not leak into the rendered output.
    expect(screen.queryByText(/### What shipped/)).not.toBeInTheDocument();
  });

  it("lets the agent brief fill the container width without a prose cap", async () => {
    const envelope = {
      ...buildMaximalEnvelope(),
      agentBrief: "First paragraph of the brief.\n\nSecond paragraph.",
    };
    render(<CompactionEnvelopeView envelope={envelope} />);
    const briefContainer = (
      await screen.findByText("First paragraph of the brief.", undefined, {
        timeout: 15000,
      })
    ).parentElement!;
    expect(briefContainer.className).not.toMatch(/max-w-\[\d+ch\]/);
  });

  it("lets the current state prose fill the container width without a prose cap", () => {
    render(<CompactionEnvelopeView envelope={buildMaximalEnvelope()} />);
    const goalParagraph = screen.getByText(/Goal —/).parentElement!;
    expect(goalParagraph.className).not.toMatch(/max-w-\[\d+ch\]/);
    const actionsList = screen
      .getByText("Wire the MessageActions compact button to useCompactMutation")
      .closest("ol")!;
    expect(actionsList.className).not.toMatch(/max-w-\[\d+ch\]/);
  });

  it("renders the current state goal and numbered next actions", () => {
    render(<CompactionEnvelopeView envelope={buildMaximalEnvelope()} />);
    expect(
      screen.getByText(/Ship the per-message compaction UX/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Goal —/)).toBeInTheDocument();
    expect(
      screen.getByText(
        "Wire the MessageActions compact button to useCompactMutation",
      ),
    ).toBeInTheDocument();
  });

  it("renders the status pill with a tone mapped from the status string", () => {
    render(<CompactionEnvelopeView envelope={buildMaximalEnvelope()} />);
    // in-progress statuses map to the cyan tone (complete→green, blocked/failed→red)
    const pills = screen.getAllByText("implementation_in_progress");
    expect(pills.length).toBeGreaterThan(0);
    expect(pills[0]!.closest("[data-tone]")).toHaveAttribute(
      "data-tone",
      "cyan",
    );
  });

  it("maps complete and blocked statuses to green and red pill tones", () => {
    const complete = {
      ...buildMinimalEnvelope(),
      currentState: {
        ...buildMinimalEnvelope().currentState,
        status: "resolved",
      },
    };
    const { unmount } = render(<CompactionEnvelopeView envelope={complete} />);
    expect(
      screen.getAllByText("resolved")[0]!.closest("[data-tone]"),
    ).toHaveAttribute("data-tone", "green");
    unmount();

    const blocked = {
      ...buildMinimalEnvelope(),
      currentState: {
        ...buildMinimalEnvelope().currentState,
        status: "blocked_on_user",
      },
    };
    render(<CompactionEnvelopeView envelope={blocked} />);
    expect(
      screen.getAllByText("blocked_on_user")[0]!.closest("[data-tone]"),
    ).toHaveAttribute("data-tone", "red");
  });

  it("renders every anchored section card with its items", () => {
    render(<CompactionEnvelopeView envelope={buildMaximalEnvelope()} />);
    // Section labels appear on the card trigger (and again in the TOC rail).
    expect(screen.getAllByText("Decisions").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Files").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Commands").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Open questions").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Blockers").length).toBeGreaterThan(0);
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

  it("collapses a section card from its trigger", () => {
    render(<CompactionEnvelopeView envelope={buildMaximalEnvelope()} />);
    const trigger = screen
      .getAllByRole("button", { name: /Decisions/ })
      .find((button) => button.hasAttribute("aria-expanded"));
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(trigger!);
    expect(
      screen.queryByText("Store envelopes in SQLite, not sidecar files."),
    ).not.toBeInTheDocument();
  });

  it("omits section cards whose arrays are empty and notes them quietly", () => {
    render(<CompactionEnvelopeView envelope={buildMinimalEnvelope()} />);
    expect(screen.queryByText("Decisions")).not.toBeInTheDocument();
    expect(screen.queryByText("Files")).not.toBeInTheDocument();
    expect(screen.queryByText("Commands")).not.toBeInTheDocument();
    expect(screen.queryByText("Open questions")).not.toBeInTheDocument();
    expect(screen.queryByText("Blockers")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "No decisions, files, commands, open questions, or blockers recorded.",
      ),
    ).toBeInTheDocument();
  });

  it("notes a single empty section as a quiet line", () => {
    const envelope = { ...buildMaximalEnvelope(), blockers: [] };
    render(<CompactionEnvelopeView envelope={envelope} />);
    expect(screen.getByText("No blockers recorded.")).toBeInTheDocument();
  });

  it("lists non-empty sections in the TOC and scrolls to one on click", () => {
    render(<CompactionEnvelopeView envelope={buildMaximalEnvelope()} />);
    const tocRow = screen
      .getAllByRole("button", { name: /Decisions/ })
      .find((button) => !button.hasAttribute("aria-expanded"));
    expect(tocRow).toBeDefined();
    fireEvent.click(tocRow!);
    expect(window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalledTimes(
      1,
    );
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

  // WCAG AA (1.4.3) pin for the chip label on bg-raised (#172033):
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

  it("renders coverage, message count, and omissions in the meta rail", () => {
    render(<CompactionEnvelopeView envelope={buildMaximalEnvelope()} />);
    expect(screen.getAllByText(/seq 0–421/).length).toBeGreaterThan(0);
    expect(screen.getByText("Coverage")).toBeInTheDocument();
    expect(screen.getByText("Messages")).toBeInTheDocument();
    expect(screen.getByText("57")).toBeInTheDocument();
    expect(screen.getByText("Omitted")).toBeInTheDocument();
    expect(
      screen.getAllByText(/reasoning · 12 tool outputs/).length,
    ).toBeGreaterThan(0);
  });

  it("renders the provenance card when given", () => {
    render(
      <CompactionEnvelopeView
        envelope={buildMaximalEnvelope()}
        provenance={buildProvenance()}
      />,
    );
    expect(
      screen.getAllByText(/claude · sonnet · medium/).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/prompt cp-1 · normalizer nv-1 · schema v1/).length,
    ).toBeGreaterThan(0);
    // conversation id shortened to its first 8 chars
    expect(
      screen.getAllByText(/by user · conv conv-fix/).length,
    ).toBeGreaterThan(0);
  });

  it("toggles the raw JSON view for debugging", () => {
    render(<CompactionEnvelopeView envelope={buildMinimalEnvelope()} />);
    expect(screen.queryByText(/"sourceHash"/)).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Raw JSON" })[0]!);
    expect(
      screen.getByText(/"sourceHash": "sha256:77aa21"/),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Hide raw JSON" })[0]!,
    );
    expect(screen.queryByText(/"sourceHash"/)).not.toBeInTheDocument();
  });
});
