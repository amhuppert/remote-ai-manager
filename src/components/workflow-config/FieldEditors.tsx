"use client";

import { useState } from "react";
import BackendToggle from "@/components/BackendToggle";
import { Switch } from "@/components/ui/Switch";
import { cn } from "@/lib/ui/cn";
import ModelSelector from "@/components/ModelSelector";
import ReasoningLevelSelector from "@/components/ReasoningLevelSelector";
import { getEffortLevelsForBackend } from "@/lib/agent-backends/catalog";
import type {
  ClaudeModel,
  CodexModel,
  CodexReasoningEffort,
  EffortLevel,
} from "@/lib/agent-backends/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type {
  CollaborationAutonomousResolutionThreshold,
  WorkflowCollaborationConfig,
} from "@/lib/workflow-graph/collaboration-schemas";
import type {
  GraphWorkflowAgentConfig,
  GraphWorkflowAgentValidatorConfig,
  GraphWorkflowCircuitBreakerPolicy,
  GraphWorkflowIterationPolicy,
} from "@/lib/workflow-graph/config-schemas";

// Reusable, feature-agnostic config field editors (docs/design/cc-cli/06 "UI
// plan"). Each is a controlled value+onChange component with no feature-level
// state, so it edits authored override blocks (workflow builder) or concrete
// resolved values (execution inspector) interchangeably.

interface EditorBaseProps<T> {
  value: T;
  onChange: (next: T) => void;
  readOnly?: boolean;
}

// Label-grid row: label in a fixed left column, control on the right, hint
// under the control column.
export function FieldRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[110px_1fr] items-center gap-x-[10px] gap-y-xs">
      <div className="font-mono text-[0.7rem] font-semibold tracking-[0.06em] text-text-tertiary uppercase">
        {label}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-xs">
        {children}
      </div>
      {hint ? (
        <div className="col-start-2 font-mono text-[0.7rem] leading-[1.5] text-text-tertiary">
          {hint}
        </div>
      ) : null}
    </div>
  );
}

export function ToggleControl({
  value,
  onChange,
  disabled,
  ariaLabel,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  return (
    <Switch
      checked={value}
      onCheckedChange={onChange}
      disabled={disabled}
      aria-label={ariaLabel}
    />
  );
}

export function NumericInput({
  value,
  onChange,
  disabled,
  min,
  placeholder,
  ariaLabel,
}: {
  value: number | undefined;
  onChange: (next: number | undefined) => void;
  disabled?: boolean;
  min?: number;
  placeholder?: string;
  ariaLabel: string;
}) {
  const [local, setLocal] = useState<string>(
    value !== undefined ? String(value) : "",
  );
  const [prev, setPrev] = useState<number | undefined>(value);
  if (prev !== value) {
    setPrev(value);
    setLocal(value !== undefined ? String(value) : "");
  }
  return (
    <input
      type="number"
      className="w-[110px] rounded-sm border border-solid border-border-default bg-bg-surface px-[10px] py-[7px] font-mono text-[0.75rem] text-text-primary transition-[border-color] duration-150 outline-none focus:border-cyan focus:shadow-[0_0_0_1px_var(--cyan-glow)] disabled:cursor-not-allowed disabled:opacity-60"
      disabled={disabled}
      value={local}
      min={min}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(event) => {
        const text = event.target.value;
        setLocal(text);
        if (text === "") {
          onChange(undefined);
          return;
        }
        const parsed = Number(text);
        if (Number.isFinite(parsed)) onChange(parsed);
      }}
    />
  );
}

export function ImplementerEditor({
  value,
  onChange,
  readOnly,
}: EditorBaseProps<GraphWorkflowAgentConfig>): React.JSX.Element {
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
    <div className="flex flex-col gap-sm">
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
    </div>
  );
}

