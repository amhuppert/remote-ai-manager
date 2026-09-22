"use client";

import { useMemo, useState } from "react";

import type {
  AgentCapabilityApplyStatus,
  AgentCapabilityCascadeKind,
  AgentCapabilityDiagnostic,
  AgentCapabilitySourceRef,
  AgentCapabilityViewResponse,
  AgentCapabilityViewRow,
} from "@/lib/agent-capabilities/schemas";
import type { AgentCapabilityScope } from "@/hooks/use-agent-capabilities";
import { Button } from "@/components/ui/Button";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/SegmentedControl";
import { Switch } from "@/components/ui/Switch";
import { StatusChip } from "@/components/ui/StatusChip";
import { cn } from "@/lib/ui/cn";
import { SupportIndicator } from "./SupportIndicator";

export interface AgentCapabilityLayerOption {
  label: string;
  scope?: AgentCapabilityScope;
  disabled?: boolean;
  value?: string;
  detail?: string;
}

export interface AgentCapabilityPanelProps {
  title: string;
  view: AgentCapabilityViewResponse | undefined;
  layerOptions: readonly AgentCapabilityLayerOption[];
  selectedScope: AgentCapabilityScope;
  onScopeChange(scope: AgentCapabilityScope): void;
  loading?: boolean;
  /** True while the refresh mutation is in flight — shown on the Refresh control. */
  refreshing?: boolean;
  errorMessage?: string;
  onRefresh?: () => void;
  onToggleItem?: (itemId: string, enabled: boolean) => void;
  onResetItem?: (itemId: string) => void;
  onOpenPlugin?: (
    pluginId: string,
    backend: AgentCapabilityViewRow["backend"],
  ) => void;
  initialSearch?: string;
  pendingItemIds?: readonly string[];
  hideHeader?: boolean;
  hideLevels?: boolean;
}

const FILTERS = [
  { key: "all", label: "All", ariaLabel: "Show all" },
  { key: "overridden", label: "Overridden", ariaLabel: "Show overridden" },
  { key: "enabled", label: "On", ariaLabel: "Show enabled" },
  { key: "disabled", label: "Off", ariaLabel: "Show disabled" },
  { key: "stale", label: "Stale", ariaLabel: "Show stale" },
  {
    key: "parent-disabled",
    label: "Parent off",
    ariaLabel: "Show parent-disabled",
  },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];

const CASCADE_TITLES: Record<AgentCapabilityCascadeKind, string> = {
  "claude-skills": "Claude Skills",
  "claude-plugins": "Claude Plugins",
  "claude-agents": "Claude Sub-Agents",
  "codex-skills": "Codex Skills",
  "codex-plugins": "Codex Plugins",
  "cursor-skills": "Cursor Skills",
  "cursor-plugins": "Cursor Plugins (CC delivery)",
  "cursor-agents": "Cursor Agent Definitions",
};

// Visually-hidden text exposed to screen readers only.
const SR_ONLY =
  "absolute h-px w-px overflow-hidden whitespace-nowrap [clip:rect(0_0_0_0)]";

// Shared by every detail span (including the chips) so long content wraps inside the row.
const DETAILS_SPAN = "min-w-0 [overflow-wrap:anywhere]";

// Base styling for the interactive plugin chip, whose blue hover/focus morph
// and span/button polymorphism are distinct from the tone-coded ui/StatusChip
// pill (the inheritance and status chips compose StatusChip directly).
const CHIP_BASE =
  "inline-flex items-center gap-[4px] whitespace-nowrap rounded-full border border-solid border-border-subtle px-[7px] py-[2px] font-mono text-[0.7rem] font-medium text-text-tertiary";

const PLUGIN_CHIP = cn(
  CHIP_BASE,
  "cursor-pointer bg-transparent transition-[border-color,background,color] duration-150",
  "hover:border-blue-dim hover:bg-blue-glow hover:text-blue",
  "focus-visible:border-blue-dim focus-visible:bg-blue-glow focus-visible:text-blue",
);
const PLUGIN_CHIP_SUPPRESSED = "border-blue-dim bg-blue-glow text-blue";

