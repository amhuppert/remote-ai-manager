import {
  agentCapabilityCascadeKindSchema,
  type AgentCapabilityCascadeKind,
  agentCapabilityDiscoverySupportSchema,
} from "@/lib/agent-backends/capability-catalog";
export {
  AGENT_CAPABILITY_CASCADE_KINDS,
  agentCapabilityCascadeKindSchema,
  type AgentCapabilityCascadeKind,
  type AgentCapabilityDiscoverySupport,
} from "@/lib/agent-backends/capability-catalog";
import {
  agentCapabilityCapabilityKindSchema,
  agentCapabilityRuntimeVisibilitySchema,
  agentCapabilitySourceRefSchema,
  agentCapabilityNativeDefaultSchema,
  agentCapabilityDiscoveredItemSchema,
  agentCapabilityControlSupportSchema,
} from "@/lib/agent-backends/capability-catalog";
export {
  agentCapabilityCapabilityKindSchema,
  type AgentCapabilityKind,
  agentCapabilityRuntimeVisibilitySchema,
  type AgentCapabilityRuntimeVisibility,
  agentCapabilitySourceRefSchema,
  type AgentCapabilitySourceRef,
  agentCapabilityNativeDefaultSchema,
  type AgentCapabilityNativeDefault,
  agentCapabilityDiscoveredItemSchema,
  type AgentCapabilityDiscoveredItem,
} from "@/lib/agent-backends/capability-catalog";
import { z } from "zod";
import { commandItemSchema } from "@/lib/commands/schemas";

import { registerTrustedSchema } from "@/lib/shared/parse-trusted";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import { agentBackendSchema, type AgentBackendId } from "@/lib/shared/schemas";
import {
  capabilityKindSchema,
  type CapabilityKind,
} from "@/lib/agent-backends/descriptor";

// ============================================================
// Agent Capability Configuration Schemas
//
// Persistent override storage, runtime apply state, API view/patch contracts,
// and SSE event payloads for backend-specific capability cascades.
// These schemas are the single source of truth shared by override stores,
// resolvers, API routes, and UI hooks.
// ============================================================

// ============================================================
// In-memory cascade taxonomy: { backend, kind }
//
// The persisted representation uses the strings above.
// This bijective codec is the only translation
// point; an unknown pair or string fails loudly instead of being coerced.
// ============================================================

export const agentCapabilityCascadeRefSchema = z
  .object({
    backend: agentBackendSchema,
    kind: capabilityKindSchema,
  })
  .superRefine((value, ctx) => {
    const encoded = `${value.backend}-${value.kind}`;
    if (!agentCapabilityCascadeKindSchema.safeParse(encoded).success) {
      ctx.addIssue({
        code: "custom",
        message: `backend '${value.backend}' does not support capability kind '${value.kind}'`,
        path: ["kind"],
      });
    }
  });
export type AgentCapabilityCascadeRef = z.infer<
  typeof agentCapabilityCascadeRefSchema
>;

export function encodeCascadeKind(
  ref: AgentCapabilityCascadeRef,
): AgentCapabilityCascadeKind {
  const parsedRef = agentCapabilityCascadeRefSchema.parse(ref);
  return agentCapabilityCascadeKindSchema.parse(
    `${parsedRef.backend}-${parsedRef.kind}`,
  );
}

export function decodeCascadeKind(value: string): AgentCapabilityCascadeRef {
  const cascadeKind = agentCapabilityCascadeKindSchema.parse(value);
  const separator = cascadeKind.indexOf("-");
  const backend = agentBackendSchema.parse(cascadeKind.slice(0, separator));
  const kind: CapabilityKind = capabilityKindSchema.parse(
    cascadeKind.slice(separator + 1),
  );
  return { backend, kind };
}

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
  "cursor-skills": "cursor",
  "cursor-plugins": "cursor",
  "cursor-agents": "cursor",
};

