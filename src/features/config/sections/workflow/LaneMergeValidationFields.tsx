import type { GraphWorkflowLaneMergeValidationConfig } from "@/lib/workflow-graph/config-schemas";
import type { ValidationCommandSummary } from "@/lib/validation/schemas";
import { LaneMergeCommandSelectorEditor } from "@/components/workflow-config/FieldEditors";
import { ConfigField } from "../../components/ConfigField";
import { ConfigPillGroup } from "../../components/ConfigPillGroup";

type LaneMergeStrategy = GraphWorkflowLaneMergeValidationConfig["strategy"];

const STRATEGY_VALUES = [
  "final-only",
  "every-merge",
] as const satisfies readonly LaneMergeStrategy[];

const STRATEGY_HINTS: Record<LaneMergeStrategy, string> = {
  "final-only": "Validate only the last merge of a join series",
  "every-merge": "Validate every lane merge in a join series",
};

// Cascades global → workflow ONLY (the lane-merge gate guards the shared
// fan-in target); there is deliberately no per-context tier for this block.
export function LaneMergeValidationFields({
  value,
  onChange,
  commandOptions,
}: {
  value: GraphWorkflowLaneMergeValidationConfig;
  onChange: (v: GraphWorkflowLaneMergeValidationConfig) => void;
  /** Registry summaries (global scope = union); undefined = unavailable. */
  commandOptions?: readonly ValidationCommandSummary[];
}) {
  return (
    <>
      <ConfigField
        label="Strategy"
        fieldPath="workflowDefaults.laneMergeValidation.strategy"
        isDefault={false}
        isModified={false}
        hint={STRATEGY_HINTS[value.strategy]}
      >
        <ConfigPillGroup
          value={value.strategy}
          options={STRATEGY_VALUES}
          onChange={(strategy) => onChange({ ...value, strategy })}
          aria-label="Lane-merge validation strategy"
        />
      </ConfigField>
      <ConfigField
        label="Commands"
        fieldPath="workflowDefaults.laneMergeValidation.commands"
        isDefault={false}
        isModified={false}
      >
        <LaneMergeCommandSelectorEditor
          value={value.commands}
          onChange={(commands) => onChange({ ...value, commands })}
          options={commandOptions}
        />
      </ConfigField>
    </>
  );
}
