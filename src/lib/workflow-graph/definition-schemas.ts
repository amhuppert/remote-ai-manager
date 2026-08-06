import { z } from "zod";
import { agentBackendSchema } from "@/lib/shared/schemas";
import { workflowCharterSchema } from "@/lib/workflows/charter-schemas";
import {
  DEFAULT_PLAN_REPAIR_POLICY,
  agentAssignmentSchema,
  graphWorkflowAskUserQuestionsConfigSchema,
  graphWorkflowCircuitBreakerPolicySchema,
  graphWorkflowHumanApprovalGateConfigSchema,
  graphWorkflowIterationPolicySchema,
  graphWorkflowMutabilityPolicySchema,
  graphWorkflowPlanRepairPolicySchema,
  graphWorkflowScriptValidatorConfigSchema,
  seededAgentAssignmentSchema,
  seededValidatorCohortSchema,
  validatorCohortSchema,
} from "./config-schemas";
import {
  resolvedCollaborationConfigSchema,
  workflowCollaborationConfigOverrideSchema,
} from "./collaboration-schemas";

export const workflowConfigOverrideSchema = z.object({
  implementer: agentAssignmentSchema.optional(),
  contextValidator: validatorCohortSchema.optional(),
  scriptValidator: graphWorkflowScriptValidatorConfigSchema.optional(),
  iterationPolicy: graphWorkflowIterationPolicySchema.optional(),
  circuitBreaker: graphWorkflowCircuitBreakerPolicySchema.optional(),
  mutability: graphWorkflowMutabilityPolicySchema.optional(),
  planRepair: graphWorkflowPlanRepairPolicySchema.optional(),
  collaboration: workflowCollaborationConfigOverrideSchema.optional(),
  humanApprovalGate: graphWorkflowHumanApprovalGateConfigSchema.optional(),
  askUserQuestions: graphWorkflowAskUserQuestionsConfigSchema.optional(),
});
export type WorkflowConfigOverride = z.infer<
  typeof workflowConfigOverrideSchema
>;

// ============================================================
// Graph Workflow Semantic Definition + Execution Context
// ============================================================

export const workflowOriginSchema = z.object({
  sourceUri: z.string().min(1),
  label: z.string().min(1).optional(),
});
export type WorkflowOrigin = z.infer<typeof workflowOriginSchema>;

// Region paths may use JSON Pointer (`/tasks/task-1/instructions`) or the
// equivalent dot/bracket form. Stable ids/names are preferred for array
// members; numeric indexes are also accepted.
export const workflowLockedRegionSchema = z.object({
  paths: z.array(z.string().min(1)).min(1),
  sourceUri: z.string().min(1),
  reason: z.string().min(1),
});
export type WorkflowLockedRegion = z.infer<typeof workflowLockedRegionSchema>;

/**
 * A JSON Schema document an execution context's final output must conform to.
 *
 * Semantic identity, NOT operational config: per-context only — no workflow- or
 * global-tier default participates, because a shared output shape across
 * heterogeneous contexts is meaningless (D1). Opaque here by design: the
 * supported-keyword subset is enforced fail-closed at accept time
 * (`validateWorkflowDefinition`), so an author sees a located, actionable
 * refusal naming the offending keyword instead of an opaque Zod failure.
 *
 * Exported so every surface that can set the field — both context schemas and
 * all four edit operations in `workflows/edit-schemas.ts` — declares it once.
 */
export const contextOutputSchemaSchema = z.record(z.string(), z.unknown());

export const graphWorkflowExecutionContextDefinitionSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.preprocess(
    (val) => (typeof val === "string" && val.trim() === "" ? undefined : val),
    z.string().trim().min(1).optional(),
  ),
  acceptanceCriteria: z.string().trim().min(1),
  outputSchema: contextOutputSchemaSchema.optional(),
  implementer: agentAssignmentSchema.optional(),
  contextValidator: validatorCohortSchema.optional(),
  scriptValidator: graphWorkflowScriptValidatorConfigSchema.optional(),
  mutability: graphWorkflowMutabilityPolicySchema.optional(),
  circuitBreaker: graphWorkflowCircuitBreakerPolicySchema.optional(),
  iterationPolicy: graphWorkflowIterationPolicySchema.optional(),
  planRepair: graphWorkflowPlanRepairPolicySchema.optional(),
  collaboration: workflowCollaborationConfigOverrideSchema.optional(),
  humanApprovalGate: graphWorkflowHumanApprovalGateConfigSchema.optional(),
  askUserQuestions: graphWorkflowAskUserQuestionsConfigSchema.optional(),
  origin: workflowOriginSchema.optional(),
});
export type GraphWorkflowExecutionContextDefinition = z.infer<
  typeof graphWorkflowExecutionContextDefinitionSchema
