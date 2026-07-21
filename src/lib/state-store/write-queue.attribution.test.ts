/**
 * Attribution tests for the write queue's timing events.
 *
 * Uses the REAL logger (no `@/lib/logging` mock) so the assertions exercise the
 * end-to-end behavior a log analyst actually sees: the waiter's ambient traceId
 * auto-stamped from the AsyncLocalStorage TraceContext, plus the current-owner
 * metadata the queue records on every wait it causes (Design 6.2). A blocked
 * request must be attributable to the mutation that held the queue against it —
 * not just visible as "something waited".
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runWithTrace } from "@/lib/logging";
import { _resetLoggerForTesting } from "@/lib/logging/logger";
import { createWriteQueue } from "./write-queue";

let tmpRoot: string;
let savedConfigDir: string | undefined;
let savedSilent: string | undefined;
let savedLevel: string | undefined;

function globalLogLines(): Record<string, unknown>[] {
  const file = path.join(tmpRoot, "logs", "global.log");
  if (!existsSync(file)) return [];
  const content = readFileSync(file, "utf-8").trim();
  if (!content) return [];
  return content
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function timingEvents(): Record<string, unknown>[] {
  return globalLogLines().filter(
    (entry) => entry["message"] === "state-store.write_queue.timing",
  );
}

/** Yield a macrotask so queued microtasks (queue acquisition) drain first. */
const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "cc-write-queue-attr-"));
  savedConfigDir = process.env["CC_CONFIG_DIR"];
  savedSilent = process.env["CC_LOG_SILENT"];
  savedLevel = process.env["CC_LOG_LEVEL"];
  _resetLoggerForTesting();
  delete process.env["CC_LOG_SILENT"];
  delete process.env["CC_LOG_FILE"];
  delete process.env["CC_LOG_SCOPED"];
  process.env["CC_CONFIG_DIR"] = tmpRoot;
  process.env["CC_LOG_LEVEL"] = "info";
});

