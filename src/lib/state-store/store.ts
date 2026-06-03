import type { ConversationState } from "@/lib/conversations/schemas";
import type { ManagerState, ProjectState } from "@/lib/projects/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import { managerStateSchema } from "@/lib/projects/schemas";
import { PersistenceError } from "../shared/errors";
import { createLogger } from "@/lib/logging";
import { timed } from "@/lib/logging/timed";

import { isProjectSentinel } from "@/lib/conversations/project-conversation-scope";
import { createAccessors } from "./accessors";
import {
  canonicalConversationRow,
  createConversationsRepo,
} from "./conversations-repo";
import { createProjectConversationsRepo } from "./project-conversations-repo";
import { createProjectsRepo } from "./projects-repo";
import {
  canonicalReferenceDocumentRow,
  createReferenceDocumentsRepo,
} from "./reference-documents-repo";
import { createSetters } from "./setters";
import { canonicalSessionRow, createSessionsRepo } from "./sessions-repo";
import { getDb } from "./state-db";
import { createStateAggregate, type StateAggregate } from "./state-aggregate";
import type { AllRepos, Db, StateStoreCore, StateStoreDeps } from "./schemas";
import {
  withWriteQueue as sharedWithWriteQueue,
  type WriteQueue,
} from "./write-queue";

export type { AllRepos, StateStoreDeps } from "./schemas";

const logger = createLogger("state-store");

/**
 * Composition-root accessor for the shared SQLite database. Modules that need
 * direct DB access (e.g., notifications/repo.ts) MUST go through this function so
 * that `state-db.getDb()` has a single in-process caller.
 */
export function getStateDb(): Db {
  return getDb();
}

function canonicalSessionWithChildren(
  projectPath: string,
  session: SessionState,
): string {
  const conversations = [...session.conversations]
    .map((c) => canonicalConversationRow(projectPath, session.sessionName, c))
    .sort();
  const referenceDocuments = [...session.referenceDocuments]
    .map((d) =>
      canonicalReferenceDocumentRow(projectPath, session.sessionName, d),
    )
    .sort();
  return JSON.stringify({
    session: canonicalSessionRow(projectPath, session),
    conversations,
    referenceDocuments,
  });
}

