import {
  respondToAbandonRefusal,
  respondToDefinitionApprovalRefusal,
  respondToDefinitionRejectionRefusal,
} from "./lifecycle-http";
import type { LifecycleLaunchAcceptance } from "./lifecycle-outcomes";
import { requireLifecycleValue } from "./lifecycle-outcomes";
import { createProductionGraphWorkflowLifecycleDeps } from "./production";

import { observeExecutionMutation } from "./mutation-guard";
import {
  respondToManagerError,
  respondToLaunchRefusal,
} from "./lifecycle-http";
import {
  createGraphWorkflowLifecycleService,
  type GraphWorkflowLifecycleDeps,
} from "./lifecycle-service";
import { getGraphWorkflowRuntime } from "./production";
import { NextResponse } from "next/server";
import {
  notFound,
  resolveProjectSessionOr404,
} from "@/lib/shared/route-resolution";
import { z } from "zod";
import { readConfig } from "@/lib/config/loader";
import {
  resetExecutionContextAssignmentRequestSchema,
  resetExecutionContextRequestSchema,
} from "@/lib/workflow-graph/schemas";
import { createLogger, withTracing } from "@/lib/logging";
import { holdsExecutionLease } from "@/lib/workflow-graph/lifecycle-classifier";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import {
  getSession as defaultGetSession,
  listArchivedGraphWorkflowExecutions,
  getGraphWorkflowEventsPage,
  getGraphWorkflowEventsTail,
  getGraphWorkflowExecutionById as defaultGetGraphWorkflowExecutionById,
  getGraphWorkflowBoundaryResultAfter as defaultGetGraphWorkflowBoundaryResultAfter,
} from "@/lib/state-store";
import type { ApiError } from "@/lib/api/errors";
import type { SessionState } from "@/lib/sessions/schemas";
import type {
  GraphWorkflowCleanupStatusValue,
  GraphWorkflowExecutionEvent,
  GraphWorkflowMergeStatusValue,
} from "@/lib/workflow-graph/event-schemas";
import type {
  GraphWorkflowEventPage,
  GraphWorkflowEventPageQuery,
} from "@/lib/state-store/graph-workflow-events-repo";
import type {
  GraphWorkflowAbandonment,
  GraphWorkflowExecutionActReceipt,
  GraphWorkflowExecution,
  GraphWorkflowExecutionJoinKind,
  GraphWorkflowExecutionJoinStatus,
  GraphWorkflowHaltReason,
  GraphWorkflowLaunchReceipt,
} from "@/lib/workflow-graph/schemas";

import type { GraphWorkflowStatus } from "@/lib/workflow-graph/definition-schemas";

import {
  createAgentAuth,
  type OptionalTokenValidation,
} from "@/lib/agent-gateway/token";
import type { ConversationCapabilityVerification } from "@/lib/agent-gateway/conversation-capability";
import type { LaneCapabilityVerification } from "@/lib/agent-gateway/lane-capability";
import { authorizeWorkflowLaunch } from "./request-principal";
import {
  classifyRoutePrincipal,
  guardExecutionMutation,
  guardHumanOnlyAct,
  invalidTokenResponse,
  runPinnedMutation,
} from "./mutation-guard";

import { type GraphWorkflowResumeOptions } from "@/lib/workflow-graph/workflow-manager";

import type { WorkflowPlanIssue } from "@/lib/workflows/plan-validation";
import { readRepoConfig as defaultReadRepoConfig } from "@/lib/projects/repo-config";
import { buildGraphWorkflowExecutionDeepLink } from "./execution-deep-link";
import type { GraphWorkflowBoundaryResultProjection } from "./execution-result-projection";

import type { GlobalConfig, PerRepoConfig } from "@/lib/config/schemas";
import { conflictDecisionInputSchema } from "@/lib/jobs/schemas";

import {
  type ApprovalGateDecisionInput,
  type RecordDecisionGuardFailureReason,
  type RecordDecisionInput,
  type RecordDecisionResult,
} from "./approval-gate";
import {
  resolveApprovalSnapshot,
  type ApprovalSnapshotResolution,
  type ResolveApprovalSnapshotInput,
} from "./approval-snapshot";

import { admitAuthoredWorkflowLaunch } from "./authored-launch-admission";

type RouteContext = {
  params: Promise<Record<string, string>>;
};

const startExecutionSchema = z.object({
  definitionId: z.string().trim().min(1),
  definitionRevision: z.number().int().positive().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  // Additive tier discriminator (the schema is not `.strict()`, so this
  // preserves every existing caller). Defaults to `project` — the per-project
  // load — so an omitted tier behaves exactly as today.
  tier: z.enum(["project", "global"]).default("project"),
});

/**
 * The inline launch body (D7 R1, decision D1): the plan document in the exact
 * dialect `workflow validate`/`create` accept, plus a SEPARATE inputs document.
 *
 * `plan` stays `unknown` here on purpose — `validateWorkflowPlan` owns the
 * accept-time parse, and a second Zod shape at this boundary would be a second
 * place for the dialect to drift. This schema only proves the two documents
 * arrived in their own channels, which is what keeps `run --file` and
 * `start --file` from meaning two different things.
 */
const runExecutionSchema = z.object({
  plan: z.unknown().refine((value) => value !== undefined, {
    message: "plan is required",
  }),
  inputs: z.record(z.string(), z.unknown()).optional(),
});

const resolveApprovalSchema = z.discriminatedUnion("decision", [
  z.object({
    contextId: z.string().trim().min(1),
    decision: z.literal("approve"),
  }),
  z.object({
    contextId: z.string().trim().min(1),
    decision: z.literal("reject"),
    message: z.string().trim().min(1),
  }),
]);

// Resume accepts an optional body: per-file operator guidance for the next
// conflict-resolution attempt of any failed join being retried. An absent or
// empty body resumes without guidance (every pre-existing caller).
const resumeRequestSchema = z.object({
  conflictGuidance: z.array(conflictDecisionInputSchema).optional(),
});

const logger = createLogger("graph-workflow-route-handlers");

const GRAPH_WORKFLOW_EVENTS_DEFAULT_LIMIT = 500;
const GRAPH_WORKFLOW_EVENTS_MAX_LIMIT = 2000;

interface GraphWorkflowExecutionContextMergeProgress {
  contextId: string;
  branchName: string | null;
  mergeStatus: GraphWorkflowMergeStatusValue;
  cleanupStatus: GraphWorkflowCleanupStatusValue;
  lastMergeError: string | null;
}

interface GraphWorkflowExecutionJoinProgress {
  joinId: string;
  kind: GraphWorkflowExecutionJoinKind;
  contextId: string | null;
  targetLaneId: string;
  sourceLaneIds: string[];
  mergedSourceLaneIds: string[];
  status: GraphWorkflowExecutionJoinStatus;
}

interface GraphWorkflowExecutionFinalPublishProgress {
  joinId: string;
  targetLaneId: string;
  sourceLaneIds: string[];
  mergedSourceLaneIds: string[];
  status: GraphWorkflowExecutionJoinStatus;
}

