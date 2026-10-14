/**
 * Active conversations route handler logic — extracted for dependency injection.
 *
 * Route files delegate to these handlers, passing production deps.
 * Tests create handlers with mock deps via `createActiveConversationsRouteHandlers(deps)`.
 */

import { NextResponse } from "next/server";
import { createLogger, withTracing } from "@/lib/logging";
import {
  getArchivedProjects as defaultGetArchivedProjects,
  listAllProjectConversations as defaultListAllProjectConversations,
  listSessionConversationListItems as defaultListSessionConversationListItems,
  type SessionConversationListItem,
} from "@/lib/state-store";
import { getProjectDisplayName as defaultGetProjectDisplayName } from "@/lib/projects/resolver";
import { truncate } from "@/lib/shared/truncate";
import { readLastAssistantContent as defaultReadLastAssistantContent } from "@/lib/prompt/transcript";
import type {
  ActiveConversation,
  ActiveConversationForkedFrom,
} from "@/lib/active-conversations/schemas";
import { getBackgroundActivityChannel } from "@/lib/conversations/background-activity";
import { coreHoldsCustody } from "@/lib/supervision/handles";
import { redactedConversationProfile } from "@/lib/conversations/conversation-profile";
import type {
  AskQuestionItem,
  ConversationBackgroundActivity,
  ConversationState,
  ConversationStatus,
  MessageContentBlock,
} from "@/lib/conversations/schemas";
import type { ApiError } from "@/lib/api/errors";

const logger = createLogger("active-conversations.route");

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface ActiveConversationsRouteDeps {
  listSessionConversationListItems(): Promise<SessionConversationListItem[]>;
  getArchivedProjects(): Promise<Set<string>>;
  getProjectDisplayName(projectPath: string): string;
  readLastAssistantContent(
    transcriptPath: string | null,
  ): Promise<MessageContentBlock[] | null>;
  listProjectConversations(): Promise<
    { projectPath: string; conversation: ConversationState }[]
  >;
  /**
   * Live background-task snapshot for a conversation, read synchronously from
   * the in-memory channel. Deliberately not persisted: background tasks are
   * children of the backend subprocess and die with the server, so an empty
   * registry after a restart is the truth.
   */
  getBackgroundActivity(
    conversationId: string,
  ): ConversationBackgroundActivity | null;
  /**
   * Whether custody holds the conversation's runtime between turns, read from
   * the core synchronously. Not persisted: custody does not outlive the
   * server. Absent, no row shows custody.
   */
  holdsCustody?(conversationId: string): boolean;
}

