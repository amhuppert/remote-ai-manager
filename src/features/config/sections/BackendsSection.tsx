import {
  backendSupportsFastMode,
  effortLevelsForCatalogEntry,
  modelOptionsForCatalogEntry,
  type BackendCatalogEntry,
} from "@/lib/agent-backends/catalog";
import { useBackendCatalogQuery } from "@/lib/agent-backends/queries";
import type { EffortLevel } from "@/lib/agent-backends/schemas";
import { ConfigField } from "../components/ConfigField";
import { ConfigNumericInput } from "../components/ConfigNumericInput";
import { ConfigPillGroup } from "../components/ConfigPillGroup";
import { ConfigToggle } from "../components/ConfigToggle";
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
  model: string;
  reasoningEffort?: EffortLevel;
  fastMode?: boolean;
  timeoutMs: number | null;
}

/** Codex's own speed default — the one backend that declares a fast mode. */
function CodexFastModeField({
  controller,
  fieldPath,
  fastMode,
}: {
  controller: ConfigFormController;
  fieldPath: string;
  fastMode: boolean;
}): React.JSX.Element {
  const { handleChange, isDefault, isModified } = controller;
  return (
    <ConfigField
      label="Codex fast mode"
      fieldPath={fieldPath}
      isDefault={isDefault(fieldPath)}
      isModified={isModified(fieldPath)}
      hint="Sets the initial speed for new Codex conversations. Fast mode uses more credits."
    >
      <ConfigToggle
        label="Codex fast mode"
        value={fastMode}
        onChange={(value) => handleChange(fieldPath, value)}
      />
    </ConfigField>
  );
}

function fallbackEffort(
  options: readonly EffortLevel[],
): EffortLevel | undefined {
  if (options.includes("high")) return "high";
  return options.at(-1);
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
    handleChangeMulti,
    handleValidityChange,
    isDefault,
    isModified,
  } = controller;
  const pathPrefix = `agentBackends.${entry.id}`;
  const modelPath = `${pathPrefix}.model`;
  const effortPath = `${pathPrefix}.reasoningEffort`;
  const fastModePath = `${pathPrefix}.fastMode`;
  const timeoutPath = `${pathPrefix}.timeoutMs`;
  const modelOptions = modelOptionsForCatalogEntry(entry, profile.model);
  const effortOptions = effortLevelsForCatalogEntry(entry, profile.model);
  const displayedEffort =
    profile.reasoningEffort ?? fallbackEffort(effortOptions);

  const handleModelChange = (model: string) => {
    const nextOptions = effortLevelsForCatalogEntry(entry, model);
    const currentEffort = profile.reasoningEffort;
    const nextEffort =
      currentEffort && nextOptions.includes(currentEffort)
        ? currentEffort
        : fallbackEffort(nextOptions);

    handleChangeMulti([
      [modelPath, model],
      [effortPath, nextEffort],
    ]);
  };

  return (
    <>
      <ConfigField
        label={`${entry.label} model`}
        fieldPath={modelPath}
        isDefault={isDefault(modelPath)}
        isModified={isModified(modelPath)}
      >
        <ConfigPillGroup
          value={profile.model}
          options={modelOptions.map((model) => model.id)}
          getOptionLabel={(model) =>
            modelOptions.find((option) => option.id === model)?.label ?? model
          }
          onChange={handleModelChange}
          aria-labelledby={`${modelPath}-label`}
        />
      </ConfigField>
      {effortOptions.length > 0 && displayedEffort ? (
        <ConfigField
          label={`${entry.label} effort`}
          fieldPath={effortPath}
          isDefault={isDefault(effortPath)}
          isModified={isModified(effortPath)}
        >
          <ConfigPillGroup
            value={displayedEffort}
            options={effortOptions}
            onChange={(value) => handleChange(effortPath, value)}
            aria-labelledby={`${effortPath}-label`}
          />
        </ConfigField>
      ) : null}
      {backendSupportsFastMode(entry.id) ? (
        <CodexFastModeField
          controller={controller}
          fieldPath={fastModePath}
          fastMode={profile.fastMode ?? false}
        />
      ) : null}
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