>;

export const graphWorkflowTaskSourceSchema = z.enum(["user", "agent"]);
export const graphWorkflowTaskDefinitionSchema = z.object({
  id: z.string().trim().min(1),
  contextId: z.string().trim().min(1),
  order: z.number().int().min(1),
  title: z.string().trim().min(1),
  instructions: z.string().trim().min(1),
  metadata: z.record(z.string(), z.string()).optional(),
  source: graphWorkflowTaskSourceSchema.default("user"),
});
export type GraphWorkflowTaskDefinition = z.infer<
  typeof graphWorkflowTaskDefinitionSchema
>;

export const graphWorkflowContextEdgeSchema = z.object({
  id: z.string().trim().min(1),
  sourceContextId: z.string().trim().min(1),
  targetContextId: z.string().trim().min(1),
});
export type GraphWorkflowContextEdge = z.infer<
  typeof graphWorkflowContextEdgeSchema
>;

// ============================================================
// Workflow Parameter Declarations (launch inputs)
// ============================================================
// A definition may declare zero or more typed launch parameters so one
// definition can be launched repeatedly with run-specific values. This schema
// is intentionally PARSE-PERMISSIVE: it pins only the structural shape. The
// accept-time shape checks owned downstream (non-empty enum options,
// duplicate-name detection, default-conformance) are deliberately NOT enforced
// here so they can surface as graph-validation-shaped locator errors rather than
// Zod parse failures. All supported types bind to string values.

const parameterDeclarationCommonShape = {
  name: z.string().trim().min(1),
  label: z.string().trim().min(1),
  required: z.boolean().default(false),
};

const stringParameterDeclarationSchema = z.object({
  type: z.literal("string"),
  ...parameterDeclarationCommonShape,
  default: z.string().optional(),
  minLength: z.number().int().min(0).optional(),
  maxLength: z.number().int().min(0).optional(),
});
export type StringParameterDeclaration = z.infer<
  typeof stringParameterDeclarationSchema
>;

const textParameterDeclarationSchema = z.object({
  type: z.literal("text"),
  ...parameterDeclarationCommonShape,
  default: z.string().optional(),
  minLength: z.number().int().min(0).optional(),
  maxLength: z.number().int().min(0).optional(),
});
export type TextParameterDeclaration = z.infer<
  typeof textParameterDeclarationSchema
>;

const enumParameterDeclarationSchema = z.object({
  type: z.literal("enum"),
  ...parameterDeclarationCommonShape,
  options: z.array(z.string()),
  default: z.string().optional(),
});
export type EnumParameterDeclaration = z.infer<
  typeof enumParameterDeclarationSchema
>;

export const parameterDeclarationSchema = z.discriminatedUnion("type", [
  stringParameterDeclarationSchema,
  textParameterDeclarationSchema,
  enumParameterDeclarationSchema,
]);
export type ParameterDeclaration = z.infer<typeof parameterDeclarationSchema>;

// ============================================================
// Workflow Prerequisites (declarative environment requirements)
// ============================================================
// A definition may declare zero or more environment-level prerequisites a
// target project must satisfy before a launch proceeds. Prerequisites are
// literal/environment-level declarations and are NEVER a substitution target.

// Normalizes a skill reference for matching against discovered command/skill
// names: trims ASCII whitespace and removes AT MOST ONE leading invocation
// sigil (`/` or `$`). Case, namespace separators (`:`), and the `-`/`:`
// distinction are all significant — no case folding, suffix matching, namespace
// stripping, colon-to-hyphen translation, or basename fallback. This is the
// single source of skill-reference normalization, shared by accept-time
// validation, the start-time skill probe, and their tests.
export function normalizeSkillReference(value: string): string {
  // ASCII whitespace only (space, tab, LF, VT, FF, CR) — deliberately not the
  // Unicode-aware String.prototype.trim, so the rule matches the spec exactly
  // and normalizes identically to any future cross-runtime reimplementation.
  const trimmed = value.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, "");
  if (trimmed.startsWith("/") || trimmed.startsWith("$")) {
    return trimmed.slice(1);
  }
  return trimmed;
}

