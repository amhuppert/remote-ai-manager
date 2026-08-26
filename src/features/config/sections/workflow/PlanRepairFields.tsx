import {
  PLAN_REPAIR_DEFAULT_AGENT,
  type GraphWorkflowPlanRepairPolicy,
} from "@/lib/workflow-graph/config-schemas";
import { modelSelectionParametersLabel } from "@/components/model-selection-presentation";
import { modelDisplayLabel } from "@/lib/agent-backends/catalog";
import { ConfigField } from "../../components/ConfigField";
import { ConfigNumericInput } from "../../components/ConfigNumericInput";
import { ConfigToggle } from "../../components/ConfigToggle";
import { AgentConfigFields } from "./AgentConfigFields";

export function PlanRepairFields({
  value,
  onChange,
}: {
  value: GraphWorkflowPlanRepairPolicy;
  onChange: (v: GraphWorkflowPlanRepairPolicy) => void;
}) {
  return (
    <>
      <ConfigField
        label="Plan repair enabled"
        fieldPath="workflowDefaults.planRepair.enabled"
        isDefault={false}
        isModified={false}
        hint="Diagnose retry-exhaustion halts and repair the plan autonomously"
      >
        <ConfigToggle
          label="Plan repair enabled"
          value={value.enabled}
          onChange={(v) => onChange({ ...value, enabled: v })}
        />
      </ConfigField>

      <ConfigField
        label="Max attempts per context"
        fieldPath="workflowDefaults.planRepair.maxAttemptsPerContext"
        isDefault={false}
        isModified={false}
        hint="Repair rounds per context before the halt sticks"
      >
        <ConfigNumericInput
          value={value.maxAttemptsPerContext}
          onChange={(v) => {
            if (typeof v !== "number" || v <= 0) return;
            onChange({ ...value, maxAttemptsPerContext: v });
          }}
          positive
          integer
        />
      </ConfigField>

      <ConfigField
        label="Custom repair agent"
        fieldPath="workflowDefaults.planRepair.agent"
        isDefault={false}
        isModified={false}
        hint={
          value.agent
            ? undefined
            : `Off — uses the default repair agent (${modelDisplayLabel(PLAN_REPAIR_DEFAULT_AGENT.backend, PLAN_REPAIR_DEFAULT_AGENT.modelSelection.modelId)}, ${modelSelectionParametersLabel(PLAN_REPAIR_DEFAULT_AGENT.modelSelection)})`
        }
      >
        <ConfigToggle
          label="Custom repair agent"
          value={value.agent !== undefined}
          onChange={(v) => {
            if (v) {
              onChange({ ...value, agent: { ...PLAN_REPAIR_DEFAULT_AGENT } });
            } else {
              const { agent: _agent, ...rest } = value;
              onChange(rest);
            }
          }}
        />
      </ConfigField>

      {value.agent ? (
        <AgentConfigFields
          value={value.agent}
          onChange={(agent) => onChange({ ...value, agent })}
          fieldPathPrefix="workflowDefaults.planRepair.agent"
        />
      ) : null}
    </>
  );
}
