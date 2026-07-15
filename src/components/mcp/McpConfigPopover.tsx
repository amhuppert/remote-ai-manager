"use client";

import { PopoverContent } from "@/components/ui/Popover";
import McpServerList from "./McpServerList";
import { pendingDot } from "./styles";
import type { McpServerCardActions, McpServerView } from "./types";

interface McpConfigPopoverProps {
  onClose(): void;
  /** Servers resolved at the conversation view level. */
  servers: McpServerView[];
  actions: McpServerCardActions;
  /** When true, a "change pending — applies next turn" banner is shown. */
  hasPending?: boolean;
  /** Servers with changes pending relative to the last emission. */
  pendingServerIds?: string[];
}

// The conversation-level MCP panel: an anchored, bottom-opening (`side="top"`)
// right-aligned floating card. It composes `ui/Popover`'s `unstyled` variant so
// it keeps its bespoke `p-0` full-bleed-header + scrollable flex-column box model
// while Radix owns the collision-aware positioning, Escape/outside-click
// dismissal, focus management, and `role="dialog"`/`aria-*` wiring — anchored to
// the trigger owned by `McpConfigButton` (no manual `getBoundingClientRect`).
export default function McpConfigPopover({
  onClose,
  servers,
  actions,
  hasPending,
  pendingServerIds,
}: McpConfigPopoverProps): React.JSX.Element {
  const summary = summarise(servers);
  const pendingCount = pendingServerIds?.length ?? 0;

  return (
    <PopoverContent
      unstyled
      side="top"
      align="end"
      aria-label="MCP configuration"
      contentClassName="z-menu flex max-h-[min(640px,var(--radix-popover-content-available-height))] w-[min(480px,calc(100vw-24px))] flex-col overflow-hidden rounded-[8px] border border-solid border-border-subtle bg-bg-elevated shadow-[var(--cc-shadow-popover)] max-640:max-h-[calc(100vh-24px)]! max-640:w-[calc(100vw-16px)]!"
    >
      <header className="flex items-center gap-sm border-x-0 border-t-0 border-b border-solid border-border-subtle bg-bg-surface px-md py-sm">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="font-mono text-[0.7rem] font-bold tracking-[0.12em] text-[var(--accent-cyan)]">
            CONVERSATION
          </span>
          <span className="font-mono text-[0.85rem] font-semibold text-text-primary">
            MCP Servers
          </span>
        </div>
        <span className="font-mono text-[0.7rem] whitespace-nowrap text-[var(--text-muted)]">
          {summary}
        </span>
        <button
          type="button"
          className="cursor-pointer appearance-none rounded-[3px] border-0 bg-transparent px-[0.4rem] py-[0.2rem] text-[1.2rem] leading-none text-text-secondary hover:bg-bg-hover hover:text-text-primary"
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>
      </header>

      {hasPending || pendingCount > 0 ? (
        <div
          className="flex items-center gap-sm border-x-0 border-t-0 border-b border-solid border-[var(--cc-amber-border-subtle)] bg-[var(--cc-amber-bg-subtle)] px-md py-xs font-mono text-[0.72rem] text-[var(--cc-accent-amber)]"
          role="status"
        >
          <span className={pendingDot} aria-hidden />
          <span>
            {pendingCount > 0
              ? `${pendingCount} change${pendingCount === 1 ? "" : "s"} queued — will apply on next turn`
              : "Changes will apply on next turn"}
          </span>
        </div>
      ) : null}

      <div className="flex-1 overflow-y-auto px-md pt-sm pb-md">
        <McpServerList
          viewLevel="conversation"
          servers={servers}
          actions={actions}
        />
      </div>
    </PopoverContent>
  );
}

function summarise(servers: McpServerView[]): string {
  const total = servers.length;
  const on = servers.filter((s) => s.enabled).length;
  const overrides = servers.filter(
    (s) => s.status.kind === "overridden" || s.status.kind === "disabled",
  ).length;
  if (overrides > 0) {
    return `${on}/${total} enabled · ${overrides} override${overrides === 1 ? "" : "s"}`;
  }
  return `${on}/${total} enabled`;
}
