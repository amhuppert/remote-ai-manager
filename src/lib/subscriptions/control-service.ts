import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ConversationSubscriptionsRepo } from "@/lib/state-store/conversation-subscriptions-repo";
import type {
  ConversationSubscriptionWaitsRepo,
  SubscriptionControlChange,
} from "@/lib/state-store/conversation-subscription-waits-repo";
import type { ConversationSubscriptionPreferencesRepo } from "@/lib/state-store/conversation-subscription-preferences-repo";
import {
  activeWaitSourceSchema,
  type SubscriptionWakeBatch,
} from "./active-wait-schemas";
import type { ActiveWaitService } from "./active-wait-service";
import {
  conversationSubscriptionSchema,
  subscriptionRecipientSchema,
  subscriptionSourceRefSchema,
  type ConversationSubscription,
  type SubscriptionRecipient,
  type SubscriptionSourceRef,
  type SourceReadResult,
} from "./schemas";
export class SubscriptionControlError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SubscriptionControlError";
  }
}
export interface SubscribeInput {
  recipient: SubscriptionRecipient;
  source: SubscriptionSourceRef;
  reason: string;
  mode?: "passive" | "active";
  eventKinds?: string[] | null;
  expiresAt?: string | null;
}
export interface SubscriptionControlsService {
  subscribe(input: SubscribeInput): Promise<ConversationSubscription | null>;
  get(
    recipient: SubscriptionRecipient,
    id: string,
  ): Promise<ConversationSubscription | null>;
  pause(
    recipient: SubscriptionRecipient,
    id: string,
  ): Promise<ConversationSubscription | null>;
  resume(
    recipient: SubscriptionRecipient,
    id: string,
  ): Promise<ConversationSubscription | null>;
  setMode(
    recipient: SubscriptionRecipient,
    id: string,
    mode: "passive" | "active",
    expiresAt?: string,
  ): Promise<ConversationSubscription | null>;
  cancel(
    recipient: SubscriptionRecipient,
    id: string,
  ): Promise<ConversationSubscription | null>;
  unfollow(
    recipient: SubscriptionRecipient,
    id: string,
  ): Promise<ConversationSubscription | null>;
  getPreferences(
    recipient: SubscriptionRecipient,
  ): Promise<{ hintsEnabled: boolean }>;
  setHintsEnabled(
    recipient: SubscriptionRecipient,
    enabled: boolean,
  ): Promise<{ hintsEnabled: boolean }>;
  markDeliveryRead(
    recipient: SubscriptionRecipient,
    id: string,
    read: boolean,
  ): Promise<boolean>;
  getReadAt(
    recipient: SubscriptionRecipient,
    id: string,
  ): Promise<string | null>;
  listReadAt(recipient: SubscriptionRecipient): Promise<Map<string, string>>;
}
export interface SubscriptionControlsDeps {
  repo: ConversationSubscriptionsRepo;
  waits?: ConversationSubscriptionWaitsRepo;
  activeWaits?: ActiveWaitService;
  preferences?: ConversationSubscriptionPreferencesRepo;
  isRecipientEligible(recipient: SubscriptionRecipient): Promise<boolean>;
  readSource?(
    recipient: SubscriptionRecipient,
    source: SubscriptionSourceRef,
  ): Promise<SourceReadResult>;
  validateSelection?(input: SubscribeInput): Promise<void>;
  withdrawPendingWake?(
    batch: SubscriptionWakeBatch,
    commit: () => void,
  ): Promise<boolean>;
  now?(): string;
  newId?(): string;
  onChange?(
    recipient: SubscriptionRecipient,
    source?: SubscriptionSourceRef,
  ): void;
}
const subscribeSchema = z
  .object({
    recipient: subscriptionRecipientSchema,
    source: subscriptionSourceRefSchema,
    reason: z
      .string()
      .min(1)
      .max(1000)
      .refine((value) => value.trim().length > 0),
    mode: z.enum(["passive", "active"]).optional(),
    eventKinds: z.array(z.string().min(1)).min(1).nullable().optional(),
    expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .strict();
export function createSubscriptionControlsService(
  deps: SubscriptionControlsDeps,
): SubscriptionControlsService {
  const now = deps.now ?? (() => new Date().toISOString());
  async function eligible(recipient: SubscriptionRecipient) {
    subscriptionRecipientSchema.parse(recipient);
    if (!(await deps.isRecipientEligible(recipient)))
      throw new SubscriptionControlError(
        "SUBSCRIPTION_RECIPIENT_INELIGIBLE",
        "Subscription controls require an ordinary, unowned, unarchived conversation.",
        409,
      );
  }
  async function apply(
    recipient: SubscriptionRecipient,
    id: string,
    change: SubscriptionControlChange,
  ) {
    await eligible(recipient);
    const current = await deps.repo.get(recipient, id);
    if (!current) return null;
    const at = now();
    const wait = await deps.waits?.get(recipient, id);
    const batch = wait?.batchId
      ? await deps.waits?.getBatch(wait.batchId)
      : null;
    if (batch && batch.state !== "accepted" && batch.state !== "cancelled") {
      if (
        change.cancelWait &&
        batch.state === "uncertain" &&
        deps.activeWaits
      ) {
        await deps.activeWaits.cancel(recipient, id);
        const result = await deps.repo.get(recipient, id);
        deps.onChange?.(recipient, current.source);
        return result;
      }
      if (
        !deps.waits ||
        !deps.withdrawPendingWake ||
        (batch.state !== "planned" && batch.state !== "queued")
      )
        throw new SubscriptionControlError(
          "ACTIVE_WAIT_QUEUE_REVIEW_REQUIRED",
          "This wake may have reached backend input. Review its queue message before changing this subscription.",
          409,
        );
      const waits = deps.waits;
      const withdrawn = await deps.withdrawPendingWake(batch, () =>
        waits.applyControlWithinWrite(recipient, id, change, at, batch.id),
      );
      if (!withdrawn)
        throw new SubscriptionControlError(
          "ACTIVE_WAIT_QUEUE_REVIEW_REQUIRED",
          "This wake is delivering or needs review, or its attempted queue row is missing. Review the wake before changing this subscription.",
          409,
        );
    } else if (deps.waits)
      await deps.waits.applyControl(recipient, id, change, at);
    else
      await deps.repo.updateControls(
        recipient,
        id,
        { ...current, ...change },
        at,
      );
    const result = await deps.repo.get(recipient, id);
    deps.onChange?.(recipient, current.source);
    return result;
  }
  function preferences() {
    if (!deps.preferences)
      throw Error("Subscription preference repository is required");
    return deps.preferences;
  }
  return {
    async subscribe(input) {
      const parsed = subscribeSchema.parse(input);
      await eligible(parsed.recipient);
      await deps.validateSelection?.(parsed);
      const current = await deps.repo.findBySource(
        parsed.recipient,
        parsed.source,
      );
      const retainedWait = current
        ? await deps.waits?.get(parsed.recipient, current.id)
        : null;
      if (retainedWait) {
        const delivery = retainedWait.deliveryId
          ? await deps.repo.getDelivery(
              parsed.recipient,
              retainedWait.deliveryId,
            )
          : null;
        if (
          retainedWait.state === "settled" ||
          retainedWait.state === "cancelled" ||
          delivery?.state === "accepted"
        )
          throw new SubscriptionControlError(
            "ACTIVE_WAIT_SPENT",
            "This source's finite wait is already spent. Choose another source to subscribe again.",
            409,
          );
        if (parsed.reason !== retainedWait.reason)
          throw new SubscriptionControlError(
            "ACTIVE_WAIT_REASON_LOCKED",
            "An existing finite wait keeps its original reason. Use its recorded reason when changing mode or resuming.",
            409,
          );
        if (
          parsed.expiresAt != null &&
          parsed.expiresAt !== retainedWait.expiresAt
        )
          throw new SubscriptionControlError(
            "ACTIVE_WAIT_EXPIRY_LOCKED",
            "An existing finite wait keeps its original expiry.",
            409,
          );
      }
      if (parsed.mode === "active") {
        const source = activeWaitSourceSchema.safeParse(parsed.source);
        if (!source.success)
          throw new SubscriptionControlError(
            "ACTIVE_WAIT_UNSUPPORTED_SOURCE",
            "Only workflow, validation, and Git job sources support active one-time waits.",
            400,
          );
        const wait = current
          ? await deps.waits?.get(parsed.recipient, current.id)
          : null;
        if (wait) {
          const delivery = wait.deliveryId
            ? await deps.repo.getDelivery(parsed.recipient, wait.deliveryId)
            : null;
          if (
            wait.state === "settled" ||
            wait.state === "cancelled" ||
            delivery?.state === "accepted"
          )
            throw new SubscriptionControlError(
              "ACTIVE_WAIT_SPENT",
              "This source's finite wait is already spent and cannot be rearmed.",
              409,
            );
          if (parsed.expiresAt != null && parsed.expiresAt !== wait.expiresAt)
            throw new SubscriptionControlError(
              "ACTIVE_WAIT_EXPIRY_LOCKED",
              "An existing finite wait keeps its original expiry.",
              409,
            );
          return apply(parsed.recipient, wait.subscriptionId, {
            mode: "active",
            status: "following",
            pausedAt: null,
            reason: parsed.reason,
            eventKinds: parsed.eventKinds ?? null,
          });
        }
        if (!deps.activeWaits) throw Error("Active wait service is required");
        const registered = await deps.activeWaits.register({
          recipient: parsed.recipient,
          source: source.data,
          reason: parsed.reason,
          ...(parsed.expiresAt == null ? {} : { expiresAt: parsed.expiresAt }),
        });
        deps.onChange?.(parsed.recipient, parsed.source);
        return deps.repo.get(parsed.recipient, registered.subscriptionId);
      }
      if (current)
        return apply(parsed.recipient, current.id, {
          status: "following",
          mode: "passive",
          pausedAt: null,
          reason: parsed.reason,
          eventKinds: parsed.eventKinds ?? null,
          expiresAt: retainedWait?.expiresAt ?? parsed.expiresAt ?? null,
        });
      const at = now();
      const baseline = await deps.readSource?.(parsed.recipient, parsed.source);
      const result = await deps.repo.createIfAbsent(
        conversationSubscriptionSchema.parse({
          id: (deps.newId ?? randomUUID)(),
          recipient: parsed.recipient,
          source: parsed.source,
          reason: parsed.reason,
          mode: "passive",
          eventKinds: parsed.eventKinds ?? null,
          expiresAt: parsed.expiresAt ?? null,
          status: "following",
          cursor: baseline?.cursor ?? null,
          createdAt: at,
          updatedAt: at,
          unfollowedAt: null,
          pausedAt: null,
          missingAt: baseline?.missing ? at : null,
          lastError: null,
        }),
      );
      deps.onChange?.(parsed.recipient, parsed.source);
      return result;
    },
    get: (recipient, id) => deps.repo.get(recipient, id),
    pause: (recipient, id) => apply(recipient, id, { pausedAt: now() }),
    resume: (recipient, id) => apply(recipient, id, { pausedAt: null }),
    async setMode(recipient, id, mode, expiresAt) {
      await eligible(recipient);
      const current = await deps.repo.get(recipient, id);
      if (!current) return null;
      await deps.validateSelection?.({
        recipient,
        source: current.source,
        reason: current.reason,
        mode,
        eventKinds: current.eventKinds,
      });
      if (mode === "passive") return apply(recipient, id, { mode });
      const parsed = activeWaitSourceSchema.safeParse(current.source);
      if (!parsed.success)
        throw new SubscriptionControlError(
          "ACTIVE_WAIT_UNSUPPORTED_SOURCE",
          "Only workflow, validation, and Git job sources support active one-time waits.",
          400,
        );
      const wait = await deps.waits?.get(recipient, id);
      if (wait) {
        const delivery = wait.deliveryId
          ? await deps.repo.getDelivery(recipient, wait.deliveryId)
          : null;
        if (
          wait.state === "cancelled" ||
          wait.state === "settled" ||
          delivery?.state === "accepted"
        )
          throw new SubscriptionControlError(
            "ACTIVE_WAIT_SPENT",
            "This source's finite wait is already spent and cannot be rearmed.",
            409,
          );
        if (expiresAt !== undefined && expiresAt !== wait.expiresAt)
          throw new SubscriptionControlError(
            "ACTIVE_WAIT_EXPIRY_LOCKED",
            "An existing finite wait keeps its original expiry.",
            409,
          );
        return apply(recipient, id, { mode: "active", status: "following" });
      }
      if (!deps.activeWaits) throw Error("Active wait service is required");
      await deps.activeWaits.register(
        {
          recipient,
          source: parsed.data,
          reason: current.reason,
          ...(expiresAt === undefined ? {} : { expiresAt }),
        },
        { pausedAt: current.pausedAt },
      );
      deps.onChange?.(recipient, current.source);
      return deps.repo.get(recipient, id);
    },
    async cancel(recipient, id) {
      await eligible(recipient);
      if (!(await deps.waits?.get(recipient, id))) {
        if (!(await deps.repo.get(recipient, id))) return null;
        throw new SubscriptionControlError(
          "SUBSCRIPTION_NOT_FINITE_WAIT",
          "This subscription has no finite wait to cancel; unfollow it instead.",
          400,
        );
      }
      return apply(recipient, id, { status: "unfollowed", cancelWait: true });
    },
    unfollow: (recipient, id) =>
      apply(recipient, id, { status: "unfollowed", cancelWait: true }),
    getPreferences: (recipient) => preferences().getPreferences(recipient),
    async setHintsEnabled(recipient, enabled) {
      await eligible(recipient);
      const result = await preferences().setHintsEnabled(recipient, enabled);
      deps.onChange?.(recipient);
      return result;
    },
    async markDeliveryRead(recipient, id, read) {
      await eligible(recipient);
      const result = await preferences().markDeliveryRead(
        recipient,
        id,
        read,
        now(),
      );
      if (result) deps.onChange?.(recipient);
      return result;
    },
    getReadAt: (recipient, id) => preferences().getReadAt(recipient, id),
    listReadAt: (recipient) => preferences().listReadAt(recipient),
  };
}
