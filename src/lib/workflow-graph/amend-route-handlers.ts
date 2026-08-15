/**
 * `POST …/graph-workflow/amend` — the one authorized way to change a launched
 * delivery-plan definition (design §11). `cctl workflow live amend` and the
 * Studio amend control both post {@link workflowExecutionAmendmentRequestSchema}
 * here; there is no second route and no second schema, so the audit trail and
 * the additive bound cannot differ by caller.
 *
 * It composes the generic live-edit pipeline rather than reimplementing one:
 * the frontier invariant and frozen-context rules are the same ones a direct
 * edit rides. Its bounded additive operand is admitted through plan-owned
 * locks; everything else keeps the lock check. The route adds the policy
 * envelope — active-run-only, delivery-plan-only, additive-only, required
 * rationale, server-derived actor — and the durable amendment event carrying
 * the old and new working-definition hashes.
 */

import { NextResponse } from "next/server";
import { createAgentAuth } from "@/lib/agent-gateway/token";
import { createLogger, withTracing } from "@/lib/logging";
import {
  notFound,
  resolveProjectSessionOr404,
} from "@/lib/shared/route-resolution";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import {
  getSession as defaultGetSession,
  getActiveGraphWorkflowExecution,
  mutateActiveGraphWorkflowExecution,
  reserveActiveGraphWorkflowExecution,
  archiveActiveGraphWorkflowExecution,
  markGraphWorkflowContextEventsPreReset,
  getGraphWorkflowPendingArtifacts,
  clearGraphWorkflowPendingArtifacts,
} from "@/lib/state-store";
import type { SessionState } from "@/lib/sessions/schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { WorkflowLiveEditOperation } from "@/lib/workflows/edit-schemas";
import {
  createGraphWorkflowExecutionEventPublisher,
  type GraphWorkflowEventDelivery,
  type PublishCharterUpdatedInput,
  type PublishExecutionAmendedInput,
  type PublishLiveEditAppliedInput,
} from "./execution-events";
import {
  createGraphWorkflowExecutionRepository,
  type MutateActiveResult,
} from "./execution-repository";
import { formatDefinitionEditIssue } from "./definition-edits";
import {
  amendmentAdditions,
  isDeliveryPlanDefinition,
  isWorkflowExecutionAmendableStatus,
  nonAdditiveOperationTypes,
  toLiveEditOperations,
  workflowExecutionAmendmentRequestSchema,
  workflowExecutionAmendmentRefusalInstruction,
  type WorkflowAmendmentActor,
} from "./execution-amendment";
import { workingDefinitionHash } from "./working-definition-hash";
import {
  applyLiveEditsToActiveExecution,
  buildDefaultAssignmentSnapshotPreparation,
  buildDefaultLiveEditDeps,
  defaultWriteCharterDocument,
  type LiveEditFailure,
} from "./live-edit-apply";
import type { PrepareAssignmentSnapshotsResult } from "./live-edit-preparation";
import type { LiveEditDeps } from "./runtime-edits";

/** Shared with the spec routes: an absent token is a human at a browser. */
const logger = createLogger("workflow-graph.amend-route");

type RouteContext = {
  params: Promise<Record<string, string>>;
};

export interface GraphWorkflowAmendAuth {
  validateOptionalToken(
    request: Request,
  ): Promise<{ kind: "valid" | "invalid" | "absent" }>;
}

export interface GraphWorkflowAmendRouteDeps {
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
  prepareAssignmentSnapshots(
    projectPath: string,
    operations: readonly WorkflowLiveEditOperation[],
  ): Promise<PrepareAssignmentSnapshotsResult>;
  publishLiveEditApplied(
    input: PublishLiveEditAppliedInput,
  ): GraphWorkflowEventDelivery;
  publishCharterUpdated(
    input: PublishCharterUpdatedInput,
  ): GraphWorkflowEventDelivery;
  publishExecutionAmended(
    input: PublishExecutionAmendedInput,
  ): GraphWorkflowEventDelivery;
  writeCharterDocument(input: {
    worktreePath: string;
    markdown: string;
  }): Promise<void>;
  auth: GraphWorkflowAmendAuth;
  /**
   * Principal verification seams for the shared mutation guard. Optional so
   * production inherits the registered verifiers and tests inject their own.
   */
  verifyConversationCapability?: WorkflowMutationGuardDeps["verifyConversationCapability"];
  verifyLaneCapability?: WorkflowMutationGuardDeps["verifyLaneCapability"];
}

import {
  guardExecutionMutation,
  runPinnedMutation,
  type WorkflowMutationGuardDeps,
} from "./mutation-guard";
import type { WorkflowRequestPrincipal } from "./request-principal";

