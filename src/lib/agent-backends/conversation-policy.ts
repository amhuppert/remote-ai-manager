import { agentBackendSchema, type AgentBackendId } from "@/lib/shared/schemas";
import {
  getDefaultStallTimeoutForBackend,
  getEffortLevelsForBackend,
} from "./catalog";
import { resolveConfiguredTimeoutMs } from "./timeout";
import { effortLevelSchema, type EffortLevel } from "./schemas";
import type {
  BackendConversationTranscriptProjection,
  BackendTaskTranscriptProjection,
} from "./descriptor";
import { getBackendDescriptor } from "./registry-core";

interface BackendProfileConfig {
  model: string;
  reasoningEffort?: string;
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
  modelId: string;
  reasoningEffort: EffortLevel | undefined;
  /** Runtime sentinel: zero means unbounded. */
  timeoutMs: number;
  /** Runtime sentinel: zero means disabled. */
  stallTimeoutMs: number;
}

export interface AgentBackendSettingsOverride {
  modelId?: string | null;
  reasoningEffort?: string | null;
}

export interface BackendSelectionDefaults {
  modelId: string;
  /** UI preference retained even when the selected model hides effort input. */
  effort: EffortLevel;
}

export type BackendSelectionDefaultsById = Readonly<
  Record<AgentBackendId, BackendSelectionDefaults>
>;

function resolveModelValidEffort(
  backend: AgentBackendId,
  modelId: string,
  configured: string | undefined,
): EffortLevel | undefined {
  let supported: EffortLevel[];
  try {
    supported = getEffortLevelsForBackend(backend, modelId);
  } catch {
    const metadata = getBackendDescriptor(backend).metadata;
    const model = metadata.models.find(({ id }) => id === modelId);
    supported = model
      ? [...model.effortLevels]
      : [
          ...new Set(
            metadata.models.flatMap(({ effortLevels }) => effortLevels),
          ),
        ];
  }
  if (supported.length === 0) return undefined;

  const parsed = effortLevelSchema.safeParse(configured);
  if (parsed.success && supported.includes(parsed.data)) return parsed.data;
  if (supported.includes("high")) return "high";
  return supported.at(-1);
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
  const descriptor =
    profile === undefined ? getBackendDescriptor(backend) : undefined;
  const modelId =
    input.explicit?.modelId ??
    input.scoped?.modelId ??
    profile?.model ??
    descriptor!.metadata.defaultModelId;
  const reasoningEffort =
    input.explicit?.reasoningEffort ??
    input.scoped?.reasoningEffort ??
    profile?.reasoningEffort;
  const configuredStallTimeout = profile?.stallTimeoutMs;
  const stallTimeoutMs =
    configuredStallTimeout === undefined
      ? resolveConfiguredTimeoutMs(
          profile === undefined
            ? descriptor!.metadata.defaultStallTimeoutMs
            : getDefaultStallTimeoutForBackend(backend),
        )
      : resolveConfiguredTimeoutMs(configuredStallTimeout);

  return {
    modelId,
    reasoningEffort: resolveModelValidEffort(backend, modelId, reasoningEffort),
    timeoutMs: resolveConfiguredTimeoutMs(
      profile === undefined
        ? descriptor!.metadata.defaultTimeoutMs
        : profile.timeoutMs,
    ),
    stallTimeoutMs,
  };
}

export function resolveConfiguredAgentBackendDefaults(
  config: ConversationTurnConfig,
  backend: AgentBackendId,
): ResolvedAgentBackendDefaults {
  return resolveAgentBackendTurnDefaults({ config, backend });
}

/** Project configured backend profiles into conversation selection controls. */
export function resolveConfiguredBackendSelectionDefaults(
  config: ConversationTurnConfig,
): BackendSelectionDefaultsById {
  return Object.fromEntries(
    agentBackendSchema.options.map((backend) => {
      const profile = config.agentBackends[backend];
      const parsed = effortLevelSchema.safeParse(profile.reasoningEffort);
      return [
        backend,
        {
          modelId: profile.model,
          effort: parsed.success ? parsed.data : "high",
        },
      ];
    }),
  ) as Record<AgentBackendId, BackendSelectionDefaults>;
}

/** Whether any declared capability can be applied to an idle live runtime. */
export function backendHasIdleLiveCapability(backend: AgentBackendId): boolean {
  return (
    getBackendDescriptor(
      backend,
    ).conversation?.capabilities.capabilityKinds.some(
      ({ applyTiming }) => applyTiming === "idle_live",
    ) ?? false
  );
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
