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
};

export function AgentCapabilityPanel({
  title,
  view,
  layerOptions,
  selectedScope,
  onScopeChange,
  loading,
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
  const panelClass = [
    "agent-capability-panel",
    view?.backend === "codex" ? "agent-capability-panel--codex" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const rowsClass = [
    "agent-capability-panel__rows",
    "agent-capability-panel__rows--capabilities",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <section className={panelClass} data-cascade-kind={view?.cascadeKind}>
      {!hideHeader ? (
        <div className="agent-capability-panel__header">
          <div>
            <h2 className="agent-capability-panel__title">{title}</h2>
            <p className="agent-capability-panel__subtitle">
              Toggle this capability set at any available scope. More specific
              layers inherit until they store an override.
            </p>
            {view ? (
              <div className="agent-capability-panel__summary">
                <span>{view.items.length} items</span>
                <span>{view.backend}</span>
                <span>{metadataLabel(view)}</span>
                <span>{overrideCount} overrides here</span>
              </div>
            ) : null}
          </div>
          <div className="agent-capability-panel__actions">
            {onRefresh ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={onRefresh}
              >
                Refresh
              </button>
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

      <div className="agent-capability-panel__toolbar">
        <label className="agent-capability-panel__field">
          <span>Search</span>
          <input
            aria-label={`Search ${title}`}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter items"
          />
        </label>
        <div className="agent-capability-panel__filters">
          {FILTERS.map((filter) => (
            <button
              key={filter.key}
              type="button"
              className={`agent-capability-filter${activeFilter === filter.key ? " agent-capability-filter--active" : ""}`}
              aria-label={filter.ariaLabel}
              aria-pressed={activeFilter === filter.key}
              onClick={() => setActiveFilter(filter.key)}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <div className="agent-capability-panel__scope-note">
          {selectedOption?.label ?? levelLabel(selectedScope.level)}
        </div>
      </div>

      {loading ? (
        <div className="agent-capability-panel__notice">
          Loading capabilities
        </div>
      ) : null}
      {errorMessage ? (
        <div className="agent-capability-panel__error" role="alert">
          {errorMessage}
        </div>
      ) : null}
      {view?.diagnostics.length ? (
        <DiagnosticList diagnostics={view.diagnostics} />
      ) : null}

      <div className={rowsClass}>
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
          <div className="agent-capability-panel__empty">
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
    <div className="agent-capability-levels">
      <span className="agent-capability-levels__label">Editing at</span>
      <div className="agent-capability-levels__stones">
        {layerOptions.map((option) => {
          const value = layerOptionValue(option);
          const active = option.scope
            ? scopeValue(option.scope) === selectedValue
            : false;
          return (
            <button
              key={value}
              type="button"
              className={`agent-capability-level${active ? " agent-capability-level--active" : ""}`}
              disabled={option.disabled || !option.scope}
              aria-pressed={active}
              onClick={() => {
                if (option.scope) onScopeChange(option.scope);
              }}
            >
              <span className="agent-capability-level__name">
                {option.label}
              </span>
              <span className="agent-capability-level__detail">
                {option.detail ??
                  (option.scope ? scopeDetail(option.scope) : "")}
              </span>
            </button>
          );
        })}
      </div>
      <label className="agent-capability-panel__scope-select">
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
  const unavailableReason = controlUnavailableReason(view);
  const controlsDisabled = pending || unavailableReason !== undefined;
  const explicitHere = row.currentLayerValue !== undefined;
  const switchEnabled = row.ownEffectiveState.enabled;
  const className = [
    "agent-capability-row",
    row.effectiveState.enabled ? "agent-capability-row--enabled" : "",
    row.stale ? "agent-capability-row--stale" : "",
    row.inheritedDisableReason ? "agent-capability-row--parent-disabled" : "",
    row.inheritedDisableReason ? "agent-capability-row--plugin-disabled" : "",
    row.applyStatus !== "none" ? "agent-capability-row--pending" : "",
    explicitHere ? "agent-capability-row--explicit" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <article
      className={className}
      data-testid={`capability-row-${row.itemId}`}
      data-item-id={row.itemId}
      data-effective={row.effectiveState.enabled ? "on" : "off"}
    >
      <div className="agent-capability-row__body">
        <div className="agent-capability-row__main">
          <div className="agent-capability-row__identity">
            <span className="agent-capability-row__name">
              {row.displayName}
            </span>
            <span className="agent-capability-row__id">{row.itemId}</span>
          </div>
        </div>
        <div className="agent-capability-row__details">
          <InheritanceChip row={row} />
          {row.owningPluginId ? (
            <PluginChip
              pluginId={row.owningPluginId}
              disabledByPlugin={row.inheritedDisableReason !== undefined}
              backend={row.backend}
              onOpenPlugin={onOpenPlugin}
            />
          ) : null}
          {row.stale ? <StatusChip label="Stale" tone="warning" /> : null}
          {row.applyStatus !== "none" ? (
            <StatusChip
              label={applyStatusLabel(row.applyStatus)}
              tone="pending"
            />
          ) : null}
          {pending ? (
            <span className="agent-capability-row__control-note">Pending</span>
          ) : null}
          {unavailableReason ? (
            <span className="agent-capability-row__control-note">
              {unavailableReason}
            </span>
          ) : null}
        </div>
        {row.diagnostics.length ? (
          <DiagnosticList diagnostics={row.diagnostics} compact />
        ) : null}
      </div>

      {onToggleItem || onResetItem ? (
        <div className="agent-capability-row__controls">
          <button
            type="button"
            className={`agent-capability-row__switch${switchEnabled ? " agent-capability-row__switch--on" : ""}`}
            aria-pressed={switchEnabled}
            aria-label={`${switchEnabled ? "Disable" : "Enable"} ${row.displayName}`}
            disabled={controlsDisabled || !onToggleItem}
            onClick={() => onToggleItem?.(row.itemId, !switchEnabled)}
          >
            <span />
          </button>
          {explicitHere ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm agent-capability-row__reset"
              aria-label={`Reset ${row.displayName}`}
              disabled={controlsDisabled || !onResetItem}
              onClick={() => onResetItem?.(row.itemId)}
            >
              Reset
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function StatusChip({
  label,
  tone,
}: {
  label: string;
  tone?: "warning" | "pending";
}): React.JSX.Element {
  return (
    <span
      className={`agent-capability-status-chip${tone ? ` agent-capability-status-chip--${tone}` : ""}`}
    >
      {label}
    </span>
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
  const className = [
    "agent-capability-plugin-chip",
    disabledByPlugin ? "agent-capability-plugin-chip--suppressed" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const text = disabledByPlugin ? `Off via plugin · ${label}` : `via ${label}`;

  if (!onOpenPlugin) {
    return <span className={className}>{text}</span>;
  }

  return (
    <button
      type="button"
      className={className}
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
      <span
        className={`agent-capability-inheritance agent-capability-inheritance--explicit${row.currentLayerValue.enabled ? "" : "-off"}`}
      >
        Set {enabledStateLabel(row.currentLayerValue.enabled)} at{" "}
        {originLabel(row.currentLayerValue.originLayer)}
      </span>
    );
  }

  return (
    <span className="agent-capability-inheritance">
      Inherits {enabledStateLabel(row.ownEffectiveState.enabled)} from{" "}
      {originLabel(row.ownEffectiveState.originLayer)}
    </span>
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
    <div
      className={
        compact
          ? "agent-capability-diagnostics agent-capability-diagnostics--compact"
          : "agent-capability-diagnostics"
      }
    >
      {diagnostics.map((diagnostic) => (
        <div
          key={`${diagnostic.code}:${diagnostic.itemId ?? ""}:${diagnostic.message}`}
          className={`agent-capability-diagnostic agent-capability-diagnostic--${diagnostic.severity}`}
        >
          <span>{diagnostic.message}</span>
        </div>
      ))}
    </div>
  );
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

function metadataLabel(view: AgentCapabilityViewResponse): string {
  if (!view.metadata) return "metadata unavailable";
  return `${view.metadata.applySemantics} ${view.metadata.compositionSupport}`;
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

function applyStatusLabel(status: AgentCapabilityApplyStatus): string {
  return status.replaceAll("-", " ");
}

function controlUnavailableReason(
  view: AgentCapabilityViewResponse,
): string | undefined {
  if (view.metadata?.compositionSupport === "verification-gated") {
    return "verification gated";
  }
  if (view.metadata?.compositionSupport === "diagnostic-only") {
    return "diagnostic only";
  }
  if (view.metadata?.discoverySupport === "unavailable-pending-verification") {
    return "pending verification";
  }
  return undefined;
}

export function titleForCapabilityCascade(
  cascadeKind: AgentCapabilityCascadeKind,
): string {
  return CASCADE_TITLES[cascadeKind];
}
