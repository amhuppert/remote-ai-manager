import { z } from "zod";
import { graphWorkflowAgentConfigSchema } from "./config-schemas";

// ============================================================
// Collaboration severity / category / threshold primitives
// ============================================================
// Hoisted above the collaboration config block so the latter can compose
// `collaborationAutonomousResolutionThresholdSchema`. Full collaboration
// artifact schemas (initial_draft, cross_review, etc.) remain below in the
// "Collaboration Mode — asymmetric artifact contract" section.
const collaborationDisagreementSeveritySchema = z.enum([
  "minor",
  "major",
  "blocking",
]);
export type CollaborationDisagreementSeverity = z.infer<
  typeof collaborationDisagreementSeveritySchema
>;

const collaborationFlowAgentSchema = z.enum(["agent_one", "agent_two"]);
export type CollaborationFlowAgent = z.infer<
  typeof collaborationFlowAgentSchema
>;

const collaborationDisagreementCategorySchema = z.enum([
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
// Agent-Invoked Collaboration Config
// ============================================================
// Composed into:
//   - workflowDefaultsSchema (src/lib/config/schemas.ts) — required on parsed,
//     optional on raw twin; loader seeds the default when absent.
//   - workflowConfigOverrideSchema (definition-schemas.ts) — optional override.
//   - graphWorkflowExecutionContextDefinitionSchema (definition-schemas.ts) —
//     optional per-context override.
// Resolved (with per-field provenance) by
// `resolveCollaborationConfigWithProvenance` in
// `src/lib/workflow-graph/resolve-config.ts`.
export const workflowCollaborationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  secondAgent: graphWorkflowAgentConfigSchema,
  negotiationRounds: z.number().int().positive(),
  autonomousResolutionThreshold:
    collaborationAutonomousResolutionThresholdSchema,
});
export type WorkflowCollaborationConfig = z.infer<
  typeof workflowCollaborationConfigSchema
>;

// Override block at the workflow-level and per-context layers. Each field is
// individually optional so the cascade can compute provenance per-field,
// satisfying R2.1–R2.3 and the "no `??` across the block" invariant in
// `resolveCollaborationConfigWithProvenance`.
export const workflowCollaborationConfigOverrideSchema = z.object({
  enabled: z.boolean().optional(),
  secondAgent: graphWorkflowAgentConfigSchema.optional(),
  negotiationRounds: z.number().int().positive().optional(),
  autonomousResolutionThreshold:
    collaborationAutonomousResolutionThresholdSchema.optional(),
});
export type WorkflowCollaborationConfigOverride = z.infer<
  typeof workflowCollaborationConfigOverrideSchema
>;

export const collaborationConfigSourceSchema = z.enum([
  "per-node",
  "workflow",
  "global",
]);
export type CollaborationConfigSource = z.infer<
  typeof collaborationConfigSourceSchema
>;

const provenancedField = <T extends z.ZodTypeAny>(value: T) =>
  z.object({
    value,
    source: collaborationConfigSourceSchema,
  });

export const resolvedCollaborationConfigSchema = z.object({
  enabled: provenancedField(z.boolean()).default({
    value: false,
    source: "global",
  }),
  secondAgent: provenancedField(graphWorkflowAgentConfigSchema),
  negotiationRounds: provenancedField(z.number().int().positive()),
  autonomousResolutionThreshold: provenancedField(
    collaborationAutonomousResolutionThresholdSchema,
  ),
});
export type ResolvedCollaborationConfig = z.infer<
  typeof resolvedCollaborationConfigSchema
>;

