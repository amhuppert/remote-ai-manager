import { z } from "zod";
import {
  backendTimeoutMsSchema,
  claudeBackendConfigSchema,
  claudeEffortLevelSchema,
  claudeModelSchema,
  codexConfigSchema,
  codexPricingTableSchema,
  codexReasoningEffortSchema,
  effortLevelSchema,
  validateClaudeBackendModelEffort,
  validateCodexBackendModelEffort,
} from "@/lib/agent-backends/schemas";
import { agentBackendSchema } from "@/lib/shared/schemas";
import {
  pushNotificationConfigSchema,
  rawPushNotificationConfigSchema,
} from "@/lib/notifications/schemas";
import { workflowCollaborationConfigSchema } from "@/lib/workflow-graph/collaboration-schemas";
import {
  graphWorkflowAgentConfigSchema,
  graphWorkflowAgentValidatorConfigSchema,
  graphWorkflowAskUserQuestionsConfigSchema,
  graphWorkflowCircuitBreakerPolicySchema,
  graphWorkflowHumanApprovalGateConfigSchema,
  graphWorkflowIterationPolicySchema,
  graphWorkflowMutabilityPolicySchema,
  graphWorkflowScriptValidatorConfigSchema,
} from "@/lib/workflow-graph/config-schemas";
import { devServerConfigSchema } from "@/lib/dev-server/schemas";

// ============================================================
// Workflow Defaults
// ============================================================

export const workflowDefaultsSchema = z.object({
  implementer: graphWorkflowAgentConfigSchema,
  contextValidator: graphWorkflowAgentValidatorConfigSchema,
  scriptValidator: graphWorkflowScriptValidatorConfigSchema,
  humanApprovalGate: graphWorkflowHumanApprovalGateConfigSchema,
  askUserQuestions: graphWorkflowAskUserQuestionsConfigSchema,
  iterationPolicy: graphWorkflowIterationPolicySchema,
  circuitBreaker: graphWorkflowCircuitBreakerPolicySchema,
  mutability: graphWorkflowMutabilityPolicySchema,
  collaboration: workflowCollaborationConfigSchema,
});
export type WorkflowDefaults = z.infer<typeof workflowDefaultsSchema>;

const rawWorkflowDefaultsSchema = z.object({
  implementer: graphWorkflowAgentConfigSchema.optional(),
  contextValidator: graphWorkflowAgentValidatorConfigSchema.optional(),
  scriptValidator: graphWorkflowScriptValidatorConfigSchema.optional(),
  humanApprovalGate: graphWorkflowHumanApprovalGateConfigSchema.optional(),
  askUserQuestions: graphWorkflowAskUserQuestionsConfigSchema.optional(),
  iterationPolicy: graphWorkflowIterationPolicySchema.optional(),
  circuitBreaker: graphWorkflowCircuitBreakerPolicySchema.optional(),
  mutability: graphWorkflowMutabilityPolicySchema.optional(),
  collaboration: workflowCollaborationConfigSchema.optional(),
});

// ============================================================
// Compaction Config
// ============================================================

export const compactionConfigSchema = z.object({
  backend: agentBackendSchema.default("claude"),
  conversationModel: z.string().default("sonnet"),
  messageModel: z.string().default("sonnet"),
  effort: effortLevelSchema.default("medium"),
  // No default: an unset (or null) timeout means "no timeout applied", matching
  // agentBackends.codex.timeoutMs. Resolved through resolveConfiguredTimeoutMs (→ 0) at the
  // task-run boundary, where the runner treats 0 as unbounded.
  timeoutMs: z.number().int().positive().nullable().optional(),
});
export type CompactionConfig = z.infer<typeof compactionConfigSchema>;

const rawCompactionConfigSchema = z.object({
  backend: agentBackendSchema.optional(),
  conversationModel: z.string().optional(),
  messageModel: z.string().optional(),
  effort: effortLevelSchema.optional(),
  timeoutMs: z.number().int().positive().nullable().optional(),
});

// ============================================================
// Global Config
// ============================================================

export const agentBackendsConfigSchema = z.object({
  claude: claudeBackendConfigSchema,
  codex: codexConfigSchema,
});
export type AgentBackendsConfig = z.infer<typeof agentBackendsConfigSchema>;

