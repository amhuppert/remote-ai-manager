import { getGlobalSingleton } from "@/lib/shared/global-singleton";
import { getArchivedProjects, getStateDb } from "@/lib/state-store";
import { getSharedWriteQueue } from "@/lib/state-store/write-queue";
import { createConversationsRepo } from "@/lib/state-store/conversations-repo";
import { createProjectConversationsRepo } from "@/lib/state-store/project-conversations-repo";
import { createSessionsRepo } from "@/lib/state-store/sessions-repo";
import { createNotepadsRepo } from "@/lib/state-store/notepads-repo";
import {
  createTicketsRepo,
  projectNameFromPath,
} from "@/lib/state-store/tickets-repo";
import { createSpecsRepo } from "@/lib/state-store/specs-repo";
import { createValidationRunsRepo } from "@/lib/state-store/validation-runs-repo";
import { createJobsRepo } from "@/lib/jobs/repo";
import { isOrdinaryConversationRole } from "@/lib/conversations/schemas";
import { isEligibleSubscriptionRecipient } from "@/lib/conversations/provenance";
import { conversationTargetStoreSessionName } from "@/lib/conversations/conversation-target";
import { conversationsPageHref } from "@/lib/conversations/hrefs";
import { readSubscriptionWakeHold } from "@/lib/conversations/message-queue-subscription-admission";
import { ticketDetailHref } from "@/lib/tickets/hrefs";
import { getSubscriptionRuntime } from "./service-factory";
import { createRunsRepo } from "@/lib/state-store/runs-repo";
import {
  createSubscriptionOverviewService,
  type SubscriptionOverviewOwner,
  type SubscriptionSourcePresentation,
  matchesSubscriptionOwner,
} from "./overview-service";
import type { SubscriptionOwner } from "./controls-schemas";
import type { SubscriptionRecipient, SubscriptionSourceRef } from "./schemas";

export interface SubscriptionSourcePresentationDeps {
  findNotepad(id: string): Promise<{
    name: string;
    scope: "global" | "project";
    projectPath: string | null;
  } | null>;
  findTicket(
    id: string,
  ): Promise<{ title: string; number: number; projectPath: string } | null>;
  findSpec(
    id: string,
  ): Promise<{ name: string; slug: string; projectPath: string } | null>;
  findValidation(id: string): {
    projectPath: string;
    commandName: string;
    sessionName: string | null;
    conversationId: string | null;
  } | null;
  findJob(
    id: string,
  ): { jobType: string; projectName: string; sessionName: string } | null;
  findRun(id: string): { projectPath: string; title: string } | null;
}

export function createSubscriptionSourcePresentationReader(
  deps: SubscriptionSourcePresentationDeps,
) {
  return async function readSource(
    recipient: SubscriptionRecipient,
    source: SubscriptionSourceRef,
  ): Promise<SubscriptionSourcePresentation> {
    const missing = { title: `${source.kind} ${source.id}`, href: null };
    const projectName = projectNameFromPath(recipient.projectPath);
    const projectHref = `/projects/${encodeURIComponent(projectName)}`;
    switch (source.kind) {
      case "conversation":
        return { title: "Conversation notices", href: null };
      case "notepad": {
        const row = await deps.findNotepad(source.id);
        if (
          !row ||
          (row.scope === "project" && row.projectPath !== recipient.projectPath)
        )
          return missing;
        return { title: row.name, href: null };
      }
      case "ticket": {
        const row = await deps.findTicket(source.id);
        return row?.projectPath === recipient.projectPath
          ? {
              title: row.title,
              href: ticketDetailHref(projectName, row.number),
            }
          : missing;
      }
      case "spec": {
        const row = await deps.findSpec(source.id);
        return row?.projectPath === recipient.projectPath
          ? {
              title: row.name,
              href: `/specs/${encodeURIComponent(projectName)}/${encodeURIComponent(row.slug)}`,
            }
          : missing;
      }
      case "validation": {
        const row = deps.findValidation(source.id);
        if (row?.projectPath !== recipient.projectPath) return missing;
        const href =
          row.conversationId !== null
            ? row.sessionName !== null
              ? conversationsPageHref({ conversationId: row.conversationId })
              : `${projectHref}?focus=${encodeURIComponent(row.conversationId)}`
            : row.sessionName !== null
              ? `${projectHref}/${encodeURIComponent(row.sessionName)}`
              : projectHref;
        return { title: `${row.commandName} validation`, href };
      }
      case "git_job": {
        const row = deps.findJob(source.id);
        return row?.projectName === projectName
          ? {
              title: `${row.jobType} ${row.sessionName}`,
              href: `${projectHref}/${encodeURIComponent(row.sessionName)}`,
            }
          : missing;
      }
      case "run": {
        // Runs have no page yet; their owner reads them with cctl run show.
        const row = deps.findRun(source.id);
        return row?.projectPath === recipient.projectPath
          ? { title: row.title, href: null }
          : missing;
      }
    }
  };
}

