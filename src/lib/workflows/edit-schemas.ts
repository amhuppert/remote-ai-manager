import { z } from "zod";
import { charterInvariantSchema, sourceOfTruthSchema } from "./charter-schemas";
import {
  contextValidatorOverrideSchema,
  graphWorkflowAgentConfigSchema,
  graphWorkflowAgentValidatorConfigSchema,
  graphWorkflowAskUserQuestionsConfigSchema,
  graphWorkflowCircuitBreakerPolicySchema,
  graphWorkflowHumanApprovalGateConfigSchema,
  graphWorkflowIterationPolicySchema,
  graphWorkflowMutabilityPolicySchema,
  graphWorkflowPlanRepairPolicySchema,
  graphWorkflowScriptValidatorConfigSchema,
} from "@/lib/workflow-graph/config-schemas";
import {
  resolvedCollaborationConfigSchema,
  workflowCollaborationConfigOverrideSchema,
} from "@/lib/workflow-graph/collaboration-schemas";
import {
  parameterDeclarationSchema,
  prerequisiteSchema,
} from "@/lib/workflow-graph/definition-schemas";

// ============================================================
// Workflow Definition Edits (targeted saved-definition edits)
// ============================================================
// Ordered, atomic domain operations that mutate a SAVED
// `WorkflowDefinitionRecord` (docs/design/cc-cli/05). The verbs and field names
// deliberately mirror the runtime-edit schema below, but the surfaces stay
// separate: runtime edits mutate a running execution's `workingDefinition`,
// these mutate the saved definition. Operations are addressed by stable ids
// (never array indices) so a batch can reference intra-batch additions (add a
// context, then its tasks, then its edges). They are applied sequentially by
// `applyDefinitionEdits` (src/lib/workflow-graph/definition-edits.ts); the final
// mutated definition runs the same accept-time gate as create/replace before
// persisting.

// Relative task placement. Agents never write the numeric `order` field — the
// server renumbers each touched context to a dense 1..n after every task op, so
// the `duplicate-task-order` invariant is unviolable.
const definitionEditTaskPositionSchema = z.union([
  z.object({ at: z.enum(["start", "end"]) }),
  z.object({ after: z.string().trim().min(1) }),
  z.object({ before: z.string().trim().min(1) }),
]);
export type DefinitionEditTaskPosition = z.infer<
  typeof definitionEditTaskPositionSchema
>;

// Per-context config override blocks on `add-context` — additive, so plain
// optional (the same shape a plan.json context carries).
const definitionEditAddContextConfigShape = {
  implementer: graphWorkflowAgentConfigSchema.optional(),
  contextValidator: contextValidatorOverrideSchema.optional(),
  scriptValidator: graphWorkflowScriptValidatorConfigSchema.optional(),
  mutability: graphWorkflowMutabilityPolicySchema.optional(),
  circuitBreaker: graphWorkflowCircuitBreakerPolicySchema.optional(),
  iterationPolicy: graphWorkflowIterationPolicySchema.optional(),
  planRepair: graphWorkflowPlanRepairPolicySchema.optional(),
  collaboration: workflowCollaborationConfigOverrideSchema.optional(),
  humanApprovalGate: graphWorkflowHumanApprovalGateConfigSchema.optional(),
  askUserQuestions: graphWorkflowAskUserQuestionsConfigSchema.optional(),
};

// Per-context config override blocks on `update-context` — `null` CLEARS the
// override (restores cascade inheritance); an absent field is untouched.
const definitionEditUpdateContextConfigShape = {
  implementer: graphWorkflowAgentConfigSchema.nullable().optional(),
  contextValidator: contextValidatorOverrideSchema.nullable().optional(),
  scriptValidator: graphWorkflowScriptValidatorConfigSchema
    .nullable()
    .optional(),
  mutability: graphWorkflowMutabilityPolicySchema.nullable().optional(),
  circuitBreaker: graphWorkflowCircuitBreakerPolicySchema.nullable().optional(),
  iterationPolicy: graphWorkflowIterationPolicySchema.nullable().optional(),
  planRepair: graphWorkflowPlanRepairPolicySchema.nullable().optional(),
  collaboration: workflowCollaborationConfigOverrideSchema
    .nullable()
    .optional(),
  humanApprovalGate: graphWorkflowHumanApprovalGateConfigSchema
    .nullable()
    .optional(),
  askUserQuestions: graphWorkflowAskUserQuestionsConfigSchema
    .nullable()
    .optional(),
};

