"use client";

import type { RalphLoopConfig } from "./types";

interface WorkflowConfigPanelProps {
  config: RalphLoopConfig;
  readOnly?: boolean;
  onConfigChange?: (config: RalphLoopConfig) => void;
}

interface FieldDef {
  label: string;
  value: number;
  min: number;
  max: number;
  /** Transform display value to config value (e.g., minutes to ms). */
  toConfig: (v: number) => Partial<RalphLoopConfig>;
  /** Transform config value to display value. */
  toDisplay: (config: RalphLoopConfig) => number;
  errorMessage: string;
}

function getFields(config: RalphLoopConfig): FieldDef[] {
  return [
    {
      label: "Max Iterations",
      value: config.maxIterations,
      min: 1,
      max: 100,
      toConfig: (v) => ({ maxIterations: v }),
      toDisplay: (c) => c.maxIterations,
      errorMessage: "Must be between 1 and 100",
    },
    {
      label: "Timeout (min)",
      value: Math.round(config.iterationTimeoutMs / 60_000),
      min: 1,
      max: 120,
      toConfig: (v) => ({ iterationTimeoutMs: v * 60_000 }),
      toDisplay: (c) => Math.round(c.iterationTimeoutMs / 60_000),
      errorMessage: "Must be between 1 and 120 minutes",
    },
    {
      label: "No-Progress Threshold",
      value: config.circuitBreaker.noProgressThreshold,
      min: 1,
      max: 20,
      toConfig: (v) => ({
        circuitBreaker: { ...config.circuitBreaker, noProgressThreshold: v },
      }),
      toDisplay: (c) => c.circuitBreaker.noProgressThreshold,
      errorMessage: "Must be between 1 and 20",
    },
    {
      label: "Same-Error Threshold",
      value: config.circuitBreaker.sameErrorThreshold,
      min: 1,
      max: 20,
      toConfig: (v) => ({
        circuitBreaker: { ...config.circuitBreaker, sameErrorThreshold: v },
      }),
      toDisplay: (c) => c.circuitBreaker.sameErrorThreshold,
      errorMessage: "Must be between 1 and 20",
    },
  ];
}

function validateField(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}

export default function WorkflowConfigPanel({
  config,
  readOnly = false,
  onConfigChange,
}: WorkflowConfigPanelProps) {
  const fields = getFields(config);

  function handleChange(field: FieldDef, rawValue: string) {
    const num = parseInt(rawValue, 10);
    if (Number.isNaN(num)) return;
    const patch = field.toConfig(num);
    onConfigChange?.({ ...config, ...patch });
  }

  return (
    <div className="workflow-config-fields">
      {fields.map((field) => {
        const isValid = validateField(field.value, field.min, field.max);
        return (
          <div key={field.label} className="workflow-config-field">
            <label>{field.label}</label>
            <input
              type="number"
              value={field.value}
              min={field.min}
              max={field.max}
              disabled={readOnly}
              onChange={(e) => handleChange(field, e.target.value)}
            />
            {!isValid && (
              <span className="workflow-config-error">
                {field.errorMessage}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
