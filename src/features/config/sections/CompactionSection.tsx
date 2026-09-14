import BackendExecutionWarning from "@/components/BackendExecutionWarning";
import { getConfiguredBackendModelCatalog } from "@/lib/agent-backends/catalog";
import { defaultSelectionForModel } from "@/lib/agent-backends/model-selection";
import { backendExecutionRefusalIn } from "@/lib/agent-backends/execution-admission";
import {
  compactionExecutionRequirements,
  compactionRepairRequirements,
} from "@/lib/config/task-admission";
import { useBackendCatalogQuery } from "@/lib/agent-backends/queries";
import type {
  BackendModelCatalog,
  BackendModelSelection,
} from "@/lib/agent-backends/schemas";
import { compactionConfigSchema } from "@/lib/config/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { DesktopModelSelectionControls } from "@/components/session/prompt/ModelSelectionControls";
import { ConfigField } from "../components/ConfigField";
import { ConfigNumericInput } from "../components/ConfigNumericInput";
import { ConfigPillGroup } from "../components/ConfigPillGroup";
import { SettingsPage } from "../components/SettingsPage";
import { SettingsSubSection } from "../components/SettingsSubSection";
import type { ConfigFormController } from "./types";

// Effective defaults rendered when config.json carries no `compaction` block
// yet. For the schema's own default backend, the compaction default model is
// deliberately the schema's — a per-feature summarizer choice, not the backend
// catalog default. Any other backend starts from its catalog default model.
const COMPACTION_DEFAULTS = compactionConfigSchema.parse({});

function CompactionModelSelectionField({
  controller,
  label,
  fieldPath,
  catalog,
  selection,
}: {
  controller: ConfigFormController;
  label: string;
  fieldPath: string;
  catalog: BackendModelCatalog;
  selection: BackendModelSelection;
}): React.JSX.Element {
  const { handleChange, isDefault, isModified } = controller;
  const apply = (next: BackendModelSelection): void => {
    handleChange(fieldPath, next);
  };

  return (
    <ConfigField
      label={label}
      fieldPath={fieldPath}
      isDefault={isDefault(fieldPath)}
      isModified={isModified(fieldPath)}
    >
      <DesktopModelSelectionControls
        catalog={catalog}
        selection={selection}
        onSelectionChange={apply}
      />
    </ConfigField>
  );
}

export function CompactionSection({
  controller,
}: {
  controller: ConfigFormController;
}): React.JSX.Element {
  const {
    formState,
    formRevision,
    handleChange,
    handleChangeMulti,
    handleValidityChange,
    isDefault,
    isModified,
  } = controller;

  const compaction = formState.compaction;
  const backend: AgentBackendId =
    compaction?.backend ?? COMPACTION_DEFAULTS.backend;
  const conversationModelSelection =
    compaction?.conversationModelSelection ??
    COMPACTION_DEFAULTS.conversationModelSelection;
  const messageModelSelection =
    compaction?.messageModelSelection ??
    COMPACTION_DEFAULTS.messageModelSelection;

  const { data: backends, isFetched, isError } = useBackendCatalogQuery();
  const availableBackends = isFetched && !isError ? backends : [];
  const selectionRefusal = backendExecutionRefusalIn(
    availableBackends,
    backend,
    compactionExecutionRequirements,
  );

  const conversationCatalog = getConfiguredBackendModelCatalog(
    backend,
    conversationModelSelection,
  );
  const messageCatalog = getConfiguredBackendModelCatalog(
    backend,
    messageModelSelection,
  );

  return (
    <SettingsPage
      title="Conversation"
      accent="compaction"
      sub="CC summarizes saved transcripts to create checkpoints and compaction artifacts. This is separate from native provider compaction and does not compact the provider’s internal history."
    >
      <SettingsSubSection
        title="Compaction backend"
        hint="Used for checkpoint creation and artifact generation. Model and reasoning options depend on the backend."
      >
        <ConfigField
          label="Backend"
          fieldPath="compaction.backend"
          isDefault={isDefault("compaction.backend")}
          isModified={isModified("compaction.backend")}
        >
          {selectionRefusal && (
            <p role="status" className="text-sm text-text-secondary">
              {selectionRefusal.message}
            </p>
          )}
          <ConfigPillGroup
            value={backend}
            options={backends.map((b) => b.id)}
            // Compaction dispatches a task run, so a backend with no task facet
            // cannot be selected here (spec D13).
            getOptionDisabledReason={(id) =>
              (
                backendExecutionRefusalIn(
                  availableBackends,
                  id,
                  compactionExecutionRequirements,
                ) ??
                backendExecutionRefusalIn(
                  availableBackends,
                  id,
                  compactionRepairRequirements,
                )
              )?.message ?? null
            }
            onChange={(value) => {
              const nextEntry = backends.find((b) => b.id === value);
              if (!nextEntry) {
                throw new Error(`Unknown agent backend: ${value}`);
              }
              const configuredSelection =
                formState.agentBackends[nextEntry.id].modelSelection;
              const nextCatalog = getConfiguredBackendModelCatalog(
                nextEntry.id,
                configuredSelection,
              );
              const nextSelection = defaultSelectionForModel(
                nextCatalog,
                nextCatalog.defaultModelId,
              );
              handleChangeMulti([
                ["compaction.backend", value],
                ["compaction.conversationModelSelection", nextSelection],
                ["compaction.messageModelSelection", nextSelection],
              ]);
            }}
          />
          <BackendExecutionWarning backend={backend} />
        </ConfigField>
      </SettingsSubSection>
      <SettingsSubSection
        title="Checkpoints and conversation artifacts"
        hint="Compact context now and Generate compaction artifact share this model and reasoning level. Project compaction settings override these global defaults."
      >
        <CompactionModelSelectionField
          controller={controller}
          label="Checkpoint and conversation model"
          fieldPath="compaction.conversationModelSelection"
          catalog={conversationCatalog}
          selection={conversationModelSelection}
        />
      </SettingsSubSection>
      <SettingsSubSection
        title="Oversized messages"
        hint="Summarizes individual messages when building compaction artifacts."
      >
        <CompactionModelSelectionField
          controller={controller}
          label="Message model selection"
          fieldPath="compaction.messageModelSelection"
          catalog={messageCatalog}
          selection={messageModelSelection}
        />
      </SettingsSubSection>
      <SettingsSubSection title="Generation timeout">
        <ConfigField
          label="Timeout"
          fieldPath="compaction.timeoutMs"
          isDefault={isDefault("compaction.timeoutMs")}
          isModified={isModified("compaction.timeoutMs")}
          hint="Minutes. Empty means no timeout."
        >
          <ConfigNumericInput
            value={compaction?.timeoutMs}
            onChange={(value) =>
              handleChange("compaction.timeoutMs", value ?? null)
            }
            displayAsMinutes
            positive
            name="compaction.timeoutMs"
            aria-label="Compaction timeout"
            aria-describedby="compaction.timeoutMs-hint"
            onValidityChange={(valid) =>
              handleValidityChange("compaction.timeoutMs", valid)
            }
            resetKey={formRevision}
          />
        </ConfigField>
      </SettingsSubSection>
    </SettingsPage>
  );
}
