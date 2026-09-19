import { z } from "zod";
import { backendModelSelectionSchema } from "@/lib/agent-backends/schemas";
import {
  ASSIGNMENT_FOCUS_MAX_LENGTH,
  findReservedSequence,
  normalizeAssignmentFocus,
} from "@/lib/agent-profiles/block";
import {
  agentProfileRefSchema,
  agentProfileSnapshotSchema,
  type AgentProfileRef,
} from "@/lib/agent-profiles/schemas";
import { workflowBackendRefusal } from "./backend-admission";
import { getBackendCatalogEntry } from "@/lib/agent-backends/catalog";
import {
  MEMORY_IMPLEMENTER_POLICY_DEFAULT,
  MEMORY_VALIDATOR_POLICY_DEFAULT,
  memoryDeliveryPolicyOverrideSchema,
  memoryDeliveryPolicySettingSchema,
} from "@/lib/memory/schemas";
import { agentBackendSchema } from "@/lib/shared/schemas";
import { escapeDiagnosticValue } from "@/lib/shared/diagnostic-text";
import { validationCommandNameSchema } from "@/lib/validation/schemas";

// ============================================================
// Graph Workflow Agent Configuration Schemas
// ============================================================

function migratedAgentSelectionField() {
  return z
    .never({
      error:
        "This workflow agent field was migrated; use the complete modelSelection.",
    })
    .optional();
}

const atomicAgentSelectionFields = {
  modelSelection: backendModelSelectionSchema,
  model: migratedAgentSelectionField(),
  reasoningEffort: migratedAgentSelectionField(),
  fastMode: migratedAgentSelectionField(),
} as const;

const graphWorkflowClaudeAgentConfigSchema = z
  .object({
    backend: z.literal("claude"),
    ...atomicAgentSelectionFields,
  })
  .strict();

const graphWorkflowCodexAgentConfigSchema = z
  .object({
    backend: z.literal("codex"),
    ...atomicAgentSelectionFields,
  })
  .strict();

const graphWorkflowCursorAgentConfigSchema = z
  .object({
    backend: z.literal("cursor"),
    ...atomicAgentSelectionFields,
  })
  .strict();

/**
 * Why a `backend` value matched no arm above, phrased for the author.
 *
 * A registered backend that reaches here is not a typo — it is a backend whose
 * descriptor declares no task facet, and a workflow role is dispatched through
 * that facet. Saying so is the difference between "fix your spelling" and "this
 * backend cannot hold a role" (spec R15.2). Anything else falls through to
 * zod's own message.
 *
 * Only an unmatched DISCRIMINATOR reaches this callback; an arm that matches
 * and then fails on its selection reports its own issue, so a bad Claude
 * selection can never be mislabelled as a facet problem.
 */
function agentConfigBackendRefusal(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || !("backend" in input)) {
    return undefined;
  }
  const parsed = agentBackendSchema.safeParse(input.backend);
  if (!parsed.success) return undefined;
  return (
    workflowBackendRefusal(getBackendCatalogEntry(parsed.data)) ??
    `${parsed.data} is not admitted to workflow roles`
  );
}

export const graphWorkflowAgentConfigSchema = z.preprocess(
  (val) => {
    if (typeof val === "object" && val !== null && !("backend" in val)) {
      return { ...val, backend: "claude" };
    }
    return val;
  },
  z.discriminatedUnion(
    "backend",
    [
      graphWorkflowClaudeAgentConfigSchema,
      graphWorkflowCodexAgentConfigSchema,
      graphWorkflowCursorAgentConfigSchema,
    ],
    { error: (issue) => agentConfigBackendRefusal(issue.input) },
  ),
);
export type GraphWorkflowAgentConfig = z.infer<
  typeof graphWorkflowAgentConfigSchema
>;

