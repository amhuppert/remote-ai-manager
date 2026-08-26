import {
  getConfiguredBackendModelCatalog,
  type BackendCatalogEntry,
} from "@/lib/agent-backends/catalog";
import { useBackendCatalogQuery } from "@/lib/agent-backends/queries";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import {
  CatalogModelSelect,
  ModelOptionsEditor,
} from "@/components/session/prompt/ModelSelectionControls";
import { ConfigField } from "../components/ConfigField";
import { ConfigNumericInput } from "../components/ConfigNumericInput";
import { ConfigPillGroup } from "../components/ConfigPillGroup";
import { SettingsPage } from "../components/SettingsPage";
import { SettingsSubSection } from "../components/SettingsSubSection";
import type { ConfigFormController } from "./types";

/**
 * The profile fields this section edits, as the structural subset every
 * registered backend's persisted profile satisfies. Provider-specific options
 * are optional here and rendered by their own owned field component, so a
 * backend that does not declare one simply never reaches it — no profile carries
 * a credential, which is read from the server environment and never persisted
 * (spec R12.2).
 */
interface BackendProfile {
  modelSelection: BackendModelSelection;
  timeoutMs: number | null;
}

function BackendProfileFields({
  controller,
  entry,
  profile,
}: {
  controller: ConfigFormController;
  entry: BackendCatalogEntry;
  profile: BackendProfile;
}): React.JSX.Element {
  const {
    formRevision,
    handleChange,
    handleValidityChange,
    isDefault,
    isModified,
  } = controller;
  const pathPrefix = `agentBackends.${entry.id}`;
  const modelSelectionPath = `${pathPrefix}.modelSelection`;
  const timeoutPath = `${pathPrefix}.timeoutMs`;
  const catalog = getConfiguredBackendModelCatalog(
    entry.id,
    profile.modelSelection,
  );
  const selectedModel = catalog.models.find(
    ({ id, aliases }) =>
      id === profile.modelSelection.modelId ||
      aliases.includes(profile.modelSelection.modelId),
  );
  const hasConfigurableParameters = selectedModel?.parameters.some(
    ({ prominence, values }) => prominence !== "hidden" && values.length > 1,
  );
  const applySelection = (selection: BackendModelSelection): void => {
    handleChange(modelSelectionPath, selection);
  };

  return (
    <>
      <ConfigField
        label={`${entry.label} model selection`}
        fieldPath={modelSelectionPath}
        isDefault={isDefault(modelSelectionPath)}
        isModified={isModified(modelSelectionPath)}
      >
        <CatalogModelSelect
          catalog={catalog}
          selection={profile.modelSelection}
          onSelectionChange={applySelection}
        />
        {hasConfigurableParameters ? (
          <div className="mt-md max-w-[420px]">
            <ModelOptionsEditor
              catalog={catalog}
              selection={profile.modelSelection}
              onApply={applySelection}
            />
          </div>
        ) : null}
      </ConfigField>
      <ConfigField
        label={`${entry.label} timeout`}
        fieldPath={timeoutPath}
        isDefault={isDefault(timeoutPath)}
        isModified={isModified(timeoutPath)}
        hint="Minutes. Empty means no timeout."
      >
        <ConfigNumericInput
          value={profile.timeoutMs}
          onChange={(value) => handleChange(timeoutPath, value ?? null)}
          name={timeoutPath}
          aria-label={`${entry.label} timeout`}
          aria-describedby={`${timeoutPath}-hint`}
          onValidityChange={(valid) => handleValidityChange(timeoutPath, valid)}
          resetKey={formRevision}
          displayAsMinutes
          positive
        />
      </ConfigField>
    </>
  );
}

export function BackendsSection({
  controller,
}: {
  controller: ConfigFormController;
}): React.JSX.Element {
  const { formState, handleChange, isDefault, isModified } = controller;
  const { data: backends } = useBackendCatalogQuery();

  return (
    <SettingsPage
      title="Agent"
      accent="backends"
      sub="Choose the conversation default and configure each backend independently."
    >
      <SettingsSubSection
        title="Default backend"
        hint="Sets the backend for new conversations. Backend profiles remain independent."
      >
        <ConfigField
          label="Backend"
          fieldPath="defaultAgentBackend"
          isDefault={isDefault("defaultAgentBackend")}
          isModified={isModified("defaultAgentBackend")}
        >
          <ConfigPillGroup
            value={formState.defaultAgentBackend}
            options={backends.map((backend) => backend.id)}
            onChange={(value) => handleChange("defaultAgentBackend", value)}
            aria-labelledby="defaultAgentBackend-label"
          />
        </ConfigField>
      </SettingsSubSection>
      {backends.map((entry) => (
        <SettingsSubSection
          key={entry.id}
          title={entry.label}
          hint={`Defaults used to initialize new ${entry.label} conversations.`}
        >
          <BackendProfileFields
            controller={controller}
            entry={entry}
            profile={formState.agentBackends[entry.id]}
          />
        </SettingsSubSection>
      ))}
    </SettingsPage>
  );
}
