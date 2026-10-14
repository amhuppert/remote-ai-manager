import { afterEach, describe, expect, it } from "vitest";
import { createSubscriptionControlsHandlers } from "./controls-route-handlers";
import {
  conversationSubscriptionSchema,
  subscriptionDeliverySchema,
} from "./schemas";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createConversationSubscriptionsRepo } from "@/lib/state-store/conversation-subscriptions-repo";
import { createConversationSubscriptionWaitsRepo } from "@/lib/state-store/conversation-subscription-waits-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { createSubscriptionControlsService } from "./control-service";
import { createActiveWaitService } from "./active-wait-service";

let persistence: PersistenceFixture | undefined;
afterEach(() => persistence?.close());

const recipient = { projectPath: "/project", conversationId: "conversation" };
const subscription = conversationSubscriptionSchema.parse({
  id: "sub",
  recipient,
  source: { kind: "ticket", id: "ticket" },
  reason: "Follow decisions",
  mode: "passive",
  eventKinds: null,
  expiresAt: null,
  status: "following",
  cursor: null,
  createdAt: "now",
  updatedAt: "now",
  unfollowedAt: null,
  pausedAt: null,
  missingAt: null,
  lastError: null,
});
const context = {
  params: Promise.resolve({ subscriptionId: "sub", deliveryId: "delivery" }),
};
function fixture() {
  let enabled = true;
  let writes = 0;
  const handlers = createSubscriptionControlsHandlers({
    resolve: async () => ({ ok: true as const, value: recipient }),
    getControls: () => ({
      async subscribe() {
        writes++;
        return subscription;
      },
      async get() {
        return subscription;
      },
      async pause() {
        writes++;
        return { ...subscription, pausedAt: "now" };
      },
      async resume() {
        return subscription;
      },
      async setMode() {
        return subscription;
      },
      async cancel() {
        return subscription;
      },
      async unfollow() {
        return subscription;
      },
      async getPreferences() {
        return { hintsEnabled: enabled };
      },
      async setHintsEnabled(_recipient, value) {
        enabled = value;
        return { hintsEnabled: value };
      },
      async markDeliveryRead() {
        writes++;
        return true;
      },
      async getReadAt() {
        return null;
      },
      async getDelivery() {
        return null;
      },
      async reviewDelivery() {
        return false;
      },
      async listReadAt() {
        return new Map();
      },
    }),
    async getDetail() {
      return { subscription, wait: null, batch: null };
    },
    async pendingCount() {
      return 3;
    },
    now: () => "2026-09-30T00:00:00.000Z",
  });
  return { handlers, writes: () => writes };
}
describe("subscription controls HTTP", () => {
  it("restores an existing finite wait over HTTP without replacing its deadline", async () => {
    persistence = createPersistenceFixture();
    const queue = createWriteQueue();
    const repo = createConversationSubscriptionsRepo(persistence.db, queue);
    const waits = createConversationSubscriptionWaitsRepo(
      persistence.db,
      queue,
    );
    let at = "2026-09-30T12:00:00.000Z";
    const active = createActiveWaitService({
      repo: waits,
      subscriptions: repo,
      isRecipientEligible: async () => true,
      now: () => at,
      readTerminalSource: async () => ({ kind: "pending", status: "running" }),
    });
    const controls = createSubscriptionControlsService({
      repo,
      waits,
      activeWaits: active,
      isRecipientEligible: async () => true,
      now: () => at,
      readSource: async () => ({ cursor: "0", facts: [], missing: false }),
    });
    const handlers = createSubscriptionControlsHandlers({
      resolve: async () => ({ ok: true, value: recipient }),
      getControls: () => controls,
      now: () => at,
      pendingCount: (value) => repo.pendingCount(value),
      async getDetail(value, id) {
        const follow = await repo.get(value, id);
        return follow
          ? {
              subscription: follow,
              wait: await waits.get(value, id),
              batch: null,
            }
          : null;
      },
    });
    const request = () =>
      new Request("http://test", {
        method: "POST",
        body: JSON.stringify({
          source: { kind: "validation", id: "workflow" },
          reason: "Continue",
          mode: "active",
        }),
      });
    const firstResponse = await handlers.subscribePOST(request(), context);
    expect(firstResponse.status).toBe(201);
    const first = await firstResponse.json();
    await controls.pause(recipient, first.subscription.id);
    at = "2026-09-30T12:30:00.000Z";
    const restoredResponse = await handlers.subscribePOST(request(), context);
    expect(restoredResponse.status).toBe(201);
    const restored = await restoredResponse.json();
    expect(restored.wait).toMatchObject({
      id: first.wait.id,
      expiresAt: first.wait.expiresAt,
      state: "waiting",
    });
    expect(restored.subscription.pausedAt).toBeNull();
  });
  it("retries and dismisses an uncertain passive receipt without asserting acceptance", async () => {
    persistence = createPersistenceFixture();
    const repo = createConversationSubscriptionsRepo(
      persistence.db,
      createWriteQueue(),
    );
    await repo.createIfAbsent(subscription);
    const delivery = subscriptionDeliverySchema.parse({
      id: "delivery",
      subscriptionId: subscription.id,
      recipient,
      source: subscription.source,
      fact: {
        occurrenceId: "1",
        eventKind: "ticket-commented",
        category: "activity",
        sourceTitle: "Ticket",
        summary: "Comment",
        occurredAt: "2026-09-30T12:00:00.000Z",
        revision: null,
        outcome: null,
        retrievalHandle: "cctl ticket get ticket",
        actorConversationId: null,
      },
      recordedAt: "now",
      state: "uncertain",
      attemptId: "unknown",
      attemptCount: 1,
      queuedAt: "now",
      acceptedAt: null,
      finishedAt: "now",
      lastError: "Unknown acceptance",
    });
    await repo.recordDelivery(delivery);
    const controls = createSubscriptionControlsService({
      repo,
      isRecipientEligible: async () => true,
    });
    const handlers = createSubscriptionControlsHandlers({
      resolve: async () => ({ ok: true, value: recipient }),
      getControls: () => controls,
      now: () => "2026-09-30T12:00:00.000Z",
      pendingCount: (value) => repo.pendingCount(value),
      getDetail: async () => ({ subscription, wait: null, batch: null }),
    });
    const deliveryContext = {
      params: Promise.resolve({ deliveryId: delivery.id }),
    };
    const review = (action: "retry" | "dismiss") =>
      handlers.readPATCH(
        new Request("http://test", {
          method: "PATCH",
          body: JSON.stringify({ action }),
        }),
        deliveryContext,
      );
    expect((await (await review("retry")).json()).delivery).toMatchObject({
      state: "pending",
      attemptId: null,
      acceptedAt: null,
      attemptCount: 1,
    });
    expect((await (await review("dismiss")).json()).delivery).toMatchObject({
      state: "superseded",
      acceptedAt: null,
    });
    expect((await review("retry")).status).toBe(409);
  });
  it("rejects unsupported selections and unknown control actions", async () => {
    const { handlers, writes } = fixture();
    const response = await handlers.subscribePOST(
      new Request("http://test", {
        method: "POST",
        body: JSON.stringify({
          source: subscription.source,
          reason: "Follow",
          eventKinds: ["notepad-content-revised"],
        }),
      }),
      context,
    );
    expect(response.status).toBe(400);
    const invalid = await handlers.controlPATCH(
      new Request("http://test", {
        method: "PATCH",
        body: JSON.stringify({ action: "approve" }),
      }),
      context,
    );
    expect(invalid.status).toBe(400);
    expect(writes()).toBe(0);
  });
  it("keeps hint summary read-only and stores the explicit preference", async () => {
    const { handlers, writes } = fixture();
    expect(
      await (
        await handlers.summaryGET(new Request("http://test"), context)
      ).json(),
    ).toEqual({ pendingCount: 3, hintsEnabled: true });
    expect(writes()).toBe(0);
    await handlers.preferencesPATCH(
      new Request("http://test", {
        method: "PATCH",
        body: JSON.stringify({ hintsEnabled: false }),
      }),
      context,
    );
    expect(
      await (
        await handlers.summaryGET(new Request("http://test"), context)
      ).json(),
    ).toEqual({ pendingCount: 3, hintsEnabled: false });
  });
  it("does not accept malformed JSON as a mutation", async () => {
    const { handlers, writes } = fixture();
    expect(
      (
        await handlers.subscribePOST(
          new Request("http://test", { method: "POST", body: "{" }),
          context,
        )
      ).status,
    ).toBe(400);
    expect(writes()).toBe(0);
  });
});
