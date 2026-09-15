import {
  CURSOR_IPC_CODEC_VERSION,
  encodeNativePayload,
  type CursorSdkErrorFrameDetail,
  type CursorWorkerFrame,
  type NativeCodecViolation,
} from "../worker/ipc";
import { modelSelectionKey } from "../../model-selection";
import type {
  CursorAttachInput,
  CursorTurnInput,
  CursorWorkerCloseOutcome,
  CursorWorkerExitInfo,
  CursorWorkerSession,
  CursorWorkerStartInput,
  CursorWorkerStartResult,
  CursorWorkerTransport,
} from "../worker-port";

/**
 * A scripted `CursorWorkerTransport` (spec D19): the injected seam that lets
 * the REAL conversation runtime, continuity adapter, projections, classifier,
 * and failure dispositions run against a worker whose frames a test writes by
 * hand.
 *
 * Nothing here simulates the runtime's own logic — it only plays the worker's
 * side of the IPC contract, so an assertion about ordering, idempotency,
 * disposition, or usage is an assertion about production code.
 */

export interface ScriptedTurn {
  runId: string;
  input: CursorTurnInput;
}

/** What a scripted worker does when a turn starts. Set per test. */
export type ScriptedTurnScript = (
  turn: ScriptedTurn,
  worker: ScriptedWorker,
) => void | Promise<void>;

export interface ScriptedWorkerOptions {
  onSteer?(
    input: { runId: string; requestId: string; text: string },
    worker: ScriptedWorker,
  ): void;
  /** Frames to play for each `startTurn`; defaults to an empty finished turn. */
  onTurn?: ScriptedTurnScript;
  /** Attach outcome; defaults to attaching and issuing `ref`. */
  onAttach?: (input: CursorAttachInput, worker: ScriptedWorker) => void;
  /** The ref a default attach issues. */
  ref?: string;
  /** Start outcome; defaults to a ready worker. */
  startResult?: (
    input: CursorWorkerStartInput,
  ) => Exclude<CursorWorkerStartResult, { kind: "ready" }> | null;
  closeOutcome?: CursorWorkerCloseOutcome;
  /**
   * Held open to model the real supervisor's teardown ladder. The supervisor
   * clears its registry entry in `onSettled`, at the END of `runTeardown`
   * (after `verifyGone`), so a worker stays ACTIVE and returnable from
   * `start()` for the whole ladder — up to tens of seconds. A test that wants
   * to drive the race between a discarded worker and the next prompt gates
   * teardown here.
   */
  closeGate?: () => Promise<void>;
}

export class ScriptedWorker implements CursorWorkerSession {
  readonly conversationId: string;
  readonly workerId: string;
  readonly pid = 4242;
  readonly selectionKey: string;
  readonly ownerToken: object;

  readonly attachments: CursorAttachInput[] = [];
  readonly turns: ScriptedTurn[] = [];
  readonly cancelledRunIds: string[] = [];
  readonly steers: Array<{ runId: string; requestId: string; text: string }> =
    [];
  readonly questionReplies: Array<{
    runId: string;
    requestId: string;
    reply: import("@/lib/conversations/in-turn-question-schemas").InTurnQuestionReply;
  }> = [];
  closeCount = 0;

  private readonly emit: (frame: CursorWorkerFrame) => void;
  private readonly emitExit: (info: CursorWorkerExitInfo) => void;
  private readonly options: ScriptedWorkerOptions;
  /** Mirrors the supervisor's `onSettled`: clears this worker's registry slot. */
  private readonly deregister: () => void;
  private exited = false;

  constructor(
    input: CursorWorkerStartInput,
    options: ScriptedWorkerOptions,
    workerId: string,
    deregister: () => void,
  ) {
    this.conversationId = input.conversationId;
    this.selectionKey = modelSelectionKey(input.modelSelection);
    this.ownerToken = input.ownerToken;
    this.emit = input.onFrame;
    this.emitExit = input.onExit;
    this.options = options;
    this.workerId = workerId;
    this.deregister = deregister;
  }

  /** Play one worker→parent frame, exactly as the supervisor would forward it. */
  send(frame: CursorWorkerFrame): void {
    if (this.exited) return;
    this.emit(frame);
  }

  /** Forward a complete native SDK object through the real tagged encoding. */
  sendNativeEvent(runId: string, eventIndex: number, native: unknown): void {
    const eventType =
      typeof native === "object" &&
      native !== null &&
      typeof Reflect.get(native, "type") === "string"
        ? (Reflect.get(native, "type") as string)
        : "unknown";
    const encoded = encodeNativePayload(eventType, native);
    if (!encoded.ok) {
      this.send({
        v: CURSOR_IPC_CODEC_VERSION,
        type: "nativeEventRejected",
        runId,
        eventIndex,
        eventType: encoded.eventType,
        violation: encoded.violation,
        byteLength: encoded.byteLength,
        sha256: encoded.sha256,
      });
      return;
    }
    this.send({
      v: CURSOR_IPC_CODEC_VERSION,
      type: "nativeEvent",
      runId,
      eventIndex,
      eventType,
      payload: encoded.payload,
    });
  }

  /** A payload the encoder would have refused, reported as the worker does. */
  sendRejectedEvent(
    runId: string,
    eventIndex: number,
    // The full codec vocabulary, not a subset: a fake that cannot express
    // every violation the wire admits hides the ones it omits.
    violation: NativeCodecViolation,
    eventType = "assistant",
  ): void {
    this.send({
      v: CURSOR_IPC_CODEC_VERSION,
      type: "nativeEventRejected",
      runId,
      eventIndex,
      eventType,
      violation,
      byteLength: 4096,
      sha256: "0".repeat(64),
    });
  }

