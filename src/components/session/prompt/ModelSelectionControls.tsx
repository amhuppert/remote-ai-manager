"use client";

import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/Popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  type SelectContentLayer,
} from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { WithTooltip } from "@/components/ui/WithTooltip";
import {
  parameterValueEmphasis,
  RAINBOW_TEXT_CLASS,
  RAINBOW_TRIGGER_BASE_CLASS,
  RAINBOW_TRIGGER_CLASS,
} from "@/components/model-selection-presentation";
import {
  availableParameterValues,
  defaultSelectionForModel,
  modelSelectionKey,
  validateModelSelection,
} from "@/lib/agent-backends/model-selection";
import type {
  BackendModelCatalog,
  BackendModelDefinition,
  BackendModelParameterDefinition,
  BackendModelSelection,
} from "@/lib/agent-backends/schemas";
import { cn } from "@/lib/ui/cn";

function modelForSelection(
  catalog: BackendModelCatalog,
  selection: BackendModelSelection,
): BackendModelDefinition | undefined {
  return catalog.models.find(
    (model) =>
      model.id === selection.modelId ||
      model.aliases.includes(selection.modelId),
  );
}

function isBooleanParameter(
  parameter: BackendModelParameterDefinition,
): boolean {
  if (parameter.values.length !== 2) return false;
  const values = new Set(parameter.values.map(({ value }) => value));
  return values.has("true") && values.has("false");
}

function parameterValueLabel(
  parameter: BackendModelParameterDefinition,
  value: string | undefined,
): string {
  return (
    parameter.values.find((candidate) => candidate.value === value)?.label ??
    value ??
    "Unavailable"
  );
}

/**
 * One parameter's listbox rows. Values the catalog marks as exceeding the
 * provider's scale carry the rainbow treatment and a `data-emphasis` hook; the
 * control itself never inspects parameter ids or value spellings.
 */
function ParameterValueItems({
  parameter,
}: {
  parameter: BackendModelParameterDefinition;
}): React.JSX.Element {
  return (
    <>
      {parameter.values.map((option) => (
        <SelectItem
          key={option.value}
          value={option.value}
          data-emphasis={option.emphasis}
        >
          {option.emphasis === undefined ? (
            option.label
          ) : (
            <span className={RAINBOW_TEXT_CLASS}>{option.label}</span>
          )}
        </SelectItem>
      ))}
    </>
  );
}

export interface UnavailableModelSelectionControlProps {
  selection: BackendModelSelection;
  reason: string;
}

export function UnavailableModelSelectionControl({
  selection,
  reason,
}: UnavailableModelSelectionControlProps): React.JSX.Element {
  return (
    <button
      type="button"
      disabled
      aria-label={`Model ${selection.modelId}. ${reason}`}
      title={reason}
      data-testid="model-selector-trigger"
      data-invalid-selection="true"
      className="inline-flex h-9 cursor-not-allowed items-center gap-[6px] rounded-md border border-solid border-red-dim bg-bg-surface px-3 font-mono text-[0.72rem] font-medium whitespace-nowrap text-red opacity-70 max-768:h-[44px]"
    >
      {selection.modelId}
    </button>
  );
}

export interface CatalogModelSelectProps {
  catalog: BackendModelCatalog;
  selection: BackendModelSelection;
  onSelectionChange(selection: BackendModelSelection): void;
  invalidReason?: string | null;
  disabled?: boolean;
  onOpenChange?(open: boolean): void;
  selectContentLayer?: SelectContentLayer;
}