export function AgentCapabilityPanel({
  title,
  view,
  layerOptions,
  selectedScope,
  onScopeChange,
  loading,
  refreshing,
  errorMessage,
  onRefresh,
  onToggleItem,
  onResetItem,
  onOpenPlugin,
  initialSearch,
  pendingItemIds = [],
  hideHeader,
  hideLevels,
}: AgentCapabilityPanelProps): React.JSX.Element {
  const [search, setSearch] = useState(() => initialSearch ?? "");
  const [activeFilter, setActiveFilter] = useState<FilterKey>("all");

  const optionByValue = useMemo(() => {
    const out = new Map<string, AgentCapabilityLayerOption>();
    for (const option of layerOptions) {
      if (option.scope) out.set(scopeValue(option.scope), option);
    }
    return out;
  }, [layerOptions]);

  const visibleRows = useMemo(() => {
    if (!view) return [];
    const term = search.trim().toLowerCase();
    return view.items.filter((row) => {
      if (term && !rowMatchesSearch(row, term)) return false;
      return rowMatchesFilter(row, activeFilter);
    });
  }, [activeFilter, search, view]);

  const selectedValue = scopeValue(selectedScope);
  const selectedOption = optionByValue.get(selectedValue);
  const overrideCount = view
    ? view.items.filter((row) => row.currentLayerValue !== undefined).length
    : 0;
  const groupUnavailable = view ? controlUnavailableReason(view) : undefined;
  const groupDiagnostics = view?.diagnostics ?? [];
  const groupNotes = [
    ...(view?.metadata?.support?.notes ?? []),
    ...groupDiagnostics
      .filter(
        (diagnostic) =>
          diagnostic.severity === "info" ||
          (groupUnavailable && diagnostic.severity !== "error"),
      )
      .map((diagnostic) => diagnostic.message),
  ];
  if (groupUnavailable) groupNotes.push(groupUnavailable);
  const visibleDiagnostics = groupDiagnostics.filter(
    (diagnostic) =>
      diagnostic.severity === "error" ||
      (diagnostic.severity === "warning" && !groupUnavailable),
  );

  return (
    <section
      className={cn("flex min-h-0 min-w-0 flex-auto flex-col bg-bg-base")}
      data-cascade-kind={view?.cascadeKind}
    >
      {!hideHeader ? (
        <div className="flex min-w-0 items-start justify-between gap-md max-768:flex-col">
          <div>
            <h2 className="font-display text-[1.25rem] leading-[1.2] font-extrabold text-text-primary">
              {title}
            </h2>
            <p className="mt-xs font-mono text-[0.74rem] text-text-secondary">
              Toggle this capability set at any available scope. More specific
              layers inherit until they store an override.
            </p>
            {view ? (
              <div className="mt-[4px] flex flex-wrap gap-xs font-mono text-[0.7rem] text-text-tertiary">
                <span>{view.items.length} items</span>
                <span>{overrideCount} overrides here</span>
              </div>
            ) : null}
          </div>
          <div className="flex-none">
            {onRefresh ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                touch
                loading={refreshing}
                onClick={onRefresh}
              >
                Refresh
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {!hideLevels ? (
        <AgentCapabilityLevelSwitcher
          layerOptions={layerOptions}
          selectedScope={selectedScope}
          onScopeChange={onScopeChange}
        />
      ) : null}

      <div className="flex min-w-0 flex-none flex-wrap items-center gap-sm rounded-md border border-solid border-border-dim border-b-border-subtle bg-bg-void px-xl py-md max-900:flex-col max-900:items-stretch [[data-cap-drawer]_&]:px-lg [[data-cap-drawer]_&]:py-sm">
        <label className="flex max-w-[360px] min-w-[180px] flex-1 flex-col items-center gap-[7px] rounded-md border border-solid border-border-subtle bg-bg-base px-[10px] py-[6px] font-mono text-[0.7rem] font-semibold tracking-[0.06em] text-text-secondary uppercase transition-all duration-150 focus-within:border-cyan focus-within:shadow-[0_0_0_3px_var(--cyan-glow)] max-900:max-w-none">
          <span className={SR_ONLY}>Search</span>
          <input
            aria-label={`Search ${title}`}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter items"
            className="min-h-[34px] w-full rounded-md border-0 bg-transparent px-[8px] py-[6px] font-mono text-[0.76rem] tracking-normal text-text-primary normal-case outline-0 placeholder:text-text-tertiary"
          />
        </label>
        <SegmentedControl
          aria-label={`Filter ${title}`}
          value={activeFilter}
          onValueChange={(next) => {
            const match = FILTERS.find((filter) => filter.key === next);
            if (match) setActiveFilter(match.key);
          }}
          layoutClassName="flex-wrap"
        >
          {FILTERS.map((filter) => (
            <SegmentedControlItem
              key={filter.key}
              value={filter.key}
              aria-label={filter.ariaLabel}
            >
              {filter.label}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
        <div className="ml-auto font-mono text-[0.7rem] whitespace-nowrap text-text-tertiary">
          {selectedOption?.label ?? levelLabel(selectedScope.level)}
        </div>
        <SupportIndicator label={title} notes={groupNotes} />
      </div>

      {loading ? (
        <div className="rounded-sm bg-bg-base p-sm font-mono text-[0.78rem] text-text-secondary">
          Loading capabilities
        </div>
      ) : null}
      {errorMessage ? (
        <div
          className="rounded-sm border border-solid border-red-dim bg-red-glow p-sm font-mono text-[0.78rem] text-red"
          role="alert"
        >
          {errorMessage}
        </div>
      ) : null}
      {visibleDiagnostics.length ? (
        <DiagnosticList diagnostics={visibleDiagnostics} />
      ) : null}

      <div className="grid min-h-0 flex-auto auto-rows-min content-start gap-xs overflow-y-auto px-xl pt-md pb-xl [[data-cap-drawer]_&]:px-lg [[data-cap-drawer]_&]:pt-sm [[data-cap-drawer]_&]:pb-lg">
        {view
          ? visibleRows.map((row) => (
              <CapabilityRow
                key={row.itemId}
                row={row}
                view={view}
                onToggleItem={onToggleItem}
                onResetItem={onResetItem}
                onOpenPlugin={onOpenPlugin}
                pending={pendingItemIds.includes(row.itemId)}
              />
            ))
          : null}
        {view && visibleRows.length === 0 ? (
          <div className="rounded-sm border border-dashed border-border-default p-sm font-mono text-[0.78rem] text-text-tertiary">
            No capabilities match
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function AgentCapabilityLevelSwitcher({
  layerOptions,
  selectedScope,
  onScopeChange,
}: {
  layerOptions: readonly AgentCapabilityLayerOption[];
  selectedScope: AgentCapabilityScope;
  onScopeChange(scope: AgentCapabilityScope): void;
}): React.JSX.Element {
  const selectedValue = scopeValue(selectedScope);
  const optionByValue = new Map(
    layerOptions.flatMap((option) =>
      option.scope ? ([[scopeValue(option.scope), option]] as const) : [],
    ),
  );

  return (
    <div className="mt-lg flex min-w-0 items-stretch pb-lg max-900:flex-col max-900:gap-sm">
      <span className="flex flex-none items-center pr-md font-mono text-[0.7rem] font-semibold tracking-[0.08em] whitespace-nowrap text-text-tertiary uppercase max-900:pr-0">
        Editing at
      </span>
      <div className="flex min-w-0 flex-1 items-stretch overflow-hidden max-900:flex-col max-900:gap-xs">
        {layerOptions.map((option, index) => {
          const value = layerOptionValue(option);
          const active = option.scope
            ? scopeValue(option.scope) === selectedValue
            : false;
          const isFirst = index === 0;
          const isLast = index === layerOptions.length - 1;
          return (
            <button
              key={value}
              type="button"
              className={cn(
                "flex min-w-0 flex-1 cursor-pointer flex-col justify-center gap-[2px] border border-r-0 border-solid border-border-subtle bg-bg-base py-[9px] pr-[12px] pl-[11px] text-left text-text-secondary transition-all duration-150",
                "enabled:hover:border-border-default enabled:hover:bg-bg-surface enabled:hover:text-text-primary",
                "disabled:cursor-not-allowed disabled:opacity-[0.35]",
                "max-900:rounded-md max-900:border max-900:border-border-subtle",
                isFirst && "rounded-l-md",
                isLast && "rounded-r-md border-r border-r-border-subtle",
                active &&
                  "z-[2] border-cyan bg-bg-raised text-cyan shadow-[inset_0_0_0_1px_var(--cyan),0_0_14px_var(--cyan-glow)]",
              )}
              disabled={option.disabled || !option.scope}
              aria-pressed={active}
              onClick={() => {
                if (option.scope) onScopeChange(option.scope);
              }}
            >
              <span className="flex items-center gap-[6px] overflow-hidden font-mono text-[0.7rem] font-semibold tracking-[0.06em] whitespace-nowrap uppercase">
                {option.label}
              </span>
              <span className="mt-[2px] min-w-0 overflow-hidden font-mono text-[0.7rem] text-ellipsis whitespace-nowrap text-text-tertiary">
                {option.detail ??
                  (option.scope ? scopeDetail(option.scope) : "")}
              </span>
            </button>
          );
        })}
      </div>
      <label className={SR_ONLY}>
        <span>Edited layer</span>
        <select
          aria-label="Edited layer"
          value={selectedValue}
          onChange={(event) => {
            const option = optionByValue.get(event.target.value);
            if (option?.scope) onScopeChange(option.scope);
          }}
        >
          {layerOptions.map((option) => (
            <option
              key={layerOptionValue(option)}
              value={layerOptionValue(option)}
              disabled={option.disabled || !option.scope}
            >
              {option.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

export function ClaudeSkillsPanel(
  props: Omit<AgentCapabilityPanelProps, "title">,
): React.JSX.Element {
  return (
    <AgentCapabilityPanel {...props} title={CASCADE_TITLES["claude-skills"]} />
  );
}

export function CodexPluginsPanel(
  props: Omit<AgentCapabilityPanelProps, "title">,
): React.JSX.Element {
  return (
    <AgentCapabilityPanel {...props} title={CASCADE_TITLES["codex-plugins"]} />
  );
}

function CapabilityRow({
  row,
  view,
  onToggleItem,
  onResetItem,
  onOpenPlugin,
  pending,
}: {
  row: AgentCapabilityViewRow;
  view: AgentCapabilityViewResponse;
  onToggleItem?: (itemId: string, enabled: boolean) => void;
  onResetItem?: (itemId: string) => void;
  onOpenPlugin?: (
    pluginId: string,
    backend: AgentCapabilityViewRow["backend"],
  ) => void;
  pending: boolean;
}): React.JSX.Element {
  const unavailableReason = row.support
    ? row.support.configurable
      ? undefined
      : (row.support.notes[0] ?? "Individual selection is unavailable.")
    : controlUnavailableReason(view);
  const controlsDisabled = pending || unavailableReason !== undefined;
  const explicitHere = row.currentLayerValue !== undefined;
  const switchEnabled = row.ownEffectiveState.enabled;
  const effectiveOn = row.effectiveState.enabled;
  const pluginDisabled = row.inheritedDisableReason !== undefined;
  const applyLabel = applyStatusLabel(row.applyStatus);
  const applyPending =
    row.applyStatus === "staged-next-turn" ||
    row.applyStatus === "deferred-next-conversation";
  const visibleDiagnostics = row.diagnostics.filter(
    (diagnostic) =>
      diagnostic.severity === "error" ||
      (diagnostic.severity === "warning" && !unavailableReason),
  );
  const notes = [
    ...(row.support?.notes ?? []),
    ...row.diagnostics
      .filter((diagnostic) => !visibleDiagnostics.includes(diagnostic))
      .map((diagnostic) => diagnostic.message),
  ];
  if (view.level === "conversation") {
    if (row.appliedEnabled === undefined)
      notes.push("Current availability unknown.");
    else if (row.appliedEnabled !== row.effectiveState.enabled) {
      notes.push(
        `Saved ${enabledStateLabel(row.effectiveState.enabled)}. ${row.appliedEnabled ? "Still available" : "Not yet available"} in this conversation.`,
      );
    }
  }

  const borderLeft = pluginDisabled
    ? "border-l-2 border-l-blue"
    : explicitHere
      ? effectiveOn
        ? "border-l-2 border-l-cyan"
        : "border-l-2 border-l-amber"
      : undefined;
  const pendingRing =
    applyPending && !(pluginDisabled || (explicitHere && !effectiveOn))
      ? "shadow-[inset_2px_0_0_var(--cyan)]"
      : undefined;

  return (
    <article
      className={cn(
        "mb-sm grid min-h-[92px] min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-md rounded-md border border-solid border-border-subtle bg-bg-surface px-[14px] py-[11px] transition-[border-color,background] duration-150 hover:border-border-default max-900:grid-cols-[1fr]",
        borderLeft,
        pendingRing,
      )}
      data-testid={`capability-row-${row.itemId}`}
      data-item-id={row.itemId}
      data-effective={effectiveOn ? "on" : "off"}
    >
      <div className="grid min-w-0 gap-xs">
        <div className="grid min-w-0 items-start justify-stretch gap-xs">
          <div className="grid min-w-0 gap-[3px]">
            <span
              className={cn(
                "min-w-0 overflow-hidden font-mono text-[0.86rem] font-medium [overflow-wrap:anywhere] text-ellipsis whitespace-nowrap",
                effectiveOn
                  ? "text-text-primary"
                  : "text-text-secondary line-through decoration-text-tertiary decoration-1",
              )}
            >
              {row.displayName}
            </span>
            <span className="min-w-0 overflow-hidden font-mono text-[0.7rem] [overflow-wrap:anywhere] text-ellipsis whitespace-nowrap text-text-tertiary">
              {row.itemId}
            </span>
          </div>
        </div>
        <div className="mt-[5px] flex min-w-0 flex-wrap items-center gap-sm font-mono text-[0.7rem] text-text-tertiary">
          <InheritanceChip row={row} />
          {row.owningPluginId ? (
            <PluginChip
              pluginId={row.owningPluginId}
              disabledByPlugin={row.inheritedDisableReason !== undefined}
              backend={row.backend}
              onOpenPlugin={onOpenPlugin}
            />
          ) : null}
          {row.stale ? (
            <StatusChip tone="amber" wrap layoutClassName="min-w-0">
              Stale
            </StatusChip>
          ) : null}
          {applyLabel ? (
            <StatusChip
              tone={row.applyStatus === "rejected" ? "red" : "amber"}
              wrap
              layoutClassName="min-w-0"
            >
              {applyLabel}
            </StatusChip>
          ) : null}
          {pending ? (
            <span className={cn(DETAILS_SPAN, "font-mono text-[0.7rem]")}>
              Saving
            </span>
          ) : null}
        </div>
        {visibleDiagnostics.length ? (
          <DiagnosticList diagnostics={visibleDiagnostics} compact />
        ) : null}
      </div>

      {onToggleItem || onResetItem || notes.length ? (
        <div className="flex flex-wrap items-center justify-end gap-sm">
          <SupportIndicator
            label={row.displayName}
            notes={notes}
            action={
              row.owningPluginId && onOpenPlugin
                ? {
                    label: "Open parent plugin",
                    onClick: () => {
                      if (row.owningPluginId)
                        onOpenPlugin(row.owningPluginId, row.backend);
                    },
                  }
                : undefined
            }
          />
          {onToggleItem || onResetItem ? (
            <>
              <Switch
                size="md"
                tone="cyan"
                checked={switchEnabled}
                disabled={controlsDisabled || !onToggleItem}
                aria-label={`${switchEnabled ? "Disable" : "Enable"} ${row.displayName}`}
                onCheckedChange={(next) => onToggleItem?.(row.itemId, next)}
              />
              {explicitHere ? (
                // Retained on the `.btn` leaf recipe: this control needs a
                // disabled-state fade (`disabled:opacity-45`), which the Button
                // primitive cannot carry (it accepts no appearance className, and
                // the fade is keyed on the button's own :disabled state, not the
                // layout allowlist). Integration tracks this as a remediation
                // consumer; see ApprovalGatePanel's local recipe for the precedent.
                <button
                  type="button"
                  className="btn btn-ghost btn-sm disabled:cursor-not-allowed disabled:opacity-45 max-768:min-h-[var(--touch-target-min)]"
                  aria-label={`Reset ${row.displayName}`}
                  disabled={pending || !onResetItem}
                  onClick={() => onResetItem?.(row.itemId)}
                >
                  Reset
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function PluginChip({
  pluginId,
  disabledByPlugin,
  backend,
  onOpenPlugin,
}: {
  pluginId: string;
  disabledByPlugin: boolean;
  backend: AgentCapabilityViewRow["backend"];
  onOpenPlugin?: (
    pluginId: string,
    backend: AgentCapabilityViewRow["backend"],
  ) => void;
}): React.JSX.Element {
  const label = pluginDisplayName(pluginId);
  const chipClass = cn(PLUGIN_CHIP, disabledByPlugin && PLUGIN_CHIP_SUPPRESSED);
  const text = disabledByPlugin ? `Off via plugin · ${label}` : `via ${label}`;

  if (!onOpenPlugin) {
    return <span className={cn(chipClass, DETAILS_SPAN)}>{text}</span>;
  }

  return (
    <button
      type="button"
      className={chipClass}
      aria-label={`Open ${label} plugin configuration`}
      onClick={() => onOpenPlugin(pluginId, backend)}
    >
      {text}
    </button>
  );
}

function InheritanceChip({
  row,
}: {
  row: AgentCapabilityViewRow;
}): React.JSX.Element {
  if (row.currentLayerValue) {
    return (
      <StatusChip
        tone={row.currentLayerValue.enabled ? "cyan" : "amber"}
        wrap
        layoutClassName="min-w-0"
      >
        Set {enabledStateLabel(row.currentLayerValue.enabled)} at{" "}
        {originLabel(row.currentLayerValue.originLayer)}
      </StatusChip>
    );
  }

  return (
    <StatusChip wrap layoutClassName="min-w-0">
      Inherits {enabledStateLabel(row.ownEffectiveState.enabled)} from{" "}
      {originLabel(row.ownEffectiveState.originLayer)}
    </StatusChip>
  );
}

function DiagnosticList({
  diagnostics,
  compact,
}: {
  diagnostics: readonly AgentCapabilityDiagnostic[];
  compact?: boolean;
}): React.JSX.Element {
  return (
    <div className={cn("grid gap-[4px]", compact && "mt-[2px]")}>
      {diagnostics.map((diagnostic) => (
        <div
          key={`${diagnostic.code}:${diagnostic.itemId ?? ""}:${diagnostic.message}`}
          className={cn(
            "rounded-sm px-[8px] py-[6px] font-mono text-[0.72rem] [overflow-wrap:anywhere]",
            diagnosticToneClass(diagnostic.severity),
          )}
        >
          <span>{diagnostic.message}</span>
        </div>
      ))}
    </div>
  );
}

function diagnosticToneClass(
  severity: AgentCapabilityDiagnostic["severity"],
): string {
  if (severity === "warning") return "bg-amber-glow text-amber";
  if (severity === "error") return "bg-red-glow text-red";
  return "bg-bg-raised text-text-secondary";
}

function rowMatchesSearch(row: AgentCapabilityViewRow, term: string): boolean {
  return [
    row.displayName,
    row.itemId,
    row.owningPluginId ?? "",
    sourceLabel(row.source),
  ].some((value) => value.toLowerCase().includes(term));
}

function rowMatchesFilter(
  row: AgentCapabilityViewRow,
  filter: FilterKey,
): boolean {
  if (filter === "all") return true;
  if (filter === "overridden") return row.currentLayerValue !== undefined;
  if (filter === "enabled") return row.effectiveState.enabled;
  if (filter === "disabled") return !row.effectiveState.enabled;
  if (filter === "stale") return row.stale;
  return row.inheritedDisableReason !== undefined;
}

function scopeValue(scope: AgentCapabilityScope): string {
  if (scope.level === "global") return "global";
  if (scope.level === "project") return `project:${scope.projectName}`;
  if (scope.level === "session") {
    return `session:${scope.projectName}:${scope.sessionName}`;
  }
  if (scope.conversationScope === "project") {
    return `project-conversation:${scope.projectName}:${scope.conversationId}`;
  }
  return `conversation:${scope.projectName}:${scope.sessionName}:${scope.conversationId}`;
}

function layerOptionValue(option: AgentCapabilityLayerOption): string {
  if (option.scope) return scopeValue(option.scope);
  return option.value ?? `disabled:${option.label}`;
}

function levelLabel(level: AgentCapabilityScope["level"]): string {
  if (level === "global") return "Global";
  if (level === "project") return "Project";
  if (level === "session") return "Session";
  return "Conversation";
}

function scopeDetail(scope: AgentCapabilityScope): string {
  if (scope.level === "global") return "CC defaults";
  if (scope.level === "project") return scope.projectName;
  if (scope.level === "session") return scope.sessionName;
  return scope.conversationId;
}

function sourceLabel(source: AgentCapabilitySourceRef): string {
  if (source.kind === "plugin") return `plugin: ${source.pluginId}`;
  if (source.kind === "sdk-runtime") return "sdk runtime";
  return `${source.kind}: ${source.path}`;
}

function enabledStateLabel(enabled: boolean): string {
  return enabled ? "on" : "off";
}

function originLabel(layer: AgentCapabilityViewRow["originLayer"]): string {
  if (layer === "global") return "Global";
  if (layer === "project") return "Project";
  if (layer === "session") return "Session";
  if (layer === "conversation") return "Conversation";
  return "native";
}

function pluginDisplayName(pluginId: string): string {
  return pluginId.startsWith("plugin:")
    ? pluginId.slice("plugin:".length)
    : pluginId;
}

function applyStatusLabel(
  status: AgentCapabilityApplyStatus,
): string | undefined {
  if (status === "staged-next-turn") return "Applies next turn";
  if (status === "deferred-next-conversation")
    return "Applies in a new conversation";
  if (status === "rejected") return "Apply failed";
  return undefined;
}

function controlUnavailableReason(
  view: AgentCapabilityViewResponse,
): string | undefined {
  if (view.metadata?.support?.configurable === false) {
    return (
      view.metadata.support.notes[0] ?? "Individual selection is unavailable."
    );
  }
  if (view.metadata?.compositionSupport === "verification-gated") {
    return "Individual selection is not yet verified. Saved preferences are retained.";
  }
  if (view.metadata?.compositionSupport === "diagnostic-only") {
    return "CC can discover these capabilities but cannot apply individual selection.";
  }
  if (view.metadata?.discoverySupport === "unavailable-pending-verification") {
    return "Native discovery is not yet verified. Saved preferences are retained.";
  }
  return undefined;
}

export function titleForCapabilityCascade(
  cascadeKind: AgentCapabilityCascadeKind,
): string {
  return CASCADE_TITLES[cascadeKind];
}
