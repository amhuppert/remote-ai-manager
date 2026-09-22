/**
 * Capability views for the supported agent backends.
 *
 * Adapters that compose the AgentCall primitive need a `BackendCapabilityView`
 * to attach to every dispatch resolution. The capability view encodes the real
 * differences between backends (continuation strength, structured-output
 * enforcement source, MCP application boundary, etc.) that workflows branch on
 * — see `agent-call-vocabulary.ts` for the field-level contract.
 *
 * The view is derived from the backend's registered descriptor, so the
 * conversation actor, validator runner, implementer runner, and other adapters
 * all read the same declaration the backend registered — there is no second
 * hand-maintained copy to drift.
 */

import type { AgentBackendId } from "@/lib/shared/schemas";
import type { AgentBackendDescriptor } from "@/lib/agent-backends/descriptor";
import { getBackendDescriptor } from "@/lib/agent-backends/registry";
import type { McpBackendCapabilities } from "@/lib/agent-backends/mcp-capabilities";
import type { BackendCapabilityView } from "./agent-call-vocabulary";

function mcpApplicationBoundaryFor(
  mcp: McpBackendCapabilities,
): BackendCapabilityView["mcpApplicationBoundary"] {
  switch (mcp.betweenTurnApply) {
    case "live-when-idle":
      return "between_turns";
    case "next-turn":
      return "per_request";
    case "unsupported":
      return "unsupported";
  }
}

export function capabilityViewFromDescriptor(
  descriptor: AgentBackendDescriptor,
): BackendCapabilityView {
  const conversation = descriptor.conversation;
  if (!conversation) {
    throw new Error(
      `Backend "${descriptor.id}" declares no conversation facet; no capability view can be derived`,
    );
  }
  const capabilities = conversation.capabilities;
  return {
    backend: descriptor.id,
    continuationStrength: capabilities.continuationStrength,
    structuredOutputEnforcement: capabilities.structuredOutput,
    mcpApplicationBoundary: mcpApplicationBoundaryFor(descriptor.mcp),
    contextMetricsAvailable: capabilities.contextWindowMetrics,
    nativeMidTurnAskUser: capabilities.nativeMidTurnAskUser,
  };
}

/** Throws for a backend without a registered descriptor — never falls back. */
export function capabilityViewForBackend(
  backend: AgentBackendId,
): BackendCapabilityView {
  return capabilityViewFromDescriptor(getBackendDescriptor(backend));
}
