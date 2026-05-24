import { describe, expect, it } from "vitest";
import {
  envelopeToCollabPassageProps,
  parseCollabFeatureSnapshot,
  type CollabEnvelopeView,
} from "@/features/session/conversation/collab/envelope-adapter";
import {
  makeAgentOneInitialDraft,
  makeAgentOneProposedChanges,
  makeAgentTwoCounterProposalRound1,
  makeAgentTwoCounterProposalRound2,
  makeAgentTwoCrossReview,
  makeAgentTwoInitialDraft,
  makeFinalAnswer,
  makeOpenConflicts,
  makeResolutionDecisionAskUser,
  makeResolutionDecisionContinue,
  makeResolutionDecisionFinal,
} from "@/lib/workflows/collaboration/test-fixtures";
import type { CollaborationArtifact } from "@/lib/workflows/collaboration/types";

function makeEnvelope(
  overrides: Partial<CollabEnvelopeView> = {},
): CollabEnvelopeView {
  return {
    workflowId: "wf-test",
    status: "running",
    phase: "asymmetric_initial_drafts",
    featureSnapshot: {
      mode: "asymmetric",
      brief: "design a thing",
      primaryAgentBackend: "claude",
      primaryBackend: "claude",
      secondaryBackend: "codex",
      negotiationRounds: 3,
      negotiationRoundsCompleted: 0,
      autonomousResolutionThreshold: "major",
      artifacts: [] as CollaborationArtifact[],
      userAnswersByQuestionId: {},
    },
    ...overrides,
  };
}

