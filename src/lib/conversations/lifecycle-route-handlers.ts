/**
 * Conversation lifecycle route handlers — extracted for dependency injection.
 *
 * Route files delegate to these handlers, passing production deps.
 * Tests construct handlers via `createConversationRouteHandlers(deps)`.
 *
 * Each lifecycle mutation (create / rename / archive) publishes a dedicated
 * SSE event after the underlying state change succeeds so streaming clients
 * can react without polling. Broadcasts are emitted directly via `broadcast`
 * (not StatusBus) so that clients can register
 * `es.addEventListener('conversation-created', ...)` (etc.) and receive a
 * dedicated event-name frame line.
 */

import { NextResponse } from "next/server";
import {
  resolveProjectPath as defaultResolveProjectPath,
  getProjectDisplayName as defaultGetProjectDisplayName,
} from "@/lib/projects/resolver";
import { getSession as defaultGetSession } from "@/lib/state-store";
import {
  createConversation as defaultCreateConversation,
  getSessionConversations as defaultGetSessionConversations,
  renameConversation as defaultRenameConversation,
  setConversationArchived as defaultSetConversationArchived,
} from "@/lib/conversations/service";
import {
  toPublicConversationState,
  toPublicConversationStates,
  conversationRenamedEventSchema,
  conversationArchivedEventSchema,
  conversationProfileChangedEventSchema,
  generateConversationNameRequestSchema,
  generateConversationNameResponseSchema,
  renameConversationRequestSchema,
  changeConversationProfileRequestSchema,
  createSessionConversationRequestSchema,
} from "@/lib/conversations/schemas";
import { buildConversationCreatedEvent } from "@/lib/conversations/created-event";
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
import type {
  AgentProfileRef,
  RedactedAgentProfileSnapshot,
} from "@/lib/agent-profiles/schemas";
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
import { sessionArchiveRequestSchema } from "@/lib/sessions/schemas";
import {
  publishEvent,
  publishEventBestEffort,
  type PublishFn,
} from "@/lib/events/publication";
import {
  jsonError,
  notFound,
  parseJsonBody,
  parseOptionalJsonBody,
} from "@/lib/shared/route-resolution";
import {
  resolveSessionRoute,
  resolveSessionConversationRoute,
} from "./route-resolution";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import { createLogger, withTracing } from "@/lib/logging";

const logger = createLogger("conversation-route-handlers");

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface ConversationRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getProjectDisplayName(projectPath: string): string;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  createConversation(
    projectPath: string,
    sessionName: string,
    opts?: { profile?: AgentProfileRef },
  ): Promise<ConversationState>;
  renameConversation(
    projectPath: string,
    sessionName: string,
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
  setConversationArchived(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    archived: boolean,
  ): Promise<void>;
  changeConversationProfile(
    identity: ConversationProfileChangeIdentity,
    ref: AgentProfileRef,
  ): Promise<RedactedAgentProfileSnapshot>;
  broadcast: PublishFn;
}

const defaultDeps: ConversationRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  getProjectDisplayName: defaultGetProjectDisplayName,
  getSession: defaultGetSession,
  createConversation: defaultCreateConversation,
  renameConversation: defaultRenameConversation,
  resolveConversationNamingContent: defaultResolveConversationNamingContent,
  resolveMessageNamingContent: defaultResolveMessageNamingContent,
  generateAndApplyConversationName: defaultGenerateAndApplyConversationName,
  setConversationArchived: defaultSetConversationArchived,
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
  broadcast: publishEvent,
};

// ---------------------------------------------------------------------------
// List-conversations deps (separate factory keeps lifecycle deps lean and
// preserves the existing ConversationRouteDeps shape).
// ---------------------------------------------------------------------------

export interface ConversationsListRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  getSessionConversations(
    projectPath: string,
    sessionName: string,
  ): Promise<ConversationState[]>;
}

const defaultListDeps: ConversationsListRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  getSession: defaultGetSession,
  getSessionConversations: defaultGetSessionConversations,
};

// ---------------------------------------------------------------------------
// Shared route context shape used by Next.js dynamic segments.
// ---------------------------------------------------------------------------

