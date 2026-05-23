/**
 * Claude-specific tool permission policy for the Anthropic SDK.
 *
 * Currently a thin wrapper that applies the MCP-filter denial decision so
 * server-/tool-level overrides flow through the SDK's permission hook.
 */

import { createLogger } from "@/lib/logging";

const denialLogger = createLogger("mcp.tool-denial");

// ============================================================
// Types
// ============================================================

type CanUseToolResult =
  | { behavior: "deny"; message: string; interrupt?: boolean }
  | { behavior: "allow"; updatedInput: Record<string, unknown> };

export type CanUseToolFn = (
  toolName: string,
  toolInput: Record<string, unknown>,
) => Promise<CanUseToolResult>;

/**
 * Resolver-backed lookup consulted by the Claude canUseTool fallback filter.
 * Tests supply deterministic implementations so the permission policy can be
 * exercised without booting the resolver.
 */
export interface McpFilterLookup {
  isToolAllowed(input: {
    conversationId: string;
    serverKey: string;
    toolName: string;
  }):
    | { allowed: true }
    | {
        allowed: false;
        reason: "server-disabled" | "tool-disabled" | "tool-not-in-allowlist";
      };
}

export interface McpFilterDeps {
  conversationId: string;
  mcpFilter: McpFilterLookup;
}

// ============================================================
// Factory
// ============================================================

const MCP_TOOL_DENIAL_MESSAGE = "Tool disabled by MCP configuration";

/** SDK-emitted MCP tool names follow `mcp__<serverKey>__<toolName>`. */
function parseMcpToolName(
  toolName: string,
): { serverKey: string; toolName: string } | null {
  if (!toolName.startsWith("mcp__")) return null;
  const rest = toolName.slice("mcp__".length);
  const separatorIdx = rest.indexOf("__");
  if (separatorIdx <= 0 || separatorIdx === rest.length - 2) return null;
  return {
    serverKey: rest.slice(0, separatorIdx),
    toolName: rest.slice(separatorIdx + 2),
  };
}

/**
 * Create a canUseTool callback for the Anthropic SDK QuerySession.
 *
 * Policy:
 * - MCP filter (when supplied): denies via sanitized deny response
 *   without interrupting the turn.
 * - All other tools: allowed (CC runs with bypassPermissions).
 */
export function createCanUseTool(mcpFilterDeps?: McpFilterDeps): CanUseToolFn {
  return async (
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<CanUseToolResult> => {
    if (mcpFilterDeps) {
      const parsed = parseMcpToolName(toolName);
      if (parsed) {
        const decision = mcpFilterDeps.mcpFilter.isToolAllowed({
          conversationId: mcpFilterDeps.conversationId,
          serverKey: parsed.serverKey,
          toolName: parsed.toolName,
        });
        if (!decision.allowed) {
          denialLogger.info("mcp.tool-denial", {
            conversationId: mcpFilterDeps.conversationId,
            serverKey: parsed.serverKey,
            toolName: parsed.toolName,
            reason: decision.reason,
          });
          return {
            behavior: "deny",
            message: MCP_TOOL_DENIAL_MESSAGE,
            interrupt: false,
          };
        }
      }
    }

    return { behavior: "allow", updatedInput: toolInput };
  };
}
