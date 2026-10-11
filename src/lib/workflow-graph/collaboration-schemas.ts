import { z } from "zod";
import { graphWorkflowAgentConfigSchema } from "./config-schemas";
import {
  collaborationAutonomousResolutionThresholdSchema,
  collaborationDisagreementCategorySchema,
  collaborationDisagreementSeveritySchema,
  collaborationFlowAgentSchema,
} from "@/lib/workflows/collaboration/schemas";

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
