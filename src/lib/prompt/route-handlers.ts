/**
 * Prompt route handler logic — extracted for dependency injection.
 *
 * Route files delegate to these handlers, passing production deps.
 * Tests create handlers with mock deps via `createPromptRouteHandlers(deps)`.
 */

import { NextResponse } from "next/server";
import {
  notFound,
  resolveProjectSessionOr404,
} from "@/lib/shared/route-resolution";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import {
  getSession as defaultGetSession,
  getActiveGraphWorkflowExecution as defaultGetActiveGraphWorkflowExecution,
  clearConversationPendingPromptTextIfMatches as defaultClearConversationPendingPromptTextIfMatches,
} from "@/lib/state-store";
import {
  getConversation as defaultGetConversation,
  setConversationPendingPromptText as defaultSetConversationPendingPromptText,
} from "@/lib/conversations/service";
import {
  executePromptStream as defaultExecutePromptStream,
  BackendMismatchError,
  ModelEffortValidationError,
  CollabBriefRequiredError,
  CollabDispatcherUnavailableError,
  hasCollabPrefix,
  stripCollabPrefix,
} from "@/lib/prompt/sdk-driver";
import { isConversationBusy as defaultIsConversationBusy } from "@/lib/prompt/single-flight";
import {
  runPromptRequestSchema,
  pendingPromptRequestSchema,
} from "@/lib/prompt/schemas";
import { createLogger, withTracing } from "@/lib/logging";
import {
  getDefaultCollaborationManager,
  type CollaborationManager,
  CollaborationConversationNotFoundError,
  CollaborationSessionNotFoundError,
  CollaborationStartConflictError,
} from "@/lib/workflows/collaboration/manager";
import type { ApiError } from "@/lib/api/errors";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { RunPromptRequest } from "@/lib/prompt/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowStatus } from "@/lib/workflow-graph/definition-schemas";

const logger = createLogger("prompt");

const DEFAULT_NEGOTIATION_ROUNDS = 3;
const DEFAULT_AUTONOMOUS_RESOLUTION_THRESHOLD = "major" as const;

/**
 * Execution statuses under which an undecided approval gate admits chat —
 * mirrors the gate-standing set (the gate survives pause/halt and a decision
 * is recordable in those states, so chat stays available too).
 */
const GATE_CHAT_EXECUTION_STATUSES: ReadonlySet<GraphWorkflowStatus> = new Set([
  "running",
  "paused",
  "halted",
]);

/**
 * A managed conversation is chat-open while a context of the session's
 * in-flight execution is parked `awaiting_approval` on this conversation
 * with no recorded decision; the moment a decision lands the managed 403
 * applies again.
 */
function hasUndecidedApprovalGate(
  execution: GraphWorkflowExecution | null,
  conversationId: string,
): boolean {
  if (!execution) return false;
  if (!GATE_CHAT_EXECUTION_STATUSES.has(execution.status)) return false;
  return Object.values(execution.contextStates).some(
    (contextState) =>
      contextState.status === "awaiting_approval" &&
      contextState.pendingApproval?.conversationId === conversationId &&
      contextState.pendingApproval.decision === null,
  );
}

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface PromptRouteDeps {
  resolveProjectPath: (name: string) => Promise<string | null>;
  getSession: (
    projectPath: string,
    sessionName: string,
  ) => Promise<SessionState | null>;
  getConversation: (
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ) => Promise<ConversationState | null>;
  getActiveGraphWorkflowExecution: (
    projectPath: string,
    sessionName: string,
  ) => Promise<GraphWorkflowExecution | null>;
  isConversationBusy: (
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ) => boolean;
  executePromptStream: typeof defaultExecutePromptStream;
  getCollaborationManager: () => CollaborationManager;
  setConversationPendingPromptText(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    text: string | null,
  ): Promise<void>;
  clearConversationPendingPromptTextIfMatches(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    expectedText: string,
  ): Promise<boolean>;
}

