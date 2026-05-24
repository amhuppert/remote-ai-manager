import type { GraphWorkflowIterationPolicy } from "@/lib/workflows/schemas";
import { ConfigField } from "../../components/ConfigField";
import { ConfigNumericInput } from "../../components/ConfigNumericInput";
import { ConfigToggle } from "../../components/ConfigToggle";

export function IterationPolicyFields({
  value,
  onChange,
}: {
  value: GraphWorkflowIterationPolicy;
  onChange: (v: GraphWorkflowIterationPolicy) => void;
}) {
  const continuityEnabled = value.continuity?.enabled ?? true;
  const continuityLimit = value.continuity?.contextLimitTokens;

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

      <ConfigField
        label="Continuity"
        fieldPath="workflowDefaults.iterationPolicy.continuity.enabled"
        isDefault={false}
        isModified={false}
      >
        <ConfigToggle
          value={continuityEnabled}
          onChange={(v) =>
            onChange({
              ...value,
              continuity: {
                enabled: v,
                ...(continuityLimit !== undefined
                  ? { contextLimitTokens: continuityLimit }
                  : {}),
              },
            })
          }
        />
      </ConfigField>

      <ConfigField
        label="Context limit tokens"
        fieldPath="workflowDefaults.iterationPolicy.continuity.contextLimitTokens"
        isDefault={false}
        isModified={false}
        hint="Leave empty for auto"
      >
        <ConfigNumericInput
          value={continuityLimit}
          onChange={(v) =>
            onChange({
              ...value,
              continuity: {
                enabled: continuityEnabled,
                ...(v !== undefined && v !== null
                  ? { contextLimitTokens: v }
                  : {}),
              },
            })
          }
          positive
          integer
        />
      </ConfigField>
    </>
  );
}
