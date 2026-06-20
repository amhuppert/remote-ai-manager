"use client";

import { cn } from "@/lib/ui/cn";
import { pendingDot } from "./styles";
import type { McpServerView } from "./types";

interface McpInfoChipProps {
  servers: McpServerView[];
  onClick(): void;
  /** Tighter spacing for info strips. */
  compact?: boolean;
}

const chipBase =
  "inline-flex items-center gap-[0.35rem] appearance-none rounded-full border border-solid border-border-subtle bg-bg-surface text-text-secondary font-mono text-[0.7rem] cursor-pointer transition-[background,color,border-color] duration-[120ms] " +
  // Hover background always applies; hover text/border only when there are no
  // overrides (legacy `.has-overrides` follows the hover rule in source order).
  "hover:bg-bg-hover data-[overrides=false]:hover:text-text-primary data-[overrides=false]:hover:border-border-default " +
  "data-[overrides=true]:border-[var(--accent-cyan)] data-[overrides=true]:text-[var(--accent-cyan)]";

const chipSize: Record<"default" | "compact", string> = {
  default: "px-[0.55rem] py-[0.25rem]",
  compact: "px-[0.45rem] py-[0.15rem]",
};

/**
 * Small pill summarising the MCP state at a given level. Shows total/enabled
 * counts and an amber accent when overrides exist at this level. Clicking
 * opens the owning surface (session or project modal).
 */
export default function McpInfoChip({
  servers,
  onClick,
  compact,
}: McpInfoChipProps): React.JSX.Element {
  const total = servers.length;
  const on = servers.filter((s) => s.enabled).length;
  const overrides = servers.filter(
    (s) => s.status.kind === "overridden" || s.status.kind === "disabled",
  ).length;
  const hasPending = servers.some((s) => s.pending);

  const label = total === 0 ? "MCP · none" : `MCP · ${on}/${total}`;
  const title =
    overrides > 0
      ? `${on} of ${total} enabled — ${overrides} override${overrides === 1 ? "" : "s"} at this level`
      : `${on} of ${total} MCP server${total === 1 ? "" : "s"} enabled`;

  return (
    <button
      type="button"
      onClick={onClick}
      data-overrides={overrides > 0}
      className={cn(chipBase, chipSize[compact ? "compact" : "default"])}
      title={title}
      aria-label={title}
    >
      <span
        className="size-[6px] rounded-full bg-current opacity-80 shadow-[0_0_4px_currentColor]"
        aria-hidden
      />
      <span className="whitespace-nowrap">{label}</span>
      {overrides > 0 ? (
        <span
          className="min-w-[1rem] rounded-full bg-current px-[0.25rem] text-center text-[0.7rem] leading-[1.2] font-bold text-bg-void"
          aria-hidden
        >
          {overrides}
        </span>
      ) : null}
      {hasPending ? (
        <span
          className={pendingDot}
          aria-label="Pending changes"
          title="Changes will apply on next turn"
        />
      ) : null}
    </button>
  );
}
