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
} from "@/lib/state-store";
import type { SessionState } from "@/lib/sessions/schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { workflowLiveEditRequestSchema } from "@/lib/workflows/edit-schemas";
import { formatDefinitionEditIssue } from "./definition-edits";
import type {
  LiveEditApplyOutcome,
  LiveEditApplyRequest,
  LiveEditFailure,
} from "./live-edit-apply";
import {
  guardExecutionMutation,
  runPinnedMutation,
  type WorkflowMutationGuardDeps,
} from "./mutation-guard";
import { applyProductionGraphWorkflowLiveEdits } from "./production";

type RouteContext = {
  params: Promise<Record<string, string>>;
};

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
  applyLiveEdits(input: {
    projectPath: string;
    sessionName: string;
    request: LiveEditApplyRequest;
  }): Promise<LiveEditApplyOutcome>;
  /**
   * Principal verification seams for the shared mutation guard. Optional so
   * production inherits the registered verifiers and tests inject their own.
   */
  auth?: WorkflowMutationGuardDeps["auth"];
  verifyConversationCapability?: WorkflowMutationGuardDeps["verifyConversationCapability"];
  verifyLaneCapability?: WorkflowMutationGuardDeps["verifyLaneCapability"];
}

const defaultDeps: GraphWorkflowRuntimeEditRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  getSession: defaultGetSession,
  getActiveExecution: getActiveGraphWorkflowExecution,
  applyLiveEdits: applyProductionGraphWorkflowLiveEdits,
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
  if (failure.rationale) {
    body["rationale"] = failure.rationale;
  }
  return NextResponse.json(body, { status: failure.status });
}

async function resolveSession(
  context: RouteContext,
  deps: GraphWorkflowRuntimeEditRouteDeps,
): Promise<
  | { error: Response }
  | { projectPath: string; sessionName: string; session: SessionState }
> {
  const params = await context.params;
  const projectName = params["name"] ?? "";
  const sessionName = decodeURIComponent(params["session"] ?? "");
  const resolved = await resolveProjectSessionOr404(
    deps,
    projectName,
    sessionName,
  );
  if (!resolved.ok) return { error: resolved.response };
  return {
    projectPath: resolved.value.projectPath,
    sessionName,
    session: resolved.value.session,
  };
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
    const { projectPath, sessionName, session } = resolved;

    // A live edit is authored work on the plan a run is executing, not a
    // decision about the launch, so authority here is session MEMBERSHIP: the
    // human UI, any conversation the session verified, and the lane currently
    // driving its own context. The lifecycle verbs keep the narrower origin
    // rule. Guarded before the apply below, which commits — a refusal must be
    // write-free.
    const guarded = await guardExecutionMutation({
      request,
      session,
      deps,
      verb: "edit",
      projectPath,
      authority: "any_session_conversation",
      execution: await deps.getActiveExecution(projectPath, sessionName),
    });
    if ("refusal" in guarded) return guarded.refusal;

    // Pinned to the run the guard authorized: an edit that landed on the
    // successor the lease turned over to would restructure a run this caller
    // was never admitted on.
    const acted = await runPinnedMutation(guarded.fence, "edit", () =>
      deps.applyLiveEdits({ projectPath, sessionName, request: editRequest }),
    );
    if (acted.kind === "turnover") return acted.refusal;
    const outcome = acted.value;

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
