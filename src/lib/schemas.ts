import { z } from "zod";

// ============================================================
// CC (Command Center) Data Entity Schemas
// ============================================================

export const claudeModelSchema = z.enum(["opus", "sonnet", "haiku"]);
export type ClaudeModel = z.infer<typeof claudeModelSchema>;

export const agentBackendSchema = z.enum(["claude", "codex"]);
export type AgentBackendId = z.infer<typeof agentBackendSchema>;

export const agentSessionRefSchema = z.discriminatedUnion("backend", [
  z.object({ backend: z.literal("claude"), sessionId: z.string() }),
  z.object({ backend: z.literal("codex"), threadId: z.string() }),
]);
export type AgentSessionRef = z.infer<typeof agentSessionRefSchema>;

export const effortLevelSchema = z.enum([
  "minimal",
  "low",
  "medium",
  "high",
  "max",
  "xhigh",
]);
export type EffortLevel = z.infer<typeof effortLevelSchema>;

/** Claude-specific effort levels (subset of EffortLevel accepted by the Claude SDK). */
export const claudeEffortLevelSchema = z.enum([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type ClaudeEffortLevel = z.infer<typeof claudeEffortLevelSchema>;

const MODEL_EFFORT_LEVELS: Record<ClaudeModel, EffortLevel[]> = {
  opus: ["low", "medium", "high", "xhigh", "max"],
  sonnet: ["low", "medium", "high"],
  haiku: [],
};

/** Returns the effort levels supported by the given model. */
export function getEffortLevelsForModel(model: ClaudeModel): EffortLevel[] {
  return MODEL_EFFORT_LEVELS[model];
}

/**
 * Clamps an effort level to the highest supported level for the given model.
 * Returns undefined if the model doesn't support effort levels at all.
 */
export function clampEffortToModel(
  effort: EffortLevel,
  model: ClaudeModel,
): EffortLevel | undefined {
  const supported = MODEL_EFFORT_LEVELS[model];
  if (supported.length === 0) return undefined;
  if (supported.includes(effort)) return effort;
  return supported[supported.length - 1];
}

// ============================================================
// Push Notification Config
// ============================================================

export const pushTriggerSchema = z.object({
  jobCompleted: z.boolean().default(true),
  waitingForInput: z.boolean().default(true),
  workflowCompleted: z.boolean().default(true),
  workflowHalted: z.boolean().default(true),
  conversationIdle: z.boolean().default(true),
});
export type PushTriggers = z.infer<typeof pushTriggerSchema>;

export const pushNotificationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(["ntfy", "pushover"]).default("ntfy"),
  serverUrl: z.string().default("https://ntfy.sh"),
  topic: z.string().default(""),
  triggers: pushTriggerSchema.default({
    jobCompleted: true,
    waitingForInput: true,
    workflowCompleted: true,
    workflowHalted: true,
    conversationIdle: true,
  }),
});
export type PushNotificationConfig = z.infer<
  typeof pushNotificationConfigSchema
>;

// ============================================================
// Codex Config
// ============================================================

export const codexModelSchema = z.enum([
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
]);
export type CodexModel = z.infer<typeof codexModelSchema>;

/** Returns all known Codex model identifiers. */
export function getCodexModels(): CodexModel[] {
  return codexModelSchema.options;
}

/** Returns the default Codex model. */
export function getDefaultCodexModel(): CodexModel {
  return "gpt-5.4";
}

export const codexReasoningEffortSchema = z.enum([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);
export type CodexReasoningEffort = z.infer<typeof codexReasoningEffortSchema>;

export const codexConfigSchema = z.object({
  enabled: z.boolean().default(false),
  model: z.string().optional().default("gpt-5.4"),
  reasoningEffort: codexReasoningEffortSchema.optional(),
  timeout: z.number().positive().nullable().optional(),
});
export type CodexConfig = z.infer<typeof codexConfigSchema>;

// ============================================================
// Codex Model Reasoning Levels
// ============================================================

const CODEX_MODEL_REASONING_LEVELS: Record<string, CodexReasoningEffort[]> = {
  "gpt-5.5": ["low", "medium", "high", "xhigh"],
  "gpt-5.4": ["low", "medium", "high", "xhigh"],
  "gpt-5.4-mini": ["low", "medium", "high", "xhigh"],
  "gpt-5.4-nano": ["low", "medium", "high", "xhigh"],
};

/**
 * Returns the reasoning effort levels supported by a Codex model.
 * Returns null for unknown models (all levels are allowed).
 */
export function getCodexReasoningLevelsForModel(
  model: string,
): CodexReasoningEffort[] | null {
  return CODEX_MODEL_REASONING_LEVELS[model] ?? null;
}

/**
 * Returns effort/reasoning levels for the given backend and optional model.
 * Both Claude and Codex levels are subsets of the unified EffortLevel union.
 */
export function getEffortLevelsForBackend(
  backend: AgentBackendId,
  model?: string,
): EffortLevel[] {
  if (backend === "codex") {
    const levels = getCodexReasoningLevelsForModel(model ?? "gpt-5.4");
    return (levels ?? [...codexReasoningEffortSchema.options]) as EffortLevel[];
  }
  return getEffortLevelsForModel((model ?? "opus") as ClaudeModel);
}

export const conversationStatusSchema = z
  .enum(["new", "awaiting", "running", "waiting_for_input"])
  .or(
    z
      .enum(["idle", "ready"])
      .transform((v) =>
        v === "idle" ? ("new" as const) : ("awaiting" as const),
      ),
  );
export type ConversationStatus =
  | "new"
  | "awaiting"
  | "running"
  | "waiting_for_input";

/** Session-level derived status (waiting_for_input > running > awaiting > new > idle) */
export type DerivedSessionStatus =
  | "waiting_for_input"
  | "running"
  | "awaiting"
  | "new"
  | "idle";

export const toolResultMetricsSchema = z.object({
  lineCount: z.number().int().nonnegative().optional(),
  fileCount: z.number().int().nonnegative().optional(),
  matchCount: z.number().int().nonnegative().optional(),
  byteCount: z.number().int().nonnegative().optional(),
  exitCode: z.number().int().optional(),
});
export type ToolResultMetrics = z.infer<typeof toolResultMetricsSchema>;

// Forward reference: debugModePhaseSchema is defined below in this file.
// We inline its values here so messageContentBlockSchema can be defined first
// without a hoisting cycle.
const debugModePhaseLiterals = z.enum([
  "hypothesizing",
  "awaiting_reproduction",
  "analyzing_evidence",
  "awaiting_verification",
  "cleanup_instrumentation",
]);

export const messageContentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("tool_use"),
    id: z.string().optional(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal("tool_result"),
    tool_use_id: z.string(),
    content: z.string().optional(),
    isError: z.boolean().optional(),
    metrics: toolResultMetricsSchema.optional(),
  }),
  z.object({
    type: z.literal("command"),
    name: z.string(),
    args: z.string().nullable(),
  }),
  z.object({
    type: z.literal("image"),
    mediaType: z.string(),
    base64Data: z.string(),
  }),
  z.object({
    type: z.literal("image_ref"),
    mediaType: z.string(),
    imagePath: z.string(),
  }),
  z.object({
    type: z.literal("image_marker"),
    index: z.number().int().positive(),
    mediaType: z.string(),
    imagePath: z.string(),
  }),
  // Structured debug-mode output (hypothesis list, evidence analysis, fix
  // result, cleanup result). The payload shape varies per phase; the renderer
  // dispatches on `phase` and gracefully degrades when fields are missing
  // (e.g., Codex schema-divergent reply).
  z.object({
    type: z.literal("debug_structured"),
    phase: debugModePhaseLiterals,
    payload: z.unknown(),
  }),
]);
export type MessageContentBlock = z.infer<typeof messageContentBlockSchema>;

export const transcriptMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.array(messageContentBlockSchema),
  timestamp: z.string().nullable(),
  model: z.string().optional(),
  effort: z.string().optional(),
});

// AskUserQuestion schemas (defined before conversationStateSchema which references them)
export const askQuestionOptionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
});
export type AskQuestionOption = z.infer<typeof askQuestionOptionSchema>;

export const askQuestionItemSchema = z.object({
  question: z.string(),
  header: z.string().optional(),
  options: z.array(askQuestionOptionSchema),
  multiSelect: z.boolean().default(false),
});
export type AskQuestionItem = z.infer<typeof askQuestionItemSchema>;

export const forkedFromSchema = z
  .object({
    sourceConversationId: z.string(),
    messageIndex: z.number().int().min(0),
    sourceBackend: agentBackendSchema.nullable().optional(),
    // Null when the fork is not derived from the source SDK session
    // (e.g., user fork at index 0 — "edit and start over").
    sourceBackendRef: agentSessionRefSchema.nullable().optional(),
    forkLocator: z.string().nullable().optional(),
    forkMode: z.enum(["native", "synthetic"]).nullable().default(null),
  })
  .nullable()
  .default(null);
export type ForkedFrom = z.infer<typeof forkedFromSchema>;

export const conversationRoleSchema = z
  .enum(["initialization", "iteration", "validator"])
  .nullable()
  .default(null);
export type ConversationRole = z.infer<typeof conversationRoleSchema>;

// ============================================================
// Debug Mode Schemas
// ============================================================

export const debugHypothesisSchema = z.object({
  id: z.string(),
  description: z.string(),
  instrumentationPlan: z.string().optional(),
});
export type DebugHypothesis = z.infer<typeof debugHypothesisSchema>;

export const debugModePhaseSchema = z.enum([
  "hypothesizing",
  "awaiting_reproduction",
  "analyzing_evidence",
  "awaiting_verification",
  "cleanup_instrumentation",
]);
export type DebugModePhase = z.infer<typeof debugModePhaseSchema>;

export const debugModeStateSchema = z.object({
  active: z.boolean(),
  recording: z.boolean(),
  logFilePath: z.string(),
  enteredAt: z.string(),
  hypotheses: z.array(debugHypothesisSchema).default([]),
  reproductionSteps: z.array(z.string()).default([]),
  fixSummary: z.string().nullable().default(null),
  verificationSteps: z.array(z.string()).default([]),
  instructionsDelivered: z.boolean().default(false),
  phase: debugModePhaseSchema.default("hypothesizing"),
  lastTurnFailed: z.boolean().default(false),
});
export type DebugModeState = z.infer<typeof debugModeStateSchema>;

export const debugLogEntrySchema = z.object({
  timestamp: z.string(),
  hypothesisId: z.string().nullable().default(null),
  location: z.string().nullable().default(null),
  message: z.string(),
  data: z.record(z.string(), z.unknown()).nullable().default(null),
});
export type DebugLogEntry = z.infer<typeof debugLogEntrySchema>;

export const debugProbeEntrySchema = z.object({
  id: z.string(),
  file: z.string(),
  description: z.string(),
});
export type DebugProbeEntry = z.infer<typeof debugProbeEntrySchema>;

export const debugInstrumentationManifestSchema = z.object({
  conversationId: z.string(),
  createdAt: z.string(),
  probes: z.array(debugProbeEntrySchema),
});
export type DebugInstrumentationManifest = z.infer<
  typeof debugInstrumentationManifestSchema
>;

// ============================================================
// MCP Configuration Schemas
// ============================================================

export const mcpConfigLevelSchema = z.enum([
  "global",
  "project",
  "session",
  "conversation",
]);
export type McpConfigLevel = z.infer<typeof mcpConfigLevelSchema>;

export const mcpBackendAvailabilitySchema = z.enum([
  "claude",
  "codex",
  "shared",
]);
export type McpBackendAvailability = z.infer<
  typeof mcpBackendAvailabilitySchema
>;

export const mcpDefinitionScopeSchema = z.enum(["global", "project"]);
export type McpDefinitionScope = z.infer<typeof mcpDefinitionScopeSchema>;

export const mcpTransportSchema = z.enum(["stdio", "streamable-http", "sse"]);
export type McpTransport = z.infer<typeof mcpTransportSchema>;

export const mcpInheritanceStatusSchema = z.enum([
  "explicit",
  "inherited",
  "overridden",
  "disabled",
]);
export type McpInheritanceStatus = z.infer<typeof mcpInheritanceStatusSchema>;

export const toolDiscoveryStateSchema = z.enum([
  "not-loaded",
  "loading",
  "ready",
  "stale",
  "error",
]);
export type ToolDiscoveryState = z.infer<typeof toolDiscoveryStateSchema>;

export const mcpApplyDispositionSchema = z.enum([
  "applied_now",
  "deferred_to_next_turn",
  "no_active_runtime",
  "unsupported",
  "rejected",
]);
export type McpApplyDisposition = z.infer<typeof mcpApplyDispositionSchema>;

