/**
 * Active conversations route handler logic — extracted for dependency injection.
 *
 * Route files delegate to these handlers, passing production deps.
 * Tests create handlers with mock deps via `createActiveConversationsRouteHandlers(deps)`.
 */

import { NextResponse } from "next/server";
import { createLogger } from "@/lib/logging";
import {
  readState as defaultReadState,
  listAllProjectConversations as defaultListAllProjectConversations,
} from "@/lib/state-store";
import { getProjectDisplayName as defaultGetProjectDisplayName } from "@/lib/projects/resolver";
import { readLastAssistantContent as defaultReadLastAssistantContent } from "@/lib/prompt/transcript";
import { createExecutionIndex } from "@/lib/workflow-graph/execution-index";
import type {
  ActiveConversation,
  ActiveConversationForkedFrom,
} from "@/lib/active-conversations/schemas";
import type {
  AskQuestionItem,
  ConversationState,
  ConversationStatus,
  MessageContentBlock,
} from "@/lib/conversations/schemas";
import type { ManagerState } from "@/lib/projects/schemas";
import type {
  GraphWorkflowCleanupStatusValue,
  GraphWorkflowExecutionJoinKind,
  GraphWorkflowExecutionJoinStatus,
  GraphWorkflowHaltReason,
  GraphWorkflowMergeStatusValue,
  GraphWorkflowStatus,
} from "@/lib/workflows/schemas";
import type { ApiError } from "@/lib/api/errors";

const logger = createLogger("active-conversations.route");

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface ActiveConversationsRouteDeps {
  readState(): Promise<ManagerState>;
  getProjectDisplayName(projectPath: string): string;
  readLastAssistantContent(
    transcriptPath: string | null,
  ): Promise<MessageContentBlock[] | null>;
  listProjectConversations(): Promise<
    { projectPath: string; conversation: ConversationState }[]
  >;
}

