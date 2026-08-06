import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { deleteGlobalValue } from "./global-singleton";

const GLOBAL_KEY = "__cc_query_semaphore";

// Mock readConfig to control the concurrency limit
vi.mock("../config/loader", () => ({
  readConfig: vi.fn().mockResolvedValue({ maxConcurrentQueries: 2 }),
}));

beforeEach(() => {
  deleteGlobalValue(GLOBAL_KEY);
});

afterEach(() => {
  deleteGlobalValue(GLOBAL_KEY);
  vi.useRealTimers();
});

/** Flush pending microtasks to let async semaphore internals settle */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe("query-semaphore", () => {
  describe("acquireQuerySlot", () => {
    it("acquires a slot and returns a release function", async () => {
      const { acquireQuerySlot } = await import("./query-semaphore");
      const release = await acquireQuerySlot("test:1");
      expect(typeof release).toBe("function");
      release();
    });

    it("allows up to the limit of concurrent slots", async () => {
      const { acquireQuerySlot, getQuerySemaphoreStatus } =
        await import("./query-semaphore");

      const release1 = await acquireQuerySlot("test:1");
      const release2 = await acquireQuerySlot("test:2");

      const status = getQuerySemaphoreStatus();
      expect(status.active).toBe(2);
      expect(status.waiting).toBe(0);

      release1();
      release2();
    });

    it("queues when at capacity and unblocks on release", async () => {
      const { acquireQuerySlot, getQuerySemaphoreStatus } =
        await import("./query-semaphore");

      const release1 = await acquireQuerySlot("test:1");
      const release2 = await acquireQuerySlot("test:2");

      // Third acquire should be queued
      let release3: (() => void) | undefined;
      const thirdPromise = acquireQuerySlot("test:3").then((r) => {
        release3 = r;
      });

      // Let async internals settle (refreshLimit await, enqueue)
      await flushMicrotasks();

      expect(release3).toBeUndefined(); // still queued
      expect(getQuerySemaphoreStatus().waiting).toBe(1);

      // Release a slot to unblock the third
      release1();
      await thirdPromise;

      expect(release3).toBeDefined();
      expect(getQuerySemaphoreStatus().active).toBe(2);

      release2();
      release3!();
    });

    it("maintains FIFO ordering for queued waiters", async () => {
      const { acquireQuerySlot } = await import("./query-semaphore");

      const release1 = await acquireQuerySlot("test:1");
      const release2 = await acquireQuerySlot("test:2");

      const order: string[] = [];

      const promiseA = acquireQuerySlot("test:A").then((release) => {
        order.push("A");
        return release;
      });
      const promiseB = acquireQuerySlot("test:B").then((release) => {
        order.push("B");
        return release;
      });

      await flushMicrotasks();

      // Release one slot — first waiter (A) should be unblocked
      release1();
      const releaseA = await promiseA;

      // Release A's slot to unblock B
      releaseA();
      const releaseB = await promiseB;
      releaseB();
      release2();

      expect(order).toEqual(["A", "B"]);
    });

    it("rejects with timeout when waiting too long", async () => {
      vi.useFakeTimers();

      const { acquireQuerySlot } = await import("./query-semaphore");

      await acquireQuerySlot("test:1");
      await acquireQuerySlot("test:2");

      // Attach catch handler immediately to prevent unhandled rejection
      let error: Error | undefined;
      const thirdPromise = acquireQuerySlot("test:3").catch((e: Error) => {
        error = e;
      });

      // Advance past the 5-minute timeout
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
      await thirdPromise;

      expect(error).toBeDefined();
      expect(error!.message).toContain("Query semaphore timeout");
    });

    it("rejects admission timeouts with a typed error a caller can classify", async () => {
      vi.useFakeTimers();

      const {
        acquireQuerySlot,
        QuerySlotAdmissionTimeoutError,
        isQuerySlotAdmissionTimeout,
      } = await import("./query-semaphore");

      await acquireQuerySlot("test:1");
      await acquireQuerySlot("test:2");

      let error: unknown;
      const thirdPromise = acquireQuerySlot("test:3").catch((e: unknown) => {
        error = e;
      });

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
      await thirdPromise;

      // Never admitted, so nothing about the callee failed: the caller has to be
      // able to tell queue pressure apart from a run that started and broke.
      expect(error).toBeInstanceOf(QuerySlotAdmissionTimeoutError);
      expect(isQuerySlotAdmissionTimeout(error)).toBe(true);
    });

    it("carries the classification in the message, for callers that only see text", async () => {
      vi.useFakeTimers();

      const { acquireQuerySlot, isQuerySlotAdmissionTimeout } =
        await import("./query-semaphore");

      await acquireQuerySlot("test:1");
      await acquireQuerySlot("test:2");

      let message = "";
      const thirdPromise = acquireQuerySlot("test:3").catch((e: Error) => {
        message = e.message;
      });

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
      await thirdPromise;

      // The error crosses boundaries that keep only the text — a task run
      // surfaces its failure as a string — so the marker has to survive there
      // too or the classification is lost exactly where it is needed.
      expect(isQuerySlotAdmissionTimeout(message)).toBe(true);
    });

    it("does not classify an unrelated failure as queue pressure", async () => {
      const { isQuerySlotAdmissionTimeout } = await import("./query-semaphore");

      expect(isQuerySlotAdmissionTimeout(new Error("provider 500"))).toBe(
        false,
      );
      expect(isQuerySlotAdmissionTimeout("model overloaded")).toBe(false);
      expect(isQuerySlotAdmissionTimeout(null)).toBe(false);
      expect(isQuerySlotAdmissionTimeout(undefined)).toBe(false);
    });

    it("idempotent release — double release is safe", async () => {
      const { acquireQuerySlot, getQuerySemaphoreStatus } =
        await import("./query-semaphore");

      const release = await acquireQuerySlot("test:1");
      expect(getQuerySemaphoreStatus().active).toBe(1);

      release();
      expect(getQuerySemaphoreStatus().active).toBe(0);

      // Second release should be no-op (not go negative)
      release();
      expect(getQuerySemaphoreStatus().active).toBe(0);
    });

    it("removes timed-out waiter from queue", async () => {
      vi.useFakeTimers();

      const { acquireQuerySlot, getQuerySemaphoreStatus } =
        await import("./query-semaphore");

      await acquireQuerySlot("test:1");
      await acquireQuerySlot("test:2");

      // Attach catch handler immediately to prevent unhandled rejection
      let error: Error | undefined;
      const thirdPromise = acquireQuerySlot("test:3").catch((e: Error) => {
        error = e;
      });

      // Let async internals settle
      await vi.advanceTimersByTimeAsync(0);
      expect(getQuerySemaphoreStatus().waiting).toBe(1);

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
      await thirdPromise;

      expect(error).toBeDefined();
      expect(getQuerySemaphoreStatus().waiting).toBe(0);
    });
  });

  describe("getQuerySemaphoreStatus", () => {
    it("returns initial state", async () => {
      const { getQuerySemaphoreStatus } = await import("./query-semaphore");
      const status = getQuerySemaphoreStatus();

      expect(status.active).toBe(0);
      expect(status.waiting).toBe(0);
      expect(status.limit).toBe(2);
    });

    it("reflects active count after acquire and release", async () => {
      const { acquireQuerySlot, getQuerySemaphoreStatus } =
        await import("./query-semaphore");

      const release = await acquireQuerySlot("test:1");
      expect(getQuerySemaphoreStatus().active).toBe(1);

      release();
      expect(getQuerySemaphoreStatus().active).toBe(0);
    });
  });
});
