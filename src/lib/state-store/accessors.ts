import { z } from "zod";
import { createLogger } from "@/lib/logging";
import {
  deriveSessionLastActivityFromConvs,
  deriveSessionPromptCountFromConvs,
  deriveSessionStatusFromParts,
  getCollaborationEnvelopeContribution,
} from "@/lib/sessions/derived";
import {
  sessionListItemSchema,
  spawnedFromSchema,
} from "@/lib/sessions/schemas";
import { isProjectSentinel } from "@/lib/conversations/project-conversation-scope";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { McpOverrides } from "@/lib/mcp/schemas";
import type { ManagerState } from "@/lib/projects/schemas";
import type { ReferenceDocument } from "@/lib/reference-documents/schemas";
import type { SessionListItem, SessionState } from "@/lib/sessions/schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionEvent,
} from "@/lib/workflows/schemas";
import type { StateStoreCore } from "./schemas";

const logger = createLogger("state-store");

const STATE_READ_TIMING_LOG_THRESHOLD_MS = 5;

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

export function createAccessors(core: StateStoreCore) {
  const { repos, aggregate } = core;

  async function readState(): Promise<ManagerState> {
    return aggregate.readAll();
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
        let spawnedFrom: SessionListItem["spawnedFrom"] = null;
        if (row.spawned_from !== null) {
          try {
            const parsed = spawnedFromSchema.safeParse(
              JSON.parse(row.spawned_from),
            );
            if (parsed.success) spawnedFrom = parsed.data;
          } catch {
            logger.warn("state-store.spawned_from_parse_failed", {
              projectPath,
              sessionName: row.session_name,
            });
          }
        }
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
          spawnedFrom,
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
        sessionName,
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

  async function listArchivedGraphWorkflowExecutions(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution[]> {
    const summaries =
      repos.graphWorkflowArchivedExecutions.listSummariesBySession(
        projectPath,
        sessionName,
      );
    const out: GraphWorkflowExecution[] = [];
    for (const summary of summaries) {
      const execution = repos.graphWorkflowArchivedExecutions.findByExecution(
        projectPath,
        sessionName,
        summary.executionId,
      );
      if (execution) out.push(execution);
    }
    return out;
  }

  return {
    readState,
    getSession,
    getProjectSessions,
    getProjectSessionListItems,
    getConversation,
    getConversationById,
    getSessionConversations,
    getProjectConversation,
    getProjectConversations,
    listAllProjectConversations,
    getSpawnedSessionStatuses,
    getReferenceDocuments,
    getProjectMcpOverrides,
    getArchivedProjects,
    getPinnedProjects,
    getGraphWorkflowEventsTail,
    findLatestGraphWorkflowContextEvent,
    listArchivedGraphWorkflowExecutions,
  };
}
