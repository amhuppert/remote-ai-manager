import { Immer } from "immer";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { ManagerState, ProjectState } from "@/lib/projects/schemas";
import type { ReferenceDocument } from "@/lib/reference-documents/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import { managerStateSchema } from "@/lib/projects/schemas";
import { createLogger } from "@/lib/logging";
import { timed } from "@/lib/logging/timed";

import { isProjectSentinel } from "@/lib/conversations/project-conversation-scope";
import { createAccessors } from "./accessors";
import { diffChangedConversationColumns } from "./conversation-row-codec";
import { createConversationsRepo } from "./conversations-repo";
import { createGraphWorkflowArchivedExecutionsRepo } from "./graph-workflow-archived-executions-repo";
import { createGraphWorkflowEventsRepo } from "./graph-workflow-events-repo";
import { createGraphWorkflowExecutionsRepo } from "./graph-workflow-executions-repo";
import { createProjectConversationsRepo } from "./project-conversations-repo";
import { createProjectsRepo } from "./projects-repo";
import { createReferenceDocumentsRepo } from "./reference-documents-repo";
import { createSetters } from "./setters";
import {
  createSessionsRepo,
  diffChangedSessionColumns,
} from "./sessions-repo";
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

/**
 * Immer instance with auto-freeze disabled, scoped to the focused row-mutate
 * paths (`mutateConversation` / `mutateSession`). Drafting the loaded row gives
 * the mutator a `next` whose touched top-level fields are fresh references
 * (cheap per-column reference diff via structural sharing) while leaving the
 * mutator's return value mutable: callers in the message-queue family build
 * queued-message rows, assign them into the draft, and return those same
 * references onward into broadcast/view code — auto-freeze would turn those
 * into read-only objects that silently no-op on a later in-place edit. Session
 * mutators that add/remove a child (`forkConversation` pushes a conversation,
 * `deleteReferenceDocument` splices a doc) likewise return the touched row.
 * Isolated from the global Immer (the rest of the app keeps default freezing
 * via `produce`).
 */
const rowMutateImmer = new Immer({ autoFreeze: false });

/**
 * Diff a session's child conversation array (`base` loaded before the mutator,
 * `next` produced after) by `id`: an id only in `next` is an insert, an id only
 * in `base` is a removal, and a shared id whose top-level reference changed is
 * an in-place edit. Identity is the conversation `id`; reference equality on the
 * shared id is "this conversation may have changed" (Immer structural sharing
 * gives an untouched conversation the same reference on `next`).
 */
function diffChildConversations(
  base: readonly ConversationState[],
  next: readonly ConversationState[],
): {
  added: ConversationState[];
  edited: ConversationState[];
  removedIds: string[];
} {
  const baseById = new Map(base.map((c) => [c.id, c]));
  const nextIds = new Set(next.map((c) => c.id));
  const added: ConversationState[] = [];
  const edited: ConversationState[] = [];
  for (const conversation of next) {
    const before = baseById.get(conversation.id);
    if (before === undefined) {
      added.push(conversation);
      continue;
    }
    if (before !== conversation) edited.push(conversation);
  }
  const removedIds: string[] = [];
  for (const conversation of base) {
    if (!nextIds.has(conversation.id)) removedIds.push(conversation.id);
  }
  return { added, edited, removedIds };
}

/**
 * Diff a session's child reference-document array by `id`. Reference documents
 * have only two mutable columns, so a changed doc is re-`upsert`ed whole rather
 * than per-column diffed (cheap). Returns the docs to upsert (added or changed)
 * and the ids to delete.
 */
