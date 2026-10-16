import { afterEach, expect, it } from "vitest";
import { createMessageQueueService } from "@/lib/conversations/message-queue-service";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createConversationSubscriptionsRepo } from "@/lib/state-store/conversation-subscriptions-repo";
import { createConversationSubscriptionWaitsRepo } from "@/lib/state-store/conversation-subscription-waits-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { createActiveWaitService } from "./active-wait-service";
import { createSubscriptionService } from "./service";
import type { SourceFact } from "./schemas";

const recipient = { projectPath: "/project", conversationId: "owner" };
const key = { ...recipient, sessionName: "session" };
const source = { kind: "run", id: "run" } as const;
const at = "2026-10-15T12:00:00.000Z";
let fixture: PersistenceFixture | undefined;
afterEach(() => fixture?.close());

function fact(occurrenceId: string): SourceFact {
  return {
    occurrenceId,
    eventKind: "run-boundary:halted",
    category: "decision",
    sourceTitle: "Run",
    summary: `Notice ${occurrenceId}`,
    sourceText: `Notice ${occurrenceId}`,
    occurredAt: at,
    revision: null,
    outcome: "halted",
    retrievalHandle: "cctl run show run",
    actorConversationId: null,
  };
}

async function harness() {
  const writeQueue = createWriteQueue();
  fixture = createPersistenceFixture({ writeQueue });
  fixture.seedProject(recipient.projectPath);
  fixture.seedSession(recipient.projectPath, key.sessionName);
  await fixture.seedConversation(
    recipient.projectPath,
    key.sessionName,
    conversationStateSchema.parse({
      id: recipient.conversationId,
      name: "Owner",
      createdAt: at,
      lastActivityAt: at,
      transcriptPath: "/tmp/source-withdrawal-test.jsonl",
      status: "awaiting",
      promptCount: 0,
    }),
  );
  const repo = createConversationSubscriptionsRepo(fixture.db, writeQueue);
  const waits = createConversationSubscriptionWaitsRepo(fixture.db, writeQueue);
  const queue = createMessageQueueService({
    ...fixture.deps,
    isSubscriptionWakeCurrent: (id) => waits.isBatchDispatchable(id),
    broadcast() {},
    getProjectDisplayName: () => "project",
    now: () => at,
    newId: () => crypto.randomUUID(),
  });
  const facts: SourceFact[] = [];
  const withdrawnOccurrenceIds: string[] = [];
  const service = createSubscriptionService({
    repo,
    waits,
    isRecipientEligible: async () => true,
    readSource: async (_recipient, _source, cursor) => ({
      facts: facts.slice(Number(cursor)),
      cursor: String(facts.length),
      withdrawnOccurrenceIds,
      missing: false,
    }),
    withdrawPendingWake: (batch, commit) =>
      queue.withdrawSubscriptionWake({
        ...key,
        batchId: batch.id,
        allowMissing: batch.state === "planned",
        commit,
      }),
    now: () => at,
  });
  const active = createActiveWaitService({
    repo: waits,
    subscriptions: repo,
    isRecipientEligible: async () => true,
    readTerminalSource: async () => ({
      kind: "terminal",
      fact: {
        ...fact("test-passed"),
        eventKind: "validation-completed",
        outcome: "passed",
      },
    }),
    now: () => at,
  });
  await service.autoFollow({
    recipient,
    source,
    initialCursor: "0",
    reason: "Owner",
    wakes: true,
  });
  async function prepare(options: { mixed?: boolean; enqueue?: boolean } = {}) {
    facts.push(fact("obsolete-halt"));
    if (options.mixed) {
      facts.push(fact("current-halt"));
      await active.register({
        recipient,
        source: { kind: "validation", id: "test" },
        reason: "Tests",
      });
    }
    await service.reconcile(recipient);
    const batch = await active.prepareBatch(recipient);
    if (!batch) throw Error("Expected a wake batch");
    if (options.enqueue !== false) {
      await active.markBatchQueued(batch.id);
      await queue.enqueue({
        ...key,
        id: batch.queueMessageId,
        metadata: { kind: "subscription_update", batchId: batch.id },
        content: [{ type: "text", text: batch.message }],
      });
    }
    return batch;
  }
  async function deliveries() {
    return (
      await repo.readInbox(recipient, { includeSettled: true, limit: 20 })
    ).items;
  }
  return {
    repo,
    waits,
    queue,
    service,
    active,
    withdrawnOccurrenceIds,
    prepare,
    deliveries,
  };
}

