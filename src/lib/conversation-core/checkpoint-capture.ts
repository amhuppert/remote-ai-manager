/**
 * A checkpoint's handoff capture on a conversation the core runs: one turn,
 * in the conversation's own session, asking the agent for the working state
 * the archive cannot show. The checkpoint maintenance owns the operation and
 * its durable stages; this host runs the capture and writes its audit.
 *
 * The core keeps no runtime between turns, so a capture always opens its own,
 * resuming the session the build captured, and releases it once the capture
 * has settled. A capture whose processes could not be confirmed stopped keeps
 * its runtime hosted: the operation is held for reconciliation, whose close
 * collects it.
 */

import { isDeepStrictEqual } from "node:util";

import type { CaptureHandoffInput } from "@/lib/agent-backends/conversation";
import {
  captureHandoffResultSchema,
  type BackendModelSelection,
  type CaptureAvailability,
  type CaptureHandoffResult,
  type CaptureMode,
} from "@/lib/agent-backends/schemas";
import { conversationTranscriptFrame } from "@/lib/agent-backends/transcript";
import { omittedCaptureResult } from "@/lib/conversation-checkpoints/checkpoint-capture";
import { checkpointErrorFields } from "@/lib/conversation-checkpoints/diagnostics";
import type {
  CheckpointHostObservation,
  CheckpointMaintenanceHost,
} from "@/lib/conversation-checkpoints/checkpoint-maintenance";
import type { CheckpointOperation } from "@/lib/conversation-checkpoints/schemas";
import type { Logger } from "@/lib/logging";
import {
  isAddressableTranscriptEntry,
  type TranscriptEntry,
} from "@/lib/prompt/transcript";
import { getErrorMessage } from "@/lib/shared/errors";
import type { AgentBackendId, AgentSessionRef } from "@/lib/shared/schemas";
import type { ConversationBackendRuntime } from "@/lib/agent-backends/conversation";
import type { ConversationTarget } from "@/lib/conversations/conversation-target";

/** What a handoff capture asks of the conversation's runtime. */
export interface CaptureRuntimeRequest {
  /** The conversation as the state store keys it: the project sentinel for a project conversation. */
  identity: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
  };
  target: ConversationTarget;
  worktreePath: string;
  backend: AgentBackendId;
  modelSelection: BackendModelSelection;
  backendRef: AgentSessionRef;
  captureId: string;
  mode: CaptureMode;
}

/** The capture side of a conversation's runtime. */
export type CaptureRuntime = Pick<
  ConversationBackendRuntime,
  "modelSelection" | "captureHandoff"
>;

export interface CoreCaptureDeps {
  captureAvailability(backend: AgentBackendId): CaptureAvailability;
  appendCaptureEntryOnce(
    conversationId: string,
    entry: TranscriptEntry & { id: string },
  ): Promise<void>;
  openForCapture(input: CaptureRuntimeRequest): Promise<CaptureRuntime>;
  release(conversationId: string): Promise<void>;
  /** Closes again a runtime whose close failed or was never confirmed; throws if it fails again. */
  retryRelease(conversationId: string): Promise<void>;
  now(): string;
  log: Pick<Logger, "warn">;
}

/** The build a capture runs under. */
export interface CoreCaptureContext {
  request: Pick<CaptureRuntimeRequest, "identity" | "target" | "worktreePath">;
  /** The session the build captured, which the capture resumes. */
  priorRef: AgentSessionRef | null;
  /** Whether the build still holds the conversation with nothing having moved it. */
  settled(
    expected: Pick<CheckpointHostObservation, "backgroundEpoch">,
  ): boolean;
  /** Why the conversation's row no longer admits a capture on `backend`, or null. */
  sourceRefusal(backend: AgentBackendId): Promise<string | null>;
  /** Keeps a capture whose cleanup or audit is unfinished, for the operation's reconciliation. */
  retain(capture: RetainedCapture): void;
}

/**
 * A capture whose processes were not confirmed stopped, or whose audit could
 * not all be written. It keeps accepting the capture's late transcript frames
 * and its unwritten entries until reconciliation finishes it.
 */