const defaultDeps: ActiveConversationsRouteDeps = {
  readState: defaultReadState,
  getProjectDisplayName: defaultGetProjectDisplayName,
  readLastAssistantContent: defaultReadLastAssistantContent,
  listProjectConversations: defaultListAllProjectConversations,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActiveGraphWorkflowContextMergeProgress {
  contextId: string;
  branchName: string | null;
  mergeStatus: GraphWorkflowMergeStatusValue;
  cleanupStatus: GraphWorkflowCleanupStatusValue;
  lastMergeError: string | null;
}

export interface ActiveGraphWorkflowJoinProgress {
  joinId: string;
  kind: GraphWorkflowExecutionJoinKind;
  contextId: string | null;
  targetLaneId: string;
  sourceLaneIds: string[];
  mergedSourceLaneIds: string[];
  status: GraphWorkflowExecutionJoinStatus;
}

export interface ActiveGraphWorkflowFinalPublishProgress {
  joinId: string;
  targetLaneId: string;
  sourceLaneIds: string[];
  mergedSourceLaneIds: string[];
  status: GraphWorkflowExecutionJoinStatus;
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
  activeJoinIds: string[];
  joinProgress: ActiveGraphWorkflowJoinProgress[];
  finalPublishState: ActiveGraphWorkflowFinalPublishProgress | null;
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

interface PendingQuestionFields {
  pendingQuestion: string | null;
  pendingQuestionId: string | null;
  pendingQuestions: AskQuestionItem[] | null;
}

function derivePendingQuestionFields(convo: {
  status: ConversationStatus;
  pendingQuestionId: string | null;
  pendingQuestions: AskQuestionItem[] | null;
}): PendingQuestionFields {
  const pendingQuestion = derivePendingQuestionText(convo);

  if (convo.status !== "waiting_for_input") {
    return {
      pendingQuestion,
      pendingQuestionId: null,
      pendingQuestions: null,
    };
  }

  if (!convo.pendingQuestionId || !convo.pendingQuestions?.length) {
    return {
      pendingQuestion,
      pendingQuestionId: null,
      pendingQuestions: null,
    };
  }

  return {
    pendingQuestion,
    pendingQuestionId: convo.pendingQuestionId,
    pendingQuestions: convo.pendingQuestions,
  };
}

function derivePendingQuestionText(convo: {
  status: ConversationStatus;
  pendingQuestions: Pick<AskQuestionItem, "question">[] | null;
}): string | null {
  if (convo.status !== "awaiting" && convo.status !== "waiting_for_input") {
    return null;
  }
  const first = convo.pendingQuestions?.[0];
  return first ? first.question : null;
}

const LAST_ACTIVITY_MAX = 80;

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function summarizeToolUse(block: {
  name: string;
  input?: Record<string, unknown>;
}): string | null {
  const input = block.input ?? {};
  const filePath = typeof input.file_path === "string" ? input.file_path : null;
  switch (block.name) {
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return filePath ? `Editing ${filePath}` : "Editing files";
    case "Read":
      return filePath ? `Reading ${filePath}` : "Reading file";
    case "Bash": {
      const cmd = typeof input.command === "string" ? input.command : null;
      return cmd ? `Running: ${cmd}` : "Running command";
    }
    case "Glob":
    case "Grep": {
      const pat = typeof input.pattern === "string" ? input.pattern : null;
      return pat ? `Searching ${pat}` : "Searching";
    }
    default:
      return `Using ${block.name}`;
  }
}

/**
 * Derive a single-line human-readable summary of what the conversation is doing.
 * Pure function — exported so it can be unit-tested without the full route handler.
 */
export function deriveLastActivitySummary(
  convo: {
    status: ConversationStatus;
    pendingQuestions: { question: string }[] | null;
  },
  lastAssistantMessage: { content: MessageContentBlock[] } | null,
): string | null {
  if (convo.status === "new") return null;

  if (convo.status === "awaiting" || convo.status === "waiting_for_input") {
    const q = convo.pendingQuestions?.[0]?.question;
    if (!q) return null;
    return truncate(collapseWhitespace(q), LAST_ACTIVITY_MAX);
  }

  // status === "running"
  if (!lastAssistantMessage) return null;
  const blocks = lastAssistantMessage.content;

  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block?.type === "tool_use") {
      const summary = summarizeToolUse(block);
      if (summary)
        return truncate(collapseWhitespace(summary), LAST_ACTIVITY_MAX);
    }
  }
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block?.type === "text") {
      const text = collapseWhitespace(block.text);
      if (text.length === 0) continue;
      return truncate(text, LAST_ACTIVITY_MAX);
    }
  }
  return null;
}

/**
 * Map the persisted forkedFrom shape (sourceConversationId + forkMode) onto the
 * sidebar API shape ({ conversationId, messageIndex, mode }). Conversations whose
 * forkMode is null are treated as "fork mode unknown" and not surfaced.
 */
function deriveForkedFrom(
  forkedFrom: {
    sourceConversationId: string;
    messageIndex: number;
    forkMode: "native" | "synthetic" | null | undefined;
  } | null,
): ActiveConversationForkedFrom | null {
  if (!forkedFrom) return null;
  const mode = forkedFrom.forkMode;
  if (mode !== "native" && mode !== "synthetic") return null;
  return {
    conversationId: forkedFrom.sourceConversationId,
    messageIndex: forkedFrom.messageIndex,
    mode,
  };
}

/**
 * Read the most recent assistant content blocks for a conversation. Returns
 * null on missing transcript or any read failure — lastActivitySummary is a
 * best-effort field and must never break the response.
 */
