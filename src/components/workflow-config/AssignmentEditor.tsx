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
  ValidatorAuthority,
} from "@/lib/workflow-graph/config-schemas";
import {
  ASSIGNMENT_INSTRUCTIONS_PRESENTATION,
  assignmentFocusRefusal,
} from "./assignment-focus";
import { FieldRow } from "./FieldPrimitives";

export const VALIDATOR_STRATEGY_OPTIONS = ["conversation", "task"] as const;
export const VALIDATOR_AUTHORITY_OPTIONS = ["blocking", "advisory"] as const;

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

export interface AssignmentAuthorityControl {
  value: ValidatorAuthority;
  onChange: (next: ValidatorAuthority) => void;
}

export interface AssignmentEditorProps<T extends AgentAssignment> {
  value: T;
  /**
   * Receives the WHOLE assignment, not a patch of the fields this editor owns.
   *
   * That is what lets a wrapper forward the result instead of merging it over
   * the previous value: an assignment edit can DELETE an optional key
   * (instructions cleared), and a merge would restore exactly the key the
   * author just removed.
   */
  onChange: (next: T) => void;
  /**
   * Present only for use sites that HAVE a strategy. Passed as a control rather
   * than read off the value so one editor serves both the implementer (no
   * strategy) and a validator (one) without a widened assignment type that
   * could carry a strategy where none is dispatched.
   */
  strategy?: AssignmentStrategyControl;
  /**
   * Present only for use sites that HAVE an authority — validators. An
   * implementer has no verdict to gate, so it has no axis here, and its
   * instructions take the subordinate face by construction rather than by a
   * default that could be forgotten.
   */
  authority?: AssignmentAuthorityControl;
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
 * The axes are separate on purpose: a library profile supplies the durable
 * prompt identity, the instructions steer it at this use site only, the
 * authority decides what a verdict from it can do, the strategy decides how the
 * lane is dispatched, and the runtime is the concrete backend/model. None of
 * them implies another — a Codex agent under the conversation strategy carrying
 * a project profile is authorable here.
 *
 * Authority and instructions are adjacent because they are one decision read
 * twice: the authority is what turns the same text from a subordinate steer
 * into the mandate a blocking verdict must trace to (R12.2).
 *
 * The instructions refusal is shown rather than enforced: the text keeps
 * flowing to the caller so a half-typed steer survives a re-render, and the
 * schema at the save boundary is the one thing that refuses. Silently
 * withholding the change would leave the author looking at text the draft does
 * not contain.
 *
 * Generic over the assignment so it edits the shared facet of whatever use site
 * holds it — a plain implementer assignment, a validator carrying strategy,
 * authority and continuity — and hands that same assignment back intact. A
 * non-generic editor would force every wrapper to re-widen the result by
 * merging it over the previous value, which is a deletion-losing operation.
 */
export function AssignmentEditor<T extends AgentAssignment>({
  value,
  onChange,
  strategy,
  authority,
  audience,
  libraryProjectName,
  readOnly,
  open,
}: AssignmentEditorProps<T>): React.JSX.Element {
  const focusText = value.focus ?? "";
  const focusRefusal = assignmentFocusRefusal(focusText);
  const focusErrorId = `assignment-instructions-error-${value.id}`;
  const instructions =
    ASSIGNMENT_INSTRUCTIONS_PRESENTATION[authority?.value ?? "advisory"];

  const handleFocus = (text: string) => {
    if (text.trim() === "") {
      // Clearing REMOVES the key rather than storing "". Absence is what "no
      // use-site instructions" is in the schema, and on a live execution it is
      // also the edit that moves the seat's fingerprint and retires its lane —
      // an empty string would be a different document that saves as a no-op.
      const cleared = { ...value };
      delete cleared.focus;
      onChange(cleared);
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

      {authority ? (
        <FieldRow label="Authority">
          <SegmentedControl
            value={authority.value}
            onValueChange={(next) =>
              authority.onChange(next as ValidatorAuthority)
            }
            disabled={readOnly}
            aria-label="Validator authority"
          >
            {VALIDATOR_AUTHORITY_OPTIONS.map((option) => (
              <SegmentedControlItem key={option} value={option}>
                {option}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </FieldRow>
      ) : null}

      <FieldRow
        label={instructions.label}
        hint={
          <span data-testid="assignment-instructions-hint">
            {instructions.hint}
          </span>
        }
      >
        <div className="flex min-w-0 flex-1 flex-col gap-2xs">
          <MultilineInput
            rows={2}
            className="min-h-[46px] w-full resize-y rounded-sm border border-solid border-border-default bg-bg-surface px-[10px] py-[7px] text-[0.75rem] leading-[1.5] text-text-primary transition-[border-color] duration-150 outline-none focus:border-cyan focus:shadow-[0_0_0_1px_var(--cyan-glow)] disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-red aria-[invalid=true]:focus:border-red"
            value={focusText}
            disabled={readOnly}
            aria-label={`${instructions.label} for ${value.id}`}
            aria-invalid={focusRefusal === null ? undefined : true}
            aria-describedby={focusRefusal === null ? undefined : focusErrorId}
            placeholder={instructions.placeholder}
            onValueChange={handleFocus}
          />
          {focusRefusal !== null ? (
            <span
              id={focusErrorId}
              role="alert"
              data-testid="assignment-instructions-error"
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