export function ContextValidatorEditor({
  value,
  onChange,
  readOnly,
}: EditorBaseProps<GraphWorkflowAgentValidatorConfig>): React.JSX.Element {
  const continuityEnabled = value.continuity?.enabled ?? true;
  const continuityLimit = value.continuity?.contextLimitTokens;

  const handleTypeChange = (next: AgentBackendId) => {
    if (next === value.type) return;
    if (next === "codex") {
      onChange({
        type: "codex",
        enabled: value.enabled,
        continuity: value.continuity ?? { enabled: true },
        codex: { model: "gpt-5.4", reasoningEffort: "medium" },
      });
    } else {
      onChange({
        type: "claude",
        enabled: value.enabled,
        continuity: value.continuity ?? { enabled: true },
        agent: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
      });
    }
  };

  return (
    <div className="flex flex-col gap-sm">
      <FieldRow label="Type">
        <BackendToggle
          value={value.type}
          onChange={handleTypeChange}
          disabled={readOnly}
        />
      </FieldRow>

      {value.type === "claude" && value.agent.backend === "claude" && (
        <ClaudeValidatorSubfields
          agent={value.agent}
          onAgentChange={(agent) =>
            onChange({
              type: "claude",
              enabled: value.enabled,
              continuity: value.continuity,
              agent,
            })
          }
          readOnly={readOnly}
        />
      )}

      {value.type === "codex" && (
        <CodexValidatorSubfields
          codex={value.codex}
          onCodexChange={(codex) =>
            onChange({
              type: "codex",
              enabled: value.enabled,
              continuity: value.continuity,
              codex,
            })
          }
          readOnly={readOnly}
        />
      )}

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
          ariaLabel="Continuity enabled"
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
          ariaLabel="Context limit tokens"
        />
      </FieldRow>
    </div>
  );
}

function ClaudeValidatorSubfields({
  agent,
  onAgentChange,
  readOnly,
}: {
  agent: {
    backend: "claude";
    model: ClaudeModel;
    reasoningEffort: EffortLevel;
  };
  onAgentChange: (next: {
    backend: "claude";
    model: ClaudeModel;
    reasoningEffort: EffortLevel;
  }) => void;
  readOnly?: boolean;
}) {
  return (
    <>
      <FieldRow label="Agent model">
        <ModelSelector
          value={agent.model}
          backend="claude"
          disabled={readOnly}
          onChange={(model) =>
            onAgentChange({
              backend: "claude",
              model: model as ClaudeModel,
              reasoningEffort: agent.reasoningEffort,
            })
          }
        />
      </FieldRow>
      <FieldRow label="Agent effort">
        <ReasoningLevelSelector
          value={agent.reasoningEffort}
          availableLevels={getEffortLevelsForBackend("claude", agent.model)}
          disabled={readOnly}
          onChange={(level) =>
            onAgentChange({
              backend: "claude",
              model: agent.model,
              reasoningEffort: level,
            })
          }
        />
      </FieldRow>
    </>
  );
}

function CodexValidatorSubfields({
  codex,
  onCodexChange,
  readOnly,
}: {
  codex: { model?: CodexModel; reasoningEffort?: CodexReasoningEffort };
  onCodexChange: (next: {
    model?: CodexModel;
    reasoningEffort?: CodexReasoningEffort;
  }) => void;
  readOnly?: boolean;
}) {
  const effectiveModel: CodexModel = codex.model ?? "gpt-5.4";
  const effectiveEffort: CodexReasoningEffort =
    codex.reasoningEffort ?? "medium";
  return (
    <>
      <FieldRow label="Codex model">
        <ModelSelector
          value={effectiveModel}
          backend="codex"
          disabled={readOnly}
          onChange={(model) =>
            onCodexChange({
              model: model as CodexModel,
              reasoningEffort: effectiveEffort,
            })
          }
        />
      </FieldRow>
      <FieldRow label="Codex effort">
        <ReasoningLevelSelector
          value={effectiveEffort as EffortLevel}
          availableLevels={getEffortLevelsForBackend("codex", effectiveModel)}
          disabled={readOnly}
          onChange={(level) =>
            onCodexChange({
              model: effectiveModel,
              reasoningEffort: level as CodexReasoningEffort,
            })
          }
        />
      </FieldRow>
    </>
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
        <ImplementerEditor
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
