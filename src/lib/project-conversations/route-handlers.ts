import { commandRequestRefusal } from "@/lib/commands/route-admission";
import { BackendAdmissionError } from "@/lib/agent-backends/execution-admission";
/**
 * Project-conversation route handlers — session-less prompt + lifecycle.
 *
 * Mirrors the session prompt/lifecycle handlers, swapping the session lookup
 * for `resolveProjectPath` + the project sentinel and the executor for
 * `executeProjectPromptStream`. Lifecycle mutations broadcast scope=project
 * SSE events.
 */

import { NextResponse } from "next/server";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import { getProjectDisplayName as defaultGetProjectDisplayName } from "@/lib/projects/resolver";
import {
  BackendMismatchError,
  ModelSelectionValidationError,
  type PromptStreamResult,
} from "@/lib/prompt/sdk-driver";
import { isConversationBusy as defaultIsConversationBusy } from "@/lib/prompt/single-flight";
import {
  changeConversationProfileRequestSchema,
  generateConversationNameRequestSchema,
  generateConversationNameResponseSchema,
  renameConversationRequestSchema,
  toPublicConversationState,
  toPublicConversationStates,
} from "@/lib/conversations/schemas";
import { ConversationProfileLockedError } from "@/lib/conversations/conversation-profile";
import {
  changeConversationProfile as defaultChangeConversationProfile,
  resolveLibraryAgentProfile,
  ConversationNotFoundForProfileChangeError,
  UnknownAgentProfileError,
  type ConversationProfileChangeIdentity,
} from "@/lib/conversations/profile-change";
import {
  getConversation as defaultGetConversation,
  mutateConversation as defaultMutateConversation,
} from "@/lib/state-store";
import {
  generateAndApplyConversationName as defaultGenerateAndApplyConversationName,
  type GenerateConversationNameInput,
} from "@/lib/conversations/name-generation";
import {
  resolveConversationNamingContent as defaultResolveConversationNamingContent,
  resolveMessageNamingContent as defaultResolveMessageNamingContent,
  type ConversationNamingContentInput,
  type MessageNamingContentInput,
} from "@/lib/conversations/naming-context";
import {
  conversationRenamedEventSchema,
  conversationArchivedEventSchema,
  conversationOpenEventSchema,
  conversationProfileChangedEventSchema,
  conversationUnreadEventSchema,
} from "@/lib/conversations/schemas";
import { sessionArchiveRequestSchema } from "@/lib/sessions/schemas";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import {
  publishEvent,
  publishEventBestEffort,
  type PublishFn,
} from "@/lib/events/publication";
import {
  resolveProjectOr404,
  parseJsonBody,
  jsonError,
  notFound,
} from "@/lib/shared/route-resolution";
import { resolveProjectConversationRoute } from "./route-resolution";
import { readConversationMessagesWithSeq as defaultReadConversationMessagesWithSeq } from "@/lib/prompt/transcript";
import { createLogger, withTracing } from "@/lib/logging";
import {
  createProjectConversationRequestSchema,
  projectConversationOpenRequestSchema,
  projectFirstPromptRequestSchema,
} from "./schemas";
import { createProjectConversationService } from "./service";
import { buildProjectConversationCreatedEvent } from "./events";
import {
  executeProjectPromptStream as defaultExecuteProjectPromptStream,
  ProjectCollaborationUnsupportedError,
} from "./prompt-entry";
import type {
  ConversationState,
  TranscriptMessage,
} from "@/lib/conversations/schemas";
import type {
  AgentProfileRef,
  RedactedAgentProfileSnapshot,
} from "@/lib/agent-profiles/schemas";
import type { ExecuteProjectPromptStreamInput } from "./prompt-entry";

const logger = createLogger("project-conversations.routes");

type RouteContext = { params: Promise<Record<string, string>> };

