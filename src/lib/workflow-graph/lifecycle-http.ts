import type { RejectDefinitionResult } from "./workflow-manager";
import {
  abandonRefusalMessage,
  type LifecycleAbandonResult,
  type LifecycleDefinitionRejectionResult,
  type LifecycleDefinitionApprovalResult,
} from "./lifecycle-outcomes";
import { assertNever } from "@/lib/shared/assert-never";
import {
  lifecycleRefusalFromError,
  type LifecycleRefusal,
} from "./lifecycle-outcomes";

import { NextResponse } from "next/server";

import { notFound } from "@/lib/shared/route-resolution";

import { createLogger } from "@/lib/logging";

import type { ApiError } from "@/lib/api/errors";

import { WorkflowStartInputError } from "@/lib/workflow-graph/workflow-manager";

import type { WorkflowPlanIssue } from "@/lib/workflows/plan-validation";

const logger = createLogger("graph-workflow-lifecycle-http");

export function respondToLifecycleRefusal(
  refusal: LifecycleRefusal,
  inputPathRoot: LaunchInputPathRoot = "parameters",
): Response {
  switch (refusal.code) {
    case "invalid_transition": {
      const error = refusal.error;
      logger.info("graph-workflow.lifecycle.transition_rejected", {
        action: error.action,
        currentStatus: error.currentStatus,
        allowedStatuses: error.allowedStatuses,
      });
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          details: {
            action: error.action,
            currentStatus: error.currentStatus,
            allowedStatuses: error.allowedStatuses,
          },
        } satisfies ApiError,
        { status: 409 },
      );
    }
    case "execution_contract": {
      const error = refusal.error;
      const message = error.message;
      return NextResponse.json(
        {
          error: message,
          code: error.code,
          errors: error.issues,
          instruction: error.instruction,
        } satisfies ApiError & {
          code: string;
          errors: unknown;
          instruction: string;
        },
        { status: 409 },
      );
    }
    case "definition_revision_mismatch": {
      const error = refusal.error;
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          details: {
            definitionId: error.definitionId,
            expectedRevision: error.expectedRevision,
            actualRevision: error.actualRevision,
          },
        } satisfies ApiError,
        { status: 409 },
      );
    }
    case "definition_validation": {
      const error = refusal.error;
      const message = error.message;
      return NextResponse.json(
        { error: message, errors: error.errors } satisfies ApiError & {
          errors: unknown;
        },
        { status: 422 },
      );
    }
    case "missing_resource": {
      const error = refusal.error;
      const message = error.message;
      return notFound(message);
    }
    case "reset_refused": {
      const error = refusal.error;
      const message = error.message;
      return error.code === "context_missing"
        ? notFound(message)
        : NextResponse.json({ error: message } satisfies ApiError, {
            status: 409,
          });
    }
    case "launch_guard": {
      const error = refusal.error;
      if (error.guard === "uncommitted_changes") {
        const dirtyPaths = error.dirtyPaths ?? [];
        return NextResponse.json(
          {
            error: error.message,
            code: "uncommitted_changes",
            details: {
              totalCount: dirtyPaths.length,
              paths: dirtyPaths.slice(0, 20).map((entry) => entry.path),
            },
          } satisfies ApiError,
          { status: 409 },
        );
      }
      // The session is being finalized by a merge, so there is no run to name and
      // no lease to clear — the remedy is the merge, not this session's workflow.
      if (
        error.guard === "session_finalizing" ||
        error.guard === "session_branch_unavailable"
      ) {
        return NextResponse.json(
          { error: error.message, code: error.guard } satisfies ApiError,
          { status: 409 },
        );
      }
      // The lease-held refusal (D7 decision D6). `details` is the blocker the
      // admission decision built, forwarded verbatim so the CLI and the UI
      // name the same run and the same remedy without re-reading anything.
      return NextResponse.json(
        {
          error: error.message,
          code: "lease_held",
          ...(error.blocker === undefined ? {} : { details: error.blocker }),
        } satisfies ApiError,
        { status: 409 },
      );
    }
    case "prerequisites_unmet": {
      const error = refusal.error;
      return NextResponse.json(
        {
          error: error.message,
          code: "prerequisites_unmet",
          details: { missing: error.missing },
        } satisfies ApiError,
        { status: 409 },
      );
    }
    case "launch_input": {
      const error = refusal.error;
      return NextResponse.json(
        {
          error: error.message,
          ...locateLaunchInputIssue(error, inputPathRoot),
        },
        { status: 400 },
      );
    }
    default:
      return assertNever(refusal, "unhandled lifecycle refusal");
  }
}
export function respondToManagerError(error: unknown): Response {
  const refusal = lifecycleRefusalFromError(error);
  if (refusal) return respondToLifecycleRefusal(refusal);
  return NextResponse.json(
    {
      error:
        error instanceof Error
          ? error.message
          : "Graph workflow request failed",
    } satisfies ApiError,
    { status: 500 },
  );
}
/**
 * The body field each launch verb carries its bound parameters in. A located
 * input issue has to point at what the caller actually sent, and the two verbs
 * deliberately name that document differently — `start` takes `parameters`,
 * `run` takes a separate `inputs` document beside the plan — so the root is
 * passed in rather than guessed.
 */
type LaunchInputPathRoot = "parameters" | "inputs";

/**
 * Locate a launch-input refusal in the request body (R1.3).
 *
 * The refusal speaks the same `{code, issues:[{path, message}]}` dialect
 * `validateWorkflowPlan` already returns, so a caller parses one refusal shape
 * for a plan that fails validation and for an input that fails binding. The
 * parameter name is a plain object key in the submitted document, which is why
 * the path is the root joined to the name rather than a re-derived JSON path.
 */