export const globalConfigSchema = z.object({
  baseDir: z.string(),
  commandCenterProjectName: z.string().min(1).optional(),
  ignorePatterns: z.array(z.string()),
  agentBackends: agentBackendsConfigSchema,
  maxTurns: z.number().int().positive().optional(),
  preMergeTimeoutMs: z.number().int().positive().optional(),
  maxConcurrentQueries: z.number().int().positive().optional(),
  tailscaleEnabled: z.boolean().optional(),
  pushNotification: pushNotificationConfigSchema.optional(),
  workflowDefaults: workflowDefaultsSchema.optional(),
  idleQuerySessionTtlMs: z.number().int().positive().optional(),
  branchPrefix: z.string().optional(),
  defaultAgentBackend: agentBackendSchema.default("claude"),
  compaction: compactionConfigSchema.optional(),
});
export type GlobalConfig = z.infer<typeof globalConfigSchema>;

const rawClaudeBackendConfigSchema = z
  .object({
    model: claudeModelSchema.optional(),
    reasoningEffort: claudeEffortLevelSchema.optional(),
    timeoutMs: backendTimeoutMsSchema.optional(),
  })
  .superRefine(validateClaudeBackendModelEffort);

const rawCodexBackendConfigSchema = z
  .object({
    enabled: z
      .never({
        error: "Codex is always available; remove agentBackends.codex.enabled.",
      })
      .optional(),
    model: z.string().trim().min(1).optional(),
    reasoningEffort: codexReasoningEffortSchema.optional(),
    fastMode: z.boolean().optional(),
    timeoutMs: backendTimeoutMsSchema.optional(),
    stallTimeoutMs: backendTimeoutMsSchema.optional(),
    pricing: codexPricingTableSchema.optional(),
  })
  .superRefine(validateCodexBackendModelEffort);

const rawAgentBackendsConfigSchema = z.object({
  claude: rawClaudeBackendConfigSchema.optional(),
  codex: rawCodexBackendConfigSchema.optional(),
});

function movedConfigField(replacement: string) {
  return z
    .never({
      error: `This config field has moved; use ${replacement}.`,
    })
    .optional();
}

export const rawGlobalConfigSchema = z.object({
  baseDir: z.string().optional(),
  commandCenterProjectName: z.string().min(1).optional(),
  ignorePatterns: z.array(z.string()).optional(),
  claudeTimeoutMs: movedConfigField("agentBackends.claude.timeoutMs"),
  defaultModel: movedConfigField("agentBackends.claude.model"),
  defaultEffort: movedConfigField("agentBackends.claude.reasoningEffort"),
  codex: movedConfigField("agentBackends.codex"),
  agentBackends: rawAgentBackendsConfigSchema.optional(),
  maxTurns: z.number().int().positive().optional(),
  preMergeTimeoutMs: z.number().int().positive().optional(),
  maxConcurrentQueries: z.number().int().positive().optional(),
  tailscaleEnabled: z.boolean().optional(),
  pushNotification: rawPushNotificationConfigSchema.optional(),
  workflowDefaults: rawWorkflowDefaultsSchema.optional(),
  idleQuerySessionTtlMs: z.number().int().positive().optional(),
  branchPrefix: z.string().optional(),
  defaultAgentBackend: agentBackendSchema.optional(),
  compaction: rawCompactionConfigSchema.optional(),
});
export type RawGlobalConfig = z.infer<typeof rawGlobalConfigSchema>;

// ============================================================
// Per-Repo Config
// ============================================================

export const perRepoConfigSchema = z.object({
  initScriptPath: z.string().nullable().optional(),
  preMergeCommand: z.string().nullable().optional(),
  preMergeTimeoutMs: z.number().int().positive().optional(),
  preMergePreparePath: z.enum(["plumbing", "fallback"]).optional(),
  devServers: z.array(devServerConfigSchema).optional(),
  branchPrefix: z.string().optional(),
  compaction: rawCompactionConfigSchema.optional(),
});
export type PerRepoConfig = z.infer<typeof perRepoConfigSchema>;

// ============================================================
// API Response Schemas
// ============================================================

export const configResponseSchema = z.object({
  baseDir: z.string(),
});

export const fullConfigResponseSchema = z.object({
  config: globalConfigSchema,
  raw: rawGlobalConfigSchema,
});
export type FullConfigResponse = z.infer<typeof fullConfigResponseSchema>;
