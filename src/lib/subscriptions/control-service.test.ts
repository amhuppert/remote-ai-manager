import { afterEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createConversationSubscriptionsRepo } from "@/lib/state-store/conversation-subscriptions-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { createSubscriptionControlsService } from "./control-service";
import { createSubscriptionService } from "./service";
const recipient = { projectPath: "/project", conversationId: "conversation" };
const source = { kind: "notepad", id: "notes" } as const;
let fixture: PersistenceFixture | undefined;
afterEach(() => fixture?.close());
function setup() {
  fixture = createPersistenceFixture();
  const repo = createConversationSubscriptionsRepo(
    fixture.db,
    createWriteQueue(),
  );
  const service = createSubscriptionService({
    repo,
    isRecipientEligible: async () => true,
    readSource: async () => ({ cursor: "1", facts: [], missing: false }),
    now: () => "2026-09-30T12:00:00.000Z",
  });
  return {
    repo,
    service,
    controls: createSubscriptionControlsService({
      repo,
      isRecipientEligible: async () => true,
    }),
  };
}
describe("subscription controls", () => {
  it("explicit subscription restores an opt-out that automatic involvement preserves", async () => {
    const h = setup();
    const sub = await h.service.autoFollow({
      recipient,
      source,
      reason: "supplied notes",
    });
    if (!sub) throw Error("Expected subscription");
    await h.service.unfollow(recipient, sub.id);
    expect(
      (await h.service.autoFollow({ recipient, source, reason: "revisited" }))
        ?.status,
    ).toBe("unfollowed");
    const restored = await h.controls.subscribe({
      recipient,
      source,
      reason: "follow deliberately",
      eventKinds: ["content-revised"],
    });
    expect(restored?.status).toBe("following");
    expect(restored?.id).toBe(sub.id);
    expect((await h.repo.get(recipient, sub.id))?.eventKinds).toEqual([
      "content-revised",
    ]);
  });
  it("pauses and resumes one following subscription without consuming inbox facts", async () => {
    const h = setup();
    const sub = await h.service.autoFollow({
      recipient,
      source,
      reason: "notes",
    });
    if (!sub) throw Error("Expected subscription");
    expect(
      (await h.controls.pause(recipient, sub.id))?.pausedAt,
    ).not.toBeNull();
    expect((await h.controls.resume(recipient, sub.id))?.pausedAt).toBeNull();
  });
});

