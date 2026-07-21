import {
  effortLevelsForCatalogEntry,
  modelOptionsForCatalogEntry,
  type BackendCatalogEntry,
} from "@/lib/agent-backends/catalog";
import { useBackendCatalogQuery } from "@/lib/agent-backends/queries";
import type { EffortLevel } from "@/lib/agent-backends/schemas";
import { ConfigField } from "../components/ConfigField";
import { ConfigNumericInput } from "../components/ConfigNumericInput";
import { ConfigPillGroup } from "../components/ConfigPillGroup";
import { SettingsPage } from "../components/SettingsPage";
import { SettingsSubSection } from "../components/SettingsSubSection";
import type { ConfigFormController } from "./types";

interface BackendProfile {
  model: string;
  reasoningEffort?: EffortLevel;
  timeoutMs: number | null;
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
  const claudeEntry = backends.find((backend) => backend.id === "claude");
  const codexEntry = backends.find((backend) => backend.id === "codex");

  if (!claudeEntry || !codexEntry) {
    throw new Error("Backend catalog is missing a configured backend");
  }

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
      <SettingsSubSection
        title={claudeEntry.label}
        hint="Defaults used whenever a Claude conversation has no override."
      >
        <BackendProfileFields
          controller={controller}
          entry={claudeEntry}
          profile={formState.agentBackends.claude}
        />
      </SettingsSubSection>
      <SettingsSubSection
        title={codexEntry.label}
        hint="Defaults used whenever a Codex conversation has no override."
      >
        <BackendProfileFields
          controller={controller}
          entry={codexEntry}
          profile={formState.agentBackends.codex}
        />
      </SettingsSubSection>
    </SettingsPage>
  );
}
