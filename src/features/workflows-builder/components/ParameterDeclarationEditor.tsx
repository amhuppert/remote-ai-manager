"use client";

import { Button } from "@/components/ui/Button";
import { MultilineInput } from "@/components/MultilineInput";
import { Checkbox } from "@/components/ui/Checkbox";
import { FormError, FormHint } from "@/components/ui/FormField";
import { IconButton } from "@/components/ui/IconButton";
import { SectionLabel } from "@/components/ui/SectionHeader";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import type { ParameterDeclaration } from "@/lib/workflow-graph/definition-schemas";
import { cn } from "@/lib/ui/cn";

type ParameterType = ParameterDeclaration["type"];

const PARAMETER_TYPES: ReadonlyArray<{ value: ParameterType; label: string }> =
  [
    { value: "string", label: "String" },
    { value: "text", label: "Multiline text" },
    { value: "enum", label: "Enum" },
  ];

// Shared `.wb-field` control recipe so the editor slots into the configuration
// panel with the same look. Kept local because these are field-level control
// classes, not a promotable primitive.
const FIELD_INPUT =
  "w-full rounded-sm border border-solid border-border-default bg-bg-base px-[10px] py-[8px] font-[inherit] text-[0.78rem] text-text-primary outline-none transition-[border-color] duration-150 focus:border-cyan focus:shadow-[0_0_0_1px_var(--cyan-glow)]";
const FIELD_TEXTAREA = "min-h-[64px] resize-y leading-[1.5]";
const FIELD_INVALID =
  "border-red focus:border-red focus:shadow-[0_0_0_1px_var(--cc-red-a25)]";
const FIELD_LABEL =
  "mb-xs block text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-text-tertiary";

export interface ParameterDeclarationEditorProps {
  parameters: ParameterDeclaration[];
  /** Emits the full edited declaration array on every change. */
  onChange(next: ParameterDeclaration[]): void;
  /**
   * Accept-time lint/validation error surfaced when the author saves — names the
   * offending field and the undeclared parameter reference (R8.3). Rendered as a
   * prominent alert banner.
   */
  saveError?: string | null;
  onPrimaryAction?: (force?: boolean) => void;
  voiceProjectName?: string | null;
}

function emptyDeclaration(): ParameterDeclaration {
  return { type: "string", name: "", label: "", required: false };
}

// Build the next declaration when the author switches `type`, preserving the
// common fields and resetting type-specific ones. Constructs the correct variant
// object per `nextType` so the discriminated union stays sound without casts.
export function changeType(
  current: ParameterDeclaration,
  nextType: ParameterType,
): ParameterDeclaration {
  const common = {
    name: current.name,
    label: current.label,
    required: current.required,
  };
  if (nextType === "enum") {
    return {
      type: "enum",
      ...common,
      options: current.type === "enum" ? current.options : [],
      ...(current.default === undefined ? {} : { default: current.default }),
    };
  }
  return {
    type: nextType,
    ...common,
    ...(current.default === undefined ? {} : { default: current.default }),
  };
}

// Compute the set of names that appear more than once (case-sensitive natural
// key) so the editor can flag duplicates inline before save (R8.2).
function duplicateNames(parameters: ParameterDeclaration[]): Set<string> {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const param of parameters) {
    const name = param.name.trim();
    if (name === "") continue;
    if (seen.has(name)) dupes.add(name);
    seen.add(name);
  }
  return dupes;
}

