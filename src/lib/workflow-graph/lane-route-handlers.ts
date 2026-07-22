/**
 * Token-gated graph-workflow LANE tool endpoints (docs/design/cc-cli/02 §4).
 *
 * The four graph-workflow lane tools (complete_task, add_task,
 * upsert_shared_document, request_collaboration) move to HTTP endpoints under
 * the workflow execution resource. Each handler performs the pre-dispatch halt
 * check FIRST (port of `wrapMcpHandlerWithHaltCheck`): a pending halt or a
 * pending collaboration block yields `409 { halt: true, reason }` with the same
 * reason text an agent sees today. Capability gates (`allowAgentTaskAdd`,
 * `allowAgentCollaboration`) return 403. The `cctl workflow …` verbs back these.
 *
 * Lane identity: `contextId`/`taskId`/document path come from the URL; the
 * lane's `executionId` rides the body as a precondition guard (the URL carries
 * no executionId per doc 02 §4, but the loader still validates the lane belongs
 * to the currently-active execution — preserving the stale-lane guard the MCP
 * URL provided). The CLI fills both from `CC_WORKFLOW_EXECUTION_ID` /
 * `CC_WORKFLOW_CONTEXT_ID` (doc 01 §2).
 */

import { NextResponse } from "next/server";
import { jsonError, resolveProjectOr404 } from "@/lib/shared/route-resolution";
import { z } from "zod";
import { createAgentAuth, type AgentAuth } from "@/lib/agent-gateway/token";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { createLogger, withTracing } from "@/lib/logging";
import type { AgentAddedTask } from "@/lib/workflow-graph/runtime-edits";
import {
  loadGraphWorkflowLaneToolContext,
  type LoadLaneToolContextResult,
} from "./lane-tool-context-loader";
import { resolveLaneHaltReason } from "./tool-dispatcher";
import { DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD } from "./constants";
import { evaluateLaneReminders, type LaneVerb } from "./lane-reminders";
import {
  addTaskSchema,
  buildContextLimitStopInstruction,
  createRequestCollaborationHandler,
  type GraphWorkflowToolServerContext,
} from "./lane-tool-service";

const log = createLogger("graph-workflow-lane-route");

const ADD_TASK_DISABLED_MESSAGE =
  "This execution context does not allow agent-added tasks (mutability.allowAgentTaskAdd is disabled).";
const COLLABORATION_DISABLED_MESSAGE =
  "This execution context does not allow agent-initiated collaboration requests.";

const executionIdField = z.string().trim().min(1);
const trimmedRequired = z.string().trim().min(1);

const completeBodySchema = z.object({
  executionId: executionIdField,
  summary: trimmedRequired,
});
const addBodySchema = addTaskSchema.extend({ executionId: executionIdField });
const sharedDocBodySchema = z.object({
  executionId: executionIdField,
  // Shared-document upserts are session-wide, but the write runs through the
  // lane's own execution-context tool context (halt-check + mutateActive), so
  // the lane supplies its contextId (from CC_WORKFLOW_CONTEXT_ID) in the body.
  contextId: trimmedRequired,
  description: trimmedRequired,
  readWhen: trimmedRequired,
});
const collaborationBodySchema = z.object({
  executionId: executionIdField,
  brief: trimmedRequired,
});

const collaborationStartedSchema = z.object({
  status: z.literal("started"),
  workflowId: z.string(),
});

export interface LaneRouteDeps {
  auth: AgentAuth;
  resolveProjectPath(name: string): Promise<string | null>;
  loadLaneToolContext(
    projectPath: string,
    sessionName: string,
    executionId: string,
    contextId: string,
  ): Promise<LoadLaneToolContextResult>;
}

function invalidBody(error: z.ZodError): Response {
  return NextResponse.json(
    {
      error: "Invalid request payload",
      issues: error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    },
    { status: 400 },
  );
}

async function readJsonBody(request: Request): Promise<unknown | undefined> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

type PreparedContext =
  | { ok: true; context: GraphWorkflowToolServerContext }
  | { ok: false; response: Response };

/**
 * Resolve the project, load the lane tool context, and run the pre-dispatch
 * halt check — the shared preamble every lane endpoint runs before touching
 * state. A pending halt/collaboration block returns 409 `{ halt, reason }` with
 * the exact text `wrapMcpHandlerWithHaltCheck` surfaces today.
 */