export function createStateStore(deps: StateStoreDeps = {}) {
  const db: Db = deps.db ?? getDb();
  const writeQueue: WriteQueue =
    deps.writeQueue ??
    ({
      withWriteQueue: sharedWithWriteQueue,
      _resetForTesting: () => {},
    } satisfies WriteQueue);

  const repos: AllRepos = {
    projects: deps.repos?.projects ?? createProjectsRepo(db),
    sessions: deps.repos?.sessions ?? createSessionsRepo(db),
    conversations: deps.repos?.conversations ?? createConversationsRepo(db),
    projectConversations:
      deps.repos?.projectConversations ?? createProjectConversationsRepo(db),
    referenceDocuments:
      deps.repos?.referenceDocuments ?? createReferenceDocumentsRepo(db),
  };

  const aggregate: StateAggregate =
    deps.aggregate ?? createStateAggregate({ db, ...repos });

  const core: StateStoreCore = { db, writeQueue, repos, aggregate };

  let deprecatedExportWarned = false;
  function warnDeprecatedExport(name: string): void {
    if (deprecatedExportWarned) return;
    deprecatedExportWarned = true;
    logger.warn("state.deprecated_export.used", { name });
  }

  function cloneAndValidate(snapshot: ManagerState): ManagerState {
    const cloned = structuredClone(snapshot);
    if (process.env.NODE_ENV !== "production") {
      return managerStateSchema.parse(cloned);
    }
    return cloned;
  }

  /**
   * @deprecated Use `mutateState` instead — direct `writeState` calls bypass the
   * write queue and can cause lost updates. Routed through `diffAndCommit`.
   */
  async function writeState(
    state: ManagerState,
    label?: string,
  ): Promise<void> {
    warnDeprecatedExport("writeState");
    return writeQueue.withWriteQueue(
      label ?? "writeState.deprecated",
      async () => {
        const snapshot = aggregate.readAll();
        aggregate.diffAndCommit(snapshot, managerStateSchema.parse(state));
      },
    );
  }

  async function mutateState<T = void>(
    label: string,
    mutate: (state: ManagerState) => T | Promise<T>,
  ): Promise<T> {
    return writeQueue.withWriteQueue(label, async () =>
      timed(logger, "state.mutate", { label }, async () => {
        const snapshot = aggregate.readAll();
        const mutated = cloneAndValidate(snapshot);
        const result = await mutate(mutated);
        aggregate.diffAndCommit(snapshot, mutated);
        return result;
      }),
    );
  }

  async function mutateSession<T = void>(
    projectPath: string,
    sessionName: string,
    label: string,
    mutate: (session: SessionState, project: ProjectState) => T | Promise<T>,
  ): Promise<T> {
    return writeQueue.withWriteQueue(`${label}[${sessionName}]`, async () =>
      timed(logger, "state.mutate", { label, sessionName }, async () => {
        const snapshot = aggregate.readAll();
        const snapProject = snapshot.projects[projectPath];
        if (!snapProject || !snapProject.sessions[sessionName]) {
          throw new Error(
            `Session "${sessionName}" not found in project "${projectPath}" during ${label}`,
          );
        }

        const siblingCanonicalsBefore = new Map<string, string>();
        for (const [name, sess] of Object.entries(snapProject.sessions)) {
          if (name === sessionName) continue;
          siblingCanonicalsBefore.set(
            name,
            canonicalSessionWithChildren(projectPath, sess),
          );
        }

        const mutated = cloneAndValidate(snapshot);
        const mutProject = mutated.projects[projectPath]!;
        const mutSession = mutProject.sessions[sessionName]!;

        const result = await mutate(mutSession, mutProject);

        for (const [name, sess] of Object.entries(mutProject.sessions)) {
          if (name === sessionName) continue;
          const before = siblingCanonicalsBefore.get(name);
          if (
            before === undefined ||
            canonicalSessionWithChildren(projectPath, sess) !== before
          ) {
            throw new PersistenceError({
              kind: "constraint",
              constraint: "mutateSession_sibling_session_out_of_scope",
            });
          }
        }
        for (const name of siblingCanonicalsBefore.keys()) {
          if (!(name in mutProject.sessions)) {
            throw new PersistenceError({
              kind: "constraint",
              constraint: "mutateSession_sibling_session_out_of_scope",
            });
          }
        }

        aggregate.diffAndCommit(snapshot, mutated);
        return result;
      }),
    );
  }

  async function mutateConversation<T = void>(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    label: string,
    mutate: (conversation: ConversationState) => T | Promise<T>,
  ): Promise<T> {
    if (isProjectSentinel(sessionName)) {
      return mutateProjectConversation<T>(
        projectPath,
        conversationId,
        label,
        mutate,
      );
    }
    return mutateSession<T>(
      projectPath,
      sessionName,
      label,
      async (session) => {
        const conversation = session.conversations.find(
          (c) => c.id === conversationId,
        );
        if (!conversation) {
          throw new Error(
            `Conversation "${conversationId}" not found in session "${sessionName}" during ${label}`,
          );
        }
        const result = await mutate(conversation);
        const now = new Date().toISOString();
        conversation.lastActivityAt = now;
        session.lastActivityAt = now;
        return result;
      },
    );
  }

  /**
   * Mutate a session-less project conversation. Loads the project record, runs
   * the mutator, stamps `lastActivityAt`, and upserts via the project repo
   * inside the write queue. Never touches `mutateSession` / the session
   * aggregate — project conversations live outside `ManagerState`.
   */
  async function mutateProjectConversation<T = void>(
    projectPath: string,
    conversationId: string,
    label: string,
    mutate: (conversation: ConversationState) => T | Promise<T>,
  ): Promise<T> {
    return writeQueue.withWriteQueue(
      `${label}[project::${conversationId}]`,
      () =>
        timed(
          logger,
          "state.mutate",
          { label, projectPath, conversationId },
          async () => {
            const conversation = repos.projectConversations.findByKey(
              projectPath,
              conversationId,
            );
            if (!conversation) {
              throw new Error(
                `Project conversation "${conversationId}" not found in project "${projectPath}" during ${label}`,
              );
            }
            const result = await mutate(conversation);
            conversation.lastActivityAt = new Date().toISOString();
            repos.projectConversations.upsert(projectPath, conversation);
            return result;
          },
        ),
    );
  }

  async function getOrCreateProject(
    projectPath: string,
  ): Promise<ProjectState> {
    return mutateState("getOrCreateProject", (state) => {
      const existing = state.projects[projectPath];
      if (existing) return existing;
      const project: ProjectState = {
        rootPath: projectPath,
        sessions: {},
      };
      state.projects[projectPath] = project;
      return project;
    });
  }

  /**
   * @deprecated Use `mutateSession` instead — this function replaces the entire
   * session object, which can overwrite concurrent changes.
   */
  async function updateSession(
    projectPath: string,
    session: SessionState,
  ): Promise<void> {
    warnDeprecatedExport("updateSession");
    return mutateState("updateSession.deprecated", (state) => {
      if (!state.projects[projectPath]) {
        state.projects[projectPath] = {
          rootPath: projectPath,
          sessions: {},
        };
      }
      state.projects[projectPath]!.sessions[session.sessionName] = session;
    });
  }

  async function removeSession(
    projectPath: string,
    sessionName: string,
  ): Promise<void> {
    return mutateState("removeSession", (state) => {
      const project = state.projects[projectPath];
      if (!project) return;
      delete project.sessions[sessionName];
    });
  }

  const accessors = createAccessors(core);
  const setters = createSetters(core, { mutateSession });

  return {
    readState: accessors.readState,
    writeState,
    mutateState,
    mutateSession,
    mutateConversation,
    mutateProjectConversation,
    getProjectSessions: accessors.getProjectSessions,
    getProjectSessionListItems: accessors.getProjectSessionListItems,
    getSession: accessors.getSession,
    getConversation: accessors.getConversation,
    getSessionConversations: accessors.getSessionConversations,
    getProjectConversation: accessors.getProjectConversation,
    getProjectConversations: accessors.getProjectConversations,
    listAllProjectConversations: accessors.listAllProjectConversations,
    getSpawnedSessionStatuses: accessors.getSpawnedSessionStatuses,
    getReferenceDocuments: accessors.getReferenceDocuments,
    getProjectMcpOverrides: accessors.getProjectMcpOverrides,
    getArchivedProjects: accessors.getArchivedProjects,
    getPinnedProjects: accessors.getPinnedProjects,
    getOrCreateProject,
    updateSession,
    removeSession,
    setSessionArchived: setters.setSessionArchived,
    setSessionTddEnabled: setters.setSessionTddEnabled,
    setSessionFinished: setters.setSessionFinished,
    setConversationPendingPromptText: setters.setConversationPendingPromptText,
    createProjectConversation: setters.createProjectConversation,
    setProjectConversationArchived: setters.setProjectConversationArchived,
    setProjectConversationOpen: setters.setProjectConversationOpen,
    setProjectConversationPendingPromptText:
      setters.setProjectConversationPendingPromptText,
    setProjectArchived: setters.setProjectArchived,
    setProjectPinned: setters.setProjectPinned,
    setSessionSpawnedFrom: setters.setSessionSpawnedFrom,
    addPlcSpawnedSessionIds: setters.addPlcSpawnedSessionIds,
    createReferenceDocument: setters.createReferenceDocument,
    deleteReferenceDocument: setters.deleteReferenceDocument,
  };
}

export type StateStore = ReturnType<typeof createStateStore>;
