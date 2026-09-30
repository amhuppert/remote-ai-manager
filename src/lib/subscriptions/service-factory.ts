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
import { createSubscriptionSourceQueriesRepo } from "@/lib/state-store/subscription-source-queries-repo";
import { createTicketStatusChangesRepo } from "@/lib/state-store/ticket-status-changes-repo";
import { createNotepadDeliveryWatermarksRepo } from "@/lib/state-store/notepad-delivery-watermarks-repo";
import {
  createConversationProvenanceReader,
  isEligibleSubscriptionRecipient,
} from "@/lib/conversations/provenance";
import { createSubscriptionService } from "./service";
import { createSubscriptionSourceReader } from "./source-adapters";
import { createSubscriptionInvolvementReader } from "./involvement";
import { projectNameFromPath } from "@/lib/state-store/tickets-repo";
export { synchronizeSubscriptionInvolvement } from "./involvement";

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
    ticketChanges,
    watermarks: createNotepadDeliveryWatermarksRepo(db, writeQueue),
  });
  const service = createSubscriptionService({
    repo,
    async isRecipientEligible(recipient) {
      return isEligibleSubscriptionRecipient(
        readConversation(recipient.conversationId),
        recipient.projectPath,
      );
    },
    discoverInvolvement,
    readSource: createSubscriptionSourceReader({
      notepads,
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
    }),
    now: () => new Date().toISOString(),
    newId: randomUUID,
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
  return { service, repo, readConversation };
}

function getRuntime() {
  return getGlobalSingleton("__cc_subscriptions_runtime", () =>
    createSubscriptionRuntime(getStateDb(), getSharedWriteQueue()),
  );
}

export function getSubscriptionService() {
  return getRuntime().service;
}

/** Startup-only recovery, after the previous process's runtime ownership is gone. */
export async function recoverInterruptedSubscriptionDeliveries(): Promise<number> {
  return getRuntime().repo.recoverOrphanedClaims(new Date().toISOString());
}