async function prepareContext(
  deps: LaneRouteDeps,
  verb: LaneVerb,
  projectName: string,
  sessionName: string,
  executionId: string,
  contextId: string,
): Promise<PreparedContext> {
  const project = await resolveProjectOr404(deps, projectName);
  if (!project.ok) return project;
  const projectPath = project.value;

  const result = await deps.loadLaneToolContext(
    projectPath,
    sessionName,
    executionId,
    contextId,
  );
  if (!result.ok) {
    return { ok: false, response: jsonError(result.error, result.status) };
  }

  const context = result.context;
  const haltReason = await resolveLaneHaltReason(
    context.getPendingHaltReason ?? (async () => null),
    context.getPendingToolBlock,
  );
  if (haltReason !== null) {
    log.info("graph-workflow-lane.halted", { contextId, reason: haltReason });
    // The halt path has no post-mutation execution to read; the loader snapshot
    // (`reminderState`) supplies the same iteration/threshold pair the engine
    // compares, so a near-budget halt surfaces iteration-budget alongside
    // halted-stop (doc 04 §6.4).
    const { reminders, ruleIds } = evaluateLaneReminders({
      verb,
      halted: haltReason,
      iterationCount: result.reminderState.iterationCount,
      circuitBreakerThreshold: result.reminderState.circuitBreakerThreshold,
      remainingTaskCount: result.reminderState.remainingTaskCount,
      contextLimitStopped: false,
      allowAgentCollaboration: context.allowAgentCollaboration,
    });
    if (reminders.length > 0) {
      log.info("graph-workflow-lane.reminders_emitted", {
        contextId,
        verb,
        ruleIds,
      });
    }
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: haltReason,
          halt: true,
          reason: haltReason,
          ...(reminders.length > 0 ? { reminders } : {}),
        },
        { status: 409 },
      ),
    };
  }

  return { ok: true, context };
}

