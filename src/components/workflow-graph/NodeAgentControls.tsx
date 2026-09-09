"use client";

import { useEffect, useId } from "react";
import { create } from "zustand";
import { IconButton } from "@/components/ui/IconButton";
import { WithTooltip } from "@/components/ui/WithTooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/Select";
import {
  parameterValueEmphasis,
  RAINBOW_TEXT_CLASS,
} from "@/components/model-selection-presentation";
import {
  getConfiguredBackendModelCatalog,
  listBackendCatalogEntries,
  modelDisplayLabel,
} from "@/lib/agent-backends/catalog";
import {
  availableParameterValues,
  defaultSelectionForModel,
} from "@/lib/agent-backends/model-selection";
import type { BackendModelParameterValueEmphasis } from "@/lib/agent-backends/schemas";
import { cn } from "@/lib/ui/cn";
import { createClientLogger } from "@/lib/logging/client-logger";
import { workflowBackendRefusal } from "@/lib/workflow-graph/backend-admission";
import {
  graphWorkflowAgentConfigSchema,
  type GraphWorkflowAgentConfig,
} from "@/lib/workflow-graph/config-schemas";
import { backendIsCodexToned, nodeParameterLabel } from "./node-presentation";

const log = createClientLogger("workflow-graph/node-agent-controls");
const useNodeMenuStore = create<{ openId: string | null }>(() => ({
  openId: null,
}));

function setNodeMenuOpen(id: string, open: boolean): void {
  useNodeMenuStore.setState((state) => {
    if (!open && state.openId !== id) return state;
    const openId = open ? id : null;
    if (state.openId === openId) return state;
    log.debug("menu.open.changed", { previousId: state.openId, openId });
    return { openId };
  });
}

const VALUE_CLASS =
  "inline-flex min-h-6 min-w-0 items-center gap-xs rounded-sm border-0 bg-transparent px-2xs py-2xs text-left font-mono text-[0.7rem] leading-normal text-text-primary";

export const NODE_AGENT_GRID_CLASS =
  "grid grid-cols-[8.5ch_minmax(0,1fr)_7ch_24px] gap-x-2xs font-mono text-[0.7rem] max-768:grid-cols-[8.5ch_minmax(0,1fr)_48px_44px]";

const COLUMN_CLASS = {
  backend: "col-start-1 row-start-1",
  model: "col-start-2 row-start-1",
  parameter: "col-start-3",
} as const;

interface NodeSelectOption {
  value: string;
  label: string;
  emphasis?: BackendModelParameterValueEmphasis;
  disabled?: boolean;
  description?: string;
}