import { createConversationSubscriptionWaitsRepo } from "@/lib/state-store/conversation-subscription-waits-repo";
import { createConversationSubscriptionPreferencesRepo } from "@/lib/state-store/conversation-subscription-preferences-repo";
import { createActiveWaitService } from "./active-wait-service";
import { sourceFactSchema } from "./schemas";
function finiteHarness() {
  fixture = createPersistenceFixture();
  const queue = createWriteQueue();
  const repo = createConversationSubscriptionsRepo(fixture.db, queue);
  const waits = createConversationSubscriptionWaitsRepo(fixture.db, queue);
  const preferences = createConversationSubscriptionPreferencesRepo(
    fixture.db,
    queue,
  );
  let at = "2026-09-30T12:00:00.000Z";
  let terminal = false;
  let sourceReads = 0;
  const active = createActiveWaitService({
    repo: waits,
    subscriptions: repo,
    isRecipientEligible: async () => true,
    now: () => at,
    readTerminalSource: async (_recipient, source) =>
      terminal
        ? {
            kind: "terminal",
            fact: sourceFactSchema.parse({
              occurrenceId: `terminal:${source.id}`,
              eventKind: "validation-completed",
              category: "outcome",
              sourceTitle: "Tests",
              summary: "Tests passed",
              occurredAt: at,
              revision: null,
              outcome: "passed",
              retrievalHandle: "cctl validate status run",
              actorConversationId: null,
            }),
          }
        : { kind: "pending", status: "running" },
  });
  const service = createSubscriptionService({
    repo,
    isRecipientEligible: async () => true,
    now: () => at,
    readSource: async () => {
      sourceReads++;
      return { cursor: "2", facts: [], missing: false };
    },
  });
  const controls = createSubscriptionControlsService({
    isRecipientEligible: async () => true,
    repo,
    waits,
    activeWaits: active,
    preferences,
    now: () => at,
  });
  return {
    repo,
    waits,
    preferences,
    active,
    service,
    controls,
    setTerminal() {
      terminal = true;
    },
    setTime(value: string) {
      at = value;
    },
    sourceReads: () => sourceReads,
  };
}
it("keeps paused outcomes durable and briefs a downgraded finite result after expiry", async () => {
  const h = finiteHarness();
  const wait = await h.active.register({
    recipient,
    source: { kind: "validation", id: "run" },
    reason: "Review tests",
    expiresAt: "2026-09-30T13:00:00.000Z",
  });
  await h.controls.pause(recipient, wait.subscriptionId);
  h.setTerminal();
  await h.active.reconcile(recipient);
  const ready = await h.waits.get(recipient, wait.subscriptionId);
  expect(ready?.state).toBe("ready");
  expect(await h.active.prepareBatch(recipient)).toBeNull();
  await h.controls.setMode(recipient, wait.subscriptionId, "passive");
  await h.controls.resume(recipient, wait.subscriptionId);
  h.setTime("2026-09-30T14:00:00.000Z");
  const briefing = await h.service.prepareBriefing({
    recipient,
    attemptId: "next-user-input",
  });
  expect(briefing.block).toContain("Tests passed");
  expect(h.sourceReads()).toBe(0);
  await briefing.onInputAccepted();
  expect(
    ready?.deliveryId &&
      (await h.repo.getDelivery(recipient, ready.deliveryId))?.state,
  ).toBe("accepted");
});
it("human read state persists separately from accepted delivery state and hints default on", async () => {
  const h = finiteHarness();
  const wait = await h.active.register({
    recipient,
    source: { kind: "validation", id: "run" },
    reason: "Review tests",
  });
  h.setTerminal();
  await h.active.reconcile(recipient);
  const ready = await h.waits.get(recipient, wait.subscriptionId);
  if (!ready?.deliveryId) throw Error("Expected outcome delivery");
  expect(await h.controls.getPreferences(recipient)).toEqual({
    hintsEnabled: true,
  });
  await h.controls.setHintsEnabled(recipient, false);
  await h.controls.markDeliveryRead(recipient, ready.deliveryId, true);
  const reloaded = createConversationSubscriptionPreferencesRepo(
    fixture?.db ??
      (() => {
        throw Error("Fixture absent");
      })(),
    createWriteQueue(),
  );
  expect(await reloaded.getPreferences(recipient)).toEqual({
    hintsEnabled: false,
  });
  expect(await reloaded.getReadAt(recipient, ready.deliveryId)).toBe(
    "2026-09-30T12:00:00.000Z",
  );
  expect((await h.repo.getDelivery(recipient, ready.deliveryId))?.state).toBe(
    "pending",
  );
  await h.controls.markDeliveryRead(recipient, ready.deliveryId, false);
  expect(await reloaded.getReadAt(recipient, ready.deliveryId)).toBeNull();
});
it("preserves pause atomically when passive follow first becomes a finite active wait", async () => {
  const h = finiteHarness();
  const sub = await h.controls.subscribe({
    recipient,
    source: { kind: "validation", id: "run" },
    reason: "Review tests",
  });
  if (!sub) throw Error("Expected passive subscription");
  const paused = await h.controls.pause(recipient, sub.id);
  h.setTerminal();
  const promoted = await h.controls.setMode(recipient, sub.id, "active");
  expect(promoted?.pausedAt).toBe(paused?.pausedAt);
  expect((await h.active.get(recipient, sub.id))?.state).toBe("ready");
  expect(await h.active.prepareBatch(recipient)).toBeNull();
});
it("refuses passive resubscribe of a spent finite source instead of reporting a follow that cannot collect", async () => {
  const h = finiteHarness();
  const wait = await h.active.register({
    recipient,
    source: { kind: "validation", id: "run" },
    reason: "Review tests",
  });
  await h.controls.cancel(recipient, wait.subscriptionId);
  await expect(
    h.controls.subscribe({
      recipient,
      source: wait.source,
      reason: wait.reason,
      mode: "passive",
    }),
  ).rejects.toMatchObject({ code: "ACTIVE_WAIT_SPENT", status: 409 });
  expect((await h.repo.get(recipient, wait.subscriptionId))?.status).toBe(
    "unfollowed",
  );
});
it("keeps one canonical reason for a retained finite wait", async () => {
  const h = finiteHarness();
  const wait = await h.active.register({
    recipient,
    source: { kind: "validation", id: "run" },
    reason: "Review tests",
  });
  await expect(
    h.controls.subscribe({
      recipient,
      source: wait.source,
      reason: "Deploy after the tests",
      mode: "active",
    }),
  ).rejects.toMatchObject({ code: "ACTIVE_WAIT_REASON_LOCKED", status: 409 });
  expect((await h.repo.get(recipient, wait.subscriptionId))?.reason).toBe(
    wait.reason,
  );
  expect((await h.waits.get(recipient, wait.subscriptionId))?.reason).toBe(
    wait.reason,
  );
});
