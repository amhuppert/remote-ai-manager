import type {
  McpOverrideOperation,
  McpOverrides,
  McpServerOverride,
} from "@/lib/mcp/schemas";
export interface OverridesPatchResult {
  overrides: McpOverrides;
  changedServerKeys: readonly string[];
}

/**
 * Apply a sequence of override operations to an immutable `McpOverrides`
 * snapshot, returning the next snapshot and the list of server keys whose
 * override record changed (unique, in insertion order).
 *
 * Pure function — does not mutate the input. Empty server records are pruned
 * so the persisted file stays small after resets.
 */
export function applyOperations(
  current: McpOverrides,
  operations: readonly McpOverrideOperation[],
): OverridesPatchResult {
  const next: McpOverrides = {
    servers: cloneServers(current.servers),
  };
  const changed = new Set<string>();

  for (const op of operations) {
    if (applyOne(next, op)) {
      changed.add(op.serverKey);
    }
  }

  return {
    overrides: next,
    changedServerKeys: Array.from(changed),
  };
}

function applyOne(next: McpOverrides, op: McpOverrideOperation): boolean {
  const { serverKey } = op;
  const before = next.servers[serverKey];

  if (op.type === "reset-server") {
    if (before === undefined) return false;
    delete next.servers[serverKey];
    return true;
  }

  if (op.type === "reset-tool") {
    if (!before?.tools || before.tools[op.toolName] === undefined) {
      return false;
    }
    const tools = { ...before.tools };
    delete tools[op.toolName];
    const nextServer: McpServerOverride = {
      ...(before.enabled !== undefined ? { enabled: before.enabled } : {}),
      ...(Object.keys(tools).length > 0 ? { tools } : {}),
    };
    if (isEmptyServerOverride(nextServer)) {
      delete next.servers[serverKey];
    } else {
      next.servers[serverKey] = nextServer;
    }
    return true;
  }

  if (op.type === "set-server-enabled") {
    const nextServer: McpServerOverride = {
      ...(before ?? {}),
      enabled: op.enabled,
    };
    if (
      before !== undefined &&
      before.enabled === op.enabled &&
      shallowEqualTools(before.tools, nextServer.tools)
    ) {
      return false;
    }
    next.servers[serverKey] = nextServer;
    return true;
  }

  // set-tool-enabled
  const prevTools = before?.tools ?? {};
  const prevTool = prevTools[op.toolName];
  if (prevTool?.enabled === op.enabled) {
    return false;
  }
  const tools = { ...prevTools, [op.toolName]: { enabled: op.enabled } };
  const nextServer: McpServerOverride = {
    ...(before?.enabled !== undefined ? { enabled: before.enabled } : {}),
    tools,
  };
  next.servers[serverKey] = nextServer;
  return true;
}

function cloneServers(
  servers: McpOverrides["servers"],
): McpOverrides["servers"] {
  const out: McpOverrides["servers"] = {};
  for (const [key, value] of Object.entries(servers)) {
    out[key] = {
      ...(value.enabled !== undefined ? { enabled: value.enabled } : {}),
      ...(value.tools !== undefined ? { tools: cloneTools(value.tools) } : {}),
    };
  }
  return out;
}

function cloneTools(
  tools: NonNullable<McpServerOverride["tools"]>,
): NonNullable<McpServerOverride["tools"]> {
  const out: NonNullable<McpServerOverride["tools"]> = {};
  for (const [name, tool] of Object.entries(tools)) {
    out[name] = { ...tool };
  }
  return out;
}

function isEmptyServerOverride(server: McpServerOverride): boolean {
  return server.enabled === undefined && server.tools === undefined;
}

function shallowEqualTools(
  a: McpServerOverride["tools"],
  b: McpServerOverride["tools"],
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a[key]?.enabled !== b[key]?.enabled) return false;
  }
  return true;
}
