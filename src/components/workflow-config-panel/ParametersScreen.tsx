"use client";

import { useState } from "react";
import { Switch } from "@/components/ui/Switch";
import { changeType } from "@/features/workflows-builder/components/ParameterDeclarationEditor";
import type { ParameterDeclaration } from "@/lib/workflow-graph/definition-schemas";
import { cn } from "@/lib/ui/cn";
import { isConfigLocked } from "./affordance";
import {
  ConfigItemList,
  ConfigTextInput,
  type ConfigListItem,
} from "./ConfigControls";
import { ConfigControlRow, ConfigRowGroup } from "./ConfigRow";
import type { WorkflowStructuralEditor } from "./structural-editor";
import { chipPart, type ConfigValuePart } from "./value-parts";

/**
 * Launch parameters — the typed inputs collected once at launch and substituted
 * into context briefs (Config Panel `paramsRows()`).
 *
 * The type control offers exactly the variants `parameterDeclarationSchema`
 * declares. The prototype's `number` and `boolean` are design-mock values the
 * engine has no variant for; offering them would be new authoring for a field
 * that is not authorable today (README §14), and every declared type binds to a
 * string value anyway.
 */

const PARAMETERS_HINT =
  "Collected at launch and substituted into context briefs. Name, type, label, required, default, and enum options are all authored here.";

type ParameterType = ParameterDeclaration["type"];

const PARAMETER_TYPES: readonly ParameterType[] = ["string", "text", "enum"];

const FIELD_LABEL =
  "font-mono text-[0.7rem] font-medium tracking-[0.06em] text-text-tertiary uppercase";

const SELECT_BOX =
  "rounded-sm border border-solid border-border-default bg-bg-surface px-[8px] py-[5px] font-mono text-[0.72rem] text-text-primary outline-none " +
  "focus:border-cyan focus:shadow-[0_0_0_1px_var(--cyan-glow)] disabled:cursor-not-allowed disabled:opacity-55 max-768:min-h-[44px]";

/** One labelled cell in a parameter card's inline field grid. */
function Field({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: React.ReactNode;
  wide?: boolean;
}): React.JSX.Element {
  return (
    <label className={cn("flex flex-col gap-[4px]", wide && "col-span-2")}>
      <span className={FIELD_LABEL}>{label}</span>
      {children}
    </label>
  );
}

/**
 * The enum options, authored as a comma-separated list.
 *
 * The field keeps its own raw text while it is being edited. The committed
 * value is a trimmed, empty-dropped array, so rendering the input straight from
 * that array would delete the separator on the very keystroke that typed it,
 * and every following character would land back in the previous option.
 *
 * On blur the draft is dropped and the field settles to the canonical join.
 * That reset is load-bearing beyond tidiness: cards are keyed by position, so
 * removing one hands its mounted state to the declaration that shifts into the
 * slot, and a surviving draft would be shown as that declaration's options.
 */
function EnumOptionsInput({
  options,
  onChange,
  ariaLabel,
  placeholder,
  disabled,
}: {
  options: readonly string[];
  onChange: (next: string[]) => void;
  ariaLabel: string;
  placeholder: string;
  disabled: boolean;
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <ConfigTextInput
      value={draft ?? options.join(", ")}
      onChange={(text) => {
        setDraft(text);
        onChange(
          text
            .split(",")
            .map((each) => each.trim())
            .filter((each) => each.length > 0),
        );
      }}
      onBlur={() => setDraft(null)}
      ariaLabel={ariaLabel}
      placeholder={placeholder}
      disabled={disabled}
    />
  );
}

function chipsFor(parameter: ParameterDeclaration): ConfigValuePart[] {
  const chips = [chipPart(parameter.type)];
  if (parameter.required) chips.push(chipPart("required", "amber"));
  return chips;
}

/** A parameter's declared default, held as text — every type binds to a string. */
function defaultOf(parameter: ParameterDeclaration): string {
  return parameter.default ?? "";
}

/**
 * Set the default, spelling "no default" as the ABSENT key rather than an empty
 * string, so clearing the field round-trips as an undeclared default.
 */
function withDefault(
  parameter: ParameterDeclaration,
  next: string,
): ParameterDeclaration {
  const { default: _dropped, ...rest } = parameter;
  return next === "" ? rest : { ...rest, default: next };
}

