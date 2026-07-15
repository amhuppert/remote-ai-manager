import { NextResponse } from "next/server";
import { resolveProjectOr404 } from "@/lib/shared/route-resolution";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import {
  workflowGeneratedDraftSchema,
  workflowPlanRequestSchema,
} from "@/lib/workflow-graph/definition-schemas";
import type { ApiError } from "@/lib/api/errors";
import type {
  WorkflowGeneratedDraft,
  WorkflowPlanRequest,
} from "@/lib/workflow-graph/definition-schemas";
import { createWorkflowPlannerService } from "@/lib/workflow-graph/planner";
import {
  ensurePlannerSession as defaultEnsurePlannerSession,
  PLANNER_SESSION_NAME,
} from "@/lib/sessions/service";
import type { SessionState } from "@/lib/sessions/schemas";

type RouteContext = {
  params: Promise<Record<string, string>>;
};

export interface WorkflowGenerateRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  ensurePlannerSession(projectPath: string): Promise<SessionState>;
  generateDraft(
    input: WorkflowPlanRequest & {
      projectPath: string;
      sessionName: string;
      conversationId: string;
    },
  ): Promise<WorkflowGeneratedDraft>;
}

const defaultPlanner = createWorkflowPlannerService();

const defaultDeps: WorkflowGenerateRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  ensurePlannerSession: defaultEnsurePlannerSession,
  generateDraft: (input) => defaultPlanner.generateDraft(input),
};

export function createWorkflowGenerateRouteHandlers(
  deps: WorkflowGenerateRouteDeps = defaultDeps,
) {
  async function POST(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const name = (await context.params)["name"] ?? "";
    const project = await resolveProjectOr404(deps, name);
    if (!project.ok) return project.response;
    const projectPath = project.value;

    let body: WorkflowPlanRequest;
    try {
      body = workflowPlanRequestSchema.parse(await request.json());
    } catch {
      return NextResponse.json(
        { error: "Invalid request: objective is required" } satisfies ApiError,
        { status: 400 },
      );
    }

    try {
      const plannerSession = await deps.ensurePlannerSession(projectPath);
      const conversationId = plannerSession.conversations[0]?.id;
      if (!conversationId) {
        return NextResponse.json(
          {
            error: "Planner session has no initial conversation",
          } satisfies ApiError,
          { status: 500 },
        );
      }

      const draft = await deps.generateDraft({
        ...body,
        projectPath,
        sessionName: PLANNER_SESSION_NAME,
        conversationId,
      });
      return NextResponse.json(workflowGeneratedDraftSchema.parse(draft));
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to generate workflow draft";
      return NextResponse.json({ error: message } satisfies ApiError, {
        status: 422,
      });
    }
  }

  return { POST };
}