  sendInputAccepted(runId: string): void {
    this.send({ v: CURSOR_IPC_CODEC_VERSION, type: "inputAccepted", runId });
  }

  sendRefIssued(ref: string, runId: string | null = null): void {
    this.send({ v: CURSOR_IPC_CODEC_VERSION, type: "refIssued", runId, ref });
  }

  /**
   * Counts are nullable because the IPC contract accepts them that way
   * (`usageFrameSchema`). A fake narrower than the wire it stands in for would
   * hide exactly the partial-usage case worth testing.
   */
  sendUsage(
    runId: string,
    usage: {
      inputTokens: number | null;
      outputTokens: number | null;
      cacheReadTokens: number | null;
      cacheWriteTokens: number | null;
      totalTokens: number | null;
      reasoningTokens?: number;
    },
  ): void {
    this.send({
      v: CURSOR_IPC_CODEC_VERSION,
      type: "usage",
      runId,
      ...usage,
    });
  }

  settle(
    runId: string,
    outcome: "completed" | "aborted" | "failed",
    error: CursorSdkErrorFrameDetail | null = null,
  ): void {
    this.send({
      v: CURSOR_IPC_CODEC_VERSION,
      type: "turnSettled",
      runId,
      outcome,
      error,
    });
  }

  /** The worker process died without being asked to. */
  die(code = 1, signal: string | null = null): void {
    if (this.exited) return;
    this.exited = true;
    // An unexpected exit clears the supervisor's registry entry immediately.
    this.deregister();
    this.emitExit({
      conversationId: this.conversationId,
      workerId: this.workerId,
      pid: this.pid,
      code,
      signal,
      expected: false,
    });
  }

  attach(input: CursorAttachInput): void {
    this.attachments.push(input);
    if (this.options.onAttach) {
      this.options.onAttach(input, this);
      return;
    }
    const ref = input.ref ?? this.options.ref ?? "agent-scripted";
    this.sendRefIssued(ref);
    this.send({
      v: CURSOR_IPC_CODEC_VERSION,
      type: "attachResult",
      outcome: "attached",
      ref,
      error: null,
    });
  }

  startTurn(input: CursorTurnInput): void {
    const turn: ScriptedTurn = { runId: input.runId, input };
    this.turns.push(turn);
    const script =
      this.options.onTurn ??
      ((played: ScriptedTurn, worker: ScriptedWorker) => {
        worker.sendInputAccepted(played.runId);
        worker.settle(played.runId, "completed");
      });
    void Promise.resolve(script(turn, this));
  }

  cancel(runId: string): void {
    this.cancelledRunIds.push(runId);
    this.send({
      v: CURSOR_IPC_CODEC_VERSION,
      type: "cancelResult",
      runId,
      outcome: "cancelled",
      message: null,
    });
  }

  steer(runId: string, requestId: string, text: string): void {
    const input = { runId, requestId, text };
    this.steers.push(input);
    if (this.options.onSteer) {
      this.options.onSteer(input, this);
      return;
    }
    this.send({
      v: CURSOR_IPC_CODEC_VERSION,
      type: "steerResult",
      runId,
      requestId,
      outcome: "complete_delivered",
    });
  }

  answerQuestion(
    runId: string,
    requestId: string,
    reply: import("@/lib/conversations/in-turn-question-schemas").InTurnQuestionReply,
  ): void {
    this.questionReplies.push({ runId, requestId, reply });
  }

  async close(): Promise<CursorWorkerCloseOutcome> {
    this.closeCount += 1;
    // The registry entry survives the whole ladder, exactly as the real
    // supervisor's does — deregistration happens only once teardown settles.
    await this.options.closeGate?.();
    this.exited = true;
    this.deregister();
    return (
      this.options.closeOutcome ?? { kind: "verified", escalation: "orderly" }
    );
  }
}

export interface ScriptedTransport extends CursorWorkerTransport {
  /** Every worker this transport has started, in order. */
  readonly workers: readonly ScriptedWorker[];
  readonly startInputs: readonly CursorWorkerStartInput[];
}

export function createScriptedTransport(
  options: ScriptedWorkerOptions = {},
): ScriptedTransport {
  const workers: ScriptedWorker[] = [];
  const startInputs: CursorWorkerStartInput[] = [];
  const live = new Map<string, ScriptedWorker>();
  let workerCounter = 0;

  return {
    workers,
    startInputs,
    async start(input) {
      startInputs.push(input);
      // The supervisor's first act: a conversation that still has a registered
      // worker gets THAT worker back, even while its teardown is in flight.
      const existing = live.get(input.conversationId);
      if (existing !== undefined) {
        if (existing.ownerToken !== input.ownerToken) {
          return {
            kind: "binding_mismatch",
            message:
              "A Cursor worker is already active for this conversation under a different runtime owner.",
          };
        }
        if (existing.selectionKey !== modelSelectionKey(input.modelSelection)) {
          return {
            kind: "binding_mismatch",
            message:
              "A Cursor worker is already active for this conversation under a different model selection.",
          };
        }
        return { kind: "already_active", session: existing };
      }
      const refused = options.startResult?.(input) ?? null;
      if (refused !== null) return refused;
      workerCounter += 1;
      const workerId = `scripted-worker-${workerCounter}`;
      const worker = new ScriptedWorker(input, options, workerId, () => {
        if (live.get(input.conversationId) === worker) {
          live.delete(input.conversationId);
        }
      });
      workers.push(worker);
      live.set(input.conversationId, worker);
      return { kind: "ready", session: worker };
    },
    find(conversationId) {
      return live.get(conversationId) ?? null;
    },
    async closeAll() {
      for (const worker of live.values()) await worker.close();
      live.clear();
    },
  };
}
