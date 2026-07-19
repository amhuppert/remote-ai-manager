import { z } from "zod";
import {
  claudeModelSchema,
  codexConfigSchema,
  codexPricingTableSchema,
  codexReasoningEffortSchema,
  effortLevelSchema,
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
  // codex.timeoutMs. Resolved through resolveConfiguredTimeoutMs (→ 0) at the
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

export const globalConfigSchema = z.object({
  baseDir: z.string(),
  ignorePatterns: z.array(z.string()),
  claudeTimeoutMs: z.number(),
  defaultModel: claudeModelSchema.default("opus"),
  defaultEffort: effortLevelSchema.optional(),
  maxTurns: z.number().int().positive().optional(),
  preMergeTimeoutMs: z.number().int().positive().optional(),
  maxConcurrentQueries: z.number().int().positive().optional(),
  tailscaleEnabled: z.boolean().optional(),
  pushNotification: pushNotificationConfigSchema.optional(),
  codex: codexConfigSchema.optional(),
  workflowDefaults: workflowDefaultsSchema.optional(),
  idleQuerySessionTtlMs: z.number().int().positive().optional(),
  branchPrefix: z.string().optional(),
  defaultAgentBackend: agentBackendSchema.default("claude"),
  compaction: compactionConfigSchema.optional(),
});
export type GlobalConfig = z.infer<typeof globalConfigSchema>;

// Field names must match codexConfigSchema exactly — the loader merges the
// parsed raw file into GlobalConfig by key, with no renaming. A historical
// `timeout` key here silently no-opped because every consumer reads
// `timeoutMs`; stray legacy `timeout` keys in config.json are now stripped.
const rawCodexConfigSchema = z.object({
  enabled: z.boolean().optional(),
  model: z.string().optional(),
  reasoningEffort: codexReasoningEffortSchema.optional(),
  timeoutMs: z.number().positive().nullable().optional(),
  stallTimeoutMs: z.number().positive().nullable().optional(),
  pricing: codexPricingTableSchema.optional(),
});

export const rawGlobalConfigSchema = z.object({
  baseDir: z.string().optional(),
  ignorePatterns: z.array(z.string()).optional(),
  claudeTimeoutMs: z.number().optional(),
  defaultModel: claudeModelSchema.optional(),
  defaultEffort: effortLevelSchema.optional(),
  maxTurns: z.number().int().positive().optional(),
  preMergeTimeoutMs: z.number().int().positive().optional(),
  maxConcurrentQueries: z.number().int().positive().optional(),
  tailscaleEnabled: z.boolean().optional(),
  pushNotification: rawPushNotificationConfigSchema.optional(),
  codex: rawCodexConfigSchema.optional(),
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
