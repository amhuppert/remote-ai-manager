import { z } from "zod";
import { agentBackendSchema } from "@/lib/shared/schemas";
import { validationCommandNameSchema } from "@/lib/validation/schemas";
import { workflowCharterSchema } from "@/lib/workflows/charter-schemas";
import {
  DEFAULT_LANE_MERGE_VALIDATION_CONFIG,
  DEFAULT_PLAN_REPAIR_POLICY,
  agentAssignmentSchema,
  graphWorkflowAgentValidationOverrideSchema,
  graphWorkflowAskUserQuestionsConfigSchema,
  graphWorkflowCircuitBreakerPolicySchema,
  graphWorkflowCommandSelectorSchema,
  graphWorkflowHumanApprovalGateConfigSchema,
  graphWorkflowIterationPolicySchema,
  graphWorkflowLaneMergeValidationConfigSchema,
  graphWorkflowLaneMergeValidationOverrideSchema,
  graphWorkflowMutabilityPolicySchema,
  graphWorkflowPlanRepairPolicySchema,
  graphWorkflowScriptValidatorConfigSchema,
  seededAgentAssignmentSchema,
  seededValidatorCohortSchema,
  validatorCohortSchema,
} from "./config-schemas";
import {
  collaborationConfigSourceSchema,
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
  agentValidation: graphWorkflowAgentValidationOverrideSchema.optional(),
  // Workflow tier only — deliberately absent from the execution-context
  // definition: the lane-merge gate guards the shared fan-in target, so a
  // per-context override would be ambiguous (validation-concurrency §6).
  laneMergeValidation:
    graphWorkflowLaneMergeValidationOverrideSchema.optional(),
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

/**
 * How many of a source context's outgoing conditional edges may activate (D4
 * R3). `independent` (the meaning of an absent block) admits zero, one, or many;
 * `atLeastOne` and `exactlyOne` turn under- or over-selection into a typed
 * resumable routing halt at runtime.
 *
 * A property of the source's outgoing edge SET, so it lives on the context — per
 * edge it would invite contradictory declarations. The FIELD stays optional with
 * no default on both tiers: materializing `{ cardinality: "independent" }` on
 * every pre-D4 context would break the dormant-by-default floor (R14.1).
 *
 * Exported so every surface that can set it — both context schemas and the
 * context edit operations in `workflows/edit-schemas.ts` — declares it once.
 */
export const graphWorkflowContextRoutingPolicySchema = z.object({
  cardinality: z
    .enum(["independent", "atLeastOne", "exactlyOne"])
    .default("independent"),
});
export type GraphWorkflowContextRoutingPolicy = z.infer<
  typeof graphWorkflowContextRoutingPolicySchema
>;

/**
 * One authored ownership entry: a normalized repo-relative POSIX path that
 * covers itself and everything beneath it (R1).
 *
 * The normalization rules mirror the specs `touchedPath` schema rather than
 * importing it. Ownership is a workflow-graph concept the spec compiler maps
 * `touchedPaths` ONTO, so the two are free to diverge — and this one already
 * does: it additionally denies the repository root and git metadata. That
 * denial is unconditional because an agent able to write `.git` could commit,
 * branch, or reset the lane out from under the engine, which is precisely what
 * the ownership envelope exists to make impossible. The `.git` comparison folds
 * case: a case-insensitive filesystem resolves `.GIT` to the same directory, so
 * a literal-only refusal would be bypassable on macOS.
 *
 * An entry is a LITERAL path, never a glob (spec non-goal) — a metacharacter is
 * read as an ordinary filename character here, and the write-policy adapter is
 * what refuses one, because that is the layer that knows what the backend can
 * actually enforce. Directory-grain entries cover the need a glob would.
 */
export const ownedPathSchema = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    const reject = (message: string): void => {
      ctx.addIssue({ code: "custom", message });
    };
    if (value === "." || value === "./") {
      reject(
        `owned path "${value}" names the repository root; declare the directories the context owns instead`,
      );
      return;
    }
    const segments = value.split("/");
    if (
      value !== value.trim() ||
      value.startsWith("/") ||
      /^[A-Za-z]:/.test(value) ||
      value.includes("\\") ||
      value.endsWith("/") ||
      segments.some(
        (segment) =>
          segment.length === 0 || segment === "." || segment === "..",
      )
    ) {
      reject(
        `owned path "${value}" must be a normalized repo-relative POSIX path without parent segments or trailing separators`,
      );
      return;
    }
    if (segments[0]?.toLowerCase() === ".git") {
      reject(
        `owned path "${value}" names repository metadata; .git is denied regardless of authored ownership`,
      );
    }
  });
