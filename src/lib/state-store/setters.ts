import { randomUUID } from "node:crypto";
import { createLogger } from "@/lib/logging";
import { timed } from "@/lib/logging/timed";
import type { ProjectState } from "@/lib/projects/schemas";
import type { ReferenceDocument } from "@/lib/reference-documents/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
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
    setProjectArchived,
    setProjectPinned,
    createReferenceDocument,
    deleteReferenceDocument,
  };
}
