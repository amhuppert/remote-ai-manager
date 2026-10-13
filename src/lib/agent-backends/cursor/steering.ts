import { randomUUID } from "node:crypto";
import { createLogger } from "@/lib/logging";
import { InputDeliveryUncertainError } from "../errors";
import type { CursorWorkerFrame } from "./worker/ipc";

const logger = createLogger("cursor:steering");

type SteerAnswer = Extract<
  CursorWorkerFrame,
  { type: "steerResult" }
>["outcome"];

/** What settled a steer other than the provider's own answer. */
type SettleCause =
  | "echoed"
  | "dispatch_failed"
  | "caller_aborted"
  | "run_ended"
  | "run_incomplete"
  | "worker_closed";

interface PendingSteer {
  runId: string;
  /** Trimmed, as the run's echo of it is compared. */
  text: string;
  /** An answer short of delivery, held until the run ends without echoing the steer. */
  heldAnswer: Exclude<SteerAnswer, "complete_delivered" | "not_sent"> | null;
  settle(outcome: SteerAnswer, cause?: SettleCause): void;
}

export interface CursorSteerDelivery {
  runId: string;
  text: string;
  send(requestId: string): void;
  /**
   * Runs synchronously when Cursor shows the steer delivered, so work it
   * orders runs at that place among the run's frames; the delivery settles
   * with its result.
   */
  onDelivered(): Promise<void>;
  signal?: AbortSignal;
}

/**
 * Correlates each steer with Cursor's evidence of taking it. Cursor appends a
 * steer to its turn only when the current response ends, however long that
 * runs, then answers `complete_delivered` and echoes the steer as a user
 * message in the run. Either proves delivery.
 *
 * The worker's own refusal (`not_sent`: no run to steer) is final at once.
 * Cursor's other answers are held until the run ends: the SDK answers
 * `revert_to_followup` when the server has not confirmed queueing the steer
 * within 15 s, and the server can still append it afterwards. A held answer
 * becomes final only when the run was observed to its normal end. A steer
 * still waiting when its run fails, is cancelled or is forced to end, when its
 * worker goes, or when its caller gives up is uncertain, held answer or not.
 * A refusal that crosses the run's end in flight is read as uncertain too.
 */
export class CursorSteering {
  private readonly pending = new Map<string, PendingSteer>();
  /** Delivered steers whose echo is still to come, so it settles no other steer. */
  private readonly echoesOwed: { runId: string; text: string }[] = [];

  deliver(delivery: CursorSteerDelivery): Promise<void> {
    const { runId, signal } = delivery;
    if (signal?.aborted)
      return Promise.reject(new Error("Input cancelled before delivery"));
    const requestId = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => steer.settle("uncertain", "caller_aborted");
      const steer: PendingSteer = {
        runId,
        text: delivery.text.trim(),
        heldAnswer: null,
        settle: (outcome, cause) => {
          if (!this.pending.delete(requestId)) return;
          signal?.removeEventListener("abort", onAbort);
          logger.info("cursor.steer_settled", {
            runId,
            requestId,
            outcome,
            ...(cause !== undefined ? { cause } : {}),
            ...(steer.heldAnswer !== null
              ? { heldAnswer: steer.heldAnswer }
              : {}),
          });
          if (outcome === "complete_delivered") {
            resolve(delivery.onDelivered());
            return;
          }
          reject(
            outcome === "uncertain"
              ? new InputDeliveryUncertainError(uncertainMessage(cause))
              : new Error(
                  outcome === "not_sent"
                    ? "Cursor's run was not taking input; it goes with the next turn"
                    : "Cursor requested delivery on the next turn",
                ),
          );
        },
      };
      this.pending.set(requestId, steer);
      signal?.addEventListener("abort", onAbort, { once: true });
      logger.info("cursor.steer_dispatched", { runId, requestId });
      try {
        delivery.send(requestId);
      } catch {
        steer.settle("uncertain", "dispatch_failed");
      }
    });
  }

  accept(frame: Extract<CursorWorkerFrame, { type: "steerResult" }>): void {
    const pending = this.pending.get(frame.requestId);
    if (!pending || pending.runId !== frame.runId) return;
    if (frame.outcome === "not_sent") {
      pending.settle("not_sent");
      return;
    }
    if (frame.outcome !== "complete_delivered") {
      pending.heldAnswer = frame.outcome;
      return;
    }
    this.echoesOwed.push({ runId: pending.runId, text: pending.text });
    pending.settle("complete_delivered");
  }

  /** The run appended a user message: the steer it echoes was delivered. */
  echoed(runId: string, text: string): void {
    const key = text.trim();
    const owed = this.echoesOwed.findIndex(
      (echo) => echo.runId === runId && echo.text === key,
    );
    if (owed !== -1) {
      this.echoesOwed.splice(owed, 1);
      return;
    }
    let waitingSteers = 0;
    for (const pending of this.pending.values()) {
      if (pending.runId !== runId) continue;
      if (pending.text !== key) {
        waitingSteers += 1;
        continue;
      }
      pending.settle("complete_delivered", "echoed");
      return;
    }
    // A steer whose echo differs from what CC sent is held to the run's end and
    // may then be sent twice; the length shows a mismatch without the text.
    logger.warn("cursor.steer_echo_unmatched", {
      runId,
      textLength: text.length,
      waitingSteers,
    });
  }

  /**
   * A run that has ended takes none of its steers still waiting. Only a run
   * observed to its normal end makes a held answer final; a failed, cancelled
   * or forced end may have lost the echo, so those steers are uncertain.
   */
  endRun(runId: string, observedToEnd: boolean): void {
    for (let index = this.echoesOwed.length - 1; index >= 0; index -= 1)
      if (this.echoesOwed[index]?.runId === runId)
        this.echoesOwed.splice(index, 1);
    for (const pending of this.pending.values()) {
      if (pending.runId !== runId) continue;
      if (observedToEnd)
        pending.settle(pending.heldAnswer ?? "uncertain", "run_ended");
      else pending.settle("uncertain", "run_incomplete");
    }
  }

  close(): void {
    this.echoesOwed.length = 0;
    for (const pending of this.pending.values())
      pending.settle("uncertain", "worker_closed");
  }
}

function uncertainMessage(cause: SettleCause | undefined): string {
  if (cause === "run_ended")
    return "The Cursor run ended without showing it took this input; review delivery before retrying";
  if (cause === "run_incomplete")
    return "The Cursor run ended before CC could see whether it took this input; review delivery before retrying";
  return "Cursor steering acknowledgement was lost; review delivery before retrying";
}
