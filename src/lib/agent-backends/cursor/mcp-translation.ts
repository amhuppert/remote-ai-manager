import type {
  PortableMcpConfig,
  PortableMcpServerConfig,
} from "../portable-mcp";
import type { CursorWorkerMcpServer } from "./worker/entry";

/**
 * Portable MCP input to the SDK's inline stdio server map (spec D18).
 *
 * The map this returns is the ENTIRE MCP surface a Cursor turn sees: the worker
 * attaches under `settingSources: []`, so no ambient user, project, team, or
 * MDM server joins it, and nothing here reads or writes Cursor's own
 * configuration files. What the cascade emits is what the SDK gets.
 *
 * The Phase 1 inline path is narrower than the portable shape, and the gap is
 * closed by refusing rather than by degrading: a server carrying a field this
 * path cannot express is left out of the map with a bounded error naming the
 * field. A tool filter is the case that matters — the SDK's inline entry has no
 * per-tool allow/deny list and Phase 1 registers no permission handler to
 * enforce one at call time, so passing such a server anyway would hand the
 * model exactly the tool the cascade denied. Dropping the server is the only
 * reading of the cascade the mechanism can honor (the Claude translator refuses
 * unsupported fields the same way).
 */

export interface PortableMcpToCursorResult {
  /** The SDK inline stdio map, keyed by portable server id. */
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

type PortableStdioServer = Extract<
  PortableMcpServerConfig,
  { transport: "stdio" }
>;

/** A filter with no members expresses no restriction, so it is not one. */
function isRestricting(tools: readonly string[] | undefined): boolean {
  return tools !== undefined && tools.length > 0;
}

/**
 * Fields the SDK's inline stdio entry has no representation for, named per
 * server. Empty when the entry translates faithfully.
 */
function unsupportedFields(server: PortableStdioServer): string[] {
  const fields: string[] = [];
  if (isRestricting(server.enabledTools)) fields.push("enabledTools");
  if (isRestricting(server.disabledTools)) fields.push("disabledTools");
  if (server.startupTimeoutSec !== undefined) fields.push("startupTimeoutSec");
  if (server.toolTimeoutSec !== undefined) fields.push("toolTimeoutSec");
  return fields;
}

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
): PortableMcpToCursorResult {
  const servers: Record<string, CursorWorkerMcpServer> = {};
  const rejectedServers: string[] = [];
  const rejectedFields: string[] = [];
  const errorsByServer: Record<string, string> = {};

  function reject(id: string, message: string, fields: string[] = []): void {
    rejectedServers.push(id);
    rejectedFields.push(...fields.map((field) => `${id}.${field}`));
    errorsByServer[id] = message;
  }

  for (const server of config.servers) {
    // The cascade's own decision, and the only mechanism the SDK offers for it:
    // a disabled server is absent, not present-and-flagged. Absence here is the
    // intended outcome, so it is not reported as a rejection.
    if (server.enabled === false) continue;

    if (server.transport !== "stdio") {
      reject(
        server.id,
        `Unsupported MCP transport for Cursor: ${server.transport}`,
      );
      continue;
    }

    const unsupported = unsupportedFields(server);
    if (unsupported.length > 0) {
      reject(
        server.id,
        `Unsupported portable MCP fields for Cursor: ${unsupported.join(", ")}`,
        unsupported,
      );
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

    // The SDK map is keyed by id, so a second entry under a live key would
    // silently replace the first. Keeping the first and refusing the collision
    // makes the emitted map a function of the cascade rather than of iteration
    // order.
    if (Object.hasOwn(servers, server.id)) {
      reject(
        server.id,
        `Ignored a duplicate MCP server id for Cursor: ${server.id}`,
      );
      continue;
    }

    servers[server.id] = {
      command: server.command,
      // Stated rather than omitted: the worker's wire contract requires both,
      // and an explicit empty map is the claim that this child inherits no
      // environment Command Center did not choose for it.
      args: server.args !== undefined ? [...server.args] : [],
      env: { ...env },
      ...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
    };
  }

  return { servers, rejectedServers, rejectedFields, errorsByServer };
}
