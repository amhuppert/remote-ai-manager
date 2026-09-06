import { getConfiguredBackendModelCatalog } from "@/lib/agent-backends/catalog";
import { defaultSelectionForModel } from "@/lib/agent-backends/model-selection";
import { backendExecutionRefusalIn } from "@/lib/agent-backends/execution-admission";
import { namingExecutionRequirements } from "@/lib/config/task-admission";
import { useBackendCatalogQuery } from "@/lib/agent-backends/queries";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import { conversationNamingConfigSchema } from "@/lib/config/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import {
  CatalogModelSelect,
  ModelOptionsEditor,
} from "@/components/session/prompt/ModelSelectionControls";
import { ConfigField } from "../components/ConfigField";
import { ConfigNumericInput } from "../components/ConfigNumericInput";
import { ConfigPillGroup } from "../components/ConfigPillGroup";
import { ConfigToggle } from "../components/ConfigToggle";
import { SettingsPage } from "../components/SettingsPage";
import { SettingsSubSection } from "../components/SettingsSubSection";
import type { ConfigFormController } from "./types";

// Effective defaults rendered when config.json carries no `conversationNaming`
// block yet. Haiku is deliberately cheaper than the Claude profile default for
// this one-shot task; subsequent backend changes use the target catalog default.
const NAMING_DEFAULTS = conversationNamingConfigSchema.parse({});

export function NamingSection({
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

  const naming = formState.conversationNaming;
  const enabled = naming?.enabled ?? NAMING_DEFAULTS.enabled;
  const backend: AgentBackendId = naming?.backend ?? NAMING_DEFAULTS.backend;
  const modelSelection: BackendModelSelection =
    naming?.modelSelection ?? NAMING_DEFAULTS.modelSelection;

  const { data: backends, isFetched, isError } = useBackendCatalogQuery();
  const availableBackends = isFetched && !isError ? backends : [];
  const selectionRefusal = backendExecutionRefusalIn(
    availableBackends,
    backend,
    namingExecutionRequirements,
  );
  const catalog = getConfiguredBackendModelCatalog(backend, modelSelection);
  const selectedModel = catalog.models.find(
    ({ id, aliases }) =>
      id === modelSelection.modelId || aliases.includes(modelSelection.modelId),
  );
  const hasConfigurableParameters = selectedModel?.parameters.some(
    ({ prominence, values }) => prominence !== "hidden" && values.length > 1,
  );
  const applySelection = (selection: BackendModelSelection): void => {
    handleChange("conversationNaming.modelSelection", selection);
  };

  return (
    <SettingsPage
      title="Conversation"
      accent="naming"
      sub="Names new conversations in the background from their first user message. The toggle gates only automatic naming; the explicit regenerate actions always work."
    >
      <SettingsSubSection
        title="Automatic naming"
        hint="When off, new conversations keep their numbered placeholder names."
      >
        <ConfigField
          label="Automatic naming enabled"
          fieldPath="conversationNaming.enabled"
          isDefault={isDefault("conversationNaming.enabled")}
          isModified={isModified("conversationNaming.enabled")}
        >
          <ConfigToggle
            label="Automatic naming enabled"
            value={enabled}
            onChange={(value) =>
              handleChange("conversationNaming.enabled", value)
            }
          />
        </ConfigField>
      </SettingsSubSection>
      <SettingsSubSection
        title="Model selection"
        hint="The backend, model, and supported model parameters used for the one-shot naming call."
      >
        <ConfigField
          label="Backend"
          fieldPath="conversationNaming.backend"
          isDefault={isDefault("conversationNaming.backend")}
          isModified={isModified("conversationNaming.backend")}
        >
          {selectionRefusal && (
            <p role="status" className="text-sm text-text-secondary">
              {selectionRefusal.message}
            </p>
          )}
          <ConfigPillGroup
            value={backend}
            options={backends.map((b) => b.id)}
            // Naming runs as a one-shot task, so a backend with no task facet
            // cannot be selected here (spec D13).
            getOptionDisabledReason={(id) =>
              backendExecutionRefusalIn(
                availableBackends,
                id,
                namingExecutionRequirements,
              )?.message ?? null
            }
            onChange={(value) => {
              const nextEntry = backends.find((b) => b.id === value);
              if (!nextEntry) {
                throw new Error(`Unknown agent backend: ${value}`);
              }
              const nextCatalog = getConfiguredBackendModelCatalog(value);
              // A complete selection belongs to one backend catalog, so a
              // backend change also installs the target catalog's default.
              handleChangeMulti([
                ["conversationNaming.backend", value],
                [
                  "conversationNaming.modelSelection",
                  defaultSelectionForModel(
                    nextCatalog,
                    nextCatalog.defaultModelId,
                  ),
                ],
              ]);
            }}
          />
        </ConfigField>
        <ConfigField
          label="Model selection"
          fieldPath="conversationNaming.modelSelection"
          isDefault={isDefault("conversationNaming.modelSelection")}
          isModified={isModified("conversationNaming.modelSelection")}
        >
          <CatalogModelSelect
            catalog={catalog}
            selection={modelSelection}
            onSelectionChange={applySelection}
          />
          {hasConfigurableParameters ? (
            <div className="mt-md max-w-[420px]">
              <ModelOptionsEditor
                catalog={catalog}
                selection={modelSelection}
                onApply={applySelection}
              />
            </div>
          ) : null}
        </ConfigField>
        <ConfigField
          label="Timeout"
          fieldPath="conversationNaming.timeoutMs"
          isDefault={isDefault("conversationNaming.timeoutMs")}
          isModified={isModified("conversationNaming.timeoutMs")}
          hint="Minutes. Empty = 1 minute default."
        >
          <ConfigNumericInput
            value={naming?.timeoutMs}
            onChange={(value) =>
              handleChange("conversationNaming.timeoutMs", value ?? null)
            }
            displayAsMinutes
            positive
            name="conversationNaming.timeoutMs"
            aria-label="Naming timeout"
            aria-describedby="conversationNaming.timeoutMs-hint"
            onValidityChange={(valid) =>
              handleValidityChange("conversationNaming.timeoutMs", valid)
            }
            resetKey={formRevision}
          />
        </ConfigField>
      </SettingsSubSection>
    </SettingsPage>
  );
}
