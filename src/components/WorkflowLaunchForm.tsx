"use client";

import { useId, useState } from "react";
import type { ParameterDeclaration } from "@/lib/workflows/schemas";
import { Button } from "@/components/ui/Button";
import {
  FormError,
  FormGroup,
  FormInput,
  FormLabel,
} from "@/components/ui/FormField";
import { cn } from "@/lib/ui/cn";

export interface WorkflowLaunchFormProps {
  /** The definition's declared launch parameters (zero or more). */
  parameters: ParameterDeclaration[];
  /** Emits the supplied values on a valid submit. */
  onLaunch: (values: Record<string, string>) => void;
  /** While true, the launch control is disabled (a launch is in flight). */
  isLaunching?: boolean;
  /** Start-time rejection reason from the engine, surfaced after submit. */
  engineError?: string | null;
  /** Optional cancel affordance. */
  onCancel?: () => void;
}

// Mirrors `FormInput`'s appearance recipe but for a multiline textarea, since the
// `text` parameter type wants a vertically resizable field. Authored with the
// same token-backed utilities as the input primitive (no new global CSS).
const textareaClassName =
  "w-full min-h-[88px] resize-y px-[12px] py-[9px] bg-bg-base border border-solid border-border-default rounded-md text-text-primary font-mono text-[0.82rem] outline-0 transition-[border-color,box-shadow] duration-150 ease-[ease] placeholder:text-text-tertiary hover:border-border-strong focus:border-cyan focus:shadow-[0_0_0_3px_var(--cyan-glow)]";

const selectClassName =
  "w-full cursor-pointer px-[12px] py-[9px] bg-bg-base border border-solid border-border-default rounded-md text-text-primary font-mono text-[0.82rem] outline-0 transition-[border-color,box-shadow] duration-150 ease-[ease] hover:border-border-strong focus:border-cyan focus:shadow-[0_0_0_3px_var(--cyan-glow)]";

// The initial value an affordance shows: the declared default when present, else
// empty. Enum without a default falls back to the first option so the select has
// a concrete value rather than presenting no selection.
function initialValue(parameter: ParameterDeclaration): string {
  if (parameter.default !== undefined) return parameter.default;
  if (parameter.type === "enum") return parameter.options[0] ?? "";
  return "";
}

function buildInitialValues(
  parameters: ParameterDeclaration[],
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const parameter of parameters) {
    values[parameter.name] = initialValue(parameter);
  }
  return values;
}

// Per-field validation mirroring the engine's launch-input rules (required +
// string/text length bounds). Enum cannot be invalid because the select is
// constrained to declared options. Returns a user-facing message or null.
function validateValue(
  parameter: ParameterDeclaration,
  value: string,
): string | null {
  if (parameter.required && value.length === 0) {
    return "This field is required.";
  }
  // An omitted optional value is valid and is simply not submitted.
  if (!parameter.required && value.length === 0) {
    return null;
  }
  if (parameter.type === "string" || parameter.type === "text") {
    if (
      parameter.minLength !== undefined &&
      value.length < parameter.minLength
    ) {
      return `Must be at least ${parameter.minLength} characters.`;
    }
    if (
      parameter.maxLength !== undefined &&
      value.length > parameter.maxLength
    ) {
      return `Must be at most ${parameter.maxLength} characters.`;
    }
  }
  return null;
}

function computeErrors(
  parameters: ParameterDeclaration[],
  values: Record<string, string>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const parameter of parameters) {
    const message = validateValue(parameter, values[parameter.name] ?? "");
    if (message !== null) errors[parameter.name] = message;
  }
  return errors;
}

// The submitted payload: every parameter's value except optional-empty fields,
// which are omitted so the launcher does not send an empty string the engine
// would have to treat as "supplied".
function buildSubmitValues(
  parameters: ParameterDeclaration[],
  values: Record<string, string>,
): Record<string, string> {
  const submitted: Record<string, string> = {};
  for (const parameter of parameters) {
    const value = values[parameter.name] ?? "";
    if (!parameter.required && value.length === 0) continue;
    submitted[parameter.name] = value;
  }
  return submitted;
}

function ParameterField({
  parameter,
  value,
  error,
  showError,
  fieldId,
  errorId,
  onChange,
}: {
  parameter: ParameterDeclaration;
  value: string;
  error: string | null;
  showError: boolean;
  fieldId: string;
  errorId: string;
  onChange: (value: string) => void;
}): React.JSX.Element {
  const invalid = showError && error !== null;
  const describedBy = invalid ? errorId : undefined;

  return (
    <FormGroup>
      <FormLabel htmlFor={fieldId}>{parameter.label}</FormLabel>
      {parameter.type === "string" && (
        <FormInput
          id={fieldId}
          type="text"
          value={value}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {parameter.type === "text" && (
        <textarea
          id={fieldId}
          className={textareaClassName}
          value={value}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {parameter.type === "enum" && (
        <select
          id={fieldId}
          className={selectClassName}
          value={value}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
        >
          {parameter.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      )}
      {invalid && error !== null && <FormError id={errorId}>{error}</FormError>}
    </FormGroup>
  );
}

export default function WorkflowLaunchForm({
  parameters,
  onLaunch,
  isLaunching = false,
  engineError = null,
  onCancel,
}: WorkflowLaunchFormProps): React.JSX.Element {
  const baseId = useId();
  const [values, setValues] = useState<Record<string, string>>(() =>
    buildInitialValues(parameters),
  );
  // Errors are only displayed after a submit attempt or after a field has been
  // touched, so a freshly opened form does not shout about empty required fields.
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [submitAttempted, setSubmitAttempted] = useState(false);

  const errors = computeErrors(parameters, values);
  const hasErrors = Object.keys(errors).length > 0;

  function handleChange(name: string, value: string): void {
    setValues((prev) => ({ ...prev, [name]: value }));
    setTouched((prev) => ({ ...prev, [name]: true }));
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setSubmitAttempted(true);
    if (hasErrors) return;
    onLaunch(buildSubmitValues(parameters, values));
  }

  // The launch control stays enabled while validation errors exist so that
  // clicking it surfaces the per-field errors (R7.4/R7.5); the submit handler is
  // the gate that actually prevents launch. Only an in-flight launch disables it.
  const launchDisabled = isLaunching;

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-sm rounded-md border border-solid border-border-dim bg-bg-surface p-md"
      noValidate
    >
      <div className="font-mono text-[0.7rem] tracking-[0.06em] text-text-tertiary uppercase">
        Launch Workflow
      </div>

      {parameters.map((parameter) => {
        const fieldId = `${baseId}-${parameter.name}`;
        const errorId = `${fieldId}-error`;
        const showError = submitAttempted || touched[parameter.name] === true;
        return (
          <ParameterField
            key={parameter.name}
            parameter={parameter}
            value={values[parameter.name] ?? ""}
            error={errors[parameter.name] ?? null}
            showError={showError}
            fieldId={fieldId}
            errorId={errorId}
            onChange={(value) => handleChange(parameter.name, value)}
          />
        );
      })}

      {engineError && (
        <FormError role="alert" layoutClassName={cn("mt-0")}>
          {engineError}
        </FormError>
      )}

      <div className="flex items-center justify-end gap-sm">
        {onCancel && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            touch
            onClick={onCancel}
          >
            Cancel
          </Button>
        )}
        <Button
          type="submit"
          variant="primary"
          size="sm"
          touch
          disabled={launchDisabled}
        >
          {isLaunching ? "Launching..." : "Launch"}
        </Button>
      </div>
    </form>
  );
}
