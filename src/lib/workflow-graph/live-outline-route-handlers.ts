import { NextResponse } from "next/server";
import { createLogger, withTracing } from "@/lib/logging";
import {
  notFound,
  resolveProjectSessionOr404,
} from "@/lib/shared/route-resolution";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import {
  getSession as defaultGetSession,
  getActiveGraphWorkflowExecution,
} from "@/lib/state-store";
import type { ApiError } from "@/lib/api/errors";
import type { SessionState } from "@/lib/sessions/schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { projectLiveOutline, type LiveOutlineSelector } from "./live-outline";

const logger = createLogger("workflow.live-edit");

type RouteContext = {
  params: Promise<Record<string, string>>;
};

export interface GraphWorkflowLiveOutlineRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  getActiveExecution(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null>;
}

const defaultDeps: GraphWorkflowLiveOutlineRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  getSession: defaultGetSession,
  getActiveExecution: getActiveGraphWorkflowExecution,
};

async function resolveSession(
  context: RouteContext,
  deps: GraphWorkflowLiveOutlineRouteDeps,
): Promise<{ error: Response } | { projectPath: string; sessionName: string }> {
  const params = await context.params;
  const projectName = params["name"] ?? "";
  const sessionName = decodeURIComponent(params["session"] ?? "");
  const resolved = await resolveProjectSessionOr404(
    deps,
    projectName,
    sessionName,
  );
  if (!resolved.ok) return { error: resolved.response };
  return { projectPath: resolved.value.projectPath, sessionName };
}

/**
 * Parse the mutually-exclusive section selectors (`?context` / `?task` /
 * `?config` / `?full` / `?charter`) into a {@link LiveOutlineSelector}.
 * Combining more than one is a malformed request (the CLI guards this too, but
 * the endpoint is the authority). `?full=false` / `?charter=false` are treated
 * as absent.
 */
function parseSelector(
  url: URL,
): { ok: true; selector: LiveOutlineSelector } | { ok: false; error: string } {
  const context = url.searchParams.get("context");
  const task = url.searchParams.get("task");
  const config = url.searchParams.get("config");
  const fullRaw = url.searchParams.get("full");
  const full = fullRaw !== null && fullRaw !== "false";
  const charterRaw = url.searchParams.get("charter");
  const charter = charterRaw !== null && charterRaw !== "false";

  const present = [
    context !== null,
    task !== null,
    config !== null,
    full,
    charter,
  ].filter(Boolean).length;
  if (present > 1) {
    return {
      ok: false,
      error: "choose at most one of context, task, config, charter, or full",
    };
  }

  if (context !== null)
    return { ok: true, selector: { kind: "context", contextId: context } };
  if (task !== null)
    return { ok: true, selector: { kind: "task", taskId: task } };
  if (config !== null)
    return { ok: true, selector: { kind: "config", contextId: config } };
  if (charter) return { ok: true, selector: { kind: "charter" } };
  if (full) return { ok: true, selector: { kind: "full" } };
  return { ok: true, selector: { kind: "outline" } };
}

export function createGraphWorkflowLiveOutlineRouteHandlers(
  deps: GraphWorkflowLiveOutlineRouteDeps = defaultDeps,
) {
  async function GET(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) return resolved.error;
    const { projectPath, sessionName } = resolved;

    const selectorResult = parseSelector(new URL(request.url));
    if (!selectorResult.ok) {
      return NextResponse.json(
        { error: selectorResult.error } satisfies ApiError,
        { status: 400 },
      );
    }

    const execution = await deps.getActiveExecution(projectPath, sessionName);
    if (!execution) {
      return notFound(
        "Session does not have an active graph workflow execution",
      );
    }

    const result = projectLiveOutline(execution, selectorResult.selector);
    if (!result.ok) {
      return notFound(result.error);
    }

    logger.debug("live_outline.projected", {
      executionId: execution.id,
      liveRevision: execution.liveRevision,
      section: result.section,
    });

    return NextResponse.json(result);
  }

  return { GET };
}

const defaultGraphWorkflowLiveOutlineHandlers =
  createGraphWorkflowLiveOutlineRouteHandlers();

export const getGraphWorkflowLiveOutline = withTracing(
  defaultGraphWorkflowLiveOutlineHandlers.GET,
);