// ---------------------------------------------------------------------------
// Override shapes — persisted at every cascade level
// ---------------------------------------------------------------------------

export const mcpToolOverrideSchema = z.object({
  enabled: z.boolean().optional(),
});
export type McpToolOverride = z.infer<typeof mcpToolOverrideSchema>;

export const mcpServerOverrideSchema = z.object({
  enabled: z.boolean().optional(),
  tools: z.record(z.string(), mcpToolOverrideSchema).optional(),
});
export type McpServerOverride = z.infer<typeof mcpServerOverrideSchema>;

export const mcpOverridesSchema = z.object({
  servers: z.record(z.string(), mcpServerOverrideSchema),
});
export type McpOverrides = z.infer<typeof mcpOverridesSchema>;

export const mcpGlobalStateSchema = z.object({
  version: z.literal(1),
  overrides: mcpOverridesSchema,
  updatedAt: z.string(),
});
export type McpGlobalStateFile = z.infer<typeof mcpGlobalStateSchema>;

// ---------------------------------------------------------------------------
// Runtime application state — conversation-level tracking of apply dispositions
// ---------------------------------------------------------------------------

export const mcpRuntimeApplicationStateSchema = z.object({
  lastAppliedConfigHash: z.string().optional(),
  pendingConfigHash: z.string().optional(),
  pendingServerKeys: z.array(z.string()).optional(),
  lastApplyDisposition: mcpApplyDispositionSchema.optional(),
  lastApplyError: z.string().optional(),
});
export type McpRuntimeApplicationState = z.infer<
  typeof mcpRuntimeApplicationStateSchema
>;

// ---------------------------------------------------------------------------
// API view model shared across discovery, resolver, and API layer
// ---------------------------------------------------------------------------

export const mcpSourceRefSchema = z.object({
  scope: mcpDefinitionScopeSchema,
  filePath: z.string(),
});
export type McpSourceRef = z.infer<typeof mcpSourceRefSchema>;

export const mcpDiagnosticSchema = z.object({
  severity: z.enum(["info", "warning", "error"]),
  code: z.string(),
  message: z.string(),
  serverKey: z.string().optional(),
  sourceRef: mcpSourceRefSchema.optional(),
});
export type McpDiagnostic = z.infer<typeof mcpDiagnosticSchema>;

export const mcpServerCompatibilityViewSchema = z.object({
  backends: z.array(
    z.object({
      backend: agentBackendSchema,
      supported: z.boolean(),
      reason: z.string().optional(),
    }),
  ),
});
export type McpServerCompatibilityView = z.infer<
  typeof mcpServerCompatibilityViewSchema
>;

export const mcpToolViewSchema = z.object({
  name: z.string(),
  enabled: z.boolean(),
  inherited: z.boolean(),
  inheritanceStatus: mcpInheritanceStatusSchema,
  orphaned: z.boolean(),
  pending: z.boolean(),
  description: z.string().optional(),
  inputSchema: z.unknown().optional(),
});
export type McpToolView = z.infer<typeof mcpToolViewSchema>;

export const mcpToolListViewSchema = z.object({
  state: toolDiscoveryStateSchema,
  tools: z.array(mcpToolViewSchema),
  diagnostics: z.array(mcpDiagnosticSchema),
  refreshedAt: z.string().optional(),
});
export type McpToolListView = z.infer<typeof mcpToolListViewSchema>;

export const mcpServerViewSchema = z.object({
  serverKey: z.string(),
  displayName: z.string(),
  nativeId: z.string(),
  transport: mcpTransportSchema,
  enabled: z.boolean(),
  inheritanceStatus: mcpInheritanceStatusSchema,
  sourceRefs: z.array(mcpSourceRefSchema),
  reserved: z.boolean(),
  orphaned: z.boolean(),
  pending: z.boolean(),
  tools: mcpToolListViewSchema,
  diagnostics: z.array(mcpDiagnosticSchema),
});
export type McpServerView = z.infer<typeof mcpServerViewSchema>;

export const mcpConfigViewResponseSchema = z.object({
  level: mcpConfigLevelSchema,
  projectName: z.string().optional(),
  sessionName: z.string().optional(),
  conversationId: z.string().optional(),
  servers: z.array(mcpServerViewSchema),
  diagnostics: z.array(mcpDiagnosticSchema),
  pendingServerKeys: z.array(z.string()),
  effectiveConfigHash: z.string().optional(),
});
export type McpConfigViewResponse = z.infer<typeof mcpConfigViewResponseSchema>;

// ---------------------------------------------------------------------------
// Patch request — discriminated union of override operations
// ---------------------------------------------------------------------------

export const mcpOverrideOperationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("set-server-enabled"),
    serverKey: z.string(),
    enabled: z.boolean(),
  }),
  z.object({
    type: z.literal("reset-server"),
    serverKey: z.string(),
  }),
  z.object({
    type: z.literal("set-tool-enabled"),
    serverKey: z.string(),
    toolName: z.string(),
    enabled: z.boolean(),
  }),
  z.object({
    type: z.literal("reset-tool"),
    serverKey: z.string(),
    toolName: z.string(),
  }),
]);
export type McpOverrideOperation = z.infer<typeof mcpOverrideOperationSchema>;

export const mcpConfigPatchRequestSchema = z.object({
  operations: z.array(mcpOverrideOperationSchema),
  expectedEffectiveConfigHash: z.string().optional(),
});
export type McpConfigPatchRequest = z.infer<typeof mcpConfigPatchRequestSchema>;

// ---------------------------------------------------------------------------
// Tool inventory API result
// ---------------------------------------------------------------------------

export const mcpDiscoveredToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.unknown().optional(),
});
export type McpDiscoveredTool = z.infer<typeof mcpDiscoveredToolSchema>;

export const mcpToolInventoryResultSchema = z.object({
  state: toolDiscoveryStateSchema,
  tools: z.array(mcpDiscoveredToolSchema),
  diagnostics: z.array(mcpDiagnosticSchema),
  refreshedAt: z.string().optional(),
});
export type McpToolInventoryResult = z.infer<
  typeof mcpToolInventoryResultSchema
>;

export const mcpToolRefreshRequestSchema = z.object({
  backend: agentBackendSchema.optional(),
});
export type McpToolRefreshRequest = z.infer<typeof mcpToolRefreshRequestSchema>;

// ============================================================
// Agent Capability Configuration Schemas
//
// Persistent override storage, runtime apply state, API view/patch contracts,
// and SSE event payloads for the five backend-specific capability cascades
// (claude-skills, claude-plugins, claude-agents, codex-skills, codex-plugins).
// These schemas are the single source of truth shared by override stores,
// resolvers, API routes, and UI hooks.
// ============================================================

export const AGENT_CAPABILITY_CASCADE_KINDS = [
  "claude-skills",
  "claude-plugins",
  "claude-agents",
  "codex-skills",
  "codex-plugins",
] as const;

export const agentCapabilityCascadeKindSchema = z.enum(
  AGENT_CAPABILITY_CASCADE_KINDS,
);
export type AgentCapabilityCascadeKind = z.infer<
  typeof agentCapabilityCascadeKindSchema
>;

// Backend ownership of each cascade is fixed by name. Pairing
// (cascadeKind: "claude-skills", backend: "codex") is structurally invalid
// and must be rejected at the schema boundary so downstream resolvers,
// translators, API routes, and UI hooks never re-check it.
export const AGENT_CAPABILITY_CASCADE_BACKEND_OWNERSHIP: Readonly<
  Record<AgentCapabilityCascadeKind, AgentBackendId>
> = {
  "claude-skills": "claude",
  "claude-plugins": "claude",
  "claude-agents": "claude",
  "codex-skills": "codex",
  "codex-plugins": "codex",
};

export function requireAgentCapabilityCascadeBackendOwnership(
  value: {
    cascadeKind: AgentCapabilityCascadeKind;
    backend: AgentBackendId;
  },
  ctx: z.RefinementCtx,
): void {
  const expected =
    AGENT_CAPABILITY_CASCADE_BACKEND_OWNERSHIP[value.cascadeKind];
  if (value.backend !== expected) {
    ctx.addIssue({
      code: "custom",
      message: `cascadeKind '${value.cascadeKind}' is owned by backend '${expected}', not '${value.backend}'`,
      path: ["backend"],
    });
  }
}

export const agentCapabilityCapabilityKindSchema = z.enum([
  "skill",
  "plugin",
  "agent",
]);
export type AgentCapabilityKind = z.infer<
  typeof agentCapabilityCapabilityKindSchema
>;

export const agentCapabilityCascadeLayerSchema = z.enum([
  "global",
  "project",
  "session",
  "conversation",
]);
export type AgentCapabilityCascadeLayer = z.infer<
  typeof agentCapabilityCascadeLayerSchema
>;

export const agentCapabilityOriginLayerSchema = z.enum([
  "global",
  "project",
  "session",
  "conversation",
  "native",
]);
export type AgentCapabilityOriginLayer = z.infer<
  typeof agentCapabilityOriginLayerSchema
>;

export const agentCapabilityApplyStatusSchema = z.enum([
  "applied",
  "staged-idle",
  "staged-next-turn",
  "deferred-next-conversation",
  "unsupported",
  "rejected",
  "none",
]);
export type AgentCapabilityApplyStatus = z.infer<
  typeof agentCapabilityApplyStatusSchema
>;

export const agentCapabilityRuntimeVisibilitySchema = z.enum([
  "runtime-visible",
  "source-only",
  "unavailable",
  "stale",
]);
export type AgentCapabilityRuntimeVisibility = z.infer<
  typeof agentCapabilityRuntimeVisibilitySchema
>;

export const agentCapabilityApplySemanticsSchema = z.enum([
  "idle-live-apply",
  "next-turn",
  "next-conversation",
]);
export type AgentCapabilityApplySemantics = z.infer<
  typeof agentCapabilityApplySemanticsSchema
>;

export const agentCapabilityDiscoverySupportSchema = z.enum([
  "available",
  "unavailable-pending-verification",
]);
export type AgentCapabilityDiscoverySupport = z.infer<
  typeof agentCapabilityDiscoverySupportSchema
>;

export const agentCapabilityMetadataRuntimeVisibilitySchema = z.enum([
  "sdk-runtime",
  "source-only",
  "unsupported",
]);
export type AgentCapabilityMetadataRuntimeVisibility = z.infer<
  typeof agentCapabilityMetadataRuntimeVisibilitySchema
>;

export const agentCapabilityCompositionSupportSchema = z.enum([
  "native",
  "translator",
  "verification-gated",
  "diagnostic-only",
]);
export type AgentCapabilityCompositionSupport = z.infer<
  typeof agentCapabilityCompositionSupportSchema
>;

// ---------------------------------------------------------------------------
// Persistent override storage — sparse per-cascade item records
// `enabled` is required when an item key exists; key absence means inherit
// from a broader layer or the backend native default.
// ---------------------------------------------------------------------------

export const agentCapabilityItemOverrideSchema = z.object({
  enabled: z.boolean(),
});
export type AgentCapabilityItemOverride = z.infer<
  typeof agentCapabilityItemOverrideSchema
>;

export const agentCapabilityCascadeOverrideSchema = z.object({
  items: z.record(z.string(), agentCapabilityItemOverrideSchema),
});
export type AgentCapabilityCascadeOverride = z.infer<
  typeof agentCapabilityCascadeOverrideSchema
>;

// `z.partialRecord` produces `Partial<Record<AgentCapabilityCascadeKind, V>>`
// in Zod v4 — exactly the sparse shape this feature requires (overrides only
// exist for cascades the user has touched). `z.record(enum, V)` instead treats
// the enum as a closed key set and demands every value, which is wrong here.
export const agentCapabilityCascadesOverrideSchema = z.partialRecord(
  agentCapabilityCascadeKindSchema,
  agentCapabilityCascadeOverrideSchema,
);
export type AgentCapabilityCascadesOverride = z.infer<
  typeof agentCapabilityCascadesOverrideSchema
>;

export const agentCapabilityOverridesSchema = z.object({
  cascades: agentCapabilityCascadesOverrideSchema,
});
export type AgentCapabilityOverrides = z.infer<
  typeof agentCapabilityOverridesSchema
>;

export const agentCapabilityGlobalStateSchema = z.object({
  version: z.literal(1),
  overrides: agentCapabilityOverridesSchema,
  updatedAt: z.string(),
});
export type AgentCapabilityGlobalStateFile = z.infer<
  typeof agentCapabilityGlobalStateSchema
>;

// ---------------------------------------------------------------------------
// Runtime apply state — conversation-level per-cascade tracking
// ---------------------------------------------------------------------------