export interface GraphWorkflowExecutionSummary {
  executionId: string;
  definitionId: string;
  definitionRevision: number;
  status: GraphWorkflowStatus;
  startedAt: string;
  completedAt: string | null;
  activeContextIds: string[];
  activeContextTitles: string[];
  activeBatchIds: string[];
  activeJoinIds: string[];
  haltReason: GraphWorkflowHaltReason | null;
  pendingHaltReason: GraphWorkflowHaltReason | null;
  contextMergeProgress: GraphWorkflowExecutionContextMergeProgress[];
  joinProgress: GraphWorkflowExecutionJoinProgress[];
  finalPublishState: GraphWorkflowExecutionFinalPublishProgress | null;
  archived: boolean;
}

export interface GraphWorkflowExecutionRouteDeps extends GraphWorkflowLifecycleDeps {
  resolveProjectPath(name: string): Promise<string | null>;

  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;

  /**
   * `CommandCenter.json` and the global config, read per RUN request so the
   * inline plan is preflighted against the command registry and capacity the
   * launch will actually use — the same reads `workflow validate` and
   * `workflow create` perform. Optional so a test can drive RUN without a
   * project on disk.
   */
  readRepoConfig?(projectPath: string): Promise<PerRepoConfig | null>;

  readConfig?(): Promise<GlobalConfig>;

  /**
   * Classifies the signed conversation capability a launch presents (D11), from
   * which the origin principal is derived. Defaults to the registered verifier,
   * keyed on the server-only capability key.
   */
  verifyConversationCapability?(
    request: Request,
  ): Promise<ConversationCapabilityVerification>;

  /**
   * Classifies the signed lane capability a caller presents (D4 R7). A lane may
   * act on its OWN execution and is refused as nesting when it tries to launch,
   * so the mutation guard has to be able to tell a lane from an ordinary
   * conversation. Defaults to the registered verifier, keyed on the same
   * server-only capability key.
   */
  verifyLaneCapability?(request: Request): Promise<LaneCapabilityVerification>;

  /** Find a named execution in Current first, then History, under full scope. */
  getExecutionById?(
    projectPath: string,
    sessionName: string,
    executionId: string,
  ): Promise<GraphWorkflowExecution | null>;

  /** Return the first durable boundary result after an opaque event cursor. */
  getBoundaryResultAfter?(
    projectPath: string,
    sessionName: string,
    executionId: string,
    cursor?: number | null,
  ): Promise<GraphWorkflowBoundaryResultProjection | null>;

  recordApprovalDecision(
    input: RecordDecisionInput,
  ): Promise<RecordDecisionResult>;

  /**
   * The change set the human approval surface renders for one parked context.
   * Optional so a test can exercise the route without git; defaults to the real
   * scoped reader.
   */
  resolveApprovalSnapshot?(
    input: ResolveApprovalSnapshotInput,
  ): Promise<ApprovalSnapshotResolution>;

  /**
   * Transport identity for the definition-approval gate. Approving and
   * rejecting a definition are human review acts: requests bearing a valid
   * agent token are refused with `human_act_required`. Defaults to the shared
   * agent-gateway auth.
   */
  auth?: {
    validateOptionalToken(request: Request): Promise<OptionalTokenValidation>;
  };

  /**
   * Read the bounded tail of the persisted append-only event log for an
   * execution. Defaults to the real `graph_workflow_events` repo via the store.
   */
  getEventsTail?(
    projectPath: string,
    sessionName: string,
    executionId: string,
    limit: number,
  ): Promise<GraphWorkflowExecutionEvent[]>;

  /**
   * Read one cursor-paginated page of an execution's event log — the reader the
   * loop-ledger surfaces walk for COMPLETE history, which the bounded tail
   * cannot serve. Defaults to the real `graph_workflow_events` repo.
   */
  getEventsPage?(
    projectPath: string,
    sessionName: string,
    executionId: string,
    query: GraphWorkflowEventPageQuery,
  ): Promise<GraphWorkflowEventPage>;
}

const defaultDeps: GraphWorkflowExecutionRouteDeps = {
  ...createProductionGraphWorkflowLifecycleDeps(),
  resolveProjectPath: defaultResolveProjectPath,
  getSession: defaultGetSession,
  readRepoConfig: defaultReadRepoConfig,
  readConfig,
  getExecutionById: (projectPath, sessionName, executionId) =>
    defaultGetGraphWorkflowExecutionById(projectPath, sessionName, executionId),
  getBoundaryResultAfter: (projectPath, sessionName, executionId, cursor) =>
    defaultGetGraphWorkflowBoundaryResultAfter(
      projectPath,
      sessionName,
      executionId,
      cursor,
    ),
  recordApprovalDecision: (input) =>
    getGraphWorkflowRuntime().approvalGateService.recordDecision(input),
  resolveApprovalSnapshot: (input) => resolveApprovalSnapshot(input),
  auth: createAgentAuth(),
  getEventsTail: (projectPath, sessionName, executionId, limit) =>
    getGraphWorkflowEventsTail(projectPath, sessionName, executionId, limit),
  getEventsPage: (projectPath, sessionName, executionId, query) =>
    getGraphWorkflowEventsPage(projectPath, sessionName, executionId, query),
};

/**
 * Header the token-gated CLI/agent surfaces use to name the calling
 * conversation (`cctl` sends it from `CC_CONVERSATION_ID`).
 *
 * It carries NO authority and nothing here reads it. Ownership and every
 * mutation principal are derived from a signed capability instead
 * (`request-principal.ts`), because confirming a claimed id belongs to the
 * session only proves the conversation exists — every sibling passes that
 * check. The constant remains because agent transports still send the header
 * as context; treating it as identity again is the regression to avoid.
 */
export const OWNER_CONVERSATION_HEADER = "x-cc-conversation-id";

/** `live abort`'s optional body: the reason is carried onto the release audit row. */
const abortExecutionSchema = z.object({
  reason: z.string().trim().min(1).optional(),
  actor: z.string().min(1).nullable().optional(),
});

/**
 * `workflow abandon`'s body. Strict and execution-addressed: an act that named
 * a definition could not express a one-off run, which has no saved definition
 * identity at all, and would let a caller abandon "whatever this template is
 * running" instead of the run they read.
 */
const abandonExecutionSchema = z
  .object({
    executionId: z.string().trim().min(1),
    reason: z.string().trim().min(1),
  })
  .strict();

/**
 * The body BOTH definition decisions carry (D7 decision D17). Strict and
 * execution-addressed: a one-off park has no saved-definition identity to
 * co-guard with, and a template park's definition identity is already pinned by
 * the immutable snapshot the execution holds — so a definition id in either act
 * would be a second, origin-conditional meaning for the same decision.
 */
const definitionDecisionIdentitySchema = z
  .object({ executionId: z.string().trim().min(1) })
  .strict();

/**
 * Project an accepted launch into the wire receipt (D7 R1.2).
 *
 * Both launch verbs answer with this one shape, and it is built from the
 * execution's recorded origin rather than from the seed projection — which on a
 * one-off run names a definition that does not exist.
 */
