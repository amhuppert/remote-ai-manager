/**
 * Runtime-status tool-inventory source.
 *
 * When a conversation runtime is live for the requested scope and its backend
 * capability declares `toolDiscovery.preferred === "runtime-status"`, we prefer
 * its reported MCP server status as the source of truth for that conversation's
 * tool list — the SDK already keeps its own MCP connections open and dispatches
 * tool calls against them, so its inventory is authoritative. When no runtime
 * is registered, the runtime is dead, or the backend's capability prefers a
 * direct probe, callers fall through to the probe path.
 *
 * The decision is driven by the capability registry — no branch on backend id.
 */
import type { ConversationBackendRuntime } from "@/lib/agent-backends/conversation";
import {
  defaultMcpCapabilityRegistry,
  type McpCapabilityRegistry,
} from "@/lib/mcp/backend-capabilities";
import { createLogger } from "@/lib/logging";
import type { McpDiscoveredTool } from "@/lib/schemas";

const logger = createLogger("mcp.tool-discovery");

export interface ClaudeRuntimeToolSourceDeps {
  getRuntime(conversationId: string): ConversationBackendRuntime | undefined;
  /**
   * Capability registry consulted to decide whether the backing runtime is a
   * valid authoritative tool-inventory source. Defaults to the shipped registry
   * so nothing else has to wire it through.
   */
  capabilityRegistry?: McpCapabilityRegistry;
}

export interface RuntimeToolLookupInput {
  conversationId: string;
  serverKey: string;
}

export interface ClaudeRuntimeToolSource {
  /**
   * Return tools reported by the live runtime for the given server, or
   * `undefined` when no authoritative answer is available (runtime not
   * registered, dead, capability says the backend uses a direct probe instead,
   * or the runtime lacks `listMcpServerTools`).
   */
  listToolsFromActiveRuntime(
    input: RuntimeToolLookupInput,
  ): Promise<readonly McpDiscoveredTool[] | undefined>;
}

export function createClaudeRuntimeToolSource(
  deps: ClaudeRuntimeToolSourceDeps,
): ClaudeRuntimeToolSource {
  const registry = deps.capabilityRegistry ?? defaultMcpCapabilityRegistry;

  return {
    async listToolsFromActiveRuntime(input) {
      const runtime = deps.getRuntime(input.conversationId);
      if (!runtime) return undefined;

      const capabilities = registry.getCapabilities(runtime.backend);
      if (capabilities.toolDiscovery.preferred !== "runtime-status") {
        return undefined;
      }

      if (runtime.status !== "alive") return undefined;
      if (typeof runtime.listMcpServerTools !== "function") return undefined;

      try {
        const tools = await runtime.listMcpServerTools(input.serverKey);
        return tools ?? undefined;
      } catch (err) {
        logger.warn("runtime.list_tools_failed", {
          conversationId: input.conversationId,
          serverKey: input.serverKey,
        });
        return undefined;
      }
    },
  };
}