export function ParametersScreen({
  editor,
}: {
  editor: WorkflowStructuralEditor;
}): React.JSX.Element {
  const locked = isConfigLocked(editor.affordance);
  const parameters = editor.parameters;

  function updateAt(index: number, next: ParameterDeclaration): void {
    editor.onParametersChange(
      parameters.map((each, at) => (at === index ? next : each)),
    );
  }

  const items: ConfigListItem[] = parameters.map((parameter, index) => {
    const named = parameter.name.length > 0 ? parameter.name : `#${index + 1}`;
    return {
      // Position, never the name. `id` becomes the list's React key, and a key
      // derived from an editable field changes on the first keystroke: the card
      // remounts, the name field loses focus, and the rest of the name is typed
      // into nothing. Two freshly added declarations are both nameless, so a
      // name-derived key would collide as well. A declaration carries no id of
      // its own, and this list has no reordering, so its position is the only
      // identity it has.
      id: `parameter-${index}`,
      title: named,
      chips: chipsFor(parameter),
      onRemove: () =>
        editor.onParametersChange(
          parameters.filter((_unused, at) => at !== index),
        ),
      children: (
        <div className="grid grid-cols-2 gap-[8px]">
          <Field label="name">
            <ConfigTextInput
              value={parameter.name}
              onChange={(name) => updateAt(index, { ...parameter, name })}
              ariaLabel={`Name of ${named}`}
              disabled={locked}
            />
          </Field>
          <Field label="type">
            <select
              className={SELECT_BOX}
              value={parameter.type}
              aria-label={`Type of ${named}`}
              disabled={locked}
              onChange={(event) => {
                const next = PARAMETER_TYPES.find(
                  (candidate) => candidate === event.target.value,
                );
                if (next !== undefined) {
                  // The builder's own variant-switch helper, so the
                  // discriminated union stays sound without a cast and the two
                  // editors cannot disagree about what a type change carries.
                  updateAt(index, changeType(parameter, next));
                }
              }}
            >
              {PARAMETER_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </Field>
          <Field label="label">
            <ConfigTextInput
              value={parameter.label}
              onChange={(label) => updateAt(index, { ...parameter, label })}
              ariaLabel={`Label of ${named}`}
              disabled={locked}
            />
          </Field>
          <Field label="required">
            <Switch
              checked={parameter.required}
              aria-label={`${named} required`}
              disabled={locked}
              onCheckedChange={(required) =>
                updateAt(index, { ...parameter, required })
              }
              layoutClassName="self-start"
            />
          </Field>
          <Field label="default">
            <ConfigTextInput
              value={defaultOf(parameter)}
              onChange={(next) => updateAt(index, withDefault(parameter, next))}
              ariaLabel={`Default of ${named}`}
              disabled={locked}
            />
          </Field>
          <Field label="options">
            <EnumOptionsInput
              options={parameter.type === "enum" ? parameter.options : []}
              onChange={(options) => {
                if (parameter.type !== "enum") return;
                updateAt(index, { ...parameter, options });
              }}
              ariaLabel={`Enum options of ${named}`}
              placeholder={
                parameter.type === "enum" ? "canary, full" : "enum only"
              }
              disabled={locked || parameter.type !== "enum"}
            />
          </Field>
        </div>
      ),
    };
  });

  return (
    <ConfigRowGroup>
      <ConfigControlRow
        rowId="workflow-parameters"
        label="Declared parameters"
        hint={PARAMETERS_HINT}
        disabled={locked}
      >
        {parameters.length === 0 ? (
          <p className="m-0 font-mono text-[0.7rem] leading-[1.5] text-text-tertiary">
            No launch parameters declared. This workflow runs as a zero-input
            template.
          </p>
        ) : null}
        <ConfigItemList
          items={items}
          disabled={locked}
          {...(locked
            ? {}
            : {
                addLabel: "Add parameter",
                onAdd: () =>
                  editor.onParametersChange([
                    ...parameters,
                    { type: "string", name: "", label: "", required: false },
                  ]),
              })}
        />
      </ConfigControlRow>
    </ConfigRowGroup>
  );
}
