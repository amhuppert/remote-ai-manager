"use client";

import { useState } from "react";
import BackendToggle from "@/components/BackendToggle";
import ModelSelector from "@/components/ModelSelector";
import ReasoningLevelSelector from "@/components/ReasoningLevelSelector";
import { getEffortLevelsForBackend } from "@/lib/schemas";
import type {
  AgentBackendId,
  ClaudeModel,
  CodexModel,
  CodexReasoningEffort,
  EffortLevel,
  GraphWorkflowAgentConfig,
  GraphWorkflowAgentValidatorConfig,
  GraphWorkflowCircuitBreakerPolicy,
  GraphWorkflowIterationPolicy,
  GraphWorkflowMutabilityPolicy,
} from "@/types";

interface EditorBaseProps<T> {
  value: T;
  onChange: (next: T) => void;
  readOnly?: boolean;
}

function FieldRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="wb-editor-field">
      <div className="wb-editor-field-label">{label}</div>
      <div className="wb-editor-field-control">{children}</div>
      {hint ? <div className="wb-field-hint">{hint}</div> : null}
    </div>
  );
}

function ToggleControl({
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
    <div
      className={`config-toggle${disabled ? " config-toggle--disabled" : ""}`}
      onClick={() => !disabled && onChange(!value)}
      role="switch"
      aria-label={ariaLabel}
      aria-checked={value}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onChange(!value);
        }
      }}
    >
      <div className={`config-toggle-track${value ? " active" : ""}`}>
        <div className="config-toggle-knob" />
      </div>
      <span className="config-toggle-label">{value ? "ON" : "OFF"}</span>
    </div>
  );
}

function NumericInput({
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
      className="wb-editor-number-input"
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
    <div className="wb-editor-stack">
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
    <div className="wb-editor-stack">
      <FieldRow label="Type">
        <BackendToggle
          value={value.type}
          onChange={handleTypeChange}
          disabled={readOnly}
        />
      </FieldRow>

      <FieldRow label="Enabled">
        <ToggleControl
          value={value.enabled}
          onChange={(next) => onChange({ ...value, enabled: next })}
          disabled={readOnly}
          ariaLabel="Validator enabled"
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
    <div className="wb-editor-stack">
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
    <div className="wb-editor-stack">
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

export function MutabilityEditor({
  value,
  onChange,
  readOnly,
}: EditorBaseProps<GraphWorkflowMutabilityPolicy>): React.JSX.Element {
  return (
    <div className="wb-editor-stack">
      <FieldRow
        label="Allow agent task add"
        hint="Let agents add tasks during execution"
      >
        <ToggleControl
          value={value.allowAgentTaskAdd}
          onChange={(next) => onChange({ allowAgentTaskAdd: next })}
          disabled={readOnly}
          ariaLabel="Allow agent task add"
        />
      </FieldRow>
    </div>
  );
}
