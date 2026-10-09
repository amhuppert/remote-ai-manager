import { z } from "zod";
import {
  inboxOverviewQuerySchema,
  inboxOverviewSchema,
  subscriptionDetailSchema,
  subscriptionOverviewQuerySchema,
  subscriptionOverviewSchema,
  subscriptionRecipientsSchema,
  subscriptionScopeSchema,
  type SubscriptionDetail,
  type SubscriptionOverview,
  type SubscriptionOverviewQuery,
  type InboxOverview,
  type InboxOverviewQuery,
  type SubscriptionOwner,
  type SubscriptionScope,
  type SubscriptionView,
  type InboxView,
} from "./controls-schemas";
import type {
  ConversationSubscription,
  SubscriptionDelivery,
  SubscriptionRecipient,
  SubscriptionSourceRef,
} from "./schemas";
import type {
  ActiveSubscriptionWait,
  SubscriptionWakeBatch,
} from "./active-wait-schemas";
import type { PendingQueuedMessageStatus } from "@/lib/conversations/message-queue-schemas";
import { validateSubscriptionSelection } from "./catalog";
import { isActionableSubscriptionDelivery } from "./delivery-state";

export interface SubscriptionSourcePresentation {
  title: string;
  href: string | null;
}
export interface SubscriptionOverviewOwner {
  owner: SubscriptionOwner;
  eligible: boolean;
}
export type SubscriptionRecipientsQuery = SubscriptionScope & {
  q?: string;
  limit?: number;
  offset?: number;
};
export interface SubscriptionOverviewDeps {
  listSubscriptions(
    recipient: SubscriptionRecipient,
  ): Promise<ConversationSubscription[]>;
  listDeliveries(
    recipient: SubscriptionRecipient,
  ): Promise<SubscriptionDelivery[]>;
  listWaits(
    recipient: SubscriptionRecipient,
  ): Promise<ActiveSubscriptionWait[]>;
  getBatch(id: string): Promise<SubscriptionWakeBatch | null>;
  listReadAt(recipient: SubscriptionRecipient): Promise<Map<string, string>>;
  listOwners(scope: SubscriptionScope): Promise<SubscriptionOverviewOwner[]>;
  readSource(
    recipient: SubscriptionRecipient,
    source: SubscriptionSourceRef,
  ): Promise<SubscriptionSourcePresentation>;
  readHold(recipient: SubscriptionRecipient): Promise<string | null>;
  readQueueStatus(
    recipient: SubscriptionRecipient,
    batchId: string,
  ): Promise<PendingQueuedMessageStatus | null>;
  readRateLimitUntil(recipient: SubscriptionRecipient): Promise<string | null>;
  now(): string;
}
export interface SubscriptionOverviewService {
  overview(query: SubscriptionOverviewQuery): Promise<SubscriptionOverview>;
  inbox(query: InboxOverviewQuery): Promise<InboxOverview>;
  recipients(query?: SubscriptionRecipientsQuery): Promise<{
    items: SubscriptionOwner[];
    total: number;
    limit: number;
    offset: number;
  }>;
  detail(
    recipient: SubscriptionRecipient,
    id: string,
  ): Promise<SubscriptionDetail | null>;
}

