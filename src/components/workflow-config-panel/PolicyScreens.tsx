"use client";

import { Switch } from "@/components/ui/Switch";
import { modelSelectionParametersLabel } from "@/components/model-selection-presentation";
import { NumericInput } from "@/components/workflow-config/FieldPrimitives";
import {
  PLAN_REPAIR_DEFAULT_AGENT,
  type GraphWorkflowPlanRepairPolicy,
} from "@/lib/workflow-graph/config-schemas";
import { ConfigAgentRuntimeRows } from "./AgentRuntimeRows";
import { isConfigLocked } from "./affordance";
import type { ConfigCascadeEditor } from "./cascade-editor";
import { blockSummaryParts, modelDisplayName } from "./config-summaries";
import { ConfigControlRow, ConfigDrillRow, ConfigRowGroup } from "./ConfigRow";
import { chipPart, textPart } from "./value-parts";

/**
 * How long a context is allowed to keep trying, what happens when it stops
 * succeeding, and what its agents may change while it runs (Config Panel
 * `policyRows()`, `planRepairRows()`).
 *
 * Everything here is block-granular, so each write carries its policy WHOLE —
 * which is exactly what makes the mutability row below load-bearing:
 * `allowAgentContextAdd` has no editor on this surface, and the only reason it
 * survives an edit to its sibling is that the write is built by spreading the
 * resolved block rather than assembling the fields this screen happens to know.
 */

export const PLAN_REPAIR_SCREEN_ID = "planrepair";

const CONTINUITY_HINT =
  "Keep one conversation across iterations, rotating it when the context limit is reached.";

const CONTEXT_LIMIT_HINT = "Leave empty for auto.";

const FAILURE_THRESHOLD_HINT =
  "Consecutive failures before the context is halted.";

const TASK_ADD_HINT = "Let agents add tasks during execution.";

const PRESERVED_FIELD_HINT =
  "Stored on the block and round-tripped unchanged. Not authored in this surface — an edit to Agent task add must not drop it.";

const PLAN_REPAIR_ENABLED_HINT =
  "Diagnose retry-exhaustion halts and repair the plan autonomously.";

const PLAN_REPAIR_ATTEMPTS_HINT =
  "Repair rounds per context before the halt sticks.";

/**
 * What "no custom agent" resolves to, named from the canonical fallback rather
 * than restated — the resolver's default and this sentence cannot drift.
 */
const PLAN_REPAIR_DEFAULT_HINT = `Off — uses the default repair agent (${modelDisplayName(
  PLAN_REPAIR_DEFAULT_AGENT.backend,
  PLAN_REPAIR_DEFAULT_AGENT.modelSelection.modelId,
)}, ${modelSelectionParametersLabel(PLAN_REPAIR_DEFAULT_AGENT.modelSelection)}).`;

export function ExecutionPolicyScreen({
  editor,
  onOpen,
}: {
  editor: ConfigCascadeEditor;
  onOpen: (screenId: string) => void;
}): React.JSX.Element {
  const { cascade } = editor;
  const locked = isConfigLocked(editor.affordance);
  const iteration = cascade.resolve("iterationPolicy").value;
  const breaker = cascade.resolve("circuitBreaker").value;
  const mutability = cascade.resolve("mutability").value;

  const iterationProvenance = cascade.provenance("iterationPolicy");
  const breakerProvenance = cascade.provenance("circuitBreaker");
  const mutabilityProvenance = cascade.provenance("mutability");

  return (
    <>
      <ConfigRowGroup label="Iteration">
        <ConfigControlRow
          rowId="policy-max-iterations"
          label="Max iterations"
          provenance={iterationProvenance}
          disabled={locked}
          onReset={() => editor.onEdit(cascade.reset("iterationPolicy"))}
          control={
            <NumericInput
              value={iteration.maxIterations}
              min={1}
              ariaLabel="Max iterations"
              disabled={locked}
              onChange={(next) => {
                // A cleared or half-typed field is not an iteration budget;
                // the row keeps showing the resolved value until one arrives.
                if (next === undefined || !Number.isInteger(next) || next < 1) {
                  return;
                }
                editor.onEdit(
                  cascade.set("iterationPolicy", {
                    ...iteration,
                    maxIterations: next,
                  }),
                );
              }}
            />
          }
        />
        <ConfigControlRow
          rowId="policy-continuity"
          label="Continuity"
          hint={CONTINUITY_HINT}
          provenance={iterationProvenance}
          disabled={locked}
          control={
            <Switch
              checked={iteration.continuity.enabled}
              disabled={locked}
              aria-label="Iteration continuity"
              onCheckedChange={(enabled) =>
                editor.onEdit(
                  cascade.set("iterationPolicy", {
                    ...iteration,
                    continuity: { ...iteration.continuity, enabled },
                  }),
                )
              }
            />
          }
        />
        <ConfigControlRow
          rowId="policy-context-limit"
          label="Context limit tokens"
          hint={CONTEXT_LIMIT_HINT}
          provenance={iterationProvenance}
          disabled={locked}
          control={
            <NumericInput
              value={iteration.continuity.contextLimitTokens}
              min={1}
              ariaLabel="Iteration context limit tokens"
              disabled={locked}
              onChange={(next) => {
                if (next === undefined) {
                  // Absence is what `auto` IS in the schema; a stored 0 would
                  // be a limit the runtime could never satisfy.
                  const continuity = { enabled: iteration.continuity.enabled };
                  editor.onEdit(
                    cascade.set("iterationPolicy", {
                      ...iteration,
                      continuity,
                    }),
                  );
                  return;
                }
                if (!Number.isInteger(next) || next < 1) return;
                editor.onEdit(
                  cascade.set("iterationPolicy", {
                    ...iteration,
                    continuity: {
                      ...iteration.continuity,
                      contextLimitTokens: next,
                    },
                  }),
                );
              }}
            />
          }
        />
      </ConfigRowGroup>

      <ConfigRowGroup label="Failure handling">
        <ConfigControlRow
          rowId="policy-failure-threshold"
          label="Failure threshold"
          hint={FAILURE_THRESHOLD_HINT}
          provenance={breakerProvenance}
          disabled={locked}
          onReset={() => editor.onEdit(cascade.reset("circuitBreaker"))}
          control={
            <NumericInput
              value={breaker.consecutiveFailureThreshold}
              min={1}
              ariaLabel="Failure threshold"
              disabled={locked}
              onChange={(next) => {
                if (next === undefined || !Number.isInteger(next) || next < 1) {
                  return;
                }
                editor.onEdit(
                  cascade.set("circuitBreaker", {
                    ...breaker,
                    consecutiveFailureThreshold: next,
                  }),
                );
              }}
            />
          }
        />
        <ConfigDrillRow
          screenId={PLAN_REPAIR_SCREEN_ID}
          label="Plan repair"
          parts={blockSummaryParts(cascade, "planRepair")}
          provenance={cascade.groupProvenance(["planRepair"])}
          onOpen={() => onOpen(PLAN_REPAIR_SCREEN_ID)}
        />
      </ConfigRowGroup>

      <ConfigRowGroup label="Mutability">
        <ConfigControlRow
          rowId="mutability-task-add"
          label="Agent task add"
          hint={TASK_ADD_HINT}
          provenance={mutabilityProvenance}
          disabled={locked}
          onReset={() => editor.onEdit(cascade.reset("mutability"))}
          control={
            <Switch
              checked={mutability.allowAgentTaskAdd}
              disabled={locked}
              aria-label="Agent task add"
              onCheckedChange={(allowAgentTaskAdd) =>
                editor.onEdit(
                  cascade.set("mutability", {
                    ...mutability,
                    allowAgentTaskAdd,
                  }),
                )
              }
            />
          }
        />
        {/* No editor, by design: this surface does not author graph-expansion
            authority. It is shown so an author can see the value their edit to
            the row above has to carry through (README §6). */}
        <ConfigControlRow
          rowId="mutability-context-add"
          label="allowAgentContextAdd"
          hint={PRESERVED_FIELD_HINT}
          parts={[
            textPart(mutability.allowAgentContextAdd ? "true" : "false", "dim"),
            chipPart("preserved"),
          ]}
          disabled
        />
      </ConfigRowGroup>
    </>
  );
}

