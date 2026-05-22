import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  ConversationState,
  ManagerState,
  McpOverrides,
  ProjectState,
  ReferenceDocument,
  SessionListItem,
  SessionState,
} from "@/types";
import { managerStateSchema, sessionListItemSchema } from "../schemas";
import {
  deriveSessionLastActivityFromConvs,
  deriveSessionPromptCountFromConvs,
  deriveSessionStatusFromParts,
  getCollaborationEnvelopeContribution,
} from "@/lib/session-derived";
import { z } from "zod";
import { PersistenceError } from "../errors";
import { readConfig } from "../config";
import { createLogger } from "@/lib/logging";
import { timed } from "@/lib/logging/timed";

import { getDb } from "./state-db";
import {
  withWriteQueue as sharedWithWriteQueue,
  type WriteQueue,
} from "./write-queue";
import { createProjectsRepo, type ProjectsRepo } from "./projects-repo";
import {
  canonicalSessionRow,
  createSessionsRepo,
  type SessionsRepo,
} from "./sessions-repo";
import {
  canonicalConversationRow,
  createConversationsRepo,
  type ConversationsRepo,
} from "./conversations-repo";
import {
  canonicalReferenceDocumentRow,
  createReferenceDocumentsRepo,
  type ReferenceDocumentsRepo,
} from "./reference-documents-repo";
import { createStateAggregate, type StateAggregate } from "./state-aggregate";

type Db = InstanceType<typeof Database>;

const logger = createLogger("state-store");

const STATE_READ_TIMING_LOG_THRESHOLD_MS = 5;

export interface AllRepos {
  projects: ProjectsRepo;
  sessions: SessionsRepo;
  conversations: ConversationsRepo;
  referenceDocuments: ReferenceDocumentsRepo;
}

export interface StateStoreDeps {
  db?: Db;
  writeQueue?: WriteQueue;
  readConfig?: typeof readConfig;
  aggregate?: StateAggregate;
  repos?: Partial<AllRepos>;
}

interface ReadTimingPayload {
  accessor: string;
  totalMs: number;
  projectPath?: string;
  sessionName?: string;
  conversationId?: string;
}

function emitReadTiming(
  start: number,
  payload: Omit<ReadTimingPayload, "totalMs">,
): void {
  const totalMs = +(performance.now() - start).toFixed(3);
  if (totalMs < STATE_READ_TIMING_LOG_THRESHOLD_MS) return;
  logger.info("state.read.timing", { ...payload, totalMs });
}