export type OwnedPath = z.infer<typeof ownedPathSchema>;

const placementLaneShape = {
  /**
   * The authored lane name. Grammar (charset, reserved session identifiers,
   * the session lane's read-only restriction) is checked in
   * `placement-validation.ts` rather than here, so the refusal can name the
   * context that declared it — the same reason `outputSchema` parses
   * permissively and is refused at accept time.
   */
  lane: z.string().trim().min(1),
};

/**
 * Where an execution context runs and what it may write (R1, decision D1).
 *
 * Discriminated on `mode` so the three grades carry exactly their own
 * obligations: `owned` requires a non-empty prefix set, and both other grades
 * forbid one — `.strict()` turns a stray `ownedPaths` on a full-access or
 * read-only placement into a located refusal rather than a silently ignored
 * declaration of intent. An empty array is invalid by construction: `readOnly`
 * is the explicit grade for a context with no write surface, so an empty
 * `ownedPaths` would be a second, ambiguous spelling of it.
 */
export const contextPlacementSchema = z.discriminatedUnion("mode", [
  z.object({ ...placementLaneShape, mode: z.literal("full") }).strict(),
  z
    .object({
      ...placementLaneShape,
      mode: z.literal("owned"),
      ownedPaths: z.array(ownedPathSchema).min(1, {
        message:
          'an owning placement must declare at least one owned path; use mode "readOnly" for a context with no write surface',
      }),
    })
    .strict(),
  z.object({ ...placementLaneShape, mode: z.literal("readOnly") }).strict(),
]);
export type ContextPlacement = z.infer<typeof contextPlacementSchema>;

export const graphWorkflowExecutionContextDefinitionSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.preprocess(
    (val) => (typeof val === "string" && val.trim() === "" ? undefined : val),
    z.string().trim().min(1).optional(),
  ),
  acceptanceCriteria: z.string().trim().min(1),
  // Required, with no runtime default: deterministic seed-time lane assignment
  // is fully replaced by authored placement (locked fork F1), and an optional
  // field would silently resurrect it. Stored definitions written before
  // placement existed are migrated at their inflate boundary, never here.
  placement: contextPlacementSchema,
  outputSchema: contextOutputSchemaSchema.optional(),
  routing: graphWorkflowContextRoutingPolicySchema.optional(),
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
  agentValidation: graphWorkflowAgentValidationOverrideSchema.optional(),
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

/**
 * An edge's source-local activation guard (D4 R1). Either a JSON-Schema-subset
 * document the source context's captured output must match, or the `else`
 * marker — the branch taken when no conditional sibling from the same source
 * activated.
 *
 * The document is parse-PERMISSIVE for the same reason `outputSchema` is: the
 * supported-keyword subset, and the guard's compatibility with the source's
 * declared output shape, are enforced fail-closed at accept time
 * (`validateWorkflowDefinition` → `validateEdgeGuards`) so an author gets a
 * located, actionable refusal instead of an opaque Zod failure.
 *
 * Both branches are `.strict()`: a document carrying `schema` AND `else` states
 * two contradictory activation rules, and the permissive branch would otherwise
 * absorb it and silently drop the marker.
 *
 * The `{ schema }` wrapper (rather than a bare document) leaves room for future
 * condition kinds without a breaking change.
 */
export const graphWorkflowEdgeGuardSchema = z.union([
  z.object({ schema: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ else: z.literal(true) }).strict(),
]);
export type GraphWorkflowEdgeGuard = z.infer<
  typeof graphWorkflowEdgeGuardSchema
>;

export const graphWorkflowContextEdgeSchema = z.object({
  id: z.string().trim().min(1),
  sourceContextId: z.string().trim().min(1),
  targetContextId: z.string().trim().min(1),
  // Absent = unconditional, which is every pre-D4 edge. Never defaulted: the
  // dormant floor is the ABSENCE of the field, not a materialized "always" guard
  // (R14.1 — a pre-D4 definition must parse to observably pre-D4 behaviour).
  when: graphWorkflowEdgeGuardSchema.optional(),
});
export type GraphWorkflowContextEdge = z.infer<
  typeof graphWorkflowContextEdgeSchema
>;

