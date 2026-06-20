"use client";

import { cn } from "@/lib/ui/cn";
import type { McpInheritanceStatus, McpViewLevel } from "./types";

interface McpInheritBadgeProps {
  status: McpInheritanceStatus;
  viewLevel: McpViewLevel;
  /** Renders the pill at a smaller size for use inside tool rows. */
  size?: "default" | "sm";
}

const badgeBase =
  "font-mono text-[0.7rem] font-semibold uppercase rounded-full whitespace-nowrap shrink-0";

const badgeSize: Record<"default" | "sm", string> = {
  default: "tracking-[0.06em] px-[8px] py-[2px]",
  sm: "tracking-[0.04em] px-[6px] py-[1px]",
};

const badgeVariant: Record<McpInheritanceStatus["kind"], string> = {
  explicit: "text-text-tertiary bg-bg-raised",
  inherited:
    "text-text-tertiary bg-transparent border border-dashed border-border-default",
  overridden:
    "text-cyan bg-cyan-glow shadow-[0_0_6px_-2px_var(--color-cyan-glow-strong)]",
  disabled: "text-red-text bg-red-glow",
};

function upper(level: string): string {
  return level.toUpperCase();
}

/**
 * Small pill that communicates the inheritance/override state of a server
 * or tool at the current view level. Visual language mirrors
 * `.wb-inspector-block__badge` from the workflow inspector.
 */
export default function McpInheritBadge({
  status,
  viewLevel,
  size = "default",
}: McpInheritBadgeProps): React.JSX.Element | null {
  const cls = cn(badgeBase, badgeSize[size], badgeVariant[status.kind]);

  if (status.kind === "explicit") {
    // At global view this is the baseline — don't render. At deeper views it
    // indicates the server was declared at this level and nowhere else.
    if (viewLevel === "global") return null;
    return <span className={cls}>{upper(viewLevel)}</span>;
  }

  if (status.kind === "inherited") {
    return <span className={cls}>INHERITED · {upper(status.from)}</span>;
  }

  if (status.kind === "overridden") {
    return <span className={cls}>OVERRIDDEN · {upper(viewLevel)}</span>;
  }

  // disabled
  return <span className={cls}>DISABLED · {upper(viewLevel)}</span>;
}
