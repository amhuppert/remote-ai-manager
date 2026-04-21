"use client";

import type { McpInheritanceStatus, McpViewLevel } from "./types";

interface McpInheritBadgeProps {
  status: McpInheritanceStatus;
  viewLevel: McpViewLevel;
  /** Renders the pill at a smaller size for use inside tool rows. */
  size?: "default" | "sm";
}

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
  const cls = `mcp-inherit-badge mcp-inherit-badge--${status.kind}${size === "sm" ? " mcp-inherit-badge--sm" : ""}`;

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
