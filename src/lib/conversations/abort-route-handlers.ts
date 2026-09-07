/**
 * Scope-specific route resolution delegates cancellation and acknowledged
 * settlement to the conversation lifecycle.
 */

import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { getSession, getProjectConversation } from "@/lib/state-store";
import { requestConversationStop } from "@/lib/workflows/conversation/manager";
import type {
  ConversationAddress,
  TurnCancelReason,
} from "@/lib/workflows/conversation/turn-spec";
import { resolveSessionConversationRoute } from "./route-resolution";
import { resolveProjectConversationRoute } from "@/lib/project-conversations/route-resolution";
import { type ConversationScopeRef } from "./conversation-target";
import { createLogger, withTracing, type Logger } from "@/lib/logging";
import type { ApiError } from "@/lib/api/errors";
import type { ConversationState } from "./schemas";

const logger = createLogger("abort-route-handlers");

type RouteContext = { params: Promise<Record<string, string>> };

/** What stopping a turn needs once its conversation is resolved. */
export interface AbortTurnDeps {
  requestConversationStop(
    address: ConversationAddress,
    reason: TurnCancelReason,
  ): { requested: boolean; settled: Promise<void> };
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
async function abortTurn(
  deps: AbortTurnDeps,
  resolved: {
    projectPath: string;
    projectName: string;
    scopeRef: ConversationScopeRef;
    conversationId: string;
  },
): Promise<Response> {
  const { projectPath, scopeRef, conversationId } = resolved;

  const stop = deps.requestConversationStop(
    {
      projectPath,
      target: {
        ...scopeRef,
        projectName: resolved.projectName,
        conversationId,
      },
    },
    "user",
  );
  await stop.settled;
  const aborted = stop.requested;
  if (!aborted)
    deps.log.warn("abort.event_rejected", { conversationId, ...scopeRef });

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
      projectName: (await context.params)["name"] ?? "",
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
      projectName: (await context.params)["name"] ?? "",
      scopeRef: { scope: "project" },
      conversationId: resolved.value.conversationId,
    });
  }

  return { POST: post };
}

const defaultHandlers = createAbortHandlers({
  resolveProjectPath,
  getSession,
  requestConversationStop,
  log: logger,
});

/** POST /api/projects/[name]/sessions/[session]/conversations/[conversationId]/abort */
export const abortConversation = withTracing(defaultHandlers.POST);

const defaultProjectHandlers = createProjectAbortHandlers({
  resolveProjectPath,
  getProjectConversation,
  requestConversationStop,
  log: logger,
});

/** POST /api/projects/[name]/conversations/[conversationId]/abort */
export const projectConversationAbortPOST = withTracing(
  defaultProjectHandlers.POST,
);
