import { describe, it, expect } from "vitest";
import type { Logger } from "@/lib/logging";
import { createWriteQueue, type WriteQueue } from "./write-queue";

/**
 * Ordering regression for the `no-slow-work-in-critical-section` charter
 * invariant on the write queue itself.
 *
 * `settle()` emits the `write_queue.timing` event (and a possible
 * `hold_budget_exceeded`) — synchronous `appendFileSync` I/O in the production
 * logger. It MUST shift the departing owner off the FIFO and release the
 * successor's gate BEFORE that emit, so a waiter is never held across the log
 * write and `holdMs` never counts it. This mirrors `tryWithWriteQueue`, which
 * already releases before logging.
 *
 * The probe logger, from inside the timing emit, attempts a fresh
 * `tryWithWriteQueue`. If release already happened the `owners` FIFO is empty
 * and the try reserves silently; if the log fired FIRST (the bug) the departing
 * writer is still the holder, so the try is contended and emits
 * `try_contended`. Asserting `try_contended` never fires proves release
 * preceded the log — the test fails against a settle() that logs before it
 * releases.
 */
describe("write queue — release precedes logging", () => {
  it("shifts the owner and releases the gate before emitting the timing log", async () => {
    const events: string[] = [];
    // The probe logger must reach the very queue it is wired into — a cycle
    // (logger → queue → logger) — so the queue lives in a mutable box the
    // closure reads, while `queue` itself stays a single-assignment const.
    const box: { queue: WriteQueue | null } = { queue: null };

    const probeLogger: Logger = {
      debug() {},
      warn() {},
      error() {},
      info(message: string) {
        events.push(message);
        if (message === "state-store.write_queue.timing") {
          // Probe queue idleness at the exact moment of the timing emit. When
          // the queue is contended, tryWithWriteQueue synchronously records
          // `try_contended`; when idle it reserves without that mark.
          void box.queue?.tryWithWriteQueue(
            "release-ordering.probe",
            async () => {},
          );
        }
      },
    };

    const queue = createWriteQueue({ logger: probeLogger });
    box.queue = queue;

    await queue.withWriteQueue("release-ordering.write", async () => {
      // A no-op mutation: the whole point is the settle() emit ordering.
    });

    expect(events).toContain("state-store.write_queue.timing");
    // If settle() logged before releasing, the probe would have found the queue
    // still held and emitted this. Its absence proves release-before-logging.
    expect(events).not.toContain("state-store.write_queue.try_contended");
  });

  it("releases before logging on the synchronous entry too", async () => {
    const events: string[] = [];
    const box: { queue: WriteQueue | null } = { queue: null };

    const probeLogger: Logger = {
      debug() {},
      warn() {},
      error() {},
      info(message: string) {
        events.push(message);
        if (message === "state-store.write_queue.timing") {
          void box.queue?.tryWithWriteQueue(
            "release-ordering.probe",
            async () => {},
          );
        }
      },
    };

    const queue = createWriteQueue({ logger: probeLogger });
    box.queue = queue;

    await queue.withWriteQueueSync("release-ordering.sync-write", () => {});

    expect(events).toContain("state-store.write_queue.timing");
    expect(events).not.toContain("state-store.write_queue.try_contended");
  });
});