export function PlanRepairScreen({
  editor,
}: {
  editor: ConfigCascadeEditor;
}): React.JSX.Element {
  const { cascade } = editor;
  const locked = isConfigLocked(editor.affordance);
  const policy = cascade.resolve("planRepair").value;
  const provenance = cascade.provenance("planRepair");

  const edit = (next: GraphWorkflowPlanRepairPolicy) =>
    editor.onEdit(cascade.set("planRepair", next));

  const toggleCustomAgent = (custom: boolean) => {
    if (custom) {
      edit({ ...policy, agent: PLAN_REPAIR_DEFAULT_AGENT });
      return;
    }
    // Absence is what "use the resolver's fallback" is in the schema; an empty
    // runtime is not a shape it accepts.
    const cleared = { ...policy };
    delete cleared.agent;
    edit(cleared);
  };

  return (
    <>
      <ConfigRowGroup label="Policy">
        <ConfigControlRow
          rowId="planrepair-enabled"
          label="Enabled"
          hint={PLAN_REPAIR_ENABLED_HINT}
          provenance={provenance}
          disabled={locked}
          onReset={() => editor.onEdit(cascade.reset("planRepair"))}
          control={
            <Switch
              checked={policy.enabled}
              disabled={locked}
              aria-label="Plan repair enabled"
              onCheckedChange={(enabled) => edit({ ...policy, enabled })}
            />
          }
        />
        <ConfigControlRow
          rowId="planrepair-attempts"
          label="Max attempts"
          hint={PLAN_REPAIR_ATTEMPTS_HINT}
          provenance={provenance}
          disabled={locked}
          control={
            <NumericInput
              value={policy.maxAttemptsPerContext}
              min={1}
              ariaLabel="Max attempts"
              disabled={locked}
              onChange={(next) => {
                if (next === undefined || !Number.isInteger(next) || next < 1) {
                  return;
                }
                edit({ ...policy, maxAttemptsPerContext: next });
              }}
            />
          }
        />
        <ConfigControlRow
          rowId="planrepair-custom-agent"
          label="Custom agent"
          hint={
            policy.agent === undefined ? PLAN_REPAIR_DEFAULT_HINT : undefined
          }
          provenance={provenance}
          disabled={locked}
          control={
            <Switch
              checked={policy.agent !== undefined}
              disabled={locked}
              aria-label="Custom repair agent"
              onCheckedChange={toggleCustomAgent}
            />
          }
        />
      </ConfigRowGroup>

      {policy.agent === undefined ? null : (
        <ConfigRowGroup label="Repair agent">
          <ConfigAgentRuntimeRows
            rowPrefix="planrepair-agent"
            value={policy.agent}
            onChange={(agent) => edit({ ...policy, agent })}
            provenance={provenance}
            disabled={locked}
          />
        </ConfigRowGroup>
      )}
    </>
  );
}