export const agentCapabilityCascadeRuntimeStateSchema = z.object({
  appliedHash: z.string().optional(),
  pendingHash: z.string().optional(),
  pendingItemIds: z.array(z.string()).optional(),
  lastApplyStatus: agentCapabilityApplyStatusSchema.optional(),
  lastApplyError: z.string().optional(),
});
export type AgentCapabilityCascadeRuntimeState = z.infer<
  typeof agentCapabilityCascadeRuntimeStateSchema
>;

export const agentCapabilityRuntimeApplicationStateSchema = z.object({
  cascades: z.partialRecord(
    agentCapabilityCascadeKindSchema,
    agentCapabilityCascadeRuntimeStateSchema,
  ),
});
export type AgentCapabilityRuntimeApplicationState = z.infer<
  typeof agentCapabilityRuntimeApplicationStateSchema
>;

// ---------------------------------------------------------------------------
// API view model — resolved view rows shared across discovery, resolver, API
// ---------------------------------------------------------------------------

export const agentCapabilityScopeContextSchema = z.object({
  level: agentCapabilityCascadeLayerSchema,
  projectName: z.string().optional(),
  sessionName: z.string().optional(),
  conversationId: z.string().optional(),
});
export type AgentCapabilityScopeContext = z.infer<
  typeof agentCapabilityScopeContextSchema
>;

export const agentCapabilitySourceRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("global-file"),
    path: z.string(),
  }),
  z.object({
    kind: z.literal("project-file"),
    path: z.string(),
  }),
  z.object({
    kind: z.literal("user-file"),
    path: z.string(),
  }),
  z.object({
    kind: z.literal("system-file"),
    path: z.string(),
  }),
  z.object({
    kind: z.literal("plugin"),
    pluginId: z.string(),
  }),
  z.object({
    kind: z.literal("sdk-runtime"),
  }),
]);
export type AgentCapabilitySourceRef = z.infer<
  typeof agentCapabilitySourceRefSchema
>;

export const agentCapabilityNativeDefaultSchema = z.object({
  enabled: z.boolean(),
  mode: z.string().optional(),
});
export type AgentCapabilityNativeDefault = z.infer<
  typeof agentCapabilityNativeDefaultSchema
>;

export const agentCapabilityEffectiveStateSchema = z.object({
  enabled: z.boolean(),
  originLayer: agentCapabilityOriginLayerSchema,
});
export type AgentCapabilityEffectiveState = z.infer<
  typeof agentCapabilityEffectiveStateSchema
>;

export const agentCapabilityInheritedDisableReasonSchema = z.object({
  pluginId: z.string(),
  originLayer: agentCapabilityOriginLayerSchema,
});
export type AgentCapabilityInheritedDisableReason = z.infer<
  typeof agentCapabilityInheritedDisableReasonSchema
>;

// `.strict()` keeps native config payloads out of the diagnostics wire shape.
// Diagnostics carry only identifiers and human-readable messages. When both
// `cascadeKind` and `backend` are present, the pairing is validated against
// the same ownership map used by view rows so diagnostics cannot misattribute
// a Codex cascade to the Claude backend.
export const agentCapabilityDiagnosticSchema = z
  .object({
    severity: z.enum(["info", "warning", "error"]),
    code: z.string(),
    message: z.string(),
    cascadeKind: agentCapabilityCascadeKindSchema.optional(),
    layer: agentCapabilityCascadeLayerSchema.optional(),
    itemId: z.string().optional(),
    backend: agentBackendSchema.optional(),
    projectName: z.string().optional(),
    sessionName: z.string().optional(),
    conversationId: z.string().optional(),
    sourceRef: agentCapabilitySourceRefSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.cascadeKind === undefined || value.backend === undefined) return;
    requireAgentCapabilityCascadeBackendOwnership(
      { cascadeKind: value.cascadeKind, backend: value.backend },
      ctx,
    );
  });
export type AgentCapabilityDiagnostic = z.infer<
  typeof agentCapabilityDiagnosticSchema
>;

export const agentCapabilityDiscoveredItemSchema = z.object({
  itemId: z.string(),
  displayName: z.string(),
  capabilityKind: agentCapabilityCapabilityKindSchema,
  source: agentCapabilitySourceRefSchema,
  nativeDefault: agentCapabilityNativeDefaultSchema,
  owningPluginId: z.string().optional(),
  runtimeVisibility: agentCapabilityRuntimeVisibilitySchema,
});
export type AgentCapabilityDiscoveredItem = z.infer<
  typeof agentCapabilityDiscoveredItemSchema
>;

export const agentCapabilityViewRowSchema = z
  .object({
    itemId: z.string(),
    displayName: z.string(),
    backend: agentBackendSchema,
    capabilityKind: agentCapabilityCapabilityKindSchema,
    cascadeKind: agentCapabilityCascadeKindSchema,
    source: agentCapabilitySourceRefSchema,
    nativeDefault: agentCapabilityNativeDefaultSchema,
    ownEffectiveState: agentCapabilityEffectiveStateSchema,
    currentLayerValue: agentCapabilityEffectiveStateSchema.optional(),
    inheritedEffectiveState: agentCapabilityEffectiveStateSchema.optional(),
    effectiveState: agentCapabilityEffectiveStateSchema,
    originLayer: agentCapabilityOriginLayerSchema,
    owningPluginId: z.string().optional(),
    inheritedDisableReason:
      agentCapabilityInheritedDisableReasonSchema.optional(),
    runtimeVisibility: agentCapabilityRuntimeVisibilitySchema,
    runtimeEmittable: z.boolean(),
    stale: z.boolean(),
    applyStatus: agentCapabilityApplyStatusSchema,
    diagnostics: z.array(agentCapabilityDiagnosticSchema),
  })
  .superRefine(requireAgentCapabilityCascadeBackendOwnership);
export type AgentCapabilityViewRow = z.infer<
  typeof agentCapabilityViewRowSchema
>;

// Canonical capability metadata shape. Used by:
// - The metadata registry (`src/lib/agent-capabilities/metadata.ts`) which
//   parses every record at construction time.
// - API view responses, where the metadata field describes the same cascade
//   the response targets. Re-exported below as `agentCapabilityViewMetadataSchema`
//   so downstream consumers see one canonical shape, not a duplicate.
export const agentCapabilityMetadataSchema = z
  .object({
    cascadeKind: agentCapabilityCascadeKindSchema,
    backend: agentBackendSchema,
    capabilityKind: agentCapabilityCapabilityKindSchema,
    applySemantics: agentCapabilityApplySemanticsSchema,
    discoverySupport: agentCapabilityDiscoverySupportSchema,
    runtimeVisibility: agentCapabilityMetadataRuntimeVisibilitySchema,
    compositionSupport: agentCapabilityCompositionSupportSchema,
  })
  .strict()
  .superRefine(requireAgentCapabilityCascadeBackendOwnership);
export type AgentCapabilityMetadata = z.infer<
  typeof agentCapabilityMetadataSchema
>;

export const agentCapabilityViewMetadataSchema = agentCapabilityMetadataSchema;
export type AgentCapabilityViewMetadata = AgentCapabilityMetadata;

export const agentCapabilityViewResponseSchema = z
  .object({
    level: agentCapabilityCascadeLayerSchema,
    projectName: z.string().optional(),
    sessionName: z.string().optional(),
    conversationId: z.string().optional(),
    cascadeKind: agentCapabilityCascadeKindSchema,
    backend: agentBackendSchema,
    items: z.array(agentCapabilityViewRowSchema),
    diagnostics: z.array(agentCapabilityDiagnosticSchema),
    effectiveHash: z.string(),
    metadata: agentCapabilityViewMetadataSchema.optional(),
  })
  .superRefine(requireAgentCapabilityCascadeBackendOwnership)
  .superRefine((value, ctx) => {
    if (!value.metadata) return;
    if (value.metadata.cascadeKind !== value.cascadeKind) {
      ctx.addIssue({
        code: "custom",
        message: `metadata.cascadeKind '${value.metadata.cascadeKind}' must match response cascadeKind '${value.cascadeKind}'`,
        path: ["metadata", "cascadeKind"],
      });
    }
  });
export type AgentCapabilityViewResponse = z.infer<
  typeof agentCapabilityViewResponseSchema
>;

export const agentCapabilityInventorySchema = z.object({
  cascadeKind: agentCapabilityCascadeKindSchema,
  items: z.array(agentCapabilityDiscoveredItemSchema),
  diagnostics: z.array(agentCapabilityDiagnosticSchema),
  sourceSignature: z.string(),
  refreshedAt: z.string(),
});
export type AgentCapabilityInventory = z.infer<
  typeof agentCapabilityInventorySchema
>;

// ---------------------------------------------------------------------------
// Patch request — set / reset operations applied atomically at a single layer
// ---------------------------------------------------------------------------

export const agentCapabilityOverrideOperationSchema = z.discriminatedUnion(
  "type",
  [
    z.object({
      type: z.literal("set-item-enabled"),
      itemId: z.string(),
      enabled: z.boolean(),
    }),
    z.object({
      type: z.literal("reset-item"),
      itemId: z.string(),
    }),
  ],
);
export type AgentCapabilityOverrideOperation = z.infer<
  typeof agentCapabilityOverrideOperationSchema
>;

export const agentCapabilityPatchRequestSchema = z.object({
  cascadeKind: agentCapabilityCascadeKindSchema,
  operations: z.array(agentCapabilityOverrideOperationSchema),
  expectedHash: z.string().optional(),
});
export type AgentCapabilityPatchRequest = z.infer<
  typeof agentCapabilityPatchRequestSchema
>;

export const agentCapabilityRefreshRequestSchema = z.object({
  cascadeKind: agentCapabilityCascadeKindSchema,
});
export type AgentCapabilityRefreshRequest = z.infer<
  typeof agentCapabilityRefreshRequestSchema
>;

export const agentCapabilityInvalidationHintsSchema = z
  .object({
    level: agentCapabilityCascadeLayerSchema,
    projectName: z.string().optional(),
    sessionName: z.string().optional(),
    conversationId: z.string().optional(),
    cascadeKind: agentCapabilityCascadeKindSchema,
    itemIds: z.array(z.string()).optional(),
    effectiveHash: z.string().optional(),
    refreshDiscovery: z.boolean().optional(),
    sourceSignature: z.string().optional(),
    operationId: z.string().optional(),
  })
  .strict();
export type AgentCapabilityInvalidationHints = z.infer<
  typeof agentCapabilityInvalidationHintsSchema
>;

// ---------------------------------------------------------------------------
// SSE events — `.strict()` blocks any attempt to carry native config payloads
// across the wire. Only identifiers, cascade keys, and invalidation hints.
// ---------------------------------------------------------------------------

export const agentCapabilitiesUpdatedEventSchema = z
  .object({
    type: z.literal("agent-capabilities-updated"),
    level: agentCapabilityCascadeLayerSchema,
    projectName: z.string().optional(),
    sessionName: z.string().optional(),
    conversationId: z.string().optional(),
    cascadeKind: agentCapabilityCascadeKindSchema,
    backend: agentBackendSchema,
    changedItemIds: z.array(z.string()),
    effectiveHash: z.string(),
    operationId: z.string().optional(),
    invalidationHints: agentCapabilityInvalidationHintsSchema,
  })
  .strict()
  .superRefine(requireAgentCapabilityCascadeBackendOwnership)
  .superRefine((value, ctx) => {
    validateAgentCapabilityInvalidationHintsMatch(
      value,
      value.invalidationHints,
      ctx,
    );
  });
export type AgentCapabilitiesUpdatedEvent = z.infer<
  typeof agentCapabilitiesUpdatedEventSchema
>;

export const agentCapabilitiesDiscoveryUpdatedEventSchema = z
  .object({
    type: z.literal("agent-capabilities-discovery-updated"),
    level: agentCapabilityCascadeLayerSchema,
    projectName: z.string().optional(),
    sessionName: z.string().optional(),
    conversationId: z.string().optional(),
    cascadeKind: agentCapabilityCascadeKindSchema,
    backend: agentBackendSchema,
    refreshedAt: z.string(),
    sourceSignature: z.string(),
    invalidationHints: agentCapabilityInvalidationHintsSchema,
  })
  .strict()
  .superRefine(requireAgentCapabilityCascadeBackendOwnership)
  .superRefine((value, ctx) => {
    validateAgentCapabilityInvalidationHintsMatch(
      value,
      value.invalidationHints,
      ctx,
    );
  });
export type AgentCapabilitiesDiscoveryUpdatedEvent = z.infer<
  typeof agentCapabilitiesDiscoveryUpdatedEventSchema
>;