const recipientsQuerySchema = subscriptionScopeSchema.extend({
  q: z.string().max(200).default(""),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
});
function recipientKey(recipient: SubscriptionRecipient): string {
  return JSON.stringify([recipient.projectPath, recipient.conversationId]);
}
function subscriptionKey(recipient: SubscriptionRecipient, id: string): string {
  return JSON.stringify([recipient.projectPath, recipient.conversationId, id]);
}
function ownerRecipient(owner: SubscriptionOwner): SubscriptionRecipient {
  return {
    projectPath: owner.projectPath,
    conversationId: owner.target.conversationId,
  };
}
export function matchesSubscriptionOwner(
  owner: SubscriptionOwner,
  scope: SubscriptionScope,
): boolean {
  return (
    (scope.project === undefined ||
      scope.project === owner.target.projectName) &&
    (scope.conversation === undefined ||
      scope.conversation === owner.target.conversationId) &&
    (scope.session === undefined ||
      (owner.target.scope === "session" &&
        scope.session === owner.target.sessionName))
  );
}
function matchesSource(
  source: SubscriptionSourceRef,
  subscriptionId: string,
  scope: SubscriptionScope,
): boolean {
  return (
    (scope.sourceKind === undefined || scope.sourceKind === source.kind) &&
    (scope.sourceId === undefined || scope.sourceId === source.id) &&
    (scope.subscriptionId === undefined ||
      scope.subscriptionId === subscriptionId)
  );
}
function needsAttention(view: SubscriptionView): boolean {
  if (view.subscription.status !== "following") return false;
  const liveWait =
    view.wait?.state === "waiting" || view.wait?.state === "ready";
  return (
    view.subscription.missingAt !== null ||
    view.subscription.lastError !== null ||
    (liveWait && view.wait?.lastError != null) ||
    view.batch?.state === "failed" ||
    view.batch?.state === "uncertain" ||
    (liveWait &&
      view.batch?.state !== "cancelled" &&
      view.batch?.state !== "accepted" &&
      view.batch?.lastError != null) ||
    view.rateLimitUntil !== null
  );
}
function isOutstanding(view: SubscriptionView, at: string): boolean {
  if (view.subscription.status !== "following") return false;
  if (view.subscription.mode === "passive")
    return (
      view.subscription.expiresAt === null || view.subscription.expiresAt > at
    );
  if (view.wait === null) return false;
  return (
    (view.wait.state === "waiting" || view.wait.state === "ready") &&
    view.batch?.state !== "accepted" &&
    view.batch?.state !== "cancelled"
  );
}
function availableActions(input: {
  subscription: ConversationSubscription;
  owner: SubscriptionOwner;
  eligible: boolean;
  wait: ActiveSubscriptionWait | null;
  waitDelivery: SubscriptionDelivery | null;
  batch: SubscriptionWakeBatch | null;
  queueStatus: PendingQueuedMessageStatus | null;
}): SubscriptionView["actions"] {
  const {
    subscription,
    owner,
    eligible,
    wait,
    waitDelivery,
    batch,
    queueStatus,
  } = input;
  if (!eligible || owner.archived) return [];
  const liveWait = wait?.state === "waiting" || wait?.state === "ready";
  if (subscription.status !== "following")
    return subscription.source.kind === "conversation" &&
      subscription.source.id === subscription.recipient.conversationId
      ? ["resume"]
      : [];
  if (
    wait &&
    ((subscription.mode === "active" &&
      (wait.state === "settled" || wait.state === "cancelled")) ||
      (liveWait &&
        (waitDelivery?.state === "accepted" || batch?.state === "accepted")))
  )
    return [];
  if (
    liveWait &&
    batch &&
    batch.state !== "accepted" &&
    batch.state !== "cancelled"
  ) {
    if (wait && batch.state === "uncertain" && queueStatus === null)
      return ["cancel"];
    if (
      queueStatus === "delivering" ||
      queueStatus === "uncertain" ||
      queueStatus === "failed"
    )
      return [];
    if (queueStatus === null && batch.state !== "planned") return [];
    if (batch.state === "uncertain" || batch.state === "failed") return [];
  }
  const actions: SubscriptionView["actions"] = [
    liveWait ? "cancel" : "unfollow",
  ];
  actions.unshift(subscription.pausedAt === null ? "pause" : "resume");
  if (subscription.mode === "active") actions.push("passive");
  else if (
    validateSubscriptionSelection(
      subscription.source.kind,
      "active",
      subscription.eventKinds,
    ) === null &&
    (!liveWait ||
      ((wait.state === "waiting" || wait.state === "ready") &&
        waitDelivery?.state !== "accepted" &&
        batch?.state !== "accepted"))
  )
    actions.push("active");
  return actions;
}

