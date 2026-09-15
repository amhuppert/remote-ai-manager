import { randomUUID } from "node:crypto";
import { createLogger } from "@/lib/logging";
import { InputDeliveryUncertainError } from "../errors";
import type { CursorWorkerFrame } from "./worker/ipc";

const logger = createLogger("cursor:steering");

interface PendingSteer {
  runId: string;
  settle(
    outcome: "complete_delivered" | "revert_to_followup" | "uncertain",
  ): void;
}

export class CursorSteering {
  private readonly pending = new Map<string, PendingSteer>();

  constructor(private readonly timeoutMs = 30_000) {}

  deliver(
    runId: string,
    send: (requestId: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted)
      return Promise.reject(new Error("Input cancelled before delivery"));
    const requestId = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => settle("uncertain");
      const timer = setTimeout(() => settle("uncertain"), this.timeoutMs);
      const settle: PendingSteer["settle"] = (outcome) => {
        if (!this.pending.delete(requestId)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        logger.info("cursor.steer_settled", { runId, requestId, outcome });
        if (outcome === "complete_delivered") {
          resolve();
          return;
        }
        reject(
          outcome === "uncertain"
            ? new InputDeliveryUncertainError(
                "Cursor steering acknowledgement was lost; review delivery before retrying",
              )
            : new Error("Cursor requested delivery on the next turn"),
        );
      };
      this.pending.set(requestId, { runId, settle });
      signal?.addEventListener("abort", onAbort, { once: true });
      logger.info("cursor.steer_dispatched", { runId, requestId });
      try {
        send(requestId);
      } catch {
        settle("uncertain");
      }
    });
  }

  accept(frame: Extract<CursorWorkerFrame, { type: "steerResult" }>): void {
    const pending = this.pending.get(frame.requestId);
    if (!pending || pending.runId !== frame.runId) return;
    pending.settle(frame.outcome);
  }

  close(): void {
    for (const pending of this.pending.values()) pending.settle("uncertain");
  }
}