function validateAgentCapabilityInvalidationHintsMatch(
  value: {
    level: AgentCapabilityCascadeLayer;
    projectName?: string;
    sessionName?: string;
    conversationId?: string;
    cascadeKind: AgentCapabilityCascadeKind;
  },
  hints: AgentCapabilityInvalidationHints,
  ctx: z.RefinementCtx,
): void {
  const fields = [
    "level",
    "projectName",
    "sessionName",
    "conversationId",
    "cascadeKind",
  ] as const;
  for (const field of fields) {
    if (value[field] !== hints[field]) {
      ctx.addIssue({
        code: "custom",
        message: `invalidationHints.${field} must match event ${field}`,
        path: ["invalidationHints", field],
      });
    }
  }
}

// ============================================================
// Conversation State
// ============================================================

// Restricts conversationId to filesystem-safe characters. The id is used as a
// directory name for transcripts and debug logs, so any character that could
// enable path traversal or escape the parent directory must be rejected at
// the trust boundary. UUIDs and underscored/dashed ids both fit this regex.
const conversationIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

export const conversationStateSchema = z.object({
  id: conversationIdSchema,
  name: z.string().nullable().default(null),
  transcriptPath: z.string().nullable(),
  status: conversationStatusSchema,
  promptCount: z.number(),
  createdAt: z.string(),
  lastActivityAt: z.string(),
  source: z.enum(["cc", "imported"]).default("cc"),
  summary: z.string().nullable().default(null),
  archived: z.boolean().default(false),
  totalCostUsd: z.number().nullable().default(null),
  totalDurationMs: z.number().nullable().default(null),
  totalTurns: z.number().nullable().default(null),
  pendingQuestionId: z.string().nullable().default(null),
  pendingQuestions: z.array(askQuestionItemSchema).nullable().default(null),
  pendingPromptText: z.string().nullable().default(null),
  forkedFrom: forkedFromSchema,
  role: conversationRoleSchema,
  contextTokens: z.number().nullable().default(null),
  contextWindowMax: z.number().nullable().default(null),
  debugMode: debugModeStateSchema.nullable().default(null),
  machineSnapshot: z.unknown().nullable().default(null),
  agentBackend: agentBackendSchema.default("claude"),
  backendRef: agentSessionRefSchema.nullable().default(null),
  mcpOverrides: mcpOverridesSchema.optional(),
  mcpRuntime: mcpRuntimeApplicationStateSchema.optional(),
  agentCapabilityOverrides: agentCapabilityOverridesSchema.optional(),
  agentCapabilitiesRuntime:
    agentCapabilityRuntimeApplicationStateSchema.optional(),
});
export type ConversationState = z.infer<typeof conversationStateSchema>;

export const sessionSourceSchema = z.enum(["cc", "imported"]);
export type SessionSource = z.infer<typeof sessionSourceSchema>;

export const sessionCreationModeSchema = z.enum([
  "fast",
  "focus",
  "optimistic",
]);
export type SessionCreationMode = z.infer<typeof sessionCreationModeSchema>;

// ============================================================
// Graph Workflow Schemas
// (defined before sessionStateSchema so it can reference graphWorkflowExecutionSchema)
// ============================================================

export const graphWorkflowClaudeAgentConfigSchema = z.object({
  backend: z.literal("claude"),
  model: claudeModelSchema,
  reasoningEffort: effortLevelSchema,
});

export const graphWorkflowCodexAgentConfigSchema = z.object({
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

export const graphWorkflowCircuitBreakerConditionSchema = z.enum([
  "retry_exhaustion",
]);
export type GraphWorkflowCircuitBreakerCondition = z.infer<
  typeof graphWorkflowCircuitBreakerConditionSchema
>;

export const graphWorkflowCircuitBreakerPolicySchema = z.object({
  consecutiveFailureThreshold: z.number().int().min(1).optional(),
});
export type GraphWorkflowCircuitBreakerPolicy = z.infer<
  typeof graphWorkflowCircuitBreakerPolicySchema
>;

export const graphWorkflowLaneContinuityPolicySchema = z.object({
  enabled: z.boolean().default(true),
  contextLimitTokens: z.number().int().positive().optional(),
});
export type GraphWorkflowLaneContinuityPolicy = z.infer<
  typeof graphWorkflowLaneContinuityPolicySchema
>;

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

export const graphWorkflowClaudeValidatorConfigSchema =
  graphWorkflowValidatorBaseSchema.extend({
    type: z.literal("claude"),
    agent: graphWorkflowAgentConfigSchema,
  });

export const graphWorkflowCodexValidatorConfigSchema =
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
export type GraphWorkflowClaudeValidatorConfig = z.infer<
  typeof graphWorkflowClaudeValidatorConfigSchema
>;
export type GraphWorkflowCodexValidatorConfig = z.infer<
  typeof graphWorkflowCodexValidatorConfigSchema
>;

export const graphWorkflowContextValidationSchema =
  graphWorkflowAgentValidatorConfigSchema;
export type GraphWorkflowContextValidation = z.infer<
  typeof graphWorkflowContextValidationSchema
>;

export const graphWorkflowScriptValidatorConfigSchema = z.object({
  enabled: z.boolean().default(false),
});
export type GraphWorkflowScriptValidatorConfig = z.infer<
  typeof graphWorkflowScriptValidatorConfigSchema
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
});
export type GraphWorkflowExecutionContextDefinition = z.infer<
  typeof graphWorkflowExecutionContextDefinitionSchema
>;

export const graphWorkflowTaskSourceSchema = z.enum(["user", "agent"]);
export type GraphWorkflowTaskSource = z.infer<
  typeof graphWorkflowTaskSourceSchema
>;

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

export const workflowConfigOverrideSchema = z.object({
  implementer: graphWorkflowAgentConfigSchema.optional(),
  contextValidator: graphWorkflowAgentValidatorConfigSchema.optional(),
  scriptValidator: graphWorkflowScriptValidatorConfigSchema.optional(),
  iterationPolicy: graphWorkflowIterationPolicySchema.optional(),
  circuitBreaker: graphWorkflowCircuitBreakerPolicySchema.optional(),
  mutability: graphWorkflowMutabilityPolicySchema.optional(),
});
export type WorkflowConfigOverride = z.infer<
  typeof workflowConfigOverrideSchema
>;

export const workflowSemanticDefinitionSchema = z.object({
  schemaVersion: z.number().int().positive().default(1),
  workflowConfig: workflowConfigOverrideSchema.default({}),
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
  mutability: graphWorkflowMutabilityPolicySchema,
  circuitBreaker: graphWorkflowCircuitBreakerPolicySchema,
  iterationPolicy: graphWorkflowIterationPolicySchema,
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

export const graphWorkflowPositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});
export type GraphWorkflowPosition = z.infer<typeof graphWorkflowPositionSchema>;

export const graphWorkflowViewportSchema = z.object({
  x: z.number().default(0),
  y: z.number().default(0),
  zoom: z.number().positive().default(1),
});
export type GraphWorkflowViewport = z.infer<typeof graphWorkflowViewportSchema>;

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
export type WorkflowAgentValidatorResult = z.infer<
  typeof workflowAgentValidatorResultSchema
>;

export const graphWorkflowSharedDocumentEntrySchema = z.object({
  id: z.string().trim().min(1),
  relativePath: z.string().trim().min(1),
  description: z.string().trim().min(1),
  readWhen: z.string().trim().min(1),
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

export const graphWorkflowHaltReasonSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("circuit_breaker"),
    contextId: z.string().trim().min(1),
    condition: graphWorkflowCircuitBreakerConditionSchema,
    failureCount: z.number().int().min(0).optional(),
    summary: z.string().nullable().default(null),
  }),
  z.object({
    type: z.literal("max_iterations"),
    contextId: z.string().trim().min(1),
    iterationCount: z.number().int().min(0),
  }),
  z.object({
    type: z.literal("recovery_error"),
    message: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal("aborted"),
  }),
  z.object({
    type: z.literal("validator_infra_error"),
    contextId: z.string().trim().min(1),
    engine: z.enum(["claude", "codex"]),
    infraReason: z.enum(["exception", "unparseable", "schema_mismatch"]),
    message: z.string(),
    summary: z.string().nullable().default(null),
  }),
  z.object({
    type: z.literal("script_validator_missing_command"),
    contextId: z.string().trim().min(1),
    message: z.string(),
  }),
  z.object({
    type: z.literal("merge_failure"),
    contextId: z.string().trim().min(1),
    message: z.string(),
    conflictFiles: z.array(z.string()).default([]),
  }),
  z.object({
    type: z.literal("merge_precondition_failed"),
    contextId: z.string().trim().min(1),
    targetBranch: z.string().trim().min(1),
    dirtyPaths: z
      .array(
        z.object({
          path: z.string(),
          statusCode: z.string(),
          tracked: z.boolean(),
        }),
      )
      .max(5)
      .default([]),
    totalDirtyCount: z.number().int().min(0),
    message: z.string(),
  }),
  z.object({
    type: z.literal("agent_turn_failed"),
    contextId: z.string().trim().min(1),
    engine: z.enum(["claude", "codex"]),
    cause: z.enum(["sdk_error", "abort", "unknown"]),
    message: z.string(),
  }),
  z.object({
    type: z.literal("worktree_creation_dirty"),
    contextId: z.string().trim().min(1).nullable().default(null),
    worktreePath: z.string().trim().min(1),
    branchName: z.string().trim().min(1),
    dirtyPaths: z
      .array(
        z.object({
          path: z.string(),
          statusCode: z.string(),
          tracked: z.boolean(),
        }),
      )
      .max(5)
      .default([]),
    totalDirtyCount: z.number().int().min(0),
  }),
  z.object({
    type: z.literal("execution_loop_failed"),
    contextId: z.string().trim().min(1).nullable().default(null),
    message: z.string(),
    cause: z.enum(["sdk_error", "validation", "io", "unknown"]),
  }),
]);
export type GraphWorkflowHaltReason = z.infer<
  typeof graphWorkflowHaltReasonSchema
>;

export const graphWorkflowExecutionContextStateSchema = z.object({
  contextId: z.string().trim().min(1),
  status: graphWorkflowContextStatusSchema,
  totalTaskCount: z.number().int().min(0),
  completedTaskCount: z.number().int().min(0).default(0),
  iterationCount: z.number().int().min(0).default(0),
  consecutiveFailureCount: z.number().int().min(0).default(0),
  worktreePath: z.string().nullable().default(null),
  branchName: z.string().nullable().default(null),
  isolation: z.enum(["session", "worktree"]).default("session"),
  batchId: z.string().nullable().default(null),
  mergeStatus: z
    .enum([
      "not-applicable",
      "pending",
      "in-progress",
      "merged-success",
      "merged-failed",
      "conflicts",
    ])
    .default("not-applicable"),
  cleanupStatus: z
    .enum(["not-applicable", "pending", "removed", "failed"])
    .default("not-applicable"),
  lastMergeError: z.string().nullable().default(null),
});
export type GraphWorkflowExecutionContextState = z.infer<
  typeof graphWorkflowExecutionContextStateSchema
>;

export const graphWorkflowTaskValidationFailureSchema = z.object({
  message: z.string(),
  timestamp: z.string(),
});
export type GraphWorkflowTaskValidationFailure = z.infer<
  typeof graphWorkflowTaskValidationFailureSchema
>;

export const graphWorkflowTaskStateSchema = z.object({
  taskId: z.string().trim().min(1),
  contextId: z.string().trim().min(1),
  order: z.number().int().min(1),
  status: graphWorkflowTaskStatusSchema,
  summary: z.string().nullable().default(null),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
  lastConversationId: z.string().nullable().default(null),
  failureMessage: z.string().nullable().default(null),
  failureHistory: z.array(graphWorkflowTaskValidationFailureSchema).default([]),
});
export type GraphWorkflowTaskState = z.infer<
  typeof graphWorkflowTaskStateSchema
>;

export const graphWorkflowValidatorTypeSchema = z.enum(["context"]);
export type GraphWorkflowValidatorType = z.infer<
  typeof graphWorkflowValidatorTypeSchema
>;

export const graphWorkflowStatusEventSchema = z.object({
  type: z.literal("graph-workflow-status"),
  projectName: z.string(),
  sessionName: z.string(),
  executionId: z.string(),
  workflowStatus: graphWorkflowStatusSchema,
  activeContextIds: z.array(z.string()).default([]),
  activeBatchIds: z.array(z.string()).default([]),
  haltReason: graphWorkflowHaltReasonSchema.nullable().default(null),
  pendingHaltReason: graphWorkflowHaltReasonSchema.nullable().default(null),
  secondaryHaltReasons: z.array(graphWorkflowHaltReasonSchema).default([]),
});
export type GraphWorkflowStatusEvent = z.infer<
  typeof graphWorkflowStatusEventSchema