function NodeSelect({
  label,
  value,
  text,
  options,
  onChange,
  disabled,
  emphasis,
  tone,
  column,
}: {
  label: string;
  value: string;
  text: string;
  options: NodeSelectOption[];
  onChange?: (value: string) => void;
  disabled?: boolean;
  emphasis?: BackendModelParameterValueEmphasis;
  tone?: "cyan" | "violet";
  column: keyof typeof COLUMN_CLASS;
}) {
  const menuId = useId();
  const open = useNodeMenuStore((state) => state.openId === menuId);
  const editable = Boolean(onChange) && !disabled;
  useEffect(() => {
    if (!editable) setNodeMenuOpen(menuId, false);
    return () => setNodeMenuOpen(menuId, false);
  }, [menuId, editable]);

  const contents = (
    <>
      {tone && (
        <span
          aria-hidden="true"
          className={cn(
            "size-[6px] shrink-0 rounded-full",
            tone === "violet" ? "bg-violet" : "bg-cyan",
          )}
        />
      )}
      <span
        data-emphasis={emphasis}
        className={cn("min-w-0 break-words", emphasis && RAINBOW_TEXT_CLASS)}
      >
        {text}
      </span>
    </>
  );
  if (!onChange)
    return (
      <span title={label} className={cn(VALUE_CLASS, COLUMN_CLASS[column])}>
        {contents}
      </span>
    );
  return (
    <Select
      value={value}
      onValueChange={onChange}
      disabled={disabled}
      open={open}
      onOpenChange={(next) => setNodeMenuOpen(menuId, next)}
    >
      <SelectTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          data-emphasis={emphasis}
          className={cn(
            VALUE_CLASS,
            COLUMN_CLASS[column],
            "nodrag nopan cursor-pointer transition-colors hover:bg-bg-surface focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 disabled:cursor-wait disabled:opacity-60 data-[state=open]:bg-bg-surface max-768:min-h-[44px] max-768:min-w-[44px]",
          )}
        >
          {contents}
        </button>
      </SelectTrigger>
      <SelectContent
        side="bottom"
        align="start"
        onCloseAutoFocus={(event) => {
          if (useNodeMenuStore.getState().openId !== null)
            event.preventDefault();
        }}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            disabled={option.disabled}
            description={option.description}
            data-emphasis={option.emphasis}
          >
            <span className={cn(option.emphasis && RAINBOW_TEXT_CLASS)}>
              {option.label}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function NodeFastToggle({
  label,
  enabled,
  disabled,
  onChange,
}: {
  label: string;
  enabled: boolean;
  disabled?: boolean;
  onChange?: () => void;
}) {
  const description = `${label} fast mode: ${enabled ? "on" : "off"}`;
  const icon = (
    <svg
      aria-hidden="true"
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="square"
      strokeLinejoin="miter"
    >
      <path d="m13 3-8 11h6l-1 7 9-12h-7l1-6Z" />
    </svg>
  );
  if (!onChange)
    return (
      <span
        role="img"
        aria-label={description}
        title={description}
        className={cn(
          "col-start-4 row-start-1 inline-flex size-6 items-center justify-center justify-self-center",
          enabled ? "text-amber" : "text-text-tertiary",
        )}
      >
        {icon}
      </span>
    );
  return (
    <WithTooltip label={description}>
      <IconButton
        variant="ghost"
        type="button"
        aria-label={`${label} fast mode`}
        aria-pressed={enabled}
        pressed={enabled}
        disabled={disabled}
        onClick={onChange}
        layoutClassName="col-start-4 row-start-1 justify-self-center"
      >
        {icon}
      </IconButton>
    </WithTooltip>
  );
}

export function NodeAgentControls({
  agent,
  label,
  onChange,
  disabled,
}: {
  agent: GraphWorkflowAgentConfig;
  label: string;
  onChange?: (agent: GraphWorkflowAgentConfig) => void;
  disabled?: boolean;
}) {
  const selection = agent.modelSelection;
  const standardCatalog = getConfiguredBackendModelCatalog(agent.backend);
  const catalog = standardCatalog.models.some(
    (entry) =>
      entry.id === selection.modelId ||
      entry.aliases.includes(selection.modelId),
  )
    ? standardCatalog
    : getConfiguredBackendModelCatalog(agent.backend, selection);
  const model = catalog.models.find(
    (entry) =>
      entry.id === selection.modelId ||
      entry.aliases.includes(selection.modelId),
  );
  const backends = listBackendCatalogEntries();
  const backend = backends.find((entry) => entry.id === agent.backend);
  return (
    <div
      data-disabled={disabled}
      className={cn(
        NODE_AGENT_GRID_CLASS,
        "nodrag nopan items-center data-[disabled=true]:opacity-60",
      )}
      onClick={onChange ? (event) => event.stopPropagation() : undefined}
      onPointerDown={onChange ? (event) => event.stopPropagation() : undefined}
      onKeyDown={onChange ? (event) => event.stopPropagation() : undefined}
    >
      <NodeSelect
        column="backend"
        label={`${label} backend`}
        value={agent.backend}
        text={backend?.label ?? agent.backend}
        tone={backendIsCodexToned(agent.backend) ? "violet" : "cyan"}
        disabled={disabled}
        options={backends.map((entry) => ({
          value: entry.id,
          label: entry.label,
          disabled: workflowBackendRefusal(entry) !== null,
          description: workflowBackendRefusal(entry) ?? undefined,
        }))}
        onChange={
          onChange
            ? (value) => {
                const next = backends.find((entry) => entry.id === value);
                if (!next || workflowBackendRefusal(next)) return;
                const nextCatalog = getConfiguredBackendModelCatalog(next.id);
                onChange(
                  graphWorkflowAgentConfigSchema.parse({
                    backend: next.id,
                    modelSelection: defaultSelectionForModel(
                      nextCatalog,
                      nextCatalog.defaultModelId,
                    ),
                  }),
                );
              }
            : undefined
        }
      />
      <NodeSelect
        column="model"
        label={`${label} model`}
        value={model?.id ?? selection.modelId}
        text={modelDisplayLabel(agent.backend, selection.modelId)}
        disabled={disabled}
        options={catalog.models.map((entry) => ({
          value: entry.id,
          label: entry.label,
        }))}
        onChange={
          onChange
            ? (modelId) =>
                onChange({
                  ...agent,
                  modelSelection: defaultSelectionForModel(catalog, modelId),
                })
            : undefined
        }
      />
      {Object.entries(selection.parameters)
        .sort(
          ([left], [right]) =>
            Number(left === "fast") - Number(right === "fast"),
        )
        .map(([id, value]) => {
          const parameter = model?.parameters.find((entry) => entry.id === id);
          const isLevel = id === "effort" || id === "reasoning";
          const available =
            model && parameter
              ? availableParameterValues({
                  model,
                  draft: selection,
                  parameterId: id,
                })
              : [];
          const update =
            onChange && parameter
              ? (next: string) =>
                  onChange({
                    ...agent,
                    modelSelection: {
                      ...selection,
                      parameters: { ...selection.parameters, [id]: next },
                    },
                  })
              : undefined;
          if (id === "fast") {
            const next = value === "true" ? "false" : "true";
            return (
              <NodeFastToggle
                key={id}
                label={label}
                enabled={value === "true"}
                disabled={disabled || !available.includes(next)}
                onChange={update ? () => update(next) : undefined}
              />
            );
          }
          return (
            <NodeSelect
              key={id}
              column="parameter"
              label={`${label} ${isLevel ? "level" : (parameter?.label.toLowerCase() ?? id)}`}
              value={value}
              text={nodeParameterLabel(id, value, parameter?.label)}
              emphasis={
                parameter ? parameterValueEmphasis(parameter, value) : undefined
              }
              disabled={disabled}
              options={
                parameter?.values.map((option) => ({
                  ...option,
                  disabled: !available.includes(option.value),
                })) ?? []
              }
              onChange={update}
            />
          );
        })}
    </div>
  );
}
