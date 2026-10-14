import { z } from "zod";

// ============================================================
// Collaboration severity / category / threshold primitives
// ============================================================
export const collaborationDisagreementSeveritySchema = z.enum([
  "minor",
  "major",
  "blocking",
]);
export type CollaborationDisagreementSeverity = z.infer<
  typeof collaborationDisagreementSeveritySchema
>;

export const collaborationFlowAgentSchema = z.enum(["agent_one", "agent_two"]);
export type CollaborationFlowAgent = z.infer<
  typeof collaborationFlowAgentSchema
>;

export const collaborationDisagreementCategorySchema = z.enum([
  "objective",
  "implementation",
]);
export type CollaborationDisagreementCategory = z.infer<
  typeof collaborationDisagreementCategorySchema
>;

export const collaborationAutonomousResolutionThresholdSchema = z.enum([
  "none",
  "minor",
  "major",
  "blocking",
]);
export type CollaborationAutonomousResolutionThreshold = z.infer<
  typeof collaborationAutonomousResolutionThresholdSchema
>;

// ============================================================
// Collaboration Mode — asymmetric artifact contract
// ============================================================
// Source of truth: memory-bank/COLLABORATION_MODE_FLOW.md §"Agent output
// contract". The primary (agent_one) and secondary (agent_two) agents emit
// kind-discriminated artifact records (initial_draft, cross_review,
// proposed_changes, counter_proposal, resolution_decision, final_answer,
// open_conflicts). Convergence and routing are decided by the orchestrator
// from the resolution_decision artifact, not by the agent narrative.
//
// The severity / category / flow-agent / autonomous-threshold enums used by
// these artifacts are defined higher up in this file; the graph engine's
// collaboration config composes the threshold from them. The per-artifact
// JSON-Schema projections live in `collaboration/types.ts`.

// Length, item-count, numeric, and pattern bounds are advisory for these small
// manifests. The prompt and artifact-file validator own content placement and
// size policy; this `safeParse` checks shape, required fields, enums, and the
// cross-field `.refine()` invariants without discarding otherwise usable
// artifact references over an inline-length violation.
const collaborationShortIdSchema = z.string();
const collaborationShortTextSchema = z.string();
const collaborationSummarySchema = z.string();
const collaborationArtifactSummarySchema = z.string();
const collaborationArtifactPathSchema = z.string();

const collaborationReferenceSchema = z
  .object({
    artifact: collaborationArtifactPathSchema,
    locator: z.string().optional(),
  })
  .strict();
export type CollaborationReference = z.infer<
  typeof collaborationReferenceSchema
>;

const collaborationArtifactAgreementSchema = z
  .object({
    id: collaborationShortIdSchema,
    claim: collaborationShortTextSchema,
    ref: collaborationReferenceSchema.optional(),
  })
  .strict();
export type CollaborationArtifactAgreement = z.infer<
  typeof collaborationArtifactAgreementSchema
>;

const collaborationArtifactDisagreementSchema = z
  .object({
    id: collaborationShortIdSchema,
    category: collaborationDisagreementCategorySchema,
    severity: collaborationDisagreementSeveritySchema,
    claim: collaborationShortTextSchema,
    reason: collaborationShortTextSchema,
    proposed_resolution: collaborationShortTextSchema.optional(),
    ref: collaborationReferenceSchema.optional(),
  })
  .strict();
export type CollaborationArtifactDisagreement = z.infer<
  typeof collaborationArtifactDisagreementSchema
>;

const collaborationUserQuestionSchema = z
  .object({
    id: collaborationShortIdSchema,
    question: collaborationShortTextSchema,
    related_disagreement_ids: z.array(collaborationShortIdSchema),
  })
  .strict();
export type CollaborationUserQuestion = z.infer<
  typeof collaborationUserQuestionSchema
>;

const collaborationReviseSelfArtifactSchema = z
  .object({
    change: collaborationShortTextSchema,
    because: collaborationShortTextSchema,
  })
  .strict();
export type CollaborationReviseSelfArtifact = z.infer<
  typeof collaborationReviseSelfArtifactSchema
>;

const collaborationChangeProposalSchema = z
  .object({
    id: collaborationShortIdSchema,
    change: collaborationShortTextSchema,
    rationale: collaborationShortTextSchema,
    addresses_disagreement_ids: z.array(collaborationShortIdSchema),
  })
  .strict();
