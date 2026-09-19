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
import {
  jsonError,
  refuseProjectSentinelSessionParam,
  resolveProjectOr404,
} from "@/lib/shared/route-resolution";
import { z } from "zod";
import { createAgentAuth, type AgentAuth } from "@/lib/agent-gateway/token";
import {
  readLaneIdentity,
  LANE_IDENTITY_HEADER,
  type LaneIdentityReading,
} from "@/lib/agent-gateway/lane-identity";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { createLogger, withTracing } from "@/lib/logging";
import { GraphExecutionContractViolationError } from "./execution-contract-port";
import type { AgentAddedTask } from "@/lib/workflow-graph/runtime-edits";
import {
  loadGraphWorkflowLaneToolContext,
  type LoadLaneToolContextResult,
} from "./lane-tool-context-loader";
import { resolveLaneHaltReason } from "./tool-dispatcher";
import { DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD } from "./constants";
import {
  evaluateLaneReminders,
  type LaneReminderInput,
  type LaneVerb,
} from "./lane-reminders";
import {
  addTaskSchema,
  createRequestCollaborationHandler,
  type GraphWorkflowToolServerContext,
} from "./lane-tool-service";
import {
  classifyExpansionPayloadRefusal,
  createDefaultExpansionService,
  graphExpansionRequestSchema,
  publishExpansionRefusal,
  type ExpansionRefusalNotice,
  type GraphExpansionInput,
  type GraphExpansionOutcome,
} from "./expansion-production";

const log = createLogger("graph-workflow-lane-route");

const ADD_TASK_DISABLED_MESSAGE =
  "This execution context does not allow agent-added tasks (mutability.allowAgentTaskAdd is disabled).";
const COLLABORATION_DISABLED_MESSAGE =
  "This execution context does not allow agent-initiated collaboration requests.";
const EXPANSION_CAPABILITY_MESSAGE =
  "Graph expansion requires a current implementer-lane identity for this execution context.";

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
const expandBodySchema = z.object({
  executionId: executionIdField,
  request: graphExpansionRequestSchema,
});

const collaborationStartedSchema = z.object({
  status: z.literal("started"),
  workflowId: z.string(),
});

export interface LaneRouteDeps {
  auth: AgentAuth;
  /**
   * Read the injected lane identity the request presents (D4 R7). Separate
   * from `auth` because it answers a different question: the bearer token says
   * "a cctl on this machine", this says "the implementer bound to THIS context".
   */
  readLaneIdentity(request: Request): Promise<LaneIdentityReading>;
  expandGraph(input: GraphExpansionInput): Promise<GraphExpansionOutcome>;
  /**
   * Emit the typed refusal event for an expansion the ROUTE refuses before the
   * service is reached (R6.2). The service publishes its own refusals; these are
   * the ones it never sees — an unauthorized lane, and a payload that failed the
   * strict schema (which is how a smuggled remove/update/move/reorder op is
   * refused). Without this the two violations R6.2 names most explicitly would be
   * the only ones missing from the audit stream.
   */
  publishExpansionRefusal(notice: ExpansionRefusalNotice): void;
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

function ownString(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null) return "";
  if (!Object.prototype.hasOwnProperty.call(value, key)) return "";
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : "";
}

/**
 * Recover the (execution, request) pair from an expansion body that has NOT been
 * validated — a refusal event still owes its reader which attempt was refused.
 * Own properties only, and an empty string where the body named nothing: an
 * unparseable payload genuinely has no request id, and inventing one would make
 * the audit stream lie about an idempotency key.
 */
function readExpansionIdentity(body: unknown): {
  executionId: string;
  requestId: string;
} {
  const requestField =
    typeof body === "object" &&
    body !== null &&
    Object.prototype.hasOwnProperty.call(body, "request")
      ? (body as Record<string, unknown>)["request"]
      : undefined;
  return {
    executionId: ownString(body, "executionId"),
    requestId: ownString(requestField, "requestId"),
  };
}