/**
 * Composition-root accessor for the shared SQLite database. Modules that need
 * direct DB access (e.g., notification-db.ts) MUST go through this function so
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
    referenceDocuments:
      deps.repos?.referenceDocuments ?? createReferenceDocumentsRepo(db),
  };

  const aggregate: StateAggregate =
    deps.aggregate ?? createStateAggregate({ db, ...repos });

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

  // ------------------------------------------------------------------
  // Aggregate read / write
  // ------------------------------------------------------------------

  async function readState(): Promise<ManagerState> {
    return aggregate.readAll();
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

  // ------------------------------------------------------------------
  // Mutation API
  // ------------------------------------------------------------------

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

  // ------------------------------------------------------------------
  // Focused read accessors (do NOT touch the aggregate)
  // ------------------------------------------------------------------

  async function getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null> {
    const start = performance.now();
    try {
      const session = repos.sessions.findByKey(projectPath, sessionName);
      if (!session) return null;
      session.conversations = repos.conversations.findBySession(
        projectPath,
        sessionName,
      );
      session.referenceDocuments = repos.referenceDocuments.findBySession(
        projectPath,
        sessionName,
      );
      return session;
    } finally {
      emitReadTiming(start, {
        accessor: "getSession",
        projectPath,
        sessionName,
      });
    }
  }

  async function getProjectSessions(
    projectPath: string,
  ): Promise<SessionState[]> {
    const start = performance.now();
    try {
      const sessions = repos.sessions.findByProject(projectPath);
      for (const session of sessions) {
        session.conversations = repos.conversations.findBySession(
          projectPath,
          session.sessionName,
        );
        session.referenceDocuments = repos.referenceDocuments.findBySession(
          projectPath,
          session.sessionName,
        );
      }
      return sessions;
    } finally {
      emitReadTiming(start, { accessor: "getProjectSessions", projectPath });
    }
  }

  async function getProjectSessionListItems(
    projectPath: string,
  ): Promise<SessionListItem[]> {
    const start = performance.now();
    try {
      const sessionRows = repos.sessions.findListItemsByProject(projectPath);
      const convRows = repos.conversations.findListItemsForProject(projectPath);
      const convsBySession = new Map<
        string,
        Array<{
          id: string;
          status: ConversationState["status"];
          promptCount: number;
          lastActivityAt: string;
        }>
      >();
      for (const row of convRows) {
        const list = convsBySession.get(row.sessionName);
        if (list) {
          list.push(row);
        } else {
          convsBySession.set(row.sessionName, [row]);
        }
      }

      const result: SessionListItem[] = sessionRows.map((row) => {
        let parsedEnvelopes: Record<string, unknown> | null = null;
        if (row.workflow_envelopes !== null) {
          try {
            const candidate: unknown = JSON.parse(row.workflow_envelopes);
            if (
              candidate !== null &&
              typeof candidate === "object" &&
              !Array.isArray(candidate)
            ) {
              parsedEnvelopes = candidate as Record<string, unknown>;
            }
          } catch {
            logger.warn("state-store.workflow_envelopes_parse_failed", {
              projectPath,
              sessionName: row.session_name,
            });
            parsedEnvelopes = null;
          }
        }

        const collabContribution = getCollaborationEnvelopeContribution({
          workflowEnvelopes: parsedEnvelopes,
        });
        const convs = convsBySession.get(row.session_name) ?? [];
        const derivedStatus = deriveSessionStatusFromParts({
          finished: row.finished === 1,
          convStatuses: convs.map((c) => c.status),
          collabContribution,
        });
        const promptCount = deriveSessionPromptCountFromConvs(convs);
        const derivedLastActivityAt = deriveSessionLastActivityFromConvs(
          row.last_activity_at,
          convs,
        );

        const item: SessionListItem = {
          sessionName: row.session_name,
          worktreePath: row.worktree_path,
          branchName: row.branch_name,
          targetBranch: row.target_branch,
          parentSessionName: row.parent_session_name,
          createdAt: row.created_at,
          lastActivityAt: row.last_activity_at,
          archived: row.archived === 1,
          finished: row.finished === 1,
          source: row.source as SessionListItem["source"],
          creationMode: row.creation_mode as SessionListItem["creationMode"],
          tddEnabled: row.tdd_enabled === 1,
          objective: row.objective,
          derivedStatus,
          promptCount,
          derivedLastActivityAt,
          collabContribution,
          hasActiveGraphWorkflow: row.has_active_graph_workflow === 1,
        };
        return item;
      });

      if (process.env.NODE_ENV !== "production") {
        return z.array(sessionListItemSchema).parse(result);
      }
      return result;
    } finally {
      emitReadTiming(start, {
        accessor: "getProjectSessionListItems",
        projectPath,
      });
    }
  }

  async function getConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<ConversationState | null> {
    const start = performance.now();
    try {
      return repos.conversations.findByKey(
        projectPath,
        sessionName,
        conversationId,
      );
    } finally {
      emitReadTiming(start, {
        accessor: "getConversation",
        projectPath,
        sessionName,
        conversationId,
      });
    }
  }

  async function getSessionConversations(
    projectPath: string,
    sessionName: string,
  ): Promise<ConversationState[]> {
    const start = performance.now();
    try {
      const conversations = repos.conversations.findBySession(
        projectPath,
        sessionName,
      );
      return conversations.sort(
        (a, b) =>
          new Date(b.lastActivityAt).getTime() -
          new Date(a.lastActivityAt).getTime(),
      );
    } finally {
      emitReadTiming(start, {
        accessor: "getSessionConversations",
        projectPath,
        sessionName,
      });
    }
  }

  async function getReferenceDocuments(
    projectPath: string,
    sessionName: string,
  ): Promise<ReferenceDocument[]> {
    const start = performance.now();
    try {
      return repos.referenceDocuments.findBySession(projectPath, sessionName);
    } finally {
      emitReadTiming(start, {
        accessor: "getReferenceDocuments",
        projectPath,
        sessionName,
      });
    }
  }

  async function getProjectMcpOverrides(
    projectPath: string,
  ): Promise<McpOverrides | undefined> {
    const start = performance.now();
    try {
      const project = repos.projects.findByRootPath(projectPath);
      return project?.mcpOverrides;
    } finally {
      emitReadTiming(start, {
        accessor: "getProjectMcpOverrides",
        projectPath,
      });
    }
  }

  async function getArchivedProjects(): Promise<Set<string>> {
    const start = performance.now();
    try {
      return new Set(repos.projects.listArchived().map((r) => r.rootPath));
    } finally {
      emitReadTiming(start, { accessor: "getArchivedProjects" });
    }
  }

  async function getPinnedProjects(): Promise<Set<string>> {
    const start = performance.now();
    try {
      return new Set(repos.projects.listPinned().map((r) => r.rootPath));
    } finally {
      emitReadTiming(start, { accessor: "getPinnedProjects" });
    }
  }

  // ------------------------------------------------------------------
  // Mutation helpers preserved verbatim from src/lib/state.ts
  // ------------------------------------------------------------------

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

  // ------------------------------------------------------------------
  // Reference-document mutations (signatures preserved verbatim)
  // ------------------------------------------------------------------

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
    readState,
    writeState,
    mutateState,
    mutateSession,
    mutateConversation,
    getProjectSessions,
    getProjectSessionListItems,
    getSession,
    getConversation,
    getSessionConversations,
    getReferenceDocuments,
    getProjectMcpOverrides,
    getArchivedProjects,
    getPinnedProjects,
    getOrCreateProject,
    updateSession,
    removeSession,
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

export type StateStore = ReturnType<typeof createStateStore>;
