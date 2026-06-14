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
  conversationCreatedEventSchema,
  conversationRenamedEventSchema,
  conversationArchivedEventSchema,
  renameConversationRequestSchema,
} from "@/lib/conversations/schemas";
import { sessionArchiveRequestSchema } from "@/lib/sessions/schemas";
import { broadcast as defaultBroadcast } from "@/lib/events/broadcaster";
import type { BroadcastFn } from "@/lib/events/broadcaster";
import { broadcastEvent } from "@/lib/events/broadcast-event";
import { jsonError, parseJsonBody } from "@/lib/shared/route-resolution";
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
  ): Promise<ConversationState>;
  renameConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    name: string,
  ): Promise<void>;
  setConversationArchived(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    archived: boolean,
  ): Promise<void>;
  broadcast: BroadcastFn;
}

const defaultDeps: ConversationRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  getProjectDisplayName: defaultGetProjectDisplayName,
  getSession: defaultGetSession,
  createConversation: defaultCreateConversation,
  renameConversation: defaultRenameConversation,
  setConversationArchived: defaultSetConversationArchived,
  broadcast: defaultBroadcast,
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
    return NextResponse.json(conversations);
  }

  return { GET };
}

export function createConversationRouteHandlers(
  deps: ConversationRouteDeps = defaultDeps,
) {
  async function POST_CREATE(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSessionRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const { projectPath, sessionName } = resolved.value;

    let conversation: ConversationState;
    try {
      conversation = await deps.createConversation(projectPath, sessionName);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to create conversation";
      return jsonError(message, 500);
    }

    const projectName = deps.getProjectDisplayName(projectPath);
    broadcastEvent({
      broadcast: deps.broadcast,
      logger,
      failureEvent: "conversation_created.broadcast_failed",
      context: { projectName, sessionName, conversationId: conversation.id },
      build: () =>
        conversationCreatedEventSchema.parse({
          type: "conversation-created",
          scope: "session",
          projectName,
          sessionName,
          conversation,
        }),
    });

    return NextResponse.json(conversation, { status: 201 });
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
    broadcastEvent({
      broadcast: deps.broadcast,
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
    broadcastEvent({
      broadcast: deps.broadcast,
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

  return {
    POST_CREATE,
    PATCH_RENAME,
    PATCH_ARCHIVE,
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
export const renameConversation = withTracing(
  _defaultConversationHandlers.PATCH_RENAME,
);