export type CollaborationChangeProposal = z.infer<
  typeof collaborationChangeProposalSchema
>;

const collaborationAgentArtifactPhaseSchema = z.enum([
  "initial_draft",
  "cross_review",
  "proposed_changes",
  "counter_proposal",
  "resolution_decision",
  "final_answer",
]);
export type CollaborationAgentArtifactPhase = z.infer<
  typeof collaborationAgentArtifactPhaseSchema
>;

const collaborationGeneratedArtifactTypeSchema = z.enum([
  "main_response",
  "audit",
  "supporting",
]);
export type CollaborationGeneratedArtifactType = z.infer<
  typeof collaborationGeneratedArtifactTypeSchema
>;

export const collaborationGeneratedArtifactSchema = z
  .object({
    id: collaborationShortIdSchema,
    artifact_type: collaborationGeneratedArtifactTypeSchema,
    path: collaborationArtifactPathSchema,
    round: z.number().int(),
    agent: collaborationFlowAgentSchema,
    phase: collaborationAgentArtifactPhaseSchema,
    summary: collaborationArtifactSummarySchema,
  })
  .strict();
export type CollaborationGeneratedArtifact = z.infer<
  typeof collaborationGeneratedArtifactSchema
>;

const collaborationGeneratedArtifactsSchema = z.array(
  collaborationGeneratedArtifactSchema,
);

// The model-authored ("content") shape of a generated artifact: only the fields
// the agent actually decides — id, artifact_type, path, summary. The
// orchestrator owns round/agent/phase (they are always the envelope's
// round/agent/kind) and injects them after parsing, so the model is never asked
// to echo bookkeeping it cannot reliably get right. Default (strip) object mode,
// not `.strict()`: if a backend echoes the injected fields anyway they are
// dropped and then overwritten by the orchestrator — a resilient gate, not a
// hard failure.
const collaborationGeneratedArtifactContentSchema = z.object({
  id: collaborationShortIdSchema,
  artifact_type: collaborationGeneratedArtifactTypeSchema,
  path: collaborationArtifactPathSchema,
  summary: collaborationArtifactSummarySchema,
});
const collaborationGeneratedArtifactContentsSchema = z.array(
  collaborationGeneratedArtifactContentSchema,
);

type CollaborationRequiredArtifact = {
  id: string;
  artifact_type: CollaborationGeneratedArtifactType;
};

const MAIN_RESPONSE_REQUIRED: ReadonlyArray<CollaborationRequiredArtifact> = [
  { id: "main", artifact_type: "main_response" },
];
const FINAL_ANSWER_REQUIRED: ReadonlyArray<CollaborationRequiredArtifact> = [
  { id: "answer", artifact_type: "main_response" },
  { id: "audit", artifact_type: "audit" },
];

// Validates the one structural invariant the model owns — the required generated
// artifact entries are present — and emits a named, path-attributed issue per
// missing entry. This replaces the old bare `.refine()` whose failure surfaced
// as an opaque root-level `$: Invalid input`. Per-artifact round/agent/phase
// consistency is no longer checked here: the orchestrator injects those values,
// so they are correct by construction (and the artifact-file validator still
// re-checks the derived paths).
function requireGeneratedArtifacts(
  required: ReadonlyArray<CollaborationRequiredArtifact>,
) {
  return (
    value: {
      artifacts: ReadonlyArray<{
        id: string;
        artifact_type: CollaborationGeneratedArtifactType;
      }>;
    },
    ctx: z.RefinementCtx,
  ): void => {
    for (const req of required) {
      const present = value.artifacts.some(
        (artifact) =>
          artifact.id === req.id &&
          artifact.artifact_type === req.artifact_type,
      );
      if (!present) {
        ctx.addIssue({
          code: "custom",
          path: ["artifacts"],
          message: `must include a generated artifact with id "${req.id}" and artifact_type "${req.artifact_type}"`,
        });
      }
    }
  };
}

