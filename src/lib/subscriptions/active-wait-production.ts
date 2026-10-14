import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  getGlobalSingleton,
  getGlobalValue,
} from "@/lib/shared/global-singleton";
import {
  isEligibleSubscriptionRecipient,
  type DurableConversationIdentity,
} from "@/lib/conversations/provenance";
import {
  conversationTargetStoreSessionName,
  type ConversationTarget,
} from "@/lib/conversations/conversation-target";
import { messageQueueService } from "@/lib/conversations/message-queue-service";
import { hasTranscriptEntry } from "@/lib/prompt/transcript";
import { projectNameFromPath } from "@/lib/state-store/tickets-repo";
import type {
  RegisterActiveWaitInput,
  SubscriptionWakeBatch,
} from "./active-wait-schemas";
import { getSubscriptionRuntime } from "./service-factory";
import { createActiveWaitDispatcher } from "./active-wait-dispatch";

const logger = createLogger("subscription-wakes");
const RECONCILE_INTERVAL_MS = 5000;

function targetFor(identity: DurableConversationIdentity): ConversationTarget {
  const projectName = projectNameFromPath(identity.projectPath);
  const conversationId = identity.conversation.id;
  return identity.sessionName === null
    ? { scope: "project", projectName, conversationId }
    : {
        scope: "session",
        projectName,
        sessionName: identity.sessionName,
        conversationId,
      };
}

function queueKey(identity: DurableConversationIdentity) {
  return {
    projectPath: identity.projectPath,
    sessionName: conversationTargetStoreSessionName(targetFor(identity)),
    conversationId: identity.conversation.id,
  };
}

function getDispatcher() {
  return getGlobalSingleton("__cc_subscription_wake_dispatcher", () => {
    const runtime = getSubscriptionRuntime();
    function identityFor(batch: SubscriptionWakeBatch) {
      const identity = runtime.readConversation(batch.recipient.conversationId);
      return identity?.projectPath === batch.recipient.projectPath
        ? identity
        : null;
    }
    return createActiveWaitDispatcher({
      service: runtime.activeWaitService,
      reconcilePassive: () => runtime.service.reconcileRecordedRecipients(),
      logger,
      async observe(batch) {
        const identity = identityFor(batch);
        const row = identity?.conversation.pendingQueue.find(
          (entry) =>
            entry.metadata?.kind === "subscription_update" &&
            entry.metadata.batchId === batch.id,
        );
        return {
          recipientEligible: isEligibleSubscriptionRecipient(
            identity,
            batch.recipient.projectPath,
          ),
          accepted: await hasTranscriptEntry(
            batch.recipient.conversationId,
            batch.id,
          ),
          queueStatus: row?.status ?? null,
          error: row?.error ?? null,
        };
      },
      async enqueue(batch) {
        if (!(await runtime.waitsRepo.isBatchDispatchable(batch.id)))
          throw new Error("Subscription wake reservation is no longer current");
        const identity = identityFor(batch);
        if (
          !identity ||
          !isEligibleSubscriptionRecipient(
            identity,
            batch.recipient.projectPath,
          )
        )
          throw new Error("The wake recipient is no longer eligible");
        await messageQueueService.enqueue({
          ...queueKey(identity),
          id: batch.queueMessageId,
          inputOrigin: "generated",
          metadata: { kind: "subscription_update", batchId: batch.id },
          content: [{ type: "text", text: batch.message }],
        });
      },
      async drain(batch) {
        if (!(await runtime.waitsRepo.isBatchDispatchable(batch.id))) return;
        const identity = identityFor(batch);
        if (
          !identity ||
          !isEligibleSubscriptionRecipient(
            identity,
            batch.recipient.projectPath,
          )
        )
          return;
        const { drainCoreConversation } =
          await import("@/lib/supervision/handles");
        const key = queueKey(identity);
        await drainCoreConversation(key.conversationId);
      },
      async confirmAccepted(batch) {
        const identity = identityFor(batch);
        if (identity)
          await messageQueueService.confirmSubscriptionWakeAccepted({
            ...queueKey(identity),
            batchId: batch.id,
          });
      },
    });
  });
}

/** The actor remains the only owner of admission and holds; reconciliation is just a nudge. */
export async function reconcileActiveSubscriptionWakes(): Promise<void> {
  await getDispatcher().tick();
}

function scheduleReconciliation(): void {
  void reconcileActiveSubscriptionWakes().catch((error: unknown) => {
    logger.error("subscription.wake_reconciliation_failed", {
      error: getErrorMessage(error),
    });
  });
}

/**
 * Asks for a delivery pass now rather than at the next timer pass. Before boot
 * starts the timer, after source recovery, the boot pass delivers instead.
 */
export function requestSubscriptionWakePass(): void {
  if (getGlobalValue("__cc_subscription_wake_timer") === undefined) return;
  scheduleReconciliation();
}

/** Called after source recovery and conversation rehydration; one timer survives dev HMR. */
export function startActiveSubscriptionWakes(): void {
  getGlobalSingleton("__cc_subscription_wake_timer", () => {
    const timer = setInterval(scheduleReconciliation, RECONCILE_INTERVAL_MS);
    timer.unref();
    return timer;
  });
  scheduleReconciliation();
}

export async function stopActiveSubscriptionWakes(): Promise<void> {
  const timer = getGlobalValue<ReturnType<typeof setInterval>>(
    "__cc_subscription_wake_timer",
  );
  if (timer) clearInterval(timer);
  await getGlobalValue<ReturnType<typeof createActiveWaitDispatcher>>(
    "__cc_subscription_wake_dispatcher",
  )?.stop();
}

/** Causation comes from the hosted turn, never from a client-supplied parent id. */
export async function registerActiveSubscriptionWait(
  input: Omit<RegisterActiveWaitInput, "causationBatchIds">,
) {
  const runtime = getSubscriptionRuntime();
  const identity = runtime.readConversation(input.recipient.conversationId);
  let causationBatchIds: string[] = [];
  if (identity?.projectPath === input.recipient.projectPath) {
    const { describeCoreTurn } = await import("@/lib/supervision/handles");
    const active = describeCoreTurn(identity.conversation.id);
    if (active?.originMessageId) {
      const parent = await runtime.activeWaitService.getBatch(
        active.originMessageId,
      );
      if (
        parent?.recipient.conversationId === input.recipient.conversationId &&
        parent.recipient.projectPath === input.recipient.projectPath
      )
        causationBatchIds = [parent.id];
    }
  }
  const result = await runtime.activeWaitService.register({
    ...input,
    causationBatchIds,
  });
  scheduleReconciliation();
  return result;
}
