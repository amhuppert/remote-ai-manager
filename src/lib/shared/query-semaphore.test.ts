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
