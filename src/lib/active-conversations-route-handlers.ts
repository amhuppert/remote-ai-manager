/**
 * Active conversations route handler logic — extracted for dependency injection.
 *
 * Route files delegate to these handlers, passing production deps.
 * Tests create handlers with mock deps via `createActiveConversationsRouteHandlers(deps)`.
 */

import { NextResponse } from "next/server";
import { readState as defaultReadState } from "@/lib/state";
import { getProjectDisplayName as defaultGetProjectDisplayName } from "@/lib/project-resolver";
import type {
  ManagerState,
  ConversationStatus,
  GraphWorkflowCleanupStatusValue,
  GraphWorkflowHaltReason,
  GraphWorkflowMergeStatusValue,
  GraphWorkflowStatus,
} from "@/types";
import type { ApiError } from "@/types";

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface ActiveConversationsRouteDeps {
  readState: () => Promise<ManagerState>;
  getProjectDisplayName: (projectPath: string) => string;
}

const defaultDeps: ActiveConversationsRouteDeps = {
  readState: defaultReadState,
  getProjectDisplayName: defaultGetProjectDisplayName,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ActiveConversation {
  id: string;
  name: string | null;
  status: ConversationStatus;
  lastActivityAt: string;
  projectName: string;
  projectPath: string;
  sessionName: string;
  agentBackend: "claude" | "codex";
}

export interface ActiveGraphWorkflowContextMergeProgress {
  contextId: string;
  branchName: string | null;
  mergeStatus: GraphWorkflowMergeStatusValue;
  cleanupStatus: GraphWorkflowCleanupStatusValue;
  lastMergeError: string | null;
}

export interface ActiveGraphWorkflowExecution {
  executionId: string;
  status: GraphWorkflowStatus;
  projectName: string;
  projectPath: string;
  sessionName: string;
  activeContextIds: string[];
  activeContextTitles: string[];
  activeBatchIds: string[];
  pendingHaltReason: GraphWorkflowHaltReason | null;
  contextMergeProgress: ActiveGraphWorkflowContextMergeProgress[];
  completedContexts: number;
  totalContexts: number;
  startedAt: string;
}

export interface ActiveCollaborationExecution {
  workflowId: string;
  status: "running" | "paused";
  phase: string;
  projectName: string;
  projectPath: string;
  sessionName: string;
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ExtractedCollaborationEnvelope {
  workflowId: string;
  status: "running" | "paused";
  phase: string;
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
}

function extractActiveCollaborationEnvelopes(session: {
  workflowEnvelopes?: Record<string, unknown>;
}): ExtractedCollaborationEnvelope[] {
  if (!session.workflowEnvelopes) return [];
  const out: ExtractedCollaborationEnvelope[] = [];
  for (const raw of Object.values(session.workflowEnvelopes)) {
    if (!raw || typeof raw !== "object") continue;
    const envelope = raw as {
      workflowId?: unknown;
      workflowType?: unknown;
      status?: unknown;
      phase?: unknown;
      createdAt?: unknown;
      updatedAt?: unknown;
      featureSnapshot?: unknown;
    };
    if (envelope.workflowType !== "collaboration") continue;
    if (envelope.status !== "running" && envelope.status !== "paused") continue;
    if (
      typeof envelope.workflowId !== "string" ||
      typeof envelope.phase !== "string" ||
      typeof envelope.createdAt !== "string" ||
      typeof envelope.updatedAt !== "string"
    ) {
      continue;
    }
    let conversationId: string | null = null;
    if (
      envelope.featureSnapshot &&
      typeof envelope.featureSnapshot === "object"
    ) {
      const snap = envelope.featureSnapshot as { conversationId?: unknown };
      if (typeof snap.conversationId === "string") {
        conversationId = snap.conversationId;
      }
    }
    out.push({
      workflowId: envelope.workflowId,
      status: envelope.status,
      phase: envelope.phase,
      conversationId,
      createdAt: envelope.createdAt,
      updatedAt: envelope.updatedAt,
    });
  }
  return out;
}

/** Statuses that qualify a conversation as "active" (visible in panels). */
const ACTIVE_STATUSES: ReadonlySet<ConversationStatus> = new Set([
  "new",
  "running",
  "awaiting",
  "waiting_for_input",
]);

/** Graph workflow statuses that qualify as "active". */
const ACTIVE_GW_STATUSES: ReadonlySet<GraphWorkflowStatus> = new Set([
  "pending",
  "running",
  "paused",
]);

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createActiveConversationsRouteHandlers(
  deps: ActiveConversationsRouteDeps = defaultDeps,
) {
  async function GET(): Promise<Response> {
    try {
      const state = await deps.readState();
      const conversations: ActiveConversation[] = [];
      const graphWorkflowExecutions: ActiveGraphWorkflowExecution[] = [];
      const activeCollaborationExecutions: ActiveCollaborationExecution[] = [];

      for (const [projectPath, project] of Object.entries(state.projects)) {
        if (state.archivedProjects.includes(projectPath)) continue;

        const projectName = deps.getProjectDisplayName(projectPath);

        for (const session of Object.values(project.sessions)) {
          if (session.archived) continue;

          for (const envelope of extractActiveCollaborationEnvelopes(session)) {
            activeCollaborationExecutions.push({
              workflowId: envelope.workflowId,
              status: envelope.status,
              phase: envelope.phase,
              projectName,
              projectPath,
              sessionName: session.sessionName,
              conversationId: envelope.conversationId,
              createdAt: envelope.createdAt,
              updatedAt: envelope.updatedAt,
            });
          }

          for (const convo of session.conversations) {
            if (convo.archived) continue;
            if (!ACTIVE_STATUSES.has(convo.status)) continue;
            if (convo.role === "iteration" || convo.role === "validator")
              continue;

            conversations.push({
              id: convo.id,
              name: convo.name ?? convo.summary ?? null,
              status: convo.status,
              lastActivityAt: convo.lastActivityAt,
              projectName,
              projectPath,
              sessionName: session.sessionName,
              agentBackend: convo.agentBackend,
            });
          }

          // Collect active graph workflow executions
          const exec = session.graphWorkflowExecution;
          if (exec && ACTIVE_GW_STATUSES.has(exec.status)) {
            const activeContextIds = [...exec.activeContextIds];
            const activeContextTitles = activeContextIds.map((id) => {
              const context = exec.workingDefinition.executionContexts.find(
                (c) => c.id === id,
              );
              return context?.title ?? id;
            });

            const seenBatches = new Set<string>();
            const activeBatchIds: string[] = [];
            for (const contextId of activeContextIds) {
              const batchId = exec.contextStates[contextId]?.batchId;
              if (batchId && !seenBatches.has(batchId)) {
                seenBatches.add(batchId);
                activeBatchIds.push(batchId);
              }
            }

            const contextMergeProgress: ActiveGraphWorkflowContextMergeProgress[] =
              [];
            for (const contextId of activeContextIds) {
              const state = exec.contextStates[contextId];
              if (!state) continue;
              if (
                state.mergeStatus === "not-applicable" &&
                state.cleanupStatus === "not-applicable" &&
                state.lastMergeError === null
              ) {
                continue;
              }
              contextMergeProgress.push({
                contextId,
                branchName: state.branchName,
                mergeStatus: state.mergeStatus,
                cleanupStatus: state.cleanupStatus,
                lastMergeError: state.lastMergeError,
              });
            }

            const completedContexts = Object.values(exec.contextStates).filter(
              (cs) => cs.status === "completed",
            ).length;

            graphWorkflowExecutions.push({
              executionId: exec.id,
              status: exec.status,
              projectName,
              projectPath,
              sessionName: session.sessionName,
              activeContextIds,
              activeContextTitles,
              activeBatchIds,
              pendingHaltReason: exec.pendingHaltReason,
              contextMergeProgress,
              completedContexts,
              totalContexts: exec.workingDefinition.executionContexts.length,
              startedAt: exec.startedAt,
            });
          }
        }
      }

      conversations.sort(
        (a, b) =>
          new Date(b.lastActivityAt).getTime() -
          new Date(a.lastActivityAt).getTime(),
      );

      return NextResponse.json({
        conversations,
        graphWorkflowExecutions,
        activeCollaborationExecutions,
      });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Failed to read active conversations";
      return NextResponse.json({ error: message } satisfies ApiError, {
        status: 500,
      });
    }
  }

  return { GET };
}
