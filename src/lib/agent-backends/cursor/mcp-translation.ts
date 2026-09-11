import { resolveMcpHeaders } from "@/lib/mcp/remote-headers";
import type { PortableMcpConfig } from "../portable-mcp";
import type { CursorWorkerMcpServer } from "./worker/entry";

import { cursorWorkerMcpServerSchema } from "./worker/ipc";

/** The worker bridge owns transport, filtering, and deadline enforcement. */
export interface PortableMcpToCursorResult {
  /** The bridge input map, keyed by portable server id. */
  servers: Record<string, CursorWorkerMcpServer>;
  /** Ids left out because the inline path cannot express them faithfully. */
  rejectedServers: string[];
  /** `<id>.<field>` for every field that caused a rejection. */
  rejectedFields: string[];
  /** One bounded, value-free explanation per rejected id. */
  errorsByServer: Record<string, string>;
}

/**
 * Bounds on the environment a server may carry into the SDK's spawn.
 *
 * Explicit values only ever reach an MCP child because the cascade put them
 * there, and these bounds keep a pathological entry — a whole file pasted into
 * a variable, a generated map of hundreds — from becoming an unbounded spawn
 * argument. Exceeding a bound refuses the server rather than truncating it: a
 * silently shortened credential or path produces a server that starts and then
 * misbehaves, which is worse than one that never starts.
 */
export const CURSOR_MCP_MAX_ENV_ENTRIES = 64;
export const CURSOR_MCP_MAX_ENV_VALUE_LENGTH = 4096;

/**
 * The first environment entry that breaches a bound, described without its
 * value. Names are safe to report — they are what the operator has to fix —
 * but a value can be credential material and never crosses into an error.
 */
function envBoundBreach(env: Record<string, string>): string | null {
  const entries = Object.entries(env);
  if (entries.length > CURSOR_MCP_MAX_ENV_ENTRIES) {
    return `${entries.length} environment entries exceeds the bound of ${CURSOR_MCP_MAX_ENV_ENTRIES}`;
  }
  for (const [name, value] of entries) {
    if (value.length > CURSOR_MCP_MAX_ENV_VALUE_LENGTH) {
      return `environment value ${name} is ${value.length} characters, over the bound of ${CURSOR_MCP_MAX_ENV_VALUE_LENGTH}`;
    }
  }
  return null;
}

export function translatePortableMcpToCursor(
  config: PortableMcpConfig,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): PortableMcpToCursorResult {
  const servers: Record<string, CursorWorkerMcpServer> = {};
  const rejectedServers: string[] = [];
  const rejectedFields: string[] = [];
  const errorsByServer: Record<string, string> = {};

  function reject(id: string, message: string, fields: string[] = []): void {
    rejectedServers.push(id);
    rejectedFields.push(...fields.map((field) => `${id}.${field}`));
    Object.defineProperty(errorsByServer, id, {
      value: message,
      enumerable: true,
      configurable: true,
    });
  }

  const counts = new Map<string, number>();
  for (const server of config.servers)
    counts.set(server.id, (counts.get(server.id) ?? 0) + 1);
  for (const server of config.servers) {
    if ((counts.get(server.id) ?? 0) > 1) {
      if (!rejectedServers.includes(server.id))
        reject(server.id, `Duplicate MCP server id for Cursor: ${server.id}`);
      continue;
    }
    if (server.enabled === false) continue;

    const controls = {
      ...(server.enabledTools !== undefined
        ? { enabledTools: [...server.enabledTools] }
        : {}),
      ...(server.disabledTools !== undefined
        ? { disabledTools: [...server.disabledTools] }
        : {}),
      ...(server.startupTimeoutSec !== undefined
        ? { startupTimeoutSec: server.startupTimeoutSec }
        : {}),
      ...(server.toolTimeoutSec !== undefined
        ? { toolTimeoutSec: server.toolTimeoutSec }
        : {}),
    };
    if (server.transport !== "stdio") {
      const resolved = resolveMcpHeaders(
        server.headers,
        server.bearerTokenEnvVar,
        environment,
      );
      if (resolved.missingBearer !== undefined) {
        reject(
          server.id,
          "Missing MCP bearer environment variable: " + resolved.missingBearer,
          ["bearerTokenEnvVar"],
        );
        continue;
      }
      const headers = resolved.headers;
      const breach = envBoundBreach(headers);
      if (breach) {
        reject(server.id, "MCP headers exceed supported bounds", ["headers"]);
        continue;
      }
      const candidate = {
        type: server.transport === "sse" ? "sse" : "http",
        url: server.url,
        ...controls,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      };
      const parsed = cursorWorkerMcpServerSchema.safeParse(candidate);
      if (!parsed.success) {
        reject(
          server.id,
          "Invalid MCP transport or control fields",
          parsed.error.issues.map((issue) => String(issue.path[0] ?? "config")),
        );
        continue;
      }
      Object.defineProperty(servers, server.id, {
        value: parsed.data,
        enumerable: true,
      });
      continue;
    }

    const env = server.env ?? {};
    const breach = envBoundBreach(env);
    if (breach !== null) {
      reject(server.id, `Unbounded MCP environment for Cursor: ${breach}`, [
        "env",
      ]);
      continue;
    }

    const candidate = {
      command: server.command,
      args: server.args !== undefined ? [...server.args] : [],
      env: { ...env },
      ...controls,
      ...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
    };
    const parsed = cursorWorkerMcpServerSchema.safeParse(candidate);
    if (!parsed.success) {
      reject(
        server.id,
        "Invalid MCP transport or control fields",
        parsed.error.issues.map((issue) => String(issue.path[0] ?? "config")),
      );
      continue;
    }
    Object.defineProperty(servers, server.id, {
      value: parsed.data,
      enumerable: true,
    });
  }

  return { servers, rejectedServers, rejectedFields, errorsByServer };
}
