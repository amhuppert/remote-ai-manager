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
          summary={claudeDraft.summary}
          artifacts={claudeDraft.artifacts}
          assumptions={claudeDraft.assumptions}
          key_claims={claudeDraft.key_claims}
        />
        <CollabInitialDraftCard
          agent="codex"
          isPrimary={false}
          summary={codexDraft.summary}
          artifacts={codexDraft.artifacts}
          assumptions={codexDraft.assumptions}
          key_claims={codexDraft.key_claims}
        />
        <CollabCrossReviewCard
          reviewerAgent="codex"
          targetAgent="claude"
          summary={crossReview.summary}
          artifacts={crossReview.artifacts}
          agree={crossReview.agree}
          disagree={crossReview.disagree}
          revise_self={crossReview.revise_self}
        />
      </div>,
    );

    const cards = Array.from(container.querySelectorAll("[data-kind]"));
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
        agreement_reached={decision.agreement_reached}
        next_action={decision.next_action}
        accepted_points={decision.accepted_points}
        resolved_disagreements={decision.resolved_disagreements}
        remaining_disagreements={decision.remaining_disagreements}
        user_questions={decision.user_questions}
        rationale={decision.rationale}
        trajectory={[3, 1, 0]}
      />,
    );

    const card = container.querySelector("[data-kind]");
    expect(card).not.toBeNull();
    expect(card?.getAttribute("data-kind")).toBe("resolution_decision");
    expect(card?.getAttribute("data-agent")).toBe("claude");

    const verdict = container.querySelector("[data-next-action]");
    expect(verdict).not.toBeNull();
    expect(verdict?.getAttribute("data-next-action")).toBe("final");
  });
});