// ============================================================
// Workflow Collaboration Result
// ============================================================
// The structured value returned by the workflow-scoped collaboration envelope
// (and surfaced to the implementer agent via `request_collaboration`). The
// four-value status mirrors the agent-facing branches of the collaboration
// policy mapping table (research.md §10.1); the result-level `superRefine`
// enforces the invariants the policy expresses informally:
//   - converged outcomes MUST carry a non-empty `finalAnswer`
//   - any non-converged outcome MUST carry at least one open conflict so the
//     surfaced failure record is never structurally empty.
export const workflowCollaborationStatusSchema = z.enum([
  "converged",
  "rounds_exhausted",
  "requires_user_input",
  "objective_disagreement",
]);
export type WorkflowCollaborationStatus = z.infer<
  typeof workflowCollaborationStatusSchema
>;

const workflowCollaborationOpenConflictSchema = z.object({
  rejectingAgent: collaborationFlowAgentSchema,
  disputedPoint: z.string().trim().min(1),
  severity: collaborationDisagreementSeveritySchema,
  category: collaborationDisagreementCategorySchema,
});
export type WorkflowCollaborationOpenConflict = z.infer<
  typeof workflowCollaborationOpenConflictSchema
>;

export const workflowCollaborationResultSchema = z
  .object({
    status: workflowCollaborationStatusSchema,
    finalAnswer: z.string().min(1).nullable(),
    openConflicts: z.array(workflowCollaborationOpenConflictSchema).default([]),
  })
  .superRefine((result, ctx) => {
    if (result.status === "converged" && result.finalAnswer == null) {
      ctx.addIssue({
        code: "custom",
        message: "converged result must include a non-empty finalAnswer",
        path: ["finalAnswer"],
      });
    }
    if (result.status !== "converged" && result.openConflicts.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "non-converged result must populate at least one openConflict",
        path: ["openConflicts"],
      });
    }
  });
export type WorkflowCollaborationResult = z.infer<
  typeof workflowCollaborationResultSchema
>;

export const graphWorkflowPendingCollaborationSchema = z.object({
  workflowId: z.string().trim().min(1),
  contextId: z.string().trim().min(1),
  conversationId: z.string().trim().min(1),
  parentImplementerTurnId: z.string().trim().min(1),
  brief: z.string().trim().min(1),
  startedAt: z.string().trim().min(1),
});
export type GraphWorkflowPendingCollaboration = z.infer<
  typeof graphWorkflowPendingCollaborationSchema
>;

export const graphWorkflowCollaborationContinuationSchema = z.object({
  workflowId: z.string().trim().min(1),
  brief: z.string().trim().min(1),
  result: workflowCollaborationResultSchema,
  roundsConsumed: z.number().int().min(0),
  completedAt: z.string().trim().min(1),
  deliveredAt: z.string().trim().min(1).nullable().default(null),
});
export type GraphWorkflowCollaborationContinuation = z.infer<
  typeof graphWorkflowCollaborationContinuationSchema
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
// these artifacts are defined higher up in this file (so the agent-invoked
// collaboration config block can compose the threshold). The artifact
// schemas themselves remain here next to the per-artifact JSON-Schema
// projections in `collaboration/types.ts`.

// Length, item-count, numeric, and pattern bounds are intentionally omitted
// from these artifact schemas: the per-artifact JSON-Schema projections in
// `collaboration/types.ts` are handed to Claude's native structured-output
// enforcement, which cannot satisfy those keywords and fails the whole turn if
// they are present (see that file's header and
// docs/structured-data-responses.md). The bounds live in the prompt + field
// descriptions instead; this `safeParse` only checks shape, required fields,
// enums, and the cross-field `.refine()` invariants.
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
export type CollaborationCrossReviewContent = z.infer<
  typeof collaborationCrossReviewContentSchema
>;
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
export type CollaborationProposedChangesContent = z.infer<
  typeof collaborationProposedChangesContentSchema
>;
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
export type CollaborationCounterProposalContent = z.infer<
  typeof collaborationCounterProposalContentSchema
>;
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
export type CollaborationResolutionDecisionContent = z.infer<
  typeof collaborationResolutionDecisionContentSchema
>;
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
export type CollaborationFinalAnswerContent = z.infer<
  typeof collaborationFinalAnswerContentSchema
>;
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
