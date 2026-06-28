import type Database from "better-sqlite3";
import type { readConfig } from "../config/loader";
import type { ConversationsRepo } from "./conversations-repo";
import type { DocumentCommentsRepo } from "./document-comments-repo";
import type { GraphWorkflowArchivedExecutionsRepo } from "./graph-workflow-archived-executions-repo";
import type { GraphWorkflowEventsRepo } from "./graph-workflow-events-repo";
import type { GraphWorkflowExecutionsRepo } from "./graph-workflow-executions-repo";
import type { ProjectConversationsRepo } from "./project-conversations-repo";
import type { ProjectsRepo } from "./projects-repo";
import type { ReferenceDocumentsRepo } from "./reference-documents-repo";
import type { SessionsRepo } from "./sessions-repo";
import type { StateAggregate } from "./state-aggregate";
import type { WriteQueue } from "./write-queue";

export type Db = InstanceType<typeof Database>;

export interface AllRepos {
  projects: ProjectsRepo;
  sessions: SessionsRepo;
  conversations: ConversationsRepo;
  projectConversations: ProjectConversationsRepo;
  referenceDocuments: ReferenceDocumentsRepo;
  documentComments: DocumentCommentsRepo;
  graphWorkflowEvents: GraphWorkflowEventsRepo;
  graphWorkflowArchivedExecutions: GraphWorkflowArchivedExecutionsRepo;
  graphWorkflowExecutions: GraphWorkflowExecutionsRepo;
}

export interface StateStoreDeps {
  db?: Db;
  writeQueue?: WriteQueue;
  readConfig?: typeof readConfig;
  aggregate?: StateAggregate;
  repos?: Partial<AllRepos>;
}

export interface StateStoreCore {
  db: Db;
  writeQueue: WriteQueue;
  repos: AllRepos;
  aggregate: StateAggregate;
}
