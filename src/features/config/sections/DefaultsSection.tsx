import { useMemo } from "react";
import { ConfigField } from "../components/ConfigField";
import { ConfigPillGroup } from "../components/ConfigPillGroup";
import { SettingsPage } from "../components/SettingsPage";
import { SettingsSubSection } from "../components/SettingsSubSection";
import {
  getEffortOptionsForBackend,
  getModelOptionsForBackend,
} from "../config-helpers";
import type { ConfigFormController } from "./types";

export function DefaultsSection({
  controller,
}: {
  controller: ConfigFormController;
}): React.JSX.Element {
  const { formState, handleChange, handleChangeMulti, isDefault, isModified } =
    controller;

  const isCodexBackend = formState.defaultAgentBackend === "codex";
  const coreModelPath = isCodexBackend ? "codex.model" : "defaultModel";
  const coreEffortPath = isCodexBackend
    ? "codex.reasoningEffort"
    : "defaultEffort";
  const coreModelValue = isCodexBackend
    ? (formState.codex?.model ?? "gpt-5.4")
    : (formState.defaultModel ?? "opus");
  const coreEffortValue = isCodexBackend
    ? (formState.codex?.reasoningEffort ?? "medium")
    : (formState.defaultEffort ?? "medium");

  const effortOptions = useMemo(
    () =>
      getEffortOptionsForBackend(
        formState.defaultAgentBackend,
        formState.defaultAgentBackend === "codex"
          ? (formState.codex?.model ?? "gpt-5.4")
          : formState.defaultModel,
      ),
    [
      formState.defaultAgentBackend,
      formState.codex?.model,
      formState.defaultModel,
    ],
  );

  return (
    <SettingsPage
      title="Agent"
      accent="defaults"
      sub="What a new conversation looks like before any per-session override."
    >
      <SettingsSubSection
        title="Default backend"
        hint="Determines which model and effort options apply below."
      >
        <ConfigField
          label="Backend"
          fieldPath="defaultAgentBackend"
          isDefault={isDefault("defaultAgentBackend")}
          isModified={isModified("defaultAgentBackend")}
        >
          <ConfigPillGroup
            value={formState.defaultAgentBackend}
            options={["claude", "codex"] as const}
            onChange={(value) => {
              handleChangeMulti([
                ["defaultAgentBackend", value],
                ["defaultModel", undefined],
                ["defaultEffort", undefined],
              ]);
            }}
          />
        </ConfigField>
      </SettingsSubSection>
      <SettingsSubSection title="Model & reasoning">
        <ConfigField
          label="Model"
          fieldPath={coreModelPath}
          isDefault={isDefault(coreModelPath)}
          isModified={isModified(coreModelPath)}
        >
          <ConfigPillGroup
            value={coreModelValue}
            options={getModelOptionsForBackend(formState.defaultAgentBackend)}
            onChange={(value) => handleChange(coreModelPath, value)}
          />
        </ConfigField>
        {effortOptions.length > 0 ? (
          <ConfigField
            label="Effort"
            fieldPath={coreEffortPath}
            isDefault={isDefault(coreEffortPath)}
            isModified={isModified(coreEffortPath)}
          >
            <ConfigPillGroup
              value={coreEffortValue}
              options={effortOptions}
              onChange={(value) => handleChange(coreEffortPath, value)}
            />
          </ConfigField>
        ) : null}
      </SettingsSubSection>
    </SettingsPage>
  );
}
