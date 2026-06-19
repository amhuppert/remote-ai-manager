/**
 * Tests for the workflow-scoped collaboration envelope (Task 3.1).
 *
 * The envelope is exercised through stubbed policy + collaborator-caller deps
 * so the round/decision logic is observable in isolation, and persisted
 * snapshots are read back through the discriminated feature-snapshot schema
 * to verify the workflow-origin variant.
 */

import { describe, expect, it, vi } from "vitest";
import { createInMemoryWorkflowEnvelopeStore } from "@/lib/workflows/primitives/workflow-envelope-store";
import {
  createStatusBus,
  type StatusBusEnvelope,
} from "@/lib/workflows/primitives/status-bus";
import {
  collaborationFeatureSnapshotSchema,
  type CollaborationFeatureSnapshotWorkflow,
  type CollaborationWorkflowArtifactEntry,
} from "./feature-snapshot";
import {
  createWorkflowCollaborationEnvelope,
  type WorkflowCollaborationEnvelopeDeps,
} from "./workflow-envelope";
import type { CollaborationPolicyDecision } from "./policy";
import type { TranscriptEntry } from "@/lib/prompt/transcript";
import type {
  CollaborationCounterProposalOutput,
  CollaborationCrossReviewOutput,
  CollaborationFinalAnswerOutput,
  CollaborationInitialDraftOutput,
  CollaborationProposedChangesOutput,
  CollaborationResolutionDecisionOutput,
  ResolvedCollaborationConfig,
} from "@/lib/workflows/schemas";

const RESOLVED_CONFIG: ResolvedCollaborationConfig = {
  secondAgent: {
    value: { backend: "codex", model: "gpt-5.4", reasoningEffort: "medium" },
    source: "global",
  },
  negotiationRounds: { value: 3, source: "workflow" },
  autonomousResolutionThreshold: { value: "minor", source: "per-node" },
};

const AGENT_ONE_DRAFT: CollaborationInitialDraftOutput = {
  kind: "initial_draft",
  agent: "agent_one",
  narrative: "agent_one draft narrative",
  report: "agent_one draft report",
  supporting: [],
  assumptions: [],
  keyClaims: [],
};

const AGENT_TWO_DRAFT: CollaborationInitialDraftOutput = {
  kind: "initial_draft",
  agent: "agent_two",
  narrative: "agent_two draft narrative",
  report: "agent_two draft report",
  supporting: [],
  assumptions: [],
  keyClaims: [],
};

const AGENT_TWO_CROSS_REVIEW: CollaborationCrossReviewOutput = {
  kind: "cross_review",
  agent: "agent_two",
  targetAgent: "agent_one",
  narrative: "agent_two cross review narrative",
  report: "agent_two cross review report",
  supporting: [],
  agree: [],
  disagree: [],
  reviseSelf: [],
};

const PROPOSED_CHANGES: CollaborationProposedChangesOutput = {
  kind: "proposed_changes",
  agent: "agent_one",
  targetAgent: "agent_two",
  narrative: "agent_one proposed changes narrative",
  acceptedFromAgentTwoDraft: [],
  proposedChanges: [],
  remainingDisagreements: [],
  report: "agent_one proposed changes report",
  supporting: [],
};

const COUNTER_PROPOSAL: CollaborationCounterProposalOutput = {
  kind: "counter_proposal",
  agent: "agent_two",
  narrative: "agent_two counter proposal narrative",
  acceptedProposedChangeIds: [],
  rejectedProposedChangeIds: [],
  alternativeChanges: [],
  agree: [],
  disagree: [],
  report: "agent_two counter proposal report",
  supporting: [],
};

const RESOLUTION_AGREED: CollaborationResolutionDecisionOutput = {
  kind: "resolution_decision",
  agent: "agent_one",
  agreementReached: true,
  nextAction: "final",
  acceptedPoints: [],
  resolvedDisagreements: [],
  remainingDisagreements: [],
  userQuestions: [],
  rationale: "agreed",
};

const FINAL_ANSWER: CollaborationFinalAnswerOutput = {
  kind: "final_answer",
  agent: "agent_one",
  answer: "Adopt Postgres for the new service tier.",
  report: "Both agents agreed on Postgres after one round.",
  supporting: ["durability requirements"],
};

const FINAL_ANSWER_SHORT: CollaborationFinalAnswerOutput = {
  kind: "final_answer",
  agent: "agent_one",
  answer: "Adopt Postgres.",
  report: "agreed on Postgres",
  supporting: [],
};

