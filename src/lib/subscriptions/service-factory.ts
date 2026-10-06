import { createNotepadCommentsRepo } from "@/lib/state-store/notepad-comments-repo";
import { createGraphWorkflowResultDeliveriesRepo } from "@/lib/state-store/graph-workflow-result-deliveries-repo";
import { withdrawSubscriptionWakeFromQueue } from "./wake-queue-control";
import { validateSubscriptionSelection } from "./catalog";
import { createConversationSubscriptionPreferencesRepo } from "@/lib/state-store/conversation-subscription-preferences-repo";
import {
  createSubscriptionControlsService,
  SubscriptionControlError,
} from "./control-service";
import { publishSubscriptionChange } from "./events";
import { randomUUID } from "node:crypto";
import { getGlobalSingleton } from "@/lib/shared/global-singleton";
import { getStateDb } from "@/lib/state-store/store";
import {
  getSharedWriteQueue,
  type WriteQueue,
} from "@/lib/state-store/write-queue";
import type { Db } from "@/lib/state-store/schemas";
import { createConversationSubscriptionsRepo } from "@/lib/state-store/conversation-subscriptions-repo";
import { createConversationsRepo } from "@/lib/state-store/conversations-repo";
import { createProjectConversationsRepo } from "@/lib/state-store/project-conversations-repo";
import { createSessionsRepo } from "@/lib/state-store/sessions-repo";
import { createNotepadsRepo } from "@/lib/state-store/notepads-repo";
import { createSpecsRepo } from "@/lib/state-store/specs-repo";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createTicketsRepo } from "@/lib/state-store/tickets-repo";
import { createGraphWorkflowExecutionsRepo } from "@/lib/state-store/graph-workflow-executions-repo";
import { createGraphWorkflowArchivedExecutionsRepo } from "@/lib/state-store/graph-workflow-archived-executions-repo";
import { createGraphWorkflowEventsRepo } from "@/lib/state-store/graph-workflow-events-repo";
import { createValidationRunsRepo } from "@/lib/state-store/validation-runs-repo";
import { createJobsRepo } from "@/lib/jobs/repo";
import { createRunsRepo } from "@/lib/state-store/runs-repo";
import { createConversationCoreRepo } from "@/lib/state-store/conversation-core-repo";
import { createSubscriptionSourceQueriesRepo } from "@/lib/state-store/subscription-source-queries-repo";
import { createTicketStatusChangesRepo } from "@/lib/state-store/ticket-status-changes-repo";
import { createNotepadDeliveryWatermarksRepo } from "@/lib/state-store/notepad-delivery-watermarks-repo";
import {
  createConversationProvenanceReader,
  isEligibleSubscriptionRecipient,
} from "@/lib/conversations/provenance";
import { createSubscriptionService } from "./service";
import { createSubscriptionSourceReader } from "./source-adapters";
import { createTerminalSourceReader } from "./terminal-source-adapters";
import { createActiveWaitService } from "./active-wait-service";
import { createConversationSubscriptionWaitsRepo } from "@/lib/state-store/conversation-subscription-waits-repo";
import { createSubscriptionInvolvementReader } from "./involvement";
import { projectNameFromPath } from "@/lib/state-store/tickets-repo";
export { synchronizeSubscriptionInvolvement } from "./involvement";

function runSourceDeps(db: Db) {
  const runs = createRunsRepo(db);
  const core = createConversationCoreRepo(db);
  return {
    run(runId: string) {
      const run = runs.get(runId);
      return run === null ? null : { runId: run.runId, projectPath: run.projectPath, title: run.facts.title };
    },
    boundaries: (runId: string) => runs.boundaries(runId),
    question: (questionId: string) => core.getQuestion(questionId),
  };
}

