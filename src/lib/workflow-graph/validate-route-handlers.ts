/**
 * Agent-facing workflow-plan validation endpoint (docs/design/cc-cli/02 §3.1).
 *
 * - POST /api/projects/[name]/sessions/[session]/graph-workflow/validate
 *   Body: the same `{ name, description?, definition, layout }` a create/replace
 *   accepts. Runs the create-path Zod parse + structural graph checks via the
 *   shared `validateWorkflowPlan` pure function and PERSISTS NOTHING — it has no
 *   storage dependency by design. Returns `{ ok: true }` (200) or
 *   `{ error, issues[] }` (400) with JSON-path locations. Token-gated. Backs
 *   `cctl workflow validate --file plan.json`; the browser UI never calls it.
 */

import { NextResponse } from "next/server";
import { createAgentAuth, type AgentAuth } from "@/lib/agent-gateway/token";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { getSession } from "@/lib/state-store";
import { createLogger, withTracing } from "@/lib/logging";
import type { ApiError } from "@/lib/api/errors";
import { validateWorkflowPlan } from "@/lib/workflows/plan-validation";

const log = createLogger("graph-workflow-validate-route");

export interface GraphWorkflowValidateRouteDeps {
  auth: AgentAuth;
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<{ sessionName: string } | null>;
}

export function createGraphWorkflowValidateHandlers(
  deps: GraphWorkflowValidateRouteDeps,
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

    const projectPath = await deps.resolveProjectPath(projectName);
    if (!projectPath) {
      return NextResponse.json(
        { error: "Project not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    const sessionState = await deps.getSession(projectPath, sessionName);
    if (!sessionState) {
      return NextResponse.json(
        { error: "Session not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Request body must be JSON" } satisfies ApiError,
        { status: 400 },
      );
    }

    const validation = validateWorkflowPlan(rawBody);
    if (!validation.ok) {
      log.info("graph-workflow-validate.invalid", {
        projectName,
        sessionName,
        issueCount: validation.issues.length,
      });
      return NextResponse.json(
        { error: "Workflow plan is invalid", issues: validation.issues },
        { status: 400 },
      );
    }

    log.info("graph-workflow-validate.ok", { projectName, sessionName });
    return NextResponse.json({ ok: true });
  }

  return { POST: post };
}

const defaultHandlers = createGraphWorkflowValidateHandlers({
  auth: createAgentAuth(),
  resolveProjectPath,
  getSession,
});

/** POST /api/projects/[name]/sessions/[session]/graph-workflow/validate */
export const POST = withTracing(defaultHandlers.POST);
