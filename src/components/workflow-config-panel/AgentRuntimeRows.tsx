"use client";

import BackendToggle from "@/components/BackendToggle";
import BackendExecutionWarning from "@/components/BackendExecutionWarning";
import { DesktopModelSelectionControls } from "@/components/session/prompt/ModelSelectionControls";
import { agentConfigForBackend } from "@/components/workflow-config/AssignmentEditor";
import { getConfiguredBackendModelCatalog } from "@/lib/agent-backends/catalog";
import {
  graphWorkflowAgentConfigSchema,
  type GraphWorkflowAgentConfig,
} from "@/lib/workflow-graph/config-schemas";
import { ConfigControlRow } from "./ConfigRow";
import type { ConfigRowProvenance } from "./row-provenance";

/**
 * Backend and one complete model selection, as two panel rows (Config Panel
 * `runtimeRows()`).
 *
 * Four blocks carry a concrete runtime — the implementer, the collaboration
 * second agent, a validator seat and the plan-repair agent — and every one of
 * them shows these same two rows under whichever block owns it. Backend and
 * selection are not cascade paths of their own, so the two rows share
 * the OWNING path's provenance and its tier chip.
 *
 * Whether they also carry its reset depends on where that path's reset already
 * lives. Under a block whose first row owns the reset (the implementer's
 * profile, a seat's cohort) they must not repeat it. `collaboration.secondAgent`
 * is different: it is a cascade FIELD whose only rows are these two, so its
 * caller passes `onReset` and the reset lands on the first of them — otherwise
 * the field could be promoted and never returned to inheritance (README §7).
 */

export interface ConfigAgentRuntimeRowsProps {
  /** Unique within a screen; two runtimes can share one screen. */
  rowPrefix: string;
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
  value,
  onChange,
  provenance,
  onReset,
  disabled = false,
}: ConfigAgentRuntimeRowsProps): React.JSX.Element {
  const catalog = getConfiguredBackendModelCatalog(
    value.backend,
    value.modelSelection,
  );

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
      >
        <BackendExecutionWarning backend={value.backend} />
      </ConfigControlRow>
      <ConfigControlRow
        rowId={`${rowPrefix}-model-selection`}
        label="Model selection"
        provenance={provenance}
        disabled={disabled}
        control={
          <DesktopModelSelectionControls
            catalog={catalog}
            selection={value.modelSelection}
            disabled={disabled}
            onSelectionChange={(modelSelection) =>
              onChange(
                graphWorkflowAgentConfigSchema.parse({
                  backend: value.backend,
                  modelSelection,
                }),
              )
            }
          />
        }
      />
    </>
  );
}