function buildLaunchReceipt(input: {
  outcome: LifecycleLaunchAcceptance;
  projectName: string;
  sessionName: string;
  warnings?: readonly WorkflowPlanIssue[];
}): GraphWorkflowLaunchReceipt {
  const { execution } = input.outcome;
  const warnings = input.warnings ?? input.outcome.warnings ?? [];
  return {
    executionId: execution.id,
    status:
      input.outcome.disposition === "awaiting_definition_approval"
        ? "awaiting_definition_approval"
        : "running",
    origin: execution.origin,
    originConversationId: execution.ownerConversationId,
    deepLink: buildGraphWorkflowExecutionDeepLink({
      projectName: input.projectName,
      sessionName: input.sessionName,
      executionId: execution.id,
    }),
    startedAt: execution.startedAt,
    ...(warnings.length === 0 ? {} : { warnings: [...warnings] }),
  };
}

/**
 * Project the outcome of an execution-addressed lifecycle act into its wire
 * receipt (D7 R4.1, R14.2).
 *
 * Abandon, approve, and reject answer with this one shape rather than the
 * execution summary, which carries the definition tier the summary's History
 * and status callers need — and which on a one-off run is compatibility filler
 * naming a definition that does not exist.
 */
function buildExecutionActReceipt(
  execution: GraphWorkflowExecution,
  archived: boolean,
): GraphWorkflowExecutionActReceipt {
  return {
    executionId: execution.id,
    status: execution.status,
    origin: execution.origin,
    archived,
  };
}

function summarizeExecution(
  execution: GraphWorkflowExecution,
  archived: boolean,
): GraphWorkflowExecutionSummary {
  const activeContextIds = [...execution.activeContextIds];
  const activeContextTitles = activeContextIds.map((contextId) => {
    const context = execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === contextId,
    );
    return context?.title ?? contextId;
  });

  const seenBatches = new Set<string>();
  const activeBatchIds: string[] = [];
  for (const contextId of activeContextIds) {
    const batchId = execution.contextStates[contextId]?.batchId;
    if (batchId && !seenBatches.has(batchId)) {
      seenBatches.add(batchId);
      activeBatchIds.push(batchId);
    }
  }

  const seenContexts = new Set<string>();
  const orderedContextIds: string[] = [];
  for (const id of activeContextIds) {
    if (!seenContexts.has(id)) {
      seenContexts.add(id);
      orderedContextIds.push(id);
    }
  }
  for (const context of execution.workingDefinition.executionContexts) {
    if (!seenContexts.has(context.id)) {
      seenContexts.add(context.id);
      orderedContextIds.push(context.id);
    }
  }

  const contextMergeProgress: GraphWorkflowExecutionContextMergeProgress[] = [];
  for (const contextId of orderedContextIds) {
    const state = execution.contextStates[contextId];
    if (!state) continue;
    if (
      state.mergeStatus === "not-applicable" &&
      state.cleanupStatus === "not-applicable" &&
      state.lastMergeError === null
    ) {
      continue;
    }
    contextMergeProgress.push({
      contextId,
      branchName: state.branchName,
      mergeStatus: state.mergeStatus,
      cleanupStatus: state.cleanupStatus,
      lastMergeError: state.lastMergeError,
    });
  }

  const joinValues = Object.values(execution.joins ?? {});
  const activeJoins = joinValues.filter(
    (join) => join.status === "pending" || join.status === "running",
  );
  activeJoins.sort((a, b) => a.joinId.localeCompare(b.joinId));
  const activeJoinIds = activeJoins.map((join) => join.joinId);
  const joinProgress: GraphWorkflowExecutionJoinProgress[] = activeJoins.map(
    (join) => ({
      joinId: join.joinId,
      kind: join.kind,
      contextId: join.contextId,
      targetLaneId: join.targetLaneId,
      sourceLaneIds: [...join.sourceLaneIds],
      mergedSourceLaneIds: [...join.mergedSourceLaneIds],
      status: join.status,
    }),
  );
  const finalPublishJoin = activeJoins.find(
    (join) => join.kind === "final_publish",
  );
  const finalPublishState: GraphWorkflowExecutionFinalPublishProgress | null =
    finalPublishJoin
      ? {
          joinId: finalPublishJoin.joinId,
          targetLaneId: finalPublishJoin.targetLaneId,
          sourceLaneIds: [...finalPublishJoin.sourceLaneIds],
          mergedSourceLaneIds: [...finalPublishJoin.mergedSourceLaneIds],
          status: finalPublishJoin.status,
        }
      : null;

  return {
    executionId: execution.id,
    definitionId: execution.seedDefinitionId,
    definitionRevision: execution.seedDefinitionRevision,
    status: execution.status,
    startedAt: execution.startedAt,
    completedAt: execution.completedAt,
    activeContextIds,
    activeContextTitles,
    activeBatchIds,
    activeJoinIds,
    haltReason: execution.haltReason,
    pendingHaltReason: execution.pendingHaltReason,
    contextMergeProgress,
    joinProgress,
    finalPublishState,
    archived,
  };
}

async function summarizeHistory(
  deps: GraphWorkflowExecutionRouteDeps,
  projectPath: string,
  sessionName: string,
): Promise<GraphWorkflowExecutionSummary[]> {
  const listArchived =
    deps.listArchivedExecutions ?? listArchivedGraphWorkflowExecutions;
  const archived = await listArchived(projectPath, sessionName);
  const items = archived.map((execution) =>
    summarizeExecution(execution, true),
  );

  // History is a LEASE projection, not a storage location (D7 decision D4): a
  // lease-free run still sitting in the active row belongs here — normalization
  // has not yet relocated it, and R3.3 requires no explicit act to make it
  // historical. A terminal-but-resumable halt is deliberately excluded: it is
  // still Current until it is resumed or abandoned.
  const active = await deps.getActiveExecution(projectPath, sessionName);
  if (
    active &&
    !holdsExecutionLease(active.status, active.haltReason, active.abandonment)
  ) {
    items.push(summarizeExecution(active, false));
  }

  return items;
}

type ResolveSessionResult =
  | { error: Response }
  | {
      projectName: string;
      projectPath: string;
      sessionName: string;
      session: SessionState;
    };

async function resolveSession(
  context: RouteContext,
  deps: GraphWorkflowExecutionRouteDeps,
): Promise<ResolveSessionResult> {
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
    projectName,
    projectPath: resolved.value.projectPath,
    sessionName,
    session: resolved.value.session,
  };
}

function resolveApprovalConflictMessage(
  reason: Exclude<RecordDecisionGuardFailureReason, "no_active_execution">,
  contextId: string,
): string {
  switch (reason) {
    case "not_awaiting_approval":
      return `Context "${contextId}" is not awaiting approval (not_awaiting_approval)`;
    case "already_decided":
      return `Context "${contextId}" already has a recorded approval decision (already_decided)`;
    case "execution_not_running":
      return "The graph workflow execution no longer accepts approval decisions (execution_not_running)";
  }
}

