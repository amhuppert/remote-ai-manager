import type { GraphWorkflowScriptValidatorConfig } from "@/lib/workflow-graph/config-schemas";
import type { ValidationCommandSummary } from "@/lib/validation/schemas";
import { CommandNameListEditor } from "@/components/workflow-config/FieldEditors";
import { ConfigField } from "../../components/ConfigField";

export function ScriptValidatorFields({
  value,
  onChange,
  commandOptions,
}: {
  value: GraphWorkflowScriptValidatorConfig;
  onChange: (v: GraphWorkflowScriptValidatorConfig) => void;
  /** Registry summaries (global scope = union); undefined = unavailable. */
  commandOptions?: readonly ValidationCommandSummary[];
}) {
  return (
    <ConfigField
      label="Commands"
      fieldPath="workflowDefaults.scriptValidator.commands"
      isDefault={false}
      isModified={false}
      hint="Ordered validation-registry commands for the script gate; runs stop at the first failure. An empty selection disables the gate."
    >
      <CommandNameListEditor
        value={value.commands}
        addLabel="Add script validator command"
        options={commandOptions}
        onChange={(commands) => onChange({ ...value, commands })}
      />
    </ConfigField>
  );
}
