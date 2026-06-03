import { randomUUID } from "node:crypto";
import { createLogger } from "@/lib/logging";
import { timed } from "@/lib/logging/timed";
import { isProjectSentinel } from "@/lib/conversations/project-conversation-scope";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { ProjectState } from "@/lib/projects/schemas";
import type { ReferenceDocument } from "@/lib/reference-documents/schemas";
import type { SessionState, SpawnedFrom } from "@/lib/sessions/schemas";
import type { StateStoreCore } from "./schemas";

const logger = createLogger("state-store");

export interface MutationFns {
  mutateSession<T = void>(
    projectPath: string,
    sessionName: string,
    label: string,
    mutate: (session: SessionState, project: ProjectState) => T | Promise<T>,
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
          return existing;
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
        const [removed] = session.referenceDocuments.splice(index, 1);
        return removed!;
      },
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
    createReferenceDocument,
    deleteReferenceDocument,
  };
}
