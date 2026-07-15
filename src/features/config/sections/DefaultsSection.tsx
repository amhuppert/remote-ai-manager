import { useMemo } from "react";
import { effortLevelsForCatalogEntry } from "@/lib/agent-backends/catalog";
import { useBackendCatalogQuery } from "@/lib/agent-backends/queries";
import { ConfigField } from "../components/ConfigField";
import { ConfigPillGroup } from "../components/ConfigPillGroup";
import { SettingsPage } from "../components/SettingsPage";
import { SettingsSubSection } from "../components/SettingsSubSection";
import type { ConfigFormController } from "./types";

export function DefaultsSection({
  controller,
}: {
  controller: ConfigFormController;
}): React.JSX.Element {
  const { formState, handleChange, handleChangeMulti, isDefault, isModified } =
    controller;

  const { data: backends } = useBackendCatalogQuery();
  const entry = backends.find((b) => b.id === formState.defaultAgentBackend);
  if (!entry) {
    throw new Error(`Unknown agent backend: ${formState.defaultAgentBackend}`);
  }

  // The on-disk config stores Codex model/effort under the `codex` block while
  // Claude uses the top-level defaults (config.json shape is frozen, D7) — the
  // storage path is config-schema-shaped, not catalog-driven.
  const isCodexBackend = entry.id === "codex";
  const coreModelPath = isCodexBackend ? "codex.model" : "defaultModel";
  const coreEffortPath = isCodexBackend
    ? "codex.reasoningEffort"
    : "defaultEffort";
  const coreModelValue =
    (isCodexBackend ? formState.codex?.model : formState.defaultModel) ??
    entry.defaultModelId;
  const coreEffortValue = isCodexBackend
    ? (formState.codex?.reasoningEffort ?? "medium")
    : (formState.defaultEffort ?? "medium");

  const effortOptions = useMemo(
    () => effortLevelsForCatalogEntry(entry, coreModelValue),
    [entry, coreModelValue],
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
            options={backends.map((b) => b.id)}
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
            options={entry.models.map((m) => m.id)}
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
