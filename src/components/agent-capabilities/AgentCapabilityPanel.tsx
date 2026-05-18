"use client";

import { useMemo, useState } from "react";

import type {
  AgentCapabilityApplyStatus,
  AgentCapabilityCascadeKind,
  AgentCapabilityCascadeLayer,
  AgentCapabilityDiagnostic,
  AgentCapabilityEffectiveState,
  AgentCapabilitySourceRef,
  AgentCapabilityViewResponse,
  AgentCapabilityViewRow,
} from "@/lib/schemas";
import type { AgentCapabilityScope } from "@/hooks/use-agent-capabilities";

export interface AgentCapabilityLayerOption {
  label: string;
  scope: AgentCapabilityScope;
  disabled?: boolean;
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
  pendingItemIds?: readonly string[];
}

const FILTERS = [
  { key: "enabled", label: "Show enabled" },
  { key: "disabled", label: "Show disabled" },
  { key: "stale", label: "Show stale" },
  { key: "parent-disabled", label: "Show parent-disabled" },
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
  pendingItemIds = [],
}: AgentCapabilityPanelProps): React.JSX.Element {
  const [search, setSearch] = useState("");
  const [activeFilters, setActiveFilters] = useState<ReadonlySet<FilterKey>>(
    () => new Set(),
  );

  const optionByValue = useMemo(() => {
    const out = new Map<string, AgentCapabilityLayerOption>();
    for (const option of layerOptions) {
      out.set(scopeValue(option.scope), option);
    }
    return out;
  }, [layerOptions]);

  const visibleRows = useMemo(() => {
    if (!view) return [];
    const term = search.trim().toLowerCase();
    return view.items.filter((row) => {
      if (term && !rowMatchesSearch(row, term)) return false;
      if (activeFilters.size === 0) return true;
      for (const filter of activeFilters) {
        if (rowMatchesFilter(row, filter)) return true;
      }
      return false;
    });
  }, [activeFilters, search, view]);

  const selectedValue = scopeValue(selectedScope);
  const panelClass = [
    "agent-capability-panel",
    view?.backend === "codex" ? "agent-capability-panel--codex" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <section className={panelClass} data-cascade-kind={view?.cascadeKind}>
      <div className="agent-capability-panel__header">
        <div>
          <h2 className="agent-capability-panel__title">{title}</h2>
          {view ? (
            <div className="agent-capability-panel__summary">
              <span>{view.items.length} items</span>
              <span>{view.backend}</span>
              <span>{metadataLabel(view)}</span>
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
        <label className="agent-capability-panel__field">
          <span>Edited layer</span>
          <select
            aria-label="Edited layer"
            value={selectedValue}
            onChange={(event) => {
              const option = optionByValue.get(event.target.value);
              if (option) onScopeChange(option.scope);
            }}
          >
            {layerOptions.map((option) => (
              <option
                key={scopeValue(option.scope)}
                value={scopeValue(option.scope)}
                disabled={option.disabled}
              >
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <div className="agent-capability-panel__filters">
          {FILTERS.map((filter) => (
            <label key={filter.key} className="agent-capability-filter">
              <input
                type="checkbox"
                aria-label={filter.label}
                checked={activeFilters.has(filter.key)}
                onChange={() => {
                  setActiveFilters((prev) => toggleFilter(prev, filter.key));
                }}
              />
              <span>{filter.label.replace("Show ", "")}</span>
            </label>
          ))}
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

      <div className="agent-capability-panel__rows">
        {view
          ? visibleRows.map((row) => (
              <CapabilityRow
                key={row.itemId}
                row={row}
                view={view}
                onToggleItem={onToggleItem}
                onResetItem={onResetItem}
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

export function ClaudeSkillsPanel(
  props: Omit<AgentCapabilityPanelProps, "title">,
): React.JSX.Element {
  return (
    <AgentCapabilityPanel {...props} title={CASCADE_TITLES["claude-skills"]} />
  );
}

export function ClaudePluginsPanel(
  props: Omit<AgentCapabilityPanelProps, "title">,
): React.JSX.Element {
  return (
    <AgentCapabilityPanel {...props} title={CASCADE_TITLES["claude-plugins"]} />
  );
}

export function ClaudeSubAgentsPanel(
  props: Omit<AgentCapabilityPanelProps, "title">,
): React.JSX.Element {
  return (
    <AgentCapabilityPanel {...props} title={CASCADE_TITLES["claude-agents"]} />
  );
}

export function CodexSkillsPanel(
  props: Omit<AgentCapabilityPanelProps, "title">,
): React.JSX.Element {
  return (
    <AgentCapabilityPanel {...props} title={CASCADE_TITLES["codex-skills"]} />
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
  pending,
}: {
  row: AgentCapabilityViewRow;
  view: AgentCapabilityViewResponse;
  onToggleItem?: (itemId: string, enabled: boolean) => void;
  onResetItem?: (itemId: string) => void;
  pending: boolean;
}): React.JSX.Element {
  const unavailableReason = controlUnavailableReason(view);
  const controlsDisabled = pending || unavailableReason !== undefined;
  const className = [
    "agent-capability-row",
    row.effectiveState.enabled ? "agent-capability-row--enabled" : "",
    row.stale ? "agent-capability-row--stale" : "",
    row.inheritedDisableReason ? "agent-capability-row--parent-disabled" : "",
    row.applyStatus !== "none" ? "agent-capability-row--pending" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <article
      className={className}
      data-testid={`capability-row-${row.itemId}`}
      data-item-id={row.itemId}
    >
      <div className="agent-capability-row__main">
        <div className="agent-capability-row__identity">
          <span className="agent-capability-row__name">{row.displayName}</span>
          <span className="agent-capability-row__id">{row.itemId}</span>
        </div>
        <div className="agent-capability-row__badges">
          <Badge label={`backend ${row.backend}`} />
          <Badge label={sourceLabel(row.source)} />
          <Badge label={`native ${enabledLabel(row.nativeDefault.enabled)}`} />
          <Badge
            label={`effective ${enabledLabel(row.effectiveState.enabled)}`}
          />
          <Badge label={`origin ${row.originLayer}`} />
          <Badge label={runtimeVisibilityLabel(row)} />
          <Badge label={row.runtimeEmittable ? "emittable" : "not emittable"} />
          {row.stale ? <Badge label="stale" tone="warning" /> : null}
          {row.applyStatus !== "none" ? (
            <Badge label={applyStatusLabel(row.applyStatus)} tone="pending" />
          ) : null}
        </div>
      </div>
      <div className="agent-capability-row__details">
        <span>{stateLabel("own", row.ownEffectiveState)}</span>
        {row.currentLayerValue ? (
          <span>current {enabledLabel(row.currentLayerValue.enabled)}</span>
        ) : (
          <span>current inherited</span>
        )}
        {row.inheritedEffectiveState ? (
          <span>{stateLabel("inherited", row.inheritedEffectiveState)}</span>
        ) : null}
        {row.owningPluginId ? <span>plugin {row.owningPluginId}</span> : null}
        {row.inheritedDisableReason ? (
          <span>
            disabled by {row.inheritedDisableReason.pluginId} from{" "}
            {row.inheritedDisableReason.originLayer}
          </span>
        ) : null}
      </div>
      {row.diagnostics.length ? (
        <DiagnosticList diagnostics={row.diagnostics} compact />
      ) : null}
      {onToggleItem || onResetItem ? (
        <div className="agent-capability-row__controls">
          <div
            className="agent-capability-row__toggle-group"
            aria-label={`${row.displayName} enablement controls`}
          >
            <button
              type="button"
              className={`agent-capability-row__toggle${row.effectiveState.enabled ? " active" : ""}`}
              aria-pressed={row.effectiveState.enabled}
              aria-label={`Enable ${row.displayName}`}
              disabled={controlsDisabled || !onToggleItem}
              onClick={() => onToggleItem?.(row.itemId, true)}
            >
              Enabled
            </button>
            <button
              type="button"
              className={`agent-capability-row__toggle${!row.effectiveState.enabled ? " active" : ""}`}
              aria-pressed={!row.effectiveState.enabled}
              aria-label={`Disable ${row.displayName}`}
              disabled={controlsDisabled || !onToggleItem}
              onClick={() => onToggleItem?.(row.itemId, false)}
            >
              Disabled
            </button>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm agent-capability-row__reset"
            aria-label={`Reset ${row.displayName}`}
            disabled={controlsDisabled || !onResetItem}
            onClick={() => onResetItem?.(row.itemId)}
          >
            Reset
          </button>
          {pending ? (
            <span className="agent-capability-row__control-note">pending</span>
          ) : null}
          {unavailableReason ? (
            <span className="agent-capability-row__control-note">
              {unavailableReason}
            </span>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function Badge({
  label,
  tone,
}: {
  label: string;
  tone?: "warning" | "pending";
}): React.JSX.Element {
  return (
    <span
      className={`agent-capability-badge${tone ? ` agent-capability-badge--${tone}` : ""}`}
    >
      {label}
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
  if (filter === "enabled") return row.effectiveState.enabled;
  if (filter === "disabled") return !row.effectiveState.enabled;
  if (filter === "stale") return row.stale;
  return row.inheritedDisableReason !== undefined;
}

function toggleFilter(
  prev: ReadonlySet<FilterKey>,
  filter: FilterKey,
): ReadonlySet<FilterKey> {
  const next = new Set(prev);
  if (next.has(filter)) {
    next.delete(filter);
  } else {
    next.add(filter);
  }
  return next;
}

function scopeValue(scope: AgentCapabilityScope): string {
  if (scope.level === "global") return "global";
  if (scope.level === "project") return `project:${scope.projectName}`;
  if (scope.level === "session") {
    return `session:${scope.projectName}:${scope.sessionName}`;
  }
  return `conversation:${scope.projectName}:${scope.sessionName}:${scope.conversationId}`;
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

function enabledLabel(enabled: boolean): string {
  return enabled ? "enabled" : "disabled";
}

function stateLabel(
  prefix: "own" | "current" | "inherited",
  state: AgentCapabilityEffectiveState,
): string {
  return `${prefix} ${enabledLabel(state.enabled)} from ${state.originLayer}`;
}

function runtimeVisibilityLabel(row: AgentCapabilityViewRow): string {
  if (row.runtimeVisibility === "runtime-visible") return "runtime visible";
  return row.runtimeVisibility.replaceAll("-", " ");
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

export function levelForScope(
  scope: AgentCapabilityScope,
): AgentCapabilityCascadeLayer {
  return scope.level;
}
