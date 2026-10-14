import { afterEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createConversationSubscriptionWaitsRepo } from "@/lib/state-store/conversation-subscription-waits-repo";
import { createConversationSubscriptionsRepo } from "@/lib/state-store/conversation-subscriptions-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import type {
  TerminalSourceRead,
  SubscriptionWakeBatch,
} from "./active-wait-schemas";
import { createActiveWaitService } from "./active-wait-service";

let fixture: PersistenceFixture | undefined;
afterEach(() => fixture?.close());
const recipient = { projectPath: "/project", conversationId: "conversation" };
const terminal: TerminalSourceRead = {
  kind: "terminal",
  fact: {
    occurrenceId: "one-time-terminal:validation:run",
    eventKind: "validation-completed",
    category: "outcome",
    sourceTitle: "Tests",
    summary: "Tests passed",
    occurredAt: "2026-09-30T12:00:00.000Z",
    revision: null,
    outcome: "passed",
    retrievalHandle: "cctl validate status run",
    actorConversationId: "conversation",
  },
};
function harness() {
  fixture = createPersistenceFixture();
  const db = fixture.db;
  let state: TerminalSourceRead = terminal;
  let eligible = true;
  let sourceError: Error | null = null;
  let occurrenceId: string | null = null;
  let at = "2026-09-30T12:00:00.000Z";
  let nextId = 0;
  let brokenDeliveryId: string | null = null;
  let failureWriteBroken = false;
  let sourceCursor = "0";
  let discardProof = async (_batch: SubscriptionWakeBatch) => false;
  const build = () =>
    createActiveWaitService({
      repo: {
        ...createConversationSubscriptionWaitsRepo(db, createWriteQueue()),
        async recordFailure(...args) {
          if (failureWriteBroken) throw Error("Failed wait error write");
          return createConversationSubscriptionWaitsRepo(
            db,
            createWriteQueue(),
          ).recordFailure(...args);
        },
      },
      subscriptions: {
        ...createConversationSubscriptionsRepo(db, createWriteQueue()),
        async getDelivery(target, id) {
          if (id === brokenDeliveryId) throw Error("Failed receipt read");
          return createConversationSubscriptionsRepo(
            db,
            createWriteQueue(),
          ).getDelivery(target, id);
        },
      },
      async isRecipientEligible() {
        return eligible;
      },
      canDiscardMissingBatch: (batch) => discardProof(batch),
      readSourceCursor: async () => sourceCursor,
      async readTerminalSource(_recipient, source) {
        if (sourceError) throw sourceError;
        return state.kind === "terminal"
          ? {
              ...state,
              fact: {
                ...state.fact,
                occurrenceId:
                  occurrenceId ??
                  `one-time-terminal:${source.kind}:${source.id}`,
              },
            }
          : state;
      },
      now: () => at,
      newId: () => `id-${++nextId}`,
    });
  return {
    build,
    getDelivery(id: string) {
      return createConversationSubscriptionsRepo(
        db,
        createWriteQueue(),
      ).getDelivery(recipient, id);
    },
    setSource(value: TerminalSourceRead) {
      state = value;
    },
    setOccurrenceId(value: string) {
      occurrenceId = value;
    },
    setSourceCursor(value: string) {
      sourceCursor = value;
    },
    breakReceiptRead(id: string) {
      brokenDeliveryId = id;
      failureWriteBroken = true;
    },
    setTime(value: string) {
      at = value;
    },
    setEligible(value: boolean) {
      eligible = value;
    },
    setSourceError(value: Error | null) {
      sourceError = value;
    },
    setDiscardProof(proof: (batch: SubscriptionWakeBatch) => Promise<boolean>) {
      discardProof = proof;
    },
  };
}
describe("explicit finite terminal waits", () => {
  it.each(["completed", "aborted", "halted"] as const)(
    "refuses a consumed final %s workflow when the source classifier says it cannot resume",
    async (outcome) => {
      const h = harness();
      const service = h.build();
      h.setSource({
        ...terminal,
        resumable: false,
        fact: {
          ...terminal.fact,
          outcome,
          eventKind: "graph-workflow-terminal",
        },
      });
      const input = {
        recipient,
        source: { kind: "validation", id: "workflow" } as const,
        reason: "Continue",
      };
      await service.register(input);
      const batch = await service.prepareBatch(recipient);
      if (!batch) throw Error("Expected wake");
      await service.settleBatch(batch.id, "accepted");
      await expect(service.register(input)).rejects.toMatchObject({
        code: "ACTIVE_WAIT_SOURCE_FINAL",
      });
      expect(await service.list(recipient)).toHaveLength(1);
    },
  );
  it.each(["failed", "queued", "uncertain"] as const)(
    "reuses a prior %s terminal receipt without blindly replaying an unresolved input",
    async (state) => {
      const h = harness();
      const service = h.build();
      const input = {
        recipient,
        source: { kind: "validation", id: "run" } as const,
        reason: "Inspect",
      };
      const first = await service.register(input);
      if (!fixture || !first.deliveryId) throw Error("Expected receipt");
      const subscriptions = createConversationSubscriptionsRepo(
        fixture.db,
        createWriteQueue(),
      );
      const follow = await subscriptions.get(recipient, first.subscriptionId);
      if (!follow) throw Error("Expected follow");
      await subscriptions.updateControls(
        recipient,
        follow.id,
        { ...follow, mode: "passive" },
        first.createdAt,
      );
      await subscriptions.claim(
        recipient,
        [first.deliveryId],
        "prior-passive",
        first.createdAt,
      );
      if (state !== "queued")
        await subscriptions.settle(
          recipient,
          "prior-passive",
          state,
          first.createdAt,
          "Known receipt state",
        );
      await service.cancel(recipient, first.subscriptionId);
      const next = await service.register(input);
      expect(next).toMatchObject({
        state: "ready",
        deliveryId: first.deliveryId,
      });
      expect(await h.getDelivery(first.deliveryId)).toMatchObject({
        state: state === "failed" ? "pending" : state,
        acceptedAt: null,
      });
      expect(await service.prepareBatch(recipient)).toEqual(
        state === "failed" ? expect.any(Object) : null,
      );
    },
  );
  it.each(["validation", "git_job"] as const)(
    "does not treat an undelivered historical %s baseline as consumed",
    async (kind) => {
      const h = harness();
      const service = h.build();
      h.setSource({ kind: "pending", status: "running" });
      const first = await service.register({
        recipient,
        source: { kind, id: "run" },
        reason: "Inspect",
      });
      await service.cancel(recipient, first.subscriptionId);
      if (!fixture) throw Error("Expected fixture");
      const subscriptions = createConversationSubscriptionsRepo(
        fixture.db,
        createWriteQueue(),
      );
      const follow = await subscriptions.get(recipient, first.subscriptionId);
      if (!follow) throw Error("Expected follow");
      const waits = createConversationSubscriptionWaitsRepo(
        fixture.db,
        createWriteQueue(),
      );
      await waits.register(
        {
          ...first,
          id: "old-unreceived",
          baselineOccurrenceId: `one-time-terminal:${kind}:run`,
        },
        follow,
      );
      h.setSource({ ...terminal, resumable: true });
      h.setTime("2026-10-02T12:00:00.000Z");
      await service.reconcile(recipient);
      expect(await service.get(recipient, first.subscriptionId)).toMatchObject({
        id: "old-unreceived",
        state: "ready",
        outcome: "source_terminal",
      });
      const inbox = await subscriptions.readInbox(recipient, {
        includeSettled: true,
      });
      expect(inbox.items).toHaveLength(1);
      expect(inbox.items[0]).toMatchObject({
        state: "pending",
        fact: {
          occurrenceId: `one-time-terminal:${kind}:run`,
          outcome: "passed",
        },
      });
    },
  );
  it("settles an old inert final-source generation from positive existing proof instead of inventing expiry", async () => {
    const h = harness();
    const service = h.build();
    const first = await service.register({
      recipient,
      source: { kind: "validation", id: "run" },
      reason: "Inspect",
    });
    const batch = await service.prepareBatch(recipient);
    if (!batch || !fixture || !first.deliveryId)
      throw Error("Expected persisted wait");
    await service.settleBatch(batch.id, "accepted");
    const subscriptions = createConversationSubscriptionsRepo(
      fixture.db,
      createWriteQueue(),
    );
    const follow = await subscriptions.get(recipient, first.subscriptionId);
    if (!follow) throw Error("Expected follow");
    const old = await createConversationSubscriptionWaitsRepo(
      fixture.db,
      createWriteQueue(),
    ).register(
      {
        ...first,
        id: "old-inert",
        state: "waiting",
        outcome: null,
        deliveryId: null,
        batchId: null,
        baselineOccurrenceId: "one-time-terminal:validation:run",
        finishedAt: null,
      },
      follow,
    );
    await service.reconcile(recipient);
    expect(await service.get(recipient, old.subscriptionId)).toMatchObject({
      id: old.id,
      state: "settled",
      outcome: "source_terminal",
      deliveryId: first.deliveryId,
    });
    expect(
      (await subscriptions.readInbox(recipient, { includeSettled: true }))
        .items,
    ).toHaveLength(1);
  });
  it("fresh-baselines passive workflow awareness when explicitly rearming an unfollowed source", async () => {
    const h = harness();
    const service = h.build();
    h.setSource({ kind: "pending", status: "running" });
    const input = {
      recipient,
      source: { kind: "validation", id: "workflow" } as const,
      reason: "Continue",
    };
    const first = await service.register(input);
    await service.cancel(recipient, first.subscriptionId);
    if (!fixture) throw Error("Expected fixture");
    const subscriptions = createConversationSubscriptionsRepo(
      fixture.db,
      createWriteQueue(),
    );
    await subscriptions.unfollow(
      recipient,
      first.subscriptionId,
      first.createdAt,
    );
    h.setSourceCursor("9");
    await service.register(input);
    expect(
      await subscriptions.get(recipient, first.subscriptionId),
    ).toMatchObject({ cursor: "9", status: "following", mode: "active" });
  });
  it("retries a proven failed unbatched receipt and spends a dismissed receipt without a wake", async () => {
    const h = harness();
    const service = h.build();
    const wait = await service.register({
      recipient,
      source: { kind: "validation", id: "workflow" },
      reason: "Continue",
    });
    if (!fixture || !wait.deliveryId) throw Error("Expected receipt");
    const subscriptions = createConversationSubscriptionsRepo(
      fixture.db,
      createWriteQueue(),
    );
    const follow = await subscriptions.get(recipient, wait.subscriptionId);
    if (!follow) throw Error("Expected follow");
    await subscriptions.updateControls(
      recipient,
      follow.id,
      { ...follow, mode: "passive" },
      follow.updatedAt,
    );
    await subscriptions.claim(
      recipient,
      [wait.deliveryId],
      "failed-input",
      follow.createdAt,
    );
    await subscriptions.settle(
      recipient,
      "failed-input",
      "failed",
      follow.createdAt,
      "Input rejected before acceptance",
    );
    await subscriptions.updateControls(
      recipient,
      follow.id,
      follow,
      follow.updatedAt,
    );
    await service.reconcile(recipient);
    expect(await h.getDelivery(wait.deliveryId)).toMatchObject({
      state: "pending",
      acceptedAt: null,
    });
    await subscriptions.reviewDelivery(
      recipient,
      wait.deliveryId,
      "dismiss",
      follow.createdAt,
    );
    await service.reconcile(recipient);
    expect(await service.get(recipient, wait.subscriptionId)).toMatchObject({
      state: "settled",
    });
    expect(
      await subscriptions.get(recipient, wait.subscriptionId),
    ).toMatchObject({ mode: "passive", expiresAt: null, status: "following" });
    expect(await service.prepareBatch(recipient)).toBeNull();
  });
  it("continues other ready waits when one receipt read and its diagnostic write fail", async () => {
    const h = harness();
    const service = h.build();
    const broken = await service.register({
      recipient,
      source: { kind: "validation", id: "broken" },
      reason: "Continue",
    });
    const healthy = await service.register({
      recipient,
      source: { kind: "validation", id: "healthy" },
      reason: "Continue",
    });
    const ready = await service.register({
      recipient,
      source: { kind: "validation", id: "ready" },
      reason: "Continue",
    });
    if (!fixture || !broken.deliveryId || !healthy.deliveryId)
      throw Error("Expected receipts");
    await createConversationSubscriptionsRepo(
      fixture.db,
      createWriteQueue(),
    ).reviewDelivery(
      recipient,
      healthy.deliveryId,
      "dismiss",
      healthy.createdAt,
    );
    h.breakReceiptRead(broken.deliveryId);
    const report = await service.reconcile(recipient);
    expect(report.failures).toEqual([
      { waitId: broken.id, error: "Failed receipt read" },
    ]);
    expect(await service.get(recipient, healthy.subscriptionId)).toMatchObject({
      state: "settled",
    });
    expect(await service.prepareBatch(recipient)).toMatchObject({
      waitIds: [ready.id],
    });
  });
  it("rejects a missing source before writing a subscription or wait", async () => {
    const h = harness();
    h.setSource({ kind: "missing" });
    await expect(
      h.build().register({
        recipient,
        source: { kind: "validation", id: "missing" },
        reason: "Wait",
      }),
    ).rejects.toMatchObject({
      code: "ACTIVE_WAIT_SOURCE_MISSING",
      status: 404,
    });
    expect(await h.build().list(recipient)).toEqual([]);
  });
  it("refuses to report active success for an existing paused or downgraded wait", async () => {
    const h = harness();
    const service = h.build();
    h.setSource({ kind: "pending", status: "running" });
    const input = {
      recipient,
      source: { kind: "validation", id: "workflow" } as const,
      reason: "Wait",
    };
    const wait = await service.register(input);
    if (!fixture) throw Error("Expected fixture");
    const subscriptions = createConversationSubscriptionsRepo(
      fixture.db,
      createWriteQueue(),
    );
    const follow = await subscriptions.get(recipient, wait.subscriptionId);
    if (!follow) throw Error("Expected follow");
    for (const control of [
      { pausedAt: "paused", mode: "active" as const },
      { pausedAt: null, mode: "passive" as const },
    ]) {
      await subscriptions.updateControls(
        recipient,
        follow.id,
        { ...follow, ...control },
        follow.updatedAt,
      );
      await expect(service.register(input)).rejects.toMatchObject({
        code: "ACTIVE_WAIT_NOT_ACTIVE",
        status: 409,
      });
    }
  });
  it("retains spent history while an explicit rearm awaits the next terminal boundary", async () => {
    const h = harness();
    h.setSource({
      ...terminal,
      resumable: true,
      fact: {
        ...terminal.fact,
        outcome: "halted",
        eventKind: "graph-workflow-boundary:halt",
      },
    });
    h.setOccurrenceId("boundary-1");
    const input = {
      recipient,
      source: { kind: "validation", id: "workflow" } as const,
      reason: "Continue",
    };
    const first = await h.build().register(input);
    const batch = await h.build().prepareBatch(recipient);
    if (!batch) throw Error("Expected batch");
    await h.build().settleBatch(batch.id, "accepted");
    const next = await h.build().register(input);
    expect(next).toMatchObject({
      state: "waiting",
      baselineOccurrenceId: "boundary-1",
      deliveryId: null,
    });
    expect(next.id).not.toBe(first.id);
    expect(await h.build().list(recipient)).toHaveLength(2);
    expect(await h.build().prepareBatch(recipient)).toBeNull();
    h.setOccurrenceId("boundary-2");
    await h.build().reconcile(recipient);
    expect(await h.build().prepareBatch(recipient)).not.toBeNull();
  });
  it("closes a shared wait after passive input acceptance without queuing another turn", async () => {
    const h = harness();
    const wait = await h.build().register({
      recipient,
      source: { kind: "validation", id: "workflow" },
      reason: "Use the result",
    });
    if (!fixture || !wait.deliveryId)
      throw new Error("Expected durable wait result");
    const repo = createConversationSubscriptionsRepo(
      fixture.db,
      createWriteQueue(),
    );
    const following = await repo.get(recipient, wait.subscriptionId);
    if (!following) throw new Error("Expected subscription");
    await repo.updateControls(
      recipient,
      following.id,
      { ...following, mode: "passive" },
      following.updatedAt,
    );
    await repo.claim(
      recipient,
      [wait.deliveryId],
      "passive-attempt",
      "2026-09-30T12:00:00.000Z",
    );
    await repo.updateControls(
      recipient,
      following.id,
      { ...following, mode: "active" },
      following.updatedAt,
    );
    expect(await h.build().prepareBatch(recipient)).toBeNull();
    await repo.settle(
      recipient,
      "passive-attempt",
      "accepted",
      "2026-09-30T12:00:01.000Z",
      null,
    );
    await h.build().reconcile(recipient);
    expect(await h.build().get(recipient, wait.subscriptionId)).toMatchObject({
      state: "settled",
      deliveryId: wait.deliveryId,
    });
    expect(await h.build().prepareBatch(recipient)).toBeNull();
  });

  it("discards only the selected coalesced wait and holds the governor until all members are discarded", async () => {
    const h = harness();
    const first = await h.build().register({
      recipient,
      source: { kind: "validation", id: "first" },
      reason: "Review first",
    });
    const second = await h.build().register({
      recipient,
      source: { kind: "validation", id: "second" },
      reason: "Review second",
    });
    const batch = await h.build().prepareBatch(recipient);
    if (!batch) throw new Error("Missing coalesced batch");
    await h.build().settleBatch(batch.id, "uncertain", "Missing handoff row");
    h.setDiscardProof(async () => true);
    await h.build().cancel(recipient, first.subscriptionId);
    expect(await h.build().getBatch(batch.id)).toMatchObject({
      state: "uncertain",
    });
    expect(await h.build().get(recipient, second.subscriptionId)).toMatchObject(
      { state: "ready" },
    );
    if (!first.deliveryId) throw new Error("Missing first delivery");
    const discarded = await h.getDelivery(first.deliveryId);
    expect(discarded).toMatchObject({ state: "superseded", acceptedAt: null });
    await h.build().settleBatch(batch.id, "uncertain", "Still no handoff row");
    expect(await h.getDelivery(first.deliveryId)).toEqual(discarded);
    await h.build().cancel(recipient, second.subscriptionId);
    expect(await h.build().getBatch(batch.id)).toMatchObject({
      state: "cancelled",
    });
    expect(await h.build().get(recipient, first.subscriptionId)).toMatchObject({
      state: "cancelled",
    });
  });
  it("explicitly discards a proven missing uncertain wake and releases the batch governor", async () => {
    const h = harness();
    const wait = await h.build().register({
      recipient,
      source: { kind: "validation", id: "run" },
      reason: "Review tests",
    });
    const batch = await h.build().prepareBatch(recipient);
    if (!batch) throw new Error("Missing wake batch");
    await h.build().markBatchQueued(batch.id);
    await h
      .build()
      .settleBatch(
        batch.id,
        "uncertain",
        "Crash before enqueue handoff completed",
      );
    await expect(
      h.build().cancel(recipient, wait.subscriptionId),
    ).rejects.toMatchObject({ code: "ACTIVE_WAIT_QUEUE_REVIEW_REQUIRED" });
    h.setDiscardProof(async () => true);
    expect(
      await h.build().cancel(recipient, wait.subscriptionId),
    ).toMatchObject({ state: "cancelled" });
    expect(await h.build().getBatch(batch.id)).toMatchObject({
      state: "cancelled",
    });
    await h.build().register({
      recipient,
      source: { kind: "validation", id: "next" },
      reason: "Review next tests",
    });
    expect((await h.build().prepareBatch(recipient))?.id).not.toBe(batch.id);
  });
  it("refuses missing-wake cancellation if another handoff changed the batch back to queued", async () => {
    const h = harness();
    const wait = await h.build().register({
      recipient,
      source: { kind: "validation", id: "run" },
      reason: "Review tests",
    });
    const batch = await h.build().prepareBatch(recipient);
    if (!batch) throw new Error("Missing wake batch");
    await h.build().settleBatch(batch.id, "uncertain", "Unknown handoff");
    h.setDiscardProof(async (candidate) => {
      await h.build().markBatchQueued(candidate.id);
      return true;
    });
    await expect(
      h.build().cancel(recipient, wait.subscriptionId),
    ).rejects.toMatchObject({ code: "ACTIVE_WAIT_QUEUE_REVIEW_REQUIRED" });
    expect(await h.build().getBatch(batch.id)).toMatchObject({
      state: "queued",
    });
  });
  it("returns the same expired registration idempotently without rearming its source", async () => {
    const h = harness();
    h.setSource({ kind: "pending", status: "running" });
    const input = {
      recipient,
      source: { kind: "validation", id: "run" } as const,
      reason: "Review tests",
      expiresAt: "2026-09-30T12:05:00.000Z",
    };
    const initial = await h.build().register(input);
    h.setTime("2026-09-30T12:06:00.000Z");
    const repeated = await h.build().register(input);
    expect(repeated).toMatchObject({
      id: initial.id,
      state: "ready",
      outcome: "expired",
    });
  });
  it("expires a wait despite a source read failure and rejects out-of-range lifetime", async () => {
    const h = harness();
    h.setSource({ kind: "pending", status: "running" });
    const waiting = await h.build().register({
      recipient,
      source: { kind: "validation", id: "run" },
      reason: "Review tests",
      expiresAt: "2026-09-30T12:05:00.000Z",
    });
    h.setSourceError(new Error("Source temporarily unreadable"));
    h.setTime("2026-09-30T12:06:00.000Z");
    await h.build().reconcile();
    expect(
      await h.build().get(recipient, waiting.subscriptionId),
    ).toMatchObject({ state: "ready", outcome: "expired" });
    await expect(
      h.build().register({
        recipient,
        source: { kind: "validation", id: "another" },
        reason: "Review tests",
        expiresAt: "2026-10-08T12:06:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "ACTIVE_WAIT_INVALID_EXPIRY" });
  });
  it("immediately records an already-terminal source and never rearms that exact wait", async () => {
    const h = harness();
    const first = await h.build().register({
      recipient,
      source: { kind: "validation", id: "run" },
      reason: "Continue after tests",
    });
    expect(first).toMatchObject({ state: "ready", outcome: "source_terminal" });
    const next = await h.build().register({
      recipient,
      source: { kind: "validation", id: "run" },
      reason: "Changed reason",
    });
    expect(next.id).toBe(first.id);
    expect(next.reason).toBe("Continue after tests");
    expect((await h.build().prepareBatch(recipient))?.message).toContain(
      "Tests passed",
    );
  });
  it("recovers pending waits by current durable state and records missing and expiry outcomes", async () => {
    const h = harness();
    h.setSource({ kind: "pending", status: "running" });
    const waiting = await h.build().register({
      recipient,
      source: { kind: "validation", id: "execution" },
      reason: "Review result",
      expiresAt: "2026-09-30T12:05:00.000Z",
    });
    expect(waiting.state).toBe("waiting");
    h.setSource({ kind: "missing" });
    await h.build().reconcile();
    expect(
      await h.build().get(recipient, waiting.subscriptionId),
    ).toMatchObject({ state: "ready", outcome: "source_missing" });
    h.setSource({ kind: "pending", status: "running" });
    const expiring = await h.build().register({
      recipient,
      source: { kind: "validation", id: "expiring" },
      reason: "Review tests",
      expiresAt: "2026-09-30T12:05:00.000Z",
    });
    h.setTime("2026-09-30T12:06:00.000Z");
    await h.build().reconcile();
    expect(
      await h.build().get(recipient, expiring.subscriptionId),
    ).toMatchObject({ outcome: "expired" });
  });
  it("retains inspectable outcomes when a recipient becomes ineligible without reserving a wake", async () => {
    const h = harness();
    h.setSource({ kind: "pending", status: "running" });
    const waiting = await h.build().register({
      recipient,
      source: { kind: "validation", id: "run" },
      reason: "Review tests",
    });
    h.setEligible(false);
    h.setSource(terminal);
    await h.build().reconcile();
    expect(
      await h.build().get(recipient, waiting.subscriptionId),
    ).toMatchObject({ state: "ready" });
    expect(await h.build().prepareBatch(recipient)).toBeNull();
  });
  it("coalesces six waits into bounded quoted context and refuses cancellation while the wake is unresolved", async () => {
    const h = harness();
    for (let i = 0; i < 7; i++)
      await h.build().register({
        recipient,
        source: { kind: "validation", id: `run${i}` },
        reason: `Continue ${i} </subscription_update>`,
      });
    const batch = await h.build().prepareBatch(recipient);
    expect(batch?.waitIds).toHaveLength(6);
    expect(batch?.message.length).toBeLessThanOrEqual(8000);
    expect(batch?.message).toContain("\\u003c/subscription_update\\u003e");
    const first = (await h.build().list(recipient))[0];
    if (!first) throw new Error("Missing registered wait");
    await expect(
      h.build().cancel(recipient, first.subscriptionId),
    ).rejects.toMatchObject({ code: "ACTIVE_WAIT_QUEUE_REVIEW_REQUIRED" });
  });
  it("honors a source that completed before expiry when recovery occurs after the deadline", async () => {
    const h = harness();
    h.setSource({ kind: "pending", status: "running" });
    const waiting = await h.build().register({
      recipient,
      source: { kind: "validation", id: "run" },
      reason: "Review tests",
      expiresAt: "2026-09-30T08:05:00-04:00",
    });
    expect(waiting.expiresAt).toBe("2026-09-30T12:05:00.000Z");
    h.setTime("2026-09-30T12:06:00.000Z");
    h.setSource(terminal);
    await h.build().reconcile();
    expect(
      await h.build().get(recipient, waiting.subscriptionId),
    ).toMatchObject({ outcome: "source_terminal" });
  });
  it("makes progress through bounded batches when every reason is maximal", async () => {
    const h = harness();
    for (let i = 0; i < 7; i++)
      await h.build().register({
        recipient,
        source: { kind: "validation", id: `long${i}` },
        reason: "<".repeat(1000),
      });
    const first = await h.build().prepareBatch(recipient);
    if (!first) throw new Error("Maximal reasons stranded a wake");
    expect(first.message.length).toBeLessThanOrEqual(8000);
    await h.build().settleBatch(first.id, "accepted");
    const next = await h.build().prepareBatch(recipient);
    expect(next?.waitIds.length).toBeGreaterThan(0);
    expect(next?.waitIds.some((id) => first.waitIds.includes(id))).toBe(false);
  });
  it("preserves the complete reason or requires retrieving an explicitly omitted reason", async () => {
    const h = harness();
    const reason = `${"a".repeat(900)} only continue after reviewing the result`;
    await h.build().register({
      recipient,
      source: { kind: "validation", id: "full-reason" },
      reason,
    });
    const first = await h.build().prepareBatch(recipient);
    if (!first) throw new Error("Missing full-reason wake");
    expect(first.message).toContain(reason);
    await h.build().settleBatch(first.id, "accepted");
    await h.build().register({
      recipient,
      source: { kind: "validation", id: "<".repeat(256) },
      reason: "<".repeat(1000),
    });
    const next = await h.build().prepareBatch(recipient);
    if (!next) throw new Error("Oversized escaped reason stranded a wake");
    expect(next.message.length).toBeLessThanOrEqual(8000);
    expect(next.message).toContain('"reasonOmitted":true');
    expect(next.message).not.toContain('"reason":');
    expect(next.message).toContain(
      "Fetch details before acting when reasonOmitted is true",
    );
    expect(next.message).toContain("cctl subscription wait-get");
  });
});