/**
 * A loop group's exit predicate (D4 R9): a JSON-Schema-subset document the
 * EXIT context's captured output must match for the loop to conclude.
 *
 * Parse-permissive and `.strict()` for the same reasons as
 * {@link graphWorkflowEdgeGuardSchema}: the supported-keyword subset and the
 * static compatibility with the exit's declared `outputSchema` are enforced
 * fail-closed at accept time so an author gets a located refusal, and the
 * `{ schema }` wrapper leaves room for future predicate kinds. Unlike an edge
 * guard there is no `else` branch — a loop concludes or it does not.
 */
export const graphWorkflowLoopPredicateSchema = z
  .object({ schema: z.record(z.string(), z.unknown()) })
  .strict();
export type GraphWorkflowLoopPredicate = z.infer<
  typeof graphWorkflowLoopPredicateSchema
>;

/**
 * An AUTHORED loop group (D4 R9, R11). The body is declared by REFERENCE: its
 * contexts, tasks, and internal edges are ordinary members of the authored
 * definition, named here by id. The accept-time resolver
 * (`resolveLoopGroups`) is what turns that reference into the versioned body
 * template the engine clones per pass.
 *
 * `maxPasses` is mandatory (R10): a loop with no declared ceiling has no
 * exhaustion halt, and there is no completion-on-exhaustion mode.
 */
export const graphWorkflowLoopGroupSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1).optional(),
  bodyContextIds: z.array(z.string().trim().min(1)).min(1),
  entryContextId: z.string().trim().min(1),
  exitContextId: z.string().trim().min(1),
  until: graphWorkflowLoopPredicateSchema,
  maxPasses: z.number().int().min(1),
});
export type GraphWorkflowLoopGroup = z.infer<
  typeof graphWorkflowLoopGroupSchema
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
  // Absent = no loops, which is every pre-D4 definition. Never defaulted to
  // `[]` for the same reason `when` is never defaulted: the dormant floor is
  // the ABSENCE of the field (R14.1).
  loopGroups: z.array(graphWorkflowLoopGroupSchema).optional(),
});
export type WorkflowSemanticDefinition = z.infer<
  typeof workflowSemanticDefinitionSchema
>;

// Resolved per-role validation allowlists with the same per-field provenance
// contract as resolved collaboration: each role selector resolves
// independently (per-node → workflow → global), so one resolved block can
// carry two distinct sources.
const resolvedAgentValidationSelectorSchema = z.object({
  value: graphWorkflowCommandSelectorSchema,
  source: collaborationConfigSourceSchema,
  // The selector expanded to explicit command names against the project
  // registry when the execution was seeded (or when a live edit rewrote this
  // role) — enforcement and prompts read THIS, so later registry edits never
  // broaden a running execution (design §6). Absent on rows frozen before the
  // snapshot existed; policy treats absence as legacy.
  commands: z.array(validationCommandNameSchema).optional(),
});

export const resolvedAgentValidationConfigSchema = z.object({
  implementer: resolvedAgentValidationSelectorSchema,
  contextValidator: resolvedAgentValidationSelectorSchema,
});
export type ResolvedAgentValidationConfig = z.infer<
  typeof resolvedAgentValidationConfigSchema
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
  // Same identity passthrough: no cascade tier contributes a routing policy.
  routing: graphWorkflowContextRoutingPolicySchema.optional(),
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
    commands: [],
  }),
  // Provenance for the script command selection frozen into this resolved
  // context. Optional for executions seeded before selector provenance existed.
  scriptValidatorSource: collaborationConfigSourceSchema.optional(),
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
  // Resolved per-role validation allowlists (with provenance), snapshotted at
  // seed time like collaboration. `.optional()` because executions seeded
  // before the field existed have no snapshot; policy enforcement treats
  // absence as the seeded defaults.
  agentValidation: resolvedAgentValidationConfigSchema.optional(),
  charter: workflowCharterSchema.optional(),
});
export type GraphWorkflowResolvedContext = z.infer<
  typeof graphWorkflowResolvedContextSchema
>;

/**
 * The immutable per-loop body snapshot pass instances are cloned FROM (R11).
 * Membership (which contexts form the body, which is entry, which is exit)
 * freezes once the first pass starts; content stays editable at quiescence,
 * each edit bumping the owning group's `templateVersion`.
 *
 * The contexts are RESOLVED contexts: the body is snapshotted after the config
 * cascade runs, so every pass clones an instance whose operational config is
 * the one the seed resolved — a later saved-definition edit cannot leak in.
 */
export const graphWorkflowLoopBodyTemplateSchema = z.object({
  contexts: z.array(graphWorkflowResolvedContextSchema).min(1),
  tasks: z.array(graphWorkflowTaskDefinitionSchema).default([]),
  edges: z.array(graphWorkflowContextEdgeSchema).default([]),
});
export type GraphWorkflowLoopBodyTemplate = z.infer<
  typeof graphWorkflowLoopBodyTemplateSchema
