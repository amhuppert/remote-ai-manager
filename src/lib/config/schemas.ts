import { z } from "zod";
import {
  backendModelSelectionSchema,
  backendTimeoutMsSchema,
  claudeBackendConfigSchema,
  codexConfigSchema,
  codexPricingTableSchema,
  cursorBackendConfigSchema,
} from "@/lib/agent-backends/schemas";
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
  graphWorkflowMemoryPolicyConfigSchema,
  graphWorkflowMutabilityPolicySchema,
  graphWorkflowPlanRepairPolicySchema,
  graphWorkflowScriptValidatorConfigSchema,
  validatorCohortSchema,
} from "@/lib/workflow-graph/config-schemas";
import { devServerConfigSchema } from "@/lib/dev-server/schemas";
import {
  MEMORY_CONVERSATION_POLICY_DEFAULT,
  MEMORY_INDEX_BUDGET_DEFAULT_BYTES,
  MEMORY_INDEX_BUDGET_DEFAULT_HOOKS,
  MEMORY_INDEX_BUDGET_MIN_BYTES,
  memoryDeliveryPolicyOverrideSchema,
  memoryDeliveryPolicySettingSchema,
} from "@/lib/memory/schemas";
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
  // The global tier of the memory delivery cascade for workflow roles (spec
  // `memory` R10): the implementer and validator defaults every execution
  // context inherits unless its workflow or the context itself overrides them.
  memory: graphWorkflowMemoryPolicyConfigSchema,
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
  // Same schema as the effective tier, like every other block here: each role
  // and each half defaults independently, and the block is strict, so a
  // misspelled role or half is refused rather than silently left at default.
  memory: graphWorkflowMemoryPolicyConfigSchema.optional(),
});

// ============================================================
// Compaction Config
// ============================================================

export const compactionConfigSchema = z.object({
  backend: agentBackendSchema.default("claude"),
  conversationModelSelection: backendModelSelectionSchema.default({
    modelId: "sonnet",
    parameters: { effort: "medium" },
  }),
  messageModelSelection: backendModelSelectionSchema.default({
    modelId: "sonnet",
    parameters: { effort: "medium" },
  }),
  // No default: an unset (or null) timeout means "no timeout applied", matching
  // agentBackends.codex.timeoutMs. Resolved through resolveConfiguredTimeoutMs (→ 0) at the
  // task-run boundary, where the runner treats 0 as unbounded.
  timeoutMs: z.number().int().positive().nullable().optional(),
});
export type CompactionConfig = z.infer<typeof compactionConfigSchema>;

const rawCompactionConfigSchema = z
  .object({
    backend: agentBackendSchema.optional(),
    conversationModelSelection: backendModelSelectionSchema.optional(),
    messageModelSelection: backendModelSelectionSchema.optional(),
    conversationModel: z
      .never({
        error:
          "This config field was migrated; use compaction.conversationModelSelection.",
      })
      .optional(),
    messageModel: z
      .never({
        error:
          "This config field was migrated; use compaction.messageModelSelection.",
      })
      .optional(),
    effort: z
      .never({
        error:
          "This config field was migrated; put parameters on the complete compaction model selections.",
      })
      .optional(),
    timeoutMs: z.number().int().positive().nullable().optional(),
  })
  .strict();

// ============================================================
// Conversation Naming Config
// ============================================================

export const conversationNamingConfigSchema = z.object({
  enabled: z.boolean().default(true),
  backend: agentBackendSchema.default("claude"),
  modelSelection: backendModelSelectionSchema.default({
    modelId: "haiku",
    parameters: {},
  }),
  // No default: an unset (or null) timeout falls back to the service's bounded
  // 60s default at the task-run boundary — naming is never unbounded.
  timeoutMs: z.number().int().positive().nullable().optional(),
});
export type ConversationNamingConfig = z.infer<
  typeof conversationNamingConfigSchema
>;

const rawConversationNamingConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    backend: agentBackendSchema.optional(),
    modelSelection: backendModelSelectionSchema.optional(),
    model: z
      .never({
        error:
          "This config field was migrated; use conversationNaming.modelSelection.",
      })
      .optional(),
    effort: z
      .never({
        error:
          "This config field was migrated; use conversationNaming.modelSelection.parameters.",
      })
      .optional(),
    timeoutMs: z.number().int().positive().nullable().optional(),
  })
  .strict();

export const resolveConversationNamingConfig = (
  config: GlobalConfig,
): ConversationNamingConfig =>
  conversationNamingConfigSchema.parse(config.conversationNaming ?? {});

// ============================================================
// Memory Config
// ============================================================

/**
 * The shared memory system's global settings (spec `memory`, R5, R10). The
 * generated-index budget lives HERE AND ONLY HERE: the spec forbids any
 * per-project, per-workflow, or per-conversation budget override, so no
 * per-repo or workflow schema carries a counterpart (`delivery-policy.test.ts`
 * walks every config schema to prove it). `conversations` is the delivery
 * policy of ordinary — human-addressed — conversations; workflow roles resolve
 * through `workflowDefaults.memory` and the cascade instead.
 */
