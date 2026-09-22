import type { AgentBackendId } from "@/lib/shared/schemas";
import { getDefaultStallTimeoutForBackend } from "./catalog";
import { resolveConfiguredTimeoutMs } from "./timeout";
import type { BackendModelSelection } from "./schemas";
import type {
  BackendConversationTranscriptProjection,
  BackendTaskTranscriptProjection,
} from "./descriptor";
import { getBackendDescriptor } from "./registry-core";

interface BackendProfileConfig {
  modelSelection: BackendModelSelection;
  timeoutMs: number | null;
  stallTimeoutMs?: number | null;
}

/** Global configuration fields consumed by backend-neutral turn setup. */
export interface ConversationTurnConfig {
  agentBackends: Readonly<Record<AgentBackendId, BackendProfileConfig>>;
  maxTurns?: number;
  idleQuerySessionTtlMs?: number;
  pushNotification?: unknown;
}

export interface ResolvedAgentBackendDefaults {
  modelSelection: BackendModelSelection;
  /** Runtime sentinel: zero means unbounded. */
  timeoutMs: number;
  /** Runtime sentinel: zero means disabled. */
  stallTimeoutMs: number;
}

export interface AgentBackendSettingsOverride {
  modelSelection?: BackendModelSelection | null;
}

// Selection defaults are resolved by the client-safe catalog; the aliases keep
// this module's existing type importers stable.
export type { BackendSelectionDefaultsById } from "./catalog";

function cloneSelection(
  selection: BackendModelSelection,
): BackendModelSelection {
  return {
    modelId: selection.modelId,
    parameters: { ...selection.parameters },
  };
}

/**
 * Resolve one backend's complete runtime defaults from its independent global
 * profile. This is the sole translation from nullable persisted timeout
 * values and optional effort into task/conversation runtime values.
 */
export function resolveAgentBackendTurnDefaults(input: {
  config: ConversationTurnConfig;
  backend: AgentBackendId;
  explicit?: AgentBackendSettingsOverride;
  scoped?: AgentBackendSettingsOverride;
}): ResolvedAgentBackendDefaults {
  const { config, backend } = input;
  const profile = config.agentBackends[backend] as
    | BackendProfileConfig
    | undefined;
  if (profile === undefined) {
    throw new Error(`Missing configured profile for backend "${backend}".`);
  }
  const modelSelection =
    input.explicit?.modelSelection ??
    input.scoped?.modelSelection ??
    profile.modelSelection;
  const configuredStallTimeout = profile?.stallTimeoutMs;
  const stallTimeoutMs =
    configuredStallTimeout === undefined
      ? resolveConfiguredTimeoutMs(getDefaultStallTimeoutForBackend(backend))
      : resolveConfiguredTimeoutMs(configuredStallTimeout);

  return {
    modelSelection: cloneSelection(modelSelection),
    timeoutMs: resolveConfiguredTimeoutMs(profile.timeoutMs),
    stallTimeoutMs,
  };
}

export function resolveConfiguredAgentBackendDefaults(
  config: ConversationTurnConfig,
  backend: AgentBackendId,
): ResolvedAgentBackendDefaults {
  return resolveAgentBackendTurnDefaults({ config, backend });
}

/** Whether fork continuity is reconstructed from the copied transcript. */
export function backendRequiresSyntheticForkSeed(
  backend: AgentBackendId,
): boolean {
  return (
    getBackendDescriptor(backend).conversation?.capabilities.fork ===
    "synthetic"
  );
}

export function getConversationTranscriptProjection(
  backend: AgentBackendId,
): BackendConversationTranscriptProjection {
  const projection = getBackendDescriptor(backend).conversation?.transcript;
  if (!projection) {
    throw new Error(
      `Backend "${backend}" declares no conversation transcript projection`,
    );
  }
  return projection;
}

export function getTaskTranscriptProjection(
  backend: AgentBackendId,
): BackendTaskTranscriptProjection {
  const projection = getBackendDescriptor(backend).tasks?.transcript;
  if (!projection) {
    throw new Error(
      `Backend "${backend}" declares no task transcript projection`,
    );
  }
  return projection;
}
