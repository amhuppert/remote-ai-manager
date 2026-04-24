/**
 * Shared presentational types for the MCP configuration UI.
 *
 * These types describe the view-level state the `McpServerCard` needs to render.
 * Wiring to the discovery/resolver/API layer is handled by each surface
 * (global section, project modal, session modal, conversation popover) — the
 * card is purely presentational and does not know where its data came from.
 */

export type McpViewLevel = "global" | "project" | "session" | "conversation";

export type McpSourceLevel = "global" | "project" | "session" | "conversation";

export type McpScope = "global" | "project";

/**
 * Inheritance status of a server (or tool) at the current viewing level.
 *
 * - `explicit` — the value is set at this very level and is the baseline
 *   (meaningful at global; rare elsewhere).
 * - `inherited` — the effective value comes from a higher level. Row is
 *   rendered read-only; auto-promote on toggle creates an override.
 * - `overridden` — explicit override at the view level whose effective value
 *   is `enabled`. Cyan accent + "Reset to inherit".
 * - `disabled` — explicit override at the view level whose effective value
 *   is disabled. Red accent + strikethrough + "Re-enable (inherit)".
 */
export type McpInheritanceStatus =
  | { kind: "explicit" }
  | { kind: "inherited"; from: McpSourceLevel }
  | { kind: "overridden"; inheritsFrom?: McpSourceLevel }
  | { kind: "disabled"; inheritsFrom?: McpSourceLevel };

export type McpToolDiscoveryState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; tools: McpToolView[] };

export interface McpToolView {
  name: string;
  description?: string;
  /** Effective on/off after cascade resolution. */
  enabled: boolean;
  /** Inheritance status of this tool at the current view level. */
  status: McpInheritanceStatus;
  /** Pending a mid-turn apply — show amber dot. */
  pending?: boolean;
}

export interface McpServerView {
  id: string;
  /** Display name (e.g. "playwright"). */
  name: string;
  /** Absolute path to the source config file. */
  sourceFile: string;
  /** Which definition scope this came from (Command Center .mcp.json). */
  scope: McpScope;
  /** Effective on/off after cascade resolution. */
  enabled: boolean;
  /** Inheritance status of the server row at the current view level. */
  status: McpInheritanceStatus;
  /** Pending a mid-turn apply — show amber dot. */
  pending?: boolean;
  /** Optional runtime diagnostic (e.g. connection error). */
  runtimeError?: string;
  /** Tool list + discovery state. */
  toolDiscovery: McpToolDiscoveryState;
}

/**
 * Action callbacks provided by each surface. Using method syntax for
 * bivariant parameter checking per project convention.
 */
export interface McpServerCardActions {
  /** Main toggle click. If status is `inherited`, surface auto-promotes to override. */
  onToggleEnabled?(serverId: string, nextEnabled: boolean): void;
  /** Explicit "Override" affordance (for users who prefer the button). */
  onOverride?(serverId: string): void;
  /** Clears a server-level override, reverting to the inherited value. */
  onResetToInherit?(serverId: string): void;
  /** Per-tool toggle. Auto-promotes to override if inherited. */
  onToggleTool?(serverId: string, toolName: string, nextEnabled: boolean): void;
  /** Clears a tool-level override. */
  onResetTool?(serverId: string, toolName: string): void;
  /** Force re-discover tools for this server. */
  onRefreshTools?(serverId: string): void;
  /** Fires when the user expands the card and we should lazy-fetch tools. */
  onExpand?(serverId: string): void;
}