// Workflow-level cascade blocks on `update-workflow-config` — `null` CLEARS the
// override. The workflow-level `contextValidator` is the concrete validator
// config, not the per-context use/disabled override.
const definitionEditWorkflowConfigShape = {
  implementer: graphWorkflowAgentConfigSchema.nullable().optional(),
  contextValidator: graphWorkflowAgentValidatorConfigSchema
    .nullable()
    .optional(),
  scriptValidator: graphWorkflowScriptValidatorConfigSchema
    .nullable()
    .optional(),
  iterationPolicy: graphWorkflowIterationPolicySchema.nullable().optional(),
  circuitBreaker: graphWorkflowCircuitBreakerPolicySchema.nullable().optional(),
  mutability: graphWorkflowMutabilityPolicySchema.nullable().optional(),
  planRepair: graphWorkflowPlanRepairPolicySchema.nullable().optional(),
  collaboration: workflowCollaborationConfigOverrideSchema
    .nullable()
    .optional(),
  humanApprovalGate: graphWorkflowHumanApprovalGateConfigSchema
    .nullable()
    .optional(),
  askUserQuestions: graphWorkflowAskUserQuestionsConfigSchema
    .nullable()
    .optional(),
};

// Charter content fields shared by the saved-tier `update-charter` op and the
// live `amend-charter` op (docs/design/cc-cli/07) — one shape so the two
// vocabularies cannot drift apart again (the live op grew from a real gap where
// `invariants` was added to the charter schema but never to this op). Partial
// merge: a present scalar sets, an array replaces wholesale, `null` clears an
// optional section, absent leaves untouched. `sourcesOfTruth` is not nullable —
// a charter always keeps at least one ranked source.
const charterContentEditShape = {
  mission: z.string().trim().min(1).optional(),
  conventions: z.array(z.string()).nullable().optional(),
  nonGoals: z.array(z.string()).nullable().optional(),
  vocabulary: z.array(z.string()).nullable().optional(),
  testStrategy: z.string().nullable().optional(),
  knownAmbiguities: z.array(z.string()).nullable().optional(),
  invariants: z.array(charterInvariantSchema).nullable().optional(),
  sourcesOfTruth: z.array(sourceOfTruthSchema).optional(),
};

/** Top-level charter fields an `update-charter`/`amend-charter` op may touch. */
export const CHARTER_CONTENT_EDIT_FIELDS = Object.keys(
  charterContentEditShape,
) as readonly string[];

