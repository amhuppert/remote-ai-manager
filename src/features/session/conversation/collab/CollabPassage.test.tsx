// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import CollabPassage, {
  buildPhases,
  flowAgentToBackend,
  groupCollabArtifacts,
  isCollabPassageTerminal,
  trajectoryThroughRound,
} from "@/features/session/conversation/collab/CollabPassage";
import {
  makeAgentOneInitialDraft,
  makeAgentOneProposedChanges,
  makeAgentTwoCounterProposalRound1,
  makeAgentTwoCounterProposalRound2,
  makeAgentTwoCrossReview,
  makeAgentTwoInitialDraft,
  makeFinalAnswer,
  makeOpenConflicts,
  makeResolutionDecisionContinue,
  makeResolutionDecisionFinal,
} from "@/lib/workflows/collaboration/test-fixtures";
import type { CollaborationArtifact } from "@/lib/workflows/collaboration/types";

describe("flowAgentToBackend", () => {
  it("maps agent_one to the configured primary backend", () => {
    expect(flowAgentToBackend("agent_one", "claude")).toBe("claude");
    expect(flowAgentToBackend("agent_one", "codex")).toBe("codex");
  });

  it("maps agent_two to the opposite backend", () => {
    expect(flowAgentToBackend("agent_two", "claude")).toBe("codex");
    expect(flowAgentToBackend("agent_two", "codex")).toBe("claude");
  });
});

describe("isCollabPassageTerminal", () => {
  it("returns true for converged/unresolved/user-stopped/failed", () => {
    expect(isCollabPassageTerminal("converged")).toBe(true);
    expect(isCollabPassageTerminal("unresolved")).toBe(true);
    expect(isCollabPassageTerminal("user-stopped")).toBe(true);
    expect(isCollabPassageTerminal("failed")).toBe(true);
  });

  it("returns false for in-progress states", () => {
    expect(isCollabPassageTerminal("drafting")).toBe(false);
    expect(isCollabPassageTerminal("negotiating")).toBe(false);
    expect(isCollabPassageTerminal("paused")).toBe(false);
  });
});

describe("groupCollabArtifacts", () => {
  it("packs proposed/counter/decision into a single round and starts a new round on the next proposed_changes", () => {
    const artifacts: CollaborationArtifact[] = [
      makeAgentOneProposedChanges(),
      makeAgentTwoCounterProposalRound1(),
      makeResolutionDecisionContinue(),
      makeAgentOneProposedChanges({ round: 2, summary: "R2 proposed" }),
      makeAgentTwoCounterProposalRound2(),
      makeResolutionDecisionFinal({ round: 2 }),
    ];
    const grouped = groupCollabArtifacts(artifacts);
    expect(grouped.rounds).toHaveLength(2);
    expect(grouped.rounds[0]!.round).toBe(1);
    expect(grouped.rounds[0]!.decision?.next_action).toBe(
      "continue_negotiation",
    );
    expect(grouped.rounds[1]!.round).toBe(2);
    expect(grouped.rounds[1]!.decision?.next_action).toBe("final");
  });

  it("captures initial drafts, cross-review, open_conflicts, and final_answer separately", () => {
    const grouped = groupCollabArtifacts([
      makeAgentOneInitialDraft(),
      makeAgentTwoInitialDraft(),
      makeAgentTwoCrossReview(),
      makeOpenConflicts(),
      makeFinalAnswer(),
    ]);
    expect(grouped.initialDrafts).toHaveLength(2);
    expect(grouped.crossReview).toBeDefined();
    expect(grouped.openConflicts).toBeDefined();
    expect(grouped.finalAnswer).toBeDefined();
    expect(grouped.rounds).toHaveLength(0);
  });
});