const eventPublisher = createGraphWorkflowExecutionEventPublisher();
const executionRepository = createGraphWorkflowExecutionRepository({
  getSession: defaultGetSession,
  getActiveGraphWorkflowExecution,
  mutateActiveGraphWorkflowExecution,
  reserveActiveGraphWorkflowExecution,
  archiveActiveGraphWorkflowExecution,
  markGraphWorkflowContextEventsPreReset,
  getGraphWorkflowPendingArtifacts,
  clearGraphWorkflowPendingArtifacts,
  eventPublisher,
});

const defaultDeps: GraphWorkflowAmendRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  getSession: defaultGetSession,
  getActiveExecution: getActiveGraphWorkflowExecution,
  mutateActive: executionRepository.mutateActive,
  buildLiveEditDeps: buildDefaultLiveEditDeps,
  prepareAssignmentSnapshots: buildDefaultAssignmentSnapshotPreparation,
  publishLiveEditApplied: eventPublisher.publishLiveEditApplied,
  publishCharterUpdated: eventPublisher.publishCharterUpdated,
  publishExecutionAmended: eventPublisher.publishExecutionAmended,
  writeCharterDocument: defaultWriteCharterDocument,
  auth: createAgentAuth(),
};

function refusal(
  code: string,
  error: string,
  instruction: string,
  status: 400 | 409 = 409,
): Response {
  return NextResponse.json({ error, code, instruction }, { status });
}

function respondLiveEditFailure(failure: LiveEditFailure): Response {
  const body: Record<string, unknown> = {
    error: failure.error,
    code: failure.code,
  };
  if (failure.issues) {
    body["issues"] = failure.issues.map(formatDefinitionEditIssue);
  }
  if (failure.instruction) {
    body["instruction"] = failure.instruction;
  }
  return NextResponse.json(body, { status: failure.status });
}

function describeActor(actor: WorkflowAmendmentActor): string {
  if (actor.kind === "human") return "human";
  return actor.backend === undefined
    ? `agent:${actor.conversationId}`
    : `agent:${actor.conversationId} (${actor.backend})`;
}

/**
 * The audit actor for an established principal.
 *
 * Which backend wrote an amendment is worth recording, but a caller cannot be
 * the one to say: the amendment row is evidence, and evidence a caller labels
 * itself with is worthless. The backend is therefore read from the session's
 * own record of that conversation — the server already knows it — and is simply
 * absent when the session no longer carries the conversation.
 */
function buildAmendmentActor(
  principal: WorkflowRequestPrincipal,
  session: SessionState,
): WorkflowAmendmentActor {
  if (principal.kind === "human_ui") return { kind: "human" };
  const backend = session.conversations.find(
    (conversation) => conversation.id === principal.conversationId,
  )?.agentBackend;
  return {
    kind: "agent",
    conversationId: principal.conversationId,
    ...(backend === undefined ? {} : { backend }),
  };
}

