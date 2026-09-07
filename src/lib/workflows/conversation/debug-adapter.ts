import { resolveDebugOutputSchema } from "@/lib/workflows/debug/prompt-policy";
/**
 * Debug adapter — single seam around debug-mode operations.
 *
 * The debug workflow (`@/lib/workflows/debug/`) owns phase transitions
 * through its pure command reducer; this adapter is how everything outside
 * the machine reaches it — schema selection for structured output, status
 * emission onto the SSE wire, and lifecycle dispatch from API routes. Each
 * lifecycle method maps onto a `DebugCommand` carried by the machine's single
 * `DEBUG_COMMAND` event. Commands acknowledge committed state and return an
 * applied, unchanged, or refused outcome. Production command delivery resolves
 * lazily; tests inject the same asynchronous command boundary.
 */
import type { ConversationCommandOutcome } from "./manager";
import type { DebugCommand } from "@/lib/workflows/debug/commands";
import type { DebugModePhase } from "@/lib/debug-log/schemas";

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

type PublishSSEFn = (event: SSEEvent) => PublishOutcome;

export interface DebugAdapterDeps {
  executeCommand?(
    target: DebugTarget,
    command: DebugCommand,
  ): Promise<ConversationCommandOutcome>;
  publishSSE?: PublishSSEFn;
  createDebugSessionId?(): string;
}

export interface DebugAdapter {
  resolveOutputFormat(
    phase: DebugModePhase | null | undefined,
  ): DebugOutputFormat | undefined;
  publishDebugModeStatus(input: DebugStatusInput): PublishOutcome;
  publishDebugLogReceived(input: DebugLogReceivedInput): PublishOutcome;
  enterDebugMode(
    target: DebugTarget,
    args: { logFilePath: string },
  ): Promise<ConversationCommandOutcome>;
  exitDebugMode(target: DebugTarget): Promise<ConversationCommandOutcome>;
  markReproduced(target: DebugTarget): Promise<ConversationCommandOutcome>;
  markFixVerified(target: DebugTarget): Promise<ConversationCommandOutcome>;
  /**
   * User has tested the agent's claimed fix and confirmed the bug still
   * reproduces. Loops the conversation back to `hypothesizing` so the agent
   * can form a fresh hypothesis set treating the prior attempt as refuted.
   */
  markFixFailed(target: DebugTarget): Promise<ConversationCommandOutcome>;
  /**
   * Inverse of `markReproduced` — used by Strategy B client-side rollback in
   * `DebugActionCard.tsx` when a prompt send fails after the phase has
   * already advanced. Transitions analyzingEvidence → awaitingReproduction.
   */
  revertToAwaitingReproduction(
    target: DebugTarget,
  ): Promise<ConversationCommandOutcome>;
  /**
   * Inverse of `markFixVerified` — used by Strategy B client-side rollback.
   * Transitions cleanupInstrumentation → awaitingVerification.
   */
  revertToAwaitingVerification(
    target: DebugTarget,
  ): Promise<ConversationCommandOutcome>;
  /**
   * From the `debug.error` sub-state, re-runs the failed turn against the
   * preserved phase + activeTurn (no UI input needed).
   */
  retryDebugTurn(target: DebugTarget): Promise<ConversationCommandOutcome>;
  setRecording(
    target: DebugTarget,
    recording: boolean,
  ): Promise<ConversationCommandOutcome>;
}

async function defaultExecuteCommand(
  target: DebugTarget,
  command: DebugCommand,
): Promise<ConversationCommandOutcome> {
  const { executeConversationCommand } = await import("./manager");
  const { getProjectDisplayName } = await import("@/lib/projects/resolver");
  const { targetFromStoreSessionName } =
    await import("@/lib/conversations/conversation-target");
  return executeConversationCommand(
    {
      projectPath: target.projectPath,
      target: targetFromStoreSessionName(
        getProjectDisplayName(target.projectPath),
        target.sessionName,
        target.conversationId,
      ),
    },
    command,
  );
}

function defaultPublishSSE(event: SSEEvent): PublishOutcome {
  return publishEvent(event);
}

export function createDebugAdapter(deps: DebugAdapterDeps = {}): DebugAdapter {
  const executeCommand = deps.executeCommand ?? defaultExecuteCommand;
  const publishSSE = deps.publishSSE ?? defaultPublishSSE;
  const createDebugSessionId = deps.createDebugSessionId ?? randomUUID;

  const dispatch = (
    target: DebugTarget,
    command: DebugCommand,
  ): Promise<ConversationCommandOutcome> => executeCommand(target, command);

  return {
    resolveOutputFormat(phase) {
      if (phase == null) return undefined;
      const schema = resolveDebugOutputSchema(phase);
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
