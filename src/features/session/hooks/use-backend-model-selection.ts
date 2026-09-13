"use client";

import { useCallback, useMemo, useState } from "react";

import { validateModelSelection } from "@/lib/agent-backends/model-selection";
import { useProjectModelOptionsQuery } from "@/lib/agent-backends/queries";
import type {
  BackendModelCatalog,
  BackendModelSelection,
} from "@/lib/agent-backends/schemas";
import type {
  BackendSelectionDefaultsById,
  BackendValueMap,
} from "@/lib/agent-backends/catalog";
import type { PublicConversationState } from "@/lib/conversations/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";

export interface UseBackendModelSelectionArgs {
  projectName: string;
  conversationId: string;
  activeConversation: PublicConversationState | undefined;
  backendDefaults: BackendSelectionDefaultsById;
  lastUsedSelection?: BackendModelSelection;
}

export interface UseBackendModelSelectionResult {
  selectedBackend: AgentBackendId;
  modelSelection: BackendModelSelection;
  modelCatalog: BackendModelCatalog | null;
  modelCatalogs: BackendModelCatalogsById;
  modelSelectionValid: boolean;
  modelSelectionBlockedReason: string | null;
  backendLocked: boolean;
  setModelSelection(selection: BackendModelSelection): void;
  handleBackendChange(backend: AgentBackendId): void;
}

export type BackendModelCatalogsById =
  BackendValueMap<BackendModelCatalog | null>;

function cloneSelection(
  selection: BackendModelSelection,
): BackendModelSelection {
  return {
    modelId: selection.modelId,
    parameters: { ...selection.parameters },
  };
}

function describeCatalogSnapshot(catalog: BackendModelCatalog): string {
  const details = [`Catalog snapshot: ${catalog.provenance.source}`];
  if (catalog.provenance.generatedAt !== undefined) {
    details.push(`generated ${catalog.provenance.generatedAt}`);
  }
  if (catalog.provenance.sdkVersion !== undefined) {
    details.push(`SDK ${catalog.provenance.sdkVersion}`);
  }
  return `${details.join(", ")}.`;
}

function preferredSelection(
  backend: AgentBackendId,
  backendDefaults: BackendSelectionDefaultsById,
  lastUsedSelection: BackendModelSelection | undefined,
): BackendModelSelection {
  return cloneSelection(lastUsedSelection ?? backendDefaults[backend]);
}

export function useBackendModelSelection({
  projectName,
  conversationId,
  activeConversation,
  backendDefaults,
  lastUsedSelection: suppliedLastUsedSelection,
}: UseBackendModelSelectionArgs): UseBackendModelSelectionResult {
  const initial = activeConversation?.checkpointFork?.initialSelection;
  const lastUsedSelection =
    suppliedLastUsedSelection ??
    (activeConversation?.promptCount === 0 &&
    initial?.backend === activeConversation.agentBackend
      ? initial.modelSelection
      : undefined);
  const initialBackend = activeConversation?.agentBackend ?? "claude";
  const [selectedBackend, setSelectedBackend] = useState<AgentBackendId>(
    () => initialBackend,
  );
  const [modelSelection, setModelSelectionState] =
    useState<BackendModelSelection>(() =>
      preferredSelection(initialBackend, backendDefaults, lastUsedSelection),
    );

  const backendLocked =
    activeConversation?.checkpointFork?.submission !== undefined ||
    (activeConversation?.promptCount ?? 0) > 0 ||
    activeConversation?.status === "running";
  const activeBackend = activeConversation?.agentBackend;
  const [previousConversationId, setPreviousConversationId] = useState(
    activeConversation?.id,
  );
  const rememberedSettingsKey = JSON.stringify([
    conversationId,
    activeBackend,
    backendLocked,
    backendDefaults,
    lastUsedSelection,
  ]);
  const [previousRememberedSettingsKey, setPreviousRememberedSettingsKey] =
    useState(rememberedSettingsKey);

  if (
    activeConversation !== undefined &&
    previousRememberedSettingsKey !== rememberedSettingsKey
  ) {
    const conversationChanged = previousConversationId !== conversationId;
    setPreviousConversationId(conversationId);
    setPreviousRememberedSettingsKey(rememberedSettingsKey);
    if (conversationChanged || backendLocked) {
      const backend = activeConversation.agentBackend ?? "claude";
      setSelectedBackend(backend);
      setModelSelectionState(
        preferredSelection(backend, backendDefaults, lastUsedSelection),
      );
    }
  }

  const projectOptionsQuery = useProjectModelOptionsQuery(projectName);
  const modelCatalogs = useMemo<BackendModelCatalogsById>(() => {
    const catalogFor = (backend: AgentBackendId): BackendModelCatalog | null =>
      projectOptionsQuery.data?.find((entry) => entry.backend === backend)
        ?.modelCatalog ?? null;
    return {
      claude: catalogFor("claude"),
      codex: catalogFor("codex"),
      cursor: catalogFor("cursor"),
    };
  }, [projectOptionsQuery.data]);
  const currentOptions = projectOptionsQuery.data?.find(
    ({ backend }) => backend === selectedBackend,
  );
  const modelCatalog = modelCatalogs[selectedBackend];
  const selectionValidation =
    modelCatalog === null
      ? null
      : validateModelSelection(modelCatalog, modelSelection);
  const modelSelectionValid = selectionValidation?.valid ?? false;

  let modelSelectionBlockedReason: string | null = null;
  if (projectOptionsQuery.isPending) {
    modelSelectionBlockedReason = "Loading model options…";
  } else if (projectOptionsQuery.isError) {
    modelSelectionBlockedReason = "Model options could not be loaded.";
  } else if (currentOptions === undefined) {
    modelSelectionBlockedReason = `Model options are unavailable for ${selectedBackend}.`;
  } else if (currentOptions.diagnostics.length > 0) {
    modelSelectionBlockedReason = currentOptions.diagnostics
      .map(({ message }) => message)
      .join(" ");
  } else if (
    modelCatalog !== null &&
    selectionValidation !== null &&
    !selectionValidation.valid
  ) {
    modelSelectionBlockedReason = `${selectionValidation.issues
      .map(({ message }) => message)
      .join(" ")} ${describeCatalogSnapshot(modelCatalog)}`;
  } else if (modelCatalog === null) {
    modelSelectionBlockedReason = "Model options are unavailable.";
  }

  const setModelSelection = useCallback((selection: BackendModelSelection) => {
    setModelSelectionState(cloneSelection(selection));
  }, []);

  const handleBackendChange = useCallback(
    (backend: AgentBackendId) => {
      if (backendLocked) return;
      const effectiveDefault = projectOptionsQuery.data?.find(
        (options) => options.backend === backend,
      )?.defaultSelection;
      setSelectedBackend(backend);
      setModelSelectionState(
        cloneSelection(effectiveDefault ?? backendDefaults[backend]),
      );
    },
    [backendDefaults, projectOptionsQuery.data, backendLocked],
  );

  return {
    selectedBackend,
    modelSelection,
    modelCatalog,
    modelCatalogs,
    modelSelectionValid,
    modelSelectionBlockedReason,
    backendLocked,
    setModelSelection,
    handleBackendChange,
  };
}