const defaultDeps: PromptRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  getSession: defaultGetSession,
  getConversation: defaultGetConversation,
  getActiveGraphWorkflowExecution: defaultGetActiveGraphWorkflowExecution,
  isConversationBusy: defaultIsConversationBusy,
  executePromptStream: defaultExecutePromptStream,
  getCollaborationManager: getDefaultCollaborationManager,
  setConversationPendingPromptText: defaultSetConversationPendingPromptText,
  clearConversationPendingPromptTextIfMatches:
    defaultClearConversationPendingPromptTextIfMatches,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RouteContext = {
  params: Promise<Record<string, string>>;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPromptRouteHandlers(deps: PromptRouteDeps = defaultDeps) {
  async function POST(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolvedParams = await context.params;
    const name = resolvedParams["name"] ?? "";
    const sessionSlug = resolvedParams["session"] ?? "";
    const sessionName = decodeURIComponent(sessionSlug);

    const resolved = await resolveProjectSessionOr404(deps, name, sessionName);
    if (!resolved.ok) return resolved.response;
    const { projectPath, session } = resolved.value;

    // Session-level POSTs create a fresh conversation, so there is nothing
    // to be busy. Concurrency across conversations within a session is
    // allowed by design — gating happens at the conversation level.

    let body: RunPromptRequest;
    try {
      body = runPromptRequestSchema.parse(await request.json());
    } catch {
      return NextResponse.json(
        {
          error: "Either prompt text or at least one image is required",
        } satisfies ApiError,
        { status: 400 },
      );
    }

    const trimmedSessionPrompt = body.prompt.trim();
    const isSessionCollab = hasCollabPrefix(trimmedSessionPrompt);
    if (isSessionCollab) {
      const sessionBrief = stripCollabPrefix(trimmedSessionPrompt).trim();
      if (sessionBrief.length === 0) {
        return NextResponse.json(
          {
            error:
              "/collab prompt must include a brief after the slash command",
            code: "COLLAB_BRIEF_REQUIRED",
          } satisfies ApiError,
          { status: 400 },
        );
      }
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const emit = (event: string, data: unknown) => {
          try {
            controller.enqueue(
              encoder.encode(
                `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
              ),
            );
          } catch {
            // Client disconnected
          }
        };

        try {
          await deps.executePromptStream(
            projectPath,
            session,
            body.prompt.trim(),
            emit,
            undefined,
            body.modelId,
            body.images,
            {
              effort: body.effort,
              backend: body.backend,
              ...(body.documentFeedback
                ? { documentFeedback: body.documentFeedback }
                : {}),
              ...(isSessionCollab && body.collab
                ? {
                    collab: {
                      ...(body.collab.negotiationRounds !== undefined
                        ? { negotiationRounds: body.collab.negotiationRounds }
                        : {}),
                      ...(body.collab.autonomousResolutionThreshold !==
                      undefined
                        ? {
                            autonomousResolutionThreshold:
                              body.collab.autonomousResolutionThreshold,
                          }
                        : {}),
                    },
                  }
                : {}),
            },
          );
        } catch (err) {
          if (err instanceof CollabBriefRequiredError) {
            emit("error", { message: err.message, code: err.code });
            emit("done", {});
            return;
          }
          if (err instanceof CollabDispatcherUnavailableError) {
            emit("error", { message: err.message, code: err.code });
            emit("done", {});
            return;
          }
          if (err instanceof BackendMismatchError) {
            emit("error", { message: err.message, code: "BACKEND_MISMATCH" });
            emit("done", {});
            return;
          }
          if (err instanceof ModelEffortValidationError) {
            emit("error", { message: err.message, code: "VALIDATION_ERROR" });
            emit("done", {});
            return;
          }
          const msg = err instanceof Error ? err.message : "Prompt failed";
          emit("error", { message: msg });
          emit("done", {});
        } finally {
          try {
            controller.close();
          } catch {
            // Already closed
          }
        }
      },
      cancel() {
        // No-op: let execution continue in background
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  /**
   * POST handler for conversation-specific prompts.
   * Resolves conversationId from route params and guards against
   * prompting managed (iteration) conversations.
   */
  async function conversationPOST(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolvedParams = await context.params;
    const name = resolvedParams["name"] ?? "";
    const sessionSlug = resolvedParams["session"] ?? "";
    const sessionName = decodeURIComponent(sessionSlug);
    const conversationId = resolvedParams["conversationId"] ?? "";

    const resolved = await resolveProjectSessionOr404(deps, name, sessionName);
    if (!resolved.ok) return resolved.response;
    const { projectPath, session } = resolved.value;

    const conversation = await deps.getConversation(
      projectPath,
      sessionName,
      conversationId,
    );
    if (!conversation) {
      return notFound("Conversation not found");
    }

    if (conversation.role === "iteration") {
      const activeExecution = await deps.getActiveGraphWorkflowExecution(
        projectPath,
        sessionName,
      );
      const gateOpen = hasUndecidedApprovalGate(
        activeExecution,
        conversationId,
      );
      if (!gateOpen) {
        return NextResponse.json(
          {
            error: "Managed workflow conversations are not user-interactive",
            code: "MANAGED_CONVERSATION",
          } satisfies ApiError,
          { status: 403 },
        );
      }
      logger.info("gate.chat_admitted", {
        projectPath,
        sessionName,
        conversationId,
      });
    }

    if (deps.isConversationBusy(projectPath, sessionName, conversationId)) {
      return NextResponse.json(
        {
          error: "Conversation is busy — a prompt is already running",
          code: "CONVERSATION_BUSY",
        } satisfies ApiError,
        { status: 409 },
      );
    }

    let body: RunPromptRequest;
    try {
      body = runPromptRequestSchema.parse(await request.json());
    } catch {
      return NextResponse.json(
        {
          error: "Either prompt text or at least one image is required",
        } satisfies ApiError,
        { status: 400 },
      );
    }

    const trimmedPrompt = body.prompt.trim();
    if (hasCollabPrefix(trimmedPrompt)) {
      const brief = stripCollabPrefix(trimmedPrompt).trim();
      if (brief.length === 0) {
        return NextResponse.json(
          {
            error:
              "/collab prompt must include a brief after the slash command",
            code: "COLLAB_BRIEF_REQUIRED",
          } satisfies ApiError,
          { status: 400 },
        );
      }
      try {
        const manager = deps.getCollaborationManager();
        const result = await manager.start({
          projectPath,
          sessionName,
          conversationId,
          brief,
          negotiationRounds:
            body.collab?.negotiationRounds ?? DEFAULT_NEGOTIATION_ROUNDS,
          autonomousResolutionThreshold:
            body.collab?.autonomousResolutionThreshold ??
            DEFAULT_AUTONOMOUS_RESOLUTION_THRESHOLD,
          ...(body.modelId !== undefined ? { modelId: body.modelId } : {}),
          ...(body.effort !== undefined ? { effort: body.effort } : {}),
          ...(body.images?.length ? { images: body.images } : {}),
        });
        try {
          await deps.clearConversationPendingPromptTextIfMatches(
            projectPath,
            sessionName,
            conversationId,
            body.submittedPendingPromptText ?? body.prompt,
          );
        } catch (error) {
          logger.warn("collaboration.pending_draft_clear_failed", {
            projectPath,
            sessionName,
            conversationId,
            workflowId: result.workflowId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        const statusUrl = `/api/projects/${encodeURIComponent(name)}/sessions/${encodeURIComponent(sessionName)}/collaboration/${encodeURIComponent(result.workflowId)}`;
        return NextResponse.json(
          { workflowId: result.workflowId, status: result.status, statusUrl },
          { status: 202 },
        );
      } catch (err) {
        if (err instanceof CollaborationSessionNotFoundError) {
          return notFound(err.message);
        }
        if (err instanceof CollaborationConversationNotFoundError) {
          return notFound(err.message);
        }
        if (err instanceof CollaborationStartConflictError) {
          return NextResponse.json(
            {
              error: err.message,
              code: "COLLABORATION_START_CONFLICT",
            } satisfies ApiError,
            { status: 409 },
          );
        }
        const message =
          err instanceof Error ? err.message : "Failed to start collaboration";
        return NextResponse.json({ error: message } satisfies ApiError, {
          status: 500,
        });
      }
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const emit = (event: string, data: unknown) => {
          try {
            controller.enqueue(
              encoder.encode(
                `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
              ),
            );
          } catch {
            // Client disconnected
          }
        };

        try {
          await deps.executePromptStream(
            projectPath,
            session,
            body.prompt.trim(),
            emit,
            conversationId,
            body.modelId,
            body.images,
            {
              effort: body.effort,
              backend: body.backend,
              onAccepted: async () => {
                await deps.clearConversationPendingPromptTextIfMatches(
                  projectPath,
                  sessionName,
                  conversationId,
                  body.submittedPendingPromptText ?? body.prompt,
                );
              },
              ...(body.documentFeedback
                ? { documentFeedback: body.documentFeedback }
                : {}),
            },
          );
        } catch (err) {
          if (err instanceof BackendMismatchError) {
            emit("error", { message: err.message, code: "BACKEND_MISMATCH" });
            emit("done", {});
            return;
          }
          if (err instanceof ModelEffortValidationError) {
            emit("error", { message: err.message, code: "VALIDATION_ERROR" });
            emit("done", {});
            return;
          }
          const msg = err instanceof Error ? err.message : "Prompt failed";
          emit("error", { message: msg });
          emit("done", {});
        } finally {
          try {
            controller.close();
          } catch {
            // Already closed
          }
        }
      },
      cancel() {
        // No-op: let execution continue in background
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  return { POST, conversationPOST };
}

// ---------------------------------------------------------------------------
// Pending-prompt persistence handler (separate concern, separate deps)
// ---------------------------------------------------------------------------

export interface PendingPromptRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  setConversationPendingPromptText(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    text: string | null,
  ): Promise<void>;
  clearConversationPendingPromptTextIfMatches(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    expectedText: string,
  ): Promise<boolean>;
}

const defaultPendingDeps: PendingPromptRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  getSession: defaultGetSession,
  setConversationPendingPromptText: defaultSetConversationPendingPromptText,
  clearConversationPendingPromptTextIfMatches:
    defaultClearConversationPendingPromptTextIfMatches,
};

export function createPendingPromptRouteHandlers(
  deps: PendingPromptRouteDeps = defaultPendingDeps,
) {
  async function POST(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolvedParams = await context.params;
    const name = resolvedParams["name"] ?? "";
    const sessionSlug = resolvedParams["session"] ?? "";
    const sessionName = decodeURIComponent(sessionSlug);
    const conversationId = resolvedParams["conversationId"] ?? "";

    const resolved = await resolveProjectSessionOr404(deps, name, sessionName);
    if (!resolved.ok) return resolved.response;
    const { projectPath, session } = resolved.value;

    const conversation = session.conversations.find(
      (c) => c.id === conversationId,
    );
    if (!conversation) {
      return notFound("Conversation not found");
    }

    let body: { text: string | null; expectedText?: string };
    try {
      body = pendingPromptRequestSchema.parse(await request.json());
    } catch {
      return NextResponse.json(
        { error: "text (string or null) is required" } satisfies ApiError,
        { status: 400 },
      );
    }

    try {
      if (body.text === null && body.expectedText !== undefined) {
        const updated = await deps.clearConversationPendingPromptTextIfMatches(
          projectPath,
          sessionName,
          conversationId,
          body.expectedText,
        );
        logger.debug("pending_prompt.compare_and_clear_completed", {
          projectPath,
          sessionName,
          conversationId,
          updated,
        });
        return NextResponse.json({ ok: true, updated });
      }

      await deps.setConversationPendingPromptText(
        projectPath,
        sessionName,
        conversationId,
        body.text,
      );
      logger.debug("pending_prompt.update_completed", {
        projectPath,
        sessionName,
        conversationId,
        cleared: body.text === null,
        textLength: body.text?.length ?? 0,
      });
      return NextResponse.json({ ok: true, updated: true });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Failed to update pending prompt text";
      logger.warn("pending_prompt.update_failed", {
        projectPath,
        sessionName,
        conversationId,
        compareAndClear: body.text === null && body.expectedText !== undefined,
        error: message,
      });
      return NextResponse.json({ error: message } satisfies ApiError, {
        status: 500,
      });
    }
  }

  return { POST };
}

// ---------------------------------------------------------------------------
// Default named exports — consumed directly by route shells
// ---------------------------------------------------------------------------

const defaultPromptHandlers = createPromptRouteHandlers();
const defaultPendingPromptHandlers = createPendingPromptRouteHandlers();

export const executePrompt = withTracing(defaultPromptHandlers.POST);
export const executeConversationPrompt = withTracing(
  defaultPromptHandlers.conversationPOST,
);
export const updatePendingPrompt = defaultPendingPromptHandlers.POST;
