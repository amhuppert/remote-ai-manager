/**
 * Portable MCP filter lookup.
 *
 * Adapts the resolver's final `PortableMcpConfig` (the translated, cascade
 * resolved output emitted to a backend) into the `McpFilterLookup` contract
 * consumed by Claude's `canUseTool` permission callback. The lookup is live —
 * it reads from a caller-supplied getter on every call, so a runtime whose
 * current portable config changes reflects the change in subsequent permission
 * checks without recreating the callback.
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
 * we do not falsely deny unrelated tools.
 */

import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";
import type { McpFilterLookup } from "@/lib/agent-backends/claude/native-tooling";

export function createPortableMcpFilterLookup(
  getConfig: () => PortableMcpConfig | null,
): McpFilterLookup {
  return {
    isToolAllowed({ serverKey, toolName }) {
      const config = getConfig();
      if (!config) return { allowed: true };

      const server = config.servers.find((s) => s.id === serverKey);
      if (!server) return { allowed: true };

      if (server.enabled === false) {
        return { allowed: false, reason: "server-disabled" };
      }

      if (server.disabledTools && server.disabledTools.includes(toolName)) {
        return { allowed: false, reason: "tool-disabled" };
      }

      if (
        server.enabledTools &&
        server.enabledTools.length > 0 &&
        !server.enabledTools.includes(toolName)
      ) {
        return { allowed: false, reason: "tool-not-in-allowlist" };
      }

      return { allowed: true };
    },
  };
}
