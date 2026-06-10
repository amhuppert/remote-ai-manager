"use client";

import { useCallback, useState } from "react";
import { getModelsForBackend } from "@/components/ModelSelector";
import {
  effortLevelSchema,
  type EffortLevel,
  getEffortLevelsForBackend,
} from "@/lib/agent-backends/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";

export interface UseBackendModelEffortArgs {
  conversationId: string;
  activeConversation: ConversationState | undefined;
  defaultModel: string;
  defaultEffort: EffortLevel;
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
  const models = getModelsForBackend(backend);
  if (preferred !== undefined && models.some((m) => m.id === preferred)) {
    return preferred;
  }
  return models.some((m) => m.id === fallback) ? fallback : models[0]!.id;
}

function resolveModelEffortSelection({
  backend,
  defaultModel,
  defaultEffort,
  lastUsedModelId,
  lastUsedEffort,
}: {
  backend: AgentBackendId;
  defaultModel: string;
  defaultEffort: EffortLevel;
  lastUsedModelId: string | undefined;
  lastUsedEffort: string | undefined;
}): {
  model: string;
  effort: EffortLevel;
} {
  const model = pickModel(backend, lastUsedModelId, defaultModel);
  return {
    model,
    effort: pickEffort(
      backend,
      model,
      parseEffort(lastUsedEffort) ?? defaultEffort,
    ),
  };
}

// Initialize backend/model/effort consistently from the active conversation's
// stored backend. The Claude `defaultModel` from server config must not leak
// into a Codex conversation — picking the first backend-appropriate model
// keeps these in sync from the very first render.
export function useBackendModelEffort({
  conversationId,
  activeConversation,
  defaultModel,
  defaultEffort,
  lastUsedModelId,
  lastUsedEffort,
}: UseBackendModelEffortArgs): UseBackendModelEffortResult {
  const initialBackend = activeConversation?.agentBackend ?? "claude";
  const initialSelection = resolveModelEffortSelection({
    backend: initialBackend,
    defaultModel,
    defaultEffort,
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

  const backendLocked = (activeConversation?.promptCount ?? 0) > 0;

  // Sync backend/model/effort when switching conversations or when the
  // server backend changes on a locked conversation (promptCount > 0).
  // When the backend isn't locked yet, the user's local toggle is
  // authoritative — server refetches must not overwrite it.
  // Uses the "store previous render's value" pattern to detect changes
  // without an effect — see https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const activeBackend = activeConversation?.agentBackend;
  const [prevConversationId, setPrevConversationId] = useState(conversationId);
  const rememberedSettingsKey = JSON.stringify([
    conversationId,
    activeBackend,
    defaultModel,
    defaultEffort,
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
    const shouldApplyRememberedSettings =
      isConversationSwitch || (activeConversation.promptCount ?? 0) > 0;
    if (shouldApplyRememberedSettings) {
      const backend = activeConversation.agentBackend ?? "claude";
      const nextSelection = resolveModelEffortSelection({
        backend,
        defaultModel,
        defaultEffort,
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

  const handleBackendChange = useCallback((backend: AgentBackendId) => {
    setSelectedBackend(backend);
    const models = getModelsForBackend(backend);
    setSelectedModel(models[0]!.id);
    const levels = getEffortLevelsForBackend(backend, models[0]!.id);
    setSelectedEffort(levels.includes("high") ? "high" : levels[0]!);
  }, []);

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
