"use client";

import { useCallback, useState } from "react";
import {
  getDefaultModelForBackend,
  getEffortLevelsForBackend,
  isSelectableModelForBackend,
} from "@/lib/agent-backends/catalog";
import {
  effortLevelSchema,
  type EffortLevel,
} from "@/lib/agent-backends/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { PublicConversationState } from "@/lib/conversations/schemas";
import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/conversation-policy";

export interface UseBackendModelEffortArgs {
  conversationId: string;
  activeConversation: PublicConversationState | undefined;
  backendDefaults: BackendSelectionDefaultsById;
  lastUsedModelId?: string;
  lastUsedEffort?: string;
}

export interface UseBackendModelEffortResult {
  selectedBackend: AgentBackendId;
  selectedModel: string;
  selectedEffort: EffortLevel;
  availableEffortLevels: EffortLevel[];
  effortSupported: boolean;
  backendLocked: boolean;
  setSelectedEffort: (effort: EffortLevel) => void;
  handleBackendChange: (backend: AgentBackendId) => void;
  handleModelChange: (model: string) => void;
}

export function pickPreferredEffort(
  availableLevels: readonly EffortLevel[],
  preferred: EffortLevel,
): EffortLevel {
  if (availableLevels.length === 0) return preferred;
  if (availableLevels.includes(preferred)) return preferred;
  return availableLevels.includes("high") ? "high" : availableLevels[0]!;
}

function pickEffort(
  backend: AgentBackendId,
  model: string,
  preferred: EffortLevel,
): EffortLevel {
  const levels = getEffortLevelsForBackend(backend, model);
  return pickPreferredEffort(levels, preferred);
}

function parseEffort(value: string | undefined): EffortLevel | undefined {
  if (value === undefined) return undefined;
  const result = effortLevelSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

function pickModel(
  backend: AgentBackendId,
  preferred: string | undefined,
  fallback: string,
): string {
  if (
    preferred !== undefined &&
    isSelectableModelForBackend(backend, preferred)
  ) {
    return preferred;
  }
  return isSelectableModelForBackend(backend, fallback)
    ? fallback
    : getDefaultModelForBackend(backend);
}

function resolveModelEffortSelection({
  backend,
  backendDefaults,
  lastUsedModelId,
  lastUsedEffort,
}: {
  backend: AgentBackendId;
  backendDefaults: BackendSelectionDefaultsById;
  lastUsedModelId: string | undefined;
  lastUsedEffort: string | undefined;
}): {
  model: string;
  effort: EffortLevel;
} {
  const defaults = backendDefaults[backend];
  const model = pickModel(backend, lastUsedModelId, defaults.modelId);
  return {
    model,
    effort: pickEffort(
      backend,
      model,
      parseEffort(lastUsedEffort) ?? defaults.effort,
    ),
  };
}

// Initialize backend/model/effort consistently from the active conversation's
// stored backend. Each backend has independent global defaults, so selection
// must resolve them together from the first render.
export function useBackendModelEffort({
  conversationId,
  activeConversation,
  backendDefaults,
  lastUsedModelId,
  lastUsedEffort,
}: UseBackendModelEffortArgs): UseBackendModelEffortResult {
  const initialBackend = activeConversation?.agentBackend ?? "claude";
  const initialSelection = resolveModelEffortSelection({
    backend: initialBackend,
    backendDefaults,
    lastUsedModelId,
    lastUsedEffort,
  });
  const [selectedBackend, setSelectedBackend] = useState<AgentBackendId>(
    () => initialBackend,
  );

  const [selectedModel, setSelectedModel] = useState<string>(
    () => initialSelection.model,
  );

  const [selectedEffort, setSelectedEffort] = useState<EffortLevel>(
    () => initialSelection.effort,
  );

  const backendLocked =
    (activeConversation?.promptCount ?? 0) > 0 ||
    activeConversation?.status === "running";

  // Sync backend/model/effort when the active conversation first loads,
  // when switching conversations, or when settings change after backend lock.
  // When the backend isn't locked yet, the user's local toggle is
  // authoritative — server refetches must not overwrite it.
  // Uses the "store previous render's value" pattern to detect changes
  // without an effect — see https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const activeBackend = activeConversation?.agentBackend;
  const [prevConversationId, setPrevConversationId] = useState(
    activeConversation?.id,
  );
  const rememberedSettingsKey = JSON.stringify([
    conversationId,
    activeBackend,
    backendLocked,
    backendDefaults,
    lastUsedModelId,
    lastUsedEffort,
  ]);
  const [prevRememberedSettingsKey, setPrevRememberedSettingsKey] = useState(
    rememberedSettingsKey,
  );
  if (
    activeConversation &&
    prevRememberedSettingsKey !== rememberedSettingsKey
  ) {
    const isConversationSwitch = prevConversationId !== conversationId;
    setPrevConversationId(conversationId);
    setPrevRememberedSettingsKey(rememberedSettingsKey);
    const shouldApplyRememberedSettings = isConversationSwitch || backendLocked;
    if (shouldApplyRememberedSettings) {
      const backend = activeConversation.agentBackend ?? "claude";
      const nextSelection = resolveModelEffortSelection({
        backend,
        backendDefaults,
        lastUsedModelId,
        lastUsedEffort,
      });
      setSelectedBackend(backend);
      setSelectedModel(nextSelection.model);
      setSelectedEffort(nextSelection.effort);
    }
  }

  const availableEffortLevels = getEffortLevelsForBackend(
    selectedBackend,
    selectedModel,
  );
  const effortSupported = availableEffortLevels.length > 0;

  const handleBackendChange = useCallback(
    (backend: AgentBackendId) => {
      const nextSelection = resolveModelEffortSelection({
        backend,
        backendDefaults,
        lastUsedModelId: undefined,
        lastUsedEffort: undefined,
      });
      setSelectedBackend(backend);
      setSelectedModel(nextSelection.model);
      setSelectedEffort(nextSelection.effort);
    },
    [backendDefaults],
  );

  const handleModelChange = useCallback(
    (model: string) => {
      setSelectedModel(model);
      const levels = getEffortLevelsForBackend(selectedBackend, model);
      if (levels.length > 0 && !levels.includes(selectedEffort)) {
        setSelectedEffort(levels[levels.length - 1]!);
      }
    },
    [selectedBackend, selectedEffort],
  );

  return {
    selectedBackend,
    selectedModel,
    selectedEffort,
    availableEffortLevels,
    effortSupported,
    backendLocked,
    setSelectedEffort,
    handleBackendChange,
    handleModelChange,
  };
}
