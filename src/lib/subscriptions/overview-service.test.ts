import { describe, expect, it } from "vitest";
import {
  conversationSubscriptionSchema,
  subscriptionDeliverySchema,
  type SubscriptionRecipient,
} from "./schemas";
import {
  activeSubscriptionWaitSchema,
  subscriptionWakeBatchSchema,
} from "./active-wait-schemas";
import {
  createSubscriptionOverviewService,
  type SubscriptionOverviewDeps,
  type SubscriptionOverviewOwner,
} from "./overview-service";

const at = "2026-09-30T12:00:00.000Z";
const recipient = { projectPath: "/repo", conversationId: "conversation" };
function subscription(id: string, extra: Record<string, unknown> = {}) {
  return conversationSubscriptionSchema.parse({
    id,
    recipient,
    source: { kind: "validation", id: `run-${id}` },
    reason: "Continue after tests",
    mode: "active",
    eventKinds: null,
    expiresAt: "2026-10-01T12:00:00.000Z",
    status: "following",
    cursor: null,
    createdAt: at,
    updatedAt: at,
    unfollowedAt: null,
    pausedAt: null,
    missingAt: null,
    lastError: null,
    ...extra,
  });
}
function delivery(
  id: string,
  subscriptionId: string,
  extra: Record<string, unknown> = {},
) {
  return subscriptionDeliverySchema.parse({
    id,
    subscriptionId,
    recipient,
    source: { kind: "validation", id: `run-${subscriptionId}` },
    fact: {
      occurrenceId: id,
      eventKind: "validation-completed",
      category: "outcome",
      sourceTitle: "Tests",
      summary: "Tests passed",
      occurredAt: at,
      revision: null,
      outcome: "passed",
      retrievalHandle: "cctl validate status",
      actorConversationId: null,
    },
    recordedAt: at,
    state: "pending",
    attemptId: null,
    attemptCount: 0,
    queuedAt: null,
    acceptedAt: null,
    finishedAt: null,
    lastError: null,
    ...extra,
  });
}
function owner(
  id = "conversation",
  sessionName: string | null = "session",
  archived = false,
): SubscriptionOverviewOwner {
  return {
    owner: {
      target:
        sessionName === null
          ? { scope: "project", projectName: "repo", conversationId: id }
          : {
              scope: "session",
              projectName: "repo",
              sessionName,
              conversationId: id,
            },
      projectPath: "/repo",
      conversationTitle: id,
      archived,
    },
    eligible: !archived,
  };
}
function harness() {
  const subscriptions = [
    subscription("first"),
    subscription("second", { mode: "passive", pausedAt: at }),
  ];
  const deliveries = [
    delivery("unread", "first"),
    delivery("read", "first", { state: "accepted", acceptedAt: at }),
    delivery("problem", "second", {
      state: "uncertain",
      lastError: "Acceptance unknown",
    }),
  ];
  const wait = activeSubscriptionWaitSchema.parse({
    id: "wait",
    subscriptionId: "first",
    recipient,
    source: { kind: "validation", id: "run-first" },
    reason: "Continue",
    expiresAt: "2026-10-01T12:00:00.000Z",
    state: "ready",
    outcome: "source_terminal",
    deliveryId: "unread",
    batchId: "batch",
    causationBatchIds: [],
    createdAt: at,
    updatedAt: at,
    finishedAt: null,
    lastError: null,
  });
  const batch = subscriptionWakeBatchSchema.parse({
    id: "batch",
    recipient,
    waitIds: ["wait"],
    deliveryIds: ["unread"],
    state: "queued",
    queueMessageId: "batch",
    message: "Wake facts",
    causationBatchIds: [],
    createdAt: at,
    updatedAt: at,
    finishedAt: null,
    lastError: null,
  });
  const owners = [
    owner(),
    owner("project-conversation", null),
    owner("archived", "old", true),
  ];
  const deps: SubscriptionOverviewDeps = {
    async listSubscriptions() {
      return subscriptions;
    },
    async listDeliveries() {
      return deliveries;
    },
    async listWaits() {
      return [wait];
    },
    async getBatch(id) {
      return id === batch.id ? batch : null;
    },
    async listReadAt(_recipient: SubscriptionRecipient) {
      return new Map([["read", at]]);
    },
    async listOwners() {
      return owners;
    },
    async readSource(_recipient, source) {
      return { title: `Source ${source.id}`, href: `/source/${source.id}` };
    },
    async readHold() {
      return "Subscription recipient is waiting for an answer";
    },
    async readQueueStatus() {
      return "pending";
    },
    async readRateLimitUntil() {
      return null;
    },
    now() {
      return at;
    },
  };
  return {
    deps,
    subscriptions,
    deliveries,
    wait,
    batch,
    owners,
    service: createSubscriptionOverviewService(deps),
  };
}
describe("subscription overview projections", () => {
  it("filters by recipient scope and returns counts independently of the selected status page", async () => {
    const h = harness();
    h.subscriptions.push(
      subscription("project", {
        recipient: { ...recipient, conversationId: "project-conversation" },
      }),
    );
    const page = await h.service.overview({
      project: "repo",
      session: "session",
      status: "paused",
      limit: 1,
    });
    expect(page).toMatchObject({
      total: 1,
      limit: 1,
      counts: { following: 2, active: 1, paused: 1, pending: 2, attention: 1 },
    });
    expect(page.items[0]).toMatchObject({
      subscription: { id: "second" },
      owner: { target: { scope: "session" } },
      pendingCount: 1,
      unreadCount: 1,
    });
  });
  it("keeps human read state separate from runtime acceptance and includes the wake batch link", async () => {
    const h = harness();
    const page = await h.service.inbox({
      conversation: "conversation",
      state: "all",
      read: "unread",
      limit: 1,
      offset: 1,
    });
    expect(page).toMatchObject({
      total: 2,
      counts: { pending: 2, accepted: 1, issues: 1, unread: 2 },
      offset: 1,
      limit: 1,
    });
    const all = await h.service.inbox({
      conversation: "conversation",
      state: "all",
    });
    expect(all.items.find((item) => item.delivery.id === "read")).toMatchObject(
      { readAt: at, delivery: { state: "accepted" } },
    );
    expect(
      all.items.find((item) => item.delivery.id === "unread"),
    ).toMatchObject({ readAt: null, wakeBatchId: "batch" });
    expect(h.deliveries.map((item) => item.state)).toEqual([
      "pending",
      "accepted",
      "uncertain",
    ]);
  });
  it("excludes unfollowed evidence from pending views and counts while retaining it in history", async () => {
    const h = harness();
    h.subscriptions[0] = subscription("first", {
      status: "unfollowed",
      unfollowedAt: at,
    });
    const pending = await h.service.inbox({ conversation: "conversation" });
    expect(pending).toMatchObject({ total: 1, counts: { pending: 1 } });
    expect(pending.items.map((item) => item.delivery.id)).toEqual(["problem"]);
    const overview = await h.service.overview({
      conversation: "conversation",
      status: "all",
    });
    expect(overview.counts.pending).toBe(1);
    expect(
      overview.items.find((item) => item.subscription.id === "first"),
    ).toMatchObject({ pendingCount: 0 });
    const history = await h.service.inbox({
      conversation: "conversation",
      state: "all",
    });
    expect(history).toMatchObject({
      total: 3,
      counts: { pending: 1, accepted: 1, unread: 2 },
    });
    expect(
      history.items.find((item) => item.delivery.id === "unread"),
    ).toMatchObject({
      delivery: { state: "pending", acceptedAt: null },
      readAt: null,
    });
    expect(
      (await h.service.detail(recipient, "first"))?.subscription.status,
    ).toBe("unfollowed");
    expect(h.deliveries.map((item) => item.state)).toEqual([
      "pending",
      "accepted",
      "uncertain",
    ]);
  });
  it("filters a requested wake batch before pagination even beyond the first hundred inbox records", async () => {
    const h = harness();
    for (let index = 0; index < 150; index++)
      h.deliveries.unshift(delivery(`older-${index}`, "second"));
    const page = await h.service.inbox({
      conversation: "conversation",
      batchId: "batch",
      state: "all",
      limit: 6,
    });
    expect(page.total).toBe(1);
    expect(page.items[0]?.delivery.id).toBe("unread");
    expect(page.counts.pending).toBe(1);
    expect(
      (
        await h.service.inbox({
          conversation: "other",
          batchId: "batch",
          state: "all",
        })
      ).items,
    ).toEqual([]);
  });
  it("offers pending-batch controls but refuses to advertise them after delivery begins", async () => {
    const h = harness();
    const pending = await h.service.overview({ subscriptionId: "first" });
    expect(pending.items[0]?.actions).toContain("pause");
    expect(pending.items[0]?.holdReason).toBe(
      "Subscription recipient is waiting for an answer",
    );
    h.deps.readQueueStatus = async () => "delivering";
    expect(
      (await h.service.overview({ subscriptionId: "first" })).items[0]?.actions,
    ).toEqual([]);
  });
  it("offers only explicit cancellation for an uncertain wake whose queue row is missing", async () => {
    const h = harness();
    h.batch.state = "uncertain";
    h.deps.readQueueStatus = async () => null;
    expect(
      (await h.service.overview({ subscriptionId: "first" })).items[0]?.actions,
    ).toEqual(["cancel"]);
    h.deps.readQueueStatus = async () => "uncertain";
    expect(
      (await h.service.overview({ subscriptionId: "first" })).items[0]?.actions,
    ).toEqual([]);
  });
  it("offers restoration of a paused passive finite wait without renewing its lifetime", async () => {
    const h = harness();
    h.subscriptions[0] = subscription("first", {
      mode: "passive",
      pausedAt: at,
    });
    h.wait.batchId = null;
    for (const state of ["waiting", "ready"] as const) {
      h.wait.state = state;
      const view = (
        await h.service.overview({ subscriptionId: "first", status: "all" })
      ).items[0];
      expect(view?.actions).toContain("active");
      expect(view?.actions).toContain("resume");
      expect(view?.actions).toContain("cancel");
      expect(view?.wait?.expiresAt).toBe("2026-10-01T12:00:00.000Z");
    }
  });
  it("keeps spent finite waits inspectable without offering delivery controls", async () => {
    const h = harness();
    h.wait.batchId = null;
    const view = async () =>
      (await h.service.overview({ subscriptionId: "first", status: "all" }))
        .items[0];
    for (const state of ["settled", "cancelled"] as const) {
      h.wait.state = state;
      expect(await view()).toMatchObject({ wait: { state }, actions: [] });
    }
    h.wait.state = "ready";
    const outcome = h.deliveries.find((item) => item.id === h.wait.deliveryId);
    if (!outcome) throw Error("Expected finite outcome delivery");
    outcome.state = "accepted";
    outcome.acceptedAt = at;
    expect((await view())?.actions).toEqual([]);
    const subscription = h.subscriptions[0];
    if (!subscription) throw Error("Expected finite subscription");
    subscription.mode = "passive";
    expect((await view())?.actions).toEqual([]);
    subscription.mode = "active";
    outcome.state = "pending";
    outcome.acceptedAt = null;
    h.wait.batchId = h.batch.id;
    h.batch.state = "accepted";
    expect(await view()).toMatchObject({
      batch: { state: "accepted" },
      actions: [],
    });
  });
  it("withholds active mode for a spent finite wait or a selected passive event filter", async () => {
    const h = harness();
    h.subscriptions[0] = subscription("first", { mode: "passive" });
    h.wait.batchId = null;
    const actions = async () =>
      (await h.service.overview({ subscriptionId: "first", status: "all" }))
        .items[0]?.actions;
    for (const state of ["settled", "cancelled"] as const) {
      h.wait.state = state;
      expect(await actions()).not.toContain("active");
    }
    h.wait.state = "ready";
    const outcome = h.deliveries.find((item) => item.id === h.wait.deliveryId);
    if (!outcome) throw Error("Expected finite outcome delivery");
    outcome.state = "accepted";
    outcome.acceptedAt = at;
    expect(await actions()).not.toContain("active");
    outcome.state = "pending";
    outcome.acceptedAt = null;
    h.subscriptions[0].eventKinds = ["validation-completed"];
    expect(await actions()).not.toContain("active");
    h.deps.listWaits = async () => [];
    expect(await actions()).not.toContain("active");
  });
  it("returns eligible recipient choices with project scope, search and pagination", async () => {
    const h = harness();
    h.owners.push({ ...owner("owned"), eligible: false });
    const page = await h.service.recipients({
      project: "repo",
      q: "project",
      limit: 1,
    });
    expect(page).toMatchObject({ total: 1, limit: 1 });
    expect(page.items[0]?.target).toEqual({
      scope: "project",
      projectName: "repo",
      conversationId: "project-conversation",
    });
  });
  it("does not advertise controls for a recipient currently owned by another execution", async () => {
    const h = harness();
    h.owners[0] = { ...owner(), eligible: false };
    const page = await h.service.overview({ subscriptionId: "second" });
    expect(page.items[0]?.actions).toEqual([]);
  });
  it("retains completed finite waits for inspection while removing them from following and active work", async () => {
    const h = harness();
    h.wait.state = "settled";
    h.batch.state = "accepted";
    const following = await h.service.overview({
      conversation: "conversation",
    });
    expect(following.items.map((item) => item.subscription.id)).toEqual([
      "second",
    ]);
    expect(following.counts).toMatchObject({
      following: 1,
      active: 0,
      paused: 1,
    });
    const history = await h.service.overview({
      conversation: "conversation",
      status: "all",
    });
    expect(
      history.items.find((item) => item.subscription.id === "first"),
    ).toMatchObject({
      wait: { state: "settled" },
      batch: { state: "accepted" },
    });
    h.wait.state = "cancelled";
    expect((await h.service.overview({ subscriptionId: "first" })).total).toBe(
      0,
    );
    expect((await h.service.detail(recipient, "first"))?.wait?.state).toBe(
      "cancelled",
    );
  });
  it("preserves accepted batch evidence in detail and separates rate limiting from user pause", async () => {
    const h = harness();
    h.batch.state = "accepted";
    h.deps.readRateLimitUntil = async () => "2026-09-30T12:00:30.000Z";
    const detail = await h.service.detail(recipient, "first");
    expect(detail).toMatchObject({
      subscription: { id: "first" },
      wait: { id: "wait" },
      batch: { id: "batch", state: "accepted" },
    });
    expect(
      await h.service.detail(
        { ...recipient, conversationId: "other" },
        "first",
      ),
    ).toBeNull();
    const page = await h.service.overview({
      subscriptionId: "first",
      status: "all",
    });
    expect(page.items[0]?.rateLimitUntil).toBeNull();
  });
});
