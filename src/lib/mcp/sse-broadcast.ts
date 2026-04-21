/**
 * Route-handler → SSE event adapter for MCP config/tool updates.
 *
 * The MCP API route handlers emit scope-agnostic payloads
 * (`McpConfigRouteBroadcastPayload`). This module is the single translation
 * point that converts those payloads into the public SSE event union. Keeping
 * it separate from the route-handler module preserves Task 12's contract
 * (no SSE dependency there) while Task 13 adds the concrete event types.
 *
 * Privacy rule (Requirement 11.2): only identifiers, changed server keys, and
 * hashes leave this boundary — never server/tool configuration contents.
 */

import { createLogger } from "@/lib/logging";
import type {
  McpConfigRouteBroadcast,
  McpConfigRouteBroadcastPayload,
} from "@/lib/mcp-config-route-handlers";
import { broadcast as defaultBroadcast } from "@/lib/sse-broadcaster";
import type {
  McpConfigUpdatedEvent,
  McpToolsUpdatedEvent,
  SSEEvent,
} from "@/types";

const log = createLogger("mcp.sse");

type EmitFn = (event: SSEEvent) => void;

/**
 * Build the `McpConfigRouteBroadcast` function that the route handler factory
 * consumes. `emit` is injectable so tests can observe the dispatched events
 * without touching the shared SSE client set.
 */
export function createMcpRouteBroadcast(
  emit: EmitFn = defaultBroadcast,
): McpConfigRouteBroadcast {
  return (payload) => {
    const event = toSseEvent(payload);
    log.debug("mcp.sse.emit", {
      type: event.type,
      level: event.level,
      serverKeyCount:
        event.type === "mcp-config-updated"
          ? event.changedServerKeys.length
          : 1,
    });
    emit(event);
  };
}

function toSseEvent(
  payload: McpConfigRouteBroadcastPayload,
): McpConfigUpdatedEvent | McpToolsUpdatedEvent {
  if (payload.kind === "config-updated") {
    return {
      type: "mcp-config-updated",
      level: payload.level,
      ...onlyDefinedScope(payload),
      changedServerKeys: [...payload.changedServerKeys],
      effectiveConfigHash: payload.effectiveConfigHash,
    };
  }
  return {
    type: "mcp-tools-updated",
    level: payload.level,
    ...onlyDefinedScope(payload),
    serverKey: payload.serverKey,
    configSignature: payload.configSignature,
  };
}

function onlyDefinedScope(payload: McpConfigRouteBroadcastPayload): {
  projectName?: string;
  sessionName?: string;
  conversationId?: string;
} {
  const out: {
    projectName?: string;
    sessionName?: string;
    conversationId?: string;
  } = {};
  if (payload.projectName !== undefined) out.projectName = payload.projectName;
  if (payload.sessionName !== undefined) out.sessionName = payload.sessionName;
  if (payload.conversationId !== undefined) {
    out.conversationId = payload.conversationId;
  }
  return out;
}
