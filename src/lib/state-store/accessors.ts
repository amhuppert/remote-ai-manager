import { z } from "zod";
import { createLogger, type Logger } from "@/lib/logging";
import {
  deriveSessionLastActivityFromConvs,
  deriveSessionPromptCountFromConvs,
  deriveSessionStatusFromParts,
  getCollaborationEnvelopeContribution,
} from "@/lib/sessions/derived";
import { sessionListItemSchema } from "@/lib/sessions/schemas";
import { isProjectSentinel } from "@/lib/conversations/project-conversation-scope";
import { scopeRefFromStoreSessionName } from "@/lib/conversations/conversation-target";
import type { ConversationState } from "@/lib/conversations/schemas";
import type {
  ConversationIdentity,
  ConversationListItemProjection,
} from "./conversations-repo";
import type { SessionListItemProjection } from "./sessions-repo";
import type { DocumentComment } from "@/lib/document-comments/schemas";
import type { SessionMarkdownDocument } from "@/lib/documents/schemas";
import type { AgentCapabilityOverrides } from "@/lib/agent-capabilities/schemas";
import type { McpOverrides } from "@/lib/mcp/schemas";
import type { ReferenceDocument } from "@/lib/reference-documents/schemas";
import type { SessionListItem, SessionState } from "@/lib/sessions/schemas";
import type { GraphWorkflowExecutionEvent } from "@/lib/workflow-graph/event-schemas";
import type {
  GraphWorkflowEventPage,
  GraphWorkflowEventPageQuery,
} from "./graph-workflow-events-repo";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { StateStoreCore } from "./schemas";

const logger = createLogger("state-store");

const STATE_READ_TIMING_LOG_THRESHOLD_MS = 5;

/**
 * List-item-tier projection of one session together with its conversations,
 * both narrowed to the fields list surfaces render. Serves the cross-project
 * list surfaces (autocomplete list, active-conversations feed) and startup
 * envelope recovery, none of which needs any conversation's full state or the
 * session's heavy blob columns.
 */
export interface SessionConversationListItem {
  projectPath: string;
  session: SessionListItemProjection;
  conversations: ConversationListItemProjection[];
}

interface ReadTimingPayload {
  accessor: string;
  projectPath?: string;
  /**
   * The session-keyed storage name a read was addressed with — the project
   * sentinel when `getConversation` serves a project conversation. Named for
   * what it is, so no call site can hand this accessor a value that gets logged
   * as a public `sessionName`: the emitted event carries the discriminated
   * scope instead (R1.3).
   */
  storeSessionName?: string;
  conversationId?: string;
}

