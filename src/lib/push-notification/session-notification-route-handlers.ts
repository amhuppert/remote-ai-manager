/**
 * Agent-facing notification endpoints (docs/design/cc-cli/02 §2.1). Both scopes
 * are adapters over ONE domain operation (`dispatchAgentNotification`):
 *
 * - POST /api/projects/[name]/sessions/[session]/notifications
 * - POST /api/projects/[name]/conversations/[conversationId]/notifications
 *   Body: { title?, message, urgency? }. Token-gated; sends an agent-initiated
 *   push. Replaces the send_notification MCP tool. The browser UI never calls
 *   these routes.
 *
 * The project adapter resolves the addressed project conversation — no session
 * record exists for it — and hands the dispatcher the project target, so nothing
 * downstream has to re-derive scope from a session name.
 */

import { NextResponse } from "next/server";
import {
  notFound,
  resolveProjectOr404,
  resolveProjectSessionOr404,
} from "@/lib/shared/route-resolution";
import { z } from "zod";
import { createAgentAuth, type AgentAuth } from "@/lib/agent-gateway/token";
import { projectConversationTarget } from "@/lib/conversations/conversation-target";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { getProjectConversation, getSession } from "@/lib/state-store";
import { createLogger, withTracing } from "@/lib/logging";
import type { ApiError } from "@/lib/api/errors";
import type { AgentNotificationTarget } from "@/lib/notifications/push";
import {
  dispatchAgentNotification,
  type AgentNotificationOutcome,
  type AgentNotificationRequest,
} from "./dispatcher";

const log = createLogger("agent-notification-route");

export const agentNotificationBodySchema = z.object({
  title: z.string().min(1).optional(),
  message: z.string().min(1),
  urgency: z.enum(["info", "attention"]).optional(),
});
export type AgentNotificationBody = z.infer<typeof agentNotificationBodySchema>;

const DEFAULT_TITLE = "Agent notification";

export interface SessionNotificationRouteDeps {
  auth: AgentAuth;
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<{ sessionName: string } | null>;
  getProjectConversation(
    projectPath: string,
    conversationId: string,
  ): Promise<{ id: string } | null>;
  dispatchAgentNotification(
    request: AgentNotificationRequest,
  ): Promise<AgentNotificationOutcome>;
}

export function createSessionNotificationHandlers(
  deps: SessionNotificationRouteDeps,
) {
  /** The one domain call both adapters reach, once their scope is resolved. */
  async function dispatch(
    request: Request,
    target: AgentNotificationTarget,
  ): Promise<Response> {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Request body must be JSON" } satisfies ApiError,
        { status: 400 },
      );
    }

    const parsed = agentNotificationBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid notification payload",
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
        { status: 400 },
      );
    }

    const request_: AgentNotificationRequest = {
      target,
      title: parsed.data.title ?? DEFAULT_TITLE,
      message: parsed.data.message,
      ...(parsed.data.urgency !== undefined
        ? { urgency: parsed.data.urgency }
        : {}),
    };

    const outcome = await deps.dispatchAgentNotification(request_);
    if (!outcome.delivered) {
      log.info("agent-notification.not_delivered", {
        ...target,
        reason: outcome.reason,
      });
      return NextResponse.json({ error: outcome.reason } satisfies ApiError, {
        status: 409,
      });
    }

    log.info("agent-notification.delivered", { ...target });
    return NextResponse.json({ ok: true });
  }

  async function post(
    request: Request,
    { params }: { params: Promise<Record<string, string>> },
  ): Promise<Response> {
    const denied = await deps.auth.requireToken(request);
    if (denied) return denied;

    const { name, session } = await params;
    const projectName = name ?? "";

    const resolved = await resolveProjectSessionOr404(
      deps,
      projectName,
      session ?? "",
    );
    if (!resolved.ok) return resolved.response;

    return dispatch(request, {
      scope: "session",
      projectName,
      sessionName: resolved.value.session.sessionName,
    });
  }

  async function projectPost(
    request: Request,
    { params }: { params: Promise<Record<string, string>> },
  ): Promise<Response> {
    const denied = await deps.auth.requireToken(request);
    if (denied) return denied;

    const { name, conversationId } = await params;
    const projectName = name ?? "";

    const project = await resolveProjectOr404(deps, projectName);
    if (!project.ok) return project.response;

    const conversation = await deps.getProjectConversation(
      project.value,
      conversationId ?? "",
    );
    if (!conversation) {
      return notFound("Conversation not found", "conversation_not_found");
    }

    return dispatch(
      request,
      projectConversationTarget(projectName, conversation.id),
    );
  }

  return { POST: post, PROJECT_POST: projectPost };
}

const defaultHandlers = createSessionNotificationHandlers({
  auth: createAgentAuth(),
  resolveProjectPath,
  getSession,
  getProjectConversation,
  dispatchAgentNotification,
});

/** POST /api/projects/[name]/sessions/[session]/notifications */
export const POST = withTracing(defaultHandlers.POST);

/** POST /api/projects/[name]/conversations/[conversationId]/notifications */
export const PROJECT_CONVERSATION_POST = withTracing(
  defaultHandlers.PROJECT_POST,
);
