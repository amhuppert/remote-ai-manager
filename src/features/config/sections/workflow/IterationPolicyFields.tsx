import type { GraphWorkflowIterationPolicy } from "@/lib/workflow-graph/config-schemas";
import { ConfigField } from "../../components/ConfigField";
import { ConfigNumericInput } from "../../components/ConfigNumericInput";

export function IterationPolicyFields({
  value,
  onChange,
}: {
  value: GraphWorkflowIterationPolicy;
  onChange: (v: GraphWorkflowIterationPolicy) => void;
}) {
  return (
    <>
      <ConfigField
        label="Max iterations"
        fieldPath="workflowDefaults.iterationPolicy.maxIterations"
        isDefault={false}
        isModified={false}
      >
        <ConfigNumericInput
          value={value.maxIterations}
          onChange={(v) =>
            onChange({
              ...value,
              maxIterations:
                typeof v === "number" && v > 0 ? v : value.maxIterations,
            })
          }
          required
          positive
          integer
        />
      </ConfigField>
    </>
  );
}
