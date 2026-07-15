/**
 * Adapts the resolver's final `PortableMcpConfig` (the translated, cascade
 * resolved output emitted to a backend) into the `McpFilterLookup` contract
 * consumed by Claude's `canUseTool` permission callback. The lookup is live —
 * it reads from a caller-supplied getter on every call, so a runtime whose
 * current portable config changes reflects the change in subsequent permission
 * checks without recreating the callback. Decision semantics live in the
 * neutral `evaluatePortableMcpToolFilter` operation on the backend seam.
 */

import {
  evaluatePortableMcpToolFilter,
  type PortableMcpConfig,
} from "../portable-mcp";
import type { McpFilterLookup } from "./native-tooling";

export function createPortableMcpFilterLookup(
  getConfig: () => PortableMcpConfig | null,
): McpFilterLookup {
  return {
    isToolAllowed({ serverKey, toolName }) {
      return evaluatePortableMcpToolFilter(getConfig(), {
        serverKey,
        toolName,
      });
    },
  };
}
