import type { AgentBackendId } from "@/lib/shared/schemas";
import { z } from "zod";
import type { CapabilityKind } from "./descriptor";
import type { ResolvedCapabilityCascade } from "./runtime-config";
import type { CommandItem } from "@/lib/commands/schemas";
export const agentCapabilityCapabilityKindSchema = z.enum([
  "skill",
  "plugin",
  "agent",
]);
export type AgentCapabilityKind = z.infer<
  typeof agentCapabilityCapabilityKindSchema
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

export const agentCapabilityControlSupportSchema = z.object({
  configurable: z.boolean(),
  notes: z.array(z.string()),
});
export type AgentCapabilityControlSupport = z.infer<
  typeof agentCapabilityControlSupportSchema
>;

export const agentCapabilityDiscoveredItemSchema = z.object({
  itemId: z.string(),
  displayName: z.string(),
  capabilityKind: agentCapabilityCapabilityKindSchema,
  source: agentCapabilitySourceRefSchema,
  nativeDefault: agentCapabilityNativeDefaultSchema,
  owningPluginId: z.string().optional(),
  support: agentCapabilityControlSupportSchema.optional(),
  runtimeVisibility: agentCapabilityRuntimeVisibilitySchema,
});
export type AgentCapabilityDiscoveredItem = z.infer<
  typeof agentCapabilityDiscoveredItemSchema
>;

export interface CapabilityCatalogDiagnostic {
  cascadeKind?: AgentCapabilityCascadeKind;
  backend?: AgentBackendId;
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  itemId?: string;
  sourceRef?: AgentCapabilitySourceRef;
}
export interface CapabilityCatalogInventory {
  items: readonly AgentCapabilityDiscoveredItem[];
  diagnostics: readonly CapabilityCatalogDiagnostic[];
  sourceSignature: string;
  refreshedAt?: string;
}
export interface BackendCapabilityCatalogFacet {
  discover(input: {
    kind: CapabilityKind;
    worktreePath: string;
    home: string;
    conversationId?: string;
  }): Promise<CapabilityCatalogInventory>;
  delivered?(conversationId: string): Promise<
    | {
        capabilities?: ResolvedCapabilityCascade;
        commands?: CommandItem[];
      }
    | undefined
  >;
}
export const AGENT_CAPABILITY_CASCADE_KINDS = [
  "claude-skills",
  "claude-plugins",
  "claude-agents",
  "codex-skills",
  "codex-plugins",
  "cursor-skills",
  "cursor-plugins",
  "cursor-agents",
] as const;

export const agentCapabilityCascadeKindSchema = z.enum(
  AGENT_CAPABILITY_CASCADE_KINDS,
);
export type AgentCapabilityCascadeKind = z.infer<
  typeof agentCapabilityCascadeKindSchema
>;

export const agentCapabilityDiscoverySupportSchema = z.enum([
  "available",
  "unavailable-pending-verification",
]);
export type AgentCapabilityDiscoverySupport = z.infer<
  typeof agentCapabilityDiscoverySupportSchema
>;
