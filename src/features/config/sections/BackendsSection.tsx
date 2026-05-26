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
        <div className="config-readout">SDK is bundled and ready.</div>
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
            value={formState.codex?.model ?? "gpt-5.4"}
            options={
              ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"] as const
            }
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
            value={formState.codex?.reasoningEffort ?? "medium"}
            options={["minimal", "low", "medium", "high", "xhigh"] as const}
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
