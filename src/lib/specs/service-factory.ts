import { createSpecAbandonmentService } from "./spec-abandonment";
import { createHash } from "node:crypto";
import { createNotificationsRepo } from "@/lib/notifications/repo";
import { getNotificationsService } from "@/lib/notifications/service";
import { createSpecApprovalNotifier } from "@/lib/notifications/spec-approvals";
import { createProductionSpecReviewFeedbackNotifier } from "@/lib/notifications/spec-review-feedback";
import { getProjectDisplayName } from "@/lib/projects/resolver";
import { readConversationMessagesWithSeq } from "@/lib/prompt/transcript";
import { getSession } from "@/lib/state-store";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import { createSpecsRepo } from "@/lib/state-store/specs-repo";
import { getStateDb } from "@/lib/state-store/store";
import { getSharedWriteQueue } from "@/lib/state-store/write-queue";
import { getTicketService } from "@/lib/tickets/service-factory";
import { getTicketContentStore } from "@/lib/tickets/storage-production";
import type { TicketAttachment } from "@/lib/tickets/schemas";

import { createAuthoringService } from "./authoring-service";
import { createSpecEventsPublisher } from "./events";
import { loadSpecExportState, verifyExportState } from "./export";
import { createImportService } from "./import-service";
import { createLinksService } from "./links-service";
import { createReviewService } from "./review-service";
import type { SpecMutationServices } from "./route-handlers";
const servicesByProject = new Map<string, SpecMutationServices>();

export async function createProductionSpecRouteServices(
  projectPath: string,
): Promise<SpecMutationServices> {
  const existing = servicesByProject.get(projectPath);
  if (existing !== undefined) return existing;

  const db = getStateDb();
  const writeQueue = getSharedWriteQueue();
  const specs = createSpecsRepo(db, writeQueue);
  const reviewRepo = createSpecReviewRepo(db);
  const linksRepo = createSpecLinksRepo(db);
  const eventsRepo = createSpecEventsRepo(db);
  const events = createSpecEventsPublisher({
    appendInTransaction: eventsRepo.appendInTransaction,
  });
  const notificationsRepo = createNotificationsRepo(db);
  const notifier = createSpecApprovalNotifier({
    createSpecNotification(input) {
      getNotificationsService().createSpecNotification(input);
    },
    findSpecNotificationsBySpecId(specId) {
      return notificationsRepo.findSpecNotificationsBySpecId(specId);
    },
    getProjectDisplayName,
  });
  const reviewFeedbackNotifier = createProductionSpecReviewFeedbackNotifier();
  const review = createReviewService({
    specs,
    review: reviewRepo,
    links: linksRepo,
    events,
    attention: eventsRepo,
    // The approval notifier plus the author-facing feedback half (#60):
    // review feedback lands as passive durable notices in the conversation
    // that authored the draft, never as a wake.
    notifier: {
      ...notifier,
      reviewFeedback: reviewFeedbackNotifier.reviewFeedback,
    },
    policyNotifier: notifier,
  });
  // Built after the review service so a successful propose can file the
  // gate-scoped asks it leaves pending through the same request verb a human
  // or an agent would call (R10.13) — one durable identity, one Needs You row.
  const authoring = createAuthoringService({
    specs,
    review: reviewRepo,
    links: linksRepo,
    events,
    attention: eventsRepo,
    policyNotifier: notifier,
    notifier,
    approvalRequests: {
      requestApproval: (input) => review.requestApproval(input),
    },
  });
  const abandonment = createSpecAbandonmentService({
    specsRepo: specs,
    events,
    writeQueue,
    runInImmediateTransaction<T>(operation: () => T): T {
      return db.transaction(operation).immediate();
    },
    now: () => new Date().toISOString(),
    attentionNotifier: notifier,
  });
  const links = createLinksService({
    specs,
    links: linksRepo,
    authoring,
    events,
    tickets: getTicketService(),
    contentStore: getTicketContentStore(),
    async loadConversationSource(conversation) {
      const session = await getSession(projectPath, conversation.sessionName);
      const source = session?.conversations.find(
        (candidate) => candidate.id === conversation.conversationId,
      );
      if (source === undefined) {
        throw new Error("Conversation source not found");
      }
      const messages = await readConversationMessagesWithSeq(
        source.transcriptPath,
      );
      return {
        messages: messages.map((message) => ({
          id: message.id ?? `seq-${message.seq}`,
          role: message.role,
          content: message.content,
        })),
        attachments: [],
      };
    },
    async resolveTicketAttachment(_ticket, attachment) {
      const content = await ticketAttachmentContent(attachment);
      return {
        content,
        version: attachment.updatedAt,
        contentHash: createHash("sha256").update(content).digest("hex"),
      };
    },
  });
  const specImport = createImportService({
    specs,
    review: reviewRepo,
    links: linksRepo,
    events,
  });
  const services: SpecMutationServices = {
    authoring,
    abandonment,
    review,
    links,
    import: specImport,
    async verify(specId) {
      return verifyExportState(
        await loadSpecExportState(
          {
            specs,
            review: reviewRepo,
            events: eventsRepo,
          },
          specId,
        ),
      );
    },
  };
  servicesByProject.set(projectPath, services);
  return services;
}

async function ticketAttachmentContent(
  attachment: TicketAttachment,
): Promise<string> {
  switch (attachment.payload.kind) {
    case "note":
      return attachment.payload.markdown;
    case "file":
      return Buffer.from(
        await getTicketContentStore().read(attachment.payload.snapshotKey),
      ).toString("utf8");
    case "conversation":
      if (attachment.payload.snapshotKey === null) {
        return JSON.stringify(attachment.payload);
      }
      return Buffer.from(
        await getTicketContentStore().read(attachment.payload.snapshotKey),
      ).toString("utf8");
    case "session":
      return JSON.stringify(attachment.payload);
  }
}
