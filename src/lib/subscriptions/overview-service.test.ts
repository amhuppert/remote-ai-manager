import { describe, expect, it, vi } from "vitest";
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
    delivery("unread", "first", {
      state: "queued",
      attemptId: "batch",
      queuedAt: at,
    }),
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
    async listSubscriptions(recipient) {
      return subscriptions.filter(
        (item) => item.recipient.conversationId === recipient.conversationId,
      );
    },
    async listDeliveries(recipient) {
      return deliveries.filter(
        (item) => item.recipient.conversationId === recipient.conversationId,
      );
    },
    async listWaits(recipient) {
      return wait.recipient.conversationId === recipient.conversationId
        ? [wait]
        : [];
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
  it("keeps expired passive wait sources inspectable but excludes them from following and paused counts", async () => {
    const h = harness();
    h.subscriptions[0] = subscription("first", {
      mode: "passive",
      expiresAt: at,
      pausedAt: at,
    });
    const all = await h.service.overview({ status: "all" });
    expect(all.items).toHaveLength(2);
    expect(all.counts).toMatchObject({ following: 1, paused: 1, active: 0 });
    const following = await h.service.overview({ status: "following" });
    expect(following.items.map((view) => view.subscription.id)).toEqual([
      "second",
    ]);
  });
  it("keeps inactive historical wait errors out of attention and preserves passive follow controls after a spent wake", async () => {
    const h = harness();
    h.wait.state = "settled";
    h.wait.outcome = "expired";
    h.wait.finishedAt = at;
    h.wait.lastError = "Wait expired";
    h.batch.state = "cancelled";
    h.batch.lastError = "Wake withdrawn";
    const subscription = h.subscriptions[0];
    const delivery = h.deliveries[0];
    if (!subscription || !delivery)
      throw new Error("Expected receipt fixtures");
    subscription.mode = "passive";
    delivery.state = "superseded";
    const page = await h.service.overview({
      subscriptionId: "first",
      status: "all",
    });
    expect(page.counts.attention).toBe(0);
    expect(page.counts.following).toBe(1);
    expect(page.items[0]?.actions).toEqual(["pause", "unfollow", "active"]);
    subscription.status = "unfollowed";
    subscription.missingAt = at;
    expect(
      (await h.service.overview({ subscriptionId: "first", status: "all" }))
        .counts.attention,
    ).toBe(0);
  });
  it("uses the same source, purpose and recipient search for counts and the inbox opened from them", async () => {
    const h = harness();
    expect(
      (await h.service.inbox({ q: "run-first", state: "all" })).items.map(
        (item) => item.delivery.id,
      ),
    ).toEqual(["read", "unread"]);
    expect(
      (await h.service.inbox({ q: "not present", state: "all" })).total,
    ).toBe(0);
  });
  it("reads evidence only for scoped owners, including batch receipt queries", async () => {
    const h = harness();
    const subscriptions = vi.spyOn(h.deps, "listSubscriptions");
    const deliveries = vi.spyOn(h.deps, "listDeliveries");
    const waits = vi.spyOn(h.deps, "listWaits");
    const reads = vi.spyOn(h.deps, "listReadAt");
    await h.service.overview({ conversation: "conversation", limit: 1 });
    expect(subscriptions).toHaveBeenCalledExactlyOnceWith(recipient);
    expect(deliveries).toHaveBeenCalledExactlyOnceWith(recipient);
    expect(waits).toHaveBeenCalledExactlyOnceWith(recipient);
    expect(reads).toHaveBeenCalledExactlyOnceWith(recipient);
    subscriptions.mockClear();
    deliveries.mockClear();
    waits.mockClear();
    reads.mockClear();
    await h.service.inbox({ batchId: "batch", state: "all", limit: 6 });
    expect(deliveries).toHaveBeenCalledExactlyOnceWith(recipient);
    expect(reads).toHaveBeenCalledExactlyOnceWith(recipient);
  });
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
      counts: { following: 2, active: 1, paused: 1, pending: 1, attention: 1 },
    });
    expect(page.items[0]).toMatchObject({
      subscription: { id: "second" },
      owner: { target: { scope: "session" } },
      pendingCount: 0,
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
      counts: { pending: 1, accepted: 1, issues: 1, unread: 2 },
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
      "queued",
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
    expect(pending).toMatchObject({
      total: 0,
      counts: { pending: 0, issues: 1 },
    });
    expect(pending.items).toEqual([]);
    const overview = await h.service.overview({
      conversation: "conversation",
      status: "all",
    });
    expect(overview.counts.pending).toBe(0);
    expect(
      overview.items.find((item) => item.subscription.id === "first"),
    ).toMatchObject({ pendingCount: 0 });
    const history = await h.service.inbox({
      conversation: "conversation",
      state: "all",
    });
    expect(history).toMatchObject({
      total: 3,
      counts: { pending: 0, accepted: 1, unread: 2 },
    });
    expect(
      history.items.find((item) => item.delivery.id === "unread"),
    ).toMatchObject({
      delivery: { state: "queued", acceptedAt: null },
      readAt: null,
    });
    expect(
      (await h.service.detail(recipient, "first"))?.subscription.status,
    ).toBe("unfollowed");
    expect(h.deliveries.map((item) => item.state)).toEqual([
      "queued",
      "accepted",
      "uncertain",
    ]);
  });
  it("offers resume for an unfollowed own-conversation notice source only to an eligible recipient", async () => {
    const h = harness();
    h.subscriptions[1] = subscription("second", {
      source: { kind: "conversation", id: recipient.conversationId },
      mode: "passive",
      status: "unfollowed",
      unfollowedAt: at,
      expiresAt: null,
    });
    const view = async () =>
      (await h.service.overview({ subscriptionId: "second", status: "all" }))
        .items[0];
    expect(await view()).toMatchObject({
      actions: ["resume"],
      pendingCount: 0,
    });
    h.owners[0] = { ...owner(), eligible: false };
    expect((await view())?.actions).toEqual([]);
    h.owners[0] = { ...owner("conversation", "session", true), eligible: true };
    expect((await view())?.actions).toEqual([]);
    h.owners[0] = owner();
    h.subscriptions[1].source = { kind: "conversation", id: "peer" };
    expect((await view())?.actions).toEqual([]);
    h.subscriptions[1].source = { kind: "notepad", id: "notes" };
    expect((await view())?.actions).toEqual([]);
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
  it("offers a fresh wait after a spent generation but respects a selected passive event filter", async () => {
    const h = harness();
    h.subscriptions[0] = subscription("first", { mode: "passive" });
    h.wait.batchId = null;
    const actions = async () =>
      (await h.service.overview({ subscriptionId: "first", status: "all" }))
        .items[0]?.actions;
    for (const state of ["settled", "cancelled"] as const) {
      h.wait.state = state;
      expect(await actions()).toContain("active");
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
