export type PortableMcpServerConfig =
  | {
      id: string;
      transport: "stdio";
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      enabled?: boolean;
      enabledTools?: string[];
      disabledTools?: string[];
      startupTimeoutSec?: number;
      toolTimeoutSec?: number;
    }
  | PortableMcpRemoteServer<"streamable-http">
  | PortableMcpRemoteServer<"sse">;

interface PortableMcpRemoteServer<T extends "streamable-http" | "sse"> {
  id: string;
  transport: T;
  url: string;
  headers?: Record<string, string>;
  bearerTokenEnvVar?: string;
  enabled?: boolean;
  enabledTools?: string[];
  disabledTools?: string[];
  startupTimeoutSec?: number;
  toolTimeoutSec?: number;
}

export interface PortableMcpConfig {
  servers: PortableMcpServerConfig[];
}

export interface McpApplyResult {
  disposition:
    | "applied_now"
    | "deferred_to_next_turn"
    | "unsupported"
    | "rejected";
  droppedServerIds: string[];
  droppedFields: string[];
  errors: Record<string, string>;
}

export type PortableMcpToolDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: "server-disabled" | "tool-disabled" | "tool-not-in-allowlist";
    };

/**
 * Neutral per-tool filter decision over an emitted portable MCP config.
 *
 * Denial reasons mirror the spec:
 * - `server-disabled` — `enabled === false` on the emitted entry
 * - `tool-disabled` — tool listed in `disabledTools` (takes precedence over an
 *   allowlist)
 * - `tool-not-in-allowlist` — `enabledTools` is non-empty and the tool is not
 *   listed
 *
 * When the config is `null` (no emitted set yet) or the server key is absent
 * from the emitted set (out-of-scope for this filter), the tool is allowed so
 * unrelated tools are never falsely denied.
 */
export function evaluatePortableMcpToolFilter(
  config: PortableMcpConfig | null,
  input: { serverKey: string; toolName: string },
): PortableMcpToolDecision {
  if (!config) return { allowed: true };

  const server = config.servers.find((s) => s.id === input.serverKey);
  if (!server) return { allowed: true };

  if (server.enabled === false) {
    return { allowed: false, reason: "server-disabled" };
  }

  if (server.disabledTools && server.disabledTools.includes(input.toolName)) {
    return { allowed: false, reason: "tool-disabled" };
  }

  if (
    server.enabledTools &&
    server.enabledTools.length > 0 &&
    !server.enabledTools.includes(input.toolName)
  ) {
    return { allowed: false, reason: "tool-not-in-allowlist" };
  }

  return { allowed: true };
}
