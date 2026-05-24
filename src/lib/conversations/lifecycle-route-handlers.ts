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
import type { ApiError } from "@/lib/api/errors";
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

function projectNotFound(): Response {
  return NextResponse.json({ error: "Project not found" } satisfies ApiError, {
    status: 404,
  });
}

function sessionNotFound(): Response {
  return NextResponse.json({ error: "Session not found" } satisfies ApiError, {
    status: 404,
  });
}

function conversationNotFound(): Response {
  return NextResponse.json(
    { error: "Conversation not found" } satisfies ApiError,
    { status: 404 },
  );
}

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
    const resolvedParams = await context.params;
    const name = resolvedParams["name"] ?? "";
    const sessionSlug = resolvedParams["session"] ?? "";
    const sessionName = decodeURIComponent(sessionSlug);

    const projectPath = await deps.resolveProjectPath(name);
    if (!projectPath) return projectNotFound();

    const session = await deps.getSession(projectPath, sessionName);
    if (!session) return sessionNotFound();

    const conversations = await deps.getSessionConversations(
      projectPath,
      sessionName,
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
    const resolvedParams = await context.params;
    const name = resolvedParams["name"] ?? "";
    const sessionSlug = resolvedParams["session"] ?? "";
    const sessionName = decodeURIComponent(sessionSlug);

    const projectPath = await deps.resolveProjectPath(name);
    if (!projectPath) return projectNotFound();

    const session = await deps.getSession(projectPath, sessionName);
    if (!session) return sessionNotFound();

    const conversation = await deps.createConversation(
      projectPath,
      sessionName,
    );

    const projectName = deps.getProjectDisplayName(projectPath);
    try {
      const event = conversationCreatedEventSchema.parse({
        type: "conversation-created",
        projectName,
        sessionName,
        conversation,
      });
      deps.broadcast(event);
    } catch (err) {
      logger.warn("conversation_created.broadcast_failed", {
        projectName,
        sessionName,
        conversationId: conversation.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return NextResponse.json(conversation, { status: 201 });
  }

  async function PATCH_RENAME(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolvedParams = await context.params;
    const name = resolvedParams["name"] ?? "";
    const sessionSlug = resolvedParams["session"] ?? "";
    const sessionName = decodeURIComponent(sessionSlug);
    const conversationId = resolvedParams["conversationId"] ?? "";

    const projectPath = await deps.resolveProjectPath(name);
    if (!projectPath) return projectNotFound();

    const session = await deps.getSession(projectPath, sessionName);
    if (!session) return sessionNotFound();

    const conversation = session.conversations.find(
      (c) => c.id === conversationId,
    );
    if (!conversation) return conversationNotFound();

    let body: { name: string };
    try {
      body = renameConversationRequestSchema.parse(await request.json());
    } catch {
      return NextResponse.json(
        { error: "name (non-empty string) is required" } satisfies ApiError,
        { status: 400 },
      );
    }

    try {
      await deps.renameConversation(
        projectPath,
        sessionName,
        conversationId,
        body.name,
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to rename conversation";
      return NextResponse.json({ error: message } satisfies ApiError, {
        status: 500,
      });
    }

    const projectName = deps.getProjectDisplayName(projectPath);
    try {
      const event = conversationRenamedEventSchema.parse({
        type: "conversation-renamed",
        projectName,
        sessionName,
        conversationId,
        name: body.name,
      });
      deps.broadcast(event);
    } catch (err) {
      logger.warn("conversation_renamed.broadcast_failed", {
        projectName,
        sessionName,
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return NextResponse.json({ ok: true });
  }

  async function PATCH_ARCHIVE(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolvedParams = await context.params;
    const name = resolvedParams["name"] ?? "";
    const sessionSlug = resolvedParams["session"] ?? "";
    const sessionName = decodeURIComponent(sessionSlug);
    const conversationId = resolvedParams["conversationId"] ?? "";

    const projectPath = await deps.resolveProjectPath(name);
    if (!projectPath) return projectNotFound();

    const session = await deps.getSession(projectPath, sessionName);
    if (!session) return sessionNotFound();

    const conversation = session.conversations.find(
      (c) => c.id === conversationId,
    );
    if (!conversation) return conversationNotFound();

    let body: { archived: boolean };
    try {
      body = sessionArchiveRequestSchema.parse(await request.json());
    } catch {
      return NextResponse.json(
        { error: "archived (boolean) is required" } satisfies ApiError,
        { status: 400 },
      );
    }

    try {
      await deps.setConversationArchived(
        projectPath,
        sessionName,
        conversationId,
        body.archived,
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to update archive state";
      return NextResponse.json({ error: message } satisfies ApiError, {
        status: 500,
      });
    }

    const projectName = deps.getProjectDisplayName(projectPath);
    try {
      const event = conversationArchivedEventSchema.parse({
        type: "conversation-archived",
        projectName,
        sessionName,
        conversationId,
        archived: body.archived,
      });
      deps.broadcast(event);
    } catch (err) {
      logger.warn("conversation_archived.broadcast_failed", {
        projectName,
        sessionName,
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

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