>;

export const graphWorkflowMergeStatusValueSchema = z.enum([
  "not-applicable",
  "pending",
  "in-progress",
  "merged-success",
  "merged-failed",
  "conflicts",
]);
export type GraphWorkflowMergeStatusValue = z.infer<
  typeof graphWorkflowMergeStatusValueSchema
>;

export const graphWorkflowCleanupStatusValueSchema = z.enum([
  "not-applicable",
  "pending",
  "removed",
  "failed",
]);
export type GraphWorkflowCleanupStatusValue = z.infer<
  typeof graphWorkflowCleanupStatusValueSchema
>;

export const graphWorkflowPendingHaltReasonEventSchema = z.object({
  type: z.literal("graph-workflow-pending-halt-reason"),
  projectName: z.string(),
  sessionName: z.string(),
  executionId: z.string(),
  pendingHaltReason: graphWorkflowHaltReasonSchema.nullable(),
});
export type GraphWorkflowPendingHaltReasonEvent = z.infer<
  typeof graphWorkflowPendingHaltReasonEventSchema
>;

export const graphWorkflowMergeStatusEventSchema = z.object({
  type: z.literal("graph-workflow-merge-status"),
  projectName: z.string(),
  sessionName: z.string(),
  executionId: z.string(),
  contextId: z.string(),
  branchName: z.string().nullable(),
  mergeStatus: graphWorkflowMergeStatusValueSchema,
  cleanupStatus: graphWorkflowCleanupStatusValueSchema,
  lastMergeError: z.string().nullable(),
});
export type GraphWorkflowMergeStatusEvent = z.infer<
  typeof graphWorkflowMergeStatusEventSchema
>;

export const graphWorkflowBatchScheduledEventSchema = z.object({
  type: z.literal("graph-workflow-batch-scheduled"),
  projectName: z.string(),
  sessionName: z.string(),
  executionId: z.string(),
  batchId: z.string(),
  contextIds: z.array(z.string()),
});
export type GraphWorkflowBatchScheduledEvent = z.infer<
  typeof graphWorkflowBatchScheduledEventSchema
>;

export const graphWorkflowContextStatusEventSchema = z.object({
  type: z.literal("graph-workflow-context-status"),
  projectName: z.string(),
  sessionName: z.string(),
  executionId: z.string(),
  contextId: z.string(),
  status: graphWorkflowContextStatusSchema,
  remainingTaskCount: z.number().int().min(0),
  iterationCount: z.number().int().min(0),
});
export type GraphWorkflowContextStatusEvent = z.infer<
  typeof graphWorkflowContextStatusEventSchema
>;

export const graphWorkflowTaskStatusEventSchema = z.object({
  type: z.literal("graph-workflow-task-status"),
  projectName: z.string(),
  sessionName: z.string(),
  executionId: z.string(),
  taskId: z.string(),
  contextId: z.string(),
  status: graphWorkflowTaskStatusSchema,
  source: graphWorkflowTaskSourceSchema,
  order: z.number().int().min(1),
  lastConversationId: z.string().nullable().optional(),
  startedAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  failureMessage: z.string().nullable().optional(),
});
export type GraphWorkflowTaskStatusEvent = z.infer<
  typeof graphWorkflowTaskStatusEventSchema
>;

export const graphWorkflowLaneKindSchema = z.enum([
  "implementer",
  "context_validator",
]);
export type GraphWorkflowLaneKind = z.infer<typeof graphWorkflowLaneKindSchema>;

export const graphWorkflowExecutionSessionRefSchema = z.discriminatedUnion(
  "engine",
  [
    z.object({
      engine: z.literal("claude"),
      lane: graphWorkflowLaneKindSchema,
      conversationId: z.string().trim().min(1),
    }),
    z.object({
      engine: z.literal("codex"),
      lane: graphWorkflowLaneKindSchema,
      threadId: z.string().trim().min(1),
    }),
  ],
);
export type GraphWorkflowExecutionSessionRef = z.infer<
  typeof graphWorkflowExecutionSessionRefSchema
>;

export const graphWorkflowValidationReviewArtifactSchema = z.discriminatedUnion(
  "engine",
  [
    z.object({
      engine: z.literal("claude"),
      conversationId: z.string().trim().min(1),
    }),
    z.object({
      engine: z.literal("codex"),
      threadId: z.string().trim(),
      response: z.string(),
      usage: z
        .object({
          inputTokens: z.number().int().min(0),
          cachedInputTokens: z.number().int().min(0),
          outputTokens: z.number().int().min(0),
        })
        .nullable()
        .default(null),
    }),
  ],
);
export type GraphWorkflowValidationReviewArtifact = z.infer<
  typeof graphWorkflowValidationReviewArtifactSchema
>;

export const graphWorkflowValidationResultEventSchema = z.object({
  type: z.literal("graph-workflow-validation-result"),
  projectName: z.string(),
  sessionName: z.string(),
  executionId: z.string(),
  contextId: z.string(),
  validatorType: graphWorkflowValidatorTypeSchema,
  pass: z.boolean(),
  summary: z.string(),
  reopenTaskIds: z.array(z.string().trim().min(1)).default([]),
  issues: z.array(workflowValidatorIssueSchema).default([]),
  sessionRef: graphWorkflowExecutionSessionRefSchema.nullable().optional(),
  reviewArtifact: graphWorkflowValidationReviewArtifactSchema
    .nullable()
    .optional(),
});
export type GraphWorkflowValidationResultEvent = z.infer<
  typeof graphWorkflowValidationResultEventSchema
>;

export const graphWorkflowCircuitBreakerEventSchema = z.object({
  type: z.literal("graph-workflow-circuit-breaker"),
  projectName: z.string(),
  sessionName: z.string(),
  executionId: z.string(),
  contextId: z.string(),
  condition: graphWorkflowCircuitBreakerConditionSchema,
  failureCount: z.number().int().min(0),
  summary: z.string().nullable().default(null),
});
export type GraphWorkflowCircuitBreakerEvent = z.infer<
  typeof graphWorkflowCircuitBreakerEventSchema
>;

export const graphWorkflowSharedDocumentsUpdatedEventSchema = z.object({
  type: z.literal("graph-workflow-shared-documents-updated"),
  projectName: z.string(),
  sessionName: z.string(),
  executionId: z.string(),
  documents: z.array(graphWorkflowSharedDocumentEntrySchema),
});
export type GraphWorkflowSharedDocumentsUpdatedEvent = z.infer<
  typeof graphWorkflowSharedDocumentsUpdatedEventSchema
>;

export const graphWorkflowSseEventSchema = z.discriminatedUnion("type", [
  graphWorkflowStatusEventSchema,
  graphWorkflowContextStatusEventSchema,
  graphWorkflowTaskStatusEventSchema,
  graphWorkflowValidationResultEventSchema,
  graphWorkflowCircuitBreakerEventSchema,
  graphWorkflowSharedDocumentsUpdatedEventSchema,
  graphWorkflowPendingHaltReasonEventSchema,
  graphWorkflowMergeStatusEventSchema,
  graphWorkflowBatchScheduledEventSchema,
]);
export type GraphWorkflowSSEEvent = z.infer<typeof graphWorkflowSseEventSchema>;

export const graphWorkflowExecutionEventSchema = z.object({
  occurredAt: z.string(),
  event: graphWorkflowSseEventSchema,
  preReset: z.boolean().default(false),
});
export type GraphWorkflowExecutionEvent = z.infer<
  typeof graphWorkflowExecutionEventSchema
>;

export const resetExecutionContextRequestSchema = z.object({
  executionId: z.string().trim().min(1),
  contextId: z.string().trim().min(1),
});
export type ResetExecutionContextRequest = z.infer<
  typeof resetExecutionContextRequestSchema
>;

// ============================================================
// Lane Runtime State
// ============================================================

const graphWorkflowLaneTurnUsageSchema = z.object({
  inputTokens: z.number().int().min(0),
  cachedInputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
});
export type GraphWorkflowLaneTurnUsage = z.infer<
  typeof graphWorkflowLaneTurnUsageSchema
>;

export const graphWorkflowLaneStateSchema = z.discriminatedUnion("engine", [
  z.object({
    lane: graphWorkflowLaneKindSchema,
    contextId: z.string().trim().min(1),
    engine: z.literal("claude"),
    workflowConversationId: z.string().trim().min(1).optional(),
    sessionRef: graphWorkflowExecutionSessionRefSchema,
    lastContextTokens: z.number().int().nullable().default(null),
    lastContextWindowMax: z.number().int().nullable().default(null),
    rotateBeforeNextTurn: z.boolean().default(false),
    limitEvaluation: z.enum(["disabled", "supported"]),
    lastUsedAt: z.string(),
  }),
  z.object({
    lane: graphWorkflowLaneKindSchema,
    contextId: z.string().trim().min(1),
    engine: z.literal("codex"),
    workflowConversationId: z.string().trim().min(1).optional(),
    sessionRef: graphWorkflowExecutionSessionRefSchema.optional(),
    lastTurnUsage: graphWorkflowLaneTurnUsageSchema.nullable().default(null),
    rotateBeforeNextTurn: z.boolean().default(false),
    limitEvaluation: z.enum(["disabled", "unsupported"]),
    lastUsedAt: z.string(),
  }),
]);
export type GraphWorkflowLaneState = z.infer<
  typeof graphWorkflowLaneStateSchema
>;

export const graphWorkflowExecutionSchema = z.object({
  id: z.string().trim().min(1),
  seedDefinitionId: z.string().trim().min(1),
  seedDefinitionRevision: z.number().int().min(1),
  workingDefinition: resolvedWorkflowSemanticDefinitionSchema,
  status: graphWorkflowStatusSchema,
  activeContextIds: z.array(z.string()).default([]),
  contextStates: z
    .record(z.string(), graphWorkflowExecutionContextStateSchema)
    .default({}),
  taskStates: z.record(z.string(), graphWorkflowTaskStateSchema).default({}),
  sharedDocuments: z.array(graphWorkflowSharedDocumentEntrySchema).default([]),
  laneStates: z
    .record(z.string(), z.record(z.string(), graphWorkflowLaneStateSchema))
    .default({}),
  machineSnapshot: z.unknown().nullable().default(null),
  history: z.array(graphWorkflowExecutionEventSchema).default([]),
  startedAt: z.string(),
  completedAt: z.string().nullable().default(null),
  haltReason: graphWorkflowHaltReasonSchema.nullable().default(null),
  pendingHaltReason: graphWorkflowHaltReasonSchema.nullable().default(null),
  secondaryHaltReasons: z.array(graphWorkflowHaltReasonSchema).default([]),
  pendingMergeRetry: z.array(z.string().trim().min(1)).default([]),
});
export type GraphWorkflowExecution = z.infer<
  typeof graphWorkflowExecutionSchema
>;

const workflowRuntimeEditAddOperationSchema = z.object({
  type: z.literal("add"),
  contextId: z.string().trim().min(1),
  title: z.string().trim().min(1),
  instructions: z.string().trim().min(1),
  metadata: z.record(z.string(), z.string()).optional(),
});

const workflowRuntimeEditUpdateOperationSchema = z
  .object({
    type: z.literal("update"),
    taskId: z.string().trim().min(1),
    title: z.string().trim().min(1).optional(),
    instructions: z.string().trim().min(1).optional(),
    metadata: z.record(z.string(), z.string()).nullable().optional(),
  })
  .refine(
    (value) =>
      value.title !== undefined ||
      value.instructions !== undefined ||
      value.metadata !== undefined,
    {
      message: "At least one of title, instructions, or metadata is required",
    },
  );

const workflowRuntimeEditRemoveOperationSchema = z.object({
  type: z.literal("remove"),
  taskId: z.string().trim().min(1),
});

const workflowRuntimeEditReorderOperationSchema = z.object({
  type: z.literal("reorder"),
  contextId: z.string().trim().min(1),
  orderedTaskIds: z.array(z.string()).min(1),
});

const workflowRuntimeEditMoveOperationSchema = z.object({
  type: z.literal("move"),
  taskId: z.string().trim().min(1),
  targetContextId: z.string().trim().min(1),
  targetOrder: z.number().int().min(1),
});

export const workflowRuntimeEditOperationSchema = z.discriminatedUnion("type", [
  workflowRuntimeEditAddOperationSchema,
  workflowRuntimeEditUpdateOperationSchema,
  workflowRuntimeEditRemoveOperationSchema,
  workflowRuntimeEditReorderOperationSchema,
  workflowRuntimeEditMoveOperationSchema,
]);
export type WorkflowRuntimeEditOperation = z.infer<
  typeof workflowRuntimeEditOperationSchema
>;

