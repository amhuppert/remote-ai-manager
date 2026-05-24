import { NextResponse } from "next/server";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import {
  workflowGeneratedDraftSchema,
  workflowPlanRequestSchema,
} from "@/lib/workflows/schemas";
import type { ApiError } from "@/lib/api/errors";
import type {
  WorkflowGeneratedDraft,
  WorkflowPlanRequest,
} from "@/lib/workflows/schemas";
import { createWorkflowPlannerService } from "@/lib/workflow-graph/planner";

type RouteContext = {
  params: Promise<Record<string, string>>;
};

export interface WorkflowGenerateRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  generateDraft(
    input: WorkflowPlanRequest & { projectPath?: string },
  ): Promise<WorkflowGeneratedDraft>;
}

const defaultPlanner = createWorkflowPlannerService();

const defaultDeps: WorkflowGenerateRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
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
    const projectPath = await deps.resolveProjectPath(name);
    if (!projectPath) {
      return NextResponse.json(
        { error: "Project not found" } satisfies ApiError,
        { status: 404 },
      );
    }

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
      const draft = await deps.generateDraft({
        ...body,
        projectPath,
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