export const graphWorkflowMutabilityPolicySchema = z.object({
  allowAgentTaskAdd: z.boolean().default(false),
  /**
   * Runtime graph-expansion authority (D4 R7): may this context's running
   * implementer append new contexts, tasks, and edges through
   * `cctl workflow graph expand`? Default-off and cascaded exactly like its
   * sibling, and stamped false on every expansion-generated child so authority
   * cannot propagate down a generated subgraph.
   */
  allowAgentContextAdd: z.boolean().default(false),
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
  modelSelection: {
    modelId: "opus",
    parameters: { effort: "high" },
  },
};

/**
 * Bounded turn for the one-shot repair agent.
 *
 * Lives beside the policy rather than in the supervisor because the halt UI
 * needs it too: an unsettled round is how the UI knows an agent is working, and
 * this budget is what says when an unsettled round stopped meaning that. The
 * supervisor reaches the repository and the logger, so importing it into a
 * client bundle is not an option.
 */
export const PLAN_REPAIR_TURN_TIMEOUT_MS = 15 * 60_000;

export const graphWorkflowIterationPolicySchema = z.object({
  maxIterations: z.number().int().min(1),
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
 * Whether a validator's findings can reopen tasks.
 *
 * `blocking` is authored, never inherited. The standard acceptance-criteria
 * verifier is the one blocking default; every other profile defaults to
 * `advisory`. A specialist added to a cohort therefore arrives non-blocking,
 * and making it able to fail a context is a deliberate act by the workflow
 * author — who then owns convergence for it.
 */
export const validatorAuthoritySchema = z.enum(["blocking", "advisory"]);
export type ValidatorAuthority = z.infer<typeof validatorAuthoritySchema>;

export const ACCEPTANCE_CRITERIA_VALIDATOR_PROFILE_REF = {
  tier: "builtin",
  id: "general-reviewer",
} as const satisfies AgentProfileRef;

/**
 * Whether a profile is the standard acceptance-criteria verifier. The seat
 * distinction the citation rule keys on (#69 change 4): a blocking assignment
 * with this profile is the acceptance seat, judging the criteria themselves;
 * a blocking assignment with any other profile is a specialist judging its
 * own mandate.
 */
export function isAcceptanceCriteriaValidatorProfile(
  profile: AgentProfileRef,
): boolean {
  return (
    profile.tier === ACCEPTANCE_CRITERIA_VALIDATOR_PROFILE_REF.tier &&
    profile.id === ACCEPTANCE_CRITERIA_VALIDATOR_PROFILE_REF.id
  );
}

export function defaultValidatorAuthority(
  profile: AgentProfileRef,
): ValidatorAuthority {
  return isAcceptanceCriteriaValidatorProfile(profile)
    ? "blocking"
    : "advisory";
}

function applyDefaultValidatorAuthority(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  if ("authority" in value && value.authority !== undefined) return value;
  if (!("profile" in value)) return value;

  const profile = agentProfileRefSchema.safeParse(value.profile);
  if (!profile.success) return { ...value, authority: "advisory" };
  return { ...value, authority: defaultValidatorAuthority(profile.data) };
}

/**
 * A validator use site. Every validator runs on one durable CC conversation
 * per assignment, so the only axis beyond the shared assignment is the
 * authority its verdict carries.
 */
const validatorAssignmentObjectSchema = agentAssignmentSchema
  .extend({
    authority: validatorAuthoritySchema,
  })
  .strict();
export const validatorAssignmentSchema = z.preprocess(
  applyDefaultValidatorAuthority,
  validatorAssignmentObjectSchema,
);
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

export const seededValidatorAssignmentSchema = z.preprocess(
  applyDefaultValidatorAuthority,
  validatorAssignmentObjectSchema
    .extend({ profileSnapshot: agentProfileSnapshotSchema })
    .strict(),
);
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

export const graphWorkflowScriptValidatorConfigSchema = z
  .object({
    commands: z.array(validationCommandNameSchema).default([]),
    purpose: z.literal("infrastructure").optional(),
  })
  .strict();
export type GraphWorkflowScriptValidatorConfig = z.infer<
  typeof graphWorkflowScriptValidatorConfigSchema
>;

// ============================================================
// Validation command selectors (design: validation-concurrency §6)
// ============================================================

// `all` intentionally opts into future registrations (after exclusions);
// `only` is stable and fail-closed. Both expand to explicit names when an
// execution is seeded (see expandCommandSelector), so later registry edits
// never broaden a running execution's permissions.
export const graphWorkflowCommandSelectorSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("all"),
    except: z.array(validationCommandNameSchema).default([]),
  }),
  z.object({
    mode: z.literal("only"),
    commands: z.array(validationCommandNameSchema),
  }),
]);
export type GraphWorkflowCommandSelector = z.infer<
  typeof graphWorkflowCommandSelectorSchema
>;

// Per-role agent allowlists, independent of script-gate selection: an
// implementer doing TDD keeps test access even when the script validator
// will also run tests. The context-validator default of no commands
// mechanizes the prompt instruction that deterministic checks are not its
// responsibility.
export const graphWorkflowAgentValidationConfigSchema = z.object({
  implementer: graphWorkflowCommandSelectorSchema.default({
    mode: "all",
    except: [],
  }),
  contextValidator: graphWorkflowCommandSelectorSchema.default({
    mode: "only",
    commands: [],
  }),
});
export type GraphWorkflowAgentValidationConfig = z.infer<
  typeof graphWorkflowAgentValidationConfigSchema