async function readLastAssistantBlocks(
  readLastAssistantContent: (
    transcriptPath: string | null,
  ) => Promise<MessageContentBlock[] | null>,
  transcriptPath: string | null,
): Promise<MessageContentBlock[] | null> {
  if (!transcriptPath) return null;
  try {
    return await readLastAssistantContent(transcriptPath);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createActiveConversationsRouteHandlers(
  deps: ActiveConversationsRouteDeps = defaultDeps,
) {
  async function GET(): Promise<Response> {
    try {
      const state = await deps.readState();
      const projectConversations = await deps.listProjectConversations();
      const conversations: ActiveConversation[] = [];
      const graphWorkflowExecutions: ActiveGraphWorkflowExecution[] = [];
      const activeCollaborationExecutions: ActiveCollaborationExecution[] = [];

      const transcriptTasks: Array<{
        conversationId: string;
        transcriptPath: string | null;
      }> = [];
      for (const [projectPath, project] of Object.entries(state.projects)) {
        if (state.archivedProjects.includes(projectPath)) continue;
        for (const session of Object.values(project.sessions)) {
          if (session.archived) continue;
          for (const convo of session.conversations) {
            if (convo.archived) continue;
            if (!ACTIVE_STATUSES.has(convo.status)) continue;
            if (convo.role === "iteration" || convo.role === "validator")
              continue;
            if (convo.status !== "running") continue;
            transcriptTasks.push({
              conversationId: convo.id,
              transcriptPath: convo.transcriptPath,
            });
          }
        }
      }
      for (const { projectPath, conversation } of projectConversations) {
        if (state.archivedProjects.includes(projectPath)) continue;
        if (conversation.archived) continue;
        if (conversation.status !== "running") continue;
        transcriptTasks.push({
          conversationId: conversation.id,
          transcriptPath: conversation.transcriptPath,
        });
      }

      const lastBlocksByConvId = new Map<
        string,
        MessageContentBlock[] | null
      >();
      await Promise.all(
        transcriptTasks.map(async (t) => {
          lastBlocksByConvId.set(
            t.conversationId,
            await readLastAssistantBlocks(
              deps.readLastAssistantContent,
              t.transcriptPath,
            ),
          );
        }),
      );

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

            const lastAssistantBlocks =
              convo.status === "running"
                ? (lastBlocksByConvId.get(convo.id) ?? null)
                : null;
            const pendingQuestionFields = derivePendingQuestionFields(convo);

            if (
              convo.status === "waiting_for_input" &&
              (convo.pendingQuestionId !== null ||
                convo.pendingQuestions !== null) &&
              (pendingQuestionFields.pendingQuestionId === null ||
                pendingQuestionFields.pendingQuestions === null)
            ) {
              logger.warn("pending_question.incomplete", {
                projectPath,
                sessionName: session.sessionName,
                conversationId: convo.id,
                hasPendingQuestionId: convo.pendingQuestionId !== null,
                pendingQuestionCount: convo.pendingQuestions?.length ?? null,
              });
            }

            conversations.push({
              scope: "session",
              id: convo.id,
              name: convo.name ?? convo.summary ?? null,
              status: convo.status,
              lastActivityAt: convo.lastActivityAt,
              projectName,
              projectPath,
              sessionName: session.sessionName,
              agentBackend: convo.agentBackend,
              summary: convo.summary,
              pendingQuestion: pendingQuestionFields.pendingQuestion,
              pendingQuestionId: pendingQuestionFields.pendingQuestionId,
              pendingQuestions: pendingQuestionFields.pendingQuestions,
              forkedFrom: deriveForkedFrom(convo.forkedFrom),
              debugActive: convo.debugMode?.active === true,
              role: convo.role,
              branchName: session.branchName,
              worktreePath: session.worktreePath,
              lastActivitySummary: deriveLastActivitySummary(
                convo,
                lastAssistantBlocks ? { content: lastAssistantBlocks } : null,
              ),
              unread: convo.unread === true,
            });
          }

          // Collect active graph workflow executions
          const exec = session.graphWorkflowExecution;
          if (exec && ACTIVE_GW_STATUSES.has(exec.status)) {
            const index = createExecutionIndex(exec.workingDefinition, exec);
            const activeContextIds = [...exec.activeContextIds];
            const activeContextTitles = activeContextIds.map((id) => {
              const context = index.contextById.get(id);
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

            const joinValues = Object.values(exec.joins ?? {});
            const activeJoins = joinValues
              .filter((j) => j.status === "pending" || j.status === "running")
              .sort((a, b) => a.joinId.localeCompare(b.joinId));
            const activeJoinIds = activeJoins.map((j) => j.joinId);
            const joinProgress: ActiveGraphWorkflowJoinProgress[] =
              activeJoins.map((j) => ({
                joinId: j.joinId,
                kind: j.kind,
                contextId: j.contextId,
                targetLaneId: j.targetLaneId,
                sourceLaneIds: [...j.sourceLaneIds],
                mergedSourceLaneIds: [...j.mergedSourceLaneIds],
                status: j.status,
              }));
            const finalPublishJoin = activeJoins.find(
              (j) => j.kind === "final_publish",
            );
            const finalPublishState: ActiveGraphWorkflowFinalPublishProgress | null =
              finalPublishJoin
                ? {
                    joinId: finalPublishJoin.joinId,
                    targetLaneId: finalPublishJoin.targetLaneId,
                    sourceLaneIds: [...finalPublishJoin.sourceLaneIds],
                    mergedSourceLaneIds: [
                      ...finalPublishJoin.mergedSourceLaneIds,
                    ],
                    status: finalPublishJoin.status,
                  }
                : null;

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
              activeJoinIds,
              joinProgress,
              finalPublishState,
              completedContexts,
              totalContexts: exec.workingDefinition.executionContexts.length,
              startedAt: exec.startedAt,
            });
          }
        }
      }

      // Project-conversation pass: session-less conversations across all
      // projects. Visibility mirrors the lifecycle rules — non-archived
      // (including closed) conversations in an active status are listed;
      // archived ones are excluded by default. The `open` flag is presentation
      // metadata for the downstream rail, not a visibility gate here.
      for (const { projectPath, conversation } of projectConversations) {
        if (state.archivedProjects.includes(projectPath)) continue;
        if (conversation.archived) continue;
        if (!ACTIVE_STATUSES.has(conversation.status)) continue;
        if (
          conversation.role === "iteration" ||
          conversation.role === "validator"
        ) {
          continue;
        }

        const lastAssistantBlocks =
          conversation.status === "running"
            ? (lastBlocksByConvId.get(conversation.id) ?? null)
            : null;
        const pendingQuestionFields = derivePendingQuestionFields(conversation);

        conversations.push({
          scope: "project",
          id: conversation.id,
          name: conversation.name ?? conversation.summary ?? null,
          status: conversation.status,
          lastActivityAt: conversation.lastActivityAt,
          projectName: deps.getProjectDisplayName(projectPath),
          projectPath,
          agentBackend: conversation.agentBackend,
          summary: conversation.summary,
          pendingQuestion: pendingQuestionFields.pendingQuestion,
          pendingQuestionId: pendingQuestionFields.pendingQuestionId,
          pendingQuestions: pendingQuestionFields.pendingQuestions,
          forkedFrom: deriveForkedFrom(conversation.forkedFrom),
          debugActive: conversation.debugMode?.active === true,
          role: conversation.role,
          worktreePath: projectPath,
          lastActivitySummary: deriveLastActivitySummary(
            conversation,
            lastAssistantBlocks ? { content: lastAssistantBlocks } : null,
          ),
          unread: conversation.unread === true,
        });
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

// ---------------------------------------------------------------------------
// Default named exports — consumed directly by route shells
// ---------------------------------------------------------------------------

const _defaultActiveConversationsHandlers =
  createActiveConversationsRouteHandlers();
export const listActiveConversations = _defaultActiveConversationsHandlers.GET;