export function CatalogModelSelect({
  catalog,
  selection,
  onSelectionChange,
  invalidReason = null,
  disabled = false,
  onOpenChange,
  selectContentLayer,
}: CatalogModelSelectProps): React.JSX.Element {
  const model = modelForSelection(catalog, selection);
  const resolvedInvalidReason =
    invalidReason ??
    (model === undefined
      ? `Model "${selection.modelId}" is not available in this catalog.`
      : null);
  const invalid = resolvedInvalidReason !== null;

  return (
    <Select
      value={model?.id}
      onValueChange={(modelId) => {
        if (modelId === "") return;
        onSelectionChange(defaultSelectionForModel(catalog, modelId));
      }}
      disabled={disabled || catalog.models.length === 0}
      onOpenChange={onOpenChange}
    >
      <WithTooltip label={resolvedInvalidReason} side="top">
        <SelectTrigger
          aria-label="Model"
          data-testid="model-selector-trigger"
          data-invalid-selection={invalid || undefined}
          aria-invalid={invalid || undefined}
          title={
            resolvedInvalidReason === null ? model?.description : undefined
          }
        >
          <span
            data-testid="model-selector-label"
            className={cn("tracking-[0.02em]", invalid && "text-red")}
          >
            {model?.label ?? selection.modelId}
          </span>
        </SelectTrigger>
      </WithTooltip>
      <SelectContent side="top" align="end" contentLayer={selectContentLayer}>
        {catalog.models.map((option) => (
          <SelectItem
            key={option.id}
            value={option.id}
            description={option.description}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export interface PrimaryModelParameterControlProps {
  catalog: BackendModelCatalog;
  selection: BackendModelSelection;
  parameter: BackendModelParameterDefinition;
  onSelectionChange(selection: BackendModelSelection): void;
  onNeedsOptions(draft: BackendModelSelection): void;
  disabled?: boolean;
  onOpenChange?(open: boolean): void;
  selectContentLayer?: SelectContentLayer;
}

export function PrimaryModelParameterControl({
  catalog,
  selection,
  parameter,
  onSelectionChange,
  onNeedsOptions,
  disabled = false,
  onOpenChange,
  selectContentLayer,
}: PrimaryModelParameterControlProps): React.JSX.Element {
  const value = selection.parameters[parameter.id];
  const changeValue = (nextValue: string): void => {
    const draft = {
      ...selection,
      parameters: { ...selection.parameters, [parameter.id]: nextValue },
    };
    const validation = validateModelSelection(catalog, draft);
    if (!validation.valid) {
      onNeedsOptions(draft);
      return;
    }
    onSelectionChange(validation.selection);
  };

  if (isBooleanParameter(parameter)) {
    return (
      <label className="inline-flex h-9 cursor-pointer items-center gap-sm rounded-md border border-solid border-border-default bg-bg-surface px-md font-mono text-[0.72rem] font-medium text-text-primary transition-all duration-150 hover:border-border-strong hover:bg-bg-raised has-[:focus-visible]:[outline:2px_solid_var(--color-cyan)] has-[:focus-visible]:outline-offset-2">
        <span>{parameter.label}</span>
        <Switch
          size="compact"
          checked={value === "true"}
          onCheckedChange={(checked) => changeValue(checked ? "true" : "false")}
          disabled={disabled}
          aria-label={parameter.label}
        />
      </label>
    );
  }

  const label = parameterValueLabel(parameter, value);
  const title = `${parameter.label}: ${label}`;
  // Reserved for tiers the catalog marks as beyond the provider's normal scale
  // — the design system's one sanctioned use of the rainbow gradient.
  const emphasis = parameterValueEmphasis(parameter, value);

  return (
    <Select
      value={value}
      onValueChange={changeValue}
      disabled={disabled}
      onOpenChange={onOpenChange}
    >
      {emphasis === undefined ? (
        <SelectTrigger aria-label={parameter.label} title={title}>
          <span
            data-testid="model-parameter-label"
            className="tracking-[0.02em]"
          >
            {label}
          </span>
        </SelectTrigger>
      ) : (
        <SelectTrigger asChild>
          <button
            type="button"
            aria-label={parameter.label}
            title={title}
            data-emphasis={emphasis}
            className={cn(RAINBOW_TRIGGER_BASE_CLASS, RAINBOW_TRIGGER_CLASS)}
          >
            <span
              data-testid="model-parameter-label"
              className={cn("tracking-[0.02em]", RAINBOW_TEXT_CLASS)}
            >
              {label}
            </span>
            <span
              className={cn(
                "inline-flex text-[0.7rem] transition-transform duration-150 ease-[ease] group-data-[state=open]:rotate-180",
                RAINBOW_TEXT_CLASS,
              )}
              aria-hidden="true"
            >
              {"▼"}
            </span>
          </button>
        </SelectTrigger>
      )}
      <SelectContent side="top" align="end" contentLayer={selectContentLayer}>
        <ParameterValueItems parameter={parameter} />
      </SelectContent>
    </Select>
  );
}

export interface ModelOptionsEditorProps {
  catalog: BackendModelCatalog;
  selection: BackendModelSelection;
  onApply(selection: BackendModelSelection): void;
  onCancel?(): void;
  disabled?: boolean;
  parameterProminence?: "advanced" | "all";
  selectContentLayer?: SelectContentLayer;
}

export interface DesktopModelSelectionControlsProps {
  catalog: BackendModelCatalog;
  selection: BackendModelSelection;
  onSelectionChange(selection: BackendModelSelection): void;
  invalidReason?: string | null;
  disabled?: boolean;
  onModelOpenChange?(open: boolean): void;
  onPrimaryOpenChange?(open: boolean): void;
  onOptionsOpenChange?(open: boolean): void;
  optionsDefaultOpen?: boolean;
  selectContentLayer?: SelectContentLayer;
}

export function DesktopModelSelectionControls({
  catalog,
  selection,
  onSelectionChange,
  invalidReason = null,
  disabled = false,
  onModelOpenChange,
  onPrimaryOpenChange,
  onOptionsOpenChange,
  optionsDefaultOpen = false,
  selectContentLayer,
}: DesktopModelSelectionControlsProps): React.JSX.Element {
  const selectionKey = modelSelectionKey(selection);
  const [rememberedSelectionKey, setRememberedSelectionKey] =
    useState(selectionKey);
  const [optionsOpen, setOptionsOpen] = useState(optionsDefaultOpen);
  const [optionsDraft, setOptionsDraft] =
    useState<BackendModelSelection>(selection);
  if (selectionKey !== rememberedSelectionKey) {
    setRememberedSelectionKey(selectionKey);
    setOptionsDraft(selection);
  }

  const model = modelForSelection(catalog, selection);
  const primaryParameter = model?.parameters.find(
    (parameter) =>
      parameter.prominence === "primary" && parameter.values.length > 1,
  );
  const hasAdvancedParameters =
    model?.parameters.some(
      (parameter) =>
        parameter.prominence === "advanced" && parameter.values.length > 1,
    ) ?? false;

  const setOpen = (open: boolean): void => {
    setOptionsOpen(open);
    if (open) setOptionsDraft(selection);
    onOptionsOpenChange?.(open);
  };

  const openWithDraft = (draft: BackendModelSelection): void => {
    setOptionsDraft(draft);
    setOptionsOpen(true);
    onOptionsOpenChange?.(true);
  };

  return (
    <div className="flex items-center gap-sm">
      <CatalogModelSelect
        catalog={catalog}
        selection={selection}
        onSelectionChange={onSelectionChange}
        invalidReason={invalidReason}
        disabled={disabled}
        onOpenChange={onModelOpenChange}
        selectContentLayer={selectContentLayer}
      />
      {primaryParameter ? (
        <PrimaryModelParameterControl
          catalog={catalog}
          selection={selection}
          parameter={primaryParameter}
          onSelectionChange={onSelectionChange}
          onNeedsOptions={openWithDraft}
          disabled={disabled}
          onOpenChange={onPrimaryOpenChange}
          selectContentLayer={selectContentLayer}
        />
      ) : null}
      {hasAdvancedParameters ? (
        <Popover open={optionsOpen} onOpenChange={setOpen}>
          <WithTooltip label="Model options">
            <PopoverTrigger asChild>
              <IconButton
                type="button"
                aria-label="Model options"
                disabled={disabled}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="square"
                  strokeLinejoin="miter"
                  aria-hidden="true"
                >
                  <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
                  <circle cx="16" cy="7" r="2" />
                  <circle cx="8" cy="17" r="2" />
                </svg>
              </IconButton>
            </PopoverTrigger>
          </WithTooltip>
          <PopoverContent
            side="top"
            align="end"
            layoutClassName="w-[360px] max-w-[calc(100vw-16px)]"
            aria-label="Model options"
          >
            <div className="mb-sm flex flex-col gap-2xs font-mono">
              <span className="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-text-primary">
                Model options
              </span>
              <span className="text-[0.7rem] text-text-tertiary">
                Apply a complete supported parameter combination.
              </span>
            </div>
            <ModelOptionsEditor
              catalog={catalog}
              selection={optionsDraft}
              parameterProminence="advanced"
              selectContentLayer={selectContentLayer}
              disabled={disabled}
              onCancel={() => setOpen(false)}
              onApply={(nextSelection) => {
                onSelectionChange(nextSelection);
                setOpen(false);
              }}
            />
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}

export function ModelOptionsEditor({
  catalog,
  selection,
  onApply,
  onCancel,
  disabled = false,
  parameterProminence = "all",
  selectContentLayer = "popover",
}: ModelOptionsEditorProps): React.JSX.Element {
  const sourceKey = modelSelectionKey(selection);
  const [rememberedSourceKey, setRememberedSourceKey] = useState(sourceKey);
  const [draft, setDraft] = useState<BackendModelSelection>(selection);
  if (rememberedSourceKey !== sourceKey) {
    setRememberedSourceKey(sourceKey);
    setDraft(selection);
  }

  const model = modelForSelection(catalog, draft);
  const parameters = (model?.parameters ?? []).filter(
    (parameter) =>
      parameter.prominence !== "hidden" &&
      parameter.values.length > 1 &&
      (parameterProminence === "all" || parameter.prominence === "advanced"),
  );
  const validation = validateModelSelection(catalog, draft);
  const conflictParameterIds = new Set(
    model === undefined
      ? []
      : parameters
          .filter(
            (parameter) =>
              !availableParameterValues({
                model,
                draft,
                parameterId: parameter.id,
              }).includes(draft.parameters[parameter.id] ?? ""),
          )
          .map((parameter) => parameter.id),
  );

  const updateParameter = (parameterId: string, value: string): void => {
    setDraft((current) => ({
      ...current,
      parameters: { ...current.parameters, [parameterId]: value },
    }));
  };

  const cancel = (): void => {
    setDraft(selection);
    onCancel?.();
  };

  return (
    <div className="flex min-w-0 w-full flex-col gap-md font-mono">
      {parameters.length === 0 ? (
        <p className="text-[0.72rem] text-text-tertiary">
          This model has no configurable options.
        </p>
      ) : (
        <div className="flex flex-col gap-xs">
          {parameters.map((parameter) => {
            const value = draft.parameters[parameter.id];
            const invalid = conflictParameterIds.has(parameter.id);
            const emphasis = parameterValueEmphasis(parameter, value);
            return (
              <div
                key={parameter.id}
                className="flex min-h-[44px] flex-wrap items-center justify-between gap-md rounded-md border border-solid border-border-subtle bg-bg-surface p-sm data-[invalid=true]:border-red-dim"
                data-invalid={invalid}
                data-emphasis={emphasis}
              >
                <div className="flex min-w-0 flex-col gap-2xs">
                  <span className="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-text-primary">
                    {parameter.label}
                  </span>
                  <span
                    className={cn(
                      "text-[0.7rem]",
                      emphasis === undefined
                        ? "text-text-tertiary"
                        : RAINBOW_TEXT_CLASS,
                    )}
                  >
                    {parameterValueLabel(parameter, value)}
                  </span>
                </div>
                {isBooleanParameter(parameter) ? (
                  <Switch
                    checked={value === "true"}
                    onCheckedChange={(checked) =>
                      updateParameter(parameter.id, checked ? "true" : "false")
                    }
                    disabled={disabled}
                    aria-label={parameter.label}
                    aria-invalid={invalid || undefined}
                  />
                ) : (
                  <Select
                    value={value}
                    onValueChange={(next) =>
                      updateParameter(parameter.id, next)
                    }
                    disabled={disabled}
                  >
                    <SelectTrigger
                      aria-label={parameter.label}
                      aria-invalid={invalid || undefined}
                      layoutClassName="min-w-[120px]"
                    >
                      <span
                        className={cn(
                          emphasis !== undefined && RAINBOW_TEXT_CLASS,
                        )}
                      >
                        {parameterValueLabel(parameter, value)}
                      </span>
                    </SelectTrigger>
                    <SelectContent contentLayer={selectContentLayer}>
                      <ParameterValueItems parameter={parameter} />
                    </SelectContent>
                  </Select>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!validation.valid ? (
        <p
          role="alert"
          className="rounded-sm border border-solid border-red-dim bg-red-glow p-sm text-[0.72rem] text-red"
        >
          Unsupported combination. Adjust the highlighted parameters.
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-sm">
        {onCancel ? (
          <Button type="button" size="sm" variant="ghost" onClick={cancel}>
            Cancel
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="primary"
          disabled={disabled || !validation.valid}
          onClick={() => {
            if (validation.valid) onApply(validation.selection);
          }}
        >
          Apply
        </Button>
      </div>
    </div>
  );
}
