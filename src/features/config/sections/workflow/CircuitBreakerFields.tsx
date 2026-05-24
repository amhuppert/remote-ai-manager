import type { GraphWorkflowCircuitBreakerPolicy } from "@/lib/workflows/schemas";
import { ConfigField } from "../../components/ConfigField";
import { ConfigNumericInput } from "../../components/ConfigNumericInput";

export function CircuitBreakerFields({
  value,
  onChange,
}: {
  value: GraphWorkflowCircuitBreakerPolicy;
  onChange: (v: GraphWorkflowCircuitBreakerPolicy) => void;
}) {
  return (
    <ConfigField
      label="Failure threshold"
      fieldPath="workflowDefaults.circuitBreaker.consecutiveFailureThreshold"
      isDefault={false}
      isModified={false}
      hint="Consecutive failures before the context is halted"
    >
      <ConfigNumericInput
        value={value.consecutiveFailureThreshold}
        onChange={(v) =>
          onChange({
            consecutiveFailureThreshold: typeof v === "number" ? v : undefined,
          })
        }
        positive
        integer
      />
    </ConfigField>
  );
}