type RouteContext = {
  params: Promise<Record<string, string>>;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createConversationsListRouteHandlers(
  deps: ConversationsListRouteDeps = defaultListDeps,
) {
  async function GET(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSessionRoute(deps, context);
    if (!resolved.ok) return resolved.response;

    const conversations = await deps.getSessionConversations(
      resolved.value.projectPath,
      resolved.value.sessionName,
    );
    return NextResponse.json(toPublicConversationStates(conversations));
  }

  return { GET };
}

export function createConversationRouteHandlers(
  deps: ConversationRouteDeps = defaultDeps,
) {
  async function POST_CREATE(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSessionRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const { projectPath, sessionName } = resolved.value;

    // Optional body: the plain "new conversation" button posts nothing, and
    // omitting a selection resolves to the Standard Agent default (R7).
    const parsed = await parseOptionalJsonBody(
      request,
      createSessionConversationRequestSchema,
      'profile (a "tier:id" reference or a {tier, id} object) is invalid',
    );
    if (!parsed.ok) return parsed.response;

    let conversation: ConversationState;
    try {
      conversation = await deps.createConversation(
        projectPath,
        sessionName,
        parsed.value.profile !== undefined
          ? { profile: parsed.value.profile }
          : undefined,
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to create conversation";
      return jsonError(message, 500);
    }

    const projectName = deps.getProjectDisplayName(projectPath);
    publishEventBestEffort({
      publish: deps.broadcast,
      logger,
      failureEvent: "conversation_created.broadcast_failed",
      context: { projectName, sessionName, conversationId: conversation.id },
      build: () =>
        buildConversationCreatedEvent({
          scope: "session",
          projectName,
          sessionName,
          conversation,
        }),
    });

    return NextResponse.json(toPublicConversationState(conversation), {
      status: 201,
    });
  }

  async function PATCH_RENAME(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSessionConversationRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const { projectPath, sessionName, conversationId } = resolved.value;

    const parsed = await parseJsonBody(
      request,
      renameConversationRequestSchema,
      "name (non-empty string) is required",
    );
    if (!parsed.ok) return parsed.response;

    try {
      await deps.renameConversation(
        projectPath,
        sessionName,
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
      failureEvent: "conversation_renamed.broadcast_failed",
      context: { projectName, sessionName, conversationId },
      build: () =>
        conversationRenamedEventSchema.parse({
          type: "conversation-renamed",
          scope: "session",
          projectName,
          sessionName,
          conversationId,
          name: parsed.value.name,
        }),
    });

    return NextResponse.json({ ok: true });
  }

  async function POST_GENERATE_NAME(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSessionConversationRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const { projectPath, sessionName, conversationId, conversation } =
      resolved.value;

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
        sessionName,
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

  async function PATCH_ARCHIVE(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSessionConversationRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const { projectPath, sessionName, conversationId } = resolved.value;

    const parsed = await parseJsonBody(
      request,
      sessionArchiveRequestSchema,
      "archived (boolean) is required",
    );
    if (!parsed.ok) return parsed.response;

    try {
      await deps.setConversationArchived(
        projectPath,
        sessionName,
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
      failureEvent: "conversation_archived.broadcast_failed",
      context: { projectName, sessionName, conversationId },
      build: () =>
        conversationArchivedEventSchema.parse({
          type: "conversation-archived",
          scope: "session",
          projectName,
          sessionName,
          conversationId,
          archived: parsed.value.archived,
        }),
    });

    return NextResponse.json({ ok: true });
  }

  // Archives every non-archived conversation in the session except the
  // addressed one ("Archive Other Conversations"). Runs sequentially and
  // broadcasts the standard conversation-archived event per sibling as soon
  // as it is persisted, so streaming clients stay consistent even if a later
  // sibling fails.
  async function POST_ARCHIVE_OTHERS(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSessionConversationRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const { projectPath, sessionName, conversationId, session } =
      resolved.value;

    const siblings = session.conversations.filter(
      (c) => c.id !== conversationId && !c.archived,
    );

    const projectName = deps.getProjectDisplayName(projectPath);
    const archivedIds: string[] = [];
    for (const sibling of siblings) {
      try {
        await deps.setConversationArchived(
          projectPath,
          sessionName,
          sibling.id,
          true,
        );
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to archive conversation";
        return jsonError(message, 500);
      }
      archivedIds.push(sibling.id);
      publishEventBestEffort({
        publish: deps.broadcast,
        logger,
        failureEvent: "conversation_archived.broadcast_failed",
        context: { projectName, sessionName, conversationId: sibling.id },
        build: () =>
          conversationArchivedEventSchema.parse({
            type: "conversation-archived",
            scope: "session",
            projectName,
            sessionName,
            conversationId: sibling.id,
            archived: true,
          }),
      });
    }

    return NextResponse.json({ ok: true, archivedIds });
  }

  /**
   * Point a conversation at a different agent profile.
   *
   * A settled profile is refused with 409, not 400: the request is well-formed
   * and the profile may well exist — the conversation is simply past the point
   * where its profile can change (R6.5). The body carries the redacted snapshot
   * now in force, never the instructions behind it (R6.3).
   */
  async function PATCH_PROFILE(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSessionConversationRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const { projectPath, sessionName, conversationId } = resolved.value;

    const parsed = await parseJsonBody(
      request,
      changeConversationProfileRequestSchema,
      'profile (a "tier:id" reference or a {tier, id} object) is required',
    );
    if (!parsed.ok) return parsed.response;

    try {
      const redactedProfileSnapshot = await deps.changeConversationProfile(
        { projectPath, sessionName, conversationId },
        parsed.value.profile,
      );

      const projectName = deps.getProjectDisplayName(projectPath);
      publishEventBestEffort({
        publish: deps.broadcast,
        logger,
        failureEvent: "conversation_profile_changed.broadcast_failed",
        context: { projectName, sessionName, conversationId },
        build: () =>
          conversationProfileChangedEventSchema.parse({
            type: "conversation-profile-changed",
            scope: "session",
            projectName,
            sessionName,
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
    POST_CREATE,
    PATCH_RENAME,
    POST_GENERATE_NAME,
    PATCH_ARCHIVE,
    PATCH_PROFILE,
    POST_ARCHIVE_OTHERS,
  };
}

// ---------------------------------------------------------------------------
// Default named exports — consumed directly by route shells
// ---------------------------------------------------------------------------

const _defaultConversationsListHandlers =
  createConversationsListRouteHandlers();
export const listSessionConversations = withTracing(
  _defaultConversationsListHandlers.GET,
);

const _defaultConversationHandlers = createConversationRouteHandlers();
export const createSessionConversation = withTracing(
  _defaultConversationHandlers.POST_CREATE,
);
export const archiveConversation = withTracing(
  _defaultConversationHandlers.PATCH_ARCHIVE,
);
export const archiveOtherConversations = withTracing(
  _defaultConversationHandlers.POST_ARCHIVE_OTHERS,
);
export const renameConversation = withTracing(
  _defaultConversationHandlers.PATCH_RENAME,
);
export const changeSessionConversationProfile = withTracing(
  _defaultConversationHandlers.PATCH_PROFILE,
);
export const generateConversationName = withTracing(
  _defaultConversationHandlers.POST_GENERATE_NAME,
);
