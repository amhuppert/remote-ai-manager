import { createHash } from "node:crypto";
import type {
  PortableMcpConfig,
  PortableMcpServerConfig,
} from "@/lib/agent-backends/portable-mcp";

/**
 * Compute a stable SHA-256 digest over the full emitted portable MCP config
 * (user-resolved servers + protected gateway servers). The hash is order-
 * insensitive w.r.t. server list and tool filter list order — semantically
 * equivalent configs must collide so that a no-op reorder doesn't invalidate
 * `lastAppliedConfigHash`. Used for change detection only; never exposed in
 * the UI.
 */
export function computeEffectiveConfigHash(
  portable: PortableMcpConfig,
): string {
  const canonical = canonicalizePortable(portable);
  const json = JSON.stringify(canonical);
  return createHash("sha256").update(json).digest("hex");
}

interface CanonicalPortableServer {
  id: string;
  transport: string;
  fields: Array<[string, unknown]>;
}

function canonicalizePortable(portable: PortableMcpConfig): {
  servers: readonly CanonicalPortableServer[];
} {
  const servers = portable.servers.map((s) => canonicalizeServer(s));
  servers.sort((a, b) => a.id.localeCompare(b.id));
  return { servers };
}

function canonicalizeServer(
  server: PortableMcpServerConfig,
): CanonicalPortableServer {
  const fields: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(server).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (key === "id" || key === "transport") continue;
    fields.push([key, normalizeField(key, value)]);
  }
  return { id: server.id, transport: server.transport, fields };
}

function normalizeField(key: string, value: unknown): unknown {
  if (key === "enabledTools" || key === "disabledTools") {
    if (Array.isArray(value)) {
      return [...value].sort();
    }
  }
  if (
    (key === "env" || key === "headers") &&
    value &&
    typeof value === "object"
  ) {
    const entries = Object.entries(value);
    entries.sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries);
  }
  return value;
}