const FINAL_ANSWER_GENERIC: CollaborationFinalAnswerOutput = {
  kind: "final_answer",
  agent: "agent_one",
  answer: "Final.",
  report: "Final report.",
  supporting: [],
};

const FINAL_ANSWER_X: CollaborationFinalAnswerOutput = {
  kind: "final_answer",
  agent: "agent_one",
  answer: "x",
  report: "x",
  supporting: [],
};

const RESOLUTION_WITH_OBJECTIVE_DISAGREEMENT: CollaborationResolutionDecisionOutput =
  {
    kind: "resolution_decision",
    agent: "agent_one",
    agreementReached: false,
    nextAction: "ask_user",
    acceptedPoints: [],
    resolvedDisagreements: [],
    remainingDisagreements: [
      {
        id: "d1",
        category: "objective",
        severity: "blocking",
        claim: "Postgres vs MySQL is the wrong dichotomy",
        reason: "User goal is unclear; need clarification",
      },
    ],
    userQuestions: [],
    rationale: "objective disagreement",
  };

function makeRoundOutput(resolution: CollaborationResolutionDecisionOutput): {
  proposedChanges: CollaborationProposedChangesOutput;
  counterProposal: CollaborationCounterProposalOutput;
  resolution: CollaborationResolutionDecisionOutput;
} {
  return {
    proposedChanges: PROPOSED_CHANGES,
    counterProposal: COUNTER_PROPOSAL,
    resolution,
  };
}

function buildBaselineDeps(overrides?: {
  policyDecide?: WorkflowCollaborationEnvelopeDeps["policyDecide"];
  collaboratorCaller?: WorkflowCollaborationEnvelopeDeps["collaboratorCaller"];
  appendArtifact?: WorkflowCollaborationEnvelopeDeps["appendArtifact"];
}): WorkflowCollaborationEnvelopeDeps {
  const envelopeStore = createInMemoryWorkflowEnvelopeStore();
  return {
    ...(overrides?.appendArtifact
      ? { appendArtifact: overrides.appendArtifact }
      : {}),
    envelopeStore,
    policyDecide:
      overrides?.policyDecide ??
      vi.fn(() => ({ kind: "final" }) satisfies CollaborationPolicyDecision),
    collaboratorCaller: overrides?.collaboratorCaller ?? {
      runInitialDrafts: vi.fn(async () => ({
        agentOneDraft: AGENT_ONE_DRAFT,
        agentTwoDraft: AGENT_TWO_DRAFT,
      })),
      runCrossReview: vi.fn(async () => ({
        agentTwoCrossReview: AGENT_TWO_CROSS_REVIEW,
      })),
      runRound: vi.fn(async () => makeRoundOutput(RESOLUTION_AGREED)),
      generateFinalAnswer: vi.fn(async () => ({
        finalAnswer: FINAL_ANSWER,
      })),
    },
    now: () => "2026-05-31T00:00:00.000Z",
    workflowIdFactory: () => "wf-collab-test-1",
  };
}

const START_ARGS = {
  brief: "Should we adopt Postgres?",
  resolvedConfig: RESOLVED_CONFIG,
  parentImplementerTurnId: "turn-7",
  executionContextId: "context-implement",
  conversationId: "conv-abc",
  executionId: "execution-1",
  iterationIndex: 0,
} as const;

