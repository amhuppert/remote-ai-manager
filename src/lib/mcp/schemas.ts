import { conversationTargetSchema } from "@/lib/conversations/conversation-target";
import { z } from "zod";
import { agentBackendSchema } from "@/lib/shared/schemas";
import { registerTrustedSchema } from "@/lib/shared/parse-trusted";

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

const mcpDefinitionScopeSchema = z.enum(["global", "project"]);
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
  "deferred_to_next_conversation",
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

export const mcpServerOverrideSchema = z.object({
  enabled: z.boolean().optional(),
  tools: z.record(z.string(), mcpToolOverrideSchema).optional(),
});
export type McpServerOverride = z.infer<typeof mcpServerOverrideSchema>;

export const mcpOverridesSchema = registerTrustedSchema(
  z.object({
    servers: z.record(z.string(), mcpServerOverrideSchema),
  }),
  "mcpOverridesSchema",
);
export type McpOverrides = z.infer<typeof mcpOverridesSchema>;

export const mcpGlobalStateSchema = z.object({
  version: z.literal(1),
  overrides: mcpOverridesSchema,
  updatedAt: z.string(),
});

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

const mcpSourceRefSchema = z.object({
  scope: mcpDefinitionScopeSchema,
  filePath: z.string(),
});
export type McpSourceRef = z.infer<typeof mcpSourceRefSchema>;

const mcpDiagnosticSchema = z.object({
  severity: z.enum(["info", "warning", "error"]),
  code: z.string(),
  message: z.string(),
  serverKey: z.string().optional(),
  sourceRef: mcpSourceRefSchema.optional(),
});
export type McpDiagnostic = z.infer<typeof mcpDiagnosticSchema>;

const mcpServerCompatibilityViewSchema = z.object({
  backends: z.array(
    z.object({
      backend: agentBackendSchema,
      supported: z.boolean(),
      reason: z.string().optional(),
      notes: z.array(z.string()).optional(),
      toolControl: z
        .object({
          configurable: z.boolean(),
          notes: z.array(z.string()),
          applyTiming: z.enum(["next-turn", "next-conversation"]).optional(),
        })
        .optional(),
    }),
  ),
});
export type McpServerCompatibilityView = z.infer<
  typeof mcpServerCompatibilityViewSchema
>;

const mcpToolViewSchema = z.object({
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

const mcpToolListViewSchema = z.object({
  state: toolDiscoveryStateSchema,
  tools: z.array(mcpToolViewSchema),
  diagnostics: z.array(mcpDiagnosticSchema),
  refreshedAt: z.string().optional(),
});
export type McpToolListView = z.infer<typeof mcpToolListViewSchema>;

const mcpServerViewSchema = z.object({
  serverKey: z.string(),
  displayName: z.string(),
  nativeId: z.string(),
  transport: mcpTransportSchema,
  compatibility: mcpServerCompatibilityViewSchema.optional(),
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
  target: conversationTargetSchema.optional(),
  backend: agentBackendSchema.optional(),
  runtime: mcpRuntimeApplicationStateSchema.optional(),
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

const mcpDiscoveredToolSchema = z.object({
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
    target: conversationTargetSchema.optional(),
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
    target: conversationTargetSchema.optional(),
    serverKey: z.string(),
  })
  .strict();
export type McpToolsUpdatedEvent = z.infer<typeof mcpToolsUpdatedEventSchema>;
