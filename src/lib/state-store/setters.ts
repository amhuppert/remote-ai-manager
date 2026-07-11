import { randomUUID } from "node:crypto";
import { createLogger } from "@/lib/logging";
import { timed } from "@/lib/logging/timed";
import { isProjectSentinel } from "@/lib/conversations/project-conversation-scope";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { DocumentComment } from "@/lib/document-comments/schemas";
import type { SessionMarkdownDocument } from "@/lib/documents/schemas";
import type { ReferenceDocument } from "@/lib/reference-documents/schemas";
import type { SessionState, SpawnedFrom } from "@/lib/sessions/schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionEvent,
} from "@/lib/workflows/schemas";
import type { GraphWorkflowArchivedExecutionRow } from "./graph-workflow-archived-executions-repo";
import type { StateStoreCore } from "./schemas";

const logger = createLogger("state-store");

export interface MutationFns {
  mutateSession<T = void>(
    projectPath: string,
    sessionName: string,
    label: string,
    mutate: (session: SessionState) => T | Promise<T>,
  ): Promise<T>;
}

export function createSetters(core: StateStoreCore, mutations: MutationFns) {
  const { db, writeQueue, repos } = core;
  const { mutateSession } = mutations;

  async function setSessionArchived(
    projectPath: string,
    sessionName: string,
    archived: boolean,
  ): Promise<void> {
    await mutateSession(
      projectPath,
      sessionName,
      "setSessionArchived",
      (session) => {
        session.archived = archived;
      },
    );
  }

  async function setSessionTddEnabled(
    projectPath: string,
    sessionName: string,
    tddEnabled: boolean,
  ): Promise<void> {
    await mutateSession(
      projectPath,
      sessionName,
      "setSessionTddEnabled",
      (session) => {
        session.tddEnabled = tddEnabled;
      },
    );
  }

  async function setSessionFinished(
    projectPath: string,
    sessionName: string,
  ): Promise<void> {
    await mutateSession(
      projectPath,
      sessionName,
      "setSessionFinished",
      (session) => {
        session.finished = true;
        session.archived = true;
      },
    );
  }

  async function setConversationPendingPromptText(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    text: string | null,
  ): Promise<void> {
    if (isProjectSentinel(sessionName)) {
      return setProjectConversationPendingPromptText(
        projectPath,
        conversationId,
        text,
      );
    }
    return writeQueue.withWriteQueue(
      `setConversationPendingPromptText[${sessionName}]`,
      async () =>
        timed(
          logger,
          "state.mutate",
          {
            label: "setConversationPendingPromptText",
            projectPath,
            sessionName,
            conversationId,
          },
          async () => {
            const updated = repos.conversations.setPendingPromptText(
              projectPath,
              sessionName,
              conversationId,
              text,
            );
            if (!updated) {
              throw new Error(
                `Conversation "${conversationId}" not found in session "${sessionName}"`,
              );
            }
          },
        ),
    );
  }

  async function setProjectConversationPendingPromptText(
    projectPath: string,
    conversationId: string,
    text: string | null,
  ): Promise<void> {
    return writeQueue.withWriteQueue(
      `setProjectConversationPendingPromptText[${conversationId}]`,
      async () =>
        timed(
          logger,
          "state.mutate",
          {
            label: "setProjectConversationPendingPromptText",
            projectPath,
            conversationId,
          },
          async () => {
            const updated = repos.projectConversations.setPendingPromptText(
              projectPath,
              conversationId,
              text,
            );
            if (!updated) {
              throw new Error(
                `Project conversation "${conversationId}" not found in project "${projectPath}"`,
              );
            }
          },
        ),
    );
  }

  async function createProjectConversation(
    projectPath: string,
    conversation: ConversationState,
  ): Promise<void> {
    return writeQueue.withWriteQueue(
      `createProjectConversation[${conversation.id}]`,
      async () =>
        timed(
          logger,
          "state.mutate",
          {
            label: "createProjectConversation",
            projectPath,
            conversationId: conversation.id,
          },
          async () => {
            // project_conversations has an FK to projects(root_path). A freshly
            // configured repo with no prior session/pin/archive state has no
            // projects row yet, so ensure one exists before the insert.
            const txn = db.transaction(() => {
              if (!repos.projects.findByRootPath(projectPath)) {
                repos.projects.upsert({ rootPath: projectPath });
              }
              repos.projectConversations.upsert(projectPath, conversation);
            });
            txn.immediate();
          },
        ),
    );
  }

  async function setProjectConversationArchived(
    projectPath: string,
    conversationId: string,
    archived: boolean,
  ): Promise<void> {
    return writeQueue.withWriteQueue(
      `setProjectConversationArchived[${conversationId}]`,
      async () =>
        timed(
          logger,
          "state.mutate",
          {
            label: "setProjectConversationArchived",
            projectPath,
            conversationId,
            archived,
          },
          async () => {
            const updated = repos.projectConversations.setArchived(
              projectPath,
              conversationId,
              archived,
            );
            if (!updated) {
              throw new Error(
                `Project conversation "${conversationId}" not found in project "${projectPath}"`,
              );
            }
          },
        ),
    );
  }

  async function setProjectConversationOpen(
    projectPath: string,
    conversationId: string,
    open: boolean,
  ): Promise<void> {
    return writeQueue.withWriteQueue(
      `setProjectConversationOpen[${conversationId}]`,
      async () =>
        timed(
          logger,
          "state.mutate",
          {
            label: "setProjectConversationOpen",
            projectPath,
            conversationId,
            open,
          },
          async () => {
            const updated = repos.projectConversations.setOpen(
              projectPath,
              conversationId,
              open,
            );
            if (!updated) {
              throw new Error(
                `Project conversation "${conversationId}" not found in project "${projectPath}"`,
              );
            }
          },
        ),
    );
  }

  async function setProjectArchived(
    projectPath: string,
    archived: boolean,
  ): Promise<void> {
    return writeQueue.withWriteQueue(
      `setProjectArchived[${projectPath}]`,
      async () =>
        timed(
          logger,
          "state.mutate",
          { label: "setProjectArchived", projectPath, archived },
          async () => {
            const txn = db.transaction(() => {
              if (!repos.projects.findByRootPath(projectPath)) {
                repos.projects.upsert({ rootPath: projectPath });
              }
              repos.projects.setArchived(projectPath, archived);
            });
            txn.immediate();
          },
        ),
    );
  }

  async function setProjectPinned(
    projectPath: string,
    pinned: boolean,
  ): Promise<void> {
    return writeQueue.withWriteQueue(
      `setProjectPinned[${projectPath}]`,
      async () =>
        timed(
          logger,
          "state.mutate",
          { label: "setProjectPinned", projectPath, pinned },
          async () => {
            const txn = db.transaction(() => {
              if (!repos.projects.findByRootPath(projectPath)) {
                repos.projects.upsert({ rootPath: projectPath });
              }
              repos.projects.setPinned(projectPath, pinned);
            });
            txn.immediate();
          },
        ),
    );
  }

  /**
   * Tag a session with its `from chat` origin. One-time focused single-column
   * write at chat-spawn creation (Pattern 2: no whole-state read / no
   * per-keystroke mutate*).
   */
  async function setSessionSpawnedFrom(
    projectPath: string,
    sessionName: string,
    spawnedFrom: SpawnedFrom,
  ): Promise<void> {
    return writeQueue.withWriteQueue(
      `setSessionSpawnedFrom[${sessionName}]`,
      async () =>
        timed(
          logger,
          "state.mutate",
          { label: "setSessionSpawnedFrom", projectPath, sessionName },
          async () => {
            const updated = repos.sessions.setSpawnedFrom(
              projectPath,
              sessionName,
              spawnedFrom,
            );
            if (!updated) {
              throw new Error(
                `Session "${sessionName}" not found in project "${projectPath}"`,
              );
            }
          },
        ),
    );
  }

  /**
   * Append spawned session names to a project conversation's back-link. Batched
   * single-row append performed once after the spawn-create loop (Pattern 2).
   */
  async function addPlcSpawnedSessionIds(
    projectPath: string,
    conversationId: string,
    sessionNames: string[],
  ): Promise<void> {
    if (sessionNames.length === 0) return;
    return writeQueue.withWriteQueue(
      `addPlcSpawnedSessionIds[${conversationId}]`,
      async () =>
        timed(
          logger,
          "state.mutate",
          { label: "addPlcSpawnedSessionIds", projectPath, conversationId },
          async () => {
            const updated = repos.projectConversations.appendSpawnedSessionIds(
              projectPath,
              conversationId,
              sessionNames,
            );
            if (!updated) {
              throw new Error(
                `Project conversation "${conversationId}" not found in project "${projectPath}"`,
              );
            }
          },
        ),
    );
  }

  /**
   * Atomically write the active graph-workflow execution blob (history-free)
   * and append its computed append-only events to `graph_workflow_events`,
   * inside a single write-queue critical section. The mutator receives the
   * currently-persisted execution and returns the next execution plus the
   * events to append (typically the events the publisher computed while
   * broadcasting). Returns the written execution.
   */
  async function mutateActiveGraphWorkflowExecution(
    projectPath: string,
    sessionName: string,
    label: string,
    mutate: (current: GraphWorkflowExecution | null) => Promise<{
      execution: GraphWorkflowExecution;
      events: GraphWorkflowExecutionEvent[];
    }>,
  ): Promise<GraphWorkflowExecution> {
    return writeQueue.withWriteQueue(`${label}[${sessionName}]`, async () =>
      timed(
        logger,
        "state.mutate",
        { label, projectPath, sessionName },
        async () => {
          const session = repos.sessions.findByKey(projectPath, sessionName);
          if (!session) {
            throw new Error(
              `Session "${sessionName}" not found in project "${projectPath}" during ${label}`,
            );
          }
          const { execution, events } = await mutate(
            repos.graphWorkflowExecutions.getActive(projectPath, sessionName),
          );
          const now = new Date().toISOString();
          const txn = db.transaction(() => {
            repos.graphWorkflowExecutions.setActive(
              projectPath,
              sessionName,
              execution,
              now,
            );
            repos.graphWorkflowEvents.appendMany(
              projectPath,
              sessionName,
              execution.id,
              now,
              events,
            );
          });
          txn.immediate();
          return execution;
        },
      ),
    );
  }

  /**
   * Move the active graph-workflow execution into the archived-executions table
   * (control-state only; its events stay in `graph_workflow_events` keyed by the
   * same execution id) and null the active blob, inside one write-queue section.
   */
  async function archiveActiveGraphWorkflowExecution(
    projectPath: string,
    sessionName: string,
  ): Promise<void> {
    return writeQueue.withWriteQueue(
      `archiveGraphWorkflowExecution[${sessionName}]`,
      async () =>
        timed(
          logger,
          "state.mutate",
          {
            label: "archiveGraphWorkflowExecution",
            projectPath,
            sessionName,
          },
          async () => {
            const execution = repos.graphWorkflowExecutions.getActive(
              projectPath,
              sessionName,
            );
            if (!execution) return;
            const now = new Date().toISOString();
            const row: GraphWorkflowArchivedExecutionRow = {
              projectPath,
              sessionName,
              executionId: execution.id,
              archivedAt: now,
              status: execution.status,
              startedAt: execution.startedAt,
              completedAt: execution.completedAt,
              execution,
            };
            const txn = db.transaction(() => {
              repos.graphWorkflowArchivedExecutions.insert(row);
              repos.graphWorkflowExecutions.setActive(
                projectPath,
                sessionName,
                null,
                now,
              );
            });
            txn.immediate();
          },
        ),
    );
  }

  /**
   * Mark every persisted event for a context up to the current insertion
   * boundary as pre-reset, replacing the old in-memory `history.map` reset
   * marking. Returns the number of rows newly marked.
   */
  async function markGraphWorkflowContextEventsPreReset(
    projectPath: string,
    sessionName: string,
    executionId: string,
    contextId: string,
  ): Promise<number> {
    return writeQueue.withWriteQueue(
      `markGraphWorkflowContextEventsPreReset[${sessionName}]`,
      async () =>
        timed(
          logger,
          "state.mutate",
          {
            label: "markGraphWorkflowContextEventsPreReset",
            projectPath,
            sessionName,
            conversationId: undefined,
          },
          async () => {
            const boundaryRow = db
              .prepare(
                `SELECT MAX(id) AS maxId FROM graph_workflow_events
                  WHERE execution_id = ?`,
              )
              .get(executionId) as { maxId: number | null };
            const boundaryId = boundaryRow.maxId;
            if (boundaryId === null) return 0;
            return repos.graphWorkflowEvents.markPreReset(
              executionId,
              contextId,
              boundaryId,
            );
          },
        ),
    );
  }

  /**
   * Focused single-column write of the session's `workflow_lanes` map. Loads
   * only the target session, hands the mutator the existing lane map (mutated
   * in place), and persists via the repo's focused setter — skipping the
   * whole-state read / clone / Zod-validate / sibling-canonicalize cycle that
   * `mutateSession` runs and the full-row re-serialization of every other
   * session column (including the large `graph_workflow_execution` blob). Stays
   * inside the write queue so concurrent same-session writes serialize.
   */
  async function mutateSessionWorkflowLanes<T = void>(
    projectPath: string,
    sessionName: string,
    label: string,
    mutate: (lanes: Record<string, unknown>) => T | Promise<T>,
  ): Promise<T> {
    return writeQueue.withWriteQueue(`${label}[${sessionName}]`, async () =>
      timed(
        logger,
        "state.mutate",
        { label, projectPath, sessionName },
        async () => {
          const session = repos.sessions.findByKey(projectPath, sessionName);
          if (!session) {
            throw new Error(
              `Session "${sessionName}" not found in project "${projectPath}" during ${label}`,
            );
          }
          const lanes = session.workflowLanes ?? {};
          const result = await mutate(lanes);
          repos.sessions.setSessionWorkflowLanes(
            projectPath,
            sessionName,
            lanes,
            new Date().toISOString(),
          );
          return result;
        },
      ),
    );
  }

  /**
   * Focused single-column write of the session's `workflow_envelopes` map.
   * Same focused-write rationale as `mutateSessionWorkflowLanes`.
   */
  async function mutateSessionWorkflowEnvelopes<T = void>(
    projectPath: string,
    sessionName: string,
    label: string,
    mutate: (envelopes: Record<string, unknown>) => T | Promise<T>,
  ): Promise<T> {
    return writeQueue.withWriteQueue(`${label}[${sessionName}]`, async () =>
      timed(
        logger,
        "state.mutate",
        { label, projectPath, sessionName },
        async () => {
          const session = repos.sessions.findByKey(projectPath, sessionName);
          if (!session) {
            throw new Error(
              `Session "${sessionName}" not found in project "${projectPath}" during ${label}`,
            );
          }
          const envelopes = session.workflowEnvelopes ?? {};
          const result = await mutate(envelopes);
          repos.sessions.setSessionWorkflowEnvelopes(
            projectPath,
            sessionName,
            envelopes,
            new Date().toISOString(),
          );
          return result;
        },
      ),
    );
  }

  async function createReferenceDocument(
    projectPath: string,
    sessionName: string,
    filePath: string,
    description: string,
  ): Promise<ReferenceDocument> {
    return mutateSession<ReferenceDocument>(
      projectPath,
      sessionName,
      "createReferenceDocument",
      (session) => {
        const existing = session.referenceDocuments.find(
          (d) => d.filePath === filePath,
        );
        if (existing) {
          existing.description = description;
          // Return a plain snapshot, not the draft element: the focused mutate
          // path finalizes the draft after the mutator returns, revoking every
          // draft proxy — including this one — so returning it directly would
          // throw on first access by the caller.
          return {
            id: existing.id,
            filePath: existing.filePath,
            description: existing.description,
            createdAt: existing.createdAt,
          };
        }
        const doc: ReferenceDocument = {
          id: randomUUID(),
          filePath,
          description,
          createdAt: new Date().toISOString(),
        };
        session.referenceDocuments.push(doc);
        return doc;
      },
    );
  }

  async function deleteReferenceDocument(
    projectPath: string,
    sessionName: string,
    documentId: string,
  ): Promise<ReferenceDocument | null> {
    return mutateSession<ReferenceDocument | null>(
      projectPath,
      sessionName,
      "deleteReferenceDocument",
      (session) => {
        const index = session.referenceDocuments.findIndex(
          (d) => d.id === documentId,
        );
        if (index === -1) return null;
        const removed = session.referenceDocuments[index]!;
        // Snapshot into a plain object before splicing: the focused mutate path
        // runs the mutator against an Immer draft, and a spliced-off element is
        // not part of the finalized `next`, so its proxy is revoked when the
        // draft finishes — returning it directly would throw on first access.
        const snapshot: ReferenceDocument = {
          id: removed.id,
          filePath: removed.filePath,
          description: removed.description,
          createdAt: removed.createdAt,
        };
        session.referenceDocuments.splice(index, 1);
        return snapshot;
      },
    );
  }

  async function upsertSessionMarkdownDocuments(
    projectPath: string,
    sessionName: string,
    documents: readonly SessionMarkdownDocument[],
  ): Promise<void> {
    return writeQueue.withWriteQueue(
      `upsertSessionMarkdownDocuments[${sessionName}]`,
      async () =>
        timed(
          logger,
          "state.mutate",
          {
            label: "upsertSessionMarkdownDocuments",
            projectPath,
            sessionName,
            documentCount: documents.length,
          },
          async () => {
            repos.sessionMarkdownDocuments.upsertMany(
              projectPath,
              sessionName,
              documents,
            );
          },
        ),
    );
  }

  /** Upsert a document comment through the serialized write queue. */
  async function upsertDocumentComment(
    comment: DocumentComment,
  ): Promise<void> {
    return writeQueue.withWriteQueue(
      `upsertDocumentComment[${comment.id}]`,
      async () =>
        timed(
          logger,
          "state.mutate",
          {
            label: "upsertDocumentComment",
            projectPath: comment.projectPath,
            sessionName: comment.sessionName,
          },
          async () => {
            repos.documentComments.upsert(comment);
          },
        ),
    );
  }

  async function deleteDocumentComment(id: string): Promise<void> {
    return writeQueue.withWriteQueue(`deleteDocumentComment[${id}]`, async () =>
      timed(
        logger,
        "state.mutate",
        { label: "deleteDocumentComment", id },
        async () => {
          repos.documentComments.delete(id);
        },
      ),
    );
  }

  return {
    setSessionArchived,
    setSessionTddEnabled,
    setSessionFinished,
    setConversationPendingPromptText,
    createProjectConversation,
    setProjectConversationPendingPromptText,
    setProjectConversationArchived,
    setProjectConversationOpen,
    setProjectArchived,
    setProjectPinned,
    setSessionSpawnedFrom,
    addPlcSpawnedSessionIds,
    mutateActiveGraphWorkflowExecution,
    archiveActiveGraphWorkflowExecution,
    markGraphWorkflowContextEventsPreReset,
    mutateSessionWorkflowLanes,
    mutateSessionWorkflowEnvelopes,
    createReferenceDocument,
    deleteReferenceDocument,
    upsertSessionMarkdownDocuments,
    upsertDocumentComment,
    deleteDocumentComment,
  };
}
