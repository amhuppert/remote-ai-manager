import { z } from "zod";
import {
  backendTimeoutMsSchema,
  claudeBackendConfigSchema,
  claudeEffortLevelSchema,
  claudeModelSchema,
  codexConfigSchema,
  codexPricingTableSchema,
  codexReasoningEffortSchema,
  cursorBackendConfigSchema,
  effortLevelSchema,
  validateClaudeBackendModelEffort,
  validateCodexBackendModelEffort,
} from "@/lib/agent-backends/schemas";
import { CURSOR_DEFAULT_SUPPORTED_MODELS } from "@/lib/agent-backends/cursor/model-policy";
import { agentBackendSchema } from "@/lib/shared/schemas";
import {
  pushNotificationConfigSchema,
  rawPushNotificationConfigSchema,
} from "@/lib/notifications/schemas";
import { workflowCollaborationConfigSchema } from "@/lib/workflow-graph/collaboration-schemas";
import {
  agentAssignmentSchema,
  graphWorkflowAgentValidationConfigSchema,
  graphWorkflowAskUserQuestionsConfigSchema,
  graphWorkflowCircuitBreakerPolicySchema,
  graphWorkflowHumanApprovalGateConfigSchema,
  graphWorkflowIterationPolicySchema,
  graphWorkflowLaneMergeValidationConfigSchema,
  graphWorkflowMutabilityPolicySchema,
  graphWorkflowPlanRepairPolicySchema,
  graphWorkflowScriptValidatorConfigSchema,
  validatorCohortSchema,
} from "@/lib/workflow-graph/config-schemas";
import { devServerConfigSchema } from "@/lib/dev-server/schemas";
import {
  globalValidationConfigSchema,
  repoValidationConfigSchema,
} from "@/lib/validation/schemas";

// ============================================================
// Workflow Defaults
// ============================================================

export const workflowDefaultsSchema = z.object({
  implementer: agentAssignmentSchema,
  contextValidator: validatorCohortSchema,
  scriptValidator: graphWorkflowScriptValidatorConfigSchema,
  humanApprovalGate: graphWorkflowHumanApprovalGateConfigSchema,
  askUserQuestions: graphWorkflowAskUserQuestionsConfigSchema,
  iterationPolicy: graphWorkflowIterationPolicySchema,
  circuitBreaker: graphWorkflowCircuitBreakerPolicySchema,
  mutability: graphWorkflowMutabilityPolicySchema,
  planRepair: graphWorkflowPlanRepairPolicySchema,
  collaboration: workflowCollaborationConfigSchema,
  agentValidation: graphWorkflowAgentValidationConfigSchema,
  laneMergeValidation: graphWorkflowLaneMergeValidationConfigSchema,
});
export type WorkflowDefaults = z.infer<typeof workflowDefaultsSchema>;

