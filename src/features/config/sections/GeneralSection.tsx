import { ConfigField } from "../components/ConfigField";
import { ConfigToggle } from "../components/ConfigToggle";
import { SettingsPage } from "../components/SettingsPage";
import { SettingsSubSection } from "../components/SettingsSubSection";
import type { ConfigFormController } from "./types";

export function GeneralSection({
  controller,
}: {
  controller: ConfigFormController;
}): React.JSX.Element {
  const { formState, handleChange, isDefault, isModified } = controller;
  return (
    <SettingsPage
      title="General"
      accent="settings"
      sub="Filesystem layout, branch naming and runtime networking."
    >
      <SettingsSubSection
        title="Workspace"
        hint="Where Command Center finds your repositories and how it names new branches."
      >
        <ConfigField
          label="Base directory"
          fieldPath="baseDir"
          isDefault={isDefault("baseDir")}
          isModified={isModified("baseDir")}
          hint="Repositories must live under this path."
        >
          <input
            className="form-input"
            type="text"
            value={formState.baseDir}
            onChange={(e) => handleChange("baseDir", e.target.value)}
          />
        </ConfigField>
        <ConfigField
          label="Branch prefix"
          fieldPath="branchPrefix"
          isDefault={isDefault("branchPrefix")}
          isModified={isModified("branchPrefix")}
          hint='Used when creating session branches (default: "csm").'
        >
          <input
            className="form-input"
            type="text"
            value={formState.branchPrefix ?? ""}
            onChange={(e) =>
              handleChange("branchPrefix", e.target.value || undefined)
            }
            placeholder="csm"
          />
        </ConfigField>
      </SettingsSubSection>
      <SettingsSubSection title="Infrastructure">
        <ConfigField
          label="Ignore patterns"
          fieldPath="ignorePatterns"
          isDefault={isDefault("ignorePatterns")}
          isModified={false}
          readOnly
          hint="Directories and globs excluded from worktree operations and indexing."
        >
          <div className="config-tags">
            {formState.ignorePatterns.map((pattern) => (
              <span key={pattern} className="config-tag">
                {pattern}
              </span>
            ))}
          </div>
        </ConfigField>
        <ConfigField
          label="Tailscale enabled"
          fieldPath="tailscaleEnabled"
          isDefault={isDefault("tailscaleEnabled")}
          isModified={isModified("tailscaleEnabled")}
          hint="Reach Command Center over your tailnet from a phone or laptop."
        >
          <ConfigToggle
            value={formState.tailscaleEnabled ?? false}
            onChange={(value) => handleChange("tailscaleEnabled", value)}
          />
        </ConfigField>
      </SettingsSubSection>
    </SettingsPage>
  );
}
