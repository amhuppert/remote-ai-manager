/**
 * Debug adapter — single seam around debug-mode operations.
 *
 * The debug workflow (`@/lib/workflows/debug/`) owns phase transitions
 * through its pure command reducer; this adapter is how everything outside
 * the machine reaches it — schema selection for structured output, status
 * emission onto the SSE wire, and lifecycle dispatch from API routes. Each
 * lifecycle method maps onto a `DebugCommand` carried by the machine's single
 * `DEBUG_COMMAND` event; the boolean return mirrors the machine's legality
 * gate (`snapshot.can()`), which routes reject with a 409.
 *
 * `sendConversationEvent` is resolved lazily via `require()` to mirror the
 * dynamic-import deferral used by the SSE publication module and avoid a
 * circular import with `manager.ts`, which itself depends on the conversation
 * machine. Tests can inject a fake sender directly through `createDebugAdapter`.
 */
import type { ConversationEvent } from "./types";
import type { DebugCommand } from "@/lib/workflows/debug/commands";
import type { DebugModePhase } from "@/lib/debug-log/schemas";
import {
  debugCleanupResultSchema,
  debugEvidenceAnalysisOutputSchema,
  debugHypothesisOutputSchema,
} from "./debug-schemas";
import type { SSEEvent } from "@/lib/api/sse-events";
import { publishEvent, type PublishOutcome } from "@/lib/events/publication";
import { randomUUID } from "node:crypto";

interface DebugOutputFormat {
  type: "json_schema";
  schema: Record<string, unknown>;
}

interface DebugTarget {
  projectPath: string;
  sessionName: string;
  conversationId: string;
}

interface DebugStatusInput {
  projectName: string;
  sessionName: string;
  conversationId: string;
  active: boolean;
  recording: boolean;
}

interface DebugLogReceivedInput {
  projectName: string;
  sessionName: string;
  conversationId: string;
  entryCount: number;
}

type SendConversationEventFn = (
  projectPath: string,
  sessionName: string,
  conversationId: string,
  event: ConversationEvent,
) => boolean;

type PublishSSEFn = (event: SSEEvent) => PublishOutcome;

export interface DebugAdapterDeps {
  sendConversationEvent?: SendConversationEventFn;
  publishSSE?: PublishSSEFn;
  createDebugSessionId?(): string;
}

export interface DebugAdapter {
  resolveOutputFormat(
    phase: DebugModePhase | null | undefined,
  ): DebugOutputFormat | undefined;
  publishDebugModeStatus(input: DebugStatusInput): PublishOutcome;
  publishDebugLogReceived(input: DebugLogReceivedInput): PublishOutcome;
  enterDebugMode(target: DebugTarget, args: { logFilePath: string }): boolean;
  exitDebugMode(target: DebugTarget): boolean;
  markReproduced(target: DebugTarget): boolean;
  markFixVerified(target: DebugTarget): boolean;
  /**
   * User has tested the agent's claimed fix and confirmed the bug still
   * reproduces. Loops the conversation back to `hypothesizing` so the agent
   * can form a fresh hypothesis set treating the prior attempt as refuted.
   */
  markFixFailed(target: DebugTarget): boolean;
  /**
   * Inverse of `markReproduced` — used by Strategy B client-side rollback in
   * `DebugActionCard.tsx` when a prompt send fails after the phase has
   * already advanced. Transitions analyzingEvidence → awaitingReproduction.
   */
  revertToAwaitingReproduction(target: DebugTarget): boolean;
  /**
   * Inverse of `markFixVerified` — used by Strategy B client-side rollback.
   * Transitions cleanupInstrumentation → awaitingVerification.
   */
  revertToAwaitingVerification(target: DebugTarget): boolean;
  /**
   * From the `debug.error` sub-state, re-runs the failed turn against the
   * preserved phase + activeTurn (no UI input needed).
   */
  retryDebugTurn(target: DebugTarget): boolean;
  setRecording(target: DebugTarget, recording: boolean): boolean;
}

function resolveSchema(
  phase: DebugModePhase | null | undefined,
): Record<string, unknown> | undefined {
  switch (phase) {
    case "hypothesizing":
      return debugHypothesisOutputSchema as unknown as Record<string, unknown>;
    case "analyzing_evidence":
      return debugEvidenceAnalysisOutputSchema as unknown as Record<
        string,
        unknown
      >;
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

function defaultPublishSSE(event: SSEEvent): PublishOutcome {
  return publishEvent(event);
}

export function createDebugAdapter(deps: DebugAdapterDeps = {}): DebugAdapter {
  const sendEvent = deps.sendConversationEvent ?? defaultSendConversationEvent;
  const publishSSE = deps.publishSSE ?? defaultPublishSSE;
  const createDebugSessionId = deps.createDebugSessionId ?? randomUUID;

  const dispatch = (target: DebugTarget, command: DebugCommand): boolean =>
    sendEvent(target.projectPath, target.sessionName, target.conversationId, {
      type: "DEBUG_COMMAND",
      command,
    });

  // Per-phase wrapper cache. The downstream `shouldRecreateRuntime` check uses
  // reference equality on `outputFormat`, so returning a fresh `{ type, schema }`
  // object every call would churn the backend runtime even when the phase
  // hadn't changed. Schemas are module-level constants, so caching by phase
  // is safe.
  const outputFormatCache = new Map<DebugModePhase, DebugOutputFormat>();

  return {
    resolveOutputFormat(phase) {
      if (phase == null) return undefined;
      const cached = outputFormatCache.get(phase);
      if (cached) return cached;
      const schema = resolveSchema(phase);
      if (!schema) return undefined;
      const wrapper: DebugOutputFormat = { type: "json_schema", schema };
      outputFormatCache.set(phase, wrapper);
      return wrapper;
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
      return dispatch(target, {
        kind: "enter",
        logFilePath,
        debugSessionId: createDebugSessionId(),
      });
    },

    exitDebugMode(target) {
      return dispatch(target, { kind: "exit" });
    },

    markReproduced(target) {
      return dispatch(target, { kind: "mark_reproduced" });
    },

    markFixVerified(target) {
      return dispatch(target, { kind: "mark_fix_verified" });
    },

    markFixFailed(target) {
      return dispatch(target, { kind: "mark_fix_failed" });
    },

    revertToAwaitingReproduction(target) {
      return dispatch(target, { kind: "revert_to_awaiting_reproduction" });
    },

    revertToAwaitingVerification(target) {
      return dispatch(target, { kind: "revert_to_awaiting_verification" });
    },

    retryDebugTurn(target) {
      return dispatch(target, { kind: "retry_turn" });
    },

    setRecording(target, recording) {
      return dispatch(target, { kind: "set_recording", recording });
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
