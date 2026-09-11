"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/ui/cn";
import { Spinner } from "@/components/ui/Spinner";
import McpInheritBadge from "./McpInheritBadge";
import McpToolRow from "./McpToolRow";
import { McpTransportCompatibility } from "./McpTransportCompatibility";
import { pendingDot } from "./styles";
import type {
  McpInheritanceStatus,
  McpServerCardActions,
  McpServerView,
  McpViewLevel,
} from "./types";

export interface McpServerCardProps {
  /** Which level is viewing this card. Determines badge text and editability. */
  viewLevel: McpViewLevel;
  server: McpServerView;
  actions: McpServerCardActions;
  /** Controls whether the card is initially expanded. */
  defaultOpen?: boolean;
}

function truncatePath(path: string, maxLen = 48): string {
  if (path.length <= maxLen) return path;
  const keepStart = 10;
  const keepEnd = maxLen - keepStart - 1;
  return `${path.slice(0, keepStart)}…${path.slice(-keepEnd)}`;
}

function toolSummary(server: McpServerView): string {
  const d = server.toolDiscovery;
  if (d.kind === "loaded") {
    const on = d.tools.filter((t) => t.enabled).length;
    return `${d.tools.length} tools · ${on} enabled`;
  }
  if (d.kind === "loading") return "Discovering tools…";
  if (d.kind === "error") return "Tool discovery failed";
  return "Tools not yet discovered";
}

const sourceBorderClass: Record<McpInheritanceStatus["kind"], string> = {
  inherited: "border-l-border-subtle",
  explicit: "border-l-border-default",
  overridden: "border-l-cyan",
  disabled: "border-l-red-dim",
};

// Ghost / small footer action button (Override / Reset). Reproduces the legacy
// `btn btn-ghost btn-sm` recipe plus the global ≤768px `.btn-sm` touch target
// (min-height 44px and padding 10px 16px). The Button primitive isn't used: its
// `touch` prop enlarges horizontal padding but not the vertical, so it could not
// reproduce this surface's exact mobile box.
const footerButtonClass =
  "inline-flex cursor-pointer items-center gap-sm rounded-md border border-solid border-transparent bg-transparent px-[12px] py-[6px] font-mono text-[0.72rem] font-medium text-text-secondary transition-all duration-150 ease-[ease] hover:border-border-default hover:bg-bg-hover hover:text-cyan max-768:min-h-[var(--touch-target-min)] max-768:px-[16px] max-768:py-[10px]";