export default function ParameterDeclarationEditor({
  parameters,
  onChange,
  saveError,
  onPrimaryAction,
  voiceProjectName,
}: ParameterDeclarationEditorProps): React.JSX.Element {
  const dupes = duplicateNames(parameters);

  const updateAt = (index: number, next: ParameterDeclaration): void => {
    onChange(parameters.map((param, i) => (i === index ? next : param)));
  };

  const addParameter = (): void => {
    onChange([...parameters, emptyDeclaration()]);
  };

  const removeAt = (index: number): void => {
    onChange(parameters.filter((_, i) => i !== index));
  };

  return (
    <div className="flex flex-col gap-md" data-scope="parameters">
      {saveError ? (
        <div
          role="alert"
          className="rounded-sm border border-solid border-red-dim bg-red-glow px-[10px] py-[8px] font-mono text-[0.72rem] text-red"
        >
          {saveError}
        </div>
      ) : null}

      {parameters.length === 0 ? (
        <FormHint layoutClassName="mt-0">
          No launch parameters declared. This workflow runs as a zero-input
          template.
        </FormHint>
      ) : null}

      {parameters.map((param, index) => {
        const isDuplicate =
          param.name.trim() !== "" && dupes.has(param.name.trim());
        const fieldId = `param-${index}`;
        return (
          <div
            key={index}
            data-param-row={param.name === "" ? `__index_${index}` : param.name}
            className="flex flex-col gap-sm rounded-md border border-solid border-border-subtle bg-bg-surface p-md"
          >
            <div className="flex items-center gap-sm">
              <SectionLabel layoutClassName="flex-1">
                Parameter {index + 1}
              </SectionLabel>
              <IconButton
                tone="danger"
                aria-label="Remove parameter"
                onClick={() => removeAt(index)}
              >
                ✕
              </IconButton>
            </div>

            <div className="grid grid-cols-2 gap-sm">
              <div>
                <label className={FIELD_LABEL} htmlFor={`${fieldId}-name`}>
                  Name
                </label>
                <input
                  id={`${fieldId}-name`}
                  type="text"
                  className={cn(FIELD_INPUT, isDuplicate && FIELD_INVALID)}
                  value={param.name}
                  aria-invalid={isDuplicate || undefined}
                  onChange={(event) =>
                    updateAt(index, { ...param, name: event.target.value })
                  }
                />
              </div>
              <div>
                <label className={FIELD_LABEL} htmlFor={`${fieldId}-type`}>
                  Type
                </label>
                <Select
                  value={param.type}
                  onValueChange={(value) => {
                    const nextType = PARAMETER_TYPES.find(
                      (t) => t.value === value,
                    )?.value;
                    if (nextType === undefined) return;
                    updateAt(index, changeType(param, nextType));
                  }}
                >
                  <SelectTrigger
                    id={`${fieldId}-type`}
                    layoutClassName="w-full"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PARAMETER_TYPES.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div>
              <label className={FIELD_LABEL} htmlFor={`${fieldId}-label`}>
                Label
              </label>
              <input
                id={`${fieldId}-label`}
                type="text"
                className={FIELD_INPUT}
                value={param.label}
                onChange={(event) =>
                  updateAt(index, { ...param, label: event.target.value })
                }
              />
            </div>

            <div className="flex items-center gap-sm text-[0.75rem] text-text-secondary">
              <Checkbox
                id={`${fieldId}-required`}
                checked={param.required}
                onCheckedChange={(next) =>
                  updateAt(index, { ...param, required: next === true })
                }
              />
              <label htmlFor={`${fieldId}-required`} className="cursor-pointer">
                Required
              </label>
            </div>

            {param.type === "enum" ? (
              <EnumOptionsEditor
                param={param}
                onChange={(next) => updateAt(index, next)}
              />
            ) : (
              <div>
                <label className={FIELD_LABEL} htmlFor={`${fieldId}-default`}>
                  Default
                </label>
                {param.type === "text" ? (
                  <MultilineInput
                    id={`${fieldId}-default`}
                    rows={2}
                    className={cn(FIELD_INPUT, FIELD_TEXTAREA)}
                    value={param.default ?? ""}
                    onValueChange={(value) =>
                      updateAt(index, applyDefault(param, value))
                    }
                    onPrimaryAction={(value) => {
                      updateAt(index, applyDefault(param, value));
                      onPrimaryAction?.(true);
                    }}
                    voiceProjectName={voiceProjectName}
                  />
                ) : (
                  <input
                    id={`${fieldId}-default`}
                    type="text"
                    className={FIELD_INPUT}
                    value={param.default ?? ""}
                    onChange={(event) =>
                      updateAt(index, applyDefault(param, event.target.value))
                    }
                  />
                )}
              </div>
            )}

            {isDuplicate ? (
              <FormError role="alert" layoutClassName="mt-0">
                Duplicate parameter name &ldquo;{param.name.trim()}&rdquo; —
                names must be unique.
              </FormError>
            ) : null}
          </div>
        );
      })}

      <div>
        <Button variant="ghost" size="sm" onClick={addParameter}>
          + Add parameter
        </Button>
      </div>
    </div>
  );
}

