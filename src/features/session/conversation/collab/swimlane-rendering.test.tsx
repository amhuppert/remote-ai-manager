// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import {
  makeAgentOneInitialDraft,
  makeAgentTwoCrossReview,
  makeAgentTwoInitialDraft,
  makeResolutionDecisionFinal,
} from "@/lib/workflows/collaboration/test-fixtures";
import CollabInitialDraftCard from "@/features/session/conversation/collab/CollabInitialDraftCard";
import CollabCrossReviewCard from "@/features/session/conversation/collab/CollabCrossReviewCard";
import CollabResolutionDecisionCard from "@/features/session/conversation/collab/CollabResolutionDecisionCard";

describe("artifact card swimlane-ready rendering", () => {
  it("emits per-agent left rail data attributes that a swimlane can position by", () => {
    const claudeDraft = makeAgentOneInitialDraft();
    const codexDraft = makeAgentTwoInitialDraft();
    const crossReview = makeAgentTwoCrossReview();

    const { container } = render(
      <div>
        <CollabInitialDraftCard
          agent="claude"
          isPrimary
          narrative={claudeDraft.narrative}
          supporting={claudeDraft.supporting}
          assumptions={claudeDraft.assumptions}
          keyClaims={claudeDraft.keyClaims}
        />
        <CollabInitialDraftCard
          agent="codex"
          isPrimary={false}
          narrative={codexDraft.narrative}
          supporting={codexDraft.supporting}
          assumptions={codexDraft.assumptions}
          keyClaims={codexDraft.keyClaims}
        />
        <CollabCrossReviewCard
          reviewerAgent="codex"
          targetAgent="claude"
          narrative={crossReview.narrative}
          supporting={crossReview.supporting}
          agree={crossReview.agree}
          disagree={crossReview.disagree}
          reviseSelf={crossReview.reviseSelf}
        />
      </div>,
    );

    const cards = Array.from(
      container.querySelectorAll(".collab-artifact-card"),
    );
    expect(cards).toHaveLength(3);
    expect(cards.map((c) => c.getAttribute("data-agent"))).toEqual([
      "claude",
      "codex",
      "codex",
    ]);
    expect(cards.map((c) => c.getAttribute("data-kind"))).toEqual([
      "initial_draft",
      "initial_draft",
      "cross_review",
    ]);
  });

  it("renders the resolution decision through the shared collapsible chrome with a verdict pill", () => {
    const decision = makeResolutionDecisionFinal();
    const { container } = render(
      <CollabResolutionDecisionCard
        agent="claude"
        round={3}
        agreementReached={decision.agreementReached}
        nextAction={decision.nextAction}
        acceptedPoints={decision.acceptedPoints}
        resolvedDisagreements={decision.resolvedDisagreements}
        remainingDisagreements={decision.remainingDisagreements}
        userQuestions={decision.userQuestions}
        rationale={decision.rationale}
        trajectory={[3, 1, 0]}
      />,
    );

    const card = container.querySelector(".collab-artifact-card");
    expect(card).not.toBeNull();
    expect(card?.getAttribute("data-kind")).toBe("resolution_decision");
    expect(card?.getAttribute("data-agent")).toBe("claude");

    const verdict = container.querySelector(".collab-artifact-card-verdict");
    expect(verdict).not.toBeNull();
    expect(verdict?.getAttribute("data-next-action")).toBe("final");
  });
});