function requireAgentCapabilityCascadeBackendOwnership(
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

function validatePublicSessionName(
  value: { sessionName?: string },
  ctx: z.RefinementCtx,
): void {
  if (value.sessionName !== PROJECT_CONVERSATION_SESSION_SENTINEL) return;
  ctx.addIssue({
    code: "custom",
    message:
      "reserved internal project-conversation identity cannot be used as a public session name",
    path: ["sessionName"],
  });
}

function validateAgentCapabilityScopeIdentity(
  value: {
    level?: AgentCapabilityCascadeLayer;
    projectName?: string;
    conversationScope?: AgentCapabilityConversationScope;
    sessionName?: string;
    conversationId?: string;
  },
  ctx: z.RefinementCtx,
): void {
  validatePublicSessionName(value, ctx);

  if (value.level === "conversation" && value.conversationScope === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "conversation scope requires conversationScope",
      path: ["conversationScope"],
    });
  }

  if (value.conversationScope === undefined) return;

  if (value.level !== "conversation") {
    ctx.addIssue({
      code: "custom",
      message: "conversationScope is only valid for conversation scope",
      path: ["conversationScope"],
    });
    return;
  }

  if (!value.projectName) {
    ctx.addIssue({
      code: "custom",
      message: "conversation scope requires projectName",
      path: ["projectName"],
    });
  }

  if (!value.conversationId) {
    ctx.addIssue({
      code: "custom",
      message: "conversation scope requires conversationId",
      path: ["conversationId"],
    });
  }

  if (value.conversationScope === "session" && !value.sessionName) {
    ctx.addIssue({
      code: "custom",
      message: "session conversation scope requires sessionName",
      path: ["sessionName"],
    });
  }

  if (value.conversationScope === "project" && value.sessionName) {
    ctx.addIssue({
      code: "custom",
      message: "project conversation scope must not include sessionName",
      path: ["sessionName"],
    });
  }
}

export const agentCapabilityCascadeLayerSchema = z.enum([
  "global",
  "project",
  "session",
  "conversation",
]);
export type AgentCapabilityCascadeLayer = z.infer<
  typeof agentCapabilityCascadeLayerSchema
>;

export const agentCapabilityConversationScopeSchema = z.enum([
  "session",
  "project",
]);
export type AgentCapabilityConversationScope = z.infer<
  typeof agentCapabilityConversationScopeSchema
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

const agentCapabilityApplySemanticsSchema = z.enum([
  "idle-live-apply",
  "next-turn",
  "next-conversation",
]);

const agentCapabilityMetadataRuntimeVisibilitySchema = z.enum([
  "sdk-runtime",
  "source-only",
  "unsupported",
]);

const agentCapabilityCompositionSupportSchema = z.enum([
  "native",
  "translator",
  "verification-gated",
  "diagnostic-only",
]);

// ---------------------------------------------------------------------------
// Persistent override storage — sparse per-cascade item records
// `enabled` is required when an item key exists; key absence means inherit
// from a broader layer or the backend native default.
// ---------------------------------------------------------------------------

export const agentCapabilityItemOverrideSchema = z.object({
  enabled: z.boolean(),
});
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

export const agentCapabilityOverridesSchema = registerTrustedSchema(
  z.object({
    cascades: agentCapabilityCascadesOverrideSchema,
  }),
  "agentCapabilityOverridesSchema",
);
export type AgentCapabilityOverrides = z.infer<
  typeof agentCapabilityOverridesSchema
>;

export const agentCapabilityGlobalStateSchema = z.object({
  version: z.literal(1),
  overrides: agentCapabilityOverridesSchema,
  updatedAt: z.string(),
});
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

export const agentCapabilityScopeContextSchema = z
  .object({
    level: agentCapabilityCascadeLayerSchema,
    projectName: z.string().optional(),
    conversationScope: agentCapabilityConversationScopeSchema.optional(),
    sessionName: z.string().optional(),
    conversationId: z.string().optional(),
  })
  .superRefine(validateAgentCapabilityScopeIdentity);
