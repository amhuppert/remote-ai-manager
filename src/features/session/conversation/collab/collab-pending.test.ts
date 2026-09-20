import { describe, expect, it } from "vitest";
import { groupCollabArtifacts } from "@/features/session/conversation/collab/CollabPassage";
import { deriveCollabPendingSteps } from "@/features/session/conversation/collab/collab-pending";
import type { CollabPassageStatus } from "@/features/session/conversation/collab/envelope-adapter";
import {
  makeAgentOneInitialDraft,
  makeAgentOneProposedChanges,
  makeAgentTwoCounterProposalRound1,
  makeAgentTwoCrossReview,
  makeAgentTwoInitialDraft,
  makeResolutionDecisionAskUser,
  makeResolutionDecisionContinue,
  makeResolutionDecisionFail,
  makeResolutionDecisionFinal,
} from "@/lib/workflows/collaboration/test-fixtures";
import type {
  CollaborationAgent,
  CollaborationArtifact,
} from "@/lib/workflows/collaboration/types";

function pendingFor(
  artifacts: CollaborationArtifact[],
  status: CollabPassageStatus,
  primary: CollaborationAgent = "claude",
) {
  return deriveCollabPendingSteps(
    groupCollabArtifacts(artifacts),
    status,
    primary,
  );
}

describe("deriveCollabPendingSteps", () => {
  it("returns nothing once the passage is terminal or paused", () => {
    const artifacts = [makeAgentOneInitialDraft()];
    for (const status of [
      "paused",
      "converged",
      "unresolved",
      "user-stopped",
      "failed",
    ] as CollabPassageStatus[]) {
      expect(pendingFor(artifacts, status)).toEqual([]);
    }
  });

  it("shows both draft placeholders before any draft lands", () => {
    const steps = pendingFor([], "drafting");
    expect(steps.map((s) => s.id)).toEqual([
      "pending-draft-primary",
      "pending-draft-secondary",
    ]);
    expect(steps.map((s) => s.lane)).toEqual(["left", "right"]);
    expect(steps.map((s) => s.agent)).toEqual(["claude", "codex"]);
    expect(steps.every((s) => s.mergeIntoDraftsRow)).toBe(true);
    expect(steps.every((s) => s.statusText === "drafting")).toBe(true);
  });

  it("labels a Cursor-initiated run's pending drafts as Cursor and its default partner", () => {
    const steps = pendingFor([], "drafting", "cursor");
    expect(steps.map((s) => s.agent)).toEqual(["cursor", "claude"]);
  });

  it("shows only the missing lane's draft when one draft has landed", () => {
    const primaryOnly = pendingFor([makeAgentOneInitialDraft()], "drafting");
    expect(primaryOnly).toHaveLength(1);
    expect(primaryOnly[0]!.id).toBe("pending-draft-secondary");
    expect(primaryOnly[0]!.agent).toBe("codex");
    expect(primaryOnly[0]!.lane).toBe("right");

    const secondaryOnly = pendingFor([makeAgentTwoInitialDraft()], "drafting");
    expect(secondaryOnly).toHaveLength(1);
    expect(secondaryOnly[0]!.id).toBe("pending-draft-primary");
    expect(secondaryOnly[0]!.agent).toBe("claude");
    expect(secondaryOnly[0]!.lane).toBe("left");
  });

  it("shows agent_two's cross-review once both drafts land (drafting status, no negotiation beat)", () => {
    const steps = pendingFor(
      [makeAgentOneInitialDraft(), makeAgentTwoInitialDraft()],
      "drafting",
    );
    expect(steps).toHaveLength(1);
    const step = steps[0]!;
    expect(step.kind).toBe("cross_review");
    expect(step.agent).toBe("codex");
    expect(step.lane).toBe("right");
    expect(step.sourceLaneOverride).toBe("left");
    expect(step.statusText).toBe("reviewing Claude's draft");
  });

  it("names the reviewed draft by the primary backend label when primary is codex", () => {
    const steps = pendingFor(
      [makeAgentOneInitialDraft(), makeAgentTwoInitialDraft()],
      "drafting",
      "codex",
    );
    expect(steps[0]!.agent).toBe("claude"); // agent_two under codex primary
    expect(steps[0]!.statusText).toBe("reviewing Codex's draft");
  });

  it("shows agent_one's first proposed changes once cross-review lands", () => {
    const steps = pendingFor(
      [
        makeAgentOneInitialDraft(),
        makeAgentTwoInitialDraft(),
        makeAgentTwoCrossReview(),
      ],
      "negotiating",
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]!.kind).toBe("proposed_changes");
    expect(steps[0]!.agent).toBe("claude");
    expect(steps[0]!.lane).toBe("left");
    expect(steps[0]!.round).toBe(1);
  });

  it("shows agent_two's counter-proposal when a round has proposed changes but no counter", () => {
    const steps = pendingFor(
      [makeAgentTwoCrossReview(), makeAgentOneProposedChanges()],
      "negotiating",
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]!.kind).toBe("counter_proposal");
    expect(steps[0]!.agent).toBe("codex");
    expect(steps[0]!.lane).toBe("right");
    expect(steps[0]!.round).toBe(1);
  });

  it("shows agent_one's resolution decision when proposed + counter are present but undecided", () => {
    const steps = pendingFor(
      [
        makeAgentTwoCrossReview(),
        makeAgentOneProposedChanges(),
        makeAgentTwoCounterProposalRound1(),
      ],
      "negotiating",
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]!.kind).toBe("resolution_decision");
    expect(steps[0]!.agent).toBe("claude");
    expect(steps[0]!.lane).toBe("full");
    expect(steps[0]!.round).toBe(1);
  });

  it("opens the next round's proposed changes after a continue decision", () => {
    const steps = pendingFor(
      [
        makeAgentTwoCrossReview(),
        makeAgentOneProposedChanges(),
        makeAgentTwoCounterProposalRound1(),
        makeResolutionDecisionContinue(),
      ],
      "negotiating",
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]!.kind).toBe("proposed_changes");
    expect(steps[0]!.round).toBe(2);
  });

  it("composes the final answer after a final decision", () => {
    const steps = pendingFor(
      [
        makeAgentTwoCrossReview(),
        makeAgentOneProposedChanges(),
        makeAgentTwoCounterProposalRound1(),
        makeResolutionDecisionFinal(),
      ],
      "negotiating",
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]!.kind).toBe("final_answer");
    expect(steps[0]!.agent).toBe("claude");
    expect(steps[0]!.lane).toBe("full");
  });

  it("shows no placeholder after an ask_user or fail decision (the run pauses or ends)", () => {
    const base = [
      makeAgentTwoCrossReview(),
      makeAgentOneProposedChanges(),
      makeAgentTwoCounterProposalRound1(),
    ];
    expect(
      pendingFor([...base, makeResolutionDecisionAskUser()], "negotiating"),
    ).toEqual([]);
    expect(
      pendingFor([...base, makeResolutionDecisionFail()], "negotiating"),
    ).toEqual([]);
  });
});
