import type { GraphWorkflowAgentValidationConfig } from "@/lib/workflow-graph/config-schemas";
import type { ValidationCommandSummary } from "@/lib/validation/schemas";
import { CommandSelectorEditor } from "@/components/workflow-config/FieldEditors";
import { ConfigField } from "../../components/ConfigField";

// Global tier of the per-role validation allowlists (validation-concurrency
// §6). Both roles are always present here — omission-means-inherit only
// applies to the workflow/context override tiers.
export function AgentValidationFields({
  value,
  onChange,
  commandOptions,
}: {
  value: GraphWorkflowAgentValidationConfig;
  onChange: (v: GraphWorkflowAgentValidationConfig) => void;
  /** Registry summaries (global scope = union); undefined = unavailable. */
  commandOptions?: readonly ValidationCommandSummary[];
}) {
  return (
    <>
      <ConfigField
        label="Implementer commands"
        fieldPath="workflowDefaults.agentValidation.implementer"
        isDefault={false}
        isModified={false}
        hint="Validation-registry commands the implementer agent may run — independent of the script gate's selection, so a TDD implementer keeps test access."
      >
        <CommandSelectorEditor
          value={value.implementer}
          onChange={(implementer) => onChange({ ...value, implementer })}
          roleLabel="Implementer"
          options={commandOptions}
        />
      </ConfigField>
      <ConfigField
        label="Context validator commands"
        fieldPath="workflowDefaults.agentValidation.contextValidator"
        isDefault={false}
        isModified={false}
        hint="Defaults to no commands — deterministic checks are the script gate's responsibility, not the validator's."
      >
        <CommandSelectorEditor
          value={value.contextValidator}
          onChange={(contextValidator) =>
            onChange({ ...value, contextValidator })
          }
          roleLabel="Context validator"
          options={commandOptions}
        />
      </ConfigField>
    </>
  );
}