describe("trajectoryThroughRound", () => {
  it("returns one disagree count per counter_proposal up through the requested round", () => {
    const artifacts: CollaborationArtifact[] = [
      makeAgentTwoCrossReview(),
      makeAgentOneProposedChanges(),
      makeAgentTwoCounterProposalRound1(),
      makeResolutionDecisionContinue(),
      makeAgentOneProposedChanges({ round: 2, summary: "R2 proposed" }),
      makeAgentTwoCounterProposalRound2(),
      makeResolutionDecisionFinal({ round: 2 }),
    ];
    expect(trajectoryThroughRound(artifacts, 1)).toEqual([
      makeAgentTwoCounterProposalRound1().disagree.length,
    ]);
    expect(trajectoryThroughRound(artifacts, 2)).toEqual([
      makeAgentTwoCounterProposalRound1().disagree.length,
      makeAgentTwoCounterProposalRound2().disagree.length,
    ]);
  });
});

describe("CollabPassage rendering", () => {
  it("renders one InitialDraft card per initial_draft artifact, with the primary card flagged", () => {
    render(
      <CollabPassage
        workflowId="wf-1"
        primary="claude"
        status="drafting"
        artifacts={[makeAgentOneInitialDraft(), makeAgentTwoInitialDraft()]}
      />,
    );
    const drafts = document.querySelectorAll(
      'section[data-kind="initial_draft"]',
    );
    expect(drafts).toHaveLength(2);
    expect(screen.getByText("Primary")).toBeInTheDocument();
  });

  it("labels each card's authoring agent with its lane's model and effort when agents is provided", () => {
    render(
      <CollabPassage
        workflowId="wf-1"
        primary="claude"
        agents={{
          agent_one: {
            backend: "claude",
            modelSelection: {
              modelId: "fable",
              parameters: { effort: "max" },
            },
          },
          agent_two: {
            backend: "codex",
            modelSelection: {
              modelId: "gpt-5.5",
              parameters: { fast: "false", reasoning: "high" },
            },
          },
        }}
        status="drafting"
        artifacts={[makeAgentOneInitialDraft(), makeAgentTwoInitialDraft()]}
      />,
    );
    const drafts = document.querySelectorAll(
      'section[data-kind="initial_draft"]',
    );
    expect(drafts).toHaveLength(2);
    const claudeDraft = Array.from(drafts).find(
      (d) => d.getAttribute("data-agent") === "claude",
    );
    const codexDraft = Array.from(drafts).find(
      (d) => d.getAttribute("data-agent") === "codex",
    );
    expect(claudeDraft?.textContent).toContain("fable");
    expect(claudeDraft?.textContent).toContain("max");
    expect(codexDraft?.textContent).toContain("gpt-5.5");
    expect(codexDraft?.textContent).toContain("high");
  });

  it("keeps the two lanes distinct when both agents run the same backend", () => {
    render(
      <CollabPassage
        workflowId="wf-1"
        primary="claude"
        agents={{
          agent_one: {
            backend: "claude",
            modelSelection: {
              modelId: "fable",
              parameters: { effort: "max" },
            },
          },
          agent_two: {
            backend: "claude",
            modelSelection: {
              modelId: "opus",
              parameters: { effort: "high" },
            },
          },
        }}
        status="drafting"
        artifacts={[makeAgentOneInitialDraft(), makeAgentTwoInitialDraft()]}
      />,
    );
    const drafts = Array.from(
      document.querySelectorAll('section[data-kind="initial_draft"]'),
    );
    expect(drafts).toHaveLength(2);
    // Both cards carry the claude backend identity, disambiguated by each
    // lane's own model metadata.
    expect(drafts.every((d) => d.getAttribute("data-agent") === "claude")).toBe(
      true,
    );
    const text = drafts.map((d) => d.textContent ?? "").join("|");
    expect(text).toContain("fable");
    expect(text).toContain("opus");
  });

  it("renders no model metadata when agents is absent (pre-existing runs)", () => {
    render(
      <CollabPassage
        workflowId="wf-1"
        primary="claude"
        status="drafting"
        artifacts={[makeAgentOneInitialDraft()]}
      />,
    );
    const draft = document.querySelector('section[data-kind="initial_draft"]');
    expect(draft?.textContent).not.toContain("fable");
    expect(draft?.textContent).toContain("Claude");
  });

  it("renders the resolution decision card in its own full-width lane", () => {
    render(
      <CollabPassage
        workflowId="wf-1"
        primary="claude"
        status="negotiating"
        artifacts={[
          makeAgentOneProposedChanges(),
          makeAgentTwoCounterProposalRound1(),
          makeResolutionDecisionContinue(),
        ]}
      />,
    );
    const decisionCard = document.querySelector(
      'section[data-kind="resolution_decision"]',
    );
    expect(decisionCard).not.toBeNull();
    const decisionHost = decisionCard!.closest("[data-card-id]");
    expect(decisionHost).not.toBeNull();
    expect(decisionHost?.getAttribute("data-lane")).toBe("full");
  });

  // Parallel beats (the two initial drafts) share a single
  // `[data-row-kind="drafts"]` row so the two-column grid binds them into one row.
  it("groups both initial drafts as siblings inside one drafts row", () => {
    render(
      <CollabPassage
        workflowId="wf-1"
        primary="claude"
        status="drafting"
        artifacts={[makeAgentOneInitialDraft(), makeAgentTwoInitialDraft()]}
      />,
    );
    const draftSection = document.querySelector(
      '[data-section="initial_draft"]',
    );
    expect(draftSection).not.toBeNull();
    const rows = draftSection!.querySelectorAll('[data-row-kind="drafts"]');
    expect(rows).toHaveLength(1);
    const draftsInRow = rows[0]!.querySelectorAll(
      'section[data-kind="initial_draft"]',
    );
    expect(draftsInRow).toHaveLength(2);
  });

  it("renders proposed_changes and counter_proposal in their own lanes (separate rows)", () => {
    render(
      <CollabPassage
        workflowId="wf-1"
        primary="claude"
        status="negotiating"
        artifacts={[
          makeAgentOneProposedChanges(),
          makeAgentTwoCounterProposalRound1(),
          makeResolutionDecisionContinue(),
        ]}
      />,
    );
    const roundSection = document.querySelector(
      '[data-section="negotiation"][data-round="1"]',
    );
    expect(roundSection).not.toBeNull();
    const proposed = roundSection!.querySelector(
      'section[data-kind="proposed_changes"]',
    );
    const counter = roundSection!.querySelector(
      'section[data-kind="counter_proposal"]',
    );
    expect(proposed).not.toBeNull();
    expect(counter).not.toBeNull();
    expect(proposed!.closest("[data-card-id]")?.getAttribute("data-lane")).toBe(
      "left",
    );
    expect(counter!.closest("[data-card-id]")?.getAttribute("data-lane")).toBe(
      "right",
    );
  });

  it("renders connectors between sequential cards", () => {
    render(
      <CollabPassage
        workflowId="wf-1"
        primary="claude"
        status="negotiating"
        artifacts={[
          makeAgentOneInitialDraft(),
          makeAgentTwoInitialDraft(),
          makeAgentTwoCrossReview(),
          makeAgentOneProposedChanges(),
          makeAgentTwoCounterProposalRound1(),
          makeResolutionDecisionContinue(),
        ]}
      />,
    );
    const connectors = document.querySelectorAll("[data-from]");
    expect(connectors.length).toBeGreaterThan(0);
  });

  it("offers Collapse all / Expand all and Prev / Next nav controls", () => {
    render(
      <CollabPassage
        workflowId="wf-1"
        primary="claude"
        status="drafting"
        artifacts={[makeAgentOneInitialDraft(), makeAgentTwoInitialDraft()]}
      />,
    );
    expect(
      screen.getByRole("button", { name: /collapse all cards/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /expand all cards/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /previous card/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /next card/i }),
    ).toBeInTheDocument();
  });

  it("renders the open conflicts card and forwards pause handlers when paused", () => {
    const onDraftChange = vi.fn();
    const onSubmit = vi.fn();
    render(
      <CollabPassage
        workflowId="wf-1"
        primary="claude"
        status="paused"
        artifacts={[makeOpenConflicts()]}
        pauseHandlers={{
          drafts: {},
          onDraftChange,
          onSubmit,
          isSubmitting: false,
        }}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Send answers/i }),
    ).toBeInTheDocument();
  });

  it("renders the final answer message when present", () => {
    render(
      <CollabPassage
        workflowId="wf-1"
        primary="claude"
        status="converged"
        artifacts={[
          makeAgentOneInitialDraft(),
          makeAgentTwoInitialDraft(),
          makeAgentTwoCrossReview(),
          makeAgentOneProposedChanges(),
          makeAgentTwoCounterProposalRound1(),
          makeResolutionDecisionFinal(),
          makeFinalAnswer(),
        ]}
        onRefClick={vi.fn()}
      />,
    );
    expect(document.querySelector('[data-kind="final_answer"]')).not.toBeNull();
  });

  it("renders an inline phase strip by default and hides it when hideInlinePhaseStrip is true", () => {
    const props = {
      workflowId: "wf-1",
      primary: "claude" as const,
      status: "drafting" as const,
      artifacts: [makeAgentOneInitialDraft()],
    };
    const { rerender } = render(<CollabPassage {...props} />);
    expect(
      document.querySelector('[aria-label="Collaboration phase progress"]'),
    ).not.toBeNull();
    rerender(<CollabPassage {...props} hideInlinePhaseStrip />);
    expect(
      document.querySelector('[aria-label="Collaboration phase progress"]'),
    ).toBeNull();
  });

  it("offers Stop whenever the run is non-terminal, including paused", () => {
    const onStop = vi.fn();
    const { rerender } = render(
      <CollabPassage
        workflowId="wf-1"
        primary="claude"
        status="negotiating"
        artifacts={[makeAgentOneProposedChanges()]}
        onStop={onStop}
      />,
    );
    expect(
      screen.getByRole("button", { name: /stop collaboration/i }),
    ).toBeInTheDocument();

    rerender(
      <CollabPassage
        workflowId="wf-1"
        primary="claude"
        status="paused"
        artifacts={[makeOpenConflicts()]}
        onStop={onStop}
      />,
    );
    expect(
      screen.getByRole("button", { name: /stop collaboration/i }),
    ).toBeInTheDocument();

    rerender(
      <CollabPassage
        workflowId="wf-1"
        primary="claude"
        status="converged"
        artifacts={[makeFinalAnswer()]}
        onStop={onStop}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /stop collaboration/i }),
    ).toBeNull();
  });

  it("renders 8 navigable cards when the converged stream contains drafts, cross-review, one negotiation round, open_conflicts, and final_answer", () => {
    render(
      <CollabPassage
        workflowId="wf-1"
        primary="codex"
        status="converged"
        artifacts={[
          makeAgentOneInitialDraft(),
          makeAgentTwoInitialDraft(),
          makeAgentTwoCrossReview(),
          makeAgentOneProposedChanges(),
          makeAgentTwoCounterProposalRound1(),
          makeResolutionDecisionFinal(),
          makeOpenConflicts(),
          makeFinalAnswer(),
        ]}
      />,
    );
    const hosts = document.querySelectorAll("[data-card-id]");
    expect(hosts).toHaveLength(8);
    const cardIds = Array.from(hosts).map((h) =>
      h.getAttribute("data-card-id"),
    );
    expect(cardIds[6]).toBe("open-conflicts");
    expect(cardIds[7]).toBe("final-answer");
    expect(document.querySelector('[aria-label="Card 1 of 8"]')).not.toBeNull();
  });

  it("Next button advances from open_conflicts (card 7) to final_answer (card 8)", () => {
    render(
      <CollabPassage
        workflowId="wf-1"
        primary="codex"
        status="converged"
        artifacts={[
          makeAgentOneInitialDraft(),
          makeAgentTwoInitialDraft(),
          makeAgentTwoCrossReview(),
          makeAgentOneProposedChanges(),
          makeAgentTwoCounterProposalRound1(),
          makeResolutionDecisionFinal(),
          makeOpenConflicts(),
          makeFinalAnswer(),
        ]}
      />,
    );
    const nextBtn = screen.getByRole("button", { name: /next card/i });
    for (let i = 0; i < 7; i++) {
      fireEvent.click(nextBtn);
    }
    expect(document.querySelector('[aria-label="Card 8 of 8"]')).not.toBeNull();
  });

  it("places the cross-review connector source on the lane of the reviewed draft (left when targetAgent === agent_one)", () => {
    render(
      <CollabPassage
        workflowId="wf-1"
        primary="codex"
        status="negotiating"
        artifacts={[
          makeAgentOneInitialDraft(),
          makeAgentTwoInitialDraft(),
          makeAgentTwoCrossReview(),
        ]}
      />,
    );
    const crossReviewSection = document.querySelector(
      '[data-section="cross_review"]',
    );
    expect(crossReviewSection).not.toBeNull();
    const connector = crossReviewSection!.querySelector("[data-from]");
    expect(connector).not.toBeNull();
    expect(connector?.getAttribute("data-from")).toBe("left");
    expect(connector?.getAttribute("data-to")).toBe("right");
  });

  it("data-status reflects the passage status on the article element", () => {
    render(
      <CollabPassage
        workflowId="wf-1"
        primary="codex"
        status="user-stopped"
        artifacts={[makeAgentOneInitialDraft()]}
      />,
    );
    const article = document.querySelector(
      '[aria-label="Collaboration passage"]',
    );
    expect(article?.getAttribute("data-status")).toBe("user-stopped");
    expect(article?.getAttribute("data-primary")).toBe("codex");
  });

  it("renders the errorSummary in a failure banner when status is 'failed'", () => {
    render(
      <CollabPassage
        workflowId="wf-1"
        primary="claude"
        status="failed"
        artifacts={[makeAgentTwoInitialDraft()]}
        errorSummary="agent_one initial_draft failed: Conversation not found"
      />,
    );
    const banner = document.querySelector(
      '[aria-label="Collaboration failure"]',
    );
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("Conversation not found");
  });

  it("does not render the failure banner when status is 'failed' but errorSummary is absent", () => {
    render(
      <CollabPassage
        workflowId="wf-1"
        primary="claude"
        status="failed"
        artifacts={[makeAgentOneInitialDraft()]}
      />,
    );
    expect(
      document.querySelector('[aria-label="Collaboration failure"]'),
    ).toBeNull();
  });

  it("does not render the failure banner for non-failed statuses even when errorSummary is provided", () => {
    render(
      <CollabPassage
        workflowId="wf-1"
        primary="claude"
        status="converged"
        artifacts={[makeFinalAnswer()]}
        errorSummary="lingering message"
      />,
    );
    expect(
      document.querySelector('[aria-label="Collaboration failure"]'),
    ).toBeNull();
  });

  it("clears any active phase pip when the passage has failed (no stalled spinner)", () => {
    const grouped = groupCollabArtifacts([makeAgentTwoInitialDraft()]);
    const phases = buildPhases(grouped, "failed");
    const activePhases = phases.filter((p) => p.status === "active");
    expect(activePhases).toHaveLength(0);
  });

  it("renders no phase pip with data-status='active' when status is 'failed' (DOM smoke)", () => {
    render(
      <CollabPassage
        workflowId="wf-1"
        primary="claude"
        status="failed"
        artifacts={[makeAgentTwoInitialDraft()]}
        errorSummary="agent_one initial_draft failed"
      />,
    );
    const activePips = document.querySelectorAll('li[data-status="active"]');
    expect(activePips).toHaveLength(0);
  });
});