export function getSubscriptionOverviewService() {
  return getGlobalSingleton("__cc_subscription_overview_service", () => {
    const db = getStateDb();
    const writeQueue = getSharedWriteQueue();
    const runtime = getSubscriptionRuntime();
    const conversations = createConversationsRepo(db);
    const projectConversations = createProjectConversationsRepo(db);
    const sessions = createSessionsRepo(db);
    const notepads = createNotepadsRepo(db, writeQueue);
    const tickets = createTicketsRepo(db, writeQueue);
    const specs = createSpecsRepo(db, writeQueue);
    const validations = createValidationRunsRepo(db);
    const jobs = createJobsRepo(db);
    const runs = createRunsRepo(db);
    const readSource = createSubscriptionSourcePresentationReader({
      findNotepad: (id) => notepads.findListItem(id),
      findTicket: (id) => tickets.findById(id),
      findSpec: (id) => specs.findById(id),
      findValidation: (id) => validations.findById(id),
      findJob: (id) => jobs.getJobRecord(id),
      findRun: (id) => {
        const run = runs.get(id);
        return run === null
          ? null
          : { projectPath: run.projectPath, title: run.facts.title };
      },
    });
    return createSubscriptionOverviewService({
      listSubscriptions: (recipient) => runtime.repo.list(recipient),
      listDeliveries: (recipient) =>
        runtime.repo.listDeliveriesForOverview(recipient),
      listWaits: (recipient) => runtime.waitsRepo.list(recipient),
      getBatch: (id) => runtime.waitsRepo.getBatch(id),
      listReadAt: (recipient) => runtime.preferencesRepo.listReadAt(recipient),
      async listOwners(scope) {
        const archivedProjects = await getArchivedProjects();
        if (scope.conversation) {
          const identity = runtime.readConversation(scope.conversation);
          if (
            !identity ||
            !isOrdinaryConversationRole(identity.conversation.role)
          )
            return [];
          const owner: SubscriptionOwner = {
            target:
              identity.sessionName === null
                ? {
                    scope: "project",
                    projectName: projectNameFromPath(identity.projectPath),
                    conversationId: scope.conversation,
                  }
                : {
                    scope: "session",
                    projectName: projectNameFromPath(identity.projectPath),
                    sessionName: identity.sessionName,
                    conversationId: scope.conversation,
                  },
            projectPath: identity.projectPath,
            conversationTitle:
              identity.conversation.name ??
              identity.conversation.summary ??
              scope.conversation,
            archived:
              identity.conversation.archived ||
              identity.sessionArchived ||
              archivedProjects.has(identity.projectPath),
          };
          return matchesSubscriptionOwner(owner, scope)
            ? [
                {
                  owner,
                  eligible:
                    !owner.archived &&
                    isEligibleSubscriptionRecipient(
                      identity,
                      identity.projectPath,
                    ),
                },
              ]
            : [];
        }
        const sessionRows = new Map(
          sessions
            .findAllListItems()
            .map((row) => [
              JSON.stringify([row.projectPath, row.session.sessionName]),
              row.session,
            ]),
        );
        const owners: SubscriptionOverviewOwner[] = [];
        for (const conversation of conversations.findAllListItems()) {
          if (!isOrdinaryConversationRole(conversation.role)) continue;
          const session = sessionRows.get(
            JSON.stringify([
              conversation.projectPath,
              conversation.sessionName,
            ]),
          );
          if (!session) continue;
          const owner: SubscriptionOwner = {
            target: {
              scope: "session",
              projectName: projectNameFromPath(conversation.projectPath),
              sessionName: conversation.sessionName,
              conversationId: conversation.id,
            },
            projectPath: conversation.projectPath,
            conversationTitle:
              conversation.name ?? conversation.summary ?? conversation.id,
            archived:
              conversation.archived ||
              session.archived ||
              archivedProjects.has(conversation.projectPath),
          };
          if (!matchesSubscriptionOwner(owner, scope)) continue;
          owners.push({
            owner,
            eligible:
              !owner.archived &&
              isEligibleSubscriptionRecipient(
                runtime.readConversation(conversation.id),
                conversation.projectPath,
              ),
          });
        }
        for (const row of scope.session ? [] : projectConversations.findAll()) {
          if (!isOrdinaryConversationRole(row.conversation.role)) continue;
          const owner: SubscriptionOwner = {
            target: {
              scope: "project",
              projectName: projectNameFromPath(row.projectPath),
              conversationId: row.conversation.id,
            },
            projectPath: row.projectPath,
            conversationTitle:
              row.conversation.name ??
              row.conversation.summary ??
              row.conversation.id,
            archived:
              row.conversation.archived ||
              archivedProjects.has(row.projectPath),
          };
          if (!matchesSubscriptionOwner(owner, scope)) continue;
          owners.push({
            owner,
            eligible:
              !owner.archived &&
              isEligibleSubscriptionRecipient(
                {
                  projectPath: row.projectPath,
                  sessionName: null,
                  sessionArchived: false,
                  conversation: row.conversation,
                },
                row.projectPath,
              ),
          });
        }
        return owners;
      },
      readSource,
      async readHold(recipient) {
        const identity = runtime.readConversation(recipient.conversationId);
        if (!identity || identity.projectPath !== recipient.projectPath)
          return "Subscription recipient no longer exists";
        const projectName = projectNameFromPath(identity.projectPath);
        const target =
          identity.sessionName === null
            ? {
                scope: "project" as const,
                projectName,
                conversationId: recipient.conversationId,
              }
            : {
                scope: "session" as const,
                projectName,
                sessionName: identity.sessionName,
                conversationId: recipient.conversationId,
              };
        return readSubscriptionWakeHold({
          projectPath: recipient.projectPath,
          sessionName: conversationTargetStoreSessionName(target),
          conversationId: recipient.conversationId,
        });
      },
      async readQueueStatus(recipient, batchId) {
        const identity = runtime.readConversation(recipient.conversationId);
        if (!identity || identity.projectPath !== recipient.projectPath)
          return null;
        return (
          identity.conversation.pendingQueue.find(
            (row) =>
              row.metadata?.kind === "subscription_update" &&
              row.metadata.batchId === batchId,
          )?.status ?? null
        );
      },
      readRateLimitUntil: (recipient) =>
        runtime.waitsRepo.rateLimitUntil(recipient, new Date().toISOString()),
      now: () => new Date().toISOString(),
    });
  });
}