// A path segment of exactly `..` escapes the worktree; a literal `..` substring
// inside a filename (e.g. `foo..bar`) does not. Shared with the accept-time
// prerequisite validator so the R4.8 worktree-relative policy has one source.
export function pathHasParentSegment(path: string): boolean {
  return path.split(/[/\\]/).some((segment) => segment === "..");
}

export function isAbsolutePath(path: string): boolean {
  // POSIX absolute, Windows drive-letter absolute, or UNC.
  return (
    path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path)
  );
}

const prerequisiteLabelShape = {
  // Optional human-readable label/rationale; non-empty when present.
  label: z.string().trim().min(1).optional(),
};

// `.strict()` mirrors the payload-isolation pattern in
// `src/lib/agent-capabilities/schemas.ts`: any unmodeled field (including a
// `backend` on a `path` variant) is rejected at parse time so a prerequisite
// declaration carries no unmodeled channel.
const pathPrerequisiteSchema = z
  .object({
    kind: z.literal("path"),
    path: z.string().trim().min(1),
    ...prerequisiteLabelShape,
  })
  .strict()
  .superRefine((value, ctx) => {
    // Schema-level first line of defence for the worktree-relative path policy
    // (R4.8); the start-time realpath containment check (R5.3) is the second.
    if (isAbsolutePath(value.path)) {
      ctx.addIssue({
        code: "custom",
        message: `path prerequisite '${value.path}' must be worktree-relative (absolute paths are rejected)`,
        path: ["path"],
      });
    }
    if (pathHasParentSegment(value.path)) {
      ctx.addIssue({
        code: "custom",
        message: `path prerequisite '${value.path}' must not contain a '..' parent-directory segment`,
        path: ["path"],
      });
    }
  });

const skillPrerequisiteSchema = z
  .object({
    kind: z.literal("skill"),
    skill: z.string().trim().min(1),
    // Optional backend scope; an omitted backend applies to every backend the
    // launched workflow uses. A `path` prerequisite has no `backend` field.
    backend: agentBackendSchema.optional(),
    ...prerequisiteLabelShape,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (normalizeSkillReference(value.skill).length === 0) {
      ctx.addIssue({
        code: "custom",
        message: `skill prerequisite '${value.skill}' normalizes to an empty reference`,
        path: ["skill"],
      });
    }
  });

export const prerequisiteSchema = z.discriminatedUnion("kind", [
  pathPrerequisiteSchema,
  skillPrerequisiteSchema,
]);
export type WorkflowPrerequisite = z.infer<typeof prerequisiteSchema>;

export const workflowSemanticDefinitionSchema = z.object({
  schemaVersion: z.number().int().positive().default(1),
  approvalRequired: z.boolean().optional(),
  origin: workflowOriginSchema.optional(),
  lockedRegions: z.array(workflowLockedRegionSchema).optional(),
  workflowConfig: workflowConfigOverrideSchema.default({}),
  charter: workflowCharterSchema,
  parameters: z.array(parameterDeclarationSchema).default([]),
  prerequisites: z.array(prerequisiteSchema).default([]),
  executionContexts: z
    .array(graphWorkflowExecutionContextDefinitionSchema)
    .default([]),
  tasks: z.array(graphWorkflowTaskDefinitionSchema).default([]),
  edges: z.array(graphWorkflowContextEdgeSchema).default([]),
});
export type WorkflowSemanticDefinition = z.infer<
  typeof workflowSemanticDefinitionSchema
>;

export const graphWorkflowResolvedContextSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1).optional(),
  acceptanceCriteria: z.string().trim().min(1),
  origin: workflowOriginSchema.optional(),
  // Mirrored verbatim from the authored context — an identity field, not a
  // cascade result. Absent on contexts whose author declared none, and on every
  // execution seeded before the field existed.
  outputSchema: contextOutputSchemaSchema.optional(),
  // Snapshot-bearing, not reference-bearing: by the time a context is in a
  // working definition, execution start has already resolved every assignment
  // — the implementer, every enabled cohort member, and every dormant
  // assignment in a disabled cohort — through the library and stored the
  // rendered bytes. Nothing downstream resolves again (R4).
  implementer: seededAgentAssignmentSchema,
  // Never null: a disabled cohort is `enabled: false` carrying its dormant
  // assignments, so the resolved snapshot a run is seeded from can be
  // re-enabled without having lost who was configured to review (R2).
  contextValidator: seededValidatorCohortSchema,
  scriptValidator: graphWorkflowScriptValidatorConfigSchema.default({
    enabled: false,
  }),
  humanApprovalGate: graphWorkflowHumanApprovalGateConfigSchema.default({
    enabled: false,
  }),
  askUserQuestions: graphWorkflowAskUserQuestionsConfigSchema.default({
    enabled: false,
  }),
  mutability: graphWorkflowMutabilityPolicySchema,
  circuitBreaker: graphWorkflowCircuitBreakerPolicySchema,
  iterationPolicy: graphWorkflowIterationPolicySchema,
  // Plan-repair policy (docs/design/cc-cli/08). Defaulted so executions seeded
  // before D1 parse WITH repair — the block ships default-ON (F4). Lazy so
  // every legacy row gets its own object, never a shared mutable instance.
  planRepair: graphWorkflowPlanRepairPolicySchema.default(() => ({
    ...DEFAULT_PLAN_REPAIR_POLICY,
  })),
  // Resolved collaboration config (with per-field provenance) snapshotted at
  // seed time so a later saved-definition edit cannot leak into a running
  // execution (doc 06, D11). `.optional()` because executions seeded before the
  // field existed have no snapshot; the lane tool context falls back to a
  // saved-definition reload only for those legacy rows.
  collaboration: resolvedCollaborationConfigSchema.optional(),
  charter: workflowCharterSchema.optional(),
});
export type GraphWorkflowResolvedContext = z.infer<
  typeof graphWorkflowResolvedContextSchema
>;

export const resolvedWorkflowSemanticDefinitionSchema = z.object({
  schemaVersion: z.number().int().positive().default(1),
  approvalRequired: z.boolean().optional(),
  origin: workflowOriginSchema.optional(),
  lockedRegions: z.array(workflowLockedRegionSchema).optional(),
  executionContexts: z.array(graphWorkflowResolvedContextSchema).default([]),
  tasks: z.array(graphWorkflowTaskDefinitionSchema).default([]),
  edges: z.array(graphWorkflowContextEdgeSchema).default([]),
});
export type ResolvedWorkflowSemanticDefinition = z.infer<
  typeof resolvedWorkflowSemanticDefinitionSchema
>;

/**
 * The cascade result BEFORE assignments are resolved: every operational field
 * settled by the global → workflow → context cascade, with assignments still
 * naming library profiles.
 *
 * This is what the pure, synchronous resolver produces, and it is the shape the
 * builder's client-side preview works in — a browser has no library service and
 * a draft has no delivered bytes to snapshot. Execution start takes this shape,
 * resolves every assignment, and produces the seeded shape above; because a
 * seeded assignment is a cascade assignment plus `profileSnapshot`, a read-only
 * consumer that only needs identity and runtime can be typed on the cascade
 * shape and serve both.
 */
export const graphWorkflowCascadeContextSchema =
  graphWorkflowResolvedContextSchema.extend({
    implementer: agentAssignmentSchema,
    contextValidator: validatorCohortSchema,
  });
export type GraphWorkflowCascadeContext = z.infer<
  typeof graphWorkflowCascadeContextSchema
>;

export const cascadeWorkflowSemanticDefinitionSchema =
  resolvedWorkflowSemanticDefinitionSchema.extend({
    executionContexts: z.array(graphWorkflowCascadeContextSchema).default([]),
  });
export type CascadeWorkflowSemanticDefinition = z.infer<
  typeof cascadeWorkflowSemanticDefinitionSchema
>;

const graphWorkflowPositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});

const graphWorkflowViewportSchema = z.object({
  x: z.number().default(0),
  y: z.number().default(0),
  zoom: z.number().positive().default(1),
});

export const graphWorkflowVisualLayoutSchema = z.object({
  workflowId: z.string().trim().min(1),
  contextPositions: z
    .record(z.string(), graphWorkflowPositionSchema)
    .default({}),
  viewport: graphWorkflowViewportSchema.default({ x: 0, y: 0, zoom: 1 }),
});
export type GraphWorkflowVisualLayout = z.infer<
  typeof graphWorkflowVisualLayoutSchema
>;

export const workflowDefinitionRecordSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  description: z.string().trim().min(1).nullable().default(null),
  schemaVersion: z.number().int().positive().default(1),
  revision: z.number().int().min(1),
  definition: workflowSemanticDefinitionSchema,
  layout: graphWorkflowVisualLayoutSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WorkflowDefinitionRecord = z.infer<
  typeof workflowDefinitionRecordSchema
>;

export const workflowValidatorIssueSchema = z.object({
  taskId: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
});
export type WorkflowValidatorIssue = z.infer<
  typeof workflowValidatorIssueSchema
