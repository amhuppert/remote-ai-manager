// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import CollabPassage, {
  flowAgentToBackend,
  groupCollabArtifacts,
  isCollabPassageTerminal,
  trajectoryThroughRound,
} from "./CollabPassage";
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
      makeAgentOneProposedChanges({ narrative: "R2 proposed" }),
      makeAgentTwoCounterProposalRound2(),
      makeResolutionDecisionFinal(),
    ];
    const grouped = groupCollabArtifacts(artifacts);
    expect(grouped.rounds).toHaveLength(2);
    expect(grouped.rounds[0]!.round).toBe(1);
    expect(grouped.rounds[0]!.decision?.nextAction).toBe(
      "continue_negotiation",
    );
    expect(grouped.rounds[1]!.round).toBe(2);
    expect(grouped.rounds[1]!.decision?.nextAction).toBe("final");
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
      makeAgentOneProposedChanges({ narrative: "R2 proposed" }),
      makeAgentTwoCounterProposalRound2(),
      makeResolutionDecisionFinal(),
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
      '.collab-artifact-card[data-kind="initial_draft"]',
    );
    expect(drafts).toHaveLength(2);
    expect(
      document.querySelector(".collab-artifact-card-primary-flag"),
    ).not.toBeNull();
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
      '.collab-artifact-card[data-kind="resolution_decision"]',
    );
    expect(decisionCard).not.toBeNull();
    const decisionHost = decisionCard!.closest(".collab-card-host");
    expect(decisionHost).not.toBeNull();
    expect(decisionHost?.getAttribute("data-lane")).toBe("full");
  });

  // Parallel beats (the two initial drafts) share a single
  // `.collab-passage-row` so the two-column grid binds them into one row.
  it("groups both initial drafts as siblings inside one .collab-passage-row", () => {
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
    const rows = draftSection!.querySelectorAll(
      '.collab-passage-row[data-row-kind="drafts"]',
    );
    expect(rows).toHaveLength(1);
    const draftsInRow = rows[0]!.querySelectorAll(
      '.collab-artifact-card[data-kind="initial_draft"]',
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
      '.collab-artifact-card[data-kind="proposed_changes"]',
    );
    const counter = roundSection!.querySelector(
      '.collab-artifact-card[data-kind="counter_proposal"]',
    );
    expect(proposed).not.toBeNull();
    expect(counter).not.toBeNull();
    expect(
      proposed!.closest(".collab-card-host")?.getAttribute("data-lane"),
    ).toBe("left");
    expect(
      counter!.closest(".collab-card-host")?.getAttribute("data-lane"),
    ).toBe("right");
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
    const connectors = document.querySelectorAll(".collab-connector");
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
    expect(
      document.querySelector(".collab-final-answer-message"),
    ).not.toBeNull();
  });

  it("renders an inline phase strip by default and hides it when hideInlinePhaseStrip is true", () => {
    const props = {
      workflowId: "wf-1",
      primary: "claude" as const,
      status: "drafting" as const,
      artifacts: [makeAgentOneInitialDraft()],
    };
    const { rerender } = render(<CollabPassage {...props} />);
    expect(document.querySelector(".collab-phase-strip")).not.toBeNull();
    rerender(<CollabPassage {...props} hideInlinePhaseStrip />);
    expect(document.querySelector(".collab-phase-strip")).toBeNull();
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
    const hosts = document.querySelectorAll(".collab-card-host");
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
    const connector = crossReviewSection!.querySelector(".collab-connector");
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
    const article = document.querySelector(".collab-passage");
    expect(article?.getAttribute("data-status")).toBe("user-stopped");
    expect(article?.getAttribute("data-primary")).toBe("codex");
  });
});
