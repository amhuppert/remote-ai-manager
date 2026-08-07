"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { CheckboxField } from "@/components/ui/Checkbox";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/SegmentedControl";
import { cn } from "@/lib/ui/cn";
import {
  validationCommandNameSchema,
  type ValidationCommandSummary,
} from "@/lib/validation/schemas";
import type {
  CollaborationAutonomousResolutionThreshold,
  WorkflowCollaborationConfig,
} from "@/lib/workflow-graph/collaboration-schemas";
import {
  PLAN_REPAIR_DEFAULT_AGENT,
  type AgentAssignment,
  type GraphWorkflowAgentValidationConfig,
  type GraphWorkflowCircuitBreakerPolicy,
  type GraphWorkflowCommandSelector,
  type GraphWorkflowIterationPolicy,
  type GraphWorkflowLaneMergeCommandSelector,
  type GraphWorkflowLaneMergeValidationConfig,
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
 * axes only a validator has.
 *
 * Strategy and backend stay independent, so a Codex agent under conversation
 * strategy (or Claude under task) is authorable rather than implied by a
 * provider-named type. Authority is handed down as a control for the same
 * reason strategy is — it exists only where a verdict does, and the shared
 * editor must not assume every assignment carries one.
 *
 * The shared editor's result is FORWARDED, never merged over the current value:
 * it returns this validator assignment whole, and merging would restore an
 * optional key the author cleared (instructions) from the stale value.
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
        onChange={onChange}
        strategy={{
          value: value.strategy,
          onChange: (strategy) => onChange({ ...value, strategy }),
        }}
        authority={{
          value: value.authority,
          onChange: (authority) => onChange({ ...value, authority }),
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

// ============================================================
// Validation command selection (design: validation-concurrency §6)
// ============================================================

const COMMAND_HINT_CLASS =
  "font-mono text-[0.7rem] leading-[1.5] text-text-tertiary";

/**
 * Ordered validation-registry command-name list.
 *
 * With `options` (the registry summaries for the editing scope) this is a
 * command multi-select: a checkbox per registered command (annotated with its
 * admission cost) toggles membership, appending on check so the chip row keeps
 * showing run order. Selected names missing from the registry render as
 * removable chips marked "unregistered" — they will fail closed server-side.
 *
 * Without `options` the registry is unavailable (fetch pending/failed), so the
 * editor falls back to free-form entry: names are checked for shape only
 * (kebab-case) and unknown names are rejected server-side at the project-bound
 * boundaries (create/replace/start/live-edit).
 */
export function CommandNameListEditor({
  value,
  onChange,
  disabled,
  addLabel,
  options,
}: {
  value: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /** Accessible name for the add input (e.g. "Add script validator command"). */
  addLabel: string;
  /** Registry summaries for this scope; undefined = registry unavailable. */
  options?: readonly ValidationCommandSummary[];
}): React.JSX.Element {
  const [text, setText] = useState("");
  const name = text.trim();
  const canAdd =
    !disabled &&
    name.length > 0 &&
    validationCommandNameSchema.safeParse(name).success &&
    !value.includes(name);

  const add = () => {
    if (!canAdd) return;
    onChange([...value, name]);
    setText("");
  };

  const registered =
    options !== undefined
      ? new Set(options.map((option) => option.name))
      : null;

  return (
    <div className="flex min-w-0 flex-col gap-xs">
      {value.length > 0 ? (
        <ul className="m-0 flex list-none flex-wrap gap-xs p-0">
          {value.map((command) => (
            <li
              key={command}
              className="inline-flex items-center gap-[5px] rounded-full border border-solid border-border-subtle bg-bg-raised py-[2px] pr-[4px] pl-[9px] font-mono text-[0.72rem] text-text-primary"
            >
              {command}
              {registered !== null && !registered.has(command) ? (
                <span
                  className="font-mono text-[0.6rem] font-semibold tracking-[0.06em] text-amber uppercase"
                  data-testid="command-chip-unregistered"
                >
                  unregistered
                </span>
              ) : null}
              <button
                type="button"
                aria-label={`Remove ${command}`}
                className="inline-flex size-[16px] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 font-mono text-[0.72rem] leading-none text-text-tertiary transition-colors duration-150 focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 enabled:hover:bg-bg-hover enabled:hover:text-red disabled:cursor-not-allowed disabled:opacity-40"
                disabled={disabled}
                onClick={() =>
                  onChange(value.filter((entry) => entry !== command))
                }
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {options !== undefined ? (
        options.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-xs p-0">
            {options.map((option) => {
              const checked = value.includes(option.name);
              return (
                <li key={option.name}>
                  <CheckboxField
                    label={option.name}
                    description={`cost ${option.cost}${
                      option.description ? ` — ${option.description}` : ""
                    }`}
                    checked={checked}
                    disabled={disabled}
                    onCheckedChange={(next) => {
                      if (next === true && !checked) {
                        onChange([...value, option.name]);
                      } else if (next !== true && checked) {
                        onChange(
                          value.filter((entry) => entry !== option.name),
                        );
                      }
                    }}
                  />
                </li>
              );
            })}
          </ul>
        ) : (
          <div className={COMMAND_HINT_CLASS}>
            No validation commands are registered for this scope.
          </div>
        )
      ) : (
        <div className="flex items-center gap-xs">
          <input
            type="text"
            className="w-[170px] rounded-sm border border-solid border-border-default bg-bg-surface px-[10px] py-[5px] font-mono text-[0.72rem] text-text-primary transition-[border-color] duration-150 outline-none focus:border-cyan focus:shadow-[0_0_0_1px_var(--cyan-glow)] disabled:cursor-not-allowed disabled:opacity-60"
            value={text}
            placeholder="command-name"
            aria-label={addLabel}
            disabled={disabled}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                add();
              }
            }}
          />
          <Button variant="ghost" size="sm" disabled={!canAdd} onClick={add}>
            Add
          </Button>
        </div>
      )}
    </div>
  );
}

function commandSelectorNames(
  selector: GraphWorkflowCommandSelector,
): readonly string[] {
  return selector.mode === "all" ? selector.except : selector.commands;
}

function commandSelectorHint(selector: GraphWorkflowCommandSelector): string {
  if (selector.mode === "all") {
    return selector.except.length === 0
      ? "Every registered validation command is allowed — including future registrations."
      : "Every registered validation command is allowed except the listed names.";
  }
  return selector.commands.length === 0
    ? "No validation commands are allowed."
    : "Only the listed commands are allowed.";
}

/**
 * Discriminated command selector: `all except […]` opts into future registry
 * additions; `only […]` is stable and fail-closed. Switching modes resets the
 * name list — the two lists mean opposite things.
 */
export function CommandSelectorEditor({
  value,
  onChange,
  readOnly,
  roleLabel,
  options,
}: {
  value: GraphWorkflowCommandSelector;
  onChange: (next: GraphWorkflowCommandSelector) => void;
  readOnly?: boolean;
  /** Names the control group for assistive tech (e.g. "Implementer"). */
  roleLabel: string;
  /** Registry summaries for this scope; undefined = registry unavailable. */
  options?: readonly ValidationCommandSummary[];
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-xs">
      <SegmentedControl
        aria-label={`${roleLabel} command mode`}
        value={value.mode}
        disabled={readOnly}
        onValueChange={(mode) => {
          if (readOnly || mode === value.mode) return;
          onChange(
            mode === "all"
              ? { mode: "all", except: [] }
              : { mode: "only", commands: [] },
          );
        }}
      >
        <SegmentedControlItem value="all">All except</SegmentedControlItem>
        <SegmentedControlItem value="only">Only</SegmentedControlItem>
      </SegmentedControl>
      <CommandNameListEditor
        value={commandSelectorNames(value)}
        disabled={readOnly}
        options={options}
        addLabel={
          value.mode === "all"
            ? `Add ${roleLabel} exception`
            : `Add ${roleLabel} command`
        }
        onChange={(names) =>
          onChange(
            value.mode === "all"
              ? { mode: "all", except: names }
              : { mode: "only", commands: names },
          )
        }
      />
      <div className={COMMAND_HINT_CLASS}>{commandSelectorHint(value)}</div>
    </div>
  );
}

export type AgentValidationRole = "implementer" | "contextValidator";

const AGENT_VALIDATION_ROLES: readonly AgentValidationRole[] = [
  "implementer",
  "contextValidator",
];

const AGENT_VALIDATION_ROLE_LABEL: Record<AgentValidationRole, string> = {
  implementer: "Implementer",
  contextValidator: "Context validator",
};

const AGENT_VALIDATION_SOURCE_TESTID: Record<AgentValidationRole, string> = {
  implementer: "agent-validation-source-implementer",
  contextValidator: "agent-validation-source-context-validator",
};

/**
 * Per-role validation allowlists. Edits are PER LEAF: changing one role emits
 * only that role's selector, so override tiers can keep the other role absent
 * (= inherit) instead of silently snapshotting it — the whole-block-replacement
 * trap the cascade exists to prevent.
 */
export function AgentValidationEditor({
  value,
  onChangeRole,
  readOnly,
  roleSourceLabels,
  options,
}: {
  value: GraphWorkflowAgentValidationConfig;
  onChangeRole: (
    role: AgentValidationRole,
    selector: GraphWorkflowCommandSelector,
  ) => void;
  readOnly?: boolean;
  /** Optional per-role provenance labels (Global / Workflow / Context). */
  roleSourceLabels?: Partial<Record<AgentValidationRole, string>>;
  /** Registry summaries for this scope; undefined = registry unavailable. */
  options?: readonly ValidationCommandSummary[];
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-md">
      {AGENT_VALIDATION_ROLES.map((role) => (
        <div key={role} className="flex flex-col gap-xs" data-role={role}>
          <div className="flex items-center gap-sm">
            <span className="font-mono text-[0.7rem] font-semibold tracking-[0.06em] text-text-tertiary uppercase">
              {AGENT_VALIDATION_ROLE_LABEL[role]}
            </span>
            {roleSourceLabels?.[role] ? (
              <span
                className="ml-auto font-mono text-[0.7rem] font-semibold tracking-[0.07em] whitespace-nowrap text-text-tertiary uppercase"
                data-testid={AGENT_VALIDATION_SOURCE_TESTID[role]}
              >
                {roleSourceLabels[role]}
              </span>
            ) : null}
          </div>
          <CommandSelectorEditor
            value={value[role]}
            onChange={(selector) => onChangeRole(role, selector)}
            readOnly={readOnly}
            roleLabel={AGENT_VALIDATION_ROLE_LABEL[role]}
            options={options}
          />
        </div>
      ))}
    </div>
  );
}

function laneMergeCommandsHint(
  selector: GraphWorkflowLaneMergeCommandSelector,
): string {
  if (selector.mode === "project") {
    return "Uses the project's lane-merge command list when configured, else its pre-merge list — resolved at merge submission.";
  }
  return selector.commands.length === 0
    ? "Empty list — lane-merge validation is disabled."
    : "Runs only the listed commands, in order.";
}

export function LaneMergeCommandSelectorEditor({
  value,
  onChange,
  readOnly,
  options,
}: {
  value: GraphWorkflowLaneMergeCommandSelector;
  onChange: (next: GraphWorkflowLaneMergeCommandSelector) => void;
  readOnly?: boolean;
  /** Registry summaries for this scope; undefined = registry unavailable. */
  options?: readonly ValidationCommandSummary[];
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-xs">
      <SegmentedControl
        aria-label="Lane-merge command source"
        value={value.mode}
        disabled={readOnly}
        onValueChange={(mode) => {
          if (readOnly || mode === value.mode) return;
          onChange(
            mode === "project"
              ? { mode: "project" }
              : { mode: "only", commands: [] },
          );
        }}
      >
        <SegmentedControlItem value="project">
          Project default
        </SegmentedControlItem>
        <SegmentedControlItem value="only">Custom list</SegmentedControlItem>
      </SegmentedControl>
      {value.mode === "only" ? (
        <CommandNameListEditor
          value={value.commands}
          disabled={readOnly}
          options={options}
          addLabel="Add lane-merge command"
          onChange={(commands) => onChange({ mode: "only", commands })}
        />
      ) : null}
      <div className={COMMAND_HINT_CLASS}>{laneMergeCommandsHint(value)}</div>
    </div>
  );
}

const LANE_MERGE_STRATEGY_HINT: Record<
  GraphWorkflowLaneMergeValidationConfig["strategy"],
  string
> = {
  "final-only": "Validates only the last merge of a join series.",
  "every-merge": "Validates every lane merge in a join series.",
};

/**
 * Workflow-scope lane-merge validation. Edits are per leaf (strategy vs
 * command selection) so a workflow override can pin one leaf while the other
 * keeps inheriting the global default.
 */
export function LaneMergeValidationEditor({
  value,
  onChangeStrategy,
  onChangeCommands,
  readOnly,
  options,
}: {
  value: GraphWorkflowLaneMergeValidationConfig;
  onChangeStrategy: (
    next: GraphWorkflowLaneMergeValidationConfig["strategy"],
  ) => void;
  onChangeCommands: (next: GraphWorkflowLaneMergeCommandSelector) => void;
  readOnly?: boolean;
  /** Registry summaries for this scope; undefined = registry unavailable. */
  options?: readonly ValidationCommandSummary[];
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-sm">
      <FieldRow
        label="Strategy"
        hint={LANE_MERGE_STRATEGY_HINT[value.strategy]}
      >
        <SegmentedControl
          aria-label="Lane-merge validation strategy"
          value={value.strategy}
          disabled={readOnly}
          onValueChange={(next) => {
            if (readOnly || next === value.strategy) return;
            if (next === "final-only" || next === "every-merge") {
              onChangeStrategy(next);
            }
          }}
        >
          <SegmentedControlItem value="final-only">
            final-only
          </SegmentedControlItem>
          <SegmentedControlItem value="every-merge">
            every-merge
          </SegmentedControlItem>
        </SegmentedControl>
      </FieldRow>
      <FieldRow label="Commands">
        <LaneMergeCommandSelectorEditor
          value={value.commands}
          onChange={onChangeCommands}
          readOnly={readOnly}
          options={options}
        />
      </FieldRow>
    </div>
  );
}
