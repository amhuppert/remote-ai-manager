import { z } from "zod";
import {
  claudeModelSchema,
  codexModelSchema,
  codexReasoningEffortSchema,
  effortLevelSchema,
} from "@/lib/agent-backends/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";

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

const graphWorkflowValidatorBaseSchema = z.object({
  enabled: z.boolean().default(true),
  continuity: graphWorkflowLaneContinuityPolicySchema.default({
    enabled: true,
  }),
});

const graphWorkflowClaudeValidatorConfigSchema =
  graphWorkflowValidatorBaseSchema.extend({
    type: z.literal("claude"),
    agent: graphWorkflowAgentConfigSchema,
  });

const graphWorkflowCodexValidatorConfigSchema =
  graphWorkflowValidatorBaseSchema.extend({
    type: z.literal("codex"),
    codex: z
      .object({
        model: codexModelSchema.optional(),
        reasoningEffort: codexReasoningEffortSchema.optional(),
      })
      .default({}),
  });

export const graphWorkflowAgentValidatorConfigSchema = z.discriminatedUnion(
  "type",
  [
    graphWorkflowClaudeValidatorConfigSchema,
    graphWorkflowCodexValidatorConfigSchema,
  ],
);
export type GraphWorkflowAgentValidatorConfig = z.infer<
  typeof graphWorkflowAgentValidatorConfigSchema
>;

export interface GraphWorkflowValidatorExecutionPlan {
  strategy: "conversation" | "task";
  backend: AgentBackendId;
  modelId: string | undefined;
  reasoningEffort: string | undefined;
}

/**
 * Translates the persisted validator-config variants into the semantic
 * execution contract consumed by the runner. Provider-named legacy variants
 * stay confined to this schema boundary; dispatch depends on strategy and the
 * configured backend carried by the plan.
 */
export function resolveGraphWorkflowValidatorExecutionPlan(
  validator: GraphWorkflowAgentValidatorConfig,
): GraphWorkflowValidatorExecutionPlan {
  if (validator.type === "claude") {
    return {
      strategy: "conversation",
      backend: validator.agent.backend,
      modelId: validator.agent.model,
      reasoningEffort: validator.agent.reasoningEffort,
    };
  }
  return {
    strategy: "task",
    backend: "codex",
    modelId: validator.codex.model,
    reasoningEffort: validator.codex.reasoningEffort,
  };
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

export const contextValidatorOverrideSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("use"),
    value: graphWorkflowAgentValidatorConfigSchema,
  }),
  z.object({ kind: z.literal("disabled") }),
]);
export type ContextValidatorOverride = z.infer<
  typeof contextValidatorOverrideSchema
>;

export const graphWorkflowCircuitBreakerConditionSchema = z.enum([
  "retry_exhaustion",
]);