export const workflowDefinitionEditOperationSchema = z.discriminatedUnion(
  "type",
  [
    z.object({
      type: z.literal("update-workflow"),
      name: z.string().trim().min(1).optional(),
      description: z.string().trim().min(1).nullable().optional(),
    }),
    z.object({
      type: z.literal("update-charter"),
      ...charterContentEditShape,
    }),
    z.object({
      type: z.literal("update-workflow-config"),
      ...definitionEditWorkflowConfigShape,
    }),
    z.object({
      type: z.literal("add-context"),
      id: z.string().trim().min(1),
      title: z.string().trim().min(1),
      acceptanceCriteria: z.string().trim().min(1),
      description: z.string().trim().min(1).optional(),
      ...definitionEditAddContextConfigShape,
    }),
    z.object({
      type: z.literal("update-context"),
      contextId: z.string().trim().min(1),
      title: z.string().trim().min(1).optional(),
      description: z.string().trim().min(1).nullable().optional(),
      acceptanceCriteria: z.string().trim().min(1).optional(),
      ...definitionEditUpdateContextConfigShape,
    }),
    z.object({
      type: z.literal("remove-context"),
      contextId: z.string().trim().min(1),
      deleteTasks: z.boolean().optional(),
    }),
    z.object({
      type: z.literal("add-task"),
      id: z.string().trim().min(1),
      contextId: z.string().trim().min(1),
      title: z.string().trim().min(1),
      instructions: z.string().trim().min(1),
      metadata: z.record(z.string(), z.string()).optional(),
      position: definitionEditTaskPositionSchema.optional(),
    }),
    z.object({
      type: z.literal("update-task"),
      taskId: z.string().trim().min(1),
      title: z.string().trim().min(1).optional(),
      instructions: z.string().trim().min(1).optional(),
      metadata: z.record(z.string(), z.string()).nullable().optional(),
    }),
    z.object({
      type: z.literal("remove-task"),
      taskId: z.string().trim().min(1),
    }),
    z.object({
      type: z.literal("move-task"),
      taskId: z.string().trim().min(1),
      contextId: z.string().trim().min(1).optional(),
      position: definitionEditTaskPositionSchema.optional(),
    }),
    z.object({
      type: z.literal("reorder-tasks"),
      contextId: z.string().trim().min(1),
      orderedTaskIds: z.array(z.string().trim().min(1)).min(1),
    }),
    z.object({
      type: z.literal("add-edge"),
      sourceContextId: z.string().trim().min(1),
      targetContextId: z.string().trim().min(1),
    }),
    z.object({
      type: z.literal("remove-edge"),
      sourceContextId: z.string().trim().min(1),
      targetContextId: z.string().trim().min(1),
    }),
    z.object({
      type: z.literal("add-parameter"),
      declaration: parameterDeclarationSchema,
    }),
    z.object({
      type: z.literal("update-parameter"),
      name: z.string().trim().min(1),
      declaration: parameterDeclarationSchema,
    }),
    z.object({
      type: z.literal("remove-parameter"),
      name: z.string().trim().min(1),
    }),
    z.object({
      type: z.literal("add-prerequisite"),
      prerequisite: prerequisiteSchema,
    }),
    // Matched by identity (kind + path/skill); prerequisites carry no ids.
    z.object({
      type: z.literal("remove-prerequisite"),
      kind: z.enum(["path", "skill"]),
      path: z.string().trim().min(1).optional(),
      skill: z.string().trim().min(1).optional(),
    }),
  ],
);
export type DefinitionEditOperation = z.infer<
  typeof workflowDefinitionEditOperationSchema
>;

export const workflowDefinitionEditRequestSchema = z.object({
  // Optimistic-concurrency guard: the revision the edits were authored against.
  // The server rejects with `revision_conflict` if the stored revision differs.
  baseRevision: z.number().int().min(1),
  // Full apply + validate, report the outcome, persist nothing.
  dryRun: z.boolean().optional(),
  operations: z.array(workflowDefinitionEditOperationSchema).min(1),
});
export type WorkflowDefinitionEditRequest = z.infer<
  typeof workflowDefinitionEditRequestSchema
>;

// ============================================================
// Workflow Live Edits (live editing of a launched execution)
// ============================================================
// Ordered, atomic domain operations that mutate a RUNNING execution's resolved
// `workingDefinition` + runtime maps (docs/design/cc-cli/06). These live
// ALONGSIDE the doc-05 saved-definition edit union and the legacy task-only
// runtime-edit schema — the route swap is a downstream slice, so all three
// coexist until then. Names mirror doc 05 where semantics match; addressing is
// always by stable id.
//
// Unlike the doc-05 blocks (which edit AUTHORED overrides where `null` clears an
// override to restore cascade inheritance), live edits set CONCRETE RESOLVED
// values — there is no cascade at runtime (doc 06, D1). Only `contextValidator`
// is nullable (null → disable the validator, matching the resolved context's
// nullable field); every other block is plain optional (present = set the value).
const liveEditContextConfigShape = {
  implementer: graphWorkflowAgentConfigSchema.optional(),
  contextValidator: graphWorkflowAgentValidatorConfigSchema
    .nullable()
    .optional(),
  scriptValidator: graphWorkflowScriptValidatorConfigSchema.optional(),
  humanApprovalGate: graphWorkflowHumanApprovalGateConfigSchema.optional(),
  askUserQuestions: graphWorkflowAskUserQuestionsConfigSchema.optional(),
  iterationPolicy: graphWorkflowIterationPolicySchema.optional(),
  circuitBreaker: graphWorkflowCircuitBreakerPolicySchema.optional(),
  mutability: graphWorkflowMutabilityPolicySchema.optional(),
  planRepair: graphWorkflowPlanRepairPolicySchema.optional(),
  collaboration: resolvedCollaborationConfigSchema.optional(),
};

