import type Database from "better-sqlite3";
import type { Logger } from "@/lib/logging";
import type { readConfig } from "../config/loader";
import type { ConversationMachineSnapshotsRepo } from "./conversation-machine-snapshots-repo";
import type { ConversationsRepo } from "./conversations-repo";
import type { DocumentCommentsRepo } from "./document-comments-repo";
import type { GraphWorkflowArchivedExecutionsRepo } from "./graph-workflow-archived-executions-repo";
import type { GraphWorkflowEventsRepo } from "./graph-workflow-events-repo";
import type { GraphWorkflowExecutionsRepo } from "./graph-workflow-executions-repo";
import type { GraphWorkflowResultDeliveriesRepo } from "./graph-workflow-result-deliveries-repo";
import type { GraphWorkflowPendingArtifactsRepo } from "./graph-workflow-pending-artifacts-repo";
import type { ProjectConversationsRepo } from "./project-conversations-repo";
import type { ProjectsRepo } from "./projects-repo";
import type { ReferenceDocumentsRepo } from "./reference-documents-repo";
import type { SessionMarkdownDocumentsRepo } from "./session-markdown-documents-repo";
import type { SessionsRepo } from "./sessions-repo";
import type { WriteQueue } from "./write-queue";
import type { NotificationsRepo } from "@/lib/notifications/repo";

export type Db = InstanceType<typeof Database>;

export interface AllRepos {
  projects: ProjectsRepo;
  sessions: SessionsRepo;
  conversations: ConversationsRepo;
  projectConversations: ProjectConversationsRepo;
  conversationMachineSnapshots: ConversationMachineSnapshotsRepo;
  referenceDocuments: ReferenceDocumentsRepo;
  sessionMarkdownDocuments: SessionMarkdownDocumentsRepo;
  documentComments: DocumentCommentsRepo;
  graphWorkflowEvents: GraphWorkflowEventsRepo;
  graphWorkflowArchivedExecutions: GraphWorkflowArchivedExecutionsRepo;
  graphWorkflowExecutions: GraphWorkflowExecutionsRepo;
  graphWorkflowResultDeliveries: GraphWorkflowResultDeliveriesRepo;
  graphWorkflowPendingArtifacts: GraphWorkflowPendingArtifactsRepo;
  notifications: NotificationsRepo;
}

export interface StateStoreDeps {
  db?: Db;
  writeQueue?: WriteQueue;
  readConfig?: typeof readConfig;
  repos?: Partial<AllRepos>;
  /**
   * Timing/event logger for the store's `timed()` mutation wrappers. Injectable
   * so a test can observe exactly when a `state.mutate` completion log is emitted
   * relative to the write-queue hold (the critical-section ordering regression);
   * defaults to the module logger in production.
   */
  logger?: Logger;
}

export interface StateStoreCore {
  db: Db;
  writeQueue: WriteQueue;
  repos: AllRepos;
}
