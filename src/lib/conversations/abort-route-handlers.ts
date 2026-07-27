/**
 * Route handlers for aborting a running conversation turn, at either scope.
 *
 * Stop is scope-neutral machinery reached through two route adapters: the abort
 * registry is keyed by conversation id alone, and the conversation machine owns
 * the ABORT_TURN transition (which also clears any pending question). Only route
 * resolution differs — a session conversation is addressed through its session,
 * a project conversation directly (D13/D1).
 *
 * Both halting steps are required. Signalling the AbortController stops backend
 * execution but leaves the machine mid-turn, so the conversation settles into
 * the wrong terminal state and a pending question can be stranded; sending the
 * transition alone would leave the backend running.
 */

import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { getSession, getProjectConversation } from "@/lib/state-store";
import { abortConversation as abortConversationRegistry } from "@/lib/conversations/abort-registry";
import { sendConversationEvent } from "@/lib/workflows/conversation/manager";
import type { ConversationEvent } from "@/lib/workflows/conversation/types";
import { resolveSessionConversationRoute } from "./route-resolution";
import { resolveProjectConversationRoute } from "@/lib/project-conversations/route-resolution";
import {
  storeSessionNameFromScopeRef,
  type ConversationScopeRef,
} from "./conversation-target";
import { createLogger, withTracing, type Logger } from "@/lib/logging";
import type { ApiError } from "@/lib/api/errors";
import type { ConversationState } from "./schemas";

const logger = createLogger("abort-route-handlers");

type RouteContext = { params: Promise<Record<string, string>> };

/** What stopping a turn needs once its conversation is resolved. */
export interface AbortTurnDeps {
  /** Signals the conversation-keyed AbortController; false when none is live. */
  abortConversation(conversationId: string): boolean;
  sendConversationEvent(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    event: ConversationEvent,
  ): boolean;
  /**
   * Injected so a test can read the diagnostics this path actually emits: a
   * sentinel reaching a log field is an R1.3 leak the module-level logger hides.
   */
  log: Logger;
}

export interface AbortRouteDeps extends AbortTurnDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<{ conversations: ConversationState[] } | null>;
}

export interface ProjectAbortRouteDeps extends AbortTurnDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getProjectConversation(
    projectPath: string,
    conversationId: string,
  ): Promise<ConversationState | null>;
}

/** Stop one conversation's turn. Scope-invariant. */
function abortTurn(
  deps: AbortTurnDeps,
  resolved: {
    projectPath: string;
    scopeRef: ConversationScopeRef;
    conversationId: string;
  },
): Response {
  const { projectPath, scopeRef, conversationId } = resolved;

  // Keyed by conversation id, so signalling one conversation's controller
  // cannot reach another conversation's turn.
  const aborted = deps.abortConversation(conversationId);

  // The transition is sent whether or not a controller was live: a conversation
  // parked on a pending question has nothing to signal, and the transition is
  // what clears that question. A machine refusal is not a request failure — the
  // signal above already stopped execution — but it must be diagnosable.
  //
  // The one place the sentinel is materialized: the session-keyed actor API
  // (A5). It is passed straight into the call and never bound to a name a later
  // log line could pick up.
  const machineAccepted = deps.sendConversationEvent(
    projectPath,
    storeSessionNameFromScopeRef(scopeRef),
    conversationId,
    { type: "ABORT_TURN", reason: "user" },
  );
  if (!machineAccepted) {
    deps.log.warn("abort.event_rejected", { conversationId, ...scopeRef });
  }

  if (!aborted) {
    return NextResponse.json(
      { error: "No running prompt to abort" } satisfies ApiError,
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true });
}

/** Session-scoped stop. */
export function createAbortHandlers(deps: AbortRouteDeps) {
  async function post(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSessionConversationRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const { projectPath, sessionName, conversationId } = resolved.value;

    // A session route always has a real session name — the public-param refusal
    // rejects the sentinel upstream — so the scope ref is the session variant
    // by construction.
    return abortTurn(deps, {
      projectPath,
      scopeRef: { scope: "session", sessionName },
      conversationId,
    });
  }

  return { POST: post };
}

/**
 * Project-scoped stop (R5.1/D13). Resolves the project conversation directly —
 * no session record is required — and reaches the SAME registry and machine
 * transition the session adapter uses.
 */
export function createProjectAbortHandlers(deps: ProjectAbortRouteDeps) {
  async function post(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveProjectConversationRoute(deps, context);
    if (!resolved.ok) return resolved.response;

    return abortTurn(deps, {
      projectPath: resolved.value.projectPath,
      scopeRef: { scope: "project" },
      conversationId: resolved.value.conversationId,
    });
  }

  return { POST: post };
}

const defaultHandlers = createAbortHandlers({
  resolveProjectPath,
  getSession,
  abortConversation: abortConversationRegistry,
  sendConversationEvent,
  log: logger,
});

/** POST /api/projects/[name]/sessions/[session]/conversations/[conversationId]/abort */
export const abortConversation = withTracing(defaultHandlers.POST);

const defaultProjectHandlers = createProjectAbortHandlers({
  resolveProjectPath,
  getProjectConversation,
  abortConversation: abortConversationRegistry,
  sendConversationEvent,
  log: logger,
});

/** POST /api/projects/[name]/conversations/[conversationId]/abort */
export const projectConversationAbortPOST = withTracing(
  defaultProjectHandlers.POST,
);