export const workflowLiveEditOperationSchema = z.discriminatedUnion("type", [
  // Versioned charter amendment (docs/design/cc-cli/07): partial-merges the
  // shared charter content shape onto the execution's charter, propagates to
  // every non-frozen context copy, and appends a rationale-bearing entry to the
  // execution's amendment log. Quiescence-gated like structural ops.
  z
    .object({
      type: z.literal("amend-charter"),
      // The "why" — recorded verbatim in the amendment log and rendered into
      // prompts/charter.md so future agents see that the rules changed and why.
      rationale: z.string().trim().min(1),
      ...charterContentEditShape,
    })
    .refine(
      (value) =>
        Object.entries(value).some(
          ([key, fieldValue]) =>
            key !== "type" && key !== "rationale" && fieldValue !== undefined,
        ),
      {
        message: "amend-charter requires at least one charter field to change",
      },
    ),
  z
    .object({
      type: z.literal("update-context"),
      contextId: z.string().trim().min(1),
      title: z.string().trim().min(1).optional(),
      description: z.string().trim().min(1).nullable().optional(),
      acceptanceCriteria: z.string().trim().min(1).optional(),
      ...liveEditContextConfigShape,
    })
    .refine(
      (value) =>
        Object.entries(value).some(
          ([key, fieldValue]) =>
            key !== "type" && key !== "contextId" && fieldValue !== undefined,
        ),
      { message: "update-context requires at least one field to change" },
    ),
  z.object({
    type: z.literal("add-context"),
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    acceptanceCriteria: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
    // Seed the new context's resolved config from this context's resolved config
    // when present, else from resolved global defaults; explicit blocks override.
    configFromContextId: z.string().trim().min(1).optional(),
    ...liveEditContextConfigShape,
  }),
  z.object({
    type: z.literal("remove-context"),
    contextId: z.string().trim().min(1),
    deleteTasks: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("add-task"),
    // Optional slug — minted server-side when absent (doc 06). Present ids let a
    // batch reference the addition (e.g. add a task, then move it).
    id: z.string().trim().min(1).optional(),
    contextId: z.string().trim().min(1),
    title: z.string().trim().min(1),
    instructions: z.string().trim().min(1),
    metadata: z.record(z.string(), z.string()).optional(),
    position: definitionEditTaskPositionSchema.optional(),
  }),
  z
    .object({
      type: z.literal("update-task"),
      taskId: z.string().trim().min(1),
      title: z.string().trim().min(1).optional(),
      instructions: z.string().trim().min(1).optional(),
      metadata: z.record(z.string(), z.string()).nullable().optional(),
    })
    .refine(
      (value) =>
        value.title !== undefined ||
        value.instructions !== undefined ||
        value.metadata !== undefined,
      {
        message:
          "update-task requires at least one of title, instructions, or metadata",
      },
    ),
  z.object({
    type: z.literal("remove-task"),
    taskId: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal("move-task"),
    taskId: z.string().trim().min(1),
    targetContextId: z.string().trim().min(1),
    position: definitionEditTaskPositionSchema.optional(),
  }),
  z.object({
    type: z.literal("reorder-tasks"),
    contextId: z.string().trim().min(1),
    orderedTaskIds: z.array(z.string().trim().min(1)).min(1),
  }),
  z.object({
    type: z.literal("add-edge"),
    sourceContextId: z.string().trim().min(1),
    targetContextId: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal("remove-edge"),
    sourceContextId: z.string().trim().min(1),
    targetContextId: z.string().trim().min(1),
  }),
]);
export type WorkflowLiveEditOperation = z.infer<
  typeof workflowLiveEditOperationSchema
>;

export const workflowLiveEditRequestSchema = z.object({
  // Must match the active execution's id (route rejects a mismatch, D7).
  executionId: z.string().min(1),
  // Optimistic-concurrency guard: the `liveRevision` the edits were authored
  // against; the route rejects with `revision_conflict` if it differs (D4).
  baseLiveRevision: z.number().int().min(1),
  // Trusted client self-identification for audit/SSE attribution (D15).
  // `lane-agent` is server-derived on the lane route only — never accepted here.
  source: z.enum(["cli", "ui"]),
  // Advisory validation without a write (route runs gates against a snapshot).
  dryRun: z.boolean().optional(),
  operations: z.array(workflowLiveEditOperationSchema).min(1),
});
export type WorkflowLiveEditRequest = z.infer<
  typeof workflowLiveEditRequestSchema
>;