it("withdraws a queued obsolete halt before delivery and preserves valid notices and finite waits", async () => {
  const h = await harness();
  const batch = await h.prepare({ mixed: true });
  h.withdrawnOccurrenceIds.push("obsolete-halt");
  expect((await h.service.reconcile(recipient)).failures).toEqual([]);

  expect(await h.queue.listActive(key)).toEqual([]);
  expect((await h.waits.getBatch(batch.id))?.state).toBe("cancelled");
  const deliveries = await h.deliveries();
  expect(
    deliveries.find((row) => row.fact.occurrenceId === "obsolete-halt"),
  ).toMatchObject({
    state: "superseded",
    acceptedAt: null,
  });
  expect(
    deliveries
      .filter((row) => row.fact.occurrenceId !== "obsolete-halt")
      .map((row) => row.state),
  ).toEqual(["pending", "pending"]);
  const next = await h.active.prepareBatch(recipient);
  expect(next?.message).toContain("current-halt");
  expect(next?.message).toContain("test-passed");
  expect(next?.message).not.toContain("obsolete-halt");
  expect(next?.waitIds).toEqual(batch.waitIds);
  await expect(
    h.queue.enqueue({
      ...key,
      id: batch.queueMessageId,
      metadata: { kind: "subscription_update", batchId: batch.id },
      content: [{ type: "text", text: batch.message }],
    }),
  ).rejects.toThrow(/no longer current/);
});

it("withdraws a planned obsolete halt even before a queue row exists", async () => {
  const h = await harness();
  const batch = await h.prepare({ enqueue: false });
  h.withdrawnOccurrenceIds.push("obsolete-halt");
  await h.service.reconcile(recipient);
  expect((await h.waits.getBatch(batch.id))?.state).toBe("cancelled");
  expect(await h.active.prepareBatch(recipient)).toBeNull();
  expect((await h.deliveries())[0]).toMatchObject({
    state: "superseded",
    acceptedAt: null,
  });
});

it.each(["failed", "uncertain"] as const)(
  "withdraws a %s handoff when its queue row proves the wake is still pending",
  async (state) => {
    const h = await harness();
    const batch = await h.prepare({ mixed: true });
    await h.active.settleBatch(batch.id, state, "Handoff interrupted");
    h.withdrawnOccurrenceIds.push("obsolete-halt");
    await h.service.reconcile(recipient);
    expect(await h.queue.listActive(key)).toEqual([]);
    expect((await h.waits.getBatch(batch.id))?.state).toBe("cancelled");
    const next = await h.active.prepareBatch(recipient);
    expect(next?.message).toContain("current-halt");
    expect(next?.message).toContain("test-passed");
    expect(next?.message).not.toContain("obsolete-halt");
  },
);

it.each(["queued", "failed", "uncertain"] as const)(
  "keeps an unresolved %s wake when there is no queue row proving it was unsent",
  async (state) => {
    const h = await harness();
    const batch = await h.prepare({ enqueue: false });
    await h.active.markBatchQueued(batch.id);
    if (state !== "queued")
      await h.active.settleBatch(batch.id, state, "Handoff interrupted");
    h.withdrawnOccurrenceIds.push("obsolete-halt");
    await h.service.reconcile(recipient);
    expect((await h.waits.getBatch(batch.id))?.state).toBe(state);
    expect((await h.deliveries())[0]?.state).toBe(state);
  },
);

it("preserves in-flight and acknowledged input when its source notice becomes obsolete", async () => {
  const h = await harness();
  const batch = await h.prepare();
  expect((await h.queue.claimNextTurnBatch(key))?.subscriptionBatchId).toBe(
    batch.id,
  );
  h.withdrawnOccurrenceIds.push("obsolete-halt");
  await h.service.reconcile(recipient);
  expect((await h.waits.getBatch(batch.id))?.state).toBe("queued");
  expect((await h.deliveries())[0]?.state).toBe("queued");
  await h.active.settleBatch(batch.id, "accepted");
  const accepted = await h.deliveries();
  await h.service.reconcile(recipient);
  expect(await h.deliveries()).toEqual(accepted);
});