describe("CollabPassage pending cards", () => {
  it("fills the missing lane with a pending draft card while one agent is still drafting", () => {
    render(
      <CollabPassage
        workflowId="wf-1"
        primary="claude"
        status="drafting"
        artifacts={[makeAgentOneInitialDraft()]}
      />,
    );
    const pending = document.querySelector('[data-collab-pending="true"]');
    expect(pending).not.toBeNull();
    expect(pending?.getAttribute("data-pending-kind")).toBe("initial_draft");
    expect(pending?.getAttribute("data-agent")).toBe("codex");
    expect(pending?.closest("[data-card-id]")?.getAttribute("data-lane")).toBe(
      "right",
    );
    // The finished draft and the placeholder share the one parallel drafts row.
    const draftsRow = document.querySelector('[data-row-kind="drafts"]');
    expect(draftsRow?.querySelectorAll("[data-card-id]")).toHaveLength(2);
  });

  it("shows a cross-review placeholder in agent_two's lane once both drafts have landed", () => {
    render(
      <CollabPassage
        workflowId="wf-1"
        primary="claude"
        status="drafting"
        artifacts={[makeAgentOneInitialDraft(), makeAgentTwoInitialDraft()]}
      />,
    );
    const pending = document.querySelector('[data-collab-pending="true"]');
    expect(pending?.getAttribute("data-pending-kind")).toBe("cross_review");
    expect(pending?.getAttribute("data-agent")).toBe("codex");
    expect(pending?.textContent).toContain("reviewing Claude's draft");
    // Both real drafts still render, unaffected by the placeholder.
    expect(
      document.querySelectorAll('section[data-kind="initial_draft"]'),
    ).toHaveLength(2);
  });

  it("shows a counter-proposal placeholder while agent_two answers a proposal", () => {
    render(
      <CollabPassage
        workflowId="wf-1"
        primary="claude"
        status="negotiating"
        artifacts={[makeAgentTwoCrossReview(), makeAgentOneProposedChanges()]}
      />,
    );
    const pending = document.querySelector('[data-collab-pending="true"]');
    expect(pending?.getAttribute("data-pending-kind")).toBe("counter_proposal");
    expect(pending?.getAttribute("data-agent")).toBe("codex");
    expect(pending?.closest("[data-card-id]")?.getAttribute("data-lane")).toBe(
      "right",
    );
  });

  it("renders no pending cards once the passage is terminal", () => {
    render(
      <CollabPassage
        workflowId="wf-1"
        primary="claude"
        status="converged"
        artifacts={[
          makeAgentOneInitialDraft(),
          makeAgentTwoInitialDraft(),
          makeAgentTwoCrossReview(),
          makeAgentOneProposedChanges(),
          makeAgentTwoCounterProposalRound1(),
          makeResolutionDecisionFinal(),
          makeFinalAnswer(),
        ]}
      />,
    );
    expect(document.querySelector('[data-collab-pending="true"]')).toBeNull();
  });
});