>;

/**
 * An issue as RECORDED on a validation result, which is a wider surface than
 * the agent validator's own output contract above.
 *
 * `taskId` is optional here because not every validation is task-scoped: an
 * output-schema rejection (D2) is located by instance path inside the rejected
 * payload, not by task. `path` carries that location; for a task-scoped issue it
 * is simply absent. The agent validator's parse contract keeps `taskId`
 * required, so widening here cannot loosen what a validator may return.
 *
 * `assignmentId` names the validator assignment that raised the finding. It is
 * stamped by the engine rather than reported by the validator — a reviewer
 * writes about the work, not about itself, so two specialists can word one
 * objection identically and nothing in the text would tell them apart. Absent
 * on findings that no assignment raised (an output-schema rejection) and on
 * rows written before cohorts existed.
 */
export const graphWorkflowValidationIssueSchema =
  workflowValidatorIssueSchema.extend({
    taskId: z.string().trim().min(1).optional(),
    path: z.string().trim().min(1).optional(),
    assignmentId: z.string().trim().min(1).optional(),
  });
export type GraphWorkflowValidationIssue = z.infer<
  typeof graphWorkflowValidationIssueSchema
>;

export const workflowAgentValidatorResultSchema = z.object({
  summary: z.string(),
  issues: z.array(workflowValidatorIssueSchema).default([]),
});

export const graphWorkflowSharedDocumentEntrySchema = z.object({
  id: z.string().trim().min(1),
  relativePath: z.string().trim().min(1),
  description: z.string().trim().min(1),
  readWhen: z.string().trim().min(1),
  // Distinguishes the reserved charter document from ordinary shared docs.
  // Entries persisted before this discriminator existed parse as "shared".
  kind: z.enum(["shared", "charter"]).default("shared"),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastUpdatedByConversationId: z.string().nullable().default(null),
});
export type GraphWorkflowSharedDocumentEntry = z.infer<
  typeof graphWorkflowSharedDocumentEntrySchema
>;

export const graphWorkflowStatusSchema = z.enum([
  "pending",
  "running",
  "paused",
  "completed",
  "halted",
  "aborted",
]);
export type GraphWorkflowStatus = z.infer<typeof graphWorkflowStatusSchema>;

export const graphWorkflowContextStatusSchema = z.enum([
  "pending",
  "ready",
  "running",
  "completed",
  "halted",
  "awaiting_approval",
  "awaiting_user_input",
]);
export type GraphWorkflowContextStatus = z.infer<
  typeof graphWorkflowContextStatusSchema
>;

export const graphWorkflowTaskStatusSchema = z.enum([
  "pending",
  "running",
  "interrupted",
  "completed",
  "failed",
]);
export type GraphWorkflowTaskStatus = z.infer<
  typeof graphWorkflowTaskStatusSchema
>;

export const graphWorkflowValidatorTypeSchema = z.enum(["context"]);
export type GraphWorkflowValidatorType = z.infer<
  typeof graphWorkflowValidatorTypeSchema
>;

// ============================================================
// Workflow Plan / Generation
// ============================================================

export const workflowGraphValidationErrorSchema = z.object({
  code: z.string().trim().min(1),
  message: z.string().trim().min(1),
  contextId: z.string().trim().min(1).optional(),
  taskId: z.string().trim().min(1).optional(),
  edgeId: z.string().trim().min(1).optional(),
  operationIndex: z.number().int().min(0).optional(),
  parameterName: z.string().trim().min(1).optional(),
  field: z.string().trim().min(1).optional(),
});
export type WorkflowGraphValidationError = z.infer<
  typeof workflowGraphValidationErrorSchema
>;

const workflowPlanReferenceSchema = z.object({
  filePath: z.string().trim().min(1),
  description: z.string().trim().min(1),
});

export const workflowPlanRequestSchema = z.object({
  objective: z.string().trim().min(1),
  references: z.array(workflowPlanReferenceSchema).default([]),
  seedDefinitionId: z.string().trim().min(1).optional(),
});
export type WorkflowPlanRequest = z.infer<typeof workflowPlanRequestSchema>;

export const workflowGeneratedDraftSchema = z.object({
  definition: workflowSemanticDefinitionSchema,
  layout: graphWorkflowVisualLayoutSchema,
  validationErrors: z.array(workflowGraphValidationErrorSchema).default([]),
});
export type WorkflowGeneratedDraft = z.infer<
  typeof workflowGeneratedDraftSchema
>;