export const workflowRuntimeEditRequestSchema = z.object({
  operations: z.array(workflowRuntimeEditOperationSchema).min(1),
});
export type WorkflowRuntimeEditRequest = z.infer<
  typeof workflowRuntimeEditRequestSchema
>;

export const workflowGraphValidationErrorSchema = z.object({
  code: z.string().trim().min(1),
  message: z.string().trim().min(1),
  contextId: z.string().trim().min(1).optional(),
  taskId: z.string().trim().min(1).optional(),
  edgeId: z.string().trim().min(1).optional(),
  operationIndex: z.number().int().min(0).optional(),
});
export type WorkflowGraphValidationError = z.infer<
  typeof workflowGraphValidationErrorSchema
>;

export const workflowPlanReferenceSchema = z.object({
  filePath: z.string().trim().min(1),
  description: z.string().trim().min(1),
});
export type WorkflowPlanReference = z.infer<typeof workflowPlanReferenceSchema>;

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

// ============================================================
// Reference Documents
// ============================================================

export const referenceDocumentSchema = z.object({
  id: z.string(),
  filePath: z.string(),
  description: z.string(),
  createdAt: z.string(),
});
export type ReferenceDocument = z.infer<typeof referenceDocumentSchema>;

// ============================================================
// Workflow Defaults + Global Config
// (defined after graph workflow schemas so workflowDefaultsSchema can
// reference agent/validator/policy building blocks)
// ============================================================

export const workflowDefaultsSchema = z.object({
  implementer: graphWorkflowAgentConfigSchema,
  contextValidator: graphWorkflowAgentValidatorConfigSchema,
  scriptValidator: graphWorkflowScriptValidatorConfigSchema,
  iterationPolicy: graphWorkflowIterationPolicySchema,
  circuitBreaker: graphWorkflowCircuitBreakerPolicySchema,
  mutability: graphWorkflowMutabilityPolicySchema,
});
export type WorkflowDefaults = z.infer<typeof workflowDefaultsSchema>;

const rawWorkflowDefaultsSchema = z.object({
  implementer: graphWorkflowAgentConfigSchema.optional(),
  contextValidator: graphWorkflowAgentValidatorConfigSchema.optional(),
  scriptValidator: graphWorkflowScriptValidatorConfigSchema.optional(),
  iterationPolicy: graphWorkflowIterationPolicySchema.optional(),
  circuitBreaker: graphWorkflowCircuitBreakerPolicySchema.optional(),
  mutability: graphWorkflowMutabilityPolicySchema.optional(),
});

export const globalConfigSchema = z.object({
  baseDir: z.string(),
  ignorePatterns: z.array(z.string()),
  claudeTimeoutMs: z.number(),
  defaultModel: claudeModelSchema.default("opus"),
  defaultEffort: effortLevelSchema.optional(),
  maxTurns: z.number().int().positive().optional(),
  mergeCheckIntervalMs: z.number().int().positive().optional(),
  preMergeTimeoutMs: z.number().int().positive().optional(),
  maxConcurrentQueries: z.number().int().positive().optional(),
  tailscaleEnabled: z.boolean().optional(),
  pushNotification: pushNotificationConfigSchema.optional(),
  codex: codexConfigSchema.optional(),
  workflowDefaults: workflowDefaultsSchema.optional(),
  idleQuerySessionTtlMs: z.number().int().positive().optional(),
  branchPrefix: z.string().optional(),
  defaultAgentBackend: agentBackendSchema.default("claude"),
});
export type GlobalConfig = z.infer<typeof globalConfigSchema>;

const rawPushTriggerSchema = z.object({
  jobCompleted: z.boolean().optional(),
  waitingForInput: z.boolean().optional(),
  workflowCompleted: z.boolean().optional(),
  workflowHalted: z.boolean().optional(),
  conversationIdle: z.boolean().optional(),
});

const rawPushNotificationConfigSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.enum(["ntfy", "pushover"]).optional(),
  serverUrl: z.string().optional(),
  topic: z.string().optional(),
  triggers: rawPushTriggerSchema.optional(),
});

const rawCodexConfigSchema = z.object({
  enabled: z.boolean().optional(),
  model: z.string().optional(),
  reasoningEffort: codexReasoningEffortSchema.optional(),
  timeout: z.number().positive().nullable().optional(),
});

export const rawGlobalConfigSchema = z.object({
  baseDir: z.string().optional(),
  ignorePatterns: z.array(z.string()).optional(),
  claudeTimeoutMs: z.number().optional(),
  defaultModel: claudeModelSchema.optional(),
  defaultEffort: effortLevelSchema.optional(),
  maxTurns: z.number().int().positive().optional(),
  mergeCheckIntervalMs: z.number().int().positive().optional(),
  preMergeTimeoutMs: z.number().int().positive().optional(),
  maxConcurrentQueries: z.number().int().positive().optional(),
  tailscaleEnabled: z.boolean().optional(),
  pushNotification: rawPushNotificationConfigSchema.optional(),
  codex: rawCodexConfigSchema.optional(),
  workflowDefaults: rawWorkflowDefaultsSchema.optional(),
  idleQuerySessionTtlMs: z.number().int().positive().optional(),
  branchPrefix: z.string().optional(),
  defaultAgentBackend: agentBackendSchema.optional(),
});
export type RawGlobalConfig = z.infer<typeof rawGlobalConfigSchema>;

// ============================================================
// Session & Project State
// ============================================================

export const sessionStateSchema = z.object({
  sessionName: z.string(),
  worktreePath: z.string(),
  branchName: z.string(),
  createdAt: z.string(),
  lastActivityAt: z.string(),
  archived: z.boolean().default(false),
  finished: z.boolean().default(false),
  conversations: z.array(conversationStateSchema).default([]),
  source: sessionSourceSchema.default("cc"),
  objective: z.string().nullable().default(null),
  creationMode: sessionCreationModeSchema.default("fast"),
  tddEnabled: z.boolean().default(true),
  targetBranch: z.string().default("main"),
  parentSessionName: z.string().nullable().default(null),
  graphWorkflowExecution: graphWorkflowExecutionSchema.nullable().default(null),
  graphWorkflowExecutionHistory: z
    .array(graphWorkflowExecutionSchema)
    .default([]),
  referenceDocuments: z.array(referenceDocumentSchema).default([]),
  // Workflow envelope durable persistence for the workflow primitive layer.
  // Stored as opaque records here to avoid pulling primitive-layer schemas into
  // schemas.ts. Validation runs at the WorkflowEnvelopeStore boundary via
  // workflowEnvelopeSchema.parse() in src/lib/workflows/primitives.
  workflowEnvelopes: z.record(z.string(), z.unknown()).optional(),
  // Workflow lane durable persistence for the workflow primitive layer.
  // Stored as opaque records for the same reason as workflowEnvelopes; the
  // LaneStore boundary validates entries with laneStateSchema.
  workflowLanes: z.record(z.string(), z.unknown()).optional(),
  mcpOverrides: mcpOverridesSchema.optional(),
  agentCapabilityOverrides: agentCapabilityOverridesSchema.optional(),
});
export type SessionState = z.infer<typeof sessionStateSchema>;

export const projectStateSchema = z.object({
  rootPath: z.string(),
  sessions: z.record(z.string(), sessionStateSchema),
  mcpOverrides: mcpOverridesSchema.optional(),
  agentCapabilityOverrides: agentCapabilityOverridesSchema.optional(),
});
export type ProjectState = z.infer<typeof projectStateSchema>;

export const projectRowSchema = z.object({
  rootPath: z.string(),
  archived: z.boolean(),
  pinned: z.boolean(),
  pinOrder: z.number().int().nullable(),
  mcpOverrides: mcpOverridesSchema.optional(),
  agentCapabilityOverrides: agentCapabilityOverridesSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProjectRow = z.infer<typeof projectRowSchema>;

export const managerStateSchema = z.object({
  projects: z.record(z.string(), projectStateSchema),
  archivedProjects: z.array(z.string()).default([]),
  pinnedProjects: z.array(z.string()).default([]),
});
export type ManagerState = z.infer<typeof managerStateSchema>;

// ============================================================
// Dev Server Schemas
// ============================================================

export const devServerPortStrategySchema = z.enum([
  "stdout-cc-port",
  "cc-assigned",
]);
export type DevServerPortStrategy = z.infer<typeof devServerPortStrategySchema>;

export const devServerPortConfigSchema = z
  .object({
    strategy: devServerPortStrategySchema.default("cc-assigned"),
    base: z.number().int().min(1).max(65535).optional(),
    range: z.number().int().min(1).max(10000).default(100),
    env: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.strategy === "cc-assigned" && value.base === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["base"],
        message: "port.base is required when strategy is 'cc-assigned'",
      });
    }
    if (value.base !== undefined && value.base + value.range - 1 > 65535) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["range"],
        message:
          "port.base + port.range would exceed the maximum TCP port (65535)",
      });
    }
  });
export type DevServerPortConfig = z.infer<typeof devServerPortConfigSchema>;

export const devServerReadinessTypeSchema = z.enum(["stdout-cc-port", "tcp"]);
export type DevServerReadinessType = z.infer<
  typeof devServerReadinessTypeSchema
>;

export const devServerReadinessConfigSchema = z.object({
  type: devServerReadinessTypeSchema,
  timeoutMs: z.number().int().min(100).max(600_000).optional(),
});
export type DevServerReadinessConfig = z.infer<
  typeof devServerReadinessConfigSchema
>;

export const devServerConfigSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  cwd: z.string().min(1).optional(),
  port: devServerPortConfigSchema.optional(),
  readiness: devServerReadinessConfigSchema.optional(),
});
export type DevServerConfig = z.infer<typeof devServerConfigSchema>;

export const devServerStatusSchema = z.enum([
  "starting",
  "running",
  "stopped",
  "error",
]);
export type DevServerStatus = z.infer<typeof devServerStatusSchema>;

export const devServerSourceSchema = z.enum(["cc-started", "external-adopted"]);
export type DevServerSource = z.infer<typeof devServerSourceSchema>;

export const devServerStatusEventSchema = z.object({
  type: z.literal("dev-server-status"),
  projectName: z.string(),
  sessionName: z.string(),
  serverName: z.string(),
  status: devServerStatusSchema,
  port: z.number().nullable(),
  remoteUrl: z.string().nullable(),
  errorMessage: z.string().nullable(),
  source: devServerSourceSchema.nullable().default(null),
  ownedByThisSession: z.boolean().default(false),
  worktreePath: z.string().nullable().default(null),
  ownerPid: z.number().int().nullable().default(null),
});
export type DevServerStatusEvent = z.infer<typeof devServerStatusEventSchema>;

export const devServerRuntimeStateSchema = z.object({
  serverName: z.string(),
  command: z.string(),
  status: devServerStatusSchema,
  port: z.number().nullable(),
  remoteUrl: z.string().nullable(),
  startedAt: z.string().nullable(),
  errorMessage: z.string().nullable(),
  recentOutput: z.array(z.string()),
  source: devServerSourceSchema.nullable().default(null),
  ownedByThisSession: z.boolean().default(false),
  worktreePath: z.string().nullable().default(null),
  ownerPid: z.number().int().nullable().default(null),
});
export type DevServerRuntimeState = z.infer<typeof devServerRuntimeStateSchema>;

export const devServersStatusResponseSchema = z.object({
  servers: z.array(devServerRuntimeStateSchema),
});
export type DevServersStatusResponse = z.infer<
  typeof devServersStatusResponseSchema
>;

// ============================================================
// Per-Repo Config
// ============================================================

export const perRepoConfigSchema = z.object({
  initScriptPath: z.string().nullable().optional(),
  preMergeCommand: z.string().nullable().optional(),
  preMergeTimeoutMs: z.number().int().positive().optional(),
  devServers: z.array(devServerConfigSchema).optional(),
  branchPrefix: z.string().optional(),
});
export type PerRepoConfig = z.infer<typeof perRepoConfigSchema>;

// ============================================================
// API Request Schemas
// ============================================================

