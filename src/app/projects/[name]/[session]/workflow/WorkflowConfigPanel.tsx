"use client";

import { useState, useCallback } from "react";
import type { RalphLoopConfig } from "./types";

interface WorkflowConfigPanelProps {
  config: RalphLoopConfig;
  readOnly?: boolean;
  onConfigChange?: (config: RalphLoopConfig) => void;
}

interface FieldDef {
  key: string;
  label: string;
  group: string;
  min: number;
  max: number;
  /** Transform config to display value. */
  toDisplay: (config: RalphLoopConfig) => number;
  /** Transform display value to config patch. */
  toConfig: (v: number) => Partial<RalphLoopConfig>;
  errorMessage: string;
}

function getFieldDefs(config: RalphLoopConfig): FieldDef[] {
  return [
    {
      key: "maxIterations",
      label: "Max Iterations",
      group: "Execution Limits",
      min: 1,
      max: 100,
      toDisplay: (c) => c.maxIterations,
      toConfig: (v) => ({ maxIterations: v }),
      errorMessage: "Must be between 1 and 100",
    },
    {
      key: "timeout",
      label: "Timeout (min)",
      group: "Execution Limits",
      min: 1,
      max: 120,
      toDisplay: (c) => Math.round(c.iterationTimeoutMs / 60_000),
      toConfig: (v) => ({ iterationTimeoutMs: v * 60_000 }),
      errorMessage: "Must be between 1 and 120 minutes",
    },
    {
      key: "noProgressThreshold",
      label: "No-Progress Threshold",
      group: "Circuit Breakers",
      min: 1,
      max: 20,
      toDisplay: (c) => c.circuitBreaker.noProgressThreshold,
      toConfig: (v) => ({
        circuitBreaker: { ...config.circuitBreaker, noProgressThreshold: v },
      }),
      errorMessage: "Must be between 1 and 20",
    },
    {
      key: "sameErrorThreshold",
      label: "Same-Error Threshold",
      group: "Circuit Breakers",
      min: 1,
      max: 20,
      toDisplay: (c) => c.circuitBreaker.sameErrorThreshold,
      toConfig: (v) => ({
        circuitBreaker: { ...config.circuitBreaker, sameErrorThreshold: v },
      }),
      errorMessage: "Must be between 1 and 20",
    },
    {
      key: "softLimit",
      label: "Soft Limit (K tokens)",
      group: "Context Management",
      min: 10,
      max: 500,
      toDisplay: (c) => Math.round(c.contextSoftLimitTokens / 1000),
      toConfig: (v) => ({ contextSoftLimitTokens: v * 1000 }),
      errorMessage: "Must be between 10K and 500K",
    },
    {
      key: "hardLimit",
      label: "Hard Limit (K tokens)",
      group: "Context Management",
      min: 10,
      max: 500,
      toDisplay: (c) => Math.round(c.contextHardLimitTokens / 1000),
      toConfig: (v) => ({ contextHardLimitTokens: v * 1000 }),
      errorMessage: "Must be between 10K and 500K",
    },
  ];
}

function validateField(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}

/** Strip everything except digits from a string. */
function stripNonNumeric(s: string): string {
  return s.replace(/\D/g, "");
}

// Group fields by their group label, preserving insertion order.
function groupFields(fields: FieldDef[]): Map<string, FieldDef[]> {
  const groups = new Map<string, FieldDef[]>();
  for (const field of fields) {
    const list = groups.get(field.group) ?? [];
    list.push(field);
    groups.set(field.group, list);
  }
  return groups;
}

/**
 * A single numeric text input that allows free typing,
 * strips non-numeric characters, and commits on blur/Enter.
 */
function NumericField({
  field,
  config,
  readOnly,
  onCommit,
}: {
  field: FieldDef;
  config: RalphLoopConfig;
  readOnly: boolean;
  onCommit: (field: FieldDef, value: number) => void;
}) {
  const displayValue = field.toDisplay(config);
  const [localValue, setLocalValue] = useState<string>(String(displayValue));
  const [showError, setShowError] = useState(false);

  // Sync local value when config changes from outside
  const [prevDisplay, setPrevDisplay] = useState(displayValue);
  if (displayValue !== prevDisplay) {
    setPrevDisplay(displayValue);
    setLocalValue(String(displayValue));
    setShowError(false);
  }

  const isConfigValueValid = validateField(displayValue, field.min, field.max);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const stripped = stripNonNumeric(e.target.value);
    setLocalValue(stripped);
    setShowError(false);
  }, []);

  const commit = useCallback(() => {
    const trimmed = localValue.trim();
    if (trimmed === "") {
      // Revert to original value
      setLocalValue(String(displayValue));
      setShowError(false);
      return;
    }
    const num = parseInt(trimmed, 10);
    if (Number.isNaN(num) || !validateField(num, field.min, field.max)) {
      setShowError(true);
      return;
    }
    setShowError(false);
    if (num !== displayValue) {
      onCommit(field, num);
    }
  }, [localValue, displayValue, field, onCommit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        commit();
      }
    },
    [commit],
  );

  return (
    <div className="workflow-config-field">
      <label>{field.label}</label>
      <input
        type="text"
        inputMode="numeric"
        value={localValue}
        disabled={readOnly}
        onChange={handleChange}
        onBlur={commit}
        onKeyDown={handleKeyDown}
      />
      {(showError || !isConfigValueValid) && (
        <span className="workflow-config-error">{field.errorMessage}</span>
      )}
    </div>
  );
}

export default function WorkflowConfigPanel({
  config,
  readOnly = false,
  onConfigChange,
}: WorkflowConfigPanelProps) {
  const fields = getFieldDefs(config);
  const grouped = groupFields(fields);

  const handleCommit = useCallback(
    (field: FieldDef, value: number) => {
      const patch = field.toConfig(value);
      onConfigChange?.({ ...config, ...patch });
    },
    [config, onConfigChange],
  );

  return (
    <div className="workflow-config-fields">
      {[...grouped.entries()].map(([groupName, groupFields]) => (
        <div key={groupName} className="workflow-config-group">
          <span className="workflow-config-group-label">{groupName}</span>
          <div className="workflow-config-group-fields">
            {groupFields.map((field) => (
              <NumericField
                key={field.key}
                field={field}
                config={config}
                readOnly={readOnly}
                onCommit={handleCommit}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
