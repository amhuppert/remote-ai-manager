"use client";

import AgentProfilePicker from "@/components/agent-profiles/AgentProfilePicker";
import BackendToggle from "@/components/BackendToggle";
import ModelSelector from "@/components/ModelSelector";
import { MultilineInput } from "@/components/MultilineInput";
import ReasoningLevelSelector from "@/components/ReasoningLevelSelector";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/SegmentedControl";
import { getEffortLevelsForBackend } from "@/lib/agent-backends/catalog";
import type {
  ClaudeModel,
  CodexModel,
  CodexReasoningEffort,
  EffortLevel,
} from "@/lib/agent-backends/schemas";
import {
  formatAgentProfileRef,
  type AgentProfileAudience,
} from "@/lib/agent-profiles/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type {
  AgentAssignment,
  GraphWorkflowAgentConfig,
  ValidatorAssignment,
} from "@/lib/workflow-graph/config-schemas";
import {
  ASSIGNMENT_FOCUS_RULES_HINT,
  assignmentFocusRefusal,
} from "./assignment-focus";
import { FieldRow } from "./FieldPrimitives";

export const VALIDATOR_STRATEGY_OPTIONS = ["conversation", "task"] as const;

/**
 * The concrete per-backend runtime an assignment runs with.
 *
 * Separate from the assignment itself because two config blocks carry a runtime
 * with no library profile behind it — the plan-repair agent and the
 * collaboration second agent — and they need these three rows without a profile
 * picker above them.
 */
export function AgentRuntimeFields({
  value,
  onChange,
  readOnly,
}: {
  value: GraphWorkflowAgentConfig;
  onChange: (next: GraphWorkflowAgentConfig) => void;
  readOnly?: boolean;
}): React.JSX.Element {
  const effortOptions = getEffortLevelsForBackend(value.backend, value.model);

  const handleBackend = (next: AgentBackendId) => {
    if (next === value.backend) return;
    if (next === "codex") {
      onChange({
        backend: "codex",
        model: "gpt-5.4",
        reasoningEffort: "medium",
      });
    } else {
      onChange({
        backend: "claude",
        model: "opus",
        reasoningEffort: "medium",
      });
    }
  };

  const handleModel = (model: string) => {
    if (value.backend === "codex") {
      onChange({
        backend: "codex",
        model: model as CodexModel,
        reasoningEffort: value.reasoningEffort as CodexReasoningEffort,
      });
    } else {
      onChange({
        backend: "claude",
        model: model as ClaudeModel,
        reasoningEffort: value.reasoningEffort as EffortLevel,
      });
    }
  };

  const handleEffort = (level: EffortLevel) => {
    onChange({
      ...value,
      reasoningEffort: level,
    } as GraphWorkflowAgentConfig);
  };

  return (
    <>
      <FieldRow label="Backend">
        <BackendToggle
          value={value.backend}
          onChange={handleBackend}
          disabled={readOnly}
        />
      </FieldRow>
      <FieldRow label="Model">
        <ModelSelector
          value={value.model}
          backend={value.backend}
          onChange={handleModel}
          disabled={readOnly}
        />
      </FieldRow>
      <FieldRow label="Reasoning effort">
        <ReasoningLevelSelector
          value={value.reasoningEffort as EffortLevel}
          availableLevels={effortOptions}
          onChange={handleEffort}
          disabled={readOnly}
        />
      </FieldRow>
    </>
  );
}

export interface AssignmentStrategyControl {
  value: ValidatorAssignment["strategy"];
  onChange: (next: ValidatorAssignment["strategy"]) => void;
}

export interface AssignmentEditorProps {
  value: AgentAssignment;
  onChange: (next: AgentAssignment) => void;
  /**
   * Present only for use sites that HAVE a strategy. Passed as a control rather
   * than read off the value so one editor serves both the implementer (no
   * strategy) and a validator (one) without a widened assignment type that
   * could carry a strategy where none is dispatched.
   */
  strategy?: AssignmentStrategyControl;
  /** Drives the picker's advisory warning; never its selectability. */
  audience: AgentProfileAudience;
  /**
   * Scopes the profile listing. Absent on the global-defaults form, which has
   * no project and lists the tiers outside every project.
   */
  libraryProjectName?: string | null;
  readOnly?: boolean;
  /** Test/story affordance: Radix cannot open a listbox in jsdom on its own. */
  open?: boolean;
}

