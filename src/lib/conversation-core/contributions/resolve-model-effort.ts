/**
 * Pre-turn step: resolve the atomic model selection and safety-net timeout a
 * turn runs with.
 *
 * Hides the backend-config fallback decision (which config block backs a
 * backend's defaults) and the three-tier selection resolution: explicit
 * per-turn override → the conversation's last-used selection → the backend's
 * configured defaults.
 */

import { selectLastUserTurnAgentSettings } from "@/lib/conversations/last-turn-agent-settings";
import type { TranscriptMessage } from "@/lib/conversations/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import {
  resolveAgentBackendTurnDefaults,
  resolveConfiguredAgentBackendDefaults,
  type ConversationTurnConfig,
} from "@/lib/agent-backends/conversation-policy";

/** Subset of GlobalConfig properties used by actor implementations. */
export type ActorConfig = ConversationTurnConfig;

/**
 * Resolve the complete model selection for a turn from an explicit override
 * and the backend seam's configured defaults.
 */
export function resolveBackendTurnSelection(
  backend: AgentBackendId,
  config: ActorConfig,
  explicitModelSelection: BackendModelSelection | null,
): BackendModelSelection {
  const resolved = resolveAgentBackendTurnDefaults({
    backend,
    config,
    explicit: { modelSelection: explicitModelSelection },
  });
  return resolved.modelSelection;
}

/**
 * Resolve the complete model selection a turn should run with, using a
 * three-tier fallback: an explicit per-turn override, else the conversation's
 * last-used selection (from its prior user turns), else the backend's
 * configured defaults.
 *
 * The last-used tier is what keeps follow-up turns that carry no explicit
 * selection — drained queued messages, document feedback, alignment turns — on
 * the exact variant the conversation was already using instead of snapping to
 * the global default. Backend is resolved separately (from the conversation's
 * stored `agentBackend`), so it is never inferred from the transcript here.
 */
export function resolveTurnModelSelection(input: {
  backend: AgentBackendId;
  config: ActorConfig;
  explicitModelSelection: BackendModelSelection | null;
  priorMessages: readonly TranscriptMessage[];
}): BackendModelSelection {
  const lastUsed = selectLastUserTurnAgentSettings(input.priorMessages);
  const resolved = resolveAgentBackendTurnDefaults({
    backend: input.backend,
    config: input.config,
    explicit: { modelSelection: input.explicitModelSelection },
    scoped: { modelSelection: lastUsed.modelSelection },
  });
  return resolved.modelSelection;
}

/**
 * Resolve the safety-net timeout for a turn based on the backend.
 * Returns 0 when the backend has no timeout.
 */
export function resolveBackendTimeoutMs(
  backend: AgentBackendId,
  config: ActorConfig,
): number {
  return resolveConfiguredAgentBackendDefaults(config, backend).timeoutMs;
}

/**
 * Resolve the per-turn inactivity (stall) bound for a turn based on the
 * backend. Returns 0 when the backend has no stall bound.
 */
export function resolveBackendStallTimeoutMs(
  backend: AgentBackendId,
  config: ActorConfig,
): number {
  return resolveConfiguredAgentBackendDefaults(config, backend).stallTimeoutMs;
}
