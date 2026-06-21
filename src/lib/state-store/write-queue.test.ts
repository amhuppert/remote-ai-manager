import { describe, it, expect, vi, beforeEach } from "vitest";

const { loggerInfo, loggerDebug, loggerWarn, loggerError } = vi.hoisted(() => ({
  loggerInfo: vi.fn(),
  loggerDebug: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: loggerInfo,
    debug: loggerDebug,
    warn: loggerWarn,
    error: loggerError,
  }),
}));

import {
  createWriteQueue,
  withWriteQueue,
  _resetForTesting,
} from "./write-queue";

beforeEach(() => {
  loggerInfo.mockClear();
  loggerDebug.mockClear();
  loggerWarn.mockClear();
  loggerError.mockClear();
  _resetForTesting();
});

describe("createWriteQueue", () => {
  it("runs concurrently-fired callbacks in arrival order", async () => {
    const queue = createWriteQueue();
    const order: number[] = [];

    const promises = [1, 2, 3, 4, 5].map((n) =>
      queue.withWriteQueue(`op-${n}`, async () => {
        await new Promise((r) => setTimeout(r, Math.random() * 5));
        order.push(n);
      }),
    );

    await Promise.all(promises);
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });

  it("propagates rejection without blocking subsequent ticks", async () => {
    const queue = createWriteQueue();

    await expect(
      queue.withWriteQueue("fail", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const result = await queue.withWriteQueue("after-fail", async () => "ok");
    expect(result).toBe("ok");
  });

  it("returns the value the callback resolves with", async () => {
    const queue = createWriteQueue();
    const result = await queue.withWriteQueue("returns", async () => 42);
    expect(result).toBe(42);
  });

  it("emits state-store.write_queue.timing with waitMs ≈ 0 on first tick and > 0 on second", async () => {
    const queue = createWriteQueue();

    await Promise.all([
      queue.withWriteQueue("first", async () => {
        await new Promise((r) => setTimeout(r, 25));
      }),
      queue.withWriteQueue("second", async () => {
        // immediate
      }),
    ]);

    const events = loggerInfo.mock.calls.filter(
      ([name]) => name === "state-store.write_queue.timing",
    );
    expect(events.length).toBe(2);

    const firstPayload = events[0]![1] as {
      label: string;
      durationMs: number;
      waitMs: number;
      holdMs: number;
    };
    const secondPayload = events[1]![1] as {
      label: string;
      durationMs: number;
      waitMs: number;
      holdMs: number;
    };

    expect(firstPayload.label).toBe("first");
    expect(firstPayload.waitMs).toBeLessThan(5);
    expect(firstPayload.holdMs).toBeGreaterThanOrEqual(20);
    expect(firstPayload.durationMs).toBeCloseTo(
      firstPayload.waitMs + firstPayload.holdMs,
      1,
    );

    expect(secondPayload.label).toBe("second");
    expect(secondPayload.waitMs).toBeGreaterThanOrEqual(20);
    expect(secondPayload.durationMs).toBeCloseTo(
      secondPayload.waitMs + secondPayload.holdMs,
      1,
    );
  });

  it("isolates queues across factory instances", async () => {
    const queueA = createWriteQueue();
    const queueB = createWriteQueue();
    const order: string[] = [];

    const a = queueA.withWriteQueue("A-slow", async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("A");
    });
    const b = queueB.withWriteQueue("B-fast", async () => {
      order.push("B");
    });

    await Promise.all([a, b]);
    expect(order).toEqual(["B", "A"]);
  });
});

describe("module-level withWriteQueue", () => {
  it("serializes calls through the shared singleton", async () => {
    const order: number[] = [];

    const promises = [1, 2, 3].map((n) =>
      withWriteQueue(`shared-${n}`, async () => {
        await new Promise((r) => setTimeout(r, Math.random() * 3));
        order.push(n);
      }),
    );

    await Promise.all(promises);
    expect(order).toEqual([1, 2, 3]);
  });
});