export const memoryConfigSchema = z.object({
  conversations: memoryDeliveryPolicySettingSchema(
    MEMORY_CONVERSATION_POLICY_DEFAULT,
  ),
  indexBudget: z
    .object({
      bytes: z
        .number()
        .int()
        .min(MEMORY_INDEX_BUDGET_MIN_BYTES)
        .default(MEMORY_INDEX_BUDGET_DEFAULT_BYTES),
      hooks: z.number().int().min(1).default(MEMORY_INDEX_BUDGET_DEFAULT_HOOKS),
    })
    .default({
      bytes: MEMORY_INDEX_BUDGET_DEFAULT_BYTES,
      hooks: MEMORY_INDEX_BUDGET_DEFAULT_HOOKS,
    }),
});
export type MemoryConfig = z.infer<typeof memoryConfigSchema>;

const rawMemoryConfigSchema = z
  .object({
    conversations: memoryDeliveryPolicyOverrideSchema.optional(),
    indexBudget: z
      .object({
        bytes: z.number().int().min(MEMORY_INDEX_BUDGET_MIN_BYTES).optional(),
        hooks: z.number().int().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const resolveMemoryConfig = (config: GlobalConfig): MemoryConfig =>
  memoryConfigSchema.parse(config.memory ?? {});

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
  memory: memoryConfigSchema.optional(),
});
export type GlobalConfig = z.infer<typeof globalConfigSchema>;

function migratedBackendSelectionField() {
  return z
    .never({
      error:
        "This config field was migrated; use the backend's complete modelSelection.",
    })
    .optional();
}

const rawClaudeBackendConfigSchema = z
  .object({
    modelSelection: backendModelSelectionSchema.optional(),
    model: migratedBackendSelectionField(),
    reasoningEffort: migratedBackendSelectionField(),
    fastMode: migratedBackendSelectionField(),
    timeoutMs: backendTimeoutMsSchema.optional(),
    stallTimeoutMs: backendTimeoutMsSchema.optional(),
  })
  .strict();

const rawCodexBackendConfigSchema = z
  .object({
    enabled: z
      .never({
        error: "Codex is always available; remove agentBackends.codex.enabled.",
      })
      .optional(),
    modelSelection: backendModelSelectionSchema.optional(),
    model: migratedBackendSelectionField(),
    reasoningEffort: migratedBackendSelectionField(),
    fastMode: migratedBackendSelectionField(),
    timeoutMs: backendTimeoutMsSchema.optional(),
    stallTimeoutMs: backendTimeoutMsSchema.optional(),
    pricing: codexPricingTableSchema.optional(),
  })
  .strict();

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
 * Every model-bearing raw config profile applies the same fail-closed rule, so
 * backend selection parameters cannot be silently discarded at this boundary.
 */
const rawCursorBackendConfigSchema = z
  .object({
    modelSelection: backendModelSelectionSchema.optional(),
    model: migratedBackendSelectionField(),
    reasoningEffort: migratedBackendSelectionField(),
    timeoutMs: backendTimeoutMsSchema.optional(),
    fastMode: migratedBackendSelectionField(),
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

function misplacedModelSelectionField() {
  return z
    .never({
      error:
        "This root field is not a model-selection boundary; use a complete modelSelection at the intended backend or service configuration site.",
    })
    .optional();
}

export const rawGlobalConfigSchema = z.object({
  baseDir: z.string().optional(),
  commandCenterProjectName: z.string().min(1).optional(),
  ignorePatterns: z.array(z.string()).optional(),
  claudeTimeoutMs: movedConfigField("agentBackends.claude.timeoutMs"),
  defaultModel: movedConfigField("agentBackends.claude.modelSelection"),
  defaultEffort: movedConfigField(
    "agentBackends.claude.modelSelection.parameters",
  ),
  model: misplacedModelSelectionField(),
  effort: misplacedModelSelectionField(),
  reasoning: misplacedModelSelectionField(),
  fast: misplacedModelSelectionField(),
  context: misplacedModelSelectionField(),
  thinking: misplacedModelSelectionField(),
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
  memory: rawMemoryConfigSchema.optional(),
});
export type RawGlobalConfig = z.infer<typeof rawGlobalConfigSchema>;

// ============================================================
// Per-Repo Config
// ============================================================

/**
 * The project's Cursor block (spec D10): the statically declared opt-out model
 * list, and nothing else.
 *
 * Every model in the generated catalog is available to every project. What is
 * a project/team property is which of them this repo's operators should NOT
 * reach for, so the block names the exclusions and the catalog — refreshed from
 * Cursor at build time — supplies everything else. A project that adopts a
 * model Cursor has just shipped needs no configuration change at all.
 *
 * An id the generated catalog does not contain is kept as written rather than
 * rejected here: Cursor retires models, and a vendor retirement must not turn a
 * project's whole configuration file unreadable. A list that names every
 * catalog model permits nothing and fails closed at the one place that knows a
 * model was actually requested.
 *
 * `.strict()` for the same reason the global Cursor profile is strict: a key
 * this block does not declare is one Command Center will never read, and
 * stripping it silently tells an operator their setting took effect. The
 * `z.never()` arms answer the fields most likely to be reached for here —
 * per-project model/effort/credential overrides do not exist, and the former
 * allowlist is named so an existing config fails with its replacement rather
 * than with "unrecognized key".
 */
const perRepoCursorConfigSchema = z
  .object({
    disabledModels: z.array(z.string().trim().min(1)).default([]),
    supportedModels: z
      .never({
        error:
          "Cursor models are now enabled by default; replace agentBackends.cursor.supportedModels with agentBackends.cursor.disabledModels naming only the models this project should not run.",
      })
      .optional(),
    model: z
      .never({
        error:
          "The per-repo Cursor block declares disabledModels only; set the model in the global agentBackends.cursor profile or select one per conversation.",
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
