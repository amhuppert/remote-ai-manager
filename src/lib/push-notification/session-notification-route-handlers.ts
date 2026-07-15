/**
 * Agent-facing session notification endpoint (docs/design/cc-cli/02 §2.1).
 *
 * - POST /api/projects/[name]/sessions/[session]/notifications
 *   Body: { title?, message, urgency? }. Token-gated; sends an agent-initiated
 *   push via the existing dispatcher path. Replaces the send_notification MCP
 *   tool. The browser UI never calls this route.
 */

import { NextResponse } from "next/server";
import { resolveProjectSessionOr404 } from "@/lib/shared/route-resolution";
import { z } from "zod";
import { createAgentAuth, type AgentAuth } from "@/lib/agent-gateway/token";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { getSession } from "@/lib/state-store";
import { createLogger, withTracing } from "@/lib/logging";
import type { ApiError } from "@/lib/api/errors";
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
  dispatchAgentNotification(
    request: AgentNotificationRequest,
  ): Promise<AgentNotificationOutcome>;
}

export function createSessionNotificationHandlers(
  deps: SessionNotificationRouteDeps,
) {
  async function post(
    request: Request,
    { params }: { params: Promise<Record<string, string>> },
  ): Promise<Response> {
    const denied = await deps.auth.requireToken(request);
    if (denied) return denied;

    const { name, session } = await params;
    const projectName = name ?? "";
    const sessionName = session ?? "";

    const resolved = await resolveProjectSessionOr404(
      deps,
      projectName,
      sessionName,
    );
    if (!resolved.ok) return resolved.response;
    const sessionState = resolved.value.session;

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
      projectName,
      sessionName: sessionState.sessionName,
      title: parsed.data.title ?? DEFAULT_TITLE,
      message: parsed.data.message,
      ...(parsed.data.urgency !== undefined
        ? { urgency: parsed.data.urgency }
        : {}),
    };

    const outcome = await deps.dispatchAgentNotification(request_);
    if (!outcome.delivered) {
      log.info("agent-notification.not_delivered", {
        projectName,
        sessionName,
        reason: outcome.reason,
      });
      return NextResponse.json({ error: outcome.reason } satisfies ApiError, {
        status: 409,
      });
    }

    log.info("agent-notification.delivered", { projectName, sessionName });
    return NextResponse.json({ ok: true });
  }

  return { POST: post };
}

const defaultHandlers = createSessionNotificationHandlers({
  auth: createAgentAuth(),
  resolveProjectPath,
  getSession,
  dispatchAgentNotification,
});

/** POST /api/projects/[name]/sessions/[session]/notifications */
export const POST = withTracing(defaultHandlers.POST);
