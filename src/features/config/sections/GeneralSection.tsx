import { FormInput } from "@/components/ui/FormField";
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
          <FormInput
            type="text"
            name="baseDir"
            aria-labelledby="baseDir-label"
            aria-describedby="baseDir-hint"
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
          <FormInput
            type="text"
            name="branchPrefix"
            aria-labelledby="branchPrefix-label"
            aria-describedby="branchPrefix-hint"
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
          <div className="flex min-h-[44px] flex-wrap gap-[6px] rounded-md border border-solid border-border-default bg-bg-base px-[10px] py-[8px]">
            {formState.ignorePatterns.map((pattern) => (
              <span
                key={pattern}
                className="inline-flex items-center rounded-sm border border-solid border-border-subtle bg-bg-raised px-[9px] py-[3px] font-mono text-[0.74rem] text-text-primary"
              >
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
            label="Tailscale enabled"
            value={formState.tailscaleEnabled ?? false}
            onChange={(value) => handleChange("tailscaleEnabled", value)}
          />
        </ConfigField>
      </SettingsSubSection>
    </SettingsPage>
  );
}