export function createAccessors(core: StateStoreCore, log: Logger = logger) {
  const { repos } = core;

  function emitReadTiming(start: number, payload: ReadTimingPayload): void {
    const durationMs = +(performance.now() - start).toFixed(3);
    if (durationMs < STATE_READ_TIMING_LOG_THRESHOLD_MS) return;
    const { storeSessionName, ...rest } = payload;
    log.info("state.read.timing", {
      ...rest,
      ...(storeSessionName !== undefined
        ? scopeRefFromStoreSessionName(storeSessionName)
        : {}),
      durationMs,
    });
  }

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
        storeSessionName: sessionName,
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
        const collabContribution = getCollaborationEnvelopeContribution({
          workflowEnvelopes: row.workflowEnvelopes,
        });
        const convs = convsBySession.get(row.sessionName) ?? [];
        const derivedStatus = deriveSessionStatusFromParts({
          finished: row.finished,
          convStatuses: convs.map((c) => c.status),
          collabContribution,
        });
        const promptCount = deriveSessionPromptCountFromConvs(convs);
        const derivedLastActivityAt = deriveSessionLastActivityFromConvs(
          row.lastActivityAt,
          convs,
        );

        const item: SessionListItem = {
          sessionName: row.sessionName,
          worktreePath: row.worktreePath,
          branchName: row.branchName,
          targetBranch: row.targetBranch,
          parentSessionName: row.parentSessionName,
          createdAt: row.createdAt,
          lastActivityAt: row.lastActivityAt,
          archived: row.archived,
          finished: row.finished,
          source: row.source,
          creationMode: row.creationMode,
          tddEnabled: row.tddEnabled,
          derivedStatus,
          promptCount,
          derivedLastActivityAt,
          collabContribution,
          hasActiveGraphWorkflow: row.hasActiveGraphWorkflow,
          spawnedFrom: row.spawnedFrom,
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
      if (isProjectSentinel(sessionName)) {
        return repos.projectConversations.findByKey(
          projectPath,
          conversationId,
        );
      }
      return repos.conversations.findByKey(
        projectPath,
        sessionName,
        conversationId,
      );
    } finally {
      emitReadTiming(start, {
        accessor: "getConversation",
        projectPath,
        storeSessionName: sessionName,
        conversationId,
      });
    }
  }

  /**
   * Resolve a session-scoped conversation by id alone — two single-row
   * indexed reads (conversation by primary key, then its owning session for
   * the worktree path). Project-scoped conversations live in a separate
   * table and are never found here.
   */
  async function getConversationById(conversationId: string): Promise<{
    projectPath: string;
    sessionName: string;
    worktreePath: string;
    conversation: ConversationState;
  } | null> {
    const start = performance.now();
    try {
      const found = repos.conversations.findByIdWithKey(conversationId);
      if (!found) return null;
      const session = repos.sessions.findByKey(
        found.projectPath,
        found.sessionName,
      );
      if (!session) {
        logger.warn("state-store.conversation_session_missing", {
          conversationId,
          projectPath: found.projectPath,
          sessionName: found.sessionName,
        });
        return null;
      }
      return {
        projectPath: found.projectPath,
        sessionName: found.sessionName,
        worktreePath: session.worktreePath,
        conversation: found.conversation,
      };
    } finally {
      emitReadTiming(start, {
        accessor: "getConversationById",
        conversationId,
      });
    }
  }

  /**
   * Resolve a project conversation by id alone, reporting its owning project.
   * The id-only lookup path serves both scopes, so a project conversation must
   * be findable without the caller already knowing its project.
   */
  async function getProjectConversationById(conversationId: string): Promise<{
    projectPath: string;
    conversation: ConversationState;
  } | null> {
    const start = performance.now();
    try {
      return repos.projectConversations.findByIdWithProject(conversationId);
    } finally {
      emitReadTiming(start, {
        accessor: "getProjectConversationById",
        conversationId,
      });
    }
  }

  async function getProjectConversation(
    projectPath: string,
    conversationId: string,
  ): Promise<ConversationState | null> {
    const start = performance.now();
    try {
      return repos.projectConversations.findByKey(projectPath, conversationId);
    } finally {
      emitReadTiming(start, {
        accessor: "getProjectConversation",
        projectPath,
        conversationId,
      });
    }
  }

  async function getProjectConversations(
    projectPath: string,
  ): Promise<ConversationState[]> {
    const start = performance.now();
    try {
      return repos.projectConversations.findByProject(projectPath);
    } finally {
      emitReadTiming(start, {
        accessor: "getProjectConversations",
        projectPath,
      });
    }
  }

  /**
   * Identity-tier listing of every session-scoped conversation: key columns
   * plus `status`, no blobs and no heavy parse. Backs callers that need
   * conversation identity tuples across the store (e.g. MCP runtime-target
   * listing) without paying the whole-state read cost.
   */
  async function listConversationIdentities(): Promise<ConversationIdentity[]> {
    const start = performance.now();
    try {
      return repos.conversations.findAllIdentities();
    } finally {
      emitReadTiming(start, { accessor: "listConversationIdentities" });
    }
  }

  /**
   * List-item-tier read of every session-scoped session with its conversations,
   * across the whole store, each projected to the fields list surfaces render.
   * Two focused list-item repo reads (sessions, then conversations) joined in
   * memory — never `readState()`. Backs the cross-project conversation lists
   * (autocomplete list, active-conversations feed) and startup envelope
   * recovery. Sessions with no conversations appear with an empty array.
   */
  async function listSessionConversationListItems(): Promise<
    SessionConversationListItem[]
  > {
    const start = performance.now();
    try {
      const sessionRows = repos.sessions.findAllListItems();
      const convRows = repos.conversations.findAllListItems();
      const convsBySession = new Map<
        string,
        ConversationListItemProjection[]
      >();
      for (const conv of convRows) {
        const key = `${conv.projectPath}\u0000${conv.sessionName}`;
        const arr = convsBySession.get(key);
        if (arr) arr.push(conv);
        else convsBySession.set(key, [conv]);
      }
      return sessionRows.map(({ projectPath, session }) => ({
        projectPath,
        session,
        conversations:
          convsBySession.get(`${projectPath}\u0000${session.sessionName}`) ??
          [],
      }));
    } finally {
      emitReadTiming(start, { accessor: "listSessionConversationListItems" });
    }
  }

  async function listAllProjectConversations(): Promise<
    { projectPath: string; conversation: ConversationState }[]
  > {
    const start = performance.now();
    try {
      return repos.projectConversations.findAll();
    } finally {
      emitReadTiming(start, { accessor: "listAllProjectConversations" });
    }
  }

  /**
   * Passive status read for the sessions a project conversation spawned:
   * intersect the PLC's `spawnedSessionIds` with the project's slim session
   * list items, returning the linked sessions' slim status (incl.
   * `derivedStatus`). Since-deleted session names drop out (not in the list).
   * Reuses the focused list-item accessor — never `readState()` (Pattern 1).
   */
  async function getSpawnedSessionStatuses(
    projectPath: string,
    conversationId: string,
  ): Promise<SessionListItem[]> {
    const start = performance.now();
    try {
      const plc = repos.projectConversations.findByKey(
        projectPath,
        conversationId,
      );
      const linked = new Set(plc?.spawnedSessionIds ?? []);
      if (linked.size === 0) return [];
      const items = await getProjectSessionListItems(projectPath);
      return items.filter((item) => linked.has(item.sessionName));
    } finally {
      emitReadTiming(start, {
        accessor: "getSpawnedSessionStatuses",
        projectPath,
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
        storeSessionName: sessionName,
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
        storeSessionName: sessionName,
      });
    }
  }

  async function getSessionMarkdownDocuments(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionMarkdownDocument[]> {
    const start = performance.now();
    try {
      return repos.sessionMarkdownDocuments.findBySession(
        projectPath,
        sessionName,
      );
    } finally {
      emitReadTiming(start, {
        accessor: "getSessionMarkdownDocuments",
        projectPath,
        storeSessionName: sessionName,
      });
    }
  }

  async function isSessionMarkdownDocumentIndexed(
    projectPath: string,
    sessionName: string,
    docPath: string,
  ): Promise<boolean> {
    return repos.sessionMarkdownDocuments.exists(
      projectPath,
      sessionName,
      docPath,
    );
  }

  async function getDocumentComments(
    projectPath: string,
    sessionName: string,
    docPath: string,
  ): Promise<DocumentComment[]> {
    const start = performance.now();
    try {
      return repos.documentComments.findByDocument(
        projectPath,
        sessionName,
        docPath,
      );
    } finally {
      emitReadTiming(start, {
        accessor: "getDocumentComments",
        projectPath,
        storeSessionName: sessionName,
      });
    }
  }

  async function getSessionDocumentComments(
    projectPath: string,
    sessionName: string,
  ): Promise<DocumentComment[]> {
    const start = performance.now();
    try {
      return repos.documentComments.findBySession(projectPath, sessionName);
    } finally {
      emitReadTiming(start, {
        accessor: "getSessionDocumentComments",
        projectPath,
        storeSessionName: sessionName,
      });
    }
  }

  async function getDocumentCommentInScope(
    projectPath: string,
    sessionName: string,
    id: string,
  ): Promise<DocumentComment | null> {
    const start = performance.now();
    try {
      return repos.documentComments.findByIdInScope(
        projectPath,
        sessionName,
        id,
      );
    } finally {
      emitReadTiming(start, {
        accessor: "getDocumentCommentInScope",
        projectPath,
        storeSessionName: sessionName,
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

  /**
   * Detail-tier read of one project's agent-capability overrides. Sibling of
   * `getProjectMcpOverrides`; backs the agent-capabilities resolution chain,
   * which needs a single project's overrides rather than the whole state.
   */
  async function getProjectAgentCapabilityOverrides(
    projectPath: string,
  ): Promise<AgentCapabilityOverrides | undefined> {
    const start = performance.now();
    try {
      const project = repos.projects.findByRootPath(projectPath);
      return project?.agentCapabilityOverrides;
    } finally {
      emitReadTiming(start, {
        accessor: "getProjectAgentCapabilityOverrides",
        projectPath,
      });
    }
  }

  /**
   * Identity-tier listing of every project's root path (key column only, no
   * override blobs). Backs cross-project fanouts that need to enumerate projects
   * without paying the whole-state read.
   */
  async function listProjectPaths(): Promise<readonly string[]> {
    const start = performance.now();
    try {
      return repos.projects.listRootPaths();
    } finally {
      emitReadTiming(start, { accessor: "listProjectPaths" });
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

  /**
   * Tail of the persisted append-only event log for a graph-workflow execution,
   * in chronological order (oldest first). Replaces reading
   * `execution.history`. Caller passes a limit so the full log is never loaded
   * into memory.
   */
  async function getGraphWorkflowEventsTail(
    executionId: string,
    limit: number,
  ): Promise<GraphWorkflowExecutionEvent[]> {
    return repos.graphWorkflowEvents.findTail(executionId, limit);
  }

  /**
   * One cursor-paginated page of a graph-workflow execution's event log
   * (D4 decision D9). The tail accessor above answers "what happened lately";
   * this is the reader for COMPLETE history — the loop ledger's full decision
   * record, including passes re-decided under an amended control revision —
   * which the bounded tail structurally cannot serve. Keyset-paginated, so
   * walking a long log costs one index range per page.
   */
  async function getGraphWorkflowEventsPage(
    executionId: string,
    query: GraphWorkflowEventPageQuery,
  ): Promise<GraphWorkflowEventPage> {
    return repos.graphWorkflowEvents.findPage(executionId, query);
  }

  /**
   * Latest persisted event of `eventType` filed under `contextId` for an
   * execution, or null. Backs the iteration orchestrator's latest-validation
   * lookup. Returns the single most recent row via the context index.
   */
  async function findLatestGraphWorkflowContextEvent(
    executionId: string,
    contextId: string,
    eventType: string,
  ): Promise<GraphWorkflowExecutionEvent | null> {
    return repos.graphWorkflowEvents.findLatestForContext(
      executionId,
      contextId,
      eventType,
    );
  }

  /**
   * The merged active graph-workflow execution for one session, or null.
   * Reads the dedicated `graph_workflow_executions` table (definition ⊕ runtime
   * tiers) — never the vestigial `sessions.graph_workflow_execution` column.
   */
  async function getActiveGraphWorkflowExecution(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null> {
    const start = performance.now();
    try {
      return repos.graphWorkflowExecutions.getActive(projectPath, sessionName);
    } finally {
      emitReadTiming(start, {
        accessor: "getActiveGraphWorkflowExecution",
        projectPath,
        storeSessionName: sessionName,
      });
    }
  }

  /**
   * Every active graph-workflow execution across all sessions, keyed by
   * `${projectPath}\0${sessionName}` (NUL-separated). Backs the
   * active-conversations feed, which needs the executions of many sessions in a
   * single read instead of N per-session point lookups.
   */
  async function listActiveGraphWorkflowExecutions(): Promise<
    Map<string, GraphWorkflowExecution>
  > {
    const start = performance.now();
    try {
      return repos.graphWorkflowExecutions.listActive();
    } finally {
      emitReadTiming(start, {
        accessor: "listActiveGraphWorkflowExecutions",
      });
    }
  }

  async function listArchivedGraphWorkflowExecutions(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution[]> {
    return repos.graphWorkflowArchivedExecutions.listBySession(
      projectPath,
      sessionName,
    );
  }

  return {
    getSession,
    getProjectSessions,
    getProjectSessionListItems,
    getConversation,
    getConversationById,
    getSessionConversations,
    getProjectConversation,
    getProjectConversationById,
    getProjectConversations,
    listAllProjectConversations,
    listConversationIdentities,
    listSessionConversationListItems,
    getSpawnedSessionStatuses,
    getReferenceDocuments,
    getSessionMarkdownDocuments,
    isSessionMarkdownDocumentIndexed,
    getDocumentComments,
    getSessionDocumentComments,
    getDocumentCommentInScope,
    getProjectMcpOverrides,
    getProjectAgentCapabilityOverrides,
    listProjectPaths,
    getArchivedProjects,
    getPinnedProjects,
    getGraphWorkflowEventsTail,
    getGraphWorkflowEventsPage,
    findLatestGraphWorkflowContextEvent,
    getActiveGraphWorkflowExecution,
    listActiveGraphWorkflowExecutions,
    listArchivedGraphWorkflowExecutions,
  };
}