const initialDraftBodyShape = {
  summary: collaborationSummarySchema,
  assumptions: z.array(collaborationShortTextSchema),
  key_claims: z.array(collaborationArtifactAgreementSchema),
};
export const collaborationInitialDraftContentSchema = z
  .object({
    ...initialDraftBodyShape,
    artifacts: collaborationGeneratedArtifactContentsSchema,
  })
  .superRefine(requireGeneratedArtifacts(MAIN_RESPONSE_REQUIRED));
export type CollaborationInitialDraftContent = z.infer<
  typeof collaborationInitialDraftContentSchema
>;
export const collaborationInitialDraftOutputSchema = z
  .object({
    kind: z.literal("initial_draft"),
    agent: collaborationFlowAgentSchema,
    round: z.number().int(),
    ...initialDraftBodyShape,
    artifacts: collaborationGeneratedArtifactsSchema,
  })
  .strict()
  .superRefine(requireGeneratedArtifacts(MAIN_RESPONSE_REQUIRED));
export type CollaborationInitialDraftOutput = z.infer<
  typeof collaborationInitialDraftOutputSchema
>;

const crossReviewBodyShape = {
  summary: collaborationSummarySchema,
  agree: z.array(collaborationArtifactAgreementSchema),
  disagree: z.array(collaborationArtifactDisagreementSchema),
  revise_self: z.array(collaborationReviseSelfArtifactSchema),
};
export const collaborationCrossReviewContentSchema = z
  .object({
    ...crossReviewBodyShape,
    artifacts: collaborationGeneratedArtifactContentsSchema,
  })
  .superRefine(requireGeneratedArtifacts(MAIN_RESPONSE_REQUIRED));
export const collaborationCrossReviewOutputSchema = z
  .object({
    kind: z.literal("cross_review"),
    agent: collaborationFlowAgentSchema,
    target_agent: collaborationFlowAgentSchema,
    round: z.number().int(),
    ...crossReviewBodyShape,
    artifacts: collaborationGeneratedArtifactsSchema,
  })
  .strict()
  .superRefine(requireGeneratedArtifacts(MAIN_RESPONSE_REQUIRED));
export type CollaborationCrossReviewOutput = z.infer<
  typeof collaborationCrossReviewOutputSchema
>;

const proposedChangesBodyShape = {
  summary: collaborationSummarySchema,
  accepted_from_other_agent_draft: z.array(
    collaborationArtifactAgreementSchema,
  ),
  proposed_changes: z.array(collaborationChangeProposalSchema),
  remaining_disagreements: z.array(collaborationArtifactDisagreementSchema),
};
export const collaborationProposedChangesContentSchema = z
  .object({
    ...proposedChangesBodyShape,
    artifacts: collaborationGeneratedArtifactContentsSchema,
  })
  .superRefine(requireGeneratedArtifacts(MAIN_RESPONSE_REQUIRED));
export const collaborationProposedChangesOutputSchema = z
  .object({
    kind: z.literal("proposed_changes"),
    agent: z.literal("agent_one"),
    target_agent: z.literal("agent_two"),
    round: z.number().int(),
    ...proposedChangesBodyShape,
    artifacts: collaborationGeneratedArtifactsSchema,
  })
  .strict()
  .superRefine(requireGeneratedArtifacts(MAIN_RESPONSE_REQUIRED));
export type CollaborationProposedChangesOutput = z.infer<
  typeof collaborationProposedChangesOutputSchema
>;

const counterProposalBodyShape = {
  summary: collaborationSummarySchema,
  accepted_change_ids: z.array(collaborationShortIdSchema),
  rejected_change_ids: z.array(collaborationShortIdSchema),
  alternative_changes: z.array(collaborationChangeProposalSchema),
  agree: z.array(collaborationArtifactAgreementSchema),
  disagree: z.array(collaborationArtifactDisagreementSchema),
};
export const collaborationCounterProposalContentSchema = z
  .object({
    ...counterProposalBodyShape,
    artifacts: collaborationGeneratedArtifactContentsSchema,
  })
  .superRefine(requireGeneratedArtifacts(MAIN_RESPONSE_REQUIRED));
export const collaborationCounterProposalOutputSchema = z
  .object({
    kind: z.literal("counter_proposal"),
    agent: z.literal("agent_two"),
    target_agent: z.literal("agent_one"),
    round: z.number().int(),
    ...counterProposalBodyShape,
    artifacts: collaborationGeneratedArtifactsSchema,
  })
  .strict()
  .superRefine(requireGeneratedArtifacts(MAIN_RESPONSE_REQUIRED));
