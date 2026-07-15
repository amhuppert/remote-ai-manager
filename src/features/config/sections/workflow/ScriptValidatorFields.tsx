import type { GraphWorkflowScriptValidatorConfig } from "@/lib/workflow-graph/config-schemas";
import { ConfigField } from "../../components/ConfigField";
import { ConfigToggle } from "../../components/ConfigToggle";

export function ScriptValidatorFields({
  value,
  onChange,
}: {
  value: GraphWorkflowScriptValidatorConfig;
  onChange: (v: GraphWorkflowScriptValidatorConfig) => void;
}) {
  return (
    <ConfigField
      label="Enabled"
      fieldPath="workflowDefaults.scriptValidator.enabled"
      isDefault={false}
      isModified={false}
      hint="Run the project's preMergeCommand before agent validation."
    >
      <ConfigToggle
        label="Script validator enabled"
        value={value.enabled}
        onChange={(enabled) => onChange({ enabled })}
      />
    </ConfigField>
  );
}
