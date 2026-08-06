"use client";

import { cn } from "@/lib/ui/cn";
import type {
  CollaborationAutonomousResolutionThreshold,
  WorkflowCollaborationConfig,
} from "@/lib/workflow-graph/collaboration-schemas";
import {
  PLAN_REPAIR_DEFAULT_AGENT,
  type AgentAssignment,
  type GraphWorkflowCircuitBreakerPolicy,
  type GraphWorkflowIterationPolicy,
  type GraphWorkflowPlanRepairPolicy,
  type ValidatorAssignment,
} from "@/lib/workflow-graph/config-schemas";
import { AgentRuntimeFields, AssignmentEditor } from "./AssignmentEditor";
import {
  FieldRow,
  NumericInput,
  ToggleControl,
  type EditorBaseProps,
} from "./FieldPrimitives";

// Reusable, feature-agnostic config field editors (docs/design/cc-cli/06 "UI
// plan"). Each is a controlled value+onChange component with no feature-level
// state, so it edits authored override blocks (workflow builder) or concrete
// resolved values (execution inspector) interchangeably.

/** Every assignment editor needs the same library scope and lock state. */
interface AssignmentEditorSurfaceProps {
  /** Scopes the profile listing; absent on the global-defaults form. */
  libraryProjectName?: string | null;
  /** Test/story affordance: Radix cannot open a listbox in jsdom on its own. */
  open?: boolean;
}

/**
 * The implementer use site: one assignment, no strategy (there is one way to
 * dispatch an implementer) and no continuity policy of its own.
 */
export function ImplementerEditor({
  value,
  onChange,
  readOnly,
  libraryProjectName,
  open,
}: EditorBaseProps<AgentAssignment> &
  AssignmentEditorSurfaceProps): React.JSX.Element {
  return (
    <AssignmentEditor
      value={value}
      onChange={onChange}
      audience="workflow_implementer"
      libraryProjectName={libraryProjectName}
      readOnly={readOnly}
      {...(open === undefined ? {} : { open })}
    />
  );
}

/**
 * Editor for ONE validator assignment: the shared assignment editor plus the
 * two axes only a validator has.
 *
 * Strategy and backend stay independent, so a Codex agent under conversation
 * strategy (or Claude under task) is authorable rather than implied by a
 * provider-named type.
 */
export function ContextValidatorEditor({
  value,
  onChange,
  readOnly,
  libraryProjectName,
  open,
}: EditorBaseProps<ValidatorAssignment> &
  AssignmentEditorSurfaceProps): React.JSX.Element {
  const continuityEnabled = value.continuity.enabled;
  const continuityLimit = value.continuity.contextLimitTokens;

  return (
    <div className="flex flex-col gap-sm">
      <AssignmentEditor
        value={value}
        onChange={(next) => onChange({ ...value, ...next })}
        strategy={{
          value: value.strategy,
          onChange: (strategy) => onChange({ ...value, strategy }),
        }}
        audience="workflow_validator"
        libraryProjectName={libraryProjectName}
        readOnly={readOnly}
        {...(open === undefined ? {} : { open })}
      />

      <FieldRow label="Continuity">
        <ToggleControl
          value={continuityEnabled}
          onChange={(next) =>
            onChange({
              ...value,
              continuity: {
                enabled: next,
                ...(continuityLimit !== undefined
                  ? { contextLimitTokens: continuityLimit }
                  : {}),
              },
            })
          }
          disabled={readOnly}
          ariaLabel={`Continuity enabled for ${value.id}`}
        />
      </FieldRow>

      <FieldRow label="Context limit tokens" hint="Leave empty for auto">
        <NumericInput
          value={continuityLimit}
          min={1}
          onChange={(next) =>
            onChange({
              ...value,
              continuity: {
                enabled: continuityEnabled,
                ...(next !== undefined ? { contextLimitTokens: next } : {}),
              },
            })
          }
          disabled={readOnly}
          ariaLabel={`Context limit tokens for ${value.id}`}
        />
      </FieldRow>
    </div>
  );
}

export function IterationPolicyEditor({
  value,
  onChange,
  readOnly,
}: EditorBaseProps<GraphWorkflowIterationPolicy>): React.JSX.Element {
  const continuityEnabled = value.continuity?.enabled ?? true;
  const continuityLimit = value.continuity?.contextLimitTokens;
  return (
    <div className="flex flex-col gap-sm">
      <FieldRow label="Max iterations">
        <NumericInput
          value={value.maxIterations}
          min={1}
          onChange={(next) => {
            if (next === undefined || next <= 0) return;
            onChange({ ...value, maxIterations: next });
          }}
          disabled={readOnly}
          ariaLabel="Max iterations"
        />
      </FieldRow>
      <FieldRow label="Continuity">
        <ToggleControl
          value={continuityEnabled}
          onChange={(next) =>
            onChange({
              ...value,
              continuity: {
                enabled: next,
                ...(continuityLimit !== undefined
                  ? { contextLimitTokens: continuityLimit }
                  : {}),
              },
            })
          }
          disabled={readOnly}
          ariaLabel="Iteration continuity enabled"
        />
      </FieldRow>
      <FieldRow label="Context limit tokens" hint="Leave empty for auto">
        <NumericInput
          value={continuityLimit}
          min={1}
          onChange={(next) =>
            onChange({
              ...value,
              continuity: {
                enabled: continuityEnabled,
                ...(next !== undefined ? { contextLimitTokens: next } : {}),
              },
            })
          }
          disabled={readOnly}
          ariaLabel="Iteration context limit tokens"
        />
      </FieldRow>
    </div>
  );
}