export const imageMediaTypeSchema = z.enum([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
export type ImageMediaType = z.infer<typeof imageMediaTypeSchema>;

export const imagePayloadSchema = z.object({
  attachmentId: z.string().min(1),
  mediaType: imageMediaTypeSchema,
  base64Data: z.string().min(1),
  inlineMarkerIndex: z.number().int().positive().optional(),
});
export type ImagePayload = z.infer<typeof imagePayloadSchema>;

export const createSessionRequestSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("fast"),
    sessionName: z.string().trim().min(1),
    tddEnabled: z.boolean().optional(),
    parentSessionName: z.string().trim().min(1).optional(),
  }),
  z.object({
    mode: z.literal("focus"),
    objective: z.string().trim().min(1),
    tddEnabled: z.boolean().optional(),
    parentSessionName: z.string().trim().min(1).optional(),
  }),
  z.object({
    mode: z.literal("optimistic"),
    instructions: z.string().trim().min(1),
    images: z.array(imagePayloadSchema).max(5).optional(),
    tddEnabled: z.boolean().optional(),
    parentSessionName: z.string().trim().min(1).optional(),
  }),
]);
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const runPromptRequestSchema = z
  .object({
    prompt: z.string().trim(),
    modelId: z.string().trim().min(1).optional(),
    effort: z.string().trim().min(1).optional(),
    images: z.array(imagePayloadSchema).max(5).optional(),
    backend: agentBackendSchema.optional(),
    collab: z
      .object({
        negotiationRounds: z.number().int().min(1).max(20).optional(),
        autonomousResolutionThreshold: z
          .enum(["none", "minor", "major", "blocking"])
          .optional(),
      })
      .optional(),
  })
  .refine(
    (data) => data.prompt.length > 0 || (data.images && data.images.length > 0),
    { message: "Either prompt text or at least one image is required" },
  );
export type RunPromptRequest = z.infer<typeof runPromptRequestSchema>;

export const commitRequestSchema = z.object({
  message: z.string().trim().min(1),
});
export type CommitRequest = z.infer<typeof commitRequestSchema>;

export const sessionArchiveRequestSchema = z.object({
  archived: z.boolean(),
});
export type SessionArchiveRequest = z.infer<typeof sessionArchiveRequestSchema>;

export const sessionTddRequestSchema = z.object({
  tddEnabled: z.boolean(),
});
export type SessionTddRequest = z.infer<typeof sessionTddRequestSchema>;

export const renameConversationRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
});
export type RenameConversationRequest = z.infer<
  typeof renameConversationRequestSchema
>;

export const forkRequestSchema = z.object({
  messageIndex: z.number().int().min(0),
});
export type ForkRequest = z.infer<typeof forkRequestSchema>;

export const forkResponseSchema = z.object({
  conversationId: z.string(),
  name: z.string(),
  forkMode: z.enum(["native", "synthetic"]).nullable(),
});
export type ForkResponse = z.infer<typeof forkResponseSchema>;

export const pendingPromptRequestSchema = z.object({
  text: z.string().nullable(),
});
export type PendingPromptRequest = z.infer<typeof pendingPromptRequestSchema>;

export const debugModeRequestSchema = z.object({
  action: z.enum([
    "enter",
    "exit",
    "mark_reproduced",
    "mark_fix_verified",
    "mark_fix_failed",
    "revert_to_awaiting_reproduction",
    "revert_to_awaiting_verification",
    "retry_turn",
  ]),
});
export type DebugModeRequest = z.infer<typeof debugModeRequestSchema>;

export const debugRecordingRequestSchema = z.object({
  recording: z.boolean(),
});
export type DebugRecordingRequest = z.infer<typeof debugRecordingRequestSchema>;

// ============================================================
// Git Operations Schemas
// ============================================================

export const commitLogEntrySchema = z.object({
  hash: z.string(),
  fullHash: z.string(),
  message: z.string(),
  date: z.string(),
  filesChanged: z.number(),
});
export type CommitLogEntry = z.infer<typeof commitLogEntrySchema>;

// ============================================================
// SSE Event Schemas
// ============================================================

export const conversationStatusEventSchema = z.object({
  type: z.literal("conversation-status"),
  projectName: z.string(),
  sessionName: z.string(),
  conversationId: z.string(),
  status: z.enum(["running", "awaiting", "waiting_for_input"]),
  error: z.string().optional(),
});
export type ConversationStatusEvent = z.infer<
  typeof conversationStatusEventSchema
>;

export const messageAppendedEventSchema = z.object({
  type: z.literal("message-appended"),
  projectName: z.string(),
  sessionName: z.string(),
  conversationId: z.string(),
  seq: z.number().int().nonnegative(),
  message: transcriptMessageSchema,
});
export type MessageAppendedEvent = z.infer<typeof messageAppendedEventSchema>;

export const messageUpdatedEventSchema = z.object({
  type: z.literal("message-updated"),
  projectName: z.string(),
  sessionName: z.string(),
  conversationId: z.string(),
  seq: z.number().int().nonnegative(),
  message: transcriptMessageSchema,
});
export type MessageUpdatedEvent = z.infer<typeof messageUpdatedEventSchema>;

export const conversationCreatedEventSchema = z.object({
  type: z.literal("conversation-created"),
  projectName: z.string(),
  sessionName: z.string(),
  conversation: conversationStateSchema,
});
export type ConversationCreatedEvent = z.infer<
  typeof conversationCreatedEventSchema
>;

export const conversationRenamedEventSchema = z.object({
  type: z.literal("conversation-renamed"),
  projectName: z.string(),
  sessionName: z.string(),
  conversationId: z.string(),
  name: z.string().nullable(),
});
export type ConversationRenamedEvent = z.infer<
  typeof conversationRenamedEventSchema
>;

export const conversationArchivedEventSchema = z.object({
  type: z.literal("conversation-archived"),
  projectName: z.string(),
  sessionName: z.string(),
  conversationId: z.string(),
  archived: z.boolean(),
});
export type ConversationArchivedEvent = z.infer<
  typeof conversationArchivedEventSchema
>;

// ============================================================
// AskUserQuestion Event Schemas
// ============================================================

export const askQuestionEventSchema = z.object({
  type: z.literal("ask-question"),
  projectName: z.string(),
  sessionName: z.string(),
  conversationId: z.string(),
  questionId: z.string(),
  questions: z.array(askQuestionItemSchema),
});
export type AskQuestionEvent = z.infer<typeof askQuestionEventSchema>;

export const answerQuestionRequestSchema = z.object({
  questionId: z.string(),
  answers: z.record(z.string(), z.string()),
});
export type AnswerQuestionRequest = z.infer<typeof answerQuestionRequestSchema>;

// ============================================================
// Background Job Schemas
// ============================================================

export const jobTypeSchema = z.enum(["commit", "merge", "resolve-conflicts"]);
export type JobType = z.infer<typeof jobTypeSchema>;