function diffChildReferenceDocuments(
  base: readonly ReferenceDocument[],
  next: readonly ReferenceDocument[],
): { upserts: ReferenceDocument[]; removedIds: string[] } {
  const baseById = new Map(base.map((d) => [d.id, d]));
  const nextIds = new Set(next.map((d) => d.id));
  const upserts: ReferenceDocument[] = [];
  for (const doc of next) {
    const before = baseById.get(doc.id);
    if (before === undefined || before !== doc) upserts.push(doc);
  }
  const removedIds: string[] = [];
  for (const doc of base) {
    if (!nextIds.has(doc.id)) removedIds.push(doc.id);
  }
  return { upserts, removedIds };
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
    graphWorkflowEvents:
      deps.repos?.graphWorkflowEvents ?? createGraphWorkflowEventsRepo(db),
    graphWorkflowArchivedExecutions:
      deps.repos?.graphWorkflowArchivedExecutions ??
      createGraphWorkflowArchivedExecutionsRepo(db),
    graphWorkflowExecutions:
      deps.repos?.graphWorkflowExecutions ??
      createGraphWorkflowExecutionsRepo(db),
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

  /**
   * Focused single-session mutation. Loads only the target session and its two
   * child collections (conversations, reference documents), runs the mutator
   * against an Immer draft, then writes — in one transaction — only the session
   * columns whose source field changed plus the added/edited/removed child rows.
   * Bypasses the aggregate's read-everything-clone-validate-diff cycle and the
   * full-row re-serialization of every session column (notably the large
   * `graph_workflow_execution` blob). The mutator only ever sees the target
   * session, so cross-session writes are structurally impossible and no
   * sibling-canonicalization guard is needed. Does NOT auto-restamp
   * `lastActivityAt` — the session timestamp is unchanged unless the mutator
   * sets `session.lastActivityAt` explicitly (config toggles like
   * archive/tdd/objective must not bump session ordering).
   */
  async function mutateSession<T = void>(
    projectPath: string,
    sessionName: string,
    label: string,
    mutate: (session: SessionState) => T | Promise<T>,
  ): Promise<T> {
    return writeQueue.withWriteQueue(`${label}[${sessionName}]`, async () =>
      timed(logger, "state.mutate", { label, sessionName }, async () => {
        const baseSession = repos.sessions.findByKey(projectPath, sessionName);
        if (!baseSession) {
          throw new Error(
            `Session "${sessionName}" not found in project "${projectPath}" during ${label}`,
          );
        }
        const base: SessionState = {
          ...baseSession,
          conversations: repos.conversations.findBySession(
            projectPath,
            sessionName,
          ),
          referenceDocuments: repos.referenceDocuments.findBySession(
            projectPath,
            sessionName,
          ),
        };

        // Run the mutator against an Immer draft so structural sharing makes
        // each touched top-level field (and each touched child) a fresh
        // reference on `next`, then diff `base` vs `next` by reference to find
        // exactly which columns and child rows changed. `createDraft`/
        // `finishDraft` (not `produce`) because mutators may be async — Immer
        // finalizes `produce` synchronously and would revoke the proxy before
        // an async recipe's first `await` resumes.
        const draft = rowMutateImmer.createDraft(base);
        const result = await mutate(draft);
        const next = rowMutateImmer.finishDraft(draft);

        const changedColumns = diffChangedSessionColumns(base, next);
        const convDiff = diffChildConversations(
          base.conversations,
          next.conversations,
        );
        const refDocDiff = diffChildReferenceDocuments(
          base.referenceDocuments,
          next.referenceDocuments,
        );

        // `last_activity_at` is excluded from SESSION_COLUMN_MAP: the session-
        // mutate path does not auto-restamp it, so a config toggle like
        // archive/tdd must not bump session activity. Carry an explicit
        // mutator-set `session.lastActivityAt` through.
        if (next.lastActivityAt !== base.lastActivityAt) {
          changedColumns.last_activity_at = next.lastActivityAt;
        }

        const txn = db.transaction(() => {
          repos.sessions.updateChangedColumns(
            projectPath,
            sessionName,
            changedColumns,
          );
          for (const conversation of convDiff.added) {
            repos.conversations.upsert(projectPath, sessionName, conversation);
          }
          for (const conversation of convDiff.edited) {
            const baseConv = base.conversations.find(
              (c) => c.id === conversation.id,
            )!;
            const changedConvColumns = diffChangedConversationColumns(
              baseConv,
              conversation,
            );
            // `last_activity_at` is excluded from the conversation column map
            // (the focused conversation path restamps it). The session-mutate
            // path does not auto-restamp child conversation activity, so carry
            // an explicit mutator-set `lastActivityAt` through.
            if (conversation.lastActivityAt !== baseConv.lastActivityAt) {
              changedConvColumns.last_activity_at = conversation.lastActivityAt;
            }
            repos.conversations.updateChangedColumns(
              projectPath,
              sessionName,
              conversation.id,
              changedConvColumns,
            );
          }
          for (const id of convDiff.removedIds) {
            repos.conversations.delete(id);
          }
          for (const doc of refDocDiff.upserts) {
            repos.referenceDocuments.upsert(projectPath, sessionName, doc);
          }
          for (const id of refDocDiff.removedIds) {
            repos.referenceDocuments.delete(id);
          }
        });
        txn.immediate();

        return result;
      }),
    );
  }

  /**
   * Focused single-conversation mutation. Writes one row via the conversations
   * repo, bypassing the aggregate's read-everything-validate-diff cycle. The
   * mutator only ever sees the target `ConversationState`, so cross-entity
   * writes are structurally impossible and no sibling-canonicalization guard is
   * needed. Touches `lastActivityAt` on both the conversation and its session.
   */
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
    return writeQueue.withWriteQueue(`${label}[${sessionName}]`, async () =>
      timed(
        logger,
        "state.mutate",
        { label, projectPath, sessionName, conversationId },
        async () => {
          const base = repos.conversations.findByKey(
            projectPath,
            sessionName,
            conversationId,
          );
          if (!base) {
            throw new Error(
              `Conversation "${conversationId}" not found in session "${sessionName}" during ${label}`,
            );
          }
          // Run the mutator against an Immer draft so structural sharing makes
          // each touched top-level field a fresh reference on `next`, then diff
          // `base` vs `next` by reference to find exactly which columns changed.
          // `createDraft`/`finishDraft` (not `produce`) because mutators may be
          // async — Immer finalizes `produce` synchronously and would revoke the
          // proxy before an async recipe's first `await` resumes.
          const draft = rowMutateImmer.createDraft(base);
          const result = await mutate(draft);
          const next = rowMutateImmer.finishDraft(draft);
          const now = new Date().toISOString();
          const changedColumns = diffChangedConversationColumns(base, next);
          repos.conversations.updateChangedColumnsWithSessionTouch(
            projectPath,
            sessionName,
            conversationId,
            changedColumns,
            now,
          );
          return result;
        },
      ),
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

  /**
   * Focused conversation creation. Inserts one new conversation row via the
   * conversations repo, bypassing the aggregate's read-everything-validate-diff
   * cycle. The `build` factory receives the next sequence number (existing
   * conversation count + 1) computed inside the write-queue critical section, so
   * concurrent creates cannot collide on a name, and returns the fully-formed
   * conversation. Persists via `upsertWithSessionTouch`, so the new row and its
   * session's `lastActivityAt` move together.
   */
  async function createSessionConversation(
    projectPath: string,
    sessionName: string,
    build: (sequenceNumber: number) => ConversationState,
  ): Promise<ConversationState> {
    return writeQueue.withWriteQueue(
      `createConversation[${sessionName}]`,
      async () =>
        timed(
          logger,
          "state.mutate",
          { label: "createConversation", projectPath, sessionName },
          async () => {
            const session = repos.sessions.findByKey(projectPath, sessionName);
            if (!session) {
              throw new Error(
                `Session "${sessionName}" not found in project "${projectPath}" during createConversation`,
              );
            }
            const sequenceNumber =
              repos.conversations.countBySession(projectPath, sessionName) + 1;
            const conversation = build(sequenceNumber);
            repos.conversations.upsertWithSessionTouch(
              projectPath,
              sessionName,
              conversation,
              conversation.lastActivityAt,
            );
            return conversation;
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
    createSessionConversation,
    getProjectSessions: accessors.getProjectSessions,
    getProjectSessionListItems: accessors.getProjectSessionListItems,
    getSession: accessors.getSession,
    getConversation: accessors.getConversation,
    getConversationById: accessors.getConversationById,
    getSessionConversations: accessors.getSessionConversations,
    getProjectConversation: accessors.getProjectConversation,
    getProjectConversations: accessors.getProjectConversations,
    listAllProjectConversations: accessors.listAllProjectConversations,
    getSpawnedSessionStatuses: accessors.getSpawnedSessionStatuses,
    getReferenceDocuments: accessors.getReferenceDocuments,
    getProjectMcpOverrides: accessors.getProjectMcpOverrides,
    getArchivedProjects: accessors.getArchivedProjects,
    getPinnedProjects: accessors.getPinnedProjects,
    getGraphWorkflowEventsTail: accessors.getGraphWorkflowEventsTail,
    findLatestGraphWorkflowContextEvent:
      accessors.findLatestGraphWorkflowContextEvent,
    getActiveGraphWorkflowExecution: accessors.getActiveGraphWorkflowExecution,
    listActiveGraphWorkflowExecutions:
      accessors.listActiveGraphWorkflowExecutions,
    listArchivedGraphWorkflowExecutions:
      accessors.listArchivedGraphWorkflowExecutions,
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
    mutateActiveGraphWorkflowExecution:
      setters.mutateActiveGraphWorkflowExecution,
    archiveActiveGraphWorkflowExecution:
      setters.archiveActiveGraphWorkflowExecution,
    markGraphWorkflowContextEventsPreReset:
      setters.markGraphWorkflowContextEventsPreReset,
    mutateSessionWorkflowLanes: setters.mutateSessionWorkflowLanes,
    mutateSessionWorkflowEnvelopes: setters.mutateSessionWorkflowEnvelopes,
    createReferenceDocument: setters.createReferenceDocument,
    deleteReferenceDocument: setters.deleteReferenceDocument,
  };
}

export type StateStore = ReturnType<typeof createStateStore>;