describe("parseCollabFeatureSnapshot", () => {
  it("returns null when the snapshot is not an object", () => {
    expect(parseCollabFeatureSnapshot(null)).toBeNull();
    expect(parseCollabFeatureSnapshot(undefined)).toBeNull();
    expect(parseCollabFeatureSnapshot("")).toBeNull();
    expect(parseCollabFeatureSnapshot([])).toBeNull();
  });

  it("extracts the canonical fields when the asymmetric snapshot is well-formed", () => {
    const env = makeEnvelope({
      featureSnapshot: {
        ...(makeEnvelope().featureSnapshot as Record<string, unknown>),
        artifacts: [makeAgentOneInitialDraft()],
        primaryAgentBackend: "codex",
        negotiationRounds: 5,
        negotiationRoundsCompleted: 2,
        autonomousResolutionThreshold: "blocking",
        userAnswersByQuestionId: { "Q-1": "ship v1" },
      },
    });
    const parsed = parseCollabFeatureSnapshot(env.featureSnapshot);
    expect(parsed).not.toBeNull();
    expect(parsed!.primaryAgentBackend).toBe("codex");
    expect(parsed!.negotiationRounds).toBe(5);
    expect(parsed!.negotiationRoundsCompleted).toBe(2);
    expect(parsed!.autonomousResolutionThreshold).toBe("blocking");
    expect(parsed!.artifacts).toHaveLength(1);
    expect(parsed!.userAnswersByQuestionId).toEqual({ "Q-1": "ship v1" });
  });

  it("drops artifacts that do not match the discriminated union", () => {
    const parsed = parseCollabFeatureSnapshot({
      mode: "asymmetric",
      brief: "x",
      primaryAgentBackend: "claude",
      negotiationRounds: 3,
      negotiationRoundsCompleted: 0,
      autonomousResolutionThreshold: "major",
      artifacts: [makeAgentOneInitialDraft(), { kind: "garbage" }],
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.artifacts).toHaveLength(1);
  });
});

describe("envelopeToCollabPassageProps", () => {
  it("forwards the workflowId, primary backend and the parsed artifact stream", () => {
    const a1 = makeAgentOneInitialDraft();
    const a2 = makeAgentTwoInitialDraft();
    const env = makeEnvelope({
      featureSnapshot: {
        ...(makeEnvelope().featureSnapshot as Record<string, unknown>),
        artifacts: [a1, a2],
        primaryAgentBackend: "codex",
      },
    });

    const props = envelopeToCollabPassageProps(env);
    expect(props).not.toBeNull();
    expect(props!.workflowId).toBe("wf-test");
    expect(props!.primary).toBe("codex");
    expect(props!.artifacts).toHaveLength(2);
    expect(props!.artifacts[0]!.kind).toBe("initial_draft");
  });

  it("returns null when the snapshot is unparseable (non-asymmetric or missing fields)", () => {
    expect(
      envelopeToCollabPassageProps(makeEnvelope({ featureSnapshot: null })),
    ).toBeNull();
    expect(
      envelopeToCollabPassageProps(
        makeEnvelope({
          featureSnapshot: { mode: "scribe", brief: "b" } as unknown,
        }),
      ),
    ).toBeNull();
  });

  it("maps envelope.status='running' to passage status='drafting' before any cross-review artifact", () => {
    const env = makeEnvelope({
      status: "running",
      phase: "asymmetric_initial_drafts",
      featureSnapshot: {
        ...(makeEnvelope().featureSnapshot as Record<string, unknown>),
        artifacts: [makeAgentOneInitialDraft(), makeAgentTwoInitialDraft()],
      },
    });
    const props = envelopeToCollabPassageProps(env);
    expect(props!.status).toBe("drafting");
  });

  it("maps envelope.status='running' to passage status='negotiating' once cross-review or later artifacts exist", () => {
    const env = makeEnvelope({
      status: "running",
      featureSnapshot: {
        ...(makeEnvelope().featureSnapshot as Record<string, unknown>),
        artifacts: [
          makeAgentOneInitialDraft(),
          makeAgentTwoInitialDraft(),
          makeAgentTwoCrossReview(),
        ],
      },
    });
    const props = envelopeToCollabPassageProps(env);
    expect(props!.status).toBe("negotiating");
  });

  it("maps envelope.status='paused' to passage status='paused'", () => {
    const env = makeEnvelope({
      status: "paused",
      phase: "asymmetric_paused_for_user",
      featureSnapshot: {
        ...(makeEnvelope().featureSnapshot as Record<string, unknown>),
        artifacts: [
          makeAgentOneInitialDraft(),
          makeAgentTwoInitialDraft(),
          makeAgentTwoCrossReview(),
          makeAgentOneProposedChanges(),
          makeAgentTwoCounterProposalRound1(),
          makeResolutionDecisionAskUser(),
          makeOpenConflicts(),
        ],
      },
    });
    const props = envelopeToCollabPassageProps(env);
    expect(props!.status).toBe("paused");
  });

  it("maps envelope.status='completed' + phase='asymmetric_completed_final' to 'converged'", () => {
    const env = makeEnvelope({
      status: "completed",
      phase: "asymmetric_completed_final",
      featureSnapshot: {
        ...(makeEnvelope().featureSnapshot as Record<string, unknown>),
        artifacts: [
          makeAgentOneInitialDraft(),
          makeAgentTwoInitialDraft(),
          makeAgentTwoCrossReview(),
          makeAgentOneProposedChanges(),
          makeAgentTwoCounterProposalRound1(),
          makeResolutionDecisionFinal(),
          makeFinalAnswer(),
        ],
      },
    });
    const props = envelopeToCollabPassageProps(env);
    expect(props!.status).toBe("converged");
  });

  it("maps envelope.status='completed' + phase='asymmetric_user_stopped' to 'user-stopped'", () => {
    const env = makeEnvelope({
      status: "completed",
      phase: "asymmetric_user_stopped",
      featureSnapshot: {
        ...(makeEnvelope().featureSnapshot as Record<string, unknown>),
        artifacts: [makeAgentOneInitialDraft()],
      },
    });
    const props = envelopeToCollabPassageProps(env);
    expect(props!.status).toBe("user-stopped");
  });

  it("maps envelope.status='failed' to 'failed' regardless of phase", () => {
    const env = makeEnvelope({
      status: "failed",
      phase: "failed_agent_two",
      featureSnapshot: {
        ...(makeEnvelope().featureSnapshot as Record<string, unknown>),
        artifacts: [makeAgentOneInitialDraft()],
      },
    });
    const props = envelopeToCollabPassageProps(env);
    expect(props!.status).toBe("failed");
  });

  it("forwards envelope.errorSummary onto the passage props so the UI can surface failure causes", () => {
    const env = makeEnvelope({
      status: "failed",
      phase: "failed_agent_one",
      errorSummary: "agent_one initial_draft failed: Conversation not found",
      featureSnapshot: {
        ...(makeEnvelope().featureSnapshot as Record<string, unknown>),
        artifacts: [makeAgentTwoInitialDraft()],
      },
    });
    const props = envelopeToCollabPassageProps(env);
    expect(props!.errorSummary).toBe(
      "agent_one initial_draft failed: Conversation not found",
    );
  });

  it("leaves errorSummary undefined for non-failed envelopes", () => {
    const env = makeEnvelope({ status: "running" });
    const props = envelopeToCollabPassageProps(env);
    expect(props!.errorSummary).toBeUndefined();
  });

  it("preserves the artifact order for the renderer", () => {
    const sequence: CollaborationArtifact[] = [
      makeAgentOneInitialDraft(),
      makeAgentTwoInitialDraft(),
      makeAgentTwoCrossReview(),
      makeAgentOneProposedChanges(),
      makeAgentTwoCounterProposalRound1(),
      makeResolutionDecisionContinue(),
      makeAgentOneProposedChanges({ narrative: "R2 proposed" }),
      makeAgentTwoCounterProposalRound2(),
      makeResolutionDecisionFinal(),
      makeFinalAnswer(),
    ];
    const env = makeEnvelope({
      status: "completed",
      phase: "asymmetric_completed_final",
      featureSnapshot: {
        ...(makeEnvelope().featureSnapshot as Record<string, unknown>),
        artifacts: sequence,
      },
    });
    const props = envelopeToCollabPassageProps(env);
    expect(props!.artifacts.map((a) => a.kind)).toEqual([
      "initial_draft",
      "initial_draft",
      "cross_review",
      "proposed_changes",
      "counter_proposal",
      "resolution_decision",
      "proposed_changes",
      "counter_proposal",
      "resolution_decision",
      "final_answer",
    ]);
  });
});