export type CollaborationCounterProposalOutput = z.infer<
  typeof collaborationCounterProposalOutputSchema
>;

const collaborationResolutionDecisionNextActionSchema = z.enum([
  "final",
  "continue_negotiation",
  "ask_user",
  "fail",
]);
export type CollaborationResolutionDecisionNextAction = z.infer<
  typeof collaborationResolutionDecisionNextActionSchema
>;

const collaborationResolvedDisagreementSchema = z
  .object({
    disagreement_id: collaborationShortIdSchema,
    resolution: collaborationShortTextSchema,
    resolved_autonomously: z.boolean(),
    rationale: collaborationShortTextSchema,
  })
  .strict();
export type CollaborationResolvedDisagreement = z.infer<
  typeof collaborationResolvedDisagreementSchema
>;

const resolutionDecisionBodyShape = {
  summary: collaborationSummarySchema,
  agreement_reached: z.boolean(),
  next_action: collaborationResolutionDecisionNextActionSchema,
  accepted_points: z.array(collaborationArtifactAgreementSchema),
  resolved_disagreements: z.array(collaborationResolvedDisagreementSchema),
  remaining_disagreements: z.array(collaborationArtifactDisagreementSchema),
  user_questions: z.array(collaborationUserQuestionSchema),
  rationale: collaborationShortTextSchema,
};
export const collaborationResolutionDecisionContentSchema = z
  .object({
    ...resolutionDecisionBodyShape,
    artifacts: collaborationGeneratedArtifactContentsSchema,
  })
  .superRefine(requireGeneratedArtifacts(MAIN_RESPONSE_REQUIRED));
export const collaborationResolutionDecisionOutputSchema = z
  .object({
    kind: z.literal("resolution_decision"),
    agent: z.literal("agent_one"),
    target_agent: z.literal("agent_two"),
    round: z.number().int(),
    ...resolutionDecisionBodyShape,
    artifacts: collaborationGeneratedArtifactsSchema,
  })
  .strict()
  .superRefine(requireGeneratedArtifacts(MAIN_RESPONSE_REQUIRED));
export type CollaborationResolutionDecisionOutput = z.infer<
  typeof collaborationResolutionDecisionOutputSchema
>;

export const collaborationOpenConflictsOutputSchema = z
  .object({
    kind: z.literal("open_conflicts"),
    round: z.number().int(),
    summary: collaborationSummarySchema,
    disagreements: z.array(collaborationArtifactDisagreementSchema),
    questions: z.array(collaborationUserQuestionSchema),
  })
  .strict();
export type CollaborationOpenConflictsOutput = z.infer<
  typeof collaborationOpenConflictsOutputSchema
>;

const finalAnswerBodyShape = {
  summary: collaborationSummarySchema,
  answer_artifact_id: z.literal("answer"),
  audit_artifact_id: z.literal("audit"),
};
export const collaborationFinalAnswerContentSchema = z
  .object({
    ...finalAnswerBodyShape,
    artifacts: collaborationGeneratedArtifactContentsSchema,
  })
  .superRefine(requireGeneratedArtifacts(FINAL_ANSWER_REQUIRED));
export const collaborationFinalAnswerOutputSchema = z
  .object({
    kind: z.literal("final_answer"),
    agent: z.literal("agent_one"),
    round: z.number().int(),
    ...finalAnswerBodyShape,
    artifacts: collaborationGeneratedArtifactsSchema,
  })
  .strict()
  .superRefine(requireGeneratedArtifacts(FINAL_ANSWER_REQUIRED));
export type CollaborationFinalAnswerOutput = z.infer<
  typeof collaborationFinalAnswerOutputSchema
>;

export const collaborationArtifactSchema = z.discriminatedUnion("kind", [
  collaborationInitialDraftOutputSchema,
  collaborationCrossReviewOutputSchema,
  collaborationProposedChangesOutputSchema,
  collaborationCounterProposalOutputSchema,
  collaborationResolutionDecisionOutputSchema,
  collaborationOpenConflictsOutputSchema,
  collaborationFinalAnswerOutputSchema,
]);
export type CollaborationArtifact = z.infer<typeof collaborationArtifactSchema>;