export function createGraphWorkflowExecutionRouteHandlers(
  deps: GraphWorkflowExecutionRouteDeps = defaultDeps,
) {
  const lifecycle = createGraphWorkflowLifecycleService(deps);
  const {
    launchSavedRunning: launch,
    launchSpecDelivery,
    findPendingDefinitionApproval,
    approveDefinition,
  } = lifecycle;

  /**
   * Launch authority for RUN and START (R9.4/R10.1).
   *
   * Two refusals a per-execution guard cannot express live here. A verified
   * LANE is refused as NESTING — a run must not launch a run, and that holds
   * even when the session's lease is free, so it is not a lease conflict and
   * must not be reported as one. An agent that proves nothing is refused
   * outright. The human UI launches unowned, which is what keeps a browser
   * launch working with no credentials at all.
   */
  async function resolveLaunchPrincipal(input: {
    request: Request;
    resolved: {
      session: SessionState;
      projectPath: string;
      sessionName: string;
    };
    verb: string;
  }): Promise<{ refusal: Response } | { ownerConversationId: string | null }> {
    const classified = await classifyRoutePrincipal(
      input.request,
      input.resolved.session,
      deps,
    );
    if (classified.kind === "invalid_token") {
      return { refusal: invalidTokenResponse() };
    }
    if (classified.kind === "unverified") {
      logger.warn("graph-workflow.run.unverified_principal_refused", {
        projectPath: input.resolved.projectPath,
        sessionName: input.resolved.sessionName,
        reason: classified.reason,
      });
      return {
        refusal: NextResponse.json(
          {
            error:
              "This agent cannot launch a workflow: it presented no verified conversation capability.",
            code: "unverified_principal",
            instruction:
              "Run `cctl workflow run` from an ordinary session conversation. Workflow lanes, the planner, and collaboration runtimes are not minted a capability and cannot launch runs.",
          } satisfies ApiError & { code: string; instruction: string },
          { status: 403 },
        ),
      };
    }

    const { principal } = classified;
    const authorization = authorizeWorkflowLaunch(principal);
    if (authorization.kind === "refused") {
      logger.warn("graph-workflow.run.nesting_refused", {
        projectPath: input.resolved.projectPath,
        sessionName: input.resolved.sessionName,
        ...(principal.kind === "lane"
          ? { laneExecutionId: principal.executionId }
          : {}),
      });
      return {
        refusal: NextResponse.json(
          {
            error:
              "A workflow lane cannot launch a workflow: runs do not nest inside runs.",
            code: "workflow_nesting_refused",
            instruction:
              "Ask the conversation that launched this run to start the next one, or launch it from the Command Center UI.",
          } satisfies ApiError & { code: string; instruction: string },
          { status: 403 },
        ),
      };
    }

    return {
      ownerConversationId:
        principal.kind === "conversation" ? principal.conversationId : null,
    };
  }

  async function START(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }

    const { projectPath, sessionName } = resolved;

    const parsed = startExecutionSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid request: definitionId is required",
        } satisfies ApiError,
        { status: 400 },
      );
    }

    // Owner identity is DERIVED, never read off a header or payload: a caller
    // header naming a conversation is a claim every sibling conversation and
    // every lane can also make, so START answers it with the same signed
    // principal RUN does (R9.4). A lane is refused here as nesting.
    const launchPrincipal = await resolveLaunchPrincipal({
      request,
      resolved,
      verb: "start",
    });
    if ("refusal" in launchPrincipal) return launchPrincipal.refusal;
    const ownerConversationId = launchPrincipal.ownerConversationId;

    let outcome: LifecycleLaunchAcceptance;
    try {
      // The active-execution and uncommitted-changes guards plus start-input
      // validation all run inside the shared start path so HTTP and MCP enforce
      // an identical pre-seed chain. Guard/input rejections seed nothing, so
      // they map directly to a response without engaging the loop-failure halt
      // path (which only applies to a seeded execution).
      outcome = await requireLifecycleValue(
        lifecycle.launch({
          source: "saved",
          projectName: resolved.projectName,
          command: {
            projectPath,
            sessionName,
            definitionId: parsed.data.definitionId,
            ...(parsed.data.definitionRevision !== undefined
              ? { expectedDefinitionRevision: parsed.data.definitionRevision }
              : {}),
            tier: parsed.data.tier,
            ...(parsed.data.parameters !== undefined
              ? { parameters: parsed.data.parameters }
              : {}),
            ...(ownerConversationId !== null ? { ownerConversationId } : {}),
          },
        }),
      );
    } catch (error) {
      return respondToLaunchRefusal(error, "parameters");
    }

    const receipt = buildLaunchReceipt({
      outcome,
      projectName: resolved.projectName,
      sessionName,
    });
    return NextResponse.json(
      { execution: summarizeExecution(outcome.execution, false), receipt },
      { status: 202 },
    );
  }

  /**
   * POST .../graph-workflow/run — the inline one-off launch (D7 R1, R2, R14).
   *
   * Two things happen here and nowhere else on this path: the submitted plan
   * passes the SAME accept-time gate `workflow validate`/`create` apply
   * (legacy-shape detection, dialect parse, structural + placement +
   * reference checks, command-selector preflight) before any state exists, and
   * the caller's conversation is captured server-side. Everything after that is
   * the shared manager gauntlet — no second engine, no reduced validation, and
   * no definition storage of any kind (R1.1).
   */
  async function RUN(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }
    const { projectPath, sessionName } = resolved;

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Request body must be JSON" } satisfies ApiError,
        { status: 400 },
      );
    }

    const body = runExecutionSchema.safeParse(rawBody);
    if (!body.success) {
      return NextResponse.json(
        {
          error: "Invalid request: plan is required",
        } satisfies ApiError,
        { status: 400 },
      );
    }

    const [repoConfig, globalConfig] = await Promise.all([
      (deps.readRepoConfig ?? defaultReadRepoConfig)(projectPath),
      (deps.readConfig ?? readConfig)(),
    ]);
    const validation = await admitAuthoredWorkflowLaunch(body.data.plan, {
      caller: "project-run",
      documentScope: { kind: "project", projectPath },
      projectValidation: repoConfig?.validation ?? null,
      globalValidation: globalConfig.validation,
      workflowDefaults: globalConfig.workflowDefaults,
      agentBackends: globalConfig.agentBackends,
    });
    if (!validation.ok) {
      logger.info("graph-workflow.run.plan_rejected", {
        projectPath,
        sessionName,
        code: validation.code ?? "invalid_plan",
        issueCount: validation.issues.length,
      });
      return NextResponse.json(
        {
          error: "Workflow plan is invalid",
          ...(validation.code ? { code: validation.code } : {}),
          issues: validation.issues,
        },
        { status: 400 },
      );
    }

    // Launch authority, in the order D11/D12 define it. The origin is a SIGNED
    // principal, not a claim (R9.4/D11), and an AGENT that cannot prove which
    // conversation it is does not launch: admitting it unowned would let a
    // lane, the planner, or a sibling agent consume the session's one lease
    // with no verified authority. No execution is passed — a launch has none
    // yet, so there is no origin to scope against.
    const launchPrincipal = await resolveLaunchPrincipal({
      request,
      resolved,
      verb: "launch",
    });
    if ("refusal" in launchPrincipal) return launchPrincipal.refusal;
    const ownerConversationId = launchPrincipal.ownerConversationId;

    let outcome: LifecycleLaunchAcceptance;
    try {
      outcome = await requireLifecycleValue(
        lifecycle.launch({
          source: "inline",
          projectName: resolved.projectName,
          command: {
            projectPath,
            sessionName,
            plan: validation.launch,
            ...(body.data.inputs !== undefined
              ? { inputs: body.data.inputs }
              : {}),
            ...(ownerConversationId !== null ? { ownerConversationId } : {}),
          },
        }),
      );
    } catch (error) {
      return respondToLaunchRefusal(error, "inputs");
    }

    const receipt = buildLaunchReceipt({
      outcome,
      projectName: resolved.projectName,
      sessionName,
      warnings: [...validation.warnings, ...(outcome.warnings ?? [])],
    });
    logger.info("graph-workflow.run.accepted", {
      projectPath,
      sessionName,
      executionId: receipt.executionId,
      status: receipt.status,
      origin: receipt.origin.kind,
      warningCount: receipt.warnings?.length ?? 0,
    });
    return NextResponse.json({ receipt }, { status: 202 });
  }

  async function STATUS(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }

    const execution = await deps.getActiveExecution(
      resolved.projectPath,
      resolved.sessionName,
    );

    // Current is a LEASE projection here exactly as it is on EXECUTION and
    // History (D7 decision D4). A settled run still physically occupying the
    // active row holds nothing, and reporting it as Current is what made a
    // finished run render as the live one. It is not hidden: `summarizeHistory`
    // is the projection that carries a lease-free active row, so the same row
    // this drops from Current appears in the history list below.
    const current =
      execution &&
      holdsExecutionLease(
        execution.status,
        execution.haltReason,
        execution.abandonment,
      )
        ? execution
        : null;

    return NextResponse.json({
      execution: current ? summarizeExecution(current, false) : null,
      archivedExecutions: await summarizeHistory(
        deps,
        resolved.projectPath,
        resolved.sessionName,
      ),
    });
  }

  async function EXECUTION(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }

    const execution = await deps.getActiveExecution(
      resolved.projectPath,
      resolved.sessionName,
    );

    // Current is a LEASE projection, not a row-position one (D7 decision D4).
    // A settled run awaiting normalization still physically occupies the active
    // row, but it holds nothing — reporting it as Current is what made a
    // finished run render as the live one while History, which already carries
    // it, was told to drop it as a duplicate.
    if (
      execution &&
      !holdsExecutionLease(
        execution.status,
        execution.haltReason,
        execution.abandonment,
      )
    ) {
      return NextResponse.json({ execution: null });
    }

    return NextResponse.json({ execution: execution ?? null });
  }

  async function EXECUTION_BY_ID(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) return resolved.error;

    const executionId = decodeURIComponent(
      (await context.params)["executionId"] ?? "",
    );
    const getExecutionById =
      deps.getExecutionById ?? defaultGetGraphWorkflowExecutionById;
    const execution = await getExecutionById(
      resolved.projectPath,
      resolved.sessionName,
      executionId,
    );
    if (execution === null) {
      logger.info("graph-workflow.execution_by_id.not_found", {
        projectPath: resolved.projectPath,
        sessionName: resolved.sessionName,
        executionId,
      });
      return notFound("Graph workflow execution not found");
    }
    return NextResponse.json({ execution });
  }

  async function EXECUTION_RESULT(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) return resolved.error;

    const executionId = decodeURIComponent(
      (await context.params)["executionId"] ?? "",
    );
    const getExecutionById =
      deps.getExecutionById ?? defaultGetGraphWorkflowExecutionById;
    const execution = await getExecutionById(
      resolved.projectPath,
      resolved.sessionName,
      executionId,
    );
    if (execution === null) {
      logger.info("graph-workflow.execution_result.not_found", {
        projectPath: resolved.projectPath,
        sessionName: resolved.sessionName,
        executionId,
      });
      return notFound("Graph workflow execution not found");
    }

    const cursorParam = new URL(request.url).searchParams.get("cursor");
    let cursor: number | null = null;
    if (cursorParam !== null) {
      const parsedCursor = Number(cursorParam);
      if (!Number.isSafeInteger(parsedCursor) || parsedCursor < 1) {
        logger.info("graph-workflow.execution_result.invalid_cursor", {
          projectPath: resolved.projectPath,
          sessionName: resolved.sessionName,
          executionId,
        });
        return NextResponse.json(
          { error: "cursor must be a positive integer" } satisfies ApiError,
          { status: 400 },
        );
      }
      cursor = parsedCursor;
    }

    const getBoundaryResultAfter =
      deps.getBoundaryResultAfter ?? defaultGetGraphWorkflowBoundaryResultAfter;
    const result = await getBoundaryResultAfter(
      resolved.projectPath,
      resolved.sessionName,
      executionId,
      cursor,
    );
    return NextResponse.json({ result });
  }

  async function HISTORY(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }

    return NextResponse.json({
      items: await summarizeHistory(
        deps,
        resolved.projectPath,
        resolved.sessionName,
      ),
    });
  }

  async function EVENTS(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }

    const url = new URL(request.url);
    const activeExecution = await deps.getActiveExecution(
      resolved.projectPath,
      resolved.sessionName,
    );
    const executionId =
      url.searchParams.get("executionId") ?? activeExecution?.id ?? null;
    // `page` opts into the cursor-paginated ledger contract; without it the
    // route answers exactly as it always has, so no existing consumer moves.
    const paginated = url.searchParams.get("page") === "true";
    if (!executionId) {
      return NextResponse.json(
        paginated ? { events: [], nextCursor: null } : { events: [] },
      );
    }

    const limitParam = url.searchParams.get("limit");
    const parsedLimit = limitParam !== null ? Number(limitParam) : NaN;
    const limit =
      Number.isInteger(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, GRAPH_WORKFLOW_EVENTS_MAX_LIMIT)
        : GRAPH_WORKFLOW_EVENTS_DEFAULT_LIMIT;

    if (paginated) {
      const cursorParam = Number(url.searchParams.get("cursor"));
      const getEventsPage = deps.getEventsPage ?? getGraphWorkflowEventsPage;
      const page = await getEventsPage(
        resolved.projectPath,
        resolved.sessionName,
        executionId,
        {
          limit,
          cursor:
            Number.isInteger(cursorParam) && cursorParam > 0
              ? cursorParam
              : null,
          direction:
            url.searchParams.get("direction") === "desc" ? "desc" : "asc",
        },
      );
      return NextResponse.json({
        // `seq` is the wire name for the row's durable ordering key: it is what
        // the caller sends back as `cursor`, so the pair is one vocabulary.
        events: page.records.map((record) => ({
          seq: record.id,
          occurredAt: record.occurredAt,
          event: record.event,
          preReset: record.preReset,
        })),
        nextCursor: page.nextCursor,
      });
    }

    const getEventsTail = deps.getEventsTail ?? getGraphWorkflowEventsTail;
    const events = await getEventsTail(
      resolved.projectPath,
      resolved.sessionName,
      executionId,
      limit,
    );
    return NextResponse.json({ events });
  }

  async function PAUSE(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }

    const guarded = await guardExecutionMutation({
      request,
      session: resolved.session,
      deps,
      verb: "pause",
      authority: "any_session_conversation",
      projectPath: resolved.projectPath,
      execution: await deps.getActiveExecution(
        resolved.projectPath,
        resolved.sessionName,
      ),
    });
    if ("refusal" in guarded) return guarded.refusal;

    try {
      const acted = await observeExecutionMutation(guarded.fence, "pause", () =>
        requireLifecycleValue(
          lifecycle.pause({ ...resolved, fence: guarded.fence }),
        ),
      );
      if (acted.kind === "turnover") return acted.refusal;
      return NextResponse.json({
        execution: summarizeExecution(acted.value, false),
      });
    } catch (error) {
      return respondToManagerError(error);
    }
  }

  async function RESUME(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }

    const rawBody: unknown = await request.json().catch(() => ({}));
    const parsedBody = resumeRequestSchema.safeParse(rawBody ?? {});
    if (!parsedBody.success) {
      return NextResponse.json(
        {
          error: `Invalid resume request: ${parsedBody.error.issues[0]?.message ?? "malformed body"}`,
        },
        { status: 400 },
      );
    }
    const resumeOptions: GraphWorkflowResumeOptions | undefined =
      parsedBody.data.conflictGuidance &&
      parsedBody.data.conflictGuidance.length > 0
        ? { conflictGuidance: parsedBody.data.conflictGuidance }
        : undefined;

    // Guarded BEFORE the restart normalization below, which mutates: a refused
    // caller must leave no trace, and normalizing for a caller that is then
    // turned away is a write a refusal is not allowed to make.
    const guarded = await guardExecutionMutation({
      request,
      session: resolved.session,
      deps,
      verb: "resume",
      authority: "any_session_conversation",
      projectPath: resolved.projectPath,
      execution: await deps.getActiveExecution(
        resolved.projectPath,
        resolved.sessionName,
      ),
    });
    if ("refusal" in guarded) return guarded.refusal;

    try {
      const acted = await observeExecutionMutation(
        guarded.fence,
        "resume",
        () =>
          requireLifecycleValue(
            lifecycle.resume({
              ...resolved,
              fence: guarded.fence,
              options: resumeOptions,
            }),
          ),
      );
      if (acted.kind === "turnover") return acted.refusal;
      const execution = acted.value;
      return NextResponse.json({
        execution: summarizeExecution(execution, false),
      });
    } catch (error) {
      return respondToManagerError(error);
    }
  }

  async function ABORT(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }
    const abortBody = abortExecutionSchema.safeParse(
      await request.json().catch(() => ({})),
    );
    const abortReason = abortBody.success ? abortBody.data.reason : undefined;

    // Guarded BEFORE the interrupted-decision settlement below, which commits:
    // a refused abort must be write-free.
    const guarded = await guardExecutionMutation({
      request,
      session: resolved.session,
      deps,
      verb: "abort",
      authority: "any_session_conversation",
      projectPath: resolved.projectPath,
      execution: await deps.getActiveExecution(
        resolved.projectPath,
        resolved.sessionName,
      ),
    });
    if ("refusal" in guarded) return guarded.refusal;

    try {
      const acted = await observeExecutionMutation(guarded.fence, "abort", () =>
        requireLifecycleValue(
          lifecycle.abort({
            ...resolved,
            fence: guarded.fence,
            audit:
              abortReason === undefined
                ? undefined
                : {
                    reason: abortReason,
                    actor: abortBody.success
                      ? (abortBody.data.actor ?? null)
                      : null,
                  },
          }),
        ),
      );
      if (acted.kind === "turnover") return acted.refusal;
      const execution = acted.value;
      return NextResponse.json({
        execution: summarizeExecution(execution, false),
        released: true,
      });
    } catch (error) {
      return respondToManagerError(error);
    }
  }

  /**
   * `cctl workflow abandon` — the one explicit, audited act that ends a
   * resumable halt's tenure (D7 decision D5). Addressed by execution identity,
   * so the run the caller read is the run that ends; a refusal never falls back
   * to whatever holds the lease now.
   *
   * The manager act commits the audit, the released boundary event, and the
   * relocation into History in one transaction. Lane teardown follows it rather
   * than preceding it: the act is the authoritative release, so only the caller
   * whose transaction committed reaches the external cleanup, and it reaches it
   * holding the whole record — lane references included.
   */
  async function ABANDON(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) return resolved.error;

    const abandon = deps.abandonExecution;
    if (abandon === undefined) {
      return NextResponse.json(
        { error: "Workflow abandonment is not available" } satisfies ApiError,
        { status: 501 },
      );
    }

    const parsed = abandonExecutionSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: `Invalid abandon request: ${parsed.error.issues[0]?.message ?? "malformed body"}`,
          code: "invalid_request",
        } satisfies ApiError & { code: string },
        { status: 400 },
      );
    }

    // The shared mutation contract admits the human UI, any conversation this
    // session verified, or the execution's current lane. An agent that cannot
    // prove which conversation it is has no authority, and a stale lane fails
    // freshness. Authorization is against the active run even when the body
    // names a stale id; only an admitted caller reaches the service's separate
    // execution-mismatch refusal.
    const active = await deps.getActiveExecution(
      resolved.projectPath,
      resolved.sessionName,
    );
    const guarded = await guardExecutionMutation({
      request,
      session: resolved.session,
      deps,
      verb: "abandon",
      authority: "any_session_conversation",
      projectPath: resolved.projectPath,
      execution: active,
    });
    if ("refusal" in guarded) return guarded.refusal;

    // The abandonment is attributed to the principal the SERVER established,
    // never to a free-text label.
    const actor: GraphWorkflowAbandonment["actor"] =
      guarded.principal.kind === "human_ui"
        ? { kind: "human" }
        : {
            kind: "conversation",
            conversationId: guarded.principal.conversationId,
          };

    const acted = await observeExecutionMutation(guarded.fence, "abandon", () =>
      lifecycle.abandon({
        fence: guarded.fence,
        projectPath: resolved.projectPath,
        sessionName: resolved.sessionName,
        executionId: parsed.data.executionId,
        reason: parsed.data.reason,
        actor,
      }),
    );
    if (acted.kind === "turnover") return acted.refusal;
    const outcome = acted.value;
    if (!outcome.ok)
      return respondToAbandonRefusal(parsed.data.executionId, outcome);

    return NextResponse.json({
      execution: buildExecutionActReceipt(outcome.execution, true),
      abandoned: true,
    });
  }

  async function RESET_CONTEXT(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }

    const parsed = resetExecutionContextRequestSchema.safeParse(
      await request.json(),
    );
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid request: executionId and contextId are required",
        } satisfies ApiError,
        { status: 400 },
      );
    }

    const activeExecution = await deps.getActiveExecution(
      resolved.projectPath,
      resolved.sessionName,
    );
    // A reset discards a context's work, so it is scoped exactly like the
    // sibling lifecycle verbs rather than admitted on transport alone.
    // Authorization is answered before the state ladder below: a caller with no
    // business here learns that, not which execution the session happens to
    // hold.
    const guarded = await guardExecutionMutation({
      request,
      session: resolved.session,
      deps,
      verb: "reset a context of",
      authority: "any_session_conversation",
      projectPath: resolved.projectPath,
      execution: activeExecution,
    });
    if ("refusal" in guarded) return guarded.refusal;

    if (!activeExecution) {
      return notFound(
        "Session does not have an active graph workflow execution",
      );
    }

    if (activeExecution.id !== parsed.data.executionId) {
      return NextResponse.json(
        {
          error:
            "Reset request targets a stale execution; reload and try again.",
        } satisfies ApiError,
        { status: 409 },
      );
    }

    try {
      const acted = await observeExecutionMutation(
        guarded.fence,
        "reset a context of",
        () =>
          requireLifecycleValue(
            lifecycle.reset({
              projectPath: resolved.projectPath,
              projectName: resolved.projectName,
              sessionName: resolved.sessionName,
              fence: guarded.fence,
              kind: "context",
              contextId: parsed.data.contextId,
            }),
          ),
      );
      if (acted.kind === "turnover") return acted.refusal;
      return NextResponse.json({
        execution: summarizeExecution(acted.value, false),
      });
    } catch (error) {
      return respondToManagerError(error);
    }
  }

  async function RESET_ASSIGNMENT(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }

    const parsed = resetExecutionContextAssignmentRequestSchema.safeParse(
      await request.json(),
    );
    if (!parsed.success) {
      return NextResponse.json(
        {
          error:
            "Invalid request: executionId, contextId, and assignmentId are required",
        } satisfies ApiError,
        { status: 400 },
      );
    }

    const activeExecution = await deps.getActiveExecution(
      resolved.projectPath,
      resolved.sessionName,
    );
    const guarded = await guardExecutionMutation({
      request,
      session: resolved.session,
      deps,
      verb: "reset an assignment of",
      authority: "any_session_conversation",
      projectPath: resolved.projectPath,
      execution: activeExecution,
    });
    if ("refusal" in guarded) return guarded.refusal;

    if (!activeExecution) {
      return notFound(
        "Session does not have an active graph workflow execution",
      );
    }

    if (activeExecution.id !== parsed.data.executionId) {
      return NextResponse.json(
        {
          error:
            "Reset request targets a stale execution; reload and try again.",
        } satisfies ApiError,
        { status: 409 },
      );
    }

    try {
      const acted = await observeExecutionMutation(
        guarded.fence,
        "reset an assignment of",
        () =>
          requireLifecycleValue(
            lifecycle.reset({
              projectPath: resolved.projectPath,
              projectName: resolved.projectName,
              sessionName: resolved.sessionName,
              fence: guarded.fence,
              kind: "assignment",
              contextId: parsed.data.contextId,
              assignmentId: parsed.data.assignmentId,
            }),
          ),
      );
      if (acted.kind === "turnover") return acted.refusal;
      return NextResponse.json({
        execution: summarizeExecution(acted.value, false),
      });
    } catch (error) {
      return respondToManagerError(error);
    }
  }

  /**
   * The change set the approval panel renders for one parked context (R15.2).
   *
   * A read of its own rather than a field on the execution payload: the patch is
   * git bytes, not execution state, and folding it into the execution row every
   * poller already fetches would put an unbounded blob on the hot path for the
   * one surface that needs it.
   */
  async function APPROVAL_SNAPSHOT(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }

    const params = new URL(request.url).searchParams;
    const contextId = params.get("contextId") ?? "";
    // Optional: when the caller names the gate it is rendering, the resolver
    // refuses to answer for a different one.
    const requestedAt = params.get("requestedAt") ?? "";
    if (contextId.trim() === "") {
      return NextResponse.json(
        { error: "Invalid request: contextId is required" } satisfies ApiError,
        { status: 400 },
      );
    }

    const activeExecution = await deps.getActiveExecution(
      resolved.projectPath,
      resolved.sessionName,
    );
    if (!activeExecution) {
      return notFound(
        "Session does not have an active graph workflow execution",
      );
    }

    const resolveSnapshot =
      deps.resolveApprovalSnapshot ?? resolveApprovalSnapshot;
    const resolution = await resolveSnapshot({
      execution: activeExecution,
      contextId,
      sessionWorktreePath: resolved.session.worktreePath,
      ...(requestedAt.trim() === "" ? {} : { requestedAt }),
    });

    // A superseded gate 404s with the others rather than getting a response
    // kind of its own: the caller's view of the execution is simply stale, and
    // the fix is the refetch its next state update already triggers.
    if (
      resolution.kind === "unknown_context" ||
      resolution.kind === "not_awaiting_approval" ||
      resolution.kind === "gate_superseded"
    ) {
      return notFound(
        `Context "${contextId}" is not awaiting approval in the active execution`,
      );
    }

    return NextResponse.json(resolution);
  }

  async function RESOLVE_APPROVAL(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }

    const parsed = resolveApprovalSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        {
          error:
            "Invalid request: contextId and decision are required; reject requires a non-empty message",
        } satisfies ApiError,
        { status: 400 },
      );
    }

    // Deciding a context's approval gate ANSWERS a question the run posed to
    // whoever launched it, rather than steering the run the way its sibling
    // verbs do, so it is the one guarded verb that keeps launch authority:
    // the human UI, the run's recorded origin, or the lane whose own gate it
    // is. It is still not the DEFINITION decision, which is human-only.
    const guarded = await guardExecutionMutation({
      request,
      session: resolved.session,
      deps,
      verb: "resolve an approval gate of",
      projectPath: resolved.projectPath,
      execution: await deps.getActiveExecution(
        resolved.projectPath,
        resolved.sessionName,
      ),
    });
    if ("refusal" in guarded) return guarded.refusal;

    const decision: ApprovalGateDecisionInput =
      parsed.data.decision === "approve"
        ? { type: "approved" }
        : { type: "rejected", message: parsed.data.message };

    let result: RecordDecisionResult;
    try {
      const acted = await runPinnedMutation(
        guarded.fence,
        "resolve an approval gate of",
        () =>
          deps.recordApprovalDecision({
            projectPath: resolved.projectPath,
            sessionName: resolved.sessionName,
            contextId: parsed.data.contextId,
            decision,
          }),
      );
      if (acted.kind === "turnover") return acted.refusal;
      result = acted.value;
    } catch (error) {
      return respondToManagerError(error);
    }

    if (!result.ok) {
      if (result.reason === "no_active_execution") {
        return notFound(
          "Session does not have an active graph workflow execution",
        );
      }
      return NextResponse.json(
        {
          error: resolveApprovalConflictMessage(
            result.reason,
            parsed.data.contextId,
          ),
        } satisfies ApiError,
        { status: 409 },
      );
    }

    return NextResponse.json({
      execution: summarizeExecution(result.execution, false),
    });
  }

  async function APPROVE_DEFINITION(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    // Definition approval is a human review act (the execution-start gate for
    // approval-required definitions), so it is refused to every agent
    // credential, not merely to agent transport.
    const humanOnly = await guardHumanOnlyAct({
      request,
      deps,
      error: "Workflow definition approval is a human-only act",
      instruction:
        "Approve the definition from the Command Center UI (Spec Studio or the session workflow page), not from an agent.",
    });
    if (humanOnly !== null) return humanOnly;

    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }

    const rawBody: unknown = await request.json().catch(() => null);
    const approvalIdentity =
      definitionDecisionIdentitySchema.safeParse(rawBody);
    if (!approvalIdentity.success) {
      return NextResponse.json(
        {
          error: `Invalid definition approval request: ${approvalIdentity.error.issues[0]?.message ?? "malformed body"}`,
          code: "invalid_request",
        } satisfies ApiError & { code: string },
        { status: 400 },
      );
    }

    let result: Awaited<ReturnType<typeof approveDefinition>>;
    try {
      result = await approveDefinition({
        projectPath: resolved.projectPath,
        projectName: resolved.projectName,
        sessionName: resolved.sessionName,
        expectedExecutionId: approvalIdentity.data.executionId,
      });
    } catch (error) {
      return respondToManagerError(error);
    }

    if (!result.ok) return respondToDefinitionApprovalRefusal(result);

    return NextResponse.json({
      execution: buildExecutionActReceipt(result.execution, false),
    });
  }

  /**
   * The reject half of the definition gate (D7 R14.2, decision D17). Addressed
   * solely by execution identity, so a one-off park — which has no saved
   * definition to name — and a template park are the same act.
   *
   * Order mirrors ABANDON for the same reasons: the decision is committed
   * through the serialized mutation first, then lane resources are released,
   * then the record is relocated into History through the audited archive seam.
   * `aborted` is lease-free the moment it commits, so the session is free even
   * if the archive below is missed — admission normalizes the row on the next
   * launch.
   */
  async function REJECT_DEFINITION(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    // Rejecting a definition is the same human review act as approving one, so
    // it answers every agent credential with the same refusal.
    const humanOnly = await guardHumanOnlyAct({
      request,
      deps,
      error: "Workflow definition rejection is a human-only act",
      instruction:
        "Reject the definition from the Command Center UI (Spec Studio or the session workflow page), not from an agent.",
    });
    if (humanOnly !== null) return humanOnly;

    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) return resolved.error;

    if (deps.rejectDefinition === undefined) {
      return NextResponse.json(
        {
          error: "Workflow definition rejection is not available",
        } satisfies ApiError,
        { status: 501 },
      );
    }

    const parsed = definitionDecisionIdentitySchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: `Invalid definition rejection request: ${parsed.error.issues[0]?.message ?? "malformed body"}`,
          code: "invalid_request",
        } satisfies ApiError & { code: string },
        { status: 400 },
      );
    }
    const outcome = await lifecycle.rejectDefinition({
      projectPath: resolved.projectPath,
      projectName: resolved.projectName,
      sessionName: resolved.sessionName,
      executionId: parsed.data.executionId,
    });
    if (!outcome.ok)
      return respondToDefinitionRejectionRefusal(
        parsed.data.executionId,
        outcome,
      );
    return NextResponse.json({
      execution: buildExecutionActReceipt(
        outcome.execution,
        "archived" in outcome && outcome.archived,
      ),
      rejected: true,
    });
  }

  return {
    START,
    RUN,
    launch,
    launchSpecDelivery,
    STATUS,
    EXECUTION,
    EXECUTION_BY_ID,
    EXECUTION_RESULT,
    HISTORY,
    EVENTS,
    PAUSE,
    RESUME,
    ABORT,
    ABANDON,
    RESET_CONTEXT,
    RESET_ASSIGNMENT,
    RESOLVE_APPROVAL,
    APPROVAL_SNAPSHOT,
    APPROVE_DEFINITION,
    REJECT_DEFINITION,
    approveDefinition,
    findPendingDefinitionApproval,
  };
}