export type AgentCapabilityScopeContext = z.infer<
  typeof agentCapabilityScopeContextSchema
>;

const agentCapabilityEffectiveStateSchema = z.object({
  enabled: z.boolean(),
  originLayer: agentCapabilityOriginLayerSchema,
});
export type AgentCapabilityEffectiveState = z.infer<
  typeof agentCapabilityEffectiveStateSchema
>;

const agentCapabilityInheritedDisableReasonSchema = z.object({
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
    conversationScope: agentCapabilityConversationScopeSchema.optional(),
    sessionName: z.string().optional(),
    conversationId: z.string().optional(),
    sourceRef: agentCapabilitySourceRefSchema.optional(),
  })
  .strict()
  .superRefine(validateAgentCapabilityScopeIdentity)
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
    appliedEnabled: z.boolean().optional(),
    support: agentCapabilityControlSupportSchema.optional(),
    originLayer: agentCapabilityOriginLayerSchema,
    conversationScope: agentCapabilityConversationScopeSchema.optional(),
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
//   the response targets.
export const agentCapabilityMetadataSchema = z
  .object({
    cascadeKind: agentCapabilityCascadeKindSchema,
    backend: agentBackendSchema,
    capabilityKind: agentCapabilityCapabilityKindSchema,
    applySemantics: agentCapabilityApplySemanticsSchema,
    discoverySupport: agentCapabilityDiscoverySupportSchema,
    runtimeVisibility: agentCapabilityMetadataRuntimeVisibilitySchema,
    compositionSupport: agentCapabilityCompositionSupportSchema,
    support: agentCapabilityControlSupportSchema.optional(),
  })
  .strict()
  .superRefine(requireAgentCapabilityCascadeBackendOwnership);
export type AgentCapabilityMetadata = z.infer<
  typeof agentCapabilityMetadataSchema
>;

export const agentCapabilityViewResponseSchema = z
  .object({
    level: agentCapabilityCascadeLayerSchema,
    projectName: z.string().optional(),
    conversationScope: agentCapabilityConversationScopeSchema.optional(),
    sessionName: z.string().optional(),
    conversationId: z.string().optional(),
    cascadeKind: agentCapabilityCascadeKindSchema,
    backend: agentBackendSchema,
    items: z.array(agentCapabilityViewRowSchema),
    appliedCommands: z.array(commandItemSchema).optional(),
    diagnostics: z.array(agentCapabilityDiagnosticSchema),
    effectiveHash: z.string(),
    metadata: agentCapabilityMetadataSchema.optional(),
  })
  .superRefine(validateAgentCapabilityScopeIdentity)
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
export const agentCapabilityInvalidationHintsSchema = z
  .object({
    level: agentCapabilityCascadeLayerSchema,
    projectName: z.string().optional(),
    conversationScope: agentCapabilityConversationScopeSchema.optional(),
    sessionName: z.string().optional(),
    conversationId: z.string().optional(),
    cascadeKind: agentCapabilityCascadeKindSchema,
    itemIds: z.array(z.string()).optional(),
    effectiveHash: z.string().optional(),
    refreshDiscovery: z.boolean().optional(),
    sourceSignature: z.string().optional(),
    operationId: z.string().optional(),
  })
  .strict()
  .superRefine(validateAgentCapabilityScopeIdentity);
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
    conversationScope: agentCapabilityConversationScopeSchema.optional(),
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
  .superRefine(validateAgentCapabilityScopeIdentity)
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
    conversationScope: agentCapabilityConversationScopeSchema.optional(),
    sessionName: z.string().optional(),
    conversationId: z.string().optional(),
    cascadeKind: agentCapabilityCascadeKindSchema,
    backend: agentBackendSchema,
    refreshedAt: z.string(),
    sourceSignature: z.string(),
    invalidationHints: agentCapabilityInvalidationHintsSchema,
  })
  .strict()
  .superRefine(validateAgentCapabilityScopeIdentity)
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
    conversationScope?: AgentCapabilityConversationScope;
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
    "conversationScope",
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