>;

// Override tiers must keep omitted role selectors absent — a defaulted
// contextValidator on a workflow override would silently erase the inherited
// selector, which is exactly the whole-block-replacement trap the per-leaf
// cascade exists to prevent.
export const graphWorkflowAgentValidationOverrideSchema = z.object({
  implementer: graphWorkflowCommandSelectorSchema.optional(),
  contextValidator: graphWorkflowCommandSelectorSchema.optional(),
});
export type GraphWorkflowAgentValidationOverride = z.infer<
  typeof graphWorkflowAgentValidationOverrideSchema
>;

/**
 * The one canonical agent-validation default, derived from the schema's own
 * field defaults (same contract as DEFAULT_PLAN_REPAIR_POLICY).
 */
export const DEFAULT_AGENT_VALIDATION_CONFIG: GraphWorkflowAgentValidationConfig =
  graphWorkflowAgentValidationConfigSchema.parse({});

// Per-role memory delivery policy (spec `memory` R10, D7): what a lane reads
// unasked and whether it may write, resolved independently for the implementer
// and the validator and — within a role — independently per half, so a
// workflow can narrow a validator's read to linked-only without touching its
// contribution. Mirrors the agent-validation per-leaf cascade for the same
// reason: whole-block replacement would let one tier silently erase another's
// setting of the other role.
export const graphWorkflowMemoryPolicyConfigSchema = z
  .object({
    implementer: memoryDeliveryPolicySettingSchema(
      MEMORY_IMPLEMENTER_POLICY_DEFAULT,
    ),
    validator: memoryDeliveryPolicySettingSchema(
      MEMORY_VALIDATOR_POLICY_DEFAULT,
    ),
  })
  .strict();
export type GraphWorkflowMemoryPolicyConfig = z.infer<
  typeof graphWorkflowMemoryPolicyConfigSchema
>;

// Override tiers keep omitted roles and omitted halves absent (inherit).
export const graphWorkflowMemoryPolicyOverrideSchema = z
  .object({
    implementer: memoryDeliveryPolicyOverrideSchema.optional(),
    validator: memoryDeliveryPolicyOverrideSchema.optional(),
  })
  .strict();
export type GraphWorkflowMemoryPolicyOverride = z.infer<
  typeof graphWorkflowMemoryPolicyOverrideSchema
>;

/** The one canonical memory-policy default, derived from the schema's own field defaults. */
export const DEFAULT_MEMORY_POLICY_CONFIG: GraphWorkflowMemoryPolicyConfig =
  graphWorkflowMemoryPolicyConfigSchema.parse({});

// `{mode:"project"}` resolves to the project's validation.laneMerge list when
// configured, else its preMerge list — resolved at merge submission against
// current project config. `{mode:"only", commands:[]}` disables lane-merge
// validation entirely.
export const graphWorkflowLaneMergeCommandSelectorSchema = z.discriminatedUnion(
  "mode",
  [
    z.object({ mode: z.literal("project") }),
    z.object({
      mode: z.literal("only"),
      commands: z.array(validationCommandNameSchema),
    }),
  ],
);
export type GraphWorkflowLaneMergeCommandSelector = z.infer<
  typeof graphWorkflowLaneMergeCommandSelectorSchema
>;

// Under `final-only`, validation is skipped for every merge in a join series
// except the last; `every-merge` restores per-lane validation for workflows
// that want integration failures isolated to a single lane.
export const graphWorkflowLaneMergeValidationConfigSchema = z.object({
  strategy: z.enum(["final-only", "every-merge"]).default("final-only"),
  commands: graphWorkflowLaneMergeCommandSelectorSchema.default({
    mode: "project",
  }),
});
export type GraphWorkflowLaneMergeValidationConfig = z.infer<
  typeof graphWorkflowLaneMergeValidationConfigSchema
>;

export const graphWorkflowLaneMergeValidationOverrideSchema = z.object({
  strategy: z.enum(["final-only", "every-merge"]).optional(),
  commands: graphWorkflowLaneMergeCommandSelectorSchema.optional(),
});
export type GraphWorkflowLaneMergeValidationOverride = z.infer<
  typeof graphWorkflowLaneMergeValidationOverrideSchema
>;

/**
 * The one canonical lane-merge-validation default, derived from the schema's
 * own field defaults (same contract as DEFAULT_PLAN_REPAIR_POLICY).
 */
export const DEFAULT_LANE_MERGE_VALIDATION_CONFIG: GraphWorkflowLaneMergeValidationConfig =
  graphWorkflowLaneMergeValidationConfigSchema.parse({});

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