>;

/**
 * A RESOLVED loop group: the authored declaration after the accept-time
 * resolver has snapshotted its body into {@link graphWorkflowLoopBodyTemplateSchema}
 * and removed those contexts from `executionContexts`. `entryContextId` and
 * `exitContextId` still name the AUTHORED (logical) ids — the exit stays
 * immutable in the authored topology while the route projection points runtime
 * consumers at the pass instance that actually satisfies each external edge
 * (D1).
 *
 * `planRepair` is resolved HERE, at seed, rather than read at repair time: the
 * resolved working definition deliberately drops workflow-tier config, so the
 * policy has to survive in the artifact the engine actually reads (D10).
 */
export const graphWorkflowResolvedLoopGroupSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1).optional(),
  entryContextId: z.string().trim().min(1),
  exitContextId: z.string().trim().min(1),
  until: graphWorkflowLoopPredicateSchema,
  maxPasses: z.number().int().min(1),
  template: graphWorkflowLoopBodyTemplateSchema,
  templateVersion: z.number().int().min(1).default(1),
  planRepair: graphWorkflowPlanRepairPolicySchema,
});
export type GraphWorkflowResolvedLoopGroup = z.infer<
  typeof graphWorkflowResolvedLoopGroupSchema
>;

export const resolvedWorkflowSemanticDefinitionSchema = z.object({
  schemaVersion: z.number().int().positive().default(1),
  approvalRequired: z.boolean().optional(),
  origin: workflowOriginSchema.optional(),
  lockedRegions: z.array(workflowLockedRegionSchema).optional(),
  // The workflow-scope lane-merge validation selection, resolved (global →
  // workflow) and snapshotted at seed time so merge submissions read the
  // execution's own record, never the saved definition. Workflow tier only —
  // the gate guards the shared fan-in target, so no per-context copy exists
  // (validation-concurrency §6). The default materializes the approved seeded
  // policy for persisted executions created before this snapshot existed.
  laneMergeValidation: graphWorkflowLaneMergeValidationConfigSchema.default(
    DEFAULT_LANE_MERGE_VALIDATION_CONFIG,
  ),
  executionContexts: z.array(graphWorkflowResolvedContextSchema).default([]),
  tasks: z.array(graphWorkflowTaskDefinitionSchema).default([]),
  edges: z.array(graphWorkflowContextEdgeSchema).default([]),
  // Same dormancy rule as the authored tier: absent means "no loops", and an
  // execution seeded before D4 must reload with the field still absent.
  loopGroups: z.array(graphWorkflowResolvedLoopGroupSchema).optional(),
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

/**
 * The pre-seeding loop template. Loop resolution runs after the config cascade,
 * so both the pass-1 instances and the frozen authored body still carry profile
 * references until the execution's assignment-seeding boundary resolves them.
 */
export const graphWorkflowCascadeLoopBodyTemplateSchema =
  graphWorkflowLoopBodyTemplateSchema.extend({
    contexts: z.array(graphWorkflowCascadeContextSchema).min(1),
  });
export type GraphWorkflowCascadeLoopBodyTemplate = z.infer<
  typeof graphWorkflowCascadeLoopBodyTemplateSchema
>;

export const graphWorkflowCascadeLoopGroupSchema =
  graphWorkflowResolvedLoopGroupSchema.extend({
    template: graphWorkflowCascadeLoopBodyTemplateSchema,
  });
export type GraphWorkflowCascadeLoopGroup = z.infer<
  typeof graphWorkflowCascadeLoopGroupSchema
>;

export const cascadeWorkflowSemanticDefinitionSchema =
  resolvedWorkflowSemanticDefinitionSchema.extend({
    executionContexts: z.array(graphWorkflowCascadeContextSchema).default([]),
    loopGroups: z.array(graphWorkflowCascadeLoopGroupSchema).optional(),
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

/**
 * A non-blocking observation, in the one shape both authorities emit.
 *
 * It carries no `taskId` by construction: an advisory is addressed to the
 * implementer, not to a task the engine must reopen, and `kind` already says
 * whether it is about the implementation, the plan, or something outside this
 * context entirely. Nothing here is checked against the context's task set, so
 * an observation about code no task owns costs the lane nothing.
 */
export const workflowValidatorAdvisorySchema = z
  .object({
    kind: z.enum(["implementation", "plan", "out_of_scope"]),
    title: z.string().trim().min(1),
    description: z.string().trim().min(1),
  })
  .strict();
export type WorkflowValidatorAdvisory = z.infer<
  typeof workflowValidatorAdvisorySchema
>;

/**
 * What names ONE advisory, for as long as anything refers to it.
 *
 * Stamped by the engine when a lane's result is accepted into the round record,
 * never reported by the validator that raised it: an advisory is delivered,
 * disposed of, and indexed by this triple, so a self-reported identity would let
 * one specialist claim another's advisory or renumber its own between rounds.
 * The three components are exactly what makes it unique — a round, a seat in
 * that round's roster, and the advisory's position in that seat's own output.
 */
export const workflowAdvisoryIdentitySchema = z
  .object({
    roundSeq: z.number().int().positive(),
    assignmentId: z.string().trim().min(1),
    /** 1-based position within its own lane's advisories. */
    ordinal: z.number().int().positive(),
  })
  .strict();
export type WorkflowAdvisoryIdentity = z.infer<
  typeof workflowAdvisoryIdentitySchema
>;

/** What the implementer may do with an advisory. */
export const ADVISORY_DISPOSITION_VALUES = [
  "addressed",
  "declined",
  "deferred",
] as const;

/**
 * One disposition as the advisory-response turn returns it.
 *
 * A flat object rather than a union discriminated on `disposition`, and a
 * nullable `reason` rather than an absent one, because this is the parse twin of
 * a dispatched schema that must stay inside what a provider-native backend
 * accepts — no `oneOf`, no optional property. Declining still owes an
 * explanation; that rule is enforced in `parseAdvisoryDispositions`, which is
 * already where the checks no schema can carry are reported.
 */
export const workflowAdvisoryDispositionEntrySchema = z
  .object({
    identity: workflowAdvisoryIdentitySchema,
    disposition: z.enum(ADVISORY_DISPOSITION_VALUES),
    reason: z.string().nullable(),
  })
  .strict();
export type WorkflowAdvisoryDispositionEntry = z.infer<
  typeof workflowAdvisoryDispositionEntrySchema
>;

/**
 * The advisory-response turn's output contract, read back off the turn.
 *
 * Closed and exhaustive for the same reason as the validator parse twins: this
 * is not a laxer fallback but the same contract the dispatched schema enforces,
 * so anything it accepts beyond that shape is a disposition that reached the
 * engine without passing the gate.
 */
export const workflowAdvisoryDispositionsResultSchema = z
  .object({
    dispositions: z.array(workflowAdvisoryDispositionEntrySchema),
  })
  .strict();

/**
 * The issue shape as a validator may EMIT it, closed to anything else.
 *
 * Strictness lives here rather than on `workflowValidatorIssueSchema` because
 * that base is also the persisted shape (extended for recorded findings, stored
 * on specialist state), where an unknown key is a row to read, not a verdict to
 * refuse.
 */
const workflowValidatorOutputIssueSchema =
  workflowValidatorIssueSchema.strict();

/**
 * The two parse-side twins of the dispatched output schemas, split by
 * authority.
 *
 * Both are closed and require every field the dispatched schema requires,
 * because these twins are not a laxer fallback contract — they are the same
 * contract read back off a backend with no native structured output. Anything
 * they accept beyond the dispatched shape is a verdict that reached the engine
 * without passing the gate: a blocking finding smuggled in by an advisory seat,
 * an advisory silently stripped of a field, or a missing array defaulted to
 * empty so a validator that never considered advisories reads as one that found
 * none. Refusing here routes the payload to the same structured-output retry
 * the gate would have run.
 */
export const workflowBlockingValidatorResultSchema = z
  .object({
    summary: z.string(),
    issues: z.array(workflowValidatorOutputIssueSchema),
    advisories: z.array(workflowValidatorAdvisorySchema),
  })
  .strict();

export const workflowAdvisoryValidatorResultSchema = z
  .object({
    summary: z.string(),
    advisories: z.array(workflowValidatorAdvisorySchema),
  })
  .strict();

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

/**
 * `skipped` is a terminal settled-with-nothing status (D4 R4): the context's
 * incoming routes resolved against it, so it holds no lane, owes no task,
 * validator, approval or output debt, and contributes no merge input. It is
 * NOT a failure and NOT a pause — nothing leaves it within the execution.
 */
export const graphWorkflowContextStatusSchema = z.enum([
  "pending",
  "ready",
  "running",
  "completed",
  "halted",
  "awaiting_approval",
  "awaiting_user_input",
  "skipped",
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
