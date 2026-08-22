"use client";

import BackendToggle from "@/components/BackendToggle";
import ModelSelector from "@/components/ModelSelector";
import ReasoningLevelSelector from "@/components/ReasoningLevelSelector";
import { agentConfigForBackend } from "@/components/workflow-config/AssignmentEditor";
import { getEffortLevelsForBackend } from "@/lib/agent-backends/catalog";
import type { EffortLevel } from "@/lib/agent-backends/schemas";
import {
  graphWorkflowAgentConfigSchema,
  type GraphWorkflowAgentConfig,
} from "@/lib/workflow-graph/config-schemas";
import { ConfigControlRow } from "./ConfigRow";
import type { ConfigRowProvenance } from "./row-provenance";

/**
 * Backend · Model · Reasoning effort, as three panel rows (Config Panel
 * `runtimeRows()`).
 *
 * Four blocks carry a concrete runtime — the implementer, the collaboration
 * second agent, a validator seat and the plan-repair agent — and every one of
 * them shows these same three rows under whichever block owns it. Backend,
 * model and effort are not cascade paths of their own, so the three rows share
 * the OWNING path's provenance and its tier chip.
 *
 * Whether they also carry its reset depends on where that path's reset already
 * lives. Under a block whose first row owns the reset (the implementer's
 * profile, a seat's cohort) they must not repeat it. `collaboration.secondAgent`
 * is different: it is a cascade FIELD whose only rows are these three, so its
 * caller passes `onReset` and the reset lands on the first of them — otherwise
 * the field could be promoted and never returned to inheritance (README §7).
 */

/**
 * Move one field of a runtime, refusing a pair the schema would not accept.
 *
 * The selectors only ever offer options the catalog lists for the current
 * backend and model, so a refusal here is unreachable from the UI; parsing is
 * what lets the panel narrow a per-backend discriminated union without a cast.
 */
function withRuntimeField(
  agent: GraphWorkflowAgentConfig,
  patch: { model: string } | { reasoningEffort: EffortLevel },
): GraphWorkflowAgentConfig {
  const parsed = graphWorkflowAgentConfigSchema.safeParse({
    ...agent,
    ...patch,
  });
  return parsed.success ? parsed.data : agent;
}

export interface ConfigAgentRuntimeRowsProps {
  /** Unique within a screen; two runtimes can share one screen. */
  rowPrefix: string;
  /** Names the runtime in each control's accessible name. */
  agentLabel: string;
  value: GraphWorkflowAgentConfig;
  onChange: (next: GraphWorkflowAgentConfig) => void;
  /** The owning block's provenance — the tier chip and edge these rows wear. */
  provenance: ConfigRowProvenance;
  /**
   * Clears the owning path's override. Supplied only when these rows are the
   * whole of that path, so the reset has nowhere else to live.
   */
  onReset?: () => void;
  disabled?: boolean;
}

export function ConfigAgentRuntimeRows({
  rowPrefix,
  agentLabel,
  value,
  onChange,
  provenance,
  onReset,
  disabled = false,
}: ConfigAgentRuntimeRowsProps): React.JSX.Element {
  const effortLevels = getEffortLevelsForBackend(value.backend, value.model);

  return (
    <>
      <ConfigControlRow
        rowId={`${rowPrefix}-backend`}
        label="Backend"
        provenance={provenance}
        disabled={disabled}
        {...(onReset === undefined ? {} : { onReset })}
        control={
          <BackendToggle
            value={value.backend}
            disabled={disabled}
            touch
            onChange={(backend) => {
              if (backend === value.backend) return;
              onChange(agentConfigForBackend(backend));
            }}
          />
        }
      />
      <ConfigControlRow
        rowId={`${rowPrefix}-model`}
        label="Model"
        provenance={provenance}
        disabled={disabled}
        control={
          <ModelSelector
            value={value.model}
            backend={value.backend}
            disabled={disabled}
            onChange={(model) => onChange(withRuntimeField(value, { model }))}
          />
        }
      />
      <ConfigControlRow
        rowId={`${rowPrefix}-effort`}
        label="Reasoning effort"
        provenance={provenance}
        disabled={disabled}
        control={
          <ReasoningLevelSelector
            value={value.reasoningEffort}
            availableLevels={effortLevels}
            disabled={disabled}
            disabledTooltip={`Reasoning effort for ${agentLabel}`}
            onChange={(reasoningEffort) =>
              onChange(withRuntimeField(value, { reasoningEffort }))
            }
          />
        }
      />
    </>
  );
}