/** Reads durable evidence only: neither listing nor inspection claims backend input. */
export function createSubscriptionOverviewService(
  deps: SubscriptionOverviewDeps,
): SubscriptionOverviewService {
  async function snapshot(scope: SubscriptionScope) {
    const ownerRows = (await deps.listOwners(scope)).filter((row) =>
      matchesSubscriptionOwner(row.owner, scope),
    );
    const rows = await Promise.all(
      ownerRows.map(async ({ owner }) => {
        const recipient = ownerRecipient(owner);
        const [subscriptions, deliveries, waits] = await Promise.all([
          deps.listSubscriptions(recipient),
          deps.listDeliveries(recipient),
          deps.listWaits(recipient),
        ]);
        return { subscriptions, deliveries, waits };
      }),
    );
    const subscriptions = rows.flatMap((row) => row.subscriptions);
    const deliveries = rows.flatMap((row) => row.deliveries);
    const waits = rows.flatMap((row) => row.waits);
    const owners = new Map(
      ownerRows
        .filter((row) => matchesSubscriptionOwner(row.owner, scope))
        .map((row) => [recipientKey(ownerRecipient(row.owner)), row.owner]),
    );
    const eligible = new Set(
      ownerRows
        .filter((row) => row.eligible)
        .map((row) => recipientKey(ownerRecipient(row.owner))),
    );
    const selectedSubscriptions = subscriptions.filter(
      (subscription) =>
        owners.has(recipientKey(subscription.recipient)) &&
        matchesSource(subscription.source, subscription.id, scope),
    );
    const selectedDeliveries = deliveries.filter(
      (delivery) =>
        owners.has(recipientKey(delivery.recipient)) &&
        matchesSource(delivery.source, delivery.subscriptionId, scope),
    );
    const reads = new Map<string, Map<string, string>>();
    await Promise.all(
      [...owners].map(async ([key, owner]) =>
        reads.set(key, await deps.listReadAt(ownerRecipient(owner))),
      ),
    );
    const batchIds = new Set(
      waits
        .filter((wait) => owners.has(recipientKey(wait.recipient)))
        .flatMap((wait) => (wait.batchId ? [wait.batchId] : [])),
    );
    for (const delivery of selectedDeliveries)
      if (delivery.attemptId !== null) batchIds.add(delivery.attemptId);
    const batches = new Map<string, SubscriptionWakeBatch>();
    await Promise.all(
      [...batchIds].map(async (id) => {
        const batch = await deps.getBatch(id);
        if (batch) batches.set(id, batch);
      }),
    );
    return {
      subscriptions: selectedSubscriptions,
      deliveries: selectedDeliveries,
      waits,
      owners,
      eligible,
      reads,
      batches,
    };
  }
  async function overview(
    query: SubscriptionOverviewQuery,
  ): Promise<SubscriptionOverview> {
    const parsed = subscriptionOverviewQuerySchema.parse(query);
    const state = await snapshot(parsed);
    const sourceReads = new Map<
      string,
      Promise<SubscriptionSourcePresentation>
    >();
    const holds = new Map<string, Promise<string | null>>();
    const rateLimits = new Map<string, Promise<string | null>>();
    const views = await Promise.all(
      state.subscriptions.map(async (subscription) => {
        const owner = state.owners.get(recipientKey(subscription.recipient));
        if (!owner) return null;
        const key = recipientKey(subscription.recipient);
        const sourceKey = JSON.stringify([
          subscription.recipient.projectPath,
          subscription.source,
        ]);
        const sourceRead =
          sourceReads.get(sourceKey) ??
          deps.readSource(subscription.recipient, subscription.source);
        sourceReads.set(sourceKey, sourceRead);
        const wait =
          state.waits.find(
            (item) =>
              item.subscriptionId === subscription.id &&
              recipientKey(item.recipient) === key,
          ) ?? null;
        const batch = wait?.batchId
          ? (state.batches.get(wait.batchId) ?? null)
          : null;
        const related = state.deliveries.filter(
          (delivery) =>
            delivery.subscriptionId === subscription.id &&
            recipientKey(delivery.recipient) === key,
        );
        const activeDelivery =
          subscription.mode === "active" &&
          subscription.status === "following" &&
          wait !== null &&
          (wait.state === "waiting" || wait.state === "ready") &&
          batch?.state !== "accepted";
        let holdReason: string | null = null;
        let rateLimitUntil: string | null = null;
        if (subscription.pausedAt !== null)
          holdReason = "Subscription delivery is paused";
        else if (activeDelivery) {
          const hold = holds.get(key) ?? deps.readHold(subscription.recipient);
          holds.set(key, hold);
          holdReason = await hold;
          if (wait.batchId === null && wait.state === "ready") {
            const rateLimit =
              rateLimits.get(key) ??
              deps.readRateLimitUntil(subscription.recipient);
            rateLimits.set(key, rateLimit);
            rateLimitUntil = await rateLimit;
            if (rateLimitUntil !== null && rateLimitUntil <= deps.now())
              rateLimitUntil = null;
            if (holdReason === null && rateLimitUntil !== null)
              holdReason = "Automatic wakes are paused by the rate limit";
          }
        }
        const queueStatus = batch
          ? await deps.readQueueStatus(subscription.recipient, batch.id)
          : null;
        const source = await sourceRead;
        return {
          subscription,
          owner,
          sourceTitle: source.title,
          sourceHref: source.href,
          wait: wait
            ? {
                id: wait.id,
                subscriptionId: wait.subscriptionId,
                expiresAt: wait.expiresAt,
                state: wait.state,
                outcome: wait.outcome,
                deliveryId: wait.deliveryId,
                batchId: wait.batchId,
                createdAt: wait.createdAt,
                updatedAt: wait.updatedAt,
                finishedAt: wait.finishedAt,
                lastError: wait.lastError,
              }
            : null,
          batch: batch
            ? {
                id: batch.id,
                state: batch.state,
                createdAt: batch.createdAt,
                finishedAt: batch.finishedAt,
                lastError: batch.lastError,
              }
            : null,
          pendingCount: related.filter((delivery) =>
            isActionableSubscriptionDelivery(
              delivery,
              subscription,
              state.waits.filter(
                (item) => recipientKey(item.recipient) === key,
              ),
              deps.now(),
            ),
          ).length,
          unreadCount: related.filter(
            (delivery) => !state.reads.get(key)?.has(delivery.id),
          ).length,
          holdReason,
          rateLimitUntil,
          actions: availableActions({
            subscription,
            owner,
            eligible: state.eligible.has(key),
            wait,
            waitDelivery:
              related.find((delivery) => delivery.id === wait?.deliveryId) ??
              null,
            batch,
            queueStatus,
          }),
        } satisfies SubscriptionView;
      }),
    );
    const searched = views
      .filter((view): view is SubscriptionView => view !== null)
      .filter(
        (view) =>
          !parsed.q ||
          [
            view.sourceTitle,
            view.subscription.source.id,
            view.subscription.reason,
            view.owner.conversationTitle,
            view.owner.target.projectName,
          ]
            .join(" ")
            .toLocaleLowerCase()
            .includes(parsed.q.toLocaleLowerCase()),
      );
    const issueSubscriptions = new Set(
      state.deliveries
        .filter(
          (delivery) =>
            delivery.state === "failed" || delivery.state === "uncertain",
        )
        .map((delivery) =>
          subscriptionKey(delivery.recipient, delivery.subscriptionId),
        ),
    );
    const hasAttention = (view: SubscriptionView) =>
      needsAttention(view) ||
      issueSubscriptions.has(
        subscriptionKey(view.subscription.recipient, view.subscription.id),
      );
    const counts = {
      following: searched.filter((view) => isOutstanding(view, deps.now()))
        .length,
      active: searched.filter(
        (view) =>
          isOutstanding(view, deps.now()) &&
          view.subscription.mode === "active" &&
          view.wait !== null,
      ).length,
      paused: searched.filter(
        (view) =>
          isOutstanding(view, deps.now()) &&
          view.subscription.pausedAt !== null,
      ).length,
      pending: searched.reduce((total, view) => total + view.pendingCount, 0),
      attention: searched.filter(hasAttention).length,
    };
    const filtered = searched
      .filter((view) => {
        if (parsed.mode !== "all" && view.subscription.mode !== parsed.mode)
          return false;
        switch (parsed.status) {
          case "all":
            return true;
          case "attention":
            return hasAttention(view);
          case "paused":
            return (
              isOutstanding(view, deps.now()) &&
              view.subscription.pausedAt !== null
            );
          case "following":
            return isOutstanding(view, deps.now());
          default:
            return view.subscription.status === parsed.status;
        }
      })
      .sort(
        (a, b) =>
          b.subscription.createdAt.localeCompare(a.subscription.createdAt) ||
          a.subscription.id.localeCompare(b.subscription.id),
      );
    return subscriptionOverviewSchema.parse({
      items: filtered.slice(parsed.offset, parsed.offset + parsed.limit),
      total: filtered.length,
      limit: parsed.limit,
      offset: parsed.offset,
      counts,
    });
  }
  async function inbox(query: InboxOverviewQuery): Promise<InboxOverview> {
    const parsed = inboxOverviewQuerySchema.parse(query);
    const batch = parsed.batchId ? await deps.getBatch(parsed.batchId) : null;
    if (parsed.batchId && !batch)
      return inboxOverviewSchema.parse({
        items: [],
        total: 0,
        limit: parsed.limit,
        offset: 0,
        counts: { pending: 0, accepted: 0, issues: 0, unread: 0 },
      });
    const state = await snapshot(
      batch
        ? {
            ...parsed,
            conversation: parsed.conversation ?? batch.recipient.conversationId,
          }
        : parsed,
    );
    const sources = new Map<string, Promise<SubscriptionSourcePresentation>>();
    const searchText = new Map<string, string>();
    const views: InboxView[] = [];
    for (const delivery of state.deliveries) {
      const key = recipientKey(delivery.recipient);
      const owner = state.owners.get(key);
      if (!owner) continue;
      const sourceKey = JSON.stringify([
        delivery.recipient.projectPath,
        delivery.source,
      ]);
      const sourceRead =
        sources.get(sourceKey) ??
        deps.readSource(delivery.recipient, delivery.source);
      sources.set(sourceKey, sourceRead);
      // Every fact a wake carried names that wake as its claim, whether a wait's or a follow's.
      const batch = [...state.batches.values()].find(
        (item) =>
          recipientKey(item.recipient) === key &&
          item.id === delivery.attemptId,
      );
      const presentation = await sourceRead;
      const subscription = state.subscriptions.find(
        (item) =>
          item.id === delivery.subscriptionId &&
          recipientKey(item.recipient) === key,
      );
      searchText.set(
        delivery.id,
        [
          presentation.title,
          delivery.source.id,
          subscription?.reason ?? "",
          owner.conversationTitle,
          owner.target.projectName,
        ]
          .join(" ")
          .toLocaleLowerCase(),
      );
      views.push({
        delivery,
        owner,
        sourceHref: presentation.href,
        readAt: state.reads.get(key)?.get(delivery.id) ?? null,
        wakeBatchId: batch?.id ?? null,
      });
    }
    const scopedViews = views.filter(
      (view) =>
        (parsed.batchId === undefined || view.wakeBatchId === parsed.batchId) &&
        (!parsed.q ||
          searchText
            .get(view.delivery.id)
            ?.includes(parsed.q.toLocaleLowerCase())),
    );
    const subscriptionsById = new Map(
      state.subscriptions.map(
        (subscription) =>
          [
            subscriptionKey(subscription.recipient, subscription.id),
            subscription,
          ] as const,
      ),
    );
    const isPending = (view: InboxView) => {
      const subscription = subscriptionsById.get(
        subscriptionKey(view.delivery.recipient, view.delivery.subscriptionId),
      );
      return (
        subscription !== undefined &&
        isActionableSubscriptionDelivery(
          view.delivery,
          subscription,
          state.waits.filter(
            (item) =>
              recipientKey(item.recipient) ===
              recipientKey(view.delivery.recipient),
          ),
          deps.now(),
        )
      );
    };
    const counts = {
      pending: scopedViews.filter(isPending).length,
      accepted: scopedViews.filter((view) => view.delivery.state === "accepted")
        .length,
      issues: scopedViews.filter(
        (view) =>
          view.delivery.state === "failed" ||
          view.delivery.state === "uncertain",
      ).length,
      unread: scopedViews.filter((view) => view.readAt === null).length,
    };
    const filtered = scopedViews
      .filter((view) => {
        if (parsed.read === "read" && view.readAt === null) return false;
        if (parsed.read === "unread" && view.readAt !== null) return false;
        if (parsed.state === "all") return true;
        if (parsed.state === "issues")
          return (
            view.delivery.state === "failed" ||
            view.delivery.state === "uncertain"
          );
        return parsed.state === "accepted"
          ? view.delivery.state === "accepted"
          : isPending(view);
      })
      .sort(
        (a, b) =>
          b.delivery.recordedAt.localeCompare(a.delivery.recordedAt) ||
          a.delivery.id.localeCompare(b.delivery.id),
      );
    return inboxOverviewSchema.parse({
      items: filtered.slice(parsed.offset, parsed.offset + parsed.limit),
      total: filtered.length,
      limit: parsed.limit,
      offset: parsed.offset,
      counts,
    });
  }
  return {
    overview,
    inbox,
    async recipients(query = {}) {
      const parsed = recipientsQuerySchema.parse(query);
      const items = (await deps.listOwners(parsed))
        .filter(
          (row) =>
            row.eligible &&
            !row.owner.archived &&
            matchesSubscriptionOwner(row.owner, parsed),
        )
        .map((row) => row.owner)
        .filter(
          (owner) =>
            !parsed.q ||
            [
              owner.conversationTitle,
              owner.target.conversationId,
              owner.target.projectName,
              owner.target.scope === "session" ? owner.target.sessionName : "",
            ]
              .join(" ")
              .toLocaleLowerCase()
              .includes(parsed.q.toLocaleLowerCase()),
        )
        .sort(
          (a, b) =>
            a.conversationTitle.localeCompare(b.conversationTitle) ||
            a.target.conversationId.localeCompare(b.target.conversationId),
        );
      return subscriptionRecipientsSchema.parse({
        items: items.slice(parsed.offset, parsed.offset + parsed.limit),
        total: items.length,
        limit: parsed.limit,
        offset: parsed.offset,
      });
    },
    async detail(recipient, id) {
      const subscription = (await deps.listSubscriptions(recipient)).find(
        (item) =>
          item.id === id &&
          recipientKey(item.recipient) === recipientKey(recipient),
      );
      if (!subscription) return null;
      const wait =
        (await deps.listWaits(recipient)).find(
          (item) =>
            item.subscriptionId === id &&
            recipientKey(item.recipient) === recipientKey(recipient),
        ) ?? null;
      const batch = wait?.batchId ? await deps.getBatch(wait.batchId) : null;
      return subscriptionDetailSchema.parse({ subscription, wait, batch });
    },
  };
}