export function CircuitBreakerEditor({
  value,
  onChange,
  readOnly,
}: EditorBaseProps<GraphWorkflowCircuitBreakerPolicy>): React.JSX.Element {
  return (
    <div className="flex flex-col gap-sm">
      <FieldRow
        label="Failure threshold"
        hint="Consecutive failures before the context is halted"
      >
        <NumericInput
          value={value.consecutiveFailureThreshold}
          min={1}
          onChange={(next) => onChange({ consecutiveFailureThreshold: next })}
          disabled={readOnly}
          ariaLabel="Failure threshold"
        />
      </FieldRow>
    </div>
  );
}

export function PlanRepairEditor({
  value,
  onChange,
  readOnly,
}: EditorBaseProps<GraphWorkflowPlanRepairPolicy>): React.JSX.Element {
  return (
    <div className="flex flex-col gap-sm">
      <FieldRow
        label="Enabled"
        hint="Diagnose retry-exhaustion halts and repair the plan autonomously"
      >
        <ToggleControl
          value={value.enabled}
          onChange={(next) => onChange({ ...value, enabled: next })}
          disabled={readOnly}
          ariaLabel="Plan repair enabled"
        />
      </FieldRow>
      <FieldRow
        label="Max attempts"
        hint="Repair rounds per context before the halt sticks"
      >
        <NumericInput
          value={value.maxAttemptsPerContext}
          min={1}
          onChange={(next) => {
            if (next === undefined || next <= 0) return;
            onChange({ ...value, maxAttemptsPerContext: next });
          }}
          disabled={readOnly}
          ariaLabel="Max repair attempts"
        />
      </FieldRow>
      <FieldRow
        label="Custom agent"
        hint={
          value.agent
            ? undefined
            : `Off — uses the default repair agent (${PLAN_REPAIR_DEFAULT_AGENT.model}, ${PLAN_REPAIR_DEFAULT_AGENT.reasoningEffort} reasoning)`
        }
      >
        <ToggleControl
          value={value.agent !== undefined}
          onChange={(next) => {
            if (next) {
              onChange({ ...value, agent: { ...PLAN_REPAIR_DEFAULT_AGENT } });
            } else {
              const { agent: _agent, ...rest } = value;
              onChange(rest);
            }
          }}
          disabled={readOnly}
          ariaLabel="Custom repair agent"
        />
      </FieldRow>
      {value.agent ? (
        <AgentRuntimeFields
          value={value.agent}
          onChange={(agent) => onChange({ ...value, agent })}
          readOnly={readOnly}
        />
      ) : null}
    </div>
  );
}

const THRESHOLD_OPTIONS: ReadonlyArray<{
  value: CollaborationAutonomousResolutionThreshold;
  hint: string;
}> = [
  { value: "none", hint: "Always pause when there are conflicts" },
  { value: "minor", hint: "Auto-resolve only minor conflicts" },
  { value: "major", hint: "Auto-resolve up to major conflicts" },
  {
    value: "blocking",
    hint: "Auto-resolve everything, including blocking conflicts",
  },
];

function ThresholdSegmented({
  value,
  onChange,
  disabled,
  ariaLabel,
}: {
  value: CollaborationAutonomousResolutionThreshold;
  onChange: (next: CollaborationAutonomousResolutionThreshold) => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex w-full flex-wrap gap-[2px] rounded-md border border-solid border-border-subtle bg-bg-base p-[3px]"
    >
      {THRESHOLD_OPTIONS.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            className={cn(
              "min-h-[28px] flex-[1_1_auto] cursor-pointer appearance-none rounded-sm border-0 px-[10px] py-[4px] font-mono text-[0.7rem] tracking-[0.04em] uppercase transition-all duration-150 ease-[ease] disabled:cursor-not-allowed max-768:min-h-[44px]",
              active
                ? "bg-cyan font-semibold text-text-inverse"
                : "bg-transparent font-medium text-text-secondary enabled:hover:bg-bg-hover enabled:hover:text-text-primary",
            )}
            data-active={active ? "true" : "false"}
            title={option.hint}
            disabled={disabled}
            onClick={() => !disabled && onChange(option.value)}
          >
            {option.value}
          </button>
        );
      })}
    </div>
  );
}

export function CollaborationEditor({
  value,
  onChange,
  readOnly,
}: EditorBaseProps<WorkflowCollaborationConfig>): React.JSX.Element {
  const activeHint = THRESHOLD_OPTIONS.find(
    (option) => option.value === value.autonomousResolutionThreshold,
  )?.hint;

  return (
    <div className="flex flex-col gap-sm">
      <div className="flex flex-col gap-[4px]">
        <div className="font-mono text-[0.7rem] font-semibold tracking-[0.06em] text-text-tertiary uppercase">
          Second agent
        </div>
        <AgentRuntimeFields
          value={value.secondAgent}
          onChange={(next) => onChange({ ...value, secondAgent: next })}
          readOnly={readOnly}
        />
      </div>
      <FieldRow label="Negotiation rounds">
        <NumericInput
          value={value.negotiationRounds}
          min={1}
          onChange={(next) => {
            if (next === undefined || next <= 0) return;
            onChange({ ...value, negotiationRounds: next });
          }}
          disabled={readOnly}
          ariaLabel="Negotiation rounds"
        />
      </FieldRow>
      <FieldRow label="Auto-resolve threshold" hint={activeHint}>
        <ThresholdSegmented
          value={value.autonomousResolutionThreshold}
          onChange={(next) =>
            onChange({ ...value, autonomousResolutionThreshold: next })
          }
          disabled={readOnly}
          ariaLabel="Auto-resolve threshold"
        />
      </FieldRow>
    </div>
  );
}
