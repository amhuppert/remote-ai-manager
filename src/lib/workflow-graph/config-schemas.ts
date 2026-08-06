import { z } from "zod";
import {
  claudeModelSchema,
  codexModelSchema,
  codexReasoningEffortSchema,
  effortLevelSchema,
} from "@/lib/agent-backends/schemas";
import {
  ASSIGNMENT_FOCUS_MAX_LENGTH,
  findReservedSequence,
  normalizeAssignmentFocus,
} from "@/lib/agent-profiles/block";
import {
  agentProfileRefSchema,
  agentProfileSnapshotSchema,
} from "@/lib/agent-profiles/schemas";
import { escapeDiagnosticValue } from "@/lib/shared/diagnostic-text";

// ============================================================
// Graph Workflow Agent Configuration Schemas
// ============================================================

const graphWorkflowClaudeAgentConfigSchema = z.object({
  backend: z.literal("claude"),
  model: claudeModelSchema,
  reasoningEffort: effortLevelSchema,
});

const graphWorkflowCodexAgentConfigSchema = z.object({
  backend: z.literal("codex"),
  model: codexModelSchema,
  reasoningEffort: codexReasoningEffortSchema,
});

export const graphWorkflowAgentConfigSchema = z.preprocess(
  (val) => {
    if (typeof val === "object" && val !== null && !("backend" in val)) {
      return { ...val, backend: "claude" };
    }
    return val;
  },
  z.discriminatedUnion("backend", [
    graphWorkflowClaudeAgentConfigSchema,
    graphWorkflowCodexAgentConfigSchema,
  ]),
);
export type GraphWorkflowAgentConfig = z.infer<
  typeof graphWorkflowAgentConfigSchema
>;

export const graphWorkflowMutabilityPolicySchema = z.object({
  allowAgentTaskAdd: z.boolean().default(false),
});
export type GraphWorkflowMutabilityPolicy = z.infer<
  typeof graphWorkflowMutabilityPolicySchema
>;

export const graphWorkflowCircuitBreakerPolicySchema = z.object({
  consecutiveFailureThreshold: z.number().int().min(1).optional(),
});
export type GraphWorkflowCircuitBreakerPolicy = z.infer<
  typeof graphWorkflowCircuitBreakerPolicySchema
>;

// Plan-repair agent policy (docs/design/cc-cli/08, roadmap D1): on a
// retry-exhaustion halt (circuit breaker / max iterations) an agent reviews the
// failure and, for planning defects, patches the plan artifacts and resumes.
// Default ON (F4); `agent` overrides the repair agent's model — the resolver
// falls back to claude/opus/high when absent.
export const graphWorkflowPlanRepairPolicySchema = z.object({
  enabled: z.boolean().default(true),
  maxAttemptsPerContext: z.number().int().min(1).default(2),
  agent: graphWorkflowAgentConfigSchema.optional(),
});
export type GraphWorkflowPlanRepairPolicy = z.infer<
  typeof graphWorkflowPlanRepairPolicySchema
>;

/**
 * The one canonical plan-repair default, derived from the schema's own field
 * defaults. Every surface that needs a concrete policy (cascade fallback,
 * resolved-context floor, UI seeds) references this object — never a
 * re-written literal.
 */
export const DEFAULT_PLAN_REPAIR_POLICY: GraphWorkflowPlanRepairPolicy =
  graphWorkflowPlanRepairPolicySchema.parse({});

/**
 * The repair agent the supervisor falls back to when `planRepair.agent` is
 * unset anywhere in the cascade. Rare, high-stakes invocations — default to
 * the strongest configuration.
 */
export const PLAN_REPAIR_DEFAULT_AGENT: GraphWorkflowAgentConfig = {
  backend: "claude",
  model: "opus",
  reasoningEffort: "high",
};

export const graphWorkflowLaneContinuityPolicySchema = z.object({
  enabled: z.boolean().default(true),
  contextLimitTokens: z.number().int().positive().optional(),
});
export const graphWorkflowIterationPolicySchema = z.object({
  maxIterations: z.number().int().min(1),
  continuity: graphWorkflowLaneContinuityPolicySchema.default({
    enabled: true,
  }),
});
export type GraphWorkflowIterationPolicy = z.infer<
  typeof graphWorkflowIterationPolicySchema