export interface ProjectConversationRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getProjectDisplayName(projectPath: string): string;
  createProjectConversation(
    projectPath: string,
    opts?: {
      agentBackend?: ConversationState["agentBackend"];
      name?: string;
      profile?: AgentProfileRef;
    },
  ): Promise<ConversationState>;
  getProjectConversation(
    projectPath: string,
    conversationId: string,
  ): Promise<ConversationState | null>;
  listProjectConversations(projectPath: string): Promise<ConversationState[]>;
  readConversationMessagesWithSeq(
    transcriptPath: string | null,
  ): Promise<Array<TranscriptMessage & { seq: number }>>;
  renameProjectConversation(
    projectPath: string,
    conversationId: string,
    name: string,
  ): Promise<void>;
  resolveConversationNamingContent(
    input: ConversationNamingContentInput,
  ): Promise<string | null>;
  resolveMessageNamingContent(
    input: MessageNamingContentInput,
  ): Promise<string | null>;
  generateAndApplyConversationName(
    input: GenerateConversationNameInput,
  ): Promise<string | null>;
  setProjectConversationArchived(
    projectPath: string,
    conversationId: string,
    archived: boolean,
  ): Promise<void>;
  setProjectConversationOpen(
    projectPath: string,
    conversationId: string,
    open: boolean,
  ): Promise<void>;
  markProjectConversationRead(
    projectPath: string,
    conversationId: string,
  ): Promise<void>;
  changeConversationProfile(
    identity: ConversationProfileChangeIdentity,
    ref: AgentProfileRef,
  ): Promise<RedactedAgentProfileSnapshot>;
  executeProjectPromptStream(
    input: ExecuteProjectPromptStreamInput,
  ): Promise<PromptStreamResult>;
  isConversationBusy(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): boolean;
  broadcast: PublishFn;
}

function defaultDeps(): ProjectConversationRouteDeps {
  const service = createProjectConversationService();
  return {
    resolveProjectPath: defaultResolveProjectPath,
    getProjectDisplayName: defaultGetProjectDisplayName,
    createProjectConversation: (projectPath, opts) =>
      service.createProjectConversation(projectPath, opts),
    getProjectConversation: (projectPath, id) =>
      service.getProjectConversation(projectPath, id),
    listProjectConversations: (projectPath) =>
      service.listProjectConversations(projectPath),
    readConversationMessagesWithSeq: defaultReadConversationMessagesWithSeq,
    renameProjectConversation: (projectPath, id, name) =>
      service.renameProjectConversation(projectPath, id, name),
    resolveConversationNamingContent: defaultResolveConversationNamingContent,
    resolveMessageNamingContent: defaultResolveMessageNamingContent,
    generateAndApplyConversationName: defaultGenerateAndApplyConversationName,
    setProjectConversationArchived: (projectPath, id, archived) =>
      service.setProjectConversationArchived(projectPath, id, archived),
    setProjectConversationOpen: (projectPath, id, open) =>
      service.setProjectConversationOpen(projectPath, id, open),
    markProjectConversationRead: (projectPath, id) =>
      service.markProjectConversationRead(projectPath, id),
    // The same change operation the session router uses; the sentinel session
    // in the identity is what points its store calls at the project repository.
    changeConversationProfile: (identity, ref) =>
      defaultChangeConversationProfile(
        {
          getConversation: defaultGetConversation,
          mutateConversation: defaultMutateConversation,
          resolveProfile: resolveLibraryAgentProfile,
        },
        identity,
        ref,
      ),
    executeProjectPromptStream: defaultExecuteProjectPromptStream,
    isConversationBusy: defaultIsConversationBusy,
    broadcast: publishEvent,
  };
}

