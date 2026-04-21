import type {
  McpServerConfig,
  McpServerToolPolicy,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  PortableMcpConfig,
  PortableMcpServerConfig,
} from "./portable-mcp";
import {
  claudeMcpCapabilities,
  codexMcpCapabilities,
  type McpBackendCapabilities,
  type McpToolFilteringMode,
} from "@/lib/mcp/backend-capabilities";

export interface PortableMcpToCodexResult {
  mcpServers: Record<string, unknown>;
  droppedFields: string[];
}

export interface PortableMcpToClaudeResult {
  servers: Record<string, McpServerConfig>;
  rejectedServers: string[];
  rejectedFields: string[];
  errorsByServer: Record<string, string>;
}

export interface TranslationOptions {
  capabilities?: McpBackendCapabilities;
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/**
 * Build the Claude SDK's per-tool `tools` policy list from the portable entry's
 * enabled/disabled tool sets. Returns `undefined` when no policies apply, so the
 * caller can omit the field entirely.
 *
 * Only called when `filteringForTransport` is `"native"` — for `"permission-layer"`
 * transports (stdio) the canUseTool fallback enforces the filter at call time.
 */
function buildNativeToolPolicies(
  server: PortableMcpServerConfig,
  filteringForTransport: McpToolFilteringMode,
): McpServerToolPolicy[] | undefined {
  if (filteringForTransport !== "native") return undefined;
  const policies: McpServerToolPolicy[] = [];
  if (server.enabledTools) {
    for (const name of server.enabledTools) {
      policies.push({ name, permission_policy: "always_allow" });
    }
  }
  if (server.disabledTools) {
    for (const name of server.disabledTools) {
      policies.push({ name, permission_policy: "always_deny" });
    }
  }
  return policies.length > 0 ? policies : undefined;
}

/**
 * Translate the portable MCP config into the shape Codex expects.
 *
 * All backend-specific decisions (whether to emit `enabled: false` natively or
 * drop the entry entirely, whether tool filters are supported per transport)
 * are routed through the injected capability metadata — no branching on
 * backend identity.
 */
export function translatePortableMcpToCodex(
  config: PortableMcpConfig,
  options: TranslationOptions = {},
): PortableMcpToCodexResult {
  const capabilities = options.capabilities ?? codexMcpCapabilities;
  const mcpServers: Record<string, unknown> = {};

  for (const server of config.servers) {
    if (server.enabled === false && capabilities.serverDisable === "omit") {
      continue;
    }

    const entry: Record<string, unknown> = {};

    if (server.transport === "stdio") {
      entry.command = server.command;
      if (server.args !== undefined) entry.args = server.args;
      if (server.env !== undefined) entry.env = server.env;
      if (server.cwd !== undefined) entry.cwd = server.cwd;
    } else {
      entry.url = server.url;
      if (server.headers !== undefined) entry.http_headers = server.headers;
      if (server.bearerTokenEnvVar !== undefined) {
        entry.bearer_token_env_var = server.bearerTokenEnvVar;
      }
    }

    if (
      server.enabled !== undefined &&
      capabilities.serverDisable === "native"
    ) {
      entry.enabled = server.enabled;
    }

    const filteringForTransport =
      capabilities.toolFiltering.byTransport[server.transport];
    if (filteringForTransport === "native") {
      if (server.enabledTools !== undefined) {
        entry.enabled_tools = server.enabledTools;
      }
      if (server.disabledTools !== undefined) {
        entry.disabled_tools = server.disabledTools;
      }
    }

    if (server.startupTimeoutSec !== undefined) {
      entry.startup_timeout_sec = server.startupTimeoutSec;
    }
    if (server.toolTimeoutSec !== undefined) {
      entry.tool_timeout_sec = server.toolTimeoutSec;
    }

    mcpServers[server.id] = entry;
  }

  return { mcpServers, droppedFields: [] };
}

/**
 * Translate the portable MCP config into the shape Claude's SDK expects.
 *
 * All backend-specific decisions (server-disable mechanism, whether per-tool
 * allow/deny lists are natively emitted vs enforced by the permission-layer
 * fallback) are routed through the injected capability metadata.
 */
export function translatePortableMcpToClaude(
  config: PortableMcpConfig,
  options: TranslationOptions = {},
): PortableMcpToClaudeResult {
  const capabilities = options.capabilities ?? claudeMcpCapabilities;
  const servers: Record<string, McpServerConfig> = {};
  const rejectedServers: string[] = [];
  const rejectedFields: string[] = [];
  const errorsByServer: Record<string, string> = {};

  for (const server of config.servers) {
    if (server.enabled === false && capabilities.serverDisable === "omit") {
      continue;
    }

    const unsupportedFields: string[] = [];

    if (server.transport === "stdio") {
      if (hasValue(server.cwd)) unsupportedFields.push(`${server.id}.cwd`);
    } else if (hasValue(server.bearerTokenEnvVar)) {
      unsupportedFields.push(`${server.id}.bearerTokenEnvVar`);
    }

    const filteringForTransport =
      capabilities.toolFiltering.byTransport[server.transport];
    if (filteringForTransport === "unsupported") {
      if (hasValue(server.enabledTools)) {
        unsupportedFields.push(`${server.id}.enabledTools`);
      }
      if (hasValue(server.disabledTools)) {
        unsupportedFields.push(`${server.id}.disabledTools`);
      }
    }

    if (hasValue(server.startupTimeoutSec)) {
      unsupportedFields.push(`${server.id}.startupTimeoutSec`);
    }
    if (hasValue(server.toolTimeoutSec)) {
      unsupportedFields.push(`${server.id}.toolTimeoutSec`);
    }

    if (unsupportedFields.length > 0) {
      rejectedServers.push(server.id);
      rejectedFields.push(...unsupportedFields);
      errorsByServer[server.id] =
        `Unsupported portable MCP fields for Claude: ${unsupportedFields.join(", ")}`;
      continue;
    }

    if (server.transport === "stdio") {
      servers[server.id] = {
        type: "stdio",
        command: server.command,
        ...(server.args !== undefined ? { args: server.args } : {}),
        ...(server.env !== undefined ? { env: server.env } : {}),
      };
      continue;
    }

    if (server.transport === "streamable-http") {
      const tools = buildNativeToolPolicies(server, filteringForTransport);
      servers[server.id] = {
        type: "http",
        url: server.url,
        ...(server.headers !== undefined ? { headers: server.headers } : {}),
        ...(tools ? { tools } : {}),
      };
      continue;
    }

    const unknownServer = server as unknown as {
      id: string;
      transport: unknown;
    };
    rejectedServers.push(unknownServer.id);
    errorsByServer[unknownServer.id] =
      `Unsupported MCP transport for Claude: ${String(unknownServer.transport)}`;
  }

  return {
    servers,
    rejectedServers,
    rejectedFields,
    errorsByServer,
  };
}
