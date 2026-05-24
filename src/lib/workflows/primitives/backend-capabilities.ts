/**
 * Capability views for the supported agent backends.
 *
 * Adapters that compose the AgentCall primitive need a `BackendCapabilityView`
 * to attach to every dispatch resolution. The capability view encodes the real
 * differences between backends (continuation strength, structured-output
 * enforcement source, MCP application boundary, etc.) that workflows branch on
 * — see `agent-call-vocabulary.ts` for the field-level contract.
 *
 * Centralizing the per-backend constants in this module avoids drift between
 * the conversation actor, validator runner, implementer runner, and other
 * adapters that all need to populate the same fields with the same values.
 */

import type { AgentBackendId } from "@/lib/shared/schemas";
import type { BackendCapabilityView } from "./agent-call-vocabulary";

export const CLAUDE_CAPABILITY_VIEW: BackendCapabilityView = {
  backend: "claude",
  continuationStrength: "precise_session",
  structuredOutputEnforcement: "backend_native",
  mcpApplicationBoundary: "between_turns",
  contextMetricsAvailable: true,
  nativeMidTurnAskUser: true,
};

export const CODEX_CAPABILITY_VIEW: BackendCapabilityView = {
  backend: "codex",
  continuationStrength: "synthetic_thread",
  structuredOutputEnforcement: "backend_native",
  mcpApplicationBoundary: "per_request",
  contextMetricsAvailable: false,
  nativeMidTurnAskUser: false,
};

export function capabilityViewForBackend(
  backend: AgentBackendId,
): BackendCapabilityView {
  return backend === "codex" ? CODEX_CAPABILITY_VIEW : CLAUDE_CAPABILITY_VIEW;
}
