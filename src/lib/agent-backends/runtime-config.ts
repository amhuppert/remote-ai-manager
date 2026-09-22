/**
 * Neutral runtime-config apply seam (plan §3.1.5, decision D9).
 *
 * `agent-capabilities` resolves override cascades into the backend-neutral
 * `ResolvedCapabilityCascade` shape and hands it to the backend descriptor's
 * `conversation.runtimeConfig` adapter. Translation into provider payloads
 * (Claude `Settings` flags, Codex TOML overrides) happens entirely below this
 * seam, inside one `apply()` call frame — no provider config type and no
 * `payload: unknown` token ever crosses upward.
 */

import { z } from "zod";

import { agentBackendSchema, type AgentBackendId } from "@/lib/shared/schemas";
import {
  capabilityKindSchema,
  type BackendCapabilityKindSupport,
} from "./descriptor";
import type { ConversationBackendRuntime } from "./conversation";

/**
 * Which cascade layer decided an item's effective state; "native" = no CC
 * override, the backend's own default won.
 */
export const capabilityOriginLayerSchema = z.enum([
  "native",
  "global",
  "project",
  "session",
  "conversation",
]);

export const resolvedCapabilityItemSchema = z.object({
  itemId: z.string(),
  enabled: z.boolean(),
  originLayer: capabilityOriginLayerSchema,
});
export type ResolvedCapabilityItem = z.infer<
  typeof resolvedCapabilityItemSchema
>;

export const resolvedCapabilityKindSchema = z.object({
  kind: capabilityKindSchema,
  items: z.array(resolvedCapabilityItemSchema).readonly(),
});
export type ResolvedCapabilityKind = z.infer<
  typeof resolvedCapabilityKindSchema
>;

export const resolvedCapabilityCascadeSchema = z.object({
  backend: agentBackendSchema,
  kinds: z.array(resolvedCapabilityKindSchema).readonly(),
});
export type ResolvedCapabilityCascade = z.infer<
  typeof resolvedCapabilityCascadeSchema
>;

export type RuntimeConfigApplyResult =
  | { status: "applied" }
  | {
      status: "deferred";
      reason: "turn_active" | "next_turn" | "next_conversation";
    }
  | { status: "rejected"; error: string };

export interface BackendRuntimeConfigAdapter {
  readonly backend: AgentBackendId;
  /** Translate and apply below the seam; no provider payload escapes. */
  apply(input: {
    runtime: ConversationBackendRuntime;
    resolved: ResolvedCapabilityCascade;
  }): Promise<RuntimeConfigApplyResult>;
}

export type ResolvedCascadeValidation =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Validate a resolved cascade against a backend's declared capability kinds.
 * An undeclared `(backend, kind)` pair (e.g. codex+agents) fails loudly so a
 * mis-routed cascade is rejected instead of silently dropped.
 */
export function validateResolvedCascade(input: {
  resolved: ResolvedCapabilityCascade;
  backend: AgentBackendId;
  capabilityKinds: readonly BackendCapabilityKindSupport[];
}): ResolvedCascadeValidation {
  const parsed = resolvedCapabilityCascadeSchema.safeParse(input.resolved);
  if (!parsed.success) {
    return {
      ok: false,
      error: `invalid resolved capability cascade: ${parsed.error.message}`,
    };
  }
  if (parsed.data.backend !== input.backend) {
    return {
      ok: false,
      error: `cascade addressed to backend '${parsed.data.backend}' but adapter is '${input.backend}'`,
    };
  }
  const declared = new Set(input.capabilityKinds.map((k) => k.kind));
  for (const kind of parsed.data.kinds) {
    if (!declared.has(kind.kind)) {
      return {
        ok: false,
        error: `capability kind '${kind.kind}' is not declared by backend '${input.backend}'`,
      };
    }
  }
  return { ok: true };
}
