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
  withWriteQueueSync,
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

  it("lets best-effort callers detect contention without waiting", async () => {
    const queue = createWriteQueue();
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = queue.withWriteQueue("holding", async () => blocker);

    await expect(
      queue.tryWithWriteQueue("best-effort", async () => "not-run"),
    ).resolves.toEqual({ acquired: false });

    release();
    await holding;
    await expect(
      queue.tryWithWriteQueue("best-effort", async () => "ingested"),
    ).resolves.toEqual({ acquired: true, value: "ingested" });
  });

  it("runs a synchronous callback through the queue and returns its value", async () => {
    const queue = createWriteQueue();
    const result = await queue.withWriteQueueSync("sync-returns", () => 42);
    expect(result).toBe(42);
  });

  it("serializes withWriteQueueSync behind an in-flight withWriteQueue", async () => {
    const queue = createWriteQueue();
    const order: string[] = [];

    let releaseAsync!: () => void;
    const asyncBlocker = new Promise<void>((resolve) => {
      releaseAsync = resolve;
    });

    const asyncPromise = queue.withWriteQueue("async-op", async () => {
      order.push("async:start");
      await asyncBlocker;
      order.push("async:end");
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["async:start"]);

    // The sync entry runs inside the same FIFO chain, so it must wait for the
    // in-flight async write even though its own callback never awaits.
    const syncPromise = queue.withWriteQueueSync("sync-op", () => {
      order.push("sync:run");
      return "done";
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["async:start"]);

    releaseAsync();
    const [, syncResult] = await Promise.all([asyncPromise, syncPromise]);
    expect(syncResult).toBe("done");
    expect(order).toEqual(["async:start", "async:end", "sync:run"]);
  });

  it("rejects async and Promise-returning callbacks at compile time", async () => {
    const queue = createWriteQueue();

    // A synchronous callback compiles and runs.
    await expect(queue.withWriteQueueSync("sync-ok", () => 1)).resolves.toBe(1);

    // The calls below are the point of the sync entry (Design 3.3): a callback
    // that returns a Promise must NOT typecheck, so "await external work while
    // holding the global lock" is unrepresentable. They are checked by
    // `bun run typecheck` and never executed at runtime.
    const unreachable = false as boolean;
    if (unreachable) {
      // @ts-expect-error async callback is forbidden — its Promise return trips the guard
      void queue.withWriteQueueSync("async-method", async () => 1);
      // @ts-expect-error a non-async callback that returns a Promise is forbidden too
      void queue.withWriteQueueSync("promise-return", () => Promise.resolve(1));
      // @ts-expect-error the module-level entry rejects async callbacks as well
      void withWriteQueueSync("async-module", async () => 1);
      // A union with even ONE Promise constituent must be rejected — otherwise a
      // callback like `() => cond ? 1 : externalWork()` would typecheck and the
      // queue would await the Promise branch while holding the lock. The guard
      // must reject on ANY PromiseLike member, not only when the whole return
      // type is a Promise.
      // @ts-expect-error a mixed sync/Promise union return is forbidden
      void queue.withWriteQueueSync(
        "mixed-union",
        (): number | Promise<number> => (unreachable ? 1 : Promise.resolve(1)),
      );
      // @ts-expect-error the module-level entry rejects mixed unions as well
      void withWriteQueueSync(
        "mixed-union-module",
        (): string | Promise<string> =>
          unreachable ? "a" : Promise.resolve("b"),
      );
    }
    expect(unreachable).toBe(false);
  });

  it("releases the queue in the same continuation the sync callback returns in", async () => {
    const queue = createWriteQueue();
    let probeAcquired: boolean | undefined;

    await queue.withWriteQueueSync("sync-op", () => {
      // A microtask scheduled the instant this synchronous callback returns. A
      // correct sync path releases the queue synchronously in THIS continuation,
      // so by the time the probe runs the queue is already free (acquired:true).
      // An `await fn()` path defers release to a later microtask, so this probe
      // would observe the queue still held — meaning unrelated microtask work can
      // interleave and be charged to the sync critical section
      // (no-slow-work-in-critical-section). `tryWithWriteQueue` is the same
      // contention observation the queue exposes in production.
      void Promise.resolve().then(async () => {
        const result = await queue.tryWithWriteQueue("probe", async () => "ok");
        probeAcquired = result.acquired;
      });
      return "done";
    });

    // Drain the probe's microtask chain.
    await new Promise((r) => setTimeout(r, 0));
    expect(probeAcquired).toBe(true);
  });

  it("propagates a synchronous throw from withWriteQueueSync without poisoning the chain", async () => {
    const queue = createWriteQueue();

    await expect(
      queue.withWriteQueueSync("sync-throws", () => {
        throw new Error("sync-boom");
      }),
    ).rejects.toThrow("sync-boom");

    const after = await queue.withWriteQueueSync("after-sync", () => "ok");
    expect(after).toBe("ok");
  });

  it("logs write_queue.hold_budget_exceeded when a callback holds past the budget", async () => {
    let clock = 0;
    const queue = createWriteQueue({ holdBudgetMs: 500, now: () => clock });

    await queue.withWriteQueueSync("slow-op", () => {
      // Simulate 600ms of hold time against the injected clock without waiting.
      clock = 600;
    });

    const violations = loggerError.mock.calls.filter(
      ([name]) => name === "state-store.write_queue.hold_budget_exceeded",
    );
    expect(violations).toHaveLength(1);
    const payload = violations[0]![1] as {
      label: string;
      holdMs: number;
      budgetMs: number;
      stack: unknown;
    };
    expect(payload.label).toBe("slow-op");
    expect(payload.holdMs).toBe(600);
    expect(payload.budgetMs).toBe(500);
    expect(typeof payload.stack).toBe("string");
  });

  it("does not log hold_budget_exceeded when the hold stays within budget", async () => {
    let clock = 0;
    const queue = createWriteQueue({ holdBudgetMs: 500, now: () => clock });

    const result = await queue.withWriteQueueSync("fast-op", () => {
      clock = 100;
      return "value";
    });

    expect(result).toBe("value");
    const violations = loggerError.mock.calls.filter(
      ([name]) => name === "state-store.write_queue.hold_budget_exceeded",
    );
    expect(violations).toHaveLength(0);
  });

  it("records the budget violation as telemetry without aborting the write", async () => {
    let clock = 0;
    const queue = createWriteQueue({ holdBudgetMs: 500, now: () => clock });

    const result = await queue.withWriteQueue("slow-but-ok", async () => {
      clock = 900;
      return "committed";
    });

    // The write still resolves normally — the budget is a loud invariant, not a
    // kill switch.
    expect(result).toBe("committed");
    expect(
      loggerError.mock.calls.filter(
        ([name]) => name === "state-store.write_queue.hold_budget_exceeded",
      ),
    ).toHaveLength(1);
  });

  it("holds the queue tail while a tryWithWriteQueue callback is in flight", async () => {
    const queue = createWriteQueue();
    const events: string[] = [];

    let releaseTry!: () => void;
    const tryBlocker = new Promise<void>((resolve) => {
      releaseTry = resolve;
    });

    // A best-effort write acquires the empty queue and blocks inside its callback.
    const tryPromise = queue.tryWithWriteQueue("try-op", async () => {
      events.push("try:start");
      await tryBlocker;
      events.push("try:end");
      return "try-value";
    });

    // Let the try-write acquire and begin executing its callback.
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toEqual(["try:start"]);

    // A normal queued write arrives while the try callback is still running.
    const queuedPromise = queue.withWriteQueue("queued-op", async () => {
      events.push("queued:start");
      return "queued-value";
    });

    // Give the queued callback ample opportunity to (incorrectly) run
    // concurrently. Against the pre-fix implementation tryWithWriteQueue never
    // reserved `tail`, so this call chained onto the already-resolved tail and
    // ran a second writer immediately — pushing "queued:start" here.
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toEqual(["try:start"]);

    // Only once the try-write settles may the queued write proceed.
    releaseTry();
    const [tryResult, queuedResult] = await Promise.all([
      tryPromise,
      queuedPromise,
    ]);

    expect(tryResult).toEqual({ acquired: true, value: "try-value" });
    expect(queuedResult).toBe("queued-value");
    expect(events).toEqual(["try:start", "try:end", "queued:start"]);
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

  it("exposes a synchronous entry point on the shared singleton", async () => {
    const result = await withWriteQueueSync("shared-sync", () => "ok");
    expect(result).toBe("ok");
  });
});
