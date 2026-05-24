"use client";

import { useCallback, useState } from "react";
import { getModelsForBackend } from "@/components/ModelSelector";
import {
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

// Initialize backend/model/effort consistently from the active conversation's
// stored backend. The Claude `defaultModel` from server config must not leak
// into a Codex conversation — picking the first backend-appropriate model
// keeps these in sync from the very first render.
export function useBackendModelEffort({
  conversationId,
  activeConversation,
  defaultModel,
  defaultEffort,
}: UseBackendModelEffortArgs): UseBackendModelEffortResult {
  const [selectedBackend, setSelectedBackend] = useState<AgentBackendId>(
    () => activeConversation?.agentBackend ?? "claude",
  );

  const [selectedModel, setSelectedModel] = useState<string>(() => {
    const backend = activeConversation?.agentBackend ?? "claude";
    const models = getModelsForBackend(backend);
    return models.some((m) => m.id === defaultModel)
      ? defaultModel
      : models[0]!.id;
  });

  const [selectedEffort, setSelectedEffort] = useState<EffortLevel>(() => {
    const backend = activeConversation?.agentBackend ?? "claude";
    const models = getModelsForBackend(backend);
    const initialModel = models.some((m) => m.id === defaultModel)
      ? defaultModel
      : models[0]!.id;
    return pickEffort(backend, initialModel, defaultEffort);
  });

  const backendLocked = (activeConversation?.promptCount ?? 0) > 0;

  // Sync backend/model/effort when switching conversations or when the
  // server backend changes on a locked conversation (promptCount > 0).
  // When the backend isn't locked yet, the user's local toggle is
  // authoritative — server refetches must not overwrite it.
  // Uses the "store previous render's value" pattern to detect changes
  // without an effect — see https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const activeBackend = activeConversation?.agentBackend;
  const [prevConversationId, setPrevConversationId] = useState(conversationId);
  const [prevActiveBackend, setPrevActiveBackend] = useState(activeBackend);
  if (
    activeConversation &&
    (prevConversationId !== conversationId ||
      prevActiveBackend !== activeBackend)
  ) {
    setPrevConversationId(conversationId);
    setPrevActiveBackend(activeBackend);
    const backend = activeConversation.agentBackend ?? "claude";
    const isConversationSwitch = prevConversationId !== conversationId;
    if (
      backend !== selectedBackend &&
      (isConversationSwitch || (activeConversation.promptCount ?? 0) > 0)
    ) {
      setSelectedBackend(backend);
      const models = getModelsForBackend(backend);
      setSelectedModel(models[0]!.id);
      const levels = getEffortLevelsForBackend(backend, models[0]!.id);
      setSelectedEffort(levels.includes("high") ? "high" : levels[0]!);
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
