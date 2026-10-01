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
  let at = "2026-09-30T12:00:00.000Z";
  let nextId = 0;
  let discardProof = async (_batch: SubscriptionWakeBatch) => false;
  const build = () =>
    createActiveWaitService({
      repo: createConversationSubscriptionWaitsRepo(db, createWriteQueue()),
      subscriptions: createConversationSubscriptionsRepo(
        db,
        createWriteQueue(),
      ),
      async isRecipientEligible() {
        return eligible;
      },
      canDiscardMissingBatch: (batch) => discardProof(batch),
      async readTerminalSource(_recipient, source) {
        if (sourceError) throw sourceError;
        return state.kind === "terminal"
          ? {
              ...state,
              fact: {
                ...state.fact,
                occurrenceId: `one-time-terminal:${source.kind}:${source.id}`,
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
  it("closes a shared wait after passive input acceptance without queuing another turn", async () => {
    const h = harness();
    const wait = await h.build().register({
      recipient,
      source: { kind: "workflow", id: "workflow" },
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
    expect(discarded).toMatchObject({ state: "failed" });
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
      source: { kind: "workflow", id: "execution" },
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
