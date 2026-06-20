"use client";

import { cn } from "@/lib/ui/cn";
import McpInheritBadge from "./McpInheritBadge";
import { pendingDot } from "./styles";
import type { McpToolView, McpViewLevel } from "./types";

interface McpToolRowProps {
  serverId: string;
  viewLevel: McpViewLevel;
  tool: McpToolView;
  /** Is the parent server effectively disabled? Controls the dim/lock treatment. */
  serverDisabled: boolean;
  /** Readonly surface (e.g. inherited server row). */
  readonly?: boolean;
  onToggle?(serverId: string, toolName: string, nextEnabled: boolean): void;
  onReset?(serverId: string, toolName: string): void;
}

export default function McpToolRow({
  serverId,
  viewLevel,
  tool,
  serverDisabled,
  readonly = false,
  onToggle,
  onReset,
}: McpToolRowProps): React.JSX.Element {
  const canEdit = !readonly && !serverDisabled;
  const handleToggle = () => {
    if (!canEdit) return;
    onToggle?.(serverId, tool.name, !tool.enabled);
  };
  const handleReset = () => {
    if (!canEdit) return;
    onReset?.(serverId, tool.name);
  };

  const canReset =
    tool.status.kind === "overridden" || tool.status.kind === "disabled";

  return (
    <div
      data-off={!tool.enabled}
      data-source={tool.status.kind}
      data-parent-disabled={serverDisabled}
      className={cn(
        "group/row flex items-center gap-sm rounded-sm px-sm py-[6px] transition-[background] duration-[120ms] hover:bg-bg-surface max-768:py-sm",
        "data-[parent-disabled=true]:opacity-[0.45]",
      )}
    >
      <button
        type="button"
        data-active={tool.enabled}
        className={cn(
          "group/toggle inline-flex shrink-0 cursor-pointer border-0 bg-transparent p-0",
          "focus-visible:rounded-full focus-visible:[outline:2px_solid_var(--cyan)] focus-visible:outline-offset-2",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "max-768:min-h-[var(--touch-target-min)] max-768:min-w-[var(--touch-target-min)] max-768:justify-start max-768:pl-0",
        )}
        role="switch"
        aria-checked={tool.enabled}
        aria-label={`${tool.enabled ? "Disable" : "Enable"} tool ${tool.name}`}
        disabled={!canEdit}
        onClick={handleToggle}
      >
        <span className="relative h-[14px] w-[26px] rounded-full border border-solid border-border-default bg-bg-raised transition-all duration-150 group-data-[active=true]/toggle:border-cyan group-data-[active=true]/toggle:bg-cyan-glow">
          <span className="absolute top-[1px] left-[1px] size-[10px] rounded-full bg-text-tertiary transition-[transform,background] duration-150 group-data-[active=true]/toggle:translate-x-[12px] group-data-[active=true]/toggle:bg-cyan" />
        </span>
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-[1px]">
        <span className="truncate font-mono text-[0.75rem] font-medium group-data-[off=false]/row:text-text-primary group-data-[off=true]/row:text-text-tertiary group-data-[source=disabled]/row:line-through">
          {tool.name}
        </span>
        {tool.description ? (
          <span className="truncate font-mono text-[0.7rem] text-text-tertiary">
            {tool.description}
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-xs">
        {tool.pending ? (
          <span
            className={pendingDot}
            title="Change will apply on next turn"
            aria-label="Pending"
          />
        ) : null}
        <McpInheritBadge status={tool.status} viewLevel={viewLevel} size="sm" />
        {canReset && onReset ? (
          <button
            type="button"
            className="cursor-pointer rounded-sm border-0 bg-transparent px-[4px] py-[2px] text-[0.85rem] leading-none text-text-tertiary transition-all duration-[120ms] hover:bg-bg-hover hover:text-cyan"
            onClick={handleReset}
            title="Reset to inherited value"
            aria-label={`Reset ${tool.name} to inherited value`}
          >
            ↺
          </button>
        ) : null}
      </div>
    </div>
  );
}