const defaultGraphWorkflowExecutionHandlers =
  createGraphWorkflowExecutionRouteHandlers();

export const startGraphWorkflowExecution = withTracing(
  defaultGraphWorkflowExecutionHandlers.START,
);
export const runGraphWorkflowExecution = withTracing(
  defaultGraphWorkflowExecutionHandlers.RUN,
);
export const getGraphWorkflowExecutionStatus = withTracing(
  defaultGraphWorkflowExecutionHandlers.STATUS,
);
export const getGraphWorkflowExecutionFull = withTracing(
  defaultGraphWorkflowExecutionHandlers.EXECUTION,
);
export const getGraphWorkflowExecutionById = withTracing(
  defaultGraphWorkflowExecutionHandlers.EXECUTION_BY_ID,
);
export const getGraphWorkflowExecutionResult = withTracing(
  defaultGraphWorkflowExecutionHandlers.EXECUTION_RESULT,
);
export const getGraphWorkflowExecutionHistory = withTracing(
  defaultGraphWorkflowExecutionHandlers.HISTORY,
);
export const getGraphWorkflowExecutionEvents = withTracing(
  defaultGraphWorkflowExecutionHandlers.EVENTS,
);
export const pauseGraphWorkflowExecution = withTracing(
  defaultGraphWorkflowExecutionHandlers.PAUSE,
);
export const resumeGraphWorkflowExecution = withTracing(
  defaultGraphWorkflowExecutionHandlers.RESUME,
);
export const abortGraphWorkflowExecution = withTracing(
  defaultGraphWorkflowExecutionHandlers.ABORT,
);
export const abandonGraphWorkflowExecution = withTracing(
  defaultGraphWorkflowExecutionHandlers.ABANDON,
);
export const resetGraphWorkflowExecutionContext = withTracing(
  defaultGraphWorkflowExecutionHandlers.RESET_CONTEXT,
);
export const resetGraphWorkflowExecutionAssignment = withTracing(
  defaultGraphWorkflowExecutionHandlers.RESET_ASSIGNMENT,
);
export const resolveGraphWorkflowApproval = withTracing(
  defaultGraphWorkflowExecutionHandlers.RESOLVE_APPROVAL,
);
export const getGraphWorkflowApprovalSnapshot = withTracing(
  defaultGraphWorkflowExecutionHandlers.APPROVAL_SNAPSHOT,
);
export const approveGraphWorkflowDefinition = withTracing(
  defaultGraphWorkflowExecutionHandlers.APPROVE_DEFINITION,
);
export const rejectGraphWorkflowDefinition = withTracing(
  defaultGraphWorkflowExecutionHandlers.REJECT_DEFINITION,
);