type PreparedContext =
  | {
      ok: true;
      context: GraphWorkflowToolServerContext;
      /** The resolved project path, so a handler needing it skips a second resolve. */
      projectPath: string;
    }
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
  // The lane endpoints resolve the project themselves rather than going through
  // the session resolution seam, so the seam's refusal never runs for them.
  // Without this guard the sentinel reaches the lane tool context loader as a
  // session key — graph workflow execution is session-only, so the refusal names
  // that rather than a project route (R1.2).
  const refusal = refuseProjectSentinelSessionParam(sessionName, projectName);
  if (refusal) return { ok: false, response: refusal };

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
    const laneReminderState: LaneReminderInput = {
      verb,
      halted: haltReason,
      iterationCount: result.reminderState.iterationCount,
      circuitBreakerThreshold: result.reminderState.circuitBreakerThreshold,
      remainingTaskCount: result.reminderState.remainingTaskCount,
      allowAgentCollaboration: context.allowAgentCollaboration,
    };
    const { reminders, ruleIds } = evaluateLaneReminders(laneReminderState);
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
          laneReminderState,
        },
        { status: 409 },
      ),
    };
  }

  return { ok: true, context, projectPath };
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
      const { execution } = await prepared.context.completeTask(
        taskId ?? "",
        parsed.data.summary,
      );
      const cid = contextId ?? "";
      const state = execution.contextStates[cid];
      const remainingTaskCount = state
        ? Math.max(0, state.totalTaskCount - state.completedTaskCount)
        : 0;

      // Reminders derive from the freshest post-completion state — the same
      // iteration/threshold pair the circuit-breaker gate compares
      // (execution-loop.ts). Return the state even when no rule fires so the
      // CLI can evaluate the shared rules against the full completion facts.
      const contextDef = execution.workingDefinition.executionContexts.find(
        (definition) => definition.id === cid,
      );
      const laneReminderState: LaneReminderInput = {
        verb: "task-complete",
        halted: null,
        iterationCount: state?.iterationCount ?? 0,
        circuitBreakerThreshold:
          contextDef?.circuitBreaker.consecutiveFailureThreshold ??
          DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD,
        remainingTaskCount,
        allowAgentCollaboration: prepared.context.allowAgentCollaboration,
      };
      const { reminders, ruleIds } = evaluateLaneReminders(laneReminderState);
      if (reminders.length > 0) {
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
      });
      return NextResponse.json({
        ok: true,
        remainingTaskCount,
        laneReminderState,
      });
    } catch (error) {
      if (error instanceof GraphExecutionContractViolationError) {
        log.warn("graph-workflow-lane.task_completion.contract_rejected", {
          contextId,
          taskId,
          code: error.code,
          issueCount: error.issues.length,
        });
        return NextResponse.json(
          {
            error: error.message,
            code: error.code,
            issues: error.issues,
            instruction: error.instruction,
          },
          { status: 409 },
        );
      }
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

  /**
   * POST …/contexts/[contextId]/expand — runtime graph expansion (D4 R6/R7).
   *
   * The only lane verb with a SECOND credential. The bearer token says a cctl on
   * this machine is calling; the injected identity says which lane, and the
   * service re-checks that claim against the context's current implementer
   * conversation inside the serialized mutation. Both are required.
   *
   * It is also the only lane verb whose refusals are themselves events (R6.2):
   * an unauthorized lane and a payload smuggling a non-additive op are refused
   * here, before the service exists to publish for them, so this handler owns
   * their `graph-workflow-graph-expanded` rows.
   */
  async function expandGraph(
    request: Request,
    { params }: { params: Promise<Record<string, string>> },
  ): Promise<Response> {
    const denied = await deps.auth.requireToken(request);
    if (denied) return denied;

    const { name, session, contextId } = await params;

    // Read the body BEFORE the credential gates: a refusal event is only worth
    // reading if it names which request was refused, and the requestId lives in
    // the payload. The body is untrusted either way — nothing below acts on it
    // until it has passed both the capability check and the strict schema.
    const body = await readJsonBody(request);
    const identity = readExpansionIdentity(body);

    /**
     * Refuse, with the typed event (R6.2). Resolving the project here rather
     * than up front keeps the happy path's ordering — and its 403-before-404
     * disclosure boundary — exactly as it was; a project that will not resolve
     * simply has nowhere to file the event.
     */
    async function refuse(
      refusalCode: string,
      response: Response,
    ): Promise<Response> {
      const projectPath = await deps.resolveProjectPath(name ?? "");
      if (projectPath !== null) {
        deps.publishExpansionRefusal({
          projectPath,
          sessionName: session ?? "",
          executionId: identity.executionId,
          invokerContextId: contextId ?? "",
          requestId: identity.requestId,
          refusalCode,
        });
      }
      return response;
    }

    const capability = await deps.readLaneIdentity(request);
    if (capability.kind !== "valid") {
      log.warn("graph-workflow-lane.expansion_capability_rejected", {
        contextId,
        reason:
          capability.kind === "absent"
            ? "absent"
            : `invalid:${capability.reason}`,
      });
      return refuse(
        capability.kind === "absent"
          ? "expansion-capability-absent"
          : "expansion-capability-invalid",
        jsonError(EXPANSION_CAPABILITY_MESSAGE, 403),
      );
    }

    const parsed = expandBodySchema.safeParse(body);
    if (!parsed.success) {
      return refuse(
        classifyExpansionPayloadRefusal(body),
        invalidBody(parsed.error),
      );
    }

    // The capability is scoped to one execution context, so a lane cannot
    // present a valid credential and then act on a different one.
    if (
      capability.scope.executionId !== parsed.data.executionId ||
      capability.scope.contextId !== (contextId ?? "")
    ) {
      log.warn("graph-workflow-lane.expansion_capability_out_of_scope", {
        contextId,
        scopedContextId: capability.scope.contextId,
      });
      return refuse(
        "expansion-capability-out-of-scope",
        jsonError(EXPANSION_CAPABILITY_MESSAGE, 403),
      );
    }

    // The shared preamble: stale-lane guard, context existence, and the
    // pre-dispatch halt check a halted run must not expand through.
    const prepared = await prepareContext(
      deps,
      "task-add",
      name ?? "",
      session ?? "",
      parsed.data.executionId,
      contextId ?? "",
    );
    if (!prepared.ok) return prepared.response;

    const outcome = await deps.expandGraph({
      projectPath: prepared.projectPath,
      sessionName: session ?? "",
      executionId: parsed.data.executionId,
      contextId: contextId ?? "",
      conversationId: capability.scope.conversationId,
      request: parsed.data.request,
    });

    if (!outcome.ok) {
      // Not a 404: the preamble above already proved this execution and context
      // exist. Reaching here means the active execution changed out from under
      // the request between the two reads, which is a conflict — the same way
      // the sibling lane verbs surface a mid-request state change.
      if (outcome.kind === "no_active_execution") {
        return jsonError(
          "The active graph workflow execution changed while the expansion was in flight; re-read the live outline and retry",
          409,
        );
      }
      return NextResponse.json(
        {
          error: outcome.issues[0]?.message ?? "graph expansion was refused",
          code: outcome.issues[0]?.code ?? "expansion-refused",
          issues: outcome.issues,
        },
        { status: outcome.kind === "forbidden" ? 403 : 409 },
      );
    }

    log.info("graph-workflow-lane.graph_expanded", {
      contextId,
      requestId: parsed.data.request.requestId,
      replayed: outcome.replayed,
      addedContextCount: outcome.createdContextIds.length,
      addedTaskCount: outcome.createdTaskIds.length,
    });
    return NextResponse.json({
      ok: true,
      // A replay answered from the permanent acceptance receipt: the ids below
      // are already in the graph. Surfaced so a lane retrying after a lost
      // response is not told it just added them again (R6.3).
      replayed: outcome.replayed,
      liveRevision: outcome.liveRevision,
      createdContextIds: outcome.createdContextIds,
      createdTaskIds: outcome.createdTaskIds,
      rejoinContextIds: outcome.rejoinContextIds,
    });
  }

  return {
    completeTask,
    addTask,
    upsertSharedDocument,
    requestCollaboration,
    expandGraph,
  };
}

const defaultDeps: LaneRouteDeps = {
  auth: createAgentAuth(),
  readLaneIdentity: async (request) =>
    readLaneIdentity(request.headers.get(LANE_IDENTITY_HEADER)),
  expandGraph: (input) => createDefaultExpansionService().expand(input),
  publishExpansionRefusal,
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
/** POST …/graph-workflow/contexts/[contextId]/expand */
export const EXPAND_GRAPH = withTracing(defaultHandlers.expandGraph);
