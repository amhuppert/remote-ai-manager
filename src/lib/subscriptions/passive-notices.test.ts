import { afterEach, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createConversationSubscriptionsRepo } from "@/lib/state-store/conversation-subscriptions-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { createSubscriptionService } from "./service";
import { sourceFactSchema } from "./schemas";

const recipient = { projectPath: "/project", conversationId: "conversation" };
const source = { kind: "spec", id: "spec" } as const;
const at = "2026-09-30T12:00:00Z";
let fixture: PersistenceFixture | undefined;
afterEach(() => fixture?.close());
function setup() {
  fixture = createPersistenceFixture();
  const db = fixture.db;
  const repo = createConversationSubscriptionsRepo(db, createWriteQueue());
  let id = 0;
  const service = createSubscriptionService({
    repo,
    isRecipientEligible: async () => true,
    readSource: async () => ({ cursor: "10", facts: [], missing: false }),
    now: () => at,
    newId: () => `notice-${++id}`,
  });
  const fact = sourceFactSchema.parse({
    occurrenceId: "10",
    eventKind: "spec-review-comment-added",
    category: "decision",
    sourceTitle: "Release",
    summary: "Submitted review feedback",
    occurredAt: at,
    revision: "revision",
    outcome: "comment-added",
    retrievalHandle: "cctl spec status release",
    actorConversationId: null,
  });
  const input = {
    recipient,
    source,
    fact,
    reason: "Submitted review feedback",
  };
  return {
    service,
    repo,
    db,
    input,
    reload: () => createConversationSubscriptionsRepo(db, createWriteQueue()),
  };
}

it("durably records a pushed spec occurrence once and keeps an existing reconciliation cursor", async () => {
  const h = setup();
  const subscription = await h.service.autoFollow({
    recipient,
    source,
    reason: "Existing involvement",
    initialCursor: "3",
  });
  if (!subscription) throw new Error("Expected subscription");
  expect(await h.service.recordNotice(h.input)).toBe(true);
  expect(await h.service.recordNotice(h.input)).toBe(false);
  expect(await h.reload().get(recipient, subscription.id)).toMatchObject({
    cursor: "3",
    reason: "Existing involvement",
  });
  expect((await h.reload().readInbox(recipient, {})).items).toMatchObject([
    { source, fact: h.input.fact, state: "pending" },
  ]);
});

it("creates first involvement before the pushed event and shares occurrence dedupe with reconciliation", async () => {
  const h = setup();
  expect(await h.service.recordNotice(h.input)).toBe(true);
  const sub = await h.reload().findBySource(recipient, source);
  expect(sub).toMatchObject({ cursor: "9", mode: "passive" });
  if (!sub) throw new Error("Expected subscription");
  expect(
    await h.repo.reconcile({
      recipient,
      subscriptionId: sub.id,
      expectedCursor: "9",
      nextCursor: "10",
      deliveries: [
        {
          ...(await h.repo.readInbox(recipient, {})).items[0],
          id: "reconciled",
          subscriptionId: sub.id,
          recipient,
          source,
          fact: h.input.fact,
          recordedAt: at,
          state: "pending",
          attemptId: null,
          attemptCount: 0,
          queuedAt: null,
          acceptedAt: null,
          finishedAt: null,
          lastError: null,
        },
      ],
      missingAt: null,
      updatedAt: at,
    }),
  ).toEqual({ applied: true, inserted: 0 });
  expect((await h.reload().readInbox(recipient, {})).total).toBe(1);
});

it("preserves paused evidence and suppresses notices excluded by existing controls", async () => {
  const h = setup();
  const sub = await h.service.autoFollow({
    recipient,
    source,
    reason: "Follow",
    initialCursor: "3",
  });
  if (!sub) throw new Error("Expected subscription");
  await h.repo.updateControls(recipient, sub.id, { ...sub, pausedAt: at }, at);
  expect(await h.service.recordNotice(h.input)).toBe(true);
  expect(
    await h.service.prepareBriefing({ recipient, attemptId: "paused" }),
  ).toMatchObject({ block: null });
  for (const controls of [
    { ...sub, status: "unfollowed" as const },
    { ...sub, expiresAt: at },
    { ...sub, eventKinds: ["another-event"] },
    { ...sub, mode: "active" as const },
  ]) {
    await h.repo.updateControls(recipient, sub.id, controls, at);
    expect(
      await h.service.recordNotice({
        ...h.input,
        fact: { ...h.input.fact, occurrenceId: "11" },
      }),
    ).toBe(false);
  }
  expect(
    (await h.reload().readInbox(recipient, { includeSettled: true })).total,
  ).toBe(1);
});

it("limits internal conversation sources to their recipient and preserves full notice evidence", async () => {
  const h = setup();
  const ownSource = {
    kind: "conversation",
    id: recipient.conversationId,
  } as const;
  const fact = { ...h.input.fact, sourceText: "opaque source text" };
  expect(
    await h.service.recordNotice({ ...h.input, source: ownSource, fact }),
  ).toBe(true);
  expect(
    (await h.reload().readInbox(recipient, {})).items[0]?.fact.sourceText,
  ).toBe("opaque source text");
  await expect(
    h.service.recordNotice({
      ...h.input,
      source: { kind: "conversation", id: "peer" },
    }),
  ).rejects.toThrow(/own conversation/i);
});

it("rolls back newly discovered involvement when its durable notice cannot be inserted", async () => {
  const h = setup();
  h.db.exec(
    "CREATE TRIGGER reject_notice BEFORE INSERT ON conversation_subscription_deliveries BEGIN SELECT RAISE(FAIL,'notice insert rejected'); END",
  );
  await expect(h.service.recordNotice(h.input)).rejects.toThrow(
    /notice insert rejected/,
  );
  expect(await h.reload().findBySource(recipient, source)).toBeNull();
  expect((await h.reload().readInbox(recipient, {})).total).toBe(0);
});
