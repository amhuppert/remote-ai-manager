import type {
  CollaborationAutonomousResolutionThreshold,
  WorkflowCollaborationConfig,
} from "@/lib/workflows/schemas";
import { ConfigField } from "../../components/ConfigField";
import { ConfigNumericInput } from "../../components/ConfigNumericInput";
import { ConfigPillGroup } from "../../components/ConfigPillGroup";
import { AgentConfigFields } from "./AgentConfigFields";

const THRESHOLD_VALUES = [
  "none",
  "minor",
  "major",
  "blocking",
] as const satisfies readonly CollaborationAutonomousResolutionThreshold[];

const THRESHOLD_HINTS: Record<
  CollaborationAutonomousResolutionThreshold,
  string
> = {
  none: "Always pause when there are conflicts",
  minor: "Auto-resolve only minor conflicts",
  major: "Auto-resolve up to major conflicts",
  blocking: "Auto-resolve everything, including blocking conflicts",
};

export function CollaborationFields({
  value,
  onChange,
}: {
  value: WorkflowCollaborationConfig;
  onChange: (v: WorkflowCollaborationConfig) => void;
}) {
  return (
    <>
      <AgentConfigFields
        value={value.secondAgent}
        onChange={(secondAgent) => onChange({ ...value, secondAgent })}
        fieldPathPrefix="workflowDefaults.collaboration.secondAgent"
      />

      <ConfigField
        label="Negotiation rounds"
        fieldPath="workflowDefaults.collaboration.negotiationRounds"
        isDefault={false}
        isModified={false}
      >
        <ConfigNumericInput
          value={value.negotiationRounds}
          onChange={(v) =>
            onChange({
              ...value,
              negotiationRounds:
                typeof v === "number" && v > 0 ? v : value.negotiationRounds,
            })
          }
          required
          positive
          integer
        />
      </ConfigField>

      <ConfigField
        label="Auto-resolve threshold"
        fieldPath="workflowDefaults.collaboration.autonomousResolutionThreshold"
        isDefault={false}
        isModified={false}
        hint={THRESHOLD_HINTS[value.autonomousResolutionThreshold]}
      >
        <ConfigPillGroup
          value={value.autonomousResolutionThreshold}
          options={THRESHOLD_VALUES}
          onChange={(threshold) =>
            onChange({ ...value, autonomousResolutionThreshold: threshold })
          }
        />
      </ConfigField>
    </>
  );
}