function locateLaunchInputIssue(
  error: WorkflowStartInputError,
  root: LaunchInputPathRoot,
): { code: string; issues: WorkflowPlanIssue[] } {
  return {
    code: error.inputError.kind,
    issues: [
      { path: `${root}.${error.inputError.name}`, message: error.message },
    ],
  };
}

/**
 * THE launch-refusal mapping, shared by both launch transports (D7 R2).
 *
 * Every pre-seed refusal a launch can raise resolves to one response here, so
 * `workflow start` and `workflow run` cannot answer the same guard differently.
 * Each of these rejections seeds nothing, which is why none of them engages the
 * loop-failure halt path (that only applies to a seeded execution).
 */
export function respondToLaunchRefusal(
  error: unknown,
  inputPathRoot: LaunchInputPathRoot,
): Response {
  const refusal = lifecycleRefusalFromError(error);
  return refusal
    ? respondToLifecycleRefusal(refusal, inputPathRoot)
    : respondToManagerError(error);
}

function rejectDefinitionRefusalMessage(
  requestedExecutionId: string,
  refusal: Exclude<RejectDefinitionResult, { ok: true }>,
): string {
  switch (refusal.reason) {
    case "no_active_execution":
      return `This session owns no graph workflow execution, so ${requestedExecutionId} cannot be rejected. Re-check with 'cctl workflow status'.`;
    case "execution_mismatch":
      return `Execution ${requestedExecutionId} does not hold this session's execution lease; ${refusal.activeExecutionId} does. Re-check with 'cctl workflow status', then decide on the run you mean.`;
    case "not_awaiting_approval":
      return `A ${refusal.status} graph workflow execution is not awaiting definition approval, so there is no definition decision to make. Abort it with 'cctl workflow live abort --reason <reason>' instead.`;
    case "decision_in_flight":
      return `An approval is already deciding execution ${requestedExecutionId}. Wait for it to settle, then re-check with 'cctl workflow status'.`;
    default:
      return assertNever(refusal, "unhandled definition rejection refusal");
  }
}

/**
 * Why an approval was declined, in the operator's terms. Each message says
 * what changed under the reviewer, because every refusal here means the park
 * they were looking at is no longer the park they are deciding.
 */
function definitionApprovalRefusalMessage(
  reason:
    | "not_awaiting_approval"
    | "already_decided"
    | "execution_mismatch"
    | "decision_in_flight"
    | "not_reserved"
    | "claim_superseded",
): string {
  switch (reason) {
    case "already_decided":
      return "The pending workflow definition is already approved (already_decided)";
    case "execution_mismatch":
      return "The active workflow execution changed before approval (execution_mismatch)";
    case "decision_in_flight":
      return "Another approval or rejection is already deciding this workflow definition (decision_in_flight)";
    case "not_reserved":
      return "The approval was no longer reserved when it went to record (not_reserved)";
    case "claim_superseded":
      return "This approval's reservation was reclaimed and another act now holds the decision (claim_superseded)";
    case "not_awaiting_approval":
      return "The active execution is not awaiting definition approval (not_awaiting_approval)";
  }
}

export function respondToAbandonRefusal(
  executionId: string,
  refusal: Exclude<LifecycleAbandonResult, { ok: true }>,
): Response {
  switch (refusal.reason) {
    case "unavailable":
      return NextResponse.json(
        { error: "Workflow abandonment is not available" },
        { status: 501 },
      );
    case "no_active_execution":
    case "execution_mismatch":
    case "not_lease_holding_halt":
      return NextResponse.json(
        {
          error: abandonRefusalMessage(executionId, refusal),
          code: refusal.reason,
        },
        { status: refusal.reason === "no_active_execution" ? 404 : 409 },
      );
    default:
      return assertNever(refusal, "unhandled abandonment refusal");
  }
}

export function respondToDefinitionRejectionRefusal(
  executionId: string,
  refusal: Exclude<LifecycleDefinitionRejectionResult, { ok: true }>,
): Response {
  switch (refusal.reason) {
    case "unavailable":
      return NextResponse.json(
        { error: "Workflow definition rejection is not available" },
        { status: 501 },
      );
    case "no_active_execution":
    case "execution_mismatch":
    case "not_awaiting_approval":
    case "decision_in_flight":
      return NextResponse.json(
        {
          error: rejectDefinitionRefusalMessage(executionId, refusal),
          code: refusal.reason,
        },
        { status: refusal.reason === "no_active_execution" ? 404 : 409 },
      );
    default:
      return assertNever(refusal, "unhandled definition rejection refusal");
  }
}

export function respondToDefinitionApprovalRefusal(
  refusal: Exclude<LifecycleDefinitionApprovalResult, { ok: true }>,
): Response {
  const reason = refusal.reason;
  switch (reason) {
    case "unavailable":
      return NextResponse.json(
        { error: "Definition approval is not available" },
        { status: 501 },
      );
    case "no_active_execution":
      return notFound(
        "Session does not have an active graph workflow execution",
      );
    case "gate_refused":
      return NextResponse.json(
        {
          error: refusal.refusal.unmetConditions.join(" "),
          code: refusal.refusal.code,
          unmetConditions: refusal.refusal.unmetConditions,
          instruction: refusal.refusal.instruction,
        },
        { status: 409 },
      );
    case "not_awaiting_approval":
    case "already_decided":
    case "execution_mismatch":
    case "decision_in_flight":
    case "not_reserved":
    case "claim_superseded":
      return NextResponse.json(
        { error: definitionApprovalRefusalMessage(reason), code: reason },
        { status: 409 },
      );
    default:
      return assertNever(reason, "unhandled definition approval refusal");
  }
}