export const jobStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "conflicts",
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const backgroundJobSchema = z.object({
  jobId: z.string(),
  jobType: jobTypeSchema,
  status: jobStatusSchema,
  projectName: z.string(),
  sessionName: z.string(),
  branchName: z.string(),
  targetBranch: z.string().optional(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  mergeHash: z.string().optional(),
  commitHash: z.string().optional(),
  conflictCount: z.number().optional(),
  conflictFiles: z.array(z.string()).optional(),
  errorMessage: z.string().optional(),
  phase: z.string().optional(),
});
export type BackgroundJob = z.infer<typeof backgroundJobSchema>;

export const jobStatusEventSchema = z.object({
  type: z.literal("job-status"),
  jobType: jobTypeSchema,
  status: jobStatusSchema,
  projectName: z.string(),
  sessionName: z.string(),
  jobId: z.string(),
  branchName: z.string(),
  mergeHash: z.string().optional(),
  commitHash: z.string().optional(),
  conflictCount: z.number().optional(),
  conflictFiles: z.array(z.string()).optional(),
  errorMessage: z.string().optional(),
  phase: z.string().optional(),
});
export type JobStatusEvent = z.infer<typeof jobStatusEventSchema>;

export const jobDispatchResponseSchema = z.object({
  jobId: z.string(),
  jobType: jobTypeSchema,
  branchName: z.string(),
  startedAt: z.string(),
});
export type JobDispatchResponse = z.infer<typeof jobDispatchResponseSchema>;

export const smartMergeRequestSchema = z.object({
  autoResolve: z.boolean(),
});
export type SmartMergeRequest = z.infer<typeof smartMergeRequestSchema>;

export const conflictEntrySchema = z.object({
  file: z.string(),
  description: z.string(),
  resolution: z.string(),
  rationale: z.string(),
});
export type ConflictEntry = z.infer<typeof conflictEntrySchema>;

export const conflictDecisionInputSchema = z.object({
  file: z.string(),
  decision: z.enum(["approved", "rejected", "pending"]),
  feedback: z.string().optional(),
});
export type ConflictDecisionInput = z.infer<typeof conflictDecisionInputSchema>;

export const resolveConflictsRequestSchema = z.object({
  decisions: z.array(conflictDecisionInputSchema).optional(),
});
export type ResolveConflictsRequest = z.infer<
  typeof resolveConflictsRequestSchema
>;

export const sessionFinishedEventSchema = z.object({
  type: z.literal("session-finished"),
  projectName: z.string(),
  sessionName: z.string(),
  branchName: z.string(),
  detectionMethod: z.enum(["ancestor", "commit-message"]),
});
export type SessionFinishedEvent = z.infer<typeof sessionFinishedEventSchema>;

// ============================================================
// Notification Schemas
// ============================================================

export const notificationTypeSchema = z.enum([
  "merge-completed",
  "merge-failed",
  "merge-conflicts",
  "commit-completed",
  "commit-failed",
  "resolve-completed",
  "resolve-failed",
]);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

export const notificationSchema = z.object({
  id: z.string(),
  type: notificationTypeSchema,
  title: z.string(),
  message: z.string(),
  read: z.boolean(),
  projectName: z.string(),
  sessionName: z.string(),
  branchName: z.string(),
  jobId: z.string(),
  jobType: jobTypeSchema,
  mergeHash: z.string().optional(),
  commitHash: z.string().optional(),
  conflictCount: z.number().optional(),
  conflictFiles: z.array(z.string()).optional(),
  targetBranch: z.string().optional(),
  errorMessage: z.string().optional(),
  createdAt: z.string(),
});
export type Notification = z.infer<typeof notificationSchema>;

export const notificationCreatedEventSchema = z.object({
  type: z.literal("notification-created"),
  notification: notificationSchema,
});
export type NotificationCreatedEvent = z.infer<
  typeof notificationCreatedEventSchema
>;

export const notificationUpdatedEventSchema = z.object({
  type: z.literal("notification-updated"),
  id: z.string(),
  read: z.boolean(),
});
export type NotificationUpdatedEvent = z.infer<
  typeof notificationUpdatedEventSchema
>;

export const getNotificationsQuerySchema = z.object({
  unread: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type GetNotificationsQuery = z.infer<typeof getNotificationsQuerySchema>;

export const notificationsResponseSchema = z.object({
  notifications: z.array(notificationSchema),
  total: z.number(),
  unreadCount: z.number(),
});
export type NotificationsResponse = z.infer<typeof notificationsResponseSchema>;

export const markReadRequestSchema = z.object({
  read: z.literal(true),
});
export type MarkReadRequest = z.infer<typeof markReadRequestSchema>;

export const messageQueuedEventSchema = z.object({
  type: z.literal("message-queued"),
  projectName: z.string(),
  sessionName: z.string(),
  conversationId: z.string(),
  text: z.string(),
});
export type MessageQueuedEvent = z.infer<typeof messageQueuedEventSchema>;

// ============================================================
// Debug Mode SSE Event Schemas
// ============================================================

export const debugModeStatusEventSchema = z.object({
  type: z.literal("debug-mode-status"),
  projectName: z.string(),
  sessionName: z.string(),
  conversationId: z.string(),
  active: z.boolean(),
  recording: z.boolean(),
});
export type DebugModeStatusEvent = z.infer<typeof debugModeStatusEventSchema>;

export const debugLogReceivedEventSchema = z.object({
  type: z.literal("debug-log-received"),
  projectName: z.string(),
  sessionName: z.string(),
  conversationId: z.string(),
  entryCount: z.number(),
});
export type DebugLogReceivedEvent = z.infer<typeof debugLogReceivedEventSchema>;

// ============================================================
// MCP Live-Update SSE Event Schemas
// ============================================================

// `.strict()` below enforces Requirement 11's privacy constraint at the schema
// boundary: the SSE payload must never carry server or tool configuration
// contents — only identifiers, changed server keys, and the effective config
// hash or config signature.

export const mcpConfigUpdatedEventSchema = z
  .object({
    type: z.literal("mcp-config-updated"),
    level: mcpConfigLevelSchema,
    projectName: z.string().optional(),
    sessionName: z.string().optional(),
    conversationId: z.string().optional(),
    changedServerKeys: z.array(z.string()),
    effectiveConfigHash: z.string(),
  })
  .strict();
export type McpConfigUpdatedEvent = z.infer<typeof mcpConfigUpdatedEventSchema>;

export const mcpToolsUpdatedEventSchema = z
  .object({
    type: z.literal("mcp-tools-updated"),
    level: mcpConfigLevelSchema,
    projectName: z.string().optional(),
    sessionName: z.string().optional(),
    conversationId: z.string().optional(),
    serverKey: z.string(),
  })
  .strict();
export type McpToolsUpdatedEvent = z.infer<typeof mcpToolsUpdatedEventSchema>;

// ============================================================
// Scoped Status SSE Event (StatusBus → SSE bridge)
// ============================================================

/**
 * Generic scoped-status SSE event used by primitive-native workflows
 * (Collaboration Mode and any future workflow built directly on the
 * primitive layer) to bridge in-process `StatusBus` envelopes onto the
 * shared session SSE wire without each feature having to define its
 * own typed SSE event.
 *
 * Contract:
 *  - `scope` identifies the feature family the envelope belongs to
 *    (`"collaboration"`, `"workflow"`, etc.). New scopes are additive
 *    and do not require schema changes — clients filter by the scope
 *    field at runtime.
 *  - `scopeId` is the durable workflow identifier within that scope
 *    (e.g. the collaboration `workflowId`).
 *  - `status` is the StatusBus lifecycle status mapped to one of the
 *    four canonical states.
 *  - `payload` is the original feature-defined envelope payload, kept
 *    `unknown` so each feature can evolve its own internal shape
 *    without redefining the SSE wire contract.
 *  - `reason` is an optional short tag describing why the envelope was
 *    published (e.g. `"max_iterations_exceeded"`); useful for surface
 *    UI without parsing the payload.
 */
export const scopedStatusEventSchema = z.object({
  type: z.literal("scoped-status"),
  scope: z.string().min(1),
  scopeId: z.string().min(1),
  status: z.enum(["running", "paused", "completed", "failed"]),
  timestamp: z.string().min(1),
  projectName: z.string(),
  sessionName: z.string(),
  payload: z.unknown().optional(),
  reason: z.string().optional(),
});
export type ScopedStatusEvent = z.infer<typeof scopedStatusEventSchema>;

/** SSE event type */
export type SSEEvent =
  | ConversationStatusEvent
  | MessageAppendedEvent
  | MessageUpdatedEvent
  | ConversationCreatedEvent
  | ConversationRenamedEvent
  | ConversationArchivedEvent
  | AskQuestionEvent
  | JobStatusEvent
  | SessionFinishedEvent
  | NotificationCreatedEvent
  | NotificationUpdatedEvent
  | MessageQueuedEvent
  | GraphWorkflowStatusEvent
  | GraphWorkflowContextStatusEvent
  | GraphWorkflowTaskStatusEvent
  | GraphWorkflowValidationResultEvent
  | GraphWorkflowCircuitBreakerEvent
  | GraphWorkflowSharedDocumentsUpdatedEvent
  | GraphWorkflowPendingHaltReasonEvent
  | GraphWorkflowMergeStatusEvent
  | GraphWorkflowBatchScheduledEvent
  | DevServerStatusEvent
  | DebugModeStatusEvent
  | DebugLogReceivedEvent
  | McpConfigUpdatedEvent
  | McpToolsUpdatedEvent
  | AgentCapabilitiesUpdatedEvent
  | AgentCapabilitiesDiscoveryUpdatedEvent
  | ScopedStatusEvent;

// ============================================================
// Command Autocomplete Schemas
// ============================================================

export const commandTypeSchema = z.enum(["command", "skill"]);
export type CommandType = z.infer<typeof commandTypeSchema>;

export const commandItemSchema = z.object({
  name: z.string(),
  description: z.string(),
  argumentHint: z.string().optional(),
  type: commandTypeSchema,
  source: z.string(),
});
export type CommandItem = z.infer<typeof commandItemSchema>;

export const commandsResponseSchema = z.object({
  items: z.array(commandItemSchema),
});
export type CommandsResponse = z.infer<typeof commandsResponseSchema>;

// ============================================================
// File Autocomplete Schemas
// ============================================================

export const fileItemSchema = z.object({
  path: z.string(),
});
export type FileItem = z.infer<typeof fileItemSchema>;

export const projectFilesResponseSchema = z.object({
  items: z.array(fileItemSchema),
  truncated: z.boolean(),
  scannedCount: z.number().int().nonnegative(),
});
export type ProjectFilesResponse = z.infer<typeof projectFilesResponseSchema>;

// ============================================================
// Collaboration Mode — asymmetric artifact contract
// ============================================================

// Source of truth: memory-bank/COLLABORATION_MODE_FLOW.md §"Agent output
// contract". The primary (agent_one) and secondary (agent_two) agents emit
// kind-discriminated artifact records (initial_draft, cross_review,
// proposed_changes, counter_proposal, resolution_decision, final_answer,
// open_conflicts). Convergence and routing are decided by the orchestrator
// from the resolution_decision artifact, not by the agent narrative.

export const collaborationDisagreementSeveritySchema = z.enum([
  "minor",
  "major",
  "blocking",
]);
export type CollaborationDisagreementSeverity = z.infer<
  typeof collaborationDisagreementSeveritySchema
>;

export const collaborationFlowAgentSchema = z.enum(["agent_one", "agent_two"]);
export type CollaborationFlowAgent = z.infer<
  typeof collaborationFlowAgentSchema
>;

export const collaborationDisagreementCategorySchema = z.enum([
  "objective",
  "implementation",
]);
export type CollaborationDisagreementCategory = z.infer<
  typeof collaborationDisagreementCategorySchema
>;

export const collaborationAutonomousResolutionThresholdSchema = z.enum([
  "none",
  "minor",
  "major",
  "blocking",
]);
export type CollaborationAutonomousResolutionThreshold = z.infer<
  typeof collaborationAutonomousResolutionThresholdSchema
>;

export const collaborationReferenceSchema = z
  .object({
    artifact: z.string().min(1),
    locator: z.string().min(1).optional(),
  })
  .strict();
export type CollaborationReference = z.infer<
  typeof collaborationReferenceSchema
>;

export const collaborationArtifactAgreementSchema = z
  .object({
    id: z.string().min(1),
    claim: z.string().min(1),
    ref: collaborationReferenceSchema.optional(),
  })
  .strict();
export type CollaborationArtifactAgreement = z.infer<
  typeof collaborationArtifactAgreementSchema
>;

export const collaborationArtifactDisagreementSchema = z
  .object({
    id: z.string().min(1),
    category: collaborationDisagreementCategorySchema,
    severity: collaborationDisagreementSeveritySchema,
    claim: z.string().min(1),
    reason: z.string().min(1),
    proposedResolution: z.string().min(1).optional(),
    ref: collaborationReferenceSchema.optional(),
  })
  .strict();
export type CollaborationArtifactDisagreement = z.infer<
  typeof collaborationArtifactDisagreementSchema
>;

export const collaborationUserQuestionSchema = z
  .object({
    id: z.string().min(1),
    question: z.string().min(1),
    relatedDisagreementIds: z.array(z.string().min(1)),
  })
  .strict();
export type CollaborationUserQuestion = z.infer<
  typeof collaborationUserQuestionSchema
>;

export const collaborationReviseSelfArtifactSchema = z
  .object({
    change: z.string().min(1),
    because: z.string().min(1),
  })
  .strict();
export type CollaborationReviseSelfArtifact = z.infer<
  typeof collaborationReviseSelfArtifactSchema
>;

export const collaborationChangeProposalSchema = z
  .object({
    id: z.string().min(1),
    change: z.string().min(1),
    rationale: z.string().min(1),
    addressesDisagreementIds: z.array(z.string().min(1)),
  })
  .strict();
export type CollaborationChangeProposal = z.infer<
  typeof collaborationChangeProposalSchema
>;

export const collaborationInitialDraftOutputSchema = z
  .object({
    kind: z.literal("initial_draft"),
    agent: collaborationFlowAgentSchema,
    narrative: z.string().min(1),
    report: z.string().min(1),
    supporting: z.array(z.string().min(1)),
    assumptions: z.array(z.string().min(1)),
    keyClaims: z.array(collaborationArtifactAgreementSchema),
  })
  .strict();
export type CollaborationInitialDraftOutput = z.infer<
  typeof collaborationInitialDraftOutputSchema
>;

export const collaborationCrossReviewOutputSchema = z
  .object({
    kind: z.literal("cross_review"),
    agent: collaborationFlowAgentSchema,
    targetAgent: collaborationFlowAgentSchema,
    narrative: z.string().min(1),
    report: z.string().min(1),
    supporting: z.array(z.string().min(1)),
    agree: z.array(collaborationArtifactAgreementSchema),
    disagree: z.array(collaborationArtifactDisagreementSchema),
    reviseSelf: z.array(collaborationReviseSelfArtifactSchema),
  })
  .strict();
export type CollaborationCrossReviewOutput = z.infer<
  typeof collaborationCrossReviewOutputSchema
>;

export const collaborationProposedChangesOutputSchema = z
  .object({
    kind: z.literal("proposed_changes"),
    agent: z.literal("agent_one"),
    targetAgent: z.literal("agent_two"),
    narrative: z.string().min(1),
    acceptedFromAgentTwoDraft: z.array(collaborationArtifactAgreementSchema),
    proposedChanges: z.array(collaborationChangeProposalSchema),
    remainingDisagreements: z.array(collaborationArtifactDisagreementSchema),
    report: z.string().min(1),
    supporting: z.array(z.string().min(1)),
  })
  .strict();
export type CollaborationProposedChangesOutput = z.infer<
  typeof collaborationProposedChangesOutputSchema
>;

export const collaborationCounterProposalOutputSchema = z
  .object({
    kind: z.literal("counter_proposal"),
    agent: z.literal("agent_two"),
    narrative: z.string().min(1),
    acceptedProposedChangeIds: z.array(z.string().min(1)),
    rejectedProposedChangeIds: z.array(z.string().min(1)),
    alternativeChanges: z.array(collaborationChangeProposalSchema),
    agree: z.array(collaborationArtifactAgreementSchema),
    disagree: z.array(collaborationArtifactDisagreementSchema),
    report: z.string().min(1),
    supporting: z.array(z.string().min(1)),
  })
  .strict();
export type CollaborationCounterProposalOutput = z.infer<
  typeof collaborationCounterProposalOutputSchema
>;

export const collaborationResolutionDecisionNextActionSchema = z.enum([
  "final",
  "continue_negotiation",
  "ask_user",
  "fail",
]);
export type CollaborationResolutionDecisionNextAction = z.infer<
  typeof collaborationResolutionDecisionNextActionSchema
>;

export const collaborationResolvedDisagreementSchema = z
  .object({
    disagreementId: z.string().min(1),
    resolution: z.string().min(1),
    resolvedAutonomously: z.boolean(),
    rationale: z.string().min(1),
  })
  .strict();
export type CollaborationResolvedDisagreement = z.infer<
  typeof collaborationResolvedDisagreementSchema
>;

export const collaborationResolutionDecisionOutputSchema = z
  .object({
    kind: z.literal("resolution_decision"),
    agent: z.literal("agent_one"),
    agreementReached: z.boolean(),
    nextAction: collaborationResolutionDecisionNextActionSchema,
    acceptedPoints: z.array(collaborationArtifactAgreementSchema),
    resolvedDisagreements: z.array(collaborationResolvedDisagreementSchema),
    remainingDisagreements: z.array(collaborationArtifactDisagreementSchema),
    userQuestions: z.array(collaborationUserQuestionSchema),
    rationale: z.string().min(1),
  })
  .strict();
export type CollaborationResolutionDecisionOutput = z.infer<
  typeof collaborationResolutionDecisionOutputSchema
>;

export const collaborationOpenConflictsOutputSchema = z
  .object({
    kind: z.literal("open_conflicts"),
    disagreements: z.array(collaborationArtifactDisagreementSchema),
    questions: z.array(collaborationUserQuestionSchema),
  })
  .strict();
export type CollaborationOpenConflictsOutput = z.infer<
  typeof collaborationOpenConflictsOutputSchema
>;

export const collaborationFinalAnswerOutputSchema = z
  .object({
    kind: z.literal("final_answer"),
    agent: z.literal("agent_one"),
    answer: z.string().min(1),
    report: z.string().min(1),
    supporting: z.array(z.string().min(1)),
  })
  .strict();
export type CollaborationFinalAnswerOutput = z.infer<
  typeof collaborationFinalAnswerOutputSchema
>;

export const collaborationArtifactSchema = z.discriminatedUnion("kind", [
  collaborationInitialDraftOutputSchema,
  collaborationCrossReviewOutputSchema,
  collaborationProposedChangesOutputSchema,
  collaborationCounterProposalOutputSchema,
  collaborationResolutionDecisionOutputSchema,
  collaborationOpenConflictsOutputSchema,
  collaborationFinalAnswerOutputSchema,
]);
export type CollaborationArtifact = z.infer<typeof collaborationArtifactSchema>;
