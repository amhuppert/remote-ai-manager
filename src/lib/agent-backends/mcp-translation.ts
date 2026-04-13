import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { PortableMcpConfig } from "./portable-mcp";

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

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null;
}

export function translatePortableMcpToCodex(
  config: PortableMcpConfig,
): PortableMcpToCodexResult {
  const mcpServers: Record<string, unknown> = {};

  for (const server of config.servers) {
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

    if (server.enabled !== undefined) entry.enabled = server.enabled;
    if (server.enabledTools !== undefined) {
      entry.enabled_tools = server.enabledTools;
    }
    if (server.disabledTools !== undefined) {
      entry.disabled_tools = server.disabledTools;
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

export function translatePortableMcpToClaude(
  config: PortableMcpConfig,
): PortableMcpToClaudeResult {
  const servers: Record<string, McpServerConfig> = {};
  const rejectedServers: string[] = [];
  const rejectedFields: string[] = [];
  const errorsByServer: Record<string, string> = {};

  for (const server of config.servers) {
    if (server.enabled === false) {
      continue;
    }

    const unsupportedFields: string[] = [];

    if (server.transport === "stdio") {
      if (hasValue(server.cwd)) unsupportedFields.push(`${server.id}.cwd`);
    } else if (hasValue(server.bearerTokenEnvVar)) {
      unsupportedFields.push(`${server.id}.bearerTokenEnvVar`);
    }

    if (hasValue(server.enabledTools)) {
      unsupportedFields.push(`${server.id}.enabledTools`);
    }
    if (hasValue(server.disabledTools)) {
      unsupportedFields.push(`${server.id}.disabledTools`);
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
      servers[server.id] = {
        type: "http",
        url: server.url,
        ...(server.headers !== undefined ? { headers: server.headers } : {}),
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
