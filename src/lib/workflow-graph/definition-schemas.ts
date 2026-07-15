import { z } from "zod";
import { agentBackendSchema } from "@/lib/shared/schemas";
import { workflowCharterSchema } from "@/lib/workflows/charter-schemas";
import {
  contextValidatorOverrideSchema,
  graphWorkflowAgentConfigSchema,
  graphWorkflowAgentValidatorConfigSchema,
  graphWorkflowAskUserQuestionsConfigSchema,
  graphWorkflowCircuitBreakerPolicySchema,
  graphWorkflowHumanApprovalGateConfigSchema,
  graphWorkflowIterationPolicySchema,
  graphWorkflowMutabilityPolicySchema,
  graphWorkflowScriptValidatorConfigSchema,
} from "./config-schemas";
import {
  resolvedCollaborationConfigSchema,
  workflowCollaborationConfigOverrideSchema,
} from "./collaboration-schemas";

export const workflowConfigOverrideSchema = z.object({
  implementer: graphWorkflowAgentConfigSchema.optional(),
  contextValidator: graphWorkflowAgentValidatorConfigSchema.optional(),
  scriptValidator: graphWorkflowScriptValidatorConfigSchema.optional(),
  iterationPolicy: graphWorkflowIterationPolicySchema.optional(),
  circuitBreaker: graphWorkflowCircuitBreakerPolicySchema.optional(),
  mutability: graphWorkflowMutabilityPolicySchema.optional(),
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

export const graphWorkflowExecutionContextDefinitionSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.preprocess(
    (val) => (typeof val === "string" && val.trim() === "" ? undefined : val),
    z.string().trim().min(1).optional(),
  ),
  acceptanceCriteria: z.string().trim().min(1),
  implementer: graphWorkflowAgentConfigSchema.optional(),
  contextValidator: contextValidatorOverrideSchema.optional(),
  scriptValidator: graphWorkflowScriptValidatorConfigSchema.optional(),
  mutability: graphWorkflowMutabilityPolicySchema.optional(),
  circuitBreaker: graphWorkflowCircuitBreakerPolicySchema.optional(),
  iterationPolicy: graphWorkflowIterationPolicySchema.optional(),
  collaboration: workflowCollaborationConfigOverrideSchema.optional(),
  humanApprovalGate: graphWorkflowHumanApprovalGateConfigSchema.optional(),
  askUserQuestions: graphWorkflowAskUserQuestionsConfigSchema.optional(),
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
  implementer: graphWorkflowAgentConfigSchema,
  contextValidator: graphWorkflowAgentValidatorConfigSchema.nullable(),
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
  executionContexts: z.array(graphWorkflowResolvedContextSchema).default([]),
  tasks: z.array(graphWorkflowTaskDefinitionSchema).default([]),
  edges: z.array(graphWorkflowContextEdgeSchema).default([]),
});
export type ResolvedWorkflowSemanticDefinition = z.infer<
  typeof resolvedWorkflowSemanticDefinitionSchema
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
