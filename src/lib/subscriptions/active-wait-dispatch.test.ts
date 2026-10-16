import { describe, expect, it } from "vitest";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import {
  createActiveWaitDispatcher,
  decideWakeDispatch,
  type ActiveWaitDispatcherDeps,
} from "./active-wait-dispatch";
import {
  subscriptionWakeBatchSchema,
  type SubscriptionWakeBatch,
} from "./active-wait-schemas";

describe("active wait queue handoff", () => {
  it("distinguishes an unattempted reservation from a lost queue receipt", () => {
    const missing = {
      recipientEligible: true,
      accepted: false,
      queueStatus: null,
    };
    expect(decideWakeDispatch("planned", missing)).toBe("enqueue");
    expect(decideWakeDispatch("queued", missing)).toBe("uncertain");
    expect(decideWakeDispatch("failed", missing)).toBe("uncertain");
  });

  it("releases an uncertain wake of follow facts only that never reached the queue, and keeps a wait's for review", () => {
    const missing = {
      recipientEligible: true,
      accepted: false,
      queueStatus: null,
    };
    expect(decideWakeDispatch("uncertain", missing, { followOnly: true })).toBe(
      "release",
    );
    expect(
      decideWakeDispatch("uncertain", missing, { followOnly: false }),
    ).toBe("uncertain");
    expect(
      decideWakeDispatch(
        "uncertain",
        { ...missing, queueStatus: "uncertain" },
        { followOnly: true },
      ),
    ).toBe("uncertain");
    expect(decideWakeDispatch("queued", missing, { followOnly: true })).toBe(
      "uncertain",
    );
  });

  it("repairs acceptance after a crash without replaying input or equating source completion with action", () => {
    expect(
      decideWakeDispatch("queued", {
        recipientEligible: true,
        accepted: true,
        queueStatus: null,
      }),
    ).toBe("accepted");
    expect(
      decideWakeDispatch("uncertain", {
        recipientEligible: false,
        accepted: true,
        queueStatus: "uncertain",
      }),
    ).toBe("accepted");
  });

  it("leaves held recipients and in-flight input alone, while recognizing a reviewed retry", () => {
    expect(
      decideWakeDispatch("planned", {
        recipientEligible: false,
        accepted: false,
        queueStatus: null,
      }),
    ).toBe("hold");
    expect(
      decideWakeDispatch("queued", {
        recipientEligible: true,
        accepted: false,
        queueStatus: "delivering",
      }),
    ).toBe("hold");
    expect(
      decideWakeDispatch("uncertain", {
        recipientEligible: true,
        accepted: false,
        queueStatus: "pending",
      }),
    ).toBe("drain");
  });

  it("retains failed and uncertain input for explicit review and honors discards", () => {
    for (const queueStatus of ["failed", "uncertain", "cancelled"] as const)
      expect(
        decideWakeDispatch("queued", {
          recipientEligible: true,
          accepted: false,
          queueStatus,
        }),
      ).toBe(queueStatus);
    expect(
      decideWakeDispatch("accepted", {
        recipientEligible: true,
        accepted: false,
        queueStatus: null,
      }),
    ).toBe("hold");
    expect(
      decideWakeDispatch("cancelled", {
        recipientEligible: true,
        accepted: false,
        queueStatus: null,
      }),
    ).toBe("hold");
  });
});

function dispatchHarness(drain: ActiveWaitDispatcherDeps["drain"]) {
  const batches: SubscriptionWakeBatch[] = [];
  const delivered = new Set<string>();
  const logger = createCapturingLogger();
  const dispatcher = createActiveWaitDispatcher({
    logger,
    service: {
      async reconcile() {},
      async listPendingBatches() {
        return batches.filter((batch) => batch.state !== "accepted");
      },
      async listRecipients() {
        return [];
      },
      async prepareBatch() {
        return null;
      },
      async markBatchQueued(id) {
        const batch = batches.find((candidate) => candidate.id === id);
        if (batch) batch.state = "queued";
      },
      async releaseUnsentBatch() {},
      async settleBatch(id, state) {
        const batch = batches.find((candidate) => candidate.id === id);
        if (batch) batch.state = state;
      },
    },
    async observe(batch) {
      return {
        recipientEligible: true,
        accepted: delivered.has(batch.id),
        queueStatus: "pending",
      };
    },
    async enqueue() {},
    async drain(batch, signal) {
      await drain(batch, signal);
      delivered.add(batch.id);
    },
    async confirmAccepted() {},
  });
  return {
    dispatcher,
    logger,
    add(id: string, conversationId = id) {
      batches.push(
        subscriptionWakeBatchSchema.parse({
          id,
          recipient: { projectPath: "/repo", conversationId },
          waitIds: [],
          deliveryIds: [],
          state: "queued",
          queueMessageId: id,
          message: `Wake ${id}`,
          causationBatchIds: [],
          createdAt: "2026-10-15T12:00:00.000Z",
          updatedAt: "2026-10-15T12:00:00.000Z",
          finishedAt: null,
          lastError: null,
        }),
      );
    },
  };
}

describe("active wake dispatch while a provider acknowledges input", () => {
  it("continues other recipients and later ticks without dispatching the waiting recipient twice", async () => {
    const acceptance = Promise.withResolvers<void>();
    const sent: string[] = [];
    const h = dispatchHarness(async (batch) => {
      sent.push(batch.id);
      if (batch.id === "a") await acceptance.promise;
    });
    h.add("a");
    h.add("b");
    let tickFinished = false;
    const firstTick = h.dispatcher.tick().then(() => {
      tickFinished = true;
    });
    try {
      await expect.poll(() => sent).toEqual(["a", "b"]);
      await expect.poll(() => tickFinished).toBe(true);
      h.add("a-second", "a");
      h.add("c");
      await h.dispatcher.tick();
      expect(sent).toEqual(["a", "b", "c"]);
    } finally {
      acceptance.resolve();
      await firstTick;
      await h.dispatcher.stop();
    }
  });

  it("stops before provider acknowledgement and aborts further delivery nudges", async () => {
    const acceptance = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const signals: AbortSignal[] = [];
    const nudged: string[] = [];
    const h = dispatchHarness(async (batch, signal) => {
      signals.push(signal);
      started.resolve();
      await acceptance.promise;
      if (!signal?.aborted) nudged.push(batch.id);
    });
    h.add("a");
    const tick = h.dispatcher.tick();
    await started.promise;
    let stopped = false;
    const stop = h.dispatcher.stop().then(() => {
      stopped = true;
    });
    try {
      await expect.poll(() => stopped).toBe(true);
      expect(signals[0]?.aborted).toBe(true);
      h.add("b");
      await h.dispatcher.tick();
      expect(signals).toHaveLength(1);
    } finally {
      acceptance.resolve();
      await Promise.all([tick, stop]);
    }
    expect(nudged).toEqual([]);
  });

  it("records a failed drain and lets a later tick retry its recipient", async () => {
    let attempts = 0;
    const h = dispatchHarness(async () => {
      attempts++;
      if (attempts === 1) throw new Error("provider unavailable");
    });
    h.add("a");
    await h.dispatcher.tick();
    await expect
      .poll(() => h.logger.entries)
      .toContainEqual({
        level: "error",
        message: "subscription.wake_dispatch_failed",
        fields: {
          conversationId: "a",
          batchId: "a",
          error: "provider unavailable",
        },
      });
    await h.dispatcher.tick();
    expect(attempts).toBe(2);
    await h.dispatcher.stop();
  });
});