const rawWorkflowDefaultsSchema = z.object({
  implementer: agentAssignmentSchema.optional(),
  contextValidator: validatorCohortSchema.optional(),
  scriptValidator: graphWorkflowScriptValidatorConfigSchema.optional(),
  humanApprovalGate: graphWorkflowHumanApprovalGateConfigSchema.optional(),
  askUserQuestions: graphWorkflowAskUserQuestionsConfigSchema.optional(),
  iterationPolicy: graphWorkflowIterationPolicySchema.optional(),
  circuitBreaker: graphWorkflowCircuitBreakerPolicySchema.optional(),
  mutability: graphWorkflowMutabilityPolicySchema.optional(),
  planRepair: graphWorkflowPlanRepairPolicySchema.optional(),
  collaboration: workflowCollaborationConfigSchema.optional(),
  agentValidation: graphWorkflowAgentValidationConfigSchema.optional(),
  laneMergeValidation: graphWorkflowLaneMergeValidationConfigSchema.optional(),
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
// Conversation Naming Config
// ============================================================

export const conversationNamingConfigSchema = z.object({
  enabled: z.boolean().default(true),
  backend: agentBackendSchema.default("claude"),
  model: z.string().default("haiku"),
  effort: effortLevelSchema.default("low"),
  // No default: an unset (or null) timeout falls back to the service's bounded
  // 60s default at the task-run boundary — naming is never unbounded.
  timeoutMs: z.number().int().positive().nullable().optional(),
});
export type ConversationNamingConfig = z.infer<
  typeof conversationNamingConfigSchema
>;

const rawConversationNamingConfigSchema = z.object({
  enabled: z.boolean().optional(),
  backend: agentBackendSchema.optional(),
  model: z.string().optional(),
  effort: effortLevelSchema.optional(),
  timeoutMs: z.number().int().positive().nullable().optional(),
});

export const resolveConversationNamingConfig = (
  config: GlobalConfig,
): ConversationNamingConfig =>
  conversationNamingConfigSchema.parse(config.conversationNaming ?? {});

// ============================================================
// Global Config
// ============================================================

export const agentBackendsConfigSchema = z.object({
  claude: claudeBackendConfigSchema,
  codex: codexConfigSchema,
  cursor: cursorBackendConfigSchema,
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
  validation: globalValidationConfigSchema.optional(),
  conversationNaming: conversationNamingConfigSchema.optional(),
});
export type GlobalConfig = z.infer<typeof globalConfigSchema>;

const rawClaudeBackendConfigSchema = z
  .object({
    model: claudeModelSchema.optional(),
    reasoningEffort: claudeEffortLevelSchema.optional(),
    timeoutMs: backendTimeoutMsSchema.optional(),
    stallTimeoutMs: backendTimeoutMsSchema.optional(),
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

/**
 * The Cursor profile as written on disk (spec D10, R12.2).
 *
 * `.strict()` is the enforcement, not a formality: an option this profile does
 * not declare is one Command Center will never read, so stripping it in silence
 * would leave an operator believing a setting took effect when nothing did — a
 * typo, a field copied from another backend, or a credential parked under a key
 * of the operator's own invention all have to fail loudly. Zod names the
 * offending key and never its value, so a secret written under an unknown key
 * is refused without being echoed into the error.
 *
 * The three `z.never()` arms sit above that catch-all so the options an
 * operator is most likely to reach for get an answer better than "unrecognized
 * key": each says where the value actually belongs.
 *
 * Cursor can fail closed because it is new — no config file already on disk can
 * carry a stray key under it. Tightening the Claude and Codex profiles, which
 * shipped tolerant, is a separate migration decision.
 */
const rawCursorBackendConfigSchema = z
  .object({
    model: z.string().trim().min(1).optional(),
    reasoningEffort: effortLevelSchema.optional(),
    timeoutMs: backendTimeoutMsSchema.optional(),
    fastMode: z
      .never({
        error:
          "Cursor has no fast mode; remove agentBackends.cursor.fastMode. Fast mode is a Codex setting.",
      })
      .optional(),
    pricing: z
      .never({
        error:
          "Cursor reports no cost; remove agentBackends.cursor.pricing. Command Center never estimates cost from tokens.",
      })
      .optional(),
    apiKey: z
      .never({
        error:
          "Command Center never stores the Cursor credential; remove agentBackends.cursor.apiKey and set the CURSOR_API_KEY environment variable on the server instead.",
      })
      .optional(),
  })
  .strict();

const rawAgentBackendsConfigSchema = z.object({
  claude: rawClaudeBackendConfigSchema.optional(),
  codex: rawCodexBackendConfigSchema.optional(),
  cursor: rawCursorBackendConfigSchema.optional(),
});

// Raw (explicit-only) variant: no defaults, so intersectKeys can distinguish
// what the user wrote from schema-injected seeds.
const rawValidationConfigSchema = z.object({
  concurrencyLimit: z.number().int().positive().optional(),
  defaultTimeoutMs: z.number().int().positive().optional(),
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
  validation: rawValidationConfigSchema.optional(),
  conversationNaming: rawConversationNamingConfigSchema.optional(),
});
export type RawGlobalConfig = z.infer<typeof rawGlobalConfigSchema>;

// ============================================================
// Per-Repo Config
// ============================================================

/**
 * The project's Cursor block (spec D10): the statically declared supported-model
 * list, and nothing else.
 *
 * The list is a project/team property — which models this repo's operators may
 * run — so it lives here rather than in CC code or the global profile. It is the
 * adapter model policy's authority: a resolved model outside it is refused
 * before a worker starts, never substituted.
 *
 * A declared-empty list is kept as written rather than rejected here. It is a
 * well-formed statement that permits nothing, and it fails closed at the one
 * place that knows a model was actually requested; refusing it at parse time
 * would make the whole project's configuration unreadable over a Cursor-only
 * mistake.
 *
 * `.strict()` for the same reason the global Cursor profile is strict: a key
 * this block does not declare is one Command Center will never read, and
 * stripping it silently tells an operator their setting took effect. The
 * `z.never()` arms answer the fields most likely to be reached for here —
 * per-project model/effort/credential overrides do not exist.
 */
const perRepoCursorConfigSchema = z
  .object({
    supportedModels: z
      .array(z.string().trim().min(1))
      .default([...CURSOR_DEFAULT_SUPPORTED_MODELS]),
    model: z
      .never({
        error:
          "The per-repo Cursor block declares supportedModels only; set the model in the global agentBackends.cursor profile or select one per conversation.",
      })
      .optional(),
    reasoningEffort: z
      .never({
        error:
          "Cursor takes no per-repo reasoning effort; remove agentBackends.cursor.reasoningEffort.",
      })
      .optional(),
    apiKey: z
      .never({
        error:
          "Command Center never stores the Cursor credential; remove agentBackends.cursor.apiKey and set the CURSOR_API_KEY environment variable on the server instead.",
      })
      .optional(),
  })
  .strict();

/**
 * Per-repo backend blocks. Strict, and Cursor-only: Claude and Codex configure
 * nothing per repo today, so an unrecognized backend key here is a typo rather
 * than a forward-compatible setting worth silently discarding.
 */
const perRepoAgentBackendsConfigSchema = z
  .object({
    cursor: perRepoCursorConfigSchema.optional(),
  })
  .strict();

export const perRepoConfigSchema = z.object({
  initScriptPath: z.string().nullable().optional(),
  agentBackends: perRepoAgentBackendsConfigSchema.optional(),
  preMergeCommand: movedConfigField("validation.commands/preMerge"),
  preMergeTimeoutMs: z.number().int().positive().optional(),
  preMergePreparePath: z.enum(["plumbing", "fallback"]).optional(),
  devServers: z.array(devServerConfigSchema).optional(),
  branchPrefix: z.string().optional(),
  compaction: rawCompactionConfigSchema.optional(),
  validation: repoValidationConfigSchema.optional(),
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