>;

// ============================================================
// Agent Assignments and Validator Cohorts
// ============================================================

/**
 * The upper bound on an assignment's `focus`. A focus is a use-site steer that
 * narrows a library profile ("auth boundaries", "hot paths") — the durable
 * behaviour belongs in the profile itself. Re-exported from the composer that
 * renders the focus rather than restated: authoring must refuse exactly what
 * rendering would refuse, or a saved assignment could fail to compose later.
 */
export const AGENT_ASSIGNMENT_FOCUS_MAX_LENGTH = ASSIGNMENT_FOCUS_MAX_LENGTH;

/** Lowercase kebab-case, bounded: the stable use-site identity of an assignment. */
const ASSIGNMENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const agentAssignmentIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(ASSIGNMENT_ID, {
    message:
      'Assignment ids are lowercase kebab-case slugs of 1-64 characters, for example "security-reviewer".',
  });

/**
 * A use-site steer, stored in exactly the form the composer will render.
 *
 * Normalization happens at parse rather than at render so the persisted value
 * IS the canonical one: two byte-different spellings of the same steer cannot
 * survive into storage and later produce two different resolved hashes. The
 * containment rules are the composer's, applied here so a colliding focus is
 * refused on the authoring surface that can still fix it instead of failing
 * when a lane tries to compose it.
 */
const assignmentFocusSchema = z.preprocess(
  (val) =>
    typeof val === "string"
      ? (normalizeAssignmentFocus(val) ?? undefined)
      : val,
  z
    .string()
    .max(AGENT_ASSIGNMENT_FOCUS_MAX_LENGTH)
    .superRefine((focus, ctx) => {
      const collision = findReservedSequence(focus);
      if (collision === null) return;
      ctx.addIssue({
        code: "custom",
        message: `Assignment focus may not contain the reserved sequence ${JSON.stringify(collision.sequence)} (at offset ${collision.offset}) — it would terminate the profile block it is rendered inside.`,
      });
    })
    .optional(),
);

/**
 * Who runs at a use site: a stable id, the library profile supplying prompt
 * identity, an optional narrowing focus, and the concrete per-backend runtime.
 *
 * Strict by construction — the pre-cutover singleton shapes (`type`, `codex`,
 * a bare agent config) must FAIL here rather than parse into a half-populated
 * assignment. There is no inbound compatibility parser; migration rewrites
 * persisted config once, and everything else refuses loudly.
 */
export const agentAssignmentSchema = z
  .object({
    id: agentAssignmentIdSchema,
    profile: agentProfileRefSchema,
    focus: assignmentFocusSchema,
    agent: graphWorkflowAgentConfigSchema,
  })
  .strict();
export type AgentAssignment = z.infer<typeof agentAssignmentSchema>;

/**
 * A validator use site. Strategy is independent of backend exactly as the
 * pre-cutover `type` field was in practice: all four backend-x-strategy
 * combinations are expressible, and dispatch reads `strategy` directly.
 */
export const validatorAssignmentSchema = agentAssignmentSchema
  .extend({
    strategy: z.enum(["conversation", "task"]),
    continuity: graphWorkflowLaneContinuityPolicySchema.default({
      enabled: true,
    }),
  })
  .strict();
export type ValidatorAssignment = z.infer<typeof validatorAssignmentSchema>;

/**
 * The ordered set of validators reviewing one context, replaced as a whole unit
 * at every cascade boundary.
 *
 * `enabled: false` retains its assignments rather than discarding them, so
 * turning validation off and back on is lossless (R2). The one shape that
 * cannot be re-enabled is an empty cohort: `{enabled: false, assignments: []}`
 * is legal because it is the honest migration of a legacy bare disable, but
 * flipping it to enabled is refused by the same refinement — an all-of
 * validation over zero validators would vacuously pass.
 */
