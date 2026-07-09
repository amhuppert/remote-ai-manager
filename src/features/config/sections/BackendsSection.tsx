import {
  codexModelSchema,
  getEffortLevelsForBackend,
  type EffortLevel,
} from "@/lib/agent-backends/schemas";
import { ConfigField } from "../components/ConfigField";
import { ConfigNumericInput } from "../components/ConfigNumericInput";
import { ConfigPillGroup } from "../components/ConfigPillGroup";
import { ConfigToggle } from "../components/ConfigToggle";
import { SettingsPage } from "../components/SettingsPage";
import { SettingsSubSection } from "../components/SettingsSubSection";
import type { ConfigFormController } from "./types";

export function BackendsSection({
  controller,
}: {
  controller: ConfigFormController;
}): React.JSX.Element {
  const { formState, handleChange, isDefault, isModified } = controller;
  // Effort options track the selected model — the GPT-5.6 Sol-only "max"/"ultra"
  // levels appear only when Sol is the default model.
  const codexModel = formState.codex?.model ?? "gpt-5.4";
  const codexEffortOptions = getEffortLevelsForBackend("codex", codexModel);
  return (
    <SettingsPage
      title="Agent"
      accent="backends"
      sub="Per-backend runtime settings. Claude is always available; Codex is opt-in."
    >
      <SettingsSubSection
        title="Claude"
        hint="Claude SDK is bundled. Per-conversation defaults live under Agent defaults."
      >
        <div className="inline-flex w-fit items-center rounded-md border border-solid border-border-subtle bg-bg-base px-md py-[8px] font-mono text-[0.76rem] text-text-secondary">
          SDK is bundled and ready.
        </div>
      </SettingsSubSection>
      <SettingsSubSection title="Codex">
        <ConfigField
          label="Enable Codex"
          fieldPath="codex.enabled"
          isDefault={isDefault("codex.enabled")}
          isModified={isModified("codex.enabled")}
        >
          <ConfigToggle
            value={formState.codex?.enabled ?? false}
            onChange={(value) => handleChange("codex.enabled", value)}
          />
        </ConfigField>
        <ConfigField
          label="Default Codex model"
          fieldPath="codex.model"
          isDefault={isDefault("codex.model")}
          isModified={isModified("codex.model")}
        >
          <ConfigPillGroup
            value={codexModel}
            options={codexModelSchema.options}
            onChange={(value) => handleChange("codex.model", value)}
          />
        </ConfigField>
        <ConfigField
          label="Default Codex effort"
          fieldPath="codex.reasoningEffort"
          isDefault={isDefault("codex.reasoningEffort")}
          isModified={isModified("codex.reasoningEffort")}
        >
          <ConfigPillGroup
            value={
              (formState.codex?.reasoningEffort ?? "medium") as EffortLevel
            }
            options={codexEffortOptions}
            onChange={(value) => handleChange("codex.reasoningEffort", value)}
          />
        </ConfigField>
        <ConfigField
          label="Codex timeout"
          fieldPath="codex.timeoutMs"
          isDefault={isDefault("codex.timeoutMs")}
          isModified={isModified("codex.timeoutMs")}
          hint="Minutes. Empty means no timeout."
        >
          <ConfigNumericInput
            value={formState.codex?.timeoutMs}
            onChange={(value) => handleChange("codex.timeoutMs", value ?? null)}
            displayAsMinutes
            positive
          />
        </ConfigField>
      </SettingsSubSection>
    </SettingsPage>
  );
}
