import { NextResponse } from "next/server";
import { workflowRuntimeEditRequestSchema } from "@/lib/schemas";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/project-resolver";
import { getSession as defaultGetSession, mutateSession } from "@/lib/state";
import type {
  ApiError,
  GraphWorkflowExecution,
  SessionState,
  WorkflowRuntimeEditRequest,
} from "@/types";
import { createGraphWorkflowExecutionRepository } from "./execution-repository";
import {
  GraphWorkflowRuntimeEditValidationError,
  createGraphWorkflowRuntimeEditService,
} from "./runtime-edits";

type RouteContext = {
  params: Promise<Record<string, string>>;
};

const executionRepository = createGraphWorkflowExecutionRepository({
  getSession: defaultGetSession,
  mutateSession,
});
const runtimeEditService = createGraphWorkflowRuntimeEditService();

export interface GraphWorkflowRuntimeEditRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  applyRuntimeEdits(
    projectPath: string,
    sessionName: string,
    request: WorkflowRuntimeEditRequest,
  ): Promise<GraphWorkflowExecution>;
}

const defaultDeps: GraphWorkflowRuntimeEditRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  getSession: defaultGetSession,
  async applyRuntimeEdits(projectPath, sessionName, request) {
    const execution = await executionRepository.getActive(
      projectPath,
      sessionName,
    );
    if (!execution) {
      throw new Error(
        "Session does not have an active graph workflow execution",
      );
    }

    const updated = runtimeEditService.applyUserEdits(execution, request);
    await executionRepository.update(projectPath, sessionName, updated);
    return updated;
  },
};

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
  const projectPath = await deps.resolveProjectPath(projectName);

  if (!projectPath) {
    return {
      error: NextResponse.json(
        { error: "Project not found" } satisfies ApiError,
        { status: 404 },
      ),
    };
  }

  const session = await deps.getSession(projectPath, sessionName);
  if (!session) {
    return {
      error: NextResponse.json(
        { error: "Session not found" } satisfies ApiError,
        { status: 404 },
      ),
    };
  }

  return { projectPath, sessionName, session };
}

function isRuntimeEditValidationError(error: unknown): error is
  | GraphWorkflowRuntimeEditValidationError
  | {
      name: string;
      message: string;
      errors: unknown;
    } {
  return (
    error instanceof GraphWorkflowRuntimeEditValidationError ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { name?: string }).name ===
        "GraphWorkflowRuntimeEditValidationError" &&
      "errors" in error)
  );
}

function respondToRuntimeEditError(error: unknown): Response {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" &&
          error !== null &&
          "message" in error &&
          typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : "Graph workflow request failed";

  if (isRuntimeEditValidationError(error)) {
    return NextResponse.json(
      {
        error: message,
        errors: error.errors,
      } satisfies ApiError & { errors: unknown },
      { status: 422 },
    );
  }

  if (message === "Session does not have an active graph workflow execution") {
    return NextResponse.json({ error: message } satisfies ApiError, {
      status: 404,
    });
  }

  if (
    message === "User runtime edits are allowed only while execution is running"
  ) {
    return NextResponse.json({ error: message } satisfies ApiError, {
      status: 409,
    });
  }

  return NextResponse.json({ error: message } satisfies ApiError, {
    status: 500,
  });
}

export function createGraphWorkflowRuntimeEditRouteHandlers(
  deps: GraphWorkflowRuntimeEditRouteDeps = defaultDeps,
) {
  async function POST(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }

    const parsed = workflowRuntimeEditRequestSchema.safeParse(
      await request.json(),
    );
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid request: operations are required",
        } satisfies ApiError,
        { status: 400 },
      );
    }

    try {
      const execution = await deps.applyRuntimeEdits(
        resolved.projectPath,
        resolved.sessionName,
        parsed.data,
      );
      return NextResponse.json({ execution });
    } catch (error) {
      return respondToRuntimeEditError(error);
    }
  }

  return { POST };
}
