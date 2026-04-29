/**
 * Debug adapter — single seam around debug-mode operations.
 *
 * The conversation state machine still owns debug phase transitions, but
 * everything debug-specific that lives outside the machine — schema selection
 * for structured output, status emission onto the SSE wire, and lifecycle
 * dispatch from API routes — flows through this adapter. That gives the
 * debug subsystem one place to extend, audit, or stub in tests without
 * threading a new dependency through every caller.
 *
 * `sendConversationEvent` is resolved lazily via `require()` to mirror the
 * dynamic-import deferral used by `default-session-status-bus.ts` and avoid a
 * circular import with `manager.ts`, which itself depends on the conversation
 * machine. Tests can inject a fake sender directly through `createDebugAdapter`.
 */
import type { ConversationEvent } from "./types";
import type { DebugModePhase } from "@/lib/schemas";
import {
  debugCleanupResultSchema,
  debugEvidenceAnalysisSchema,
  debugFixResultSchema,
  debugHypothesisOutputSchema,
} from "./debug-schemas";
import type { SSEEvent } from "@/types";
import type { StatusBusDeliveryOutcome } from "@/lib/workflows/primitives/status-bus";
import { publishSessionStatus } from "@/lib/workflows/primitives/default-session-status-bus";

export interface DebugOutputFormat {
  type: "json_schema";
  schema: Record<string, unknown>;
}

export interface DebugTarget {
  projectPath: string;
  sessionName: string;
  conversationId: string;
}

export interface DebugStatusInput {
  projectName: string;
  sessionName: string;
  conversationId: string;
  active: boolean;
  recording: boolean;
}

export interface DebugLogReceivedInput {
  projectName: string;
  sessionName: string;
  conversationId: string;
  entryCount: number;
}

export type SendConversationEventFn = (
  projectPath: string,
  sessionName: string,
  conversationId: string,
  event: ConversationEvent,
) => boolean;

export type PublishSSEFn = (event: SSEEvent) => StatusBusDeliveryOutcome;

export interface DebugAdapterDeps {
  sendConversationEvent?: SendConversationEventFn;
  publishSSE?: PublishSSEFn;
}

export interface DebugAdapter {
  resolveOutputFormat(
    phase: DebugModePhase | null | undefined,
  ): DebugOutputFormat | undefined;
  publishDebugModeStatus(input: DebugStatusInput): StatusBusDeliveryOutcome;
  publishDebugLogReceived(
    input: DebugLogReceivedInput,
  ): StatusBusDeliveryOutcome;
  enterDebugMode(target: DebugTarget, args: { logFilePath: string }): boolean;
  exitDebugMode(target: DebugTarget): boolean;
  markReproduced(target: DebugTarget): boolean;
  markFixVerified(target: DebugTarget): boolean;
  setRecording(target: DebugTarget, recording: boolean): boolean;
  clearDebugLogs(target: DebugTarget): boolean;
}

function resolveSchema(
  phase: DebugModePhase | null | undefined,
): Record<string, unknown> | undefined {
  switch (phase) {
    case "hypothesizing":
      return debugHypothesisOutputSchema as unknown as Record<string, unknown>;
    case "analyzing_evidence":
      return debugEvidenceAnalysisSchema as unknown as Record<string, unknown>;
    case "fixing":
      return debugFixResultSchema as unknown as Record<string, unknown>;
    case "cleanup_instrumentation":
      return debugCleanupResultSchema as unknown as Record<string, unknown>;
    default:
      return undefined;
  }
}

function defaultSendConversationEvent(
  projectPath: string,
  sessionName: string,
  conversationId: string,
  event: ConversationEvent,
): boolean {
  const mod: { sendConversationEvent: SendConversationEventFn } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("./manager");
  return mod.sendConversationEvent(
    projectPath,
    sessionName,
    conversationId,
    event,
  );
}

function defaultPublishSSE(event: SSEEvent): StatusBusDeliveryOutcome {
  return publishSessionStatus(event);
}

export function createDebugAdapter(deps: DebugAdapterDeps = {}): DebugAdapter {
  const sendEvent = deps.sendConversationEvent ?? defaultSendConversationEvent;
  const publishSSE = deps.publishSSE ?? defaultPublishSSE;

  return {
    resolveOutputFormat(phase) {
      const schema = resolveSchema(phase);
      if (!schema) return undefined;
      return { type: "json_schema", schema };
    },

    publishDebugModeStatus(input) {
      return publishSSE({
        type: "debug-mode-status",
        projectName: input.projectName,
        sessionName: input.sessionName,
        conversationId: input.conversationId,
        active: input.active,
        recording: input.recording,
      });
    },

    publishDebugLogReceived(input) {
      return publishSSE({
        type: "debug-log-received",
        projectName: input.projectName,
        sessionName: input.sessionName,
        conversationId: input.conversationId,
        entryCount: input.entryCount,
      });
    },

    enterDebugMode(target, { logFilePath }) {
      return sendEvent(
        target.projectPath,
        target.sessionName,
        target.conversationId,
        { type: "ENTER_DEBUG_MODE", logFilePath },
      );
    },

    exitDebugMode(target) {
      return sendEvent(
        target.projectPath,
        target.sessionName,
        target.conversationId,
        { type: "EXIT_DEBUG_MODE" },
      );
    },

    markReproduced(target) {
      return sendEvent(
        target.projectPath,
        target.sessionName,
        target.conversationId,
        { type: "MARK_REPRODUCED" },
      );
    },

    markFixVerified(target) {
      return sendEvent(
        target.projectPath,
        target.sessionName,
        target.conversationId,
        { type: "MARK_FIX_VERIFIED" },
      );
    },

    setRecording(target, recording) {
      return sendEvent(
        target.projectPath,
        target.sessionName,
        target.conversationId,
        { type: "SET_DEBUG_RECORDING", recording },
      );
    },

    clearDebugLogs(target) {
      return sendEvent(
        target.projectPath,
        target.sessionName,
        target.conversationId,
        { type: "CLEAR_DEBUG_LOGS" },
      );
    },
  };
}

let cachedAdapter: DebugAdapter | null = null;

export function getDefaultDebugAdapter(): DebugAdapter {
  if (!cachedAdapter) {
    cachedAdapter = createDebugAdapter();
  }
  return cachedAdapter;
}

export function _resetDefaultDebugAdapterForTesting(): void {
  cachedAdapter = null;
}