/**
 * ONE agent assignment, wherever it is authored (D11).
 *
 * The four fields are separate axes on purpose: a library profile supplies the
 * durable prompt identity, the focus narrows it at this use site only, the
 * strategy decides how the lane is dispatched, and the runtime is the concrete
 * backend/model. None of them implies another — a Codex agent under the
 * conversation strategy carrying a project profile is authorable here.
 *
 * The focus refusal is shown rather than enforced: the text keeps flowing to
 * the caller so a half-typed steer survives a re-render, and the schema at the
 * save boundary is the one thing that refuses. Silently withholding the change
 * would leave the author looking at text the draft does not contain.
 */
export function AssignmentEditor({
  value,
  onChange,
  strategy,
  audience,
  libraryProjectName,
  readOnly,
  open,
}: AssignmentEditorProps): React.JSX.Element {
  const focusText = value.focus ?? "";
  const focusRefusal = assignmentFocusRefusal(focusText);
  const focusErrorId = `assignment-focus-error-${value.id}`;

  const handleFocus = (text: string) => {
    if (text.trim() === "") {
      const { focus: _focus, ...withoutFocus } = value;
      onChange(withoutFocus);
      return;
    }
    onChange({ ...value, focus: text });
  };

  return (
    <div className="flex flex-col gap-sm" data-testid="assignment-editor">
      <FieldRow label="Profile">
        <AgentProfilePicker
          projectName={libraryProjectName}
          value={formatAgentProfileRef(value.profile)}
          onChange={(selection) =>
            onChange({ ...value, profile: selection.ref })
          }
          audience={audience}
          disabled={readOnly}
          {...(open === undefined ? {} : { open })}
        />
      </FieldRow>

      <FieldRow
        label="Focus"
        hint={
          <span data-testid="assignment-focus-hint">
            {ASSIGNMENT_FOCUS_RULES_HINT}
          </span>
        }
      >
        <div className="flex min-w-0 flex-1 flex-col gap-2xs">
          <MultilineInput
            rows={2}
            className="min-h-[46px] w-full resize-y rounded-sm border border-solid border-border-default bg-bg-surface px-[10px] py-[7px] text-[0.75rem] leading-[1.5] text-text-primary transition-[border-color] duration-150 outline-none focus:border-cyan focus:shadow-[0_0_0_1px_var(--cyan-glow)] disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-red aria-[invalid=true]:focus:border-red"
            value={focusText}
            disabled={readOnly}
            aria-label={`Focus for ${value.id}`}
            aria-invalid={focusRefusal === null ? undefined : true}
            aria-describedby={focusRefusal === null ? undefined : focusErrorId}
            placeholder="Optional — narrow this profile for this use site"
            onValueChange={handleFocus}
          />
          {focusRefusal !== null ? (
            <span
              id={focusErrorId}
              role="alert"
              data-testid="assignment-focus-error"
              className="font-mono text-[0.7rem] leading-[1.4] text-red"
            >
              {focusRefusal}
            </span>
          ) : null}
        </div>
      </FieldRow>

      {strategy ? (
        <FieldRow label="Strategy">
          <SegmentedControl
            value={strategy.value}
            onValueChange={(next) =>
              strategy.onChange(next as ValidatorAssignment["strategy"])
            }
            disabled={readOnly}
            aria-label="Validator execution strategy"
          >
            {VALIDATOR_STRATEGY_OPTIONS.map((option) => (
              <SegmentedControlItem key={option} value={option}>
                {option}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </FieldRow>
      ) : null}

      <AgentRuntimeFields
        value={value.agent}
        onChange={(agent) => onChange({ ...value, agent })}
        readOnly={readOnly}
      />
    </div>
  );
}