describe("createWorkflowCollaborationEnvelope", () => {
  describe("happy path: policy returns final on the first round", () => {
    it("returns status converged with a non-empty finalAnswer", async () => {
      const deps = buildBaselineDeps();
      const envelope = createWorkflowCollaborationEnvelope(deps);

      const { result, roundsConsumed } = await envelope.start(START_ARGS);

      expect(result.status).toBe("converged");
      expect(result.finalAnswer).toBe(
        "Adopt Postgres for the new service tier.",
      );
      expect(result.openConflicts).toEqual([]);
      expect(roundsConsumed).toBe(1);
    });

    it("invokes all four phases in order: initial drafts, cross-review, runRound, final answer", async () => {
      const runInitialDrafts = vi.fn(async () => ({
        agentOneDraft: AGENT_ONE_DRAFT,
        agentTwoDraft: AGENT_TWO_DRAFT,
      }));
      const runCrossReview = vi.fn(async () => ({
        agentTwoCrossReview: AGENT_TWO_CROSS_REVIEW,
      }));
      const runRound = vi.fn(async () => makeRoundOutput(RESOLUTION_AGREED));
      const generateFinalAnswer = vi.fn(async () => ({
        finalAnswer: FINAL_ANSWER_GENERIC,
      }));
      const deps = buildBaselineDeps({
        collaboratorCaller: {
          runInitialDrafts,
          runCrossReview,
          runRound,
          generateFinalAnswer,
        },
      });

      await createWorkflowCollaborationEnvelope(deps).start(START_ARGS);

      expect(runInitialDrafts).toHaveBeenCalledTimes(1);
      expect(runCrossReview).toHaveBeenCalledTimes(1);
      expect(runRound).toHaveBeenCalledTimes(1);
      expect(generateFinalAnswer).toHaveBeenCalledTimes(1);
    });

    it("threads the initial drafts and cross-review into the round and final-answer calls", async () => {
      const runRound = vi.fn(async () => makeRoundOutput(RESOLUTION_AGREED));
      const generateFinalAnswer = vi.fn(async () => ({
        finalAnswer: FINAL_ANSWER_GENERIC,
      }));
      const deps = buildBaselineDeps({
        collaboratorCaller: {
          runInitialDrafts: vi.fn(async () => ({
            agentOneDraft: AGENT_ONE_DRAFT,
            agentTwoDraft: AGENT_TWO_DRAFT,
          })),
          runCrossReview: vi.fn(async () => ({
            agentTwoCrossReview: AGENT_TWO_CROSS_REVIEW,
          })),
          runRound,
          generateFinalAnswer,
        },
      });

      await createWorkflowCollaborationEnvelope(deps).start(START_ARGS);

      expect(runRound).toHaveBeenCalledWith(
        expect.objectContaining({
          round: 1,
          brief: "Should we adopt Postgres?",
          agentOneDraft: AGENT_ONE_DRAFT,
          agentTwoDraft: AGENT_TWO_DRAFT,
          agentTwoCrossReview: AGENT_TWO_CROSS_REVIEW,
        }),
      );
      expect(generateFinalAnswer).toHaveBeenCalledWith(
        expect.objectContaining({
          brief: "Should we adopt Postgres?",
          agentOneDraft: AGENT_ONE_DRAFT,
          agentTwoDraft: AGENT_TWO_DRAFT,
          latestCounterProposal: COUNTER_PROPOSAL,
          latestResolutionDecision: RESOLUTION_AGREED,
        }),
      );
    });

    it("invokes the policy decider with the negotiation rounds remaining count", async () => {
      const policyDecide = vi.fn(() => ({
        kind: "final" as const,
      }));
      const deps = buildBaselineDeps({ policyDecide });

      await createWorkflowCollaborationEnvelope(deps).start(START_ARGS);

      expect(policyDecide).toHaveBeenCalledWith(
        expect.objectContaining({
          autonomousResolutionThreshold: "minor",
          negotiationRoundsRemaining: 2,
        }),
      );
    });

    it("writes a workflow-origin snapshot that parses through the discriminated schema", async () => {
      const deps = buildBaselineDeps();
      await createWorkflowCollaborationEnvelope(deps).start(START_ARGS);

      const persisted = await deps.envelopeStore.read("wf-collab-test-1");
      expect(persisted).not.toBeNull();
      const parsed = collaborationFeatureSnapshotSchema.parse(
        persisted?.featureSnapshot,
      );
      expect(parsed.origin).toBe("workflow");
      const workflowSnapshot = parsed as CollaborationFeatureSnapshotWorkflow;
      expect(workflowSnapshot.parentImplementerTurnId).toBe("turn-7");
      expect(workflowSnapshot.executionContextId).toBe("context-implement");
      expect(workflowSnapshot.conversationId).toBe("conv-abc");
      expect(workflowSnapshot.resolvedConfig.negotiationRounds.value).toBe(3);
      expect(workflowSnapshot.resolvedConfig.negotiationRounds.source).toBe(
        "workflow",
      );
    });

    it("marks the envelope completed on a converged terminal decision", async () => {
      const deps = buildBaselineDeps();
      await createWorkflowCollaborationEnvelope(deps).start(START_ARGS);

      const persisted = await deps.envelopeStore.read("wf-collab-test-1");
      expect(persisted?.status).toBe("completed");
      expect(persisted?.completedAt).toBe("2026-05-31T00:00:00.000Z");
    });
  });

  describe("non-converged terminal decision (objective_disagreement)", () => {
    it("returns status objective_disagreement with at least one openConflict", async () => {
      const deps = buildBaselineDeps({
        policyDecide: vi.fn(
          () =>
            ({
              kind: "ask_user",
              reason: "objective_disagreement",
            }) satisfies CollaborationPolicyDecision,
        ),
        collaboratorCaller: {
          runInitialDrafts: vi.fn(async () => ({
            agentOneDraft: AGENT_ONE_DRAFT,
            agentTwoDraft: AGENT_TWO_DRAFT,
          })),
          runCrossReview: vi.fn(async () => ({
            agentTwoCrossReview: AGENT_TWO_CROSS_REVIEW,
          })),
          runRound: vi.fn(async () =>
            makeRoundOutput(RESOLUTION_WITH_OBJECTIVE_DISAGREEMENT),
          ),
          generateFinalAnswer: vi.fn(async () => {
            throw new Error(
              "generateFinalAnswer must not be called for non-converged paths",
            );
          }),
        },
      });

      const { result } =
        await createWorkflowCollaborationEnvelope(deps).start(START_ARGS);

      expect(result.status).toBe("objective_disagreement");
      expect(result.finalAnswer).toBeNull();
      expect(result.openConflicts.length).toBeGreaterThan(0);
      expect(result.openConflicts[0]?.category).toBe("objective");
      expect(result.openConflicts[0]?.severity).toBe("blocking");
    });

    it("does not call generateFinalAnswer on non-converged paths", async () => {
      const generateFinalAnswer = vi.fn(async () => ({
        finalAnswer: FINAL_ANSWER_X,
      }));
      const deps = buildBaselineDeps({
        policyDecide: vi.fn(
          () =>
            ({
              kind: "ask_user",
              reason: "objective_disagreement",
            }) satisfies CollaborationPolicyDecision,
        ),
        collaboratorCaller: {
          runInitialDrafts: vi.fn(async () => ({
            agentOneDraft: AGENT_ONE_DRAFT,
            agentTwoDraft: AGENT_TWO_DRAFT,
          })),
          runCrossReview: vi.fn(async () => ({
            agentTwoCrossReview: AGENT_TWO_CROSS_REVIEW,
          })),
          runRound: vi.fn(async () =>
            makeRoundOutput(RESOLUTION_WITH_OBJECTIVE_DISAGREEMENT),
          ),
          generateFinalAnswer,
        },
      });

      await createWorkflowCollaborationEnvelope(deps).start(START_ARGS);

      expect(generateFinalAnswer).not.toHaveBeenCalled();
    });
  });

  describe("multi-round loop: policy continues then finalizes", () => {
    it("runs the configured number of rounds until policy returns terminal", async () => {
      let callCount = 0;
      const policyDecide = vi.fn((): CollaborationPolicyDecision => {
        callCount++;
        if (callCount < 2) return { kind: "continue_negotiation" };
        return { kind: "final" };
      });
      const runRound = vi.fn(async () => makeRoundOutput(RESOLUTION_AGREED));
      const deps = buildBaselineDeps({
        policyDecide,
        collaboratorCaller: {
          runInitialDrafts: vi.fn(async () => ({
            agentOneDraft: AGENT_ONE_DRAFT,
            agentTwoDraft: AGENT_TWO_DRAFT,
          })),
          runCrossReview: vi.fn(async () => ({
            agentTwoCrossReview: AGENT_TWO_CROSS_REVIEW,
          })),
          runRound,
          generateFinalAnswer: vi.fn(async () => ({
            finalAnswer: FINAL_ANSWER_GENERIC,
          })),
        },
      });

      const { result, roundsConsumed } =
        await createWorkflowCollaborationEnvelope(deps).start(START_ARGS);

      expect(runRound).toHaveBeenCalledTimes(2);
      expect(policyDecide).toHaveBeenCalledTimes(2);
      expect(result.status).toBe("converged");
      expect(roundsConsumed).toBe(2);
    });

    it("stops after the configured negotiationRounds even if policy keeps continuing", async () => {
      const policyDecide = vi.fn(
        (): CollaborationPolicyDecision => ({
          kind: "continue_negotiation",
        }),
      );
      const runRound = vi.fn(async () =>
        makeRoundOutput(RESOLUTION_WITH_OBJECTIVE_DISAGREEMENT),
      );
      const deps = buildBaselineDeps({
        policyDecide,
        collaboratorCaller: {
          runInitialDrafts: vi.fn(async () => ({
            agentOneDraft: AGENT_ONE_DRAFT,
            agentTwoDraft: AGENT_TWO_DRAFT,
          })),
          runCrossReview: vi.fn(async () => ({
            agentTwoCrossReview: AGENT_TWO_CROSS_REVIEW,
          })),
          runRound,
          generateFinalAnswer: vi.fn(async () => ({
            finalAnswer: FINAL_ANSWER_X,
          })),
        },
      });

      const envelope = createWorkflowCollaborationEnvelope(deps);

      await expect(envelope.start(START_ARGS)).rejects.toThrow(
        /continue_negotiation/,
      );
      expect(runRound).toHaveBeenCalledTimes(3);
    });
  });

  describe("snapshot round-trip via discriminated parser", () => {
    it("persists secondAgent provenance on the workflow snapshot", async () => {
      const deps = buildBaselineDeps();
      await createWorkflowCollaborationEnvelope(deps).start(START_ARGS);

      const persisted = await deps.envelopeStore.read("wf-collab-test-1");
      const parsed = collaborationFeatureSnapshotSchema.parse(
        persisted?.featureSnapshot,
      );
      if (parsed.origin !== "workflow") throw new Error("expected workflow");
      expect(parsed.resolvedConfig.secondAgent.source).toBe("global");
      expect(parsed.resolvedConfig.secondAgent.value.backend).toBe("codex");
    });
  });

  describe("artifact stream persistence", () => {
    it("appends every phase output to the sidecar in order on the converged path, and keeps them out of the persisted envelope blob", async () => {
      const appended: CollaborationWorkflowArtifactEntry[] = [];
      const deps = buildBaselineDeps({
        appendArtifact: async (_workflowId, entry) => {
          appended.push(entry);
        },
      });
      await createWorkflowCollaborationEnvelope(deps).start(START_ARGS);

      expect(appended.map((a) => a.kind)).toEqual([
        "initial_draft",
        "initial_draft",
        "cross_review",
        "proposed_changes",
        "counter_proposal",
        "resolution_decision",
        "final_answer",
      ]);

      const initialDrafts = appended.filter((a) => a.kind === "initial_draft");
      expect(initialDrafts.map((a) => a.agent).sort()).toEqual([
        "agent_one",
        "agent_two",
      ]);

      const finalAnswer = appended.find((a) => a.kind === "final_answer");
      if (!finalAnswer || finalAnswer.kind !== "final_answer") {
        throw new Error("expected final_answer artifact");
      }
      expect(finalAnswer.value.answer).toBe(
        "Adopt Postgres for the new service tier.",
      );

      // The unbounded artifact stream must no longer ride inside the envelope
      // blob — that round-trip cost is exactly what the sidecar removes.
      const persisted = await deps.envelopeStore.read("wf-collab-test-1");
      expect(
        (persisted?.featureSnapshot as Record<string, unknown>)["artifacts"],
      ).toBeUndefined();
    });

    it("appends per-round artifacts with monotonic round numbers across multiple rounds", async () => {
      let callCount = 0;
      const policyDecide = vi.fn((): CollaborationPolicyDecision => {
        callCount++;
        if (callCount < 2) return { kind: "continue_negotiation" };
        return { kind: "final" };
      });
      const appended: CollaborationWorkflowArtifactEntry[] = [];
      const deps = buildBaselineDeps({
        policyDecide,
        appendArtifact: async (_workflowId, entry) => {
          appended.push(entry);
        },
        collaboratorCaller: {
          runInitialDrafts: vi.fn(async () => ({
            agentOneDraft: AGENT_ONE_DRAFT,
            agentTwoDraft: AGENT_TWO_DRAFT,
          })),
          runCrossReview: vi.fn(async () => ({
            agentTwoCrossReview: AGENT_TWO_CROSS_REVIEW,
          })),
          runRound: vi.fn(async () => makeRoundOutput(RESOLUTION_AGREED)),
          generateFinalAnswer: vi.fn(async () => ({
            finalAnswer: FINAL_ANSWER_SHORT,
          })),
        },
      });

      await createWorkflowCollaborationEnvelope(deps).start(START_ARGS);

      const proposedRounds = appended
        .filter((a) => a.kind === "proposed_changes")
        .map((a) => (a.kind === "proposed_changes" ? a.round : -1));
      expect(proposedRounds).toEqual([1, 2]);

      const counterRounds = appended
        .filter((a) => a.kind === "counter_proposal")
        .map((a) => (a.kind === "counter_proposal" ? a.round : -1));
      expect(counterRounds).toEqual([1, 2]);

      const resolutionRounds = appended
        .filter((a) => a.kind === "resolution_decision")
        .map((a) => (a.kind === "resolution_decision" ? a.round : -1));
      expect(resolutionRounds).toEqual([1, 2]);
    });

    it("omits the final_answer artifact when the run terminates without a final answer", async () => {
      const appended: CollaborationWorkflowArtifactEntry[] = [];
      const deps = buildBaselineDeps({
        appendArtifact: async (_workflowId, entry) => {
          appended.push(entry);
        },
        policyDecide: vi.fn(
          () =>
            ({
              kind: "ask_user",
              reason: "objective_disagreement",
            }) satisfies CollaborationPolicyDecision,
        ),
        collaboratorCaller: {
          runInitialDrafts: vi.fn(async () => ({
            agentOneDraft: AGENT_ONE_DRAFT,
            agentTwoDraft: AGENT_TWO_DRAFT,
          })),
          runCrossReview: vi.fn(async () => ({
            agentTwoCrossReview: AGENT_TWO_CROSS_REVIEW,
          })),
          runRound: vi.fn(async () =>
            makeRoundOutput(RESOLUTION_WITH_OBJECTIVE_DISAGREEMENT),
          ),
          generateFinalAnswer: vi.fn(async () => ({
            finalAnswer: FINAL_ANSWER_X,
          })),
        },
      });

      await createWorkflowCollaborationEnvelope(deps).start(START_ARGS);

      expect(appended.some((a) => a.kind === "final_answer")).toBe(false);
    });
  });

  describe("statusBus phase events", () => {
    function setupStatusBus() {
      const captured: StatusBusEnvelope[] = [];
      const broadcast = vi.fn((env: StatusBusEnvelope) => {
        captured.push(env);
      });
      const statusBus = createStatusBus({
        broadcast,
        now: () => "2026-05-31T00:00:00.000Z",
      });
      return { captured, statusBus, broadcast };
    }

    it("publishes started, phase transitions, and a completed lifecycle event on the converged path", async () => {
      const { captured, statusBus } = setupStatusBus();
      const deps = buildBaselineDeps();
      deps.statusBus = statusBus;
      await createWorkflowCollaborationEnvelope(deps).start(START_ARGS);

      const scopes = new Set(captured.map((e) => e.scope));
      expect(scopes).toEqual(new Set(["collaboration"]));

      const scopeIds = new Set(captured.map((e) => e.scopeId));
      expect(scopeIds).toEqual(new Set(["wf-collab-test-1"]));

      const kinds = captured.map((e) => {
        const payload = e.payload as { kind?: string };
        return payload.kind;
      });
      expect(kinds).toEqual([
        "workflow_collaboration_started",
        "workflow_collaboration_initial_drafts_completed",
        "workflow_collaboration_cross_review_completed",
        "workflow_collaboration_round_started",
        "workflow_collaboration_round_completed",
        "workflow_collaboration_completed",
      ]);

      const finalEvent = captured[captured.length - 1];
      expect(finalEvent?.status).toBe("completed");
    });

    it("publishes a failed terminal status when the run does not converge", async () => {
      const { captured, statusBus } = setupStatusBus();
      const deps = buildBaselineDeps({
        policyDecide: vi.fn(
          () =>
            ({
              kind: "ask_user",
              reason: "objective_disagreement",
            }) satisfies CollaborationPolicyDecision,
        ),
        collaboratorCaller: {
          runInitialDrafts: vi.fn(async () => ({
            agentOneDraft: AGENT_ONE_DRAFT,
            agentTwoDraft: AGENT_TWO_DRAFT,
          })),
          runCrossReview: vi.fn(async () => ({
            agentTwoCrossReview: AGENT_TWO_CROSS_REVIEW,
          })),
          runRound: vi.fn(async () =>
            makeRoundOutput(RESOLUTION_WITH_OBJECTIVE_DISAGREEMENT),
          ),
          generateFinalAnswer: vi.fn(async () => ({
            finalAnswer: FINAL_ANSWER_X,
          })),
        },
      });
      deps.statusBus = statusBus;
      await createWorkflowCollaborationEnvelope(deps).start(START_ARGS);

      const finalEvent = captured[captured.length - 1];
      expect(finalEvent?.status).toBe("failed");
      const payload = finalEvent?.payload as {
        kind: string;
        status: string;
      };
      expect(payload.kind).toBe("workflow_collaboration_completed");
      expect(payload.status).toBe("objective_disagreement");
    });
  });

  describe("transcript writeback", () => {
    it("appends the final answer to the originating conversation when appendTranscriptEntry is supplied", async () => {
      const calls: Array<[string, TranscriptEntry]> = [];
      const appendTranscriptEntry = vi.fn(
        async (conversationId: string, entry: TranscriptEntry) => {
          calls.push([conversationId, entry]);
        },
      );
      const deps = buildBaselineDeps();
      deps.appendTranscriptEntry = appendTranscriptEntry;
      await createWorkflowCollaborationEnvelope(deps).start(START_ARGS);

      expect(appendTranscriptEntry).toHaveBeenCalledTimes(1);
      const [conversationId, entry] = calls[0]!;
      expect(conversationId).toBe("conv-abc");
      expect(entry.type).toBe("assistant");
      expect(entry.role).toBe("assistant");
      expect(entry.content?.[0]).toEqual({
        type: "text",
        text: "Adopt Postgres for the new service tier.",
      });
    });

    it("stamps the transcript entry's origin field with workflow source, executionId, executionContextId (as nodeId), and iterationIndex", async () => {
      const calls: Array<[string, TranscriptEntry]> = [];
      const appendTranscriptEntry = vi.fn(
        async (conversationId: string, entry: TranscriptEntry) => {
          calls.push([conversationId, entry]);
        },
      );
      const deps = buildBaselineDeps();
      deps.appendTranscriptEntry = appendTranscriptEntry;
      await createWorkflowCollaborationEnvelope(deps).start({
        ...START_ARGS,
        executionId: "execution-42",
        iterationIndex: 3,
      });

      expect(calls).toHaveLength(1);
      const entry = calls[0]![1];
      expect(entry.origin).toEqual({
        source: "workflow",
        workflow: {
          executionId: "execution-42",
          nodeId: "context-implement",
          iterationIndex: 3,
        },
      });
    });

    it("does not append to the transcript when the run terminates without a final answer", async () => {
      const appendTranscriptEntry = vi.fn(
        async (_conversationId: string, _entry: TranscriptEntry) => {},
      );
      const deps = buildBaselineDeps({
        policyDecide: vi.fn(
          () =>
            ({
              kind: "ask_user",
              reason: "objective_disagreement",
            }) satisfies CollaborationPolicyDecision,
        ),
        collaboratorCaller: {
          runInitialDrafts: vi.fn(async () => ({
            agentOneDraft: AGENT_ONE_DRAFT,
            agentTwoDraft: AGENT_TWO_DRAFT,
          })),
          runCrossReview: vi.fn(async () => ({
            agentTwoCrossReview: AGENT_TWO_CROSS_REVIEW,
          })),
          runRound: vi.fn(async () =>
            makeRoundOutput(RESOLUTION_WITH_OBJECTIVE_DISAGREEMENT),
          ),
          generateFinalAnswer: vi.fn(async () => ({
            finalAnswer: FINAL_ANSWER_X,
          })),
        },
      });
      deps.appendTranscriptEntry = appendTranscriptEntry;
      await createWorkflowCollaborationEnvelope(deps).start(START_ARGS);

      expect(appendTranscriptEntry).not.toHaveBeenCalled();
    });

    it("does not fail the run when transcript writeback throws", async () => {
      const appendTranscriptEntry = vi.fn(async () => {
        throw new Error("transcript path unavailable");
      });
      const deps = buildBaselineDeps();
      deps.appendTranscriptEntry = appendTranscriptEntry;

      const { result } =
        await createWorkflowCollaborationEnvelope(deps).start(START_ARGS);

      expect(result.status).toBe("converged");
      expect(result.finalAnswer).toBe(
        "Adopt Postgres for the new service tier.",
      );
      const persisted = await deps.envelopeStore.read("wf-collab-test-1");
      expect(persisted?.status).toBe("completed");
    });
  });
});