function checkCohortIntegrity(
  cohort: { enabled: boolean; assignments: { id: string }[] },
  ctx: z.RefinementCtx,
): void {
  if (cohort.enabled && cohort.assignments.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["assignments"],
      message:
        "An enabled validator cohort needs at least one assignment — validation over an empty cohort would pass vacuously.",
    });
  }

  const seen = new Set<string>();
  for (const [index, assignment] of cohort.assignments.entries()) {
    if (seen.has(assignment.id)) {
      ctx.addIssue({
        code: "custom",
        path: ["assignments", index, "id"],
        // The id is quoted here from an unvalidated document — the duplicate
        // check runs alongside, not after, the id grammar check, so a malformed
        // id reaches this message intact.
        message: `Duplicate validator assignment id "${escapeDiagnosticValue(assignment.id)}" — ids are the stable use-site identity and must be unique within a cohort.`,
      });
    }
    seen.add(assignment.id);
  }
}

export const validatorCohortSchema = z
  .object({
    enabled: z.boolean().default(true),
    assignments: z.array(validatorAssignmentSchema).default([]),
  })
  .strict()
  .superRefine(checkCohortIntegrity);
export type ValidatorCohort = z.infer<typeof validatorCohortSchema>;

// ============================================================
// Seeded (snapshot-bearing) assignments
// ============================================================

/**
 * An assignment as it exists AFTER execution start resolved it.
 *
 * The authored shapes above are reference-bearing: they name a profile the
 * library still owns. These carry the resolved bytes instead. The boundary
 * between them is execution start, and it is one-way — nothing downstream of
 * the seed ever consults the library again, which is what makes a later profile
 * edit or deletion unable to reach a running execution through ANY path,
 * including an edit that enables a dormant assignment.
 */
export const seededAgentAssignmentSchema = agentAssignmentSchema
  .extend({ profileSnapshot: agentProfileSnapshotSchema })
  .strict();
export type SeededAgentAssignment = z.infer<typeof seededAgentAssignmentSchema>;

export const seededValidatorAssignmentSchema = validatorAssignmentSchema
  .extend({ profileSnapshot: agentProfileSnapshotSchema })
  .strict();
export type SeededValidatorAssignment = z.infer<
  typeof seededValidatorAssignmentSchema
>;

/**
 * A seeded cohort. Dormant assignments carry snapshots too: enabling one
 * mid-run is a config edit, not a resolution, so its bytes must already be
 * here.
 */
export const seededValidatorCohortSchema = z
  .object({
    enabled: z.boolean().default(true),
    assignments: z.array(seededValidatorAssignmentSchema).default([]),
  })
  .strict()
  .superRefine(checkCohortIntegrity);
export type SeededValidatorCohort = z.infer<typeof seededValidatorCohortSchema>;

/**
 * The assignments a run actually invokes: the whole ordered cohort when
 * enabled, and nothing at all when disabled — the dormant assignments a
 * disabled cohort retains are configuration to restore, never work to dispatch.
 */
export function selectRunnableCohortAssignments<T extends ValidatorAssignment>(
  cohort: Readonly<{ enabled: boolean; assignments: readonly T[] }>,
): T[] {
  return cohort.enabled ? [...cohort.assignments] : [];
}

export const graphWorkflowScriptValidatorConfigSchema = z.object({
  enabled: z.boolean().default(false),
});
export type GraphWorkflowScriptValidatorConfig = z.infer<
  typeof graphWorkflowScriptValidatorConfigSchema
>;

export const graphWorkflowHumanApprovalGateConfigSchema = z.object({
  enabled: z.boolean().default(false),
});
export type GraphWorkflowHumanApprovalGateConfig = z.infer<
  typeof graphWorkflowHumanApprovalGateConfigSchema
>;

// One cascading toggle (global → workflow → per-context) controlling whether a
// context's workflow agents may ask the user questions. A single value covers
// both the implementer and the context-validator role — there is no per-role
// split (Req 1.5).
export const graphWorkflowAskUserQuestionsConfigSchema = z.object({
  enabled: z.boolean().default(false),
});
export type GraphWorkflowAskUserQuestionsConfig = z.infer<
  typeof graphWorkflowAskUserQuestionsConfigSchema
>;

/**
 * What ran out when the breaker tripped. `retry_exhaustion` is the general
 * validator-failure loop; `output_schema_validation` narrows that to a D2
 * format turn whose payload the structured-output gate kept refusing, so the
 * halt card can say what to fix (the context's `outputSchema`) instead of
 * pointing at the tasks.
 */
export const graphWorkflowCircuitBreakerConditionSchema = z.enum([
  "retry_exhaustion",
  "output_schema_validation",
]);
