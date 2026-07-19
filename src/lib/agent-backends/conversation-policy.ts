import { resolveConfiguredTimeoutMs } from "./timeout";
import { getBackendDescriptor } from "./registry-core";
import { getDefaultModelForBackend } from "./catalog";
import { effortLevelSchema, type EffortLevel } from "./schemas";
import type {
  BackendConversationTranscriptProjection,
  BackendTaskTranscriptProjection,
} from "./descriptor";
import { agentBackendSchema, type AgentBackendId } from "@/lib/shared/schemas";

/** Global configuration fields still consumed by conversation turn setup. */
export interface ConversationTurnConfig {
  defaultModel?: string;
  defaultEffort?: string;
  claudeTimeoutMs: number;
  maxTurns?: number;
  idleQuerySessionTtlMs?: number;
  pushNotification?: unknown;
  codex?: {
    enabled?: boolean;
    model?: string;
    reasoningEffort?: string;
    timeoutMs?: number | null;
    stallTimeoutMs?: number | null;
  };
}

export interface ConfiguredConversationTurnSettings {
  modelId: string | undefined;
  reasoningEffort: string | undefined;
}

export interface BackendSelectionDefaults {
  modelId: string;
  effort: EffortLevel;
}

export type BackendSelectionDefaultsById = Readonly<
  Record<AgentBackendId, BackendSelectionDefaults>
>;

/**
 * Compatibility translation from the current global config shape to a
 * backend-neutral turn-settings result. Unrecognized registered backends use
 * their descriptor metadata and never inherit another backend's config.
 */
export function resolveConfiguredConversationTurnSettings(
  backend: AgentBackendId,
  config: ConversationTurnConfig,
): ConfiguredConversationTurnSettings {
  if (backend === "codex") {
    return {
      modelId: config.codex?.model,
      reasoningEffort: config.codex?.reasoningEffort,
    };
  }
  if (backend === "claude") {
    return {
      modelId: config.defaultModel,
      reasoningEffort: config.defaultEffort,
    };
  }

  return {
    modelId: getBackendDescriptor(backend).metadata.defaultModelId,
    reasoningEffort: undefined,
  };
}

/**
 * Project provider-shaped global configuration into the backend-keyed defaults
 * consumed by conversation selection controls.
 */
export function resolveConfiguredBackendSelectionDefaults(
  config: ConversationTurnConfig,
): BackendSelectionDefaultsById {
  return Object.fromEntries(
    agentBackendSchema.options.map((backend) => {
      const configured = resolveConfiguredConversationTurnSettings(
        backend,
        config,
      );
      const effort = effortLevelSchema.safeParse(configured.reasoningEffort);
      return [
        backend,
        {
          modelId: configured.modelId ?? getDefaultModelForBackend(backend),
          effort: effort.success ? effort.data : "high",
        },
      ];
    }),
  ) as Record<AgentBackendId, BackendSelectionDefaults>;
}

/** Resolve the configured safety-net timeout without consumer identity logic. */
export function resolveConfiguredConversationTimeoutMs(
  backend: AgentBackendId,
  config: ConversationTurnConfig,
): number {
  if (backend === "codex") {
    return resolveConfiguredTimeoutMs(config.codex?.timeoutMs);
  }
  if (backend === "claude") {
    return config.claudeTimeoutMs;
  }
  return resolveConfiguredTimeoutMs(
    getBackendDescriptor(backend).metadata.defaultTimeoutMs,
  );
}

/**
 * Resolve the per-turn inactivity (stall) bound for a backend: an explicit
 * config value wins (null = disabled), else the descriptor's declared
 * default. Returns 0 when disabled, mirroring the safety-net timeout's
 * "0 means unbounded" convention.
 */
export function resolveConfiguredStallTimeoutMs(
  backend: AgentBackendId,
  config: ConversationTurnConfig,
): number {
  if (backend === "codex" && config.codex?.stallTimeoutMs !== undefined) {
    return resolveConfiguredTimeoutMs(config.codex.stallTimeoutMs);
  }
  return resolveConfiguredTimeoutMs(
    getBackendDescriptor(backend).metadata.defaultStallTimeoutMs,
  );
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