afterEach(() => {
  _resetLoggerForTesting();
  if (savedSilent === undefined) delete process.env["CC_LOG_SILENT"];
  else process.env["CC_LOG_SILENT"] = savedSilent;
  if (savedLevel === undefined) delete process.env["CC_LOG_LEVEL"];
  else process.env["CC_LOG_LEVEL"] = savedLevel;
  if (savedConfigDir === undefined) delete process.env["CC_CONFIG_DIR"];
  else process.env["CC_CONFIG_DIR"] = savedConfigDir;
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("write queue timing attribution", () => {
  it("stamps the waiter's ambient traceId and names the owner it blocked on", async () => {
    const queue = createWriteQueue();

    let releaseOwner!: () => void;
    const ownerBlocker = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });

    // Owner mutation acquires the empty queue inside its own trace, then holds
    // it open by blocking inside its callback.
    const ownerPromise = runWithTrace({ traceId: "owner-trace" }, () =>
      queue.withWriteQueue("owner-op", async () => {
        await ownerBlocker;
      }),
    );

    // Let the owner acquire and record itself as the current holder.
    await tick();

    // A second mutation enqueues while the owner still holds the queue, in a
    // distinct trace — this is the request that will suffer the wait.
    const waiterPromise = runWithTrace({ traceId: "waiter-trace" }, () =>
      queue.withWriteQueue("waiter-op", async () => {}),
    );

    // Let the waiter enqueue and block on the owner's gate.
    await tick();
    releaseOwner();
    await Promise.all([ownerPromise, waiterPromise]);

    const events = timingEvents();
    const owner = events.find((entry) => entry["label"] === "owner-op");
    const waiter = events.find((entry) => entry["label"] === "waiter-op");
    expect(owner).toBeDefined();
    expect(waiter).toBeDefined();

    // The owner ran first on an idle queue — attributed to no one.
    expect(owner!["traceId"]).toBe("owner-trace");
    expect(owner!["blockedByLabel"]).toBeUndefined();
    expect(owner!["blockedByTraceId"]).toBeUndefined();

    // The waiter carries its own ambient traceId (names the victim) AND the
    // owner metadata (names the culprit).
    expect(waiter!["traceId"]).toBe("waiter-trace");
    expect(waiter!["blockedByLabel"]).toBe("owner-op");
    expect(waiter!["blockedByTraceId"]).toBe("owner-trace");
  });

  it("never leaves a wait unattributed when it enqueues as the holder's callback settles", async () => {
    const queue = createWriteQueue();

    let releaseOwner!: () => void;
    const ownerBlocker = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });

    // A holds the queue and blocks; B is queued behind A (immediate callback).
    const ownerPromise = runWithTrace({ traceId: "owner-trace" }, () =>
      queue.withWriteQueue("owner-op", async () => {
        await ownerBlocker;
      }),
    );
    await tick();
    const successorPromise = runWithTrace({ traceId: "successor-trace" }, () =>
      queue.withWriteQueue("successor-op", async () => {}),
    );

    // C attaches to the SAME promise the owner awaits, so its enqueue fires the
    // microtask after A's callback resolves — but BEFORE A's `finally` releases
    // the gate and hands off. A is therefore still the un-released holder at C's
    // enqueue, so C must name A. This is the ordering that previously produced a
    // null owner (attempt 1): the guarantee under test is that a wait arriving as
    // the holder's callback settles is still attributed to a real in-flight
    // holder, never left blank.
    const laterPromise = ownerBlocker.then(() =>
      runWithTrace({ traceId: "later-trace" }, () =>
        queue.withWriteQueue("later-op", async () => {}),
      ),
    );

    releaseOwner();
    await Promise.all([ownerPromise, successorPromise, laterPromise]);

    const later = timingEvents().find((entry) => entry["label"] === "later-op");
    expect(later).toBeDefined();
    expect(later!["traceId"]).toBe("later-trace");
    expect(later!["blockedByLabel"]).toBe("owner-op");
    expect(later!["blockedByTraceId"]).toBe("owner-trace");
  });

  it("advances the recorded holder to the successor after a handoff", async () => {
    const queue = createWriteQueue();

    let releaseA!: () => void;
    let releaseB!: () => void;
    const blockerA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const blockerB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });

    // A acquires and holds; B queues behind A and, once it acquires, also holds.
    const aPromise = runWithTrace({ traceId: "a-trace" }, () =>
      queue.withWriteQueue("a-op", async () => {
        await blockerA;
      }),
    );
    await tick();
    const bPromise = runWithTrace({ traceId: "b-trace" }, () =>
      queue.withWriteQueue("b-op", async () => {
        await blockerB;
      }),
    );
    await tick();

    // Hand off: A releases, B acquires and becomes the new holder.
    releaseA();
    await tick();

    // D enqueues while B holds — the recorded holder must have advanced from A to
    // B through the handoff, so D names B, not the departed A.
    const dPromise = runWithTrace({ traceId: "d-trace" }, () =>
      queue.withWriteQueue("d-op", async () => {}),
    );
    await tick();
    releaseB();
    await Promise.all([aPromise, bPromise, dPromise]);

    const d = timingEvents().find((entry) => entry["label"] === "d-op");
    expect(d).toBeDefined();
    expect(d!["traceId"]).toBe("d-trace");
    expect(d!["blockedByLabel"]).toBe("b-op");
    expect(d!["blockedByTraceId"]).toBe("b-trace");
  });

  it("attributes a deep-queue waiter to the current holder, not the waiter ahead of it", async () => {
    const queue = createWriteQueue();

    let releaseOwner!: () => void;
    const ownerBlocker = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });

    // A acquires the empty queue and holds it open.
    const ownerPromise = runWithTrace({ traceId: "owner-trace" }, () =>
      queue.withWriteQueue("owner-op", async () => {
        await ownerBlocker;
      }),
    );
    await tick();

    // B queues behind A while A still holds the queue.
    const firstWaiterPromise = runWithTrace(
      { traceId: "first-waiter-trace" },
      () => queue.withWriteQueue("first-waiter-op", async () => {}),
    );
    // C queues behind B — still while A holds. The mutation *holding* the queue
    // at C's enqueue time is A, not the waiter C sits directly behind (B). Deep
    // queues must attribute to the holder (Design 6.2 culprit attribution), so
    // naming B here (the tail) would misidentify the stall's cause.
    const secondWaiterPromise = runWithTrace(
      { traceId: "second-waiter-trace" },
      () => queue.withWriteQueue("second-waiter-op", async () => {}),
    );

    await tick();
    releaseOwner();
    await Promise.all([ownerPromise, firstWaiterPromise, secondWaiterPromise]);

    const events = timingEvents();
    const first = events.find((e) => e["label"] === "first-waiter-op");
    const second = events.find((e) => e["label"] === "second-waiter-op");
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    // Both waiters were blocked by the same holder — A.
    expect(first!["traceId"]).toBe("first-waiter-trace");
    expect(first!["blockedByLabel"]).toBe("owner-op");
    expect(first!["blockedByTraceId"]).toBe("owner-trace");

    expect(second!["traceId"]).toBe("second-waiter-trace");
    expect(second!["blockedByLabel"]).toBe("owner-op");
    expect(second!["blockedByTraceId"]).toBe("owner-trace");
  });

  it("attributes a wait caused by an in-flight tryWithWriteQueue holder", async () => {
    const queue = createWriteQueue();

    let releaseTry!: () => void;
    const tryBlocker = new Promise<void>((resolve) => {
      releaseTry = resolve;
    });

    const tryPromise = runWithTrace({ traceId: "try-trace" }, () =>
      queue.tryWithWriteQueue("try-op", async () => {
        await tryBlocker;
        return "ok";
      }),
    );

    await tick();

    const waiterPromise = runWithTrace({ traceId: "waiter-trace" }, () =>
      queue.withWriteQueue("waiter-op", async () => {}),
    );

    await tick();
    releaseTry();
    await Promise.all([tryPromise, waiterPromise]);

    const waiter = timingEvents().find(
      (entry) => entry["label"] === "waiter-op",
    );
    expect(waiter).toBeDefined();
    expect(waiter!["traceId"]).toBe("waiter-trace");
    expect(waiter!["blockedByLabel"]).toBe("try-op");
    expect(waiter!["blockedByTraceId"]).toBe("try-trace");
  });
});