// Apply a default value to a string/text declaration, dropping the field when
// the value is cleared so the persisted shape stays minimal. Enum defaults are
// managed inside EnumOptionsEditor.
function applyDefault(
  param: ParameterDeclaration,
  value: string,
): ParameterDeclaration {
  if (param.type === "string") {
    if (value === "") {
      const { default: _drop, ...rest } = param;
      return rest;
    }
    return { ...param, default: value };
  }
  if (param.type === "text") {
    if (value === "") {
      const { default: _drop, ...rest } = param;
      return rest;
    }
    return { ...param, default: value };
  }
  return param;
}

interface EnumOptionsEditorProps {
  param: Extract<ParameterDeclaration, { type: "enum" }>;
  onChange(next: Extract<ParameterDeclaration, { type: "enum" }>): void;
}

function EnumOptionsEditor({
  param,
  onChange,
}: EnumOptionsEditorProps): React.JSX.Element {
  const setOptions = (options: string[]): void => {
    onChange({ ...param, options });
  };

  const addOption = (): void => {
    setOptions([...param.options, ""]);
  };

  const updateOption = (optionIndex: number, value: string): void => {
    setOptions(
      param.options.map((option, i) => (i === optionIndex ? value : option)),
    );
  };

  const removeOption = (optionIndex: number): void => {
    setOptions(param.options.filter((_, i) => i !== optionIndex));
  };

  return (
    <div className="flex flex-col gap-sm">
      <span className={FIELD_LABEL}>Options</span>
      {param.options.length === 0 ? (
        <FormHint layoutClassName="mt-0">
          An enum parameter needs at least one option.
        </FormHint>
      ) : null}
      {param.options.map((option, optionIndex) => {
        const optionId = `param-${param.name}-option-${optionIndex}`;
        return (
          <div key={optionIndex} className="flex items-center gap-sm">
            <label className="sr-only" htmlFor={optionId}>
              Option {optionIndex + 1}
            </label>
            <input
              id={optionId}
              type="text"
              className={FIELD_INPUT}
              value={option}
              onChange={(event) =>
                updateOption(optionIndex, event.target.value)
              }
            />
            <IconButton
              tone="danger"
              aria-label={`Remove option ${optionIndex + 1}`}
              onClick={() => removeOption(optionIndex)}
            >
              ✕
            </IconButton>
          </div>
        );
      })}
      <div>
        <Button variant="ghost" size="sm" onClick={addOption}>
          + Add option
        </Button>
      </div>

      <div>
        <label className={FIELD_LABEL} htmlFor={`param-${param.name}-default`}>
          Default
        </label>
        <select
          id={`param-${param.name}-default`}
          className={FIELD_INPUT}
          value={param.default ?? ""}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "") {
              const { default: _drop, ...rest } = param;
              onChange(rest);
              return;
            }
            onChange({ ...param, default: value });
          }}
        >
          <option value="">— none —</option>
          {param.options.map((option, optionIndex) => (
            <option key={optionIndex} value={option}>
              {option === "" ? `(option ${optionIndex + 1})` : option}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
