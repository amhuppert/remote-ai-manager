import {
  CohortEditor,
  toggleCohortEnabled,
} from "@/components/workflow-config/CohortEditor";
import type { ValidatorCohort } from "@/lib/workflow-graph/config-schemas";
import { ConfigField } from "../../components/ConfigField";
import { ConfigToggle } from "../../components/ConfigToggle";

/**
 * Global-tier editor for the validator cohort.
 *
 * It composes the same cohort editor the workflow builder and the runtime
 * pause-to-edit surface render (D11), so the ordered set an operator authors
 * here is authored the same way at every tier — a defaults form that could only
 * edit the first assignment would make the seeded single reviewer look like the
 * only shape the global tier supports.
 *
 * Its provenance line carries only the two states this tier can be in — in use,
 * or switched off — because nothing sits above the global defaults for them to
 * inherit from. `enabled` stays a field of its own, like every other Settings
 * toggle, and flips through the shared helper that keeps the dormant
 * assignments.
 */
export function ContextValidatorFields({
  value,
  onChange,
}: {
  value: ValidatorCohort;
  onChange: (v: ValidatorCohort) => void;
}) {
  return (
    <>
      <ConfigField
        label="Enabled"
        fieldPath="workflowDefaults.contextValidator.enabled"
        isDefault={false}
        isModified={false}
        hint="Turning validation off keeps the cohort — every assignment returns, in order, when you turn it back on."
      >
        <ConfigToggle
          label="Context validator enabled"
          value={value.enabled}
          onChange={(enabled) => onChange(toggleCohortEnabled(value, enabled))}
        />
      </ConfigField>

      <ConfigField
        label="Cohort"
        fieldPath="workflowDefaults.contextValidator.assignments"
        isDefault={false}
        isModified={false}
        hint="Every required validator reviews the same frozen candidate, in this order."
      >
        <CohortEditor
          value={value}
          onChange={onChange}
          cascade={{
            state: value.enabled ? "use" : "disabled",
            origin: "every workflow that does not override it",
          }}
        />
      </ConfigField>
    </>
  );
}