export function createLaneRouteHandlers(deps: LaneRouteDeps) {
  async function completeTask(
    request: Request,
    { params }: { params: Promise<Record<string, string>> },
  ): Promise<Response> {
    const denied = await deps.auth.requireToken(request);
    if (denied) return denied;

    const { name, session, contextId, taskId } = await params;
    const parsed = completeBodySchema.safeParse(await readJsonBody(request));
    if (!parsed.success) return invalidBody(parsed.error);

    const prepared = await prepareContext(
      deps,
      "task-complete",
      name ?? "",
      session ?? "",
      parsed.data.executionId,
      contextId ?? "",
    );
    if (!prepared.ok) return prepared.response;

    try {
      const { execution, contextLimitStop } =
        await prepared.context.completeTask(taskId ?? "", parsed.data.summary);
      const cid = contextId ?? "";
      const state = execution.contextStates[cid];
      const remainingTaskCount = state
        ? Math.max(0, state.totalTaskCount - state.completedTaskCount)
        : 0;

      const body: {
        ok: true;
        remainingTaskCount: number;
        stopInstruction?: string;
        reminders?: string[];
      } = { ok: true, remainingTaskCount };
      if (contextLimitStop) {
        body.stopInstruction =
          buildContextLimitStopInstruction(contextLimitStop);
      }

      // Reminders derive from the freshest post-completion state — the same
      // iteration/threshold pair the circuit-breaker gate compares
      // (execution-loop.ts). Attach only when a rule fires (doc 04 §6.4).
      const contextDef = execution.workingDefinition.executionContexts.find(
        (definition) => definition.id === cid,
      );
      const { reminders, ruleIds } = evaluateLaneReminders({
        verb: "task-complete",
        halted: null,
        iterationCount: state?.iterationCount ?? 0,
        circuitBreakerThreshold:
          contextDef?.circuitBreaker.consecutiveFailureThreshold ??
          DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD,
        remainingTaskCount,
        contextLimitStopped: contextLimitStop !== null,
        allowAgentCollaboration: prepared.context.allowAgentCollaboration,
      });
      if (reminders.length > 0) {
        body.reminders = reminders;
        log.info("graph-workflow-lane.reminders_emitted", {
          contextId,
          verb: "task-complete",
          ruleIds,
        });
      }

      log.info("graph-workflow-lane.task_completed", {
        contextId,
        taskId,
        remainingTaskCount,
        stopped: contextLimitStop !== null,
      });
      return NextResponse.json(body);
    } catch (error) {
      return jsonError(
        error instanceof Error ? error.message : "Task completion failed",
        409,
      );
    }
  }

  async function addTask(
    request: Request,
    { params }: { params: Promise<Record<string, string>> },
  ): Promise<Response> {
    const denied = await deps.auth.requireToken(request);
    if (denied) return denied;

    const { name, session, contextId } = await params;
    const parsed = addBodySchema.safeParse(await readJsonBody(request));
    if (!parsed.success) return invalidBody(parsed.error);

    const prepared = await prepareContext(
      deps,
      "task-add",
      name ?? "",
      session ?? "",
      parsed.data.executionId,
      contextId ?? "",
    );
    if (!prepared.ok) return prepared.response;

    if (!prepared.context.allowAgentTaskAdd) {
      return jsonError(ADD_TASK_DISABLED_MESSAGE, 403);
    }

    const task: AgentAddedTask = {
      title: parsed.data.title,
      instructions: parsed.data.instructions,
      ...(parsed.data.slug !== undefined ? { slug: parsed.data.slug } : {}),
    };

    try {
      await prepared.context.addTask(task);
      log.info("graph-workflow-lane.task_added", {
        contextId,
        title: parsed.data.title,
      });
      return NextResponse.json({ ok: true });
    } catch (error) {
      return jsonError(
        error instanceof Error ? error.message : "Add task failed",
        409,
      );
    }
  }

  async function upsertSharedDocument(
    request: Request,
    { params }: { params: Promise<Record<string, string | string[]>> },
  ): Promise<Response> {
    const denied = await deps.auth.requireToken(request);
    if (denied) return denied;

    const resolvedParams = await params;
    const name = (resolvedParams.name as string | undefined) ?? "";
    const session = (resolvedParams.session as string | undefined) ?? "";
    const docPathParam = resolvedParams.docPath;
    const relativePath = Array.isArray(docPathParam)
      ? docPathParam.map((seg) => decodeURIComponent(seg)).join("/")
      : (docPathParam ?? "");
    if (relativePath === "") {
      return jsonError("Shared document path is required", 400);
    }

    const parsed = sharedDocBodySchema.safeParse(await readJsonBody(request));
    if (!parsed.success) return invalidBody(parsed.error);

    const prepared = await prepareContext(
      deps,
      "shared-doc-upsert",
      name,
      session,
      parsed.data.executionId,
      parsed.data.contextId,
    );
    if (!prepared.ok) return prepared.response;

    try {
      await prepared.context.upsertSharedDocument({
        relativePath,
        description: parsed.data.description,
        readWhen: parsed.data.readWhen,
      });
      log.info("graph-workflow-lane.shared_document_upserted", {
        relativePath,
      });
      return NextResponse.json({ ok: true });
    } catch (error) {
      return jsonError(
        error instanceof Error
          ? error.message
          : "Shared document upsert failed",
        409,
      );
    }
  }

  async function requestCollaboration(
    request: Request,
    { params }: { params: Promise<Record<string, string>> },
  ): Promise<Response> {
    const denied = await deps.auth.requireToken(request);
    if (denied) return denied;

    const { name, session, contextId } = await params;
    const parsed = collaborationBodySchema.safeParse(
      await readJsonBody(request),
    );
    if (!parsed.success) return invalidBody(parsed.error);

    const prepared = await prepareContext(
      deps,
      "collab-request",
      name ?? "",
      session ?? "",
      parsed.data.executionId,
      contextId ?? "",
    );
    if (!prepared.ok) return prepared.response;

    const context = prepared.context;
    if (!context.allowAgentCollaboration || !context.collaboration) {
      return jsonError(COLLABORATION_DISABLED_MESSAGE, 403);
    }

    const collaboration = context.collaboration;
    const handler = createRequestCollaborationHandler({
      executionContextTitle: context.executionContextTitle,
      parentImplementerTurnId: collaboration.parentImplementerTurnId,
      executionContextId: collaboration.executionContextId,
      conversationId: collaboration.conversationId,
      executionId: collaboration.executionId,
      iterationIndex: collaboration.iterationIndex,
      resolveCollaborationConfig: collaboration.resolveCollaborationConfig,
      triggerWorkflowCollaboration: collaboration.triggerWorkflowCollaboration,
      setPendingHaltReason: collaboration.setPendingHaltReason,
    });

    const result = await handler({ brief: parsed.data.brief });
    const text = result.content[0]?.text ?? "";
    if ("isError" in result && result.isError) {
      return jsonError(text || "Collaboration request failed", 409);
    }

    let workflowId: string | undefined;
    try {
      const parsedStart = collaborationStartedSchema.safeParse(
        JSON.parse(text),
      );
      if (parsedStart.success) workflowId = parsedStart.data.workflowId;
    } catch {
      workflowId = undefined;
    }

    log.info("graph-workflow-lane.collaboration_requested", {
      contextId,
      ...(workflowId !== undefined ? { workflowId } : {}),
    });
    return NextResponse.json({
      ok: true,
      status: "started",
      ...(workflowId !== undefined ? { workflowId } : {}),
    });
  }

  return {
    completeTask,
    addTask,
    upsertSharedDocument,
    requestCollaboration,
  };
}

const defaultDeps: LaneRouteDeps = {
  auth: createAgentAuth(),
  resolveProjectPath,
  loadLaneToolContext: loadGraphWorkflowLaneToolContext,
};

const defaultHandlers = createLaneRouteHandlers(defaultDeps);

/** POST …/graph-workflow/contexts/[contextId]/tasks/[taskId]/complete */
export const COMPLETE_TASK = withTracing(defaultHandlers.completeTask);
/** POST …/graph-workflow/contexts/[contextId]/tasks */
export const ADD_TASK = withTracing(defaultHandlers.addTask);
/** PUT …/graph-workflow/shared-documents/[...docPath] */
export const UPSERT_SHARED_DOCUMENT = withTracing(
  defaultHandlers.upsertSharedDocument,
);
/** POST …/graph-workflow/contexts/[contextId]/collaboration-requests */
export const REQUEST_COLLABORATION = withTracing(
  defaultHandlers.requestCollaboration,
);