const defaultDeps: ActiveConversationsRouteDeps = {
  listSessionConversationListItems: defaultListSessionConversationListItems,
  getArchivedProjects: defaultGetArchivedProjects,
  getProjectDisplayName: defaultGetProjectDisplayName,
  readLastAssistantContent: defaultReadLastAssistantContent,
  listProjectConversations: defaultListAllProjectConversations,
  getBackgroundActivity: (conversationId) =>
    getBackgroundActivityChannel().get(conversationId),
  holdsCustody: coreHoldsCustody,
};

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
  workflowEnvelopes?: Record<string, unknown> | null;
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
    return truncate(collapseWhitespace(q), LAST_ACTIVITY_MAX, {
      countEllipsisInBudget: true,
    });
  }

  // status === "running"
  if (!lastAssistantMessage) return null;
  const blocks = lastAssistantMessage.content;

  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block?.type === "tool_use") {
      const summary = summarizeToolUse(block);
      if (summary)
        return truncate(collapseWhitespace(summary), LAST_ACTIVITY_MAX, {
          countEllipsisInBudget: true,
        });
    }
  }
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block?.type === "text") {
      const text = collapseWhitespace(block.text);
      if (text.length === 0) continue;
      return truncate(text, LAST_ACTIVITY_MAX, {
        countEllipsisInBudget: true,
      });
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
  async function GET(request?: Request): Promise<Response> {
    try {
      const params = request ? new URL(request.url).searchParams : null;
      const sidebar = params?.get("view") === "sidebar";
      const includeArchived =
        sidebar && params?.get("includeArchived") === "true";
      const [sessionItems, archivedProjects, projectConversations] =
        await Promise.all([
          deps.listSessionConversationListItems(),
          deps.getArchivedProjects(),
          deps.listProjectConversations(),
        ]);
      const conversations: ActiveConversation[] = [];
      const activeCollaborationExecutions: ActiveCollaborationExecution[] = [];

      const transcriptTasks: Array<{
        conversationId: string;
        transcriptPath: string | null;
      }> = [];
      for (const {
        projectPath,
        session,
        conversations: convos,
      } of sessionItems) {
        if (archivedProjects.has(projectPath)) continue;
        if (session.archived) continue;
        for (const convo of convos) {
          if (convo.archived && !includeArchived) continue;
          if (!ACTIVE_STATUSES.has(convo.status)) continue;
          if (
            !sidebar &&
            (convo.role === "iteration" || convo.role === "validator")
          )
            continue;
          if (convo.status !== "running") continue;
          transcriptTasks.push({
            conversationId: convo.id,
            transcriptPath: convo.transcriptPath,
          });
        }
      }
      for (const { projectPath, conversation } of projectConversations) {
        if (archivedProjects.has(projectPath)) continue;
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

      // Regroup the flat session list by project so the display name resolves
      // once per project, preserving the per-project → per-session structure.
      const sessionsByProject = new Map<
        string,
        SessionConversationListItem[]
      >();
      for (const item of sessionItems) {
        const arr = sessionsByProject.get(item.projectPath);
        if (arr) arr.push(item);
        else sessionsByProject.set(item.projectPath, [item]);
      }

      for (const [projectPath, projectSessions] of sessionsByProject) {
        if (archivedProjects.has(projectPath)) continue;

        const projectName = deps.getProjectDisplayName(projectPath);

        for (const { session, conversations: convos } of projectSessions) {
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

          for (const convo of convos) {
            if (convo.archived && !includeArchived) continue;
            const hasPendingQuestion =
              convo.status === "waiting_for_input" &&
              convo.pendingQuestionId !== null;
            // Human-input rows bypass the role filter so workflow-managed lane
            // conversations surface while a question or approval is pending.
            // Archival above remains authoritative.
            if (!sidebar && !hasPendingQuestion) {
              if (!ACTIVE_STATUSES.has(convo.status)) continue;
              if (convo.role === "iteration" || convo.role === "validator")
                continue;
            }

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
              ...(sidebar ? { archived: convo.archived } : {}),
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
              backgroundActivity: deps.getBackgroundActivity(convo.id),
              custody: deps.holdsCustody?.(convo.id) ?? false,
              // Already redacted by the store's list-item projection: the
              // snapshot blob never leaves SQLite for this feed.
              redactedProfileSnapshot: convo.redactedProfileSnapshot,
            });
          }
        }
      }

      // Project-conversation pass: session-less conversations across all
      // projects. Visibility mirrors the lifecycle rules — non-archived
      // (including closed) conversations in an active status are listed;
      // archived ones are excluded by default. The `open` flag is presentation
      // metadata for the downstream rail, not a visibility gate here.
      let includedProjectConversationCount = 0;
      let closedProjectConversationCount = 0;
      let excludedProjectConversationCount = 0;

      for (const { projectPath, conversation } of projectConversations) {
        if (archivedProjects.has(projectPath)) {
          excludedProjectConversationCount += 1;
          continue;
        }
        if (conversation.archived) {
          excludedProjectConversationCount += 1;
          continue;
        }
        if (!ACTIVE_STATUSES.has(conversation.status)) {
          excludedProjectConversationCount += 1;
          continue;
        }
        if (
          conversation.role === "iteration" ||
          conversation.role === "validator"
        ) {
          excludedProjectConversationCount += 1;
          continue;
        }

        const open = conversation.open !== false;
        includedProjectConversationCount += 1;
        if (!open) closedProjectConversationCount += 1;

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
          open,
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
          backgroundActivity: deps.getBackgroundActivity(conversation.id),
          custody: deps.holdsCustody?.(conversation.id) ?? false,
          // The project walk reads whole rows, so redaction happens here.
          redactedProfileSnapshot: redactedConversationProfile(conversation),
        });
      }

      logger.debug("project_conversations.active_pass.complete", {
        includedProjectConversationCount,
        closedProjectConversationCount,
        excludedProjectConversationCount,
      });

      conversations.sort(
        (a, b) =>
          new Date(b.lastActivityAt).getTime() -
          new Date(a.lastActivityAt).getTime(),
      );

      logger.debug("active_conversations.list", {
        view: sidebar ? "sidebar" : "active",
        includeArchived,
        conversationCount: conversations.length,
        archivedCount: conversations.filter((row) => row.archived).length,
      });

      return NextResponse.json({
        conversations,
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
export const listActiveConversations = withTracing(
  _defaultActiveConversationsHandlers.GET,
);