export interface RetainedCapture {
  captureId: string;
  /**
   * Writes what the audit still owes under the same entry ids, collects the
   * capture's runtime, and completes the audit: true once nothing of the
   * capture can still run and its audit is durable; false when this process
   * never learned the capture's outcome, so its stop cannot be observed.
   * Throws when a write or the close fails again.
   */
  reconcile(): Promise<boolean>;
}

type CaptureOutcome = Awaited<
  ReturnType<CheckpointMaintenanceHost["captureHandoff"]>
>;

export async function captureCoreHandoff(
  deps: CoreCaptureDeps,
  context: CoreCaptureContext,
  operation: CheckpointOperation,
  captureInput: Omit<CaptureHandoffInput, "mode" | "onTranscript">,
  expected: Pick<CheckpointHostObservation, "backgroundEpoch">,
): Promise<CaptureOutcome> {
  const handoff = operation.handoff;
  if (handoff === null) throw new Error("Capture has no admitted intent");
  const { conversationId } = context.request.identity;
  const ref = context.priorRef;
  const auditEntryIds: string[] = [];
  let sourceChanged = false;
  let ordinal = 0;
  let sinkSettled = false;
  let writes: Promise<void> = Promise.resolve();
  let writeFailure: unknown;
  /** Entries whose write has not succeeded yet, by id, in order. */
  const pendingWrites = new Map<string, () => Promise<void>>();
  let opened = false;
  let invoked = false;
  let outputAdded = false;
  let settlementAdded = false;
  /** What the backend reported, once it did. */
  let captureResult: CaptureHandoffResult | null = null;

  const sourceIsCurrent = () =>
    context.settled(expected) &&
    (ref?.ref ?? null) === operation.protectedReferences.priorBackendRef;

  const append = (
    entry: TranscriptEntry,
    part: "control" | "output" | "activity" | "settlement",
  ): Promise<void> => {
    const id = `${handoff.captureId}:${ordinal++}`;
    const stamped: TranscriptEntry & { id: string } = {
      ...entry,
      id,
      origin: {
        source: "checkpoint_capture",
        checkpointCapture: {
          operationId: operation.id,
          captureId: handoff.captureId,
          part,
        },
      },
    };
    // Raw backend protocol frames stay forensic; only entries the archive reader addresses join the audit range.
    if (isAddressableTranscriptEntry(stamped)) auditEntryIds.push(id);
    const persist = async () => {
      await deps.appendCaptureEntryOnce(conversationId, stamped);
      pendingWrites.delete(id);
    };
    pendingWrites.set(id, persist);
    const receipt = writes.then(persist);
    writes = receipt.catch((error: unknown) => {
      writeFailure ??= error;
    });
    return receipt;
  };

  const sourceRefusal = () => {
    sourceChanged = true;
    return omittedCaptureResult("checkpoint_failed", ref);
  };

  const dispatch = async (): Promise<CaptureHandoffResult> => {
    if (captureInput.signal.aborted)
      return omittedCaptureResult("skipped", ref);
    if (!sourceIsCurrent()) return sourceRefusal();
    const availability = deps.captureAvailability(handoff.backend);
    if (handoff.requestedMode === null || !availability.available)
      return omittedCaptureResult("unavailable", ref);
    if (availability.mode !== handoff.requestedMode)
      return omittedCaptureResult("mode_changed", ref);
    if (ref === null || ref.backend !== handoff.backend)
      return omittedCaptureResult("continuity_unavailable", null);
    if (
      (await context.sourceRefusal(handoff.backend)) !== null ||
      !sourceIsCurrent()
    )
      return sourceRefusal();
    const mode = handoff.requestedMode;
    let runtime: CaptureRuntime;
    try {
      opened = true;
      runtime = await deps.openForCapture({
        ...context.request,
        backend: handoff.backend,
        modelSelection: structuredClone(handoff.modelSelection),
        backendRef: ref,
        captureId: handoff.captureId,
        mode,
      });
    } catch (error) {
      deps.log.warn("checkpoint.capture.runtime_failed", {
        conversationId,
        operationId: operation.id,
        ...checkpointErrorFields(error),
      });
      return omittedCaptureResult("mode_establishment_failed", ref);
    }
    if (runtime.captureHandoff === undefined)
      return omittedCaptureResult("unavailable", ref);
    const bindingIsCurrent = () =>
      sourceIsCurrent() &&
      isDeepStrictEqual(runtime.modelSelection, handoff.modelSelection);
    if (!bindingIsCurrent()) return sourceRefusal();
    await append(
      {
        timestamp: deps.now(),
        type: "checkpoint_capture_control",
        role: "notice",
        content: [{ type: "text", text: captureInput.promptText }],
      },
      "control",
    );
    if (!bindingIsCurrent()) return sourceRefusal();
    const current = deps.captureAvailability(handoff.backend);
    if (!current.available || current.mode !== mode)
      return omittedCaptureResult("mode_changed", ref);
    if (captureInput.signal.aborted)
      return omittedCaptureResult("skipped", ref);
    invoked = true;
    const result = captureHandoffResultSchema.parse(
      await runtime.captureHandoff({
        ...captureInput,
        mode,
        onTranscript: async (entry) => {
          if (sinkSettled)
            throw new Error("Capture transcript sink is settled");
          const frame = conversationTranscriptFrame(entry);
          return append(
            frame,
            frame.role === "user"
              ? "control"
              : frame.role === "assistant"
                ? "output"
                : "activity",
          );
        },
      }),
    );
    sourceChanged = !bindingIsCurrent();
    return result;
  };

  const finishAudit = async (result: CaptureHandoffResult) => {
    sinkSettled = true;
    if (!result.submitted && ordinal === 0) return;
    if (result.candidateText !== null && !outputAdded) {
      outputAdded = true;
      await append(
        {
          timestamp: deps.now(),
          type: "checkpoint_capture_output",
          role: "assistant",
          content: [{ type: "text", text: result.candidateText }],
        },
        "output",
      );
    }
    if (settlementAdded) return;
    settlementAdded = true;
    await append(
      {
        timestamp: deps.now(),
        type: "checkpoint_capture_settlement",
        role: "notice",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              captureId: handoff.captureId,
              executionSettled: result.executionSettled,
              activity: result.activity,
              omissionReason: result.omissionReason,
            }),
          },
        ],
      },
      "settlement",
    );
  };

  // The model request is never replayed: only the audit's own writes and the runtime's close are.
  const reconcile = async (): Promise<boolean> => {
    await writes;
    writeFailure = undefined;
    for (const persist of [...pendingWrites.values()]) await persist();
    await deps.retryRelease(conversationId);
    const known =
      captureResult ??
      (invoked ? null : omittedCaptureResult("capture_failed", ref));
    if (known === null) return false;
    // A successful close collected whatever the capture left running.
    captureResult = { ...known, executionSettled: true, cleanupFailure: null };
    await finishAudit(captureResult);
    await writes;
    if (writeFailure !== undefined) throw writeFailure;
    return true;
  };
  const retained: RetainedCapture = {
    captureId: handoff.captureId,
    reconcile,
  };

  // Kept from the start: whatever fails after the capture (the checkpoint's own writes and
  // reads included), reconciliation finds the capture this process ran and can observe its stop.
  context.retain(retained);
  let result = await dispatch();
  captureResult = result;
  // A runtime whose processes were not confirmed stopped stays hosted for reconciliation to collect.
  if (opened && result.executionSettled) {
    try {
      await deps.release(conversationId);
    } catch (error) {
      result = {
        ...result,
        executionSettled: false,
        cleanupFailure: {
          code: "cleanup_unverified",
          message: `the capture runtime did not close: ${getErrorMessage(error)}`,
        },
      };
    }
  }
  // Late frames of an unconfirmed capture are still its audit: the sink stays open for them.
  if (result.executionSettled && result.cleanupFailure === null)
    await finishAudit(result);
  await writes;
  if (writeFailure !== undefined) throw writeFailure;
  return { ...result, auditEntryIds, sourceChanged };
}