export default function McpServerCard({
  viewLevel,
  server,
  actions,
  defaultOpen,
}: McpServerCardProps): React.JSX.Element {
  const [open, setOpen] = useState<boolean>(defaultOpen ?? false);
  const discoveryRequestedRef = useRef<boolean>(
    server.toolDiscovery.kind === "loaded" ||
      server.toolDiscovery.kind === "loading",
  );

  useEffect(() => {
    if (
      open &&
      !discoveryRequestedRef.current &&
      server.toolDiscovery.kind === "idle"
    ) {
      discoveryRequestedRef.current = true;
      actions.onExpand?.(server.id);
    }
  }, [open, server.toolDiscovery.kind, server.id, actions]);

  const { status } = server;
  const isRefreshing = actions.refreshingServerId === server.id;
  const isInherited = status.kind === "inherited";
  const isDisabled = status.kind === "disabled";
  const isOverridden = status.kind === "overridden";

  const toggleLocked = false;

  const handleHeadClick = useCallback(() => {
    setOpen((prev) => !prev);
  }, []);

  const handleToggle = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (toggleLocked) return;
      actions.onToggleEnabled?.(server.id, !server.enabled);
    },
    [actions, server.id, server.enabled, toggleLocked],
  );

  const handleReset = useCallback(() => {
    actions.onResetToInherit?.(server.id);
  }, [actions, server.id]);

  const handleOverride = useCallback(() => {
    actions.onOverride?.(server.id);
  }, [actions, server.id]);

  const handleRefresh = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      actions.onRefreshTools?.(server.id);
    },
    [actions, server.id],
  );

  // `--pending` box-shadow follows `--source-overridden` in the legacy source,
  // so it wins when both apply; the two are mutually exclusive here.
  const cardShadow = server.pending
    ? "shadow-[0_0_0_1px_var(--color-amber-glow),0_0_10px_-2px_var(--color-amber-glow)]"
    : isOverridden
      ? "shadow-[0_0_12px_-4px_var(--color-cyan-glow)]"
      : "";

  const cardClass = cn(
    "group/card mb-sm rounded-md border border-l-2 border-solid border-border-subtle bg-bg-surface transition-[border-color,box-shadow] duration-150 hover:border-border-default",
    sourceBorderClass[status.kind],
    cardShadow,
  );

  const statusDotClass = cn(
    "size-[8px] shrink-0 rounded-full",
    server.runtimeError
      ? "bg-red shadow-[0_0_6px_var(--color-red-glow),0_0_2px_var(--color-red)]"
      : !server.enabled
        ? "bg-text-tertiary opacity-[0.6]"
        : "bg-green shadow-[0_0_6px_var(--color-green-glow),0_0_2px_var(--color-green)]",
  );

  const nameClass = cn(
    "min-w-0 truncate font-mono text-[0.82rem] font-semibold",
    isDisabled
      ? "text-text-tertiary line-through"
      : !server.enabled
        ? "text-text-secondary"
        : "text-text-primary",
  );

  const summaryClass = cn(
    "min-w-0 flex-1 truncate font-mono text-[0.72rem] font-normal text-text-tertiary",
    isDisabled && "line-through",
  );

  // Tool toggles stay interactive on inherited rows so a user can change a
  // single tool without first overriding the whole server — the per-tool
  // mutation auto-promotes at the current scope. Tools render read-only only
  // when the server is effectively off (handled via parent-disabled styling).
  const showResetServer = isOverridden || isDisabled;

  return (
    <div
      className={cardClass}
      data-open={open}
      data-source={status.kind}
      data-server-id={server.id}
    >
      <button
        type="button"
        className="flex min-h-[48px] w-full cursor-pointer items-center gap-sm border-0 bg-transparent px-md py-sm text-left text-text-primary select-none group-data-[open=true]/card:border-x-0 group-data-[open=true]/card:border-t-0 group-data-[open=true]/card:border-b group-data-[open=true]/card:border-solid group-data-[open=true]/card:border-b-border-subtle hover:rounded-t-[calc(var(--radius-md)-1px)] hover:bg-bg-hover focus-visible:rounded-[calc(var(--radius-md)-1px)] focus-visible:[outline:2px_solid_var(--cyan)] focus-visible:outline-offset-[-2px] max-768:min-h-[var(--touch-target-min)] max-768:flex-wrap max-768:p-sm"
        aria-expanded={open}
        aria-controls={`mcp-server-body--${server.id}`}
        onClick={handleHeadClick}
      >
        <span
          className={cn(
            "inline-flex size-[16px] shrink-0 items-center justify-center text-text-secondary transition-transform duration-150 ease-[ease]",
            !open && "-rotate-90",
          )}
          aria-hidden="true"
        >
          ▾
        </span>
        <span className={statusDotClass} aria-hidden="true" />
        <span className={nameClass}>{server.name}</span>
        <span className={summaryClass}>{toolSummary(server)}</span>
        {server.pending ? (
          <span
            className={pendingDot}
            title="Change will apply on next turn"
            aria-label="Pending"
          />
        ) : null}
        <McpInheritBadge status={status} viewLevel={viewLevel} />
        <span
          role="switch"
          tabIndex={0}
          aria-checked={server.enabled}
          aria-label={`${server.enabled ? "Disable" : "Enable"} ${server.name}`}
          aria-disabled={toggleLocked || undefined}
          data-active={server.enabled}
          className="group/toggle inline-flex shrink-0 cursor-pointer items-center justify-center rounded-sm p-[4px] focus-visible:[outline:2px_solid_var(--cyan)] focus-visible:outline-offset-1 max-768:min-h-[var(--touch-target-min)] max-768:min-w-[var(--touch-target-min)]"
          onClick={handleToggle}
          onKeyDown={(e) => {
            if (e.key === " " || e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              if (!toggleLocked) {
                actions.onToggleEnabled?.(server.id, !server.enabled);
              }
            }
          }}
        >
          <span className="relative h-[18px] w-[32px] rounded-full border border-solid border-border-default bg-bg-raised transition-all duration-150 group-data-[active=true]/toggle:border-cyan group-data-[active=true]/toggle:bg-cyan-glow group-data-[active=true]/toggle:shadow-[0_0_8px_-2px_var(--color-cyan-glow-strong)]">
            <span className="absolute top-[2px] left-[2px] size-[12px] rounded-full bg-text-tertiary transition-[transform,background] duration-150 group-data-[active=true]/toggle:translate-x-[14px] group-data-[active=true]/toggle:bg-cyan" />
          </span>
        </span>
      </button>

      <div
        id={`mcp-server-body--${server.id}`}
        className="flex flex-col gap-md rounded-b-[calc(var(--radius-md)-1px)] bg-bg-base p-md [&[hidden]]:hidden"
        hidden={!open}
      >
        <div className="flex flex-wrap items-center gap-xs font-mono text-[0.7rem] text-text-tertiary">
          <span className="mr-xs font-semibold tracking-[0.08em] text-text-tertiary uppercase">
            SOURCE
          </span>
          <span
            className="max-w-[280px] truncate rounded-sm bg-bg-raised px-[6px] py-[1px] text-text-secondary max-768:max-w-full"
            title={server.sourceFile}
          >
            {truncatePath(server.sourceFile)}
          </span>
          <span className="text-border-default">·</span>
          <span className="font-semibold tracking-[0.05em]">
            {server.scope.toUpperCase()}
          </span>
        </div>

        <McpTransportCompatibility compatibility={server.compatibility} />
        {server.runtimeError ? (
          <div
            className="flex items-center gap-sm rounded-sm bg-red-glow p-sm font-mono text-[0.72rem] text-red-text"
            role="alert"
          >
            <span className="shrink-0 text-[0.9rem]" aria-hidden>
              ✕
            </span>
            <span>{server.runtimeError}</span>
          </div>
        ) : null}

        <div className="flex flex-col gap-xs">
          <div className="flex items-center gap-sm">
            <span className="font-mono text-[0.72rem] font-semibold tracking-[0.08em] text-text-secondary uppercase">
              TOOLS
            </span>
            <span className="ml-auto font-mono text-[0.7rem] text-text-tertiary">
              {toolSummary(server)}
            </span>
            {actions.onRefreshTools ? (
              <button
                type="button"
                className="inline-flex size-[24px] cursor-pointer items-center justify-center rounded-sm border border-solid border-border-subtle bg-transparent p-0 text-[0.85rem] leading-none text-text-secondary transition-all duration-[120ms] hover:border-cyan-dim hover:bg-bg-hover hover:text-cyan focus-visible:[outline:2px_solid_var(--cyan)] focus-visible:outline-offset-1 disabled:cursor-default"
                onClick={handleRefresh}
                title="Refresh tool list"
                aria-label="Refresh tool list"
                disabled={isRefreshing}
                aria-busy={isRefreshing || undefined}
              >
                {isRefreshing ? <Spinner size="sm" tone="inherit" /> : "↻"}
              </button>
            ) : null}
          </div>

          <McpToolList
            serverId={server.id}
            viewLevel={viewLevel}
            discovery={server.toolDiscovery}
            serverDisabled={!server.enabled}
            readonly={false}
            onToggle={actions.onToggleTool}
            onReset={actions.onResetTool}
          />
        </div>

        <div className="flex justify-end gap-sm empty:hidden">
          {isInherited && actions.onOverride ? (
            <button
              type="button"
              className={footerButtonClass}
              onClick={handleOverride}
            >
              Override at {viewLevel}
            </button>
          ) : null}

          {showResetServer && actions.onResetToInherit ? (
            <button
              type="button"
              className={footerButtonClass}
              onClick={handleReset}
            >
              {isDisabled ? "Re-enable (inherit)" : "Reset to inherit"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

interface McpToolListProps {
  serverId: string;
  viewLevel: McpViewLevel;
  discovery: McpServerView["toolDiscovery"];
  serverDisabled: boolean;
  readonly: boolean;
  onToggle?: McpServerCardActions["onToggleTool"];
  onReset?: McpServerCardActions["onResetTool"];
}

// Text colour is applied per-state by the caller: the idle / no-tools
// placeholders are `text-text-tertiary`, the error placeholder is
// `text-red-text`. `cn` is plain clsx (no tailwind-merge), so baking a default
// colour here would collide with the error override and win on source order.
const toolPlaceholderBase =
  "flex items-center justify-center gap-sm rounded-sm border border-dashed border-border-subtle bg-bg-void p-md text-center font-mono text-[0.72rem]";

function McpToolList({
  serverId,
  viewLevel,
  discovery,
  serverDisabled,
  readonly,
  onToggle,
  onReset,
}: McpToolListProps): React.JSX.Element {
  if (discovery.kind === "idle") {
    return (
      <div className={cn(toolPlaceholderBase, "text-text-tertiary")}>
        Tools will load when the server is first used, or click ↻ to discover
        now.
      </div>
    );
  }
  if (discovery.kind === "loading") {
    return (
      <div
        className="flex flex-col gap-[2px] rounded-sm border border-solid border-border-subtle bg-bg-void p-xs"
        aria-busy="true"
      >
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-[24px] animate-[skeleton-shimmer_1.4s_ease-in-out_infinite] rounded-sm bg-[linear-gradient(90deg,var(--bg-raised)_0%,var(--bg-elevated)_50%,var(--bg-raised)_100%)] bg-[length:200%_100%]"
            style={{ animationDelay: `${i * 80}ms` }}
          />
        ))}
      </div>
    );
  }
  if (discovery.kind === "error") {
    return (
      <div className={cn(toolPlaceholderBase, "border-red-dim text-red-text")}>
        <span className="shrink-0 text-[0.9rem]" aria-hidden>
          ✕
        </span>
        <span>Tool discovery failed: {discovery.message}</span>
      </div>
    );
  }
  if (discovery.tools.length === 0) {
    return (
      <div className={cn(toolPlaceholderBase, "text-text-tertiary")}>
        This server exposes no tools.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-[2px] rounded-sm border border-solid border-border-subtle bg-bg-void p-xs">
      {discovery.tools.map((tool) => (
        <McpToolRow
          key={tool.name}
          serverId={serverId}
          viewLevel={viewLevel}
          tool={tool}
          serverDisabled={serverDisabled}
          readonly={readonly}
          onToggle={onToggle}
          onReset={onReset}
        />
      ))}
    </div>
  );
}
