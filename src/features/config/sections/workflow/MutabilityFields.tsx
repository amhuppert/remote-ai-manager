import type { GraphWorkflowMutabilityPolicy } from "@/lib/workflows/schemas";
import { ConfigField } from "../../components/ConfigField";
import { ConfigToggle } from "../../components/ConfigToggle";

export function MutabilityFields({
  value,
  onChange,
}: {
  value: GraphWorkflowMutabilityPolicy;
  onChange: (v: GraphWorkflowMutabilityPolicy) => void;
}) {
  return (
    <ConfigField
      label="Allow agent task add"
      fieldPath="workflowDefaults.mutability.allowAgentTaskAdd"
      isDefault={false}
      isModified={false}
      hint="Let agents add tasks during execution"
    >
      <ConfigToggle
        value={value.allowAgentTaskAdd}
        onChange={(v) => onChange({ allowAgentTaskAdd: v })}
      />
    </ConfigField>
  );
}
