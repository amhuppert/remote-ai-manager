import { NextResponse } from "next/server";
import { withTracing } from "@/lib/logging";
import {
  notFound,
  resolveProjectSessionOr404,
} from "@/lib/shared/route-resolution";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import {
  getSession as defaultGetSession,
  getActiveGraphWorkflowExecution,
  mutateActiveGraphWorkflowExecution,
  archiveActiveGraphWorkflowExecution,
  markGraphWorkflowContextEventsPreReset,
} from "@/lib/state-store";
import type { SessionState } from "@/lib/sessions/schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { workflowLiveEditRequestSchema } from "@/lib/workflows/edit-schemas";
import {
  createGraphWorkflowExecutionEventPublisher,
  type GraphWorkflowEventDelivery,
  type PublishCharterUpdatedInput,
  type PublishLiveEditAppliedInput,
} from "./execution-events";
import {
  createGraphWorkflowExecutionRepository,
  type MutateActiveResult,
} from "./execution-repository";
import { formatDefinitionEditIssue } from "./definition-edits";
import {
  applyLiveEditsToActiveExecution,
  buildDefaultLiveEditDeps,
  defaultWriteCharterDocument,
  type LiveEditFailure,
} from "./live-edit-apply";
import type { LiveEditDeps } from "./runtime-edits";

type RouteContext = {
  params: Promise<Record<string, string>>;
};

const eventPublisher = createGraphWorkflowExecutionEventPublisher();
const executionRepository = createGraphWorkflowExecutionRepository({
  getSession: defaultGetSession,
  getActiveGraphWorkflowExecution,
  mutateActiveGraphWorkflowExecution,
  archiveActiveGraphWorkflowExecution,
  markGraphWorkflowContextEventsPreReset,
  eventPublisher,
});

export interface GraphWorkflowRuntimeEditRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  getActiveExecution(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null>;
  mutateActive(
    projectPath: string,
    sessionName: string,
    fn: (
      execution: GraphWorkflowExecution,
    ) => MutateActiveResult | GraphWorkflowExecution,
  ): Promise<GraphWorkflowExecution>;
  buildLiveEditDeps(projectPath: string): Promise<LiveEditDeps>;
  publishLiveEditApplied(
    input: PublishLiveEditAppliedInput,
  ): GraphWorkflowEventDelivery;
  publishCharterUpdated(
    input: PublishCharterUpdatedInput,
  ): GraphWorkflowEventDelivery;
  /**
   * Rewrite the session worktree's charter.md pointer copy after an accepted
   * amendment. Lane worktrees re-materialize per iteration; the session
   * worktree's copy is only written at seed time, so it goes stale without
   * this. Best-effort: a failure is logged, never a request failure — the
   * inline prompt digest is authoritative, the file is a pointer copy.
   */
  writeCharterDocument(input: {
    worktreePath: string;
    markdown: string;
  }): Promise<void>;
}

const defaultDeps: GraphWorkflowRuntimeEditRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  getSession: defaultGetSession,
  getActiveExecution: getActiveGraphWorkflowExecution,
  mutateActive: executionRepository.mutateActive,
  buildLiveEditDeps: buildDefaultLiveEditDeps,
  publishLiveEditApplied: eventPublisher.publishLiveEditApplied,
  publishCharterUpdated: eventPublisher.publishCharterUpdated,
  writeCharterDocument: defaultWriteCharterDocument,
};

/** Map a service-layer rejection onto the doc-06 HTTP error contract. */
function respondLiveEditFailure(failure: LiveEditFailure): Response {
  const body: Record<string, unknown> = {
    error: failure.error,
    code: failure.code,
  };
  if (failure.currentLiveRevision !== undefined) {
    body["currentLiveRevision"] = failure.currentLiveRevision;
  }
  if (failure.issues) {
    body["issues"] = failure.issues.map(formatDefinitionEditIssue);
  }
  if (failure.instruction) {
    body["instruction"] = failure.instruction;
  }
  return NextResponse.json(body, { status: failure.status });
}

async function resolveSession(
  context: RouteContext,
  deps: GraphWorkflowRuntimeEditRouteDeps,
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

export function createGraphWorkflowRuntimeEditRouteHandlers(
  deps: GraphWorkflowRuntimeEditRouteDeps = defaultDeps,
) {
  async function POST(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json(
        {
          error: "Invalid live edit request: body must be JSON",
          issues: [{ path: "body", message: "invalid JSON" }],
        },
        { status: 400 },
      );
    }

    const parsed = workflowLiveEditRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid live edit request",
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join(".") || "operations",
            message: issue.message,
          })),
        },
        { status: 400 },
      );
    }
    const editRequest = parsed.data;

    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }
    const { projectPath, sessionName } = resolved;

    const outcome = await applyLiveEditsToActiveExecution(
      { projectPath, sessionName, request: editRequest },
      deps,
    );

    if (!outcome.ok) {
      if (outcome.kind === "no_active_execution") {
        return notFound(
          "Session does not have an active graph workflow execution",
        );
      }
      return respondLiveEditFailure(outcome.failure);
    }

    return NextResponse.json({
      applied: outcome.applied,
      liveRevision: outcome.liveRevision,
      affectedContextIds: outcome.affectedContextIds,
      dryRun: outcome.dryRun,
    });
  }

  return { POST };
}

const defaultGraphWorkflowRuntimeEditHandlers =
  createGraphWorkflowRuntimeEditRouteHandlers();

export const applyGraphWorkflowRuntimeEdits = withTracing(
  defaultGraphWorkflowRuntimeEditHandlers.POST,
);