export function createGraphWorkflowAmendRouteHandlers(
  deps: GraphWorkflowAmendRouteDeps = defaultDeps,
) {
  async function POST(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const transport = await deps.auth.validateOptionalToken(request);
    if (transport.kind === "invalid") {
      return NextResponse.json(
        { error: "Invalid Command Center API token", code: "unauthorized" },
        { status: 401 },
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json(
        {
          error: "Invalid amendment request: body must be JSON",
          issues: [{ path: "body", message: "invalid JSON" }],
        },
        { status: 400 },
      );
    }

    // Name every non-additive entry before the schema reports it as an unknown
    // discriminator: "add-context, add-task, add-edge only" is the actual rule,
    // and a zod union error would bury it (`refusals-name-remedy`).
    const rawOperations = (rawBody as { operations?: unknown } | null)
      ?.operations;
    const offenders = Array.isArray(rawOperations)
      ? nonAdditiveOperationTypes(rawOperations)
      : [];
    if (offenders.length > 0) {
      logger.warn("graph-workflow.amend.refused", {
        code: "non_additive_operation",
        operationTypes: offenders,
      });
      return refusal(
        "non_additive_operation",
        `An amendment is additive only; it cannot carry ${offenders.join(", ")}. Nothing was applied.`,
        "Remove the non-additive entries and keep only add-context, add-task, and add-edge. To change or drop existing plan content, reopen the plan with `cctl spec plan reopen` before launch, or replan with `cctl spec capture <slug> --file <task.json> --blocking-reason <why>` after it.",
        400,
      );
    }

    const parsed = workflowExecutionAmendmentRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid amendment request",
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join(".") || "operations",
            message: issue.message,
          })),
        },
        { status: 400 },
      );
    }
    const amendmentRequest = parsed.data;

    const params = await context.params;
    const projectName = params["name"] ?? "";
    const sessionName = decodeURIComponent(params["session"] ?? "");
    const resolved = await resolveProjectSessionOr404(
      deps,
      projectName,
      sessionName,
    );
    if (!resolved.ok) return resolved.response;
    const projectPath = resolved.value.projectPath;

    const execution = await deps.getActiveExecution(projectPath, sessionName);
    if (execution === null) {
      return notFound(
        "Session does not have an active graph workflow execution",
      );
    }

    // Attribution is DERIVED from the server-established principal, never from
    // the caller's own header: letting a caller name itself in an audit row is
    // the one thing a row of this kind must not allow (`evidence-legality`),
    // and it is the same forgery the lifecycle verbs refuse. Guarded before the
    // amendment below, which commits — a refusal must be write-free.
    const guarded = await guardExecutionMutation({
      request,
      session: resolved.value.session,
      deps,
      verb: "amend",
      projectPath,
      execution,
    });
    if ("refusal" in guarded) return guarded.refusal;
    const actor: WorkflowAmendmentActor = buildAmendmentActor(
      guarded.principal,
      resolved.value.session,
    );

    if (!isWorkflowExecutionAmendableStatus(execution.status)) {
      logger.warn("graph-workflow.amend.refused", {
        code: "not_running",
        executionId: execution.id,
        executionStatus: execution.status,
        ...(execution.haltReason === null
          ? {}
          : { haltReasonType: execution.haltReason.type }),
      });
      return refusal(
        "not_running",
        `Execution "${execution.id}" is ${execution.status}; only a running or paused execution can be amended. Nothing was applied.`,
        workflowExecutionAmendmentRefusalInstruction(execution),
      );
    }

    if (!isDeliveryPlanDefinition(execution.workingDefinition)) {
      logger.warn("graph-workflow.amend.refused", {
        code: "not_a_delivery_plan",
        executionId: execution.id,
      });
      return refusal(
        "not_a_delivery_plan",
        `Execution "${execution.id}" was not compiled from a delivery plan, so it has no locked regions to amend around. Nothing was applied.`,
        "Edit it directly with `cctl workflow live edit --file <live-ops.json>` — a legacy definition's regions are unlocked on purpose.",
      );
    }

    const additions = amendmentAdditions(amendmentRequest.operations);
    const acted = await runPinnedMutation(guarded.fence, "amend", () =>
      applyLiveEditsToActiveExecution(
        {
          projectPath,
          sessionName,
          request: {
            executionId: execution.id,
            baseLiveRevision: execution.liveRevision,
            source: actor.kind === "human" ? "ui" : "cli",
            operations: toLiveEditOperations(amendmentRequest.operations),
            amendment: {
              reason: amendmentRequest.reason,
              actor: describeActor(actor),
              policyActor: actor,
              operations: amendmentRequest.operations,
              addedContextIds: additions.contextIds,
              addedTaskIds: additions.taskIds,
              addedEdgeIds: additions.edgeIds,
              hashDefinition: workingDefinitionHash,
            },
          },
        },
        deps,
      ),
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

    const policyBasis = outcome.amendmentPolicyBasis;
    if (policyBasis === null) {
      throw new Error("an applied amendment must report its policy admission");
    }
    const previousWorkingDefinitionHash = workingDefinitionHash(
      execution.workingDefinition,
    );
    const nextWorkingDefinitionHash =
      outcome.execution === null
        ? null
        : workingDefinitionHash(outcome.execution.workingDefinition);
    logger.info("graph-workflow.amend.applied", {
      executionId: execution.id,
      liveRevision: outcome.liveRevision,
      operationCount: outcome.applied,
      actorKind: actor.kind,
      ...(actor.kind === "agent"
        ? {
            conversationId: actor.conversationId,
            ...(actor.backend === undefined ? {} : { backend: actor.backend }),
          }
        : {}),
      policyBasis,
      addedContextIds: additions.contextIds,
      addedTaskIds: additions.taskIds,
      addedEdgeIds: additions.edgeIds,
      previousWorkingDefinitionHash,
      workingDefinitionHash: nextWorkingDefinitionHash,
    });

    return NextResponse.json({
      amended: outcome.applied,
      liveRevision: outcome.liveRevision,
      policyBasis,
      addedContextIds: additions.contextIds,
      addedTaskIds: additions.taskIds,
      addedEdgeIds: additions.edgeIds,
      previousWorkingDefinitionHash,
      workingDefinitionHash: nextWorkingDefinitionHash,
    });
  }

  return { POST };
}

const defaultAmendHandlers = createGraphWorkflowAmendRouteHandlers();

export const amendGraphWorkflowExecution = withTracing(
  defaultAmendHandlers.POST,
);
