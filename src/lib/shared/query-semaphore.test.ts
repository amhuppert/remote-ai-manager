import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { deleteGlobalValue } from "./global-singleton";

const GLOBAL_KEY = "__cc_query_semaphore";

import {
  setQuerySemaphoreDeps,
  resetQuerySemaphoreDeps,
} from "./query-semaphore";

beforeEach(() => {
  setQuerySemaphoreDeps({
    readConfig: async () => ({ maxConcurrentQueries: 2 }),
  });
  deleteGlobalValue(GLOBAL_KEY);
});

afterEach(() => {
  resetQuerySemaphoreDeps();
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
    it("removes a cancelled waiter without dispatching it when capacity opens", async () => {
      const { acquireQuerySlot, getQuerySemaphoreStatus } =
        await import("./query-semaphore");
      const releaseA = await acquireQuerySlot("incumbent:A");
      const releaseB = await acquireQuerySlot("incumbent:B");
      const controller = new AbortController();
      let dispatched = false;
      const waiting = acquireQuerySlot("cancelled", {
        signal: controller.signal,
      }).then(
        (release) => {
          dispatched = true;
          release();
          return null;
        },
        (error: unknown) => error,
      );
      await flushMicrotasks();
      expect(getQuerySemaphoreStatus().waiting).toBe(1);
      controller.abort();
      await flushMicrotasks();
      const statusAfterAbort = getQuerySemaphoreStatus();
      releaseA();
      releaseB();
      const result = await waiting;
      expect(statusAfterAbort.waiting).toBe(0);
      expect(dispatched).toBe(false);
      expect(result).toMatchObject({ name: "AbortError" });
      expect(getQuerySemaphoreStatus().active).toBe(0);
    });

    it("does not take capacity for an already cancelled request", async () => {
      const { acquireQuerySlot, getQuerySemaphoreStatus } =
        await import("./query-semaphore");
      const controller = new AbortController();
      controller.abort();
      const result = await acquireQuerySlot("cancelled", {
        signal: controller.signal,
      }).then(
        (release) => {
          release();
          return null;
        },
        (error: unknown) => error,
      );
      expect(result).toMatchObject({ name: "AbortError" });
      expect(getQuerySemaphoreStatus()).toMatchObject({
        active: 0,
        waiting: 0,
      });
    });

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

      const { acquireQuerySlot, QuerySlotAdmissionTimeoutError } =
        await import("./query-semaphore");

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

it("does not grant capacity after cancellation during configuration refresh", async () => {
  const { acquireQuerySlot, getQuerySemaphoreStatus } =
    await import("./query-semaphore");
  let finish!: (config: { maxConcurrentQueries: number }) => void;
  setQuerySemaphoreDeps({
    readConfig: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const controller = new AbortController();
  const pending = acquireQuerySlot("config-cancel", {
    signal: controller.signal,
  }).then(
    (release) => {
      release();
      return null;
    },
    (error: unknown) => error,
  );
  controller.abort();
  finish({ maxConcurrentQueries: 1 });
  expect(await pending).toMatchObject({ name: "AbortError" });
  expect(getQuerySemaphoreStatus()).toMatchObject({ active: 0, waiting: 0 });
});

it("returns a simultaneously cancelled grant and advances the next FIFO waiter once", async () => {
  const { acquireQuerySlot, getQuerySemaphoreStatus } =
    await import("./query-semaphore");
  setQuerySemaphoreDeps({
    readConfig: async () => ({ maxConcurrentQueries: 1 }),
  });
  const release = await acquireQuerySlot("incumbent");
  const controller = new AbortController();
  const cancelled = acquireQuerySlot("cancel-at-grant", {
    signal: controller.signal,
  }).then(
    (releaseSlot) => {
      releaseSlot();
      return null;
    },
    (error: unknown) => error,
  );
  const next = acquireQuerySlot("next");
  await flushMicrotasks();
  expect(getQuerySemaphoreStatus().waiting).toBe(2);
  release();
  controller.abort();
  expect(await cancelled).toMatchObject({ name: "AbortError" });
  const releaseNext = await next;
  expect(getQuerySemaphoreStatus()).toMatchObject({ active: 1, waiting: 0 });
  releaseNext();
  releaseNext();
  expect(getQuerySemaphoreStatus().active).toBe(0);
});