describe("CollabPassage — failed run recovery affordance", () => {
  const failedProps = {
    workflowId: "wf-1",
    primary: "claude" as const,
    status: "failed" as const,
    artifacts: [],
    errorSummary: "backend_error: provider unavailable",
  };

  it("offers a resume control for an operational failure", () => {
    const onResume = vi.fn();
    render(
      <CollabPassage
        {...failedProps}
        resumable
        failureKind="backend_error"
        onResume={onResume}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /resume collaboration/i }),
    );
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("names what failed so the user can tell an outage from a bad prompt", () => {
    render(
      <CollabPassage
        {...failedProps}
        resumable
        failureKind="quota_exhausted"
        onResume={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Collaboration failure")).toHaveTextContent(
      "quota_exhausted",
    );
  });

  // A run the agents decided to fail would reach the same conclusion again, so
  // offering a button that can only ever be refused would be a false promise.
  it("offers restart guidance instead when the failure is not resumable", () => {
    render(
      <CollabPassage {...failedProps} resumable={false} onResume={vi.fn()} />,
    );

    expect(
      screen.queryByRole("button", { name: /resume collaboration/i }),
    ).toBeNull();
    expect(screen.getByLabelText("Collaboration failure")).toHaveTextContent(
      /cannot be resumed/i,
    );
  });

  it("disables the control while a resume is in flight", () => {
    render(
      <CollabPassage
        {...failedProps}
        resumable
        onResume={vi.fn()}
        resumePending
      />,
    );
    expect(screen.getByRole("button", { name: /resuming/i })).toBeDisabled();
  });

  it("shows the server's refusal inline rather than losing it", () => {
    render(
      <CollabPassage
        {...failedProps}
        resumable
        onResume={vi.fn()}
        resumeError="This collaboration had already asked you a question."
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "already asked you a question",
    );
  });
});
