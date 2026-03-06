/**
 * Workflow route handler logic — extracted for dependency injection.
 *
 * Route files delegate to these handlers, passing production deps.
 * Tests create handlers with mock deps via `createWorkflowRouteHandlers(deps)`.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/project-resolver";
import {
  getSession as defaultGetSession,
  mutateSession as defaultMutateSession,
} from "@/lib/state";
import {
  startWorkflow as defaultStartWorkflow,
  resumeWorkflow as defaultResumeWorkflow,
  sendEvent as defaultSendEvent,
  hasActiveWorkflow as defaultHasActiveWorkflow,
} from "@/lib/workflows/ralph-loop/workflow-manager";
import { dispatchPlanGeneration as defaultDispatchPlanGeneration } from "@/lib/ralph-loop/plan-generator";
import { getConversation as defaultGetConversation } from "@/lib/conversations";
import { executePromptStream as defaultExecutePromptStream } from "@/lib/prompt";
import { isSessionBusy as defaultIsSessionBusy } from "@/lib/lock";
import { createInitialCircuitBreakerState } from "@/lib/ralph-loop/circuit-breaker";
import { fixPlanTaskSchema, runPromptRequestSchema } from "@/lib/schemas";
import { broadcast as defaultBroadcast } from "@/lib/sse-broadcaster";
import type {
  ApiError,
  SessionState,
  ConversationState,
  RunPromptRequest,
} from "@/types";

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface WorkflowRouteDeps {
  resolveProjectPath: (name: string) => Promise<string | null>;
  getSession: (
    projectPath: string,
    sessionName: string,
  ) => Promise<SessionState | null>;
  mutateSession: typeof defaultMutateSession;
  startWorkflow: typeof defaultStartWorkflow;
  resumeWorkflow: typeof defaultResumeWorkflow;
  sendEvent: typeof defaultSendEvent;
  hasActiveWorkflow: typeof defaultHasActiveWorkflow;
  dispatchPlanGeneration: typeof defaultDispatchPlanGeneration;
  getConversation: (
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ) => Promise<ConversationState | null>;
  executePromptStream: typeof defaultExecutePromptStream;
  isSessionBusy: (projectPath: string, sessionName: string) => boolean;
  broadcast: typeof defaultBroadcast;
}

const defaultDeps: WorkflowRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  getSession: defaultGetSession,
  mutateSession: defaultMutateSession,
  startWorkflow: defaultStartWorkflow,
  resumeWorkflow: defaultResumeWorkflow,
  sendEvent: defaultSendEvent,
  hasActiveWorkflow: defaultHasActiveWorkflow,
  dispatchPlanGeneration: defaultDispatchPlanGeneration,
  getConversation: defaultGetConversation,
  executePromptStream: defaultExecutePromptStream,
  isSessionBusy: defaultIsSessionBusy,
  broadcast: defaultBroadcast,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RouteContext = {
  params: Promise<Record<string, string>>;
};

// ---------------------------------------------------------------------------
// Shared param resolver
// ---------------------------------------------------------------------------

type ResolveError = { error: Response };
type ResolveSuccess = {
  projectPath: string;
  sessionName: string;
  session: SessionState;
  name: string;
};

async function resolveSessionParams(
  context: RouteContext,
  deps: WorkflowRouteDeps,
): Promise<ResolveError | ResolveSuccess> {
  const resolvedParams = await context.params;
  const name = resolvedParams["name"] ?? "";
  const sessionSlug = resolvedParams["session"] ?? "";
  const sessionName = decodeURIComponent(sessionSlug);

  const projectPath = await deps.resolveProjectPath(name);
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

  return { projectPath, sessionName, session, name };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const startWorkflowSchema = z.object({
  objective: z.string().min(1).optional(),
});

const patchWorkflowSchema = z.object({
  objective: z.string().min(1),
});

const updateFixPlanSchema = z.object({
  fixPlan: z.array(fixPlanTaskSchema),
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWorkflowRouteHandlers(
  deps: WorkflowRouteDeps = defaultDeps,
) {
  // ===== POST /workflow — Create workflow =====
  async function workflowPOST(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSessionParams(context, deps);
    if ("error" in resolved) return resolved.error;
    const { projectPath, sessionName, session } = resolved;

    if (session.workflow) {
      return NextResponse.json(
        { error: "Session already has a workflow" } satisfies ApiError,
        { status: 409 },
      );
    }

    let body: z.infer<typeof startWorkflowSchema>;
    try {
      body = startWorkflowSchema.parse(await request.json());
    } catch {
      body = {};
    }

    const workflow = await deps.mutateSession(
      projectPath,
      sessionName,
      "workflow.create",
      (sess) => {
        const now = new Date().toISOString();
        sess.workflow = {
          status: "planning",
          objective: body.objective ?? "",
          fixPlan: [],
          config: {
            maxIterations: 20,
            iterationTimeoutMs: 3_600_000,
            contextSoftLimitTokens: 160_000,
            contextHardLimitTokens: 180_000,
            circuitBreaker: {
              noProgressThreshold: 3,
              sameErrorThreshold: 5,
            },
          },
          currentIterationConversationId: null,
          circuitBreaker: createInitialCircuitBreakerState(),
          iterations: [],
          haltReason: null,
          generatingPlan: false,
          createdAt: now,
          startedAt: null,
          completedAt: null,
          totalCostUsd: 0,
          totalDurationMs: 0,
        };
        return sess.workflow;
      },
    );

    return NextResponse.json({ workflow }, { status: 201 });
  }

  // ===== GET /workflow — Get workflow state =====
  async function workflowGET(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSessionParams(context, deps);
    if ("error" in resolved) return resolved.error;
    const { session } = resolved;

    return NextResponse.json({ workflow: session.workflow ?? null });
  }

  // ===== PATCH /workflow — Update objective =====
  async function workflowPATCH(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSessionParams(context, deps);
    if ("error" in resolved) return resolved.error;
    const { projectPath, sessionName, session } = resolved;

    if (!session.workflow) {
      return NextResponse.json(
        { error: "No workflow exists" } satisfies ApiError,
        { status: 404 },
      );
    }

    if (session.workflow.status !== "planning") {
      return NextResponse.json(
        {
          error: "Objective can only be changed during planning phase",
        } satisfies ApiError,
        { status: 409 },
      );
    }

    const parsed = patchWorkflowSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request body" } satisfies ApiError,
        { status: 400 },
      );
    }

    const workflow = await deps.mutateSession(
      projectPath,
      sessionName,
      "workflow.updateObjective",
      (sess) => {
        if (!sess.workflow) return null;
        sess.workflow.objective = parsed.data.objective;
        return sess.workflow;
      },
    );

    return NextResponse.json({ workflow });
  }

  // ===== POST /workflow/confirm =====
  async function confirmPOST(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSessionParams(context, deps);
    if ("error" in resolved) return resolved.error;
    const { projectPath, sessionName, session } = resolved;

    if (!session.workflow) {
      return NextResponse.json(
        { error: "No workflow exists" } satisfies ApiError,
        { status: 404 },
      );
    }

    if (session.workflow.status !== "planning") {
      return NextResponse.json(
        {
          error: "Workflow can only be confirmed during planning phase",
        } satisfies ApiError,
        { status: 409 },
      );
    }

    if (!session.workflow.objective.trim()) {
      return NextResponse.json(
        { error: "Objective cannot be empty" } satisfies ApiError,
        { status: 400 },
      );
    }

    if (session.workflow.fixPlan.length === 0) {
      return NextResponse.json(
        { error: "Fix plan must have at least one task" } satisfies ApiError,
        { status: 400 },
      );
    }

    await deps.mutateSession(
      projectPath,
      sessionName,
      "workflow.confirm",
      (sess) => {
        if (!sess.workflow) return;
        sess.workflow.status = "running";
        if (!sess.workflow.startedAt) {
          sess.workflow.startedAt = new Date().toISOString();
        }
      },
    );

    deps.startWorkflow({
      projectPath,
      projectName: projectPath.split("/").pop() ?? projectPath,
      sessionName,
      objective: session.workflow.objective,
      config: session.workflow.config,
      fixPlan: session.workflow.fixPlan,
      worktreePath: session.worktreePath,
      iterations: session.workflow.iterations,
      circuitBreaker: session.workflow.circuitBreaker,
      totalCostUsd: session.workflow.totalCostUsd,
      totalDurationMs: session.workflow.totalDurationMs,
    });

    const updatedSession = await deps.getSession(projectPath, sessionName);
    return NextResponse.json(
      { workflow: updatedSession?.workflow ?? session.workflow },
      { status: 202 },
    );
  }

  // ===== POST /workflow/pause =====
  async function pausePOST(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSessionParams(context, deps);
    if ("error" in resolved) return resolved.error;
    const { projectPath, sessionName, session } = resolved;

    if (!session.workflow || session.workflow.status !== "running") {
      return NextResponse.json(
        { error: "Workflow is not running" } satisfies ApiError,
        { status: 409 },
      );
    }

    if (!deps.hasActiveWorkflow(projectPath, sessionName)) {
      return NextResponse.json(
        {
          error: "Workflow not found in actor registry",
        } satisfies ApiError,
        { status: 409 },
      );
    }

    deps.sendEvent(projectPath, sessionName, { type: "PAUSE" });

    return NextResponse.json({ status: "pause_requested" });
  }

  // ===== POST /workflow/resume =====
  async function resumePOST(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSessionParams(context, deps);
    if ("error" in resolved) return resolved.error;
    const { projectPath, sessionName, session } = resolved;

    if (!session.workflow) {
      return NextResponse.json(
        { error: "No workflow exists" } satisfies ApiError,
        { status: 404 },
      );
    }

    if (
      session.workflow.status !== "paused" &&
      session.workflow.status !== "halted"
    ) {
      return NextResponse.json(
        {
          error: "Workflow must be paused or halted to resume",
        } satisfies ApiError,
        { status: 409 },
      );
    }

    if (session.workflow.status === "halted") {
      await deps.mutateSession(
        projectPath,
        sessionName,
        "workflow.clearHaltForResume",
        (sess) => {
          if (sess.workflow) {
            sess.workflow.haltReason = null;
          }
        },
      );
    }

    deps.resumeWorkflow({
      projectPath,
      projectName: projectPath.split("/").pop() ?? projectPath,
      sessionName,
      objective: session.workflow.objective,
      config: session.workflow.config,
      fixPlan: session.workflow.fixPlan,
      worktreePath: session.worktreePath,
      iterations: session.workflow.iterations,
      circuitBreaker: session.workflow.circuitBreaker,
      totalCostUsd: session.workflow.totalCostUsd,
      totalDurationMs: session.workflow.totalDurationMs,
    });

    return NextResponse.json({ workflow: session.workflow }, { status: 202 });
  }

  // ===== POST /workflow/abort =====
  async function abortPOST(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSessionParams(context, deps);
    if ("error" in resolved) return resolved.error;
    const { projectPath, sessionName, session } = resolved;

    if (
      !session.workflow ||
      (session.workflow.status !== "running" &&
        session.workflow.status !== "paused")
    ) {
      return NextResponse.json(
        {
          error: "Workflow must be running or paused to abort",
        } satisfies ApiError,
        { status: 409 },
      );
    }

    if (deps.hasActiveWorkflow(projectPath, sessionName)) {
      deps.sendEvent(projectPath, sessionName, { type: "ABORT" });
    } else {
      await deps.mutateSession(
        projectPath,
        sessionName,
        "workflow.abort",
        (sess) => {
          if (!sess.workflow) return;
          sess.workflow.status = "aborted";
          sess.workflow.haltReason = { type: "aborted" };
          sess.workflow.completedAt = new Date().toISOString();
        },
      );
    }

    return NextResponse.json({ status: "aborted" });
  }

  // ===== PUT /workflow/fix-plan =====
  async function fixPlanPUT(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSessionParams(context, deps);
    if ("error" in resolved) return resolved.error;
    const { projectPath, sessionName, session, name } = resolved;

    if (!session.workflow) {
      return NextResponse.json(
        { error: "No workflow exists" } satisfies ApiError,
        { status: 404 },
      );
    }

    if (
      session.workflow.status !== "planning" &&
      session.workflow.status !== "paused"
    ) {
      return NextResponse.json(
        {
          error: "Fix plan can only be edited during planning or paused phases",
        } satisfies ApiError,
        { status: 409 },
      );
    }

    let body: z.infer<typeof updateFixPlanSchema>;
    try {
      body = updateFixPlanSchema.parse(await request.json());
    } catch {
      return NextResponse.json(
        { error: "Invalid fix plan data" } satisfies ApiError,
        { status: 400 },
      );
    }

    const fixPlan = await deps.mutateSession(
      projectPath,
      sessionName,
      "workflow.updateFixPlan",
      (sess) => {
        if (!sess.workflow) return null;
        sess.workflow.fixPlan = body.fixPlan;
        return sess.workflow.fixPlan;
      },
    );

    try {
      deps.broadcast({
        type: "workflow-fix-plan-updated",
        projectName: name,
        sessionName,
        fixPlan: fixPlan ?? [],
        source: "user",
      });
    } catch {
      // fire-and-forget
    }

    return NextResponse.json({ fixPlan });
  }

  // ===== POST /conversations/[conversationId]/prompt (with workflow guards) =====
  async function conversationPromptPOST(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolvedParams = await context.params;
    const name = resolvedParams["name"] ?? "";
    const sessionSlug = resolvedParams["session"] ?? "";
    const sessionName = decodeURIComponent(sessionSlug);
    const conversationId = resolvedParams["conversationId"] ?? "";

    const projectPath = await deps.resolveProjectPath(name);
    if (!projectPath) {
      return NextResponse.json(
        { error: "Project not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    const session = await deps.getSession(projectPath, sessionName);
    if (!session) {
      return NextResponse.json(
        { error: "Session not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    const conversation = await deps.getConversation(
      projectPath,
      sessionName,
      conversationId,
    );
    if (!conversation) {
      return NextResponse.json(
        { error: "Conversation not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    if (conversation.role === "iteration") {
      return NextResponse.json(
        {
          error: "Managed workflow conversations are not user-interactive",
          code: "MANAGED_CONVERSATION",
        } satisfies ApiError,
        { status: 403 },
      );
    }

    if (session.workflow?.status === "running") {
      return NextResponse.json(
        {
          error:
            "Session has an active workflow — prompts are blocked during execution",
          code: "WORKFLOW_ACTIVE",
        } satisfies ApiError,
        { status: 409 },
      );
    }

    if (deps.isSessionBusy(projectPath, sessionName)) {
      return NextResponse.json(
        {
          error: "Session is busy — a prompt is already running",
          code: "SESSION_BUSY",
        } satisfies ApiError,
        { status: 409 },
      );
    }

    let body: RunPromptRequest;
    try {
      body = runPromptRequestSchema.parse(await request.json());
    } catch {
      return NextResponse.json(
        {
          error: "Either prompt text or at least one image is required",
        } satisfies ApiError,
        { status: 400 },
      );
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const emit = (event: string, data: unknown) => {
          try {
            controller.enqueue(
              encoder.encode(
                `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
              ),
            );
          } catch {
            // Client disconnected
          }
        };

        try {
          await deps.executePromptStream(
            projectPath,
            session,
            body.prompt.trim(),
            emit,
            conversationId,
            body.modelId,
            body.images,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Prompt failed";
          emit("error", { message: msg });
          emit("done", {});
        } finally {
          try {
            controller.close();
          } catch {
            // Already closed
          }
        }
      },
      cancel() {
        // No-op
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  return {
    workflowPOST,
    workflowGET,
    workflowPATCH,
    confirmPOST,
    pausePOST,
    resumePOST,
    abortPOST,
    fixPlanPUT,
    conversationPromptPOST,
  };
}
