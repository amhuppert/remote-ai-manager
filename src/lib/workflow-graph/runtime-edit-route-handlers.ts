import { NextResponse } from "next/server";
import { withTracing } from "@/lib/logging";
import { workflowRuntimeEditRequestSchema } from "@/lib/workflows/schemas";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import {
  getSession as defaultGetSession,
  getActiveGraphWorkflowExecution,
  mutateActiveGraphWorkflowExecution,
  archiveActiveGraphWorkflowExecution,
  markGraphWorkflowContextEventsPreReset,
} from "@/lib/state-store";
import type { ApiError } from "@/lib/api/errors";
import type { SessionState } from "@/lib/sessions/schemas";
import type {
  GraphWorkflowExecution,
  WorkflowRuntimeEditRequest,
} from "@/lib/workflows/schemas";
import { createGraphWorkflowExecutionRepository } from "./execution-repository";
import { createWorkflowStorageService } from "./storage";
import { createGraphWorkflowManager } from "@/lib/workflow-graph/workflow-manager";
import { createParallelWorktrees } from "./parallel-worktrees";
import {
  GraphWorkflowRuntimeEditValidationError,
  createGraphWorkflowRuntimeEditService,
} from "./runtime-edits";

type RouteContext = {
  params: Promise<Record<string, string>>;
};

const executionRepository = createGraphWorkflowExecutionRepository({
  getSession: defaultGetSession,
  getActiveGraphWorkflowExecution,
  mutateActiveGraphWorkflowExecution,
  archiveActiveGraphWorkflowExecution,
  markGraphWorkflowContextEventsPreReset,
});
const workflowStorage = createWorkflowStorageService();
const workflowManager = createGraphWorkflowManager({
  executionRepository,
  loadDefinition: (projectPath, definitionId) =>
    workflowStorage.get(projectPath, definitionId),
  parallelWorktrees: createParallelWorktrees(),
  getSession: defaultGetSession,
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
    return workflowManager.mutateActive(projectPath, sessionName, (execution) =>
      runtimeEditService.applyUserEdits(execution, request),
    );
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
    message ===
    "User runtime edits are allowed only while execution is running, paused, halted, or aborted"
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

const defaultGraphWorkflowRuntimeEditHandlers =
  createGraphWorkflowRuntimeEditRouteHandlers();

export const applyGraphWorkflowRuntimeEdits = withTracing(
  defaultGraphWorkflowRuntimeEditHandlers.POST,
);