export function createProjectConversationRouteHandlers(
  deps: ProjectConversationRouteDeps = defaultDeps(),
) {
  function streamPrompt(
    projectPath: string,
    conversationId: string | undefined,
    body: {
      prompt: string;
      modelSelection?: ExecuteProjectPromptStreamInput["modelSelection"];
      backend?: ConversationState["agentBackend"];
      images?: ExecuteProjectPromptStreamInput["images"];
      /**
       * Only the create-and-send entry can use this: it is the token the created
       * conversation records, and a turn in an existing conversation creates
       * nothing to stamp.
       */
      creationRequestId?: string;
      /**
       * Like `creationRequestId`, meaningful only when this entry creates the
       * conversation: an existing conversation's profile is already settled and
       * changes through its own PATCH route.
       */
      profile?: AgentProfileRef;
    },
  ): Response {
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
            // Client disconnected.
          }
        };

        try {
          await deps.executeProjectPromptStream({
            projectPath,
            ...(conversationId !== undefined ? { conversationId } : {}),
            promptText: body.prompt.trim(),
            emit,
            ...(body.modelSelection !== undefined
              ? { modelSelection: body.modelSelection }
              : {}),
            ...(body.images !== undefined ? { images: body.images } : {}),
            ...(body.backend !== undefined ? { backend: body.backend } : {}),
            // Dropped when this turn targets an existing conversation: that
            // conversation was not created for this submission.
            ...(conversationId === undefined &&
            body.creationRequestId !== undefined
              ? { creationRequestId: body.creationRequestId }
              : {}),
            ...(conversationId === undefined && body.profile !== undefined
              ? { profile: body.profile }
              : {}),
          });
        } catch (err) {
          if (err instanceof BackendAdmissionError) {
            emit("error", { message: err.message, code: err.code });
            emit("done", {});
            return;
          }
          if (err instanceof BackendMismatchError) {
            emit("error", { message: err.message, code: "BACKEND_MISMATCH" });
            emit("done", {});
            return;
          }
          if (err instanceof ModelSelectionValidationError) {
            emit("error", {
              message: err.message,
              code: err.code,
              modelId: err.modelId,
              ...(err.parameterId !== undefined
                ? { parameterId: err.parameterId }
                : {}),
            });
            emit("done", {});
            return;
          }
          if (err instanceof ProjectCollaborationUnsupportedError) {
            emit("error", { message: err.message, code: err.code });
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
            // Already closed.
          }
        }
      },
      cancel() {
        // No-op: let execution continue in the background.
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

  async function createPOST(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const { name } = await context.params;
    const project = await resolveProjectOr404(deps, name ?? "");
    if (!project.ok) return project.response;
    const projectPath = project.value;

    const parsed = await parseJsonBody(
      request,
      createProjectConversationRequestSchema,
      "Invalid request body",
    );
    if (!parsed.ok) return parsed.response;

    const conversation = await deps.createProjectConversation(
      projectPath,
      parsed.value,
    );
    const projectName = deps.getProjectDisplayName(projectPath);
    publishEventBestEffort({
      publish: deps.broadcast,
      logger,
      failureEvent: "project_conversation_created.broadcast_failed",
      context: { projectName, conversationId: conversation.id },
      build: () =>
        buildProjectConversationCreatedEvent(projectName, conversation),
    });

    return NextResponse.json(toPublicConversationState(conversation), {
      status: 201,
    });
  }

  async function listGET(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const { name } = await context.params;
    const project = await resolveProjectOr404(deps, name ?? "");
    if (!project.ok) return project.response;

    const conversations = await deps.listProjectConversations(project.value);
    return NextResponse.json(toPublicConversationStates(conversations));
  }

  async function messagesGET(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveProjectConversationRoute(deps, context);
    if (!resolved.ok) return resolved.response;

    try {
      const messages = await deps.readConversationMessagesWithSeq(
        resolved.value.conversation.transcriptPath,
      );
      const sorted = [...messages].sort((a, b) => a.seq - b.seq);
      return NextResponse.json(sorted);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to read messages";
      return jsonError(message, 500);
    }
  }

  async function firstPromptPOST(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const { name } = await context.params;
    const project = await resolveProjectOr404(deps, name ?? "");
    if (!project.ok) return project.response;

    const parsed = await parseJsonBody(
      request,
      projectFirstPromptRequestSchema,
      "prompt or images required",
    );
    if (!parsed.ok) return parsed.response;

    const refusal = await commandRequestRefusal(
      parsed.value.prompt,
      parsed.value.backend,
    );
    if (refusal) return refusal;
    return streamPrompt(project.value, undefined, parsed.value);
  }

  async function promptPOST(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveProjectConversationRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const { projectPath, conversationId } = resolved.value;

    if (
      deps.isConversationBusy(
        projectPath,
        PROJECT_CONVERSATION_SESSION_SENTINEL,
        conversationId,
      )
    ) {
      return jsonError("Conversation is busy", 409);
    }

    const parsed = await parseJsonBody(
      request,
      projectFirstPromptRequestSchema,
      "prompt or images required",
    );
    if (!parsed.ok) return parsed.response;

    const refusal = await commandRequestRefusal(
      parsed.value.prompt,
      parsed.value.backend ?? resolved.value.conversation.agentBackend,
    );
    if (refusal) return refusal;
    return streamPrompt(projectPath, conversationId, parsed.value);
  }

  async function renamePATCH(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveProjectConversationRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const { projectPath, conversationId } = resolved.value;

    const parsed = await parseJsonBody(
      request,
      renameConversationRequestSchema,
      "name (non-empty string) is required",
    );
    if (!parsed.ok) return parsed.response;

    try {
      await deps.renameProjectConversation(
        projectPath,
        conversationId,
        parsed.value.name,
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to rename conversation";
      return jsonError(message, 500);
    }

    const projectName = deps.getProjectDisplayName(projectPath);
    publishEventBestEffort({
      publish: deps.broadcast,
      logger,
      failureEvent: "project_conversation_renamed.broadcast_failed",
      context: { projectName, conversationId },
      build: () =>
        conversationRenamedEventSchema.parse({
          type: "conversation-renamed",
          scope: "project",
          projectName,
          conversationId,
          name: parsed.value.name,
        }),
    });

    return NextResponse.json({ ok: true });
  }

  async function generateNamePOST(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveProjectConversationRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const { projectPath, conversationId, conversation } = resolved.value;

    const parsed = await parseJsonBody(
      request,
      generateConversationNameRequestSchema,
      "source must be conversation or message with a non-negative messageIndex",
    );
    if (!parsed.ok) return parsed.response;

    let content: string | null;
    try {
      content =
        parsed.value.source === "conversation"
          ? await deps.resolveConversationNamingContent({
              conversationId,
              transcriptPath: conversation.transcriptPath,
            })
          : await deps.resolveMessageNamingContent({
              transcriptPath: conversation.transcriptPath,
              messageIndex: parsed.value.messageIndex,
            });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Failed to resolve conversation naming content";
      return jsonError(message, 500);
    }

    if (content === null) {
      return jsonError(
        "Conversation naming content could not be resolved",
        422,
      );
    }

    try {
      const name = await deps.generateAndApplyConversationName({
        projectPath,
        projectName: deps.getProjectDisplayName(projectPath),
        sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
        conversationId,
        content,
        trigger: "explicit",
      });
      if (name === null) {
        return jsonError("Failed to generate conversation name", 500);
      }
      return NextResponse.json(
        generateConversationNameResponseSchema.parse({ name }),
      );
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Failed to generate conversation name";
      return jsonError(message, 500);
    }
  }

  async function archivePATCH(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveProjectConversationRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const { projectPath, conversationId } = resolved.value;

    const parsed = await parseJsonBody(
      request,
      sessionArchiveRequestSchema,
      "archived (boolean) is required",
    );
    if (!parsed.ok) return parsed.response;

    try {
      await deps.setProjectConversationArchived(
        projectPath,
        conversationId,
        parsed.value.archived,
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to update archive state";
      return jsonError(message, 500);
    }

    const projectName = deps.getProjectDisplayName(projectPath);
    publishEventBestEffort({
      publish: deps.broadcast,
      logger,
      failureEvent: "project_conversation_archived.broadcast_failed",
      context: { projectName, conversationId },
      build: () =>
        conversationArchivedEventSchema.parse({
          type: "conversation-archived",
          scope: "project",
          projectName,
          conversationId,
          archived: parsed.value.archived,
        }),
    });

    return NextResponse.json({ ok: true });
  }

  async function openPATCH(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveProjectConversationRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const { projectPath, conversationId } = resolved.value;

    const parsed = await parseJsonBody(
      request,
      projectConversationOpenRequestSchema,
      "open (boolean) is required",
    );
    if (!parsed.ok) return parsed.response;

    try {
      await deps.setProjectConversationOpen(
        projectPath,
        conversationId,
        parsed.value.open,
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to update open state";
      return jsonError(message, 500);
    }

    const projectName = deps.getProjectDisplayName(projectPath);
    publishEventBestEffort({
      publish: deps.broadcast,
      logger,
      failureEvent: "project_conversation_open.broadcast_failed",
      context: { projectName, conversationId },
      build: () =>
        conversationOpenEventSchema.parse({
          type: "conversation-open",
          scope: "project",
          projectName,
          conversationId,
          open: parsed.value.open,
        }),
    });

    return NextResponse.json({ ok: true });
  }

  async function markReadPOST(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveProjectConversationRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const { projectPath, conversationId } = resolved.value;

    try {
      await deps.markProjectConversationRead(projectPath, conversationId);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to mark as read";
      return jsonError(message, 500);
    }

    const projectName = deps.getProjectDisplayName(projectPath);
    publishEventBestEffort({
      publish: deps.broadcast,
      logger,
      failureEvent: "project_conversation_mark_read.broadcast_failed",
      context: { projectName, conversationId },
      build: () =>
        conversationUnreadEventSchema.parse({
          type: "conversation-unread",
          scope: "project",
          projectName,
          conversationId,
          unread: false,
        }),
    });

    return NextResponse.json({ ok: true });
  }

  /**
   * Point a project conversation at a different agent profile.
   *
   * The project counterpart of the session router's profile PATCH, and the only
   * production control a project conversation has for the operation: a legacy
   * row (and one that has already run a turn) is refused here with the standard
   * post-lock error as a 409, because the request is well-formed and the profile
   * may well exist — the conversation is simply past the point where its profile
   * can change (R6.5). The body carries the redacted snapshot now in force,
   * never the instructions behind it (R6.3).
   */
  async function profilePATCH(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveProjectConversationRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const { projectPath, conversationId } = resolved.value;

    const parsed = await parseJsonBody(
      request,
      changeConversationProfileRequestSchema,
      'profile (a "tier:id" reference or a {tier, id} object) is required',
    );
    if (!parsed.ok) return parsed.response;

    try {
      const redactedProfileSnapshot = await deps.changeConversationProfile(
        {
          projectPath,
          sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
          conversationId,
        },
        parsed.value.profile,
      );

      const projectName = deps.getProjectDisplayName(projectPath);
      publishEventBestEffort({
        publish: deps.broadcast,
        logger,
        failureEvent: "conversation_profile_changed.broadcast_failed",
        context: { projectName, conversationId },
        build: () =>
          conversationProfileChangedEventSchema.parse({
            type: "conversation-profile-changed",
            scope: "project",
            projectName,
            conversationId,
            redactedProfileSnapshot,
          }),
      });

      return NextResponse.json({ ok: true, redactedProfileSnapshot });
    } catch (err) {
      if (err instanceof ConversationProfileLockedError) {
        return jsonError(err.message, 409);
      }
      // Through the resolve seam, not a hand-rolled ladder: both are
      // single-entity misses. The conversation case is a race guard — route
      // resolution already found it, so only a concurrent delete gets here.
      if (err instanceof UnknownAgentProfileError) {
        return notFound(err.message);
      }
      if (err instanceof ConversationNotFoundForProfileChangeError) {
        return notFound(err.message);
      }
      const message =
        err instanceof Error
          ? err.message
          : "Failed to change the conversation's agent profile";
      return jsonError(message, 500);
    }
  }

  return {
    createPOST,
    listGET,
    messagesGET,
    firstPromptPOST,
    promptPOST,
    renamePATCH,
    generateNamePOST,
    archivePATCH,
    openPATCH,
    markReadPOST,
    profilePATCH,
  };
}

const _handlers = createProjectConversationRouteHandlers();
export const projectConversationsCreatePOST = withTracing(_handlers.createPOST);
export const projectConversationsListGET = withTracing(_handlers.listGET);
export const projectConversationMessagesGET = withTracing(
  _handlers.messagesGET,
);
export const projectFirstPromptPOST = withTracing(_handlers.firstPromptPOST);
export const projectConversationPromptPOST = withTracing(_handlers.promptPOST);
export const projectConversationRenamePATCH = withTracing(
  _handlers.renamePATCH,
);
export const projectConversationGenerateNamePOST = withTracing(
  _handlers.generateNamePOST,
);
export const projectConversationArchivePATCH = withTracing(
  _handlers.archivePATCH,
);
export const projectConversationOpenPATCH = withTracing(_handlers.openPATCH);
export const projectConversationProfilePATCH = withTracing(
  _handlers.profilePATCH,
);
export const projectConversationMarkReadPOST = withTracing(
  _handlers.markReadPOST,
);
