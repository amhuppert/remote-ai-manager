/**
 * Pre-turn step: resolve the model, effort, and safety-net timeout a turn
 * runs with.
 *
 * Hides the backend-config fallback decision (which config block backs a
 * backend's defaults) and the three-tier model/effort resolution: explicit
 * per-turn override → the conversation's last-used model/effort → the
 * backend's configured defaults.
 */

import { selectLastUserTurnAgentSettings } from "@/lib/conversations/last-turn-agent-settings";
import type { TranscriptMessage } from "@/lib/conversations/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import {
  resolveConfiguredConversationTimeoutMs,
  resolveConfiguredConversationTurnSettings,
  resolveConfiguredStallTimeoutMs,
  type ConversationTurnConfig,
} from "@/lib/agent-backends/conversation-policy";

/** Subset of GlobalConfig properties used by actor implementations. */
export type ActorConfig = ConversationTurnConfig;

/**
 * Resolve the effective model and effort for a turn from explicit overrides
 * and the backend seam's configured defaults.
 */
export function resolveBackendTurnSettings(
  backend: AgentBackendId,
  config: ActorConfig,
  explicitModel: string | null,
  explicitEffort: string | null,
): { effectiveModel: string | undefined; effectiveEffort: string | undefined } {
  const configured = resolveConfiguredConversationTurnSettings(backend, config);
  return {
    effectiveModel: explicitModel ?? configured.modelId,
    effectiveEffort: explicitEffort ?? configured.reasoningEffort,
  };
}

/**
 * Resolve the model + effort a turn should run with, using a three-tier
 * fallback: an explicit per-turn override, else the conversation's last-used
 * model/effort (from its prior user turns), else the backend's configured
 * defaults.
 *
 * The last-used tier is what keeps follow-up turns that carry no explicit
 * model/effort — drained queued messages, document feedback, alignment turns —
 * on the model the conversation was already using instead of snapping to the
 * global default. The client resolves this same last-used value for the
 * composer (`selectLastUserTurnAgentSettings`); paths that bypass the composer
 * rely on this server-side tier so the model/effort stays consistent. Backend
 * is resolved separately (from the conversation's stored `agentBackend`), so it
 * is never inferred from the transcript here.
 */
export function resolveTurnModelEffort(input: {
  backend: AgentBackendId;
  config: ActorConfig;
  explicitModel: string | null;
  explicitEffort: string | null;
  priorMessages: readonly TranscriptMessage[];
}): {
  effectiveModel: string | undefined;
  effectiveEffort: string | undefined;
} {
  const lastUsed = selectLastUserTurnAgentSettings(input.priorMessages);
  return resolveBackendTurnSettings(
    input.backend,
    input.config,
    input.explicitModel ?? lastUsed.modelId ?? null,
    input.explicitEffort ?? lastUsed.effort ?? null,
  );
}

/**
 * Resolve the safety-net timeout for a turn based on the backend.
 * Returns 0 when the backend has no timeout.
 */
export function resolveBackendTimeoutMs(
  backend: AgentBackendId,
  config: ActorConfig,
): number {
  return resolveConfiguredConversationTimeoutMs(backend, config);
}

/**
 * Resolve the per-turn inactivity (stall) bound for a turn based on the
 * backend. Returns 0 when the backend has no stall bound.
 */
export function resolveBackendStallTimeoutMs(
  backend: AgentBackendId,
  config: ActorConfig,
): number {
  return resolveConfiguredStallTimeoutMs(backend, config);
}