export function createSubscriptionRuntime(db: Db, writeQueue: WriteQueue) {
  const repo = createConversationSubscriptionsRepo(db, writeQueue);
  const readConversation = createConversationProvenanceReader({
    conversations: createConversationsRepo(db),
    projectConversations: createProjectConversationsRepo(db),
    sessions: createSessionsRepo(db),
  });
  const notepads = createNotepadsRepo(db, writeQueue);
  const queries = createSubscriptionSourceQueriesRepo(db);
  const ticketChanges = createTicketStatusChangesRepo(db);
  const discoverInvolvement = createSubscriptionInvolvementReader({
    readConversation,
    notepads,
    queries,
    watermarks: createNotepadDeliveryWatermarksRepo(db, writeQueue),
  });
  const sourceDeps = {
    notepads,
    comments: createNotepadCommentsRepo(db, writeQueue),
    watermarks: createNotepadDeliveryWatermarksRepo(db, writeQueue),
    resultDeliveries: createGraphWorkflowResultDeliveriesRepo(db),
    tickets: createTicketsRepo(db, writeQueue),
    specs: createSpecsRepo(db, writeQueue),
    specEvents: createSpecEventsRepo(db),
    workflows: createGraphWorkflowExecutionsRepo(db),
    archivedWorkflows: createGraphWorkflowArchivedExecutionsRepo(db),
    workflowEvents: createGraphWorkflowEventsRepo(db),
    validations: createValidationRunsRepo(db),
    jobs: createJobsRepo(db),
    queries,
    ticketChanges,
    runs: runSourceDeps(db),
  };
  async function isRecipientEligible(recipient: {
    projectPath: string;
    conversationId: string;
  }) {
    return isEligibleSubscriptionRecipient(
      readConversation(recipient.conversationId),
      recipient.projectPath,
    );
  }
  function inboxGetCommand(
    recipient: { projectPath: string; conversationId: string },
    deliveryId: string,
  ): string {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const identity = readConversation(recipient.conversationId);
    const sessionFlag = identity?.sessionName
      ? ` --session=${quote(identity.sessionName)}`
      : "";
    return `cctl inbox get --project=${quote(projectNameFromPath(recipient.projectPath))}${sessionFlag} --conversation=${quote(recipient.conversationId)} -- ${quote(deliveryId)}`;
  }
  const waitsRepo = createConversationSubscriptionWaitsRepo(db, writeQueue);
  const preferencesRepo = createConversationSubscriptionPreferencesRepo(
    db,
    writeQueue,
  );
  const activeWaitService = createActiveWaitService({
    repo: waitsRepo,
    subscriptions: repo,
    onChange: publishSubscriptionChange,
    async cancelPendingWait(recipient, id) {
      await controlsService.cancel(recipient, id);
    },
    isRecipientEligible,
    readTerminalSource: createTerminalSourceReader(sourceDeps),
    async readSourceCursor(recipient, source) {
      return (
        await createSubscriptionSourceReader(sourceDeps)(
          recipient,
          source,
          null,
        )
      ).cursor;
    },
    async canDiscardMissingBatch(batch) {
      const identity = readConversation(batch.recipient.conversationId);
      if (!identity || identity.projectPath !== batch.recipient.projectPath)
        return false;
      if (
        identity.conversation.pendingQueue.some(
          (row) =>
            row.metadata?.kind === "subscription_update" &&
            row.metadata.batchId === batch.id,
        )
      )
        return false;
      const { hasTranscriptEntry } = await import("@/lib/prompt/transcript");
      return !(await hasTranscriptEntry(
        batch.recipient.conversationId,
        batch.id,
      ));
    },
    deliveryGetCommand(delivery) {
      return inboxGetCommand(delivery.recipient, delivery.id);
    },
    waitGetCommand(wait) {
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      const identity = readConversation(wait.recipient.conversationId);
      const sessionFlag = identity?.sessionName
        ? ` --session=${quote(identity.sessionName)}`
        : "";
      return `cctl subscription wait-get --project=${quote(projectNameFromPath(wait.recipient.projectPath))}${sessionFlag} --conversation=${quote(wait.recipient.conversationId)} --wait-id=${quote(wait.id)} -- ${quote(wait.subscriptionId)}`;
    },
  });
  const service = createSubscriptionService({
    repo,
    onChange: publishSubscriptionChange,
    getPreferences: (recipient) => preferencesRepo.getPreferences(recipient),
    reconcileFiniteWaits: (recipient) => activeWaitService.reconcile(recipient),
    isRecipientEligible,
    async cancelActiveWait(recipient, subscriptionId) {
      await activeWaitService.cancel(recipient, subscriptionId);
    },
    discoverInvolvement,
    readSource: createSubscriptionSourceReader(sourceDeps),
    now: () => new Date().toISOString(),
    newId: randomUUID,
    inboxGetCommand,
    inboxCommand(recipient) {
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      const identity = readConversation(recipient.conversationId);
      const sessionFlag =
        identity?.sessionName === null
          ? ""
          : identity
            ? ` --session=${quote(identity.sessionName)}`
            : "";
      return `cctl inbox list --project=${quote(projectNameFromPath(recipient.projectPath))}${sessionFlag} --conversation=${quote(recipient.conversationId)}`;
    },
  });
  const controlsService = createSubscriptionControlsService({
    repo,
    waits: waitsRepo,
    activeWaits: activeWaitService,
    preferences: preferencesRepo,
    isRecipientEligible,
    readSource: async (recipient, source) =>
      createSubscriptionSourceReader(sourceDeps)(recipient, source, null),
    onChange: publishSubscriptionChange,
    async validateSelection(input) {
      const error = validateSubscriptionSelection(
        input.source.kind,
        input.mode ?? "passive",
        input.eventKinds ?? null,
      );
      if (error)
        throw new SubscriptionControlError(
          "INVALID_SUBSCRIPTION_SELECTION",
          error,
          400,
        );
    },
    async withdrawPendingWake(batch, commit) {
      const identity = readConversation(batch.recipient.conversationId);
      if (!identity || identity.projectPath !== batch.recipient.projectPath)
        return false;
      const { hasTranscriptEntry } = await import("@/lib/prompt/transcript");
      if (await hasTranscriptEntry(batch.recipient.conversationId, batch.id))
        return false;
      const { conversationTargetStoreSessionName } =
        await import("@/lib/conversations/conversation-target");
      const projectName = projectNameFromPath(identity.projectPath);
      const target =
        identity.sessionName === null
          ? {
              scope: "project" as const,
              projectName,
              conversationId: identity.conversation.id,
            }
          : {
              scope: "session" as const,
              projectName,
              sessionName: identity.sessionName,
              conversationId: identity.conversation.id,
            };
      return withdrawSubscriptionWakeFromQueue({
        projectPath: identity.projectPath,
        sessionName: conversationTargetStoreSessionName(target),
        conversationId: identity.conversation.id,
        batchId: batch.id,
        allowMissing: batch.state === "planned",
        commit,
      });
    },
  });
  return {
    service,
    repo,
    readConversation,
    activeWaitService,
    waitsRepo,
    preferencesRepo,
    controlsService,
  };
}

export function getSubscriptionRuntime() {
  return getGlobalSingleton("__cc_subscriptions_runtime", () =>
    createSubscriptionRuntime(getStateDb(), getSharedWriteQueue()),
  );
}

export function getSubscriptionService() {
  return getSubscriptionRuntime().service;
}

export function getSubscriptionControlsService() {
  return getSubscriptionRuntime().controlsService;
}

export function getActiveWaitService() {
  return getSubscriptionRuntime().activeWaitService;
}

/** Startup-only recovery, after the previous process's runtime ownership is gone. */
export async function recoverInterruptedSubscriptionDeliveries(): Promise<number> {
  return getSubscriptionRuntime().repo.recoverOrphanedClaims(
    new Date().toISOString(),
  );
}
