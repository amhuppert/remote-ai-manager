import { assertNever } from "@/lib/shared/assert-never";
import type { AbandonExecutionResult } from "./workflow-manager";
import type { GraphWorkflowLaunchOutcome } from "./workflow-manager";

export type LifecycleLaunchAcceptance = Omit<
  GraphWorkflowLaunchOutcome,
  "awaitingDefinitionApproval"
> & {
  disposition: "running" | "awaiting_definition_approval";
};
import {
  GraphWorkflowTransitionConflictError,
  WorkflowDefinitionNotFoundError,
  WorkflowDefinitionRevisionMismatchError,
  WorkflowPrerequisitesUnmetError,
} from "./workflow-manager";
import { WorkflowStartGuardError } from "./start-guards";
import { WorkflowStartInputError } from "./start-input-service";
import { GraphExecutionContractViolationError } from "./execution-contract-port";
import { GraphWorkflowValidationError } from "./definition-validation";
import { GraphWorkflowResourceMissingError } from "./lifecycle-errors";
import { ResetExecutionContextError } from "./reset-context";
import { ResetAssignmentError } from "./reset-assignment";

export type LifecycleRefusal =
  | {
      code: "missing_resource";
      error:
        | GraphWorkflowResourceMissingError
        | WorkflowDefinitionNotFoundError;
    }
  | { code: "invalid_transition"; error: GraphWorkflowTransitionConflictError }
  | {
      code: "definition_revision_mismatch";
      error: WorkflowDefinitionRevisionMismatchError;
    }
  | { code: "launch_guard"; error: WorkflowStartGuardError }
  | { code: "launch_input"; error: WorkflowStartInputError }
  | { code: "prerequisites_unmet"; error: WorkflowPrerequisitesUnmetError }
  | { code: "execution_contract"; error: GraphExecutionContractViolationError }
  | { code: "definition_validation"; error: GraphWorkflowValidationError }
  | {
      code: "reset_refused";
      error: ResetExecutionContextError | ResetAssignmentError;
    };

export type LifecycleResult<Value> =
  | { kind: "accepted"; value: Value }
  | { kind: "refused"; refusal: LifecycleRefusal };

/**
 * The graph runtime is composed at server startup, in another bundle than the
 * routes that answer its refusals, so a refusal arrives as an instance of that
 * bundle's copy of its class and `instanceof` cannot see it. Each class is
 * recognised by its unique name instead; a subclass keeps its parent's name to
 * be recognised as its parent.
 */
export function lifecycleRefusalFromError(
  error: unknown,
): LifecycleRefusal | null {
  if (
    GraphWorkflowResourceMissingError.is(error) ||
    WorkflowDefinitionNotFoundError.is(error)
  )
    return { code: "missing_resource", error };
  if (GraphWorkflowTransitionConflictError.is(error))
    return { code: "invalid_transition", error };
  if (WorkflowDefinitionRevisionMismatchError.is(error))
    return { code: "definition_revision_mismatch", error };
  if (WorkflowStartGuardError.is(error)) return { code: "launch_guard", error };
  if (WorkflowStartInputError.is(error)) return { code: "launch_input", error };
  if (WorkflowPrerequisitesUnmetError.is(error))
    return { code: "prerequisites_unmet", error };
  if (GraphExecutionContractViolationError.is(error))
    return { code: "execution_contract", error };
  if (GraphWorkflowValidationError.is(error))
    return { code: "definition_validation", error };
  if (ResetExecutionContextError.is(error) || ResetAssignmentError.is(error))
    return { code: "reset_refused", error };
  return null;
}

export async function lifecycleResult<Value>(
  run: () => Promise<Value>,
): Promise<LifecycleResult<Value>> {
  try {
    return { kind: "accepted", value: await run() };
  } catch (error) {
    const refusal = lifecycleRefusalFromError(error);
    if (refusal === null) throw error;
    return { kind: "refused", refusal };
  }
}

export async function requireLifecycleValue<Value>(
  result: Promise<LifecycleResult<Value>>,
): Promise<Value> {
  const settled = await result;
  if (settled.kind === "refused") throw settled.refusal.error;
  return settled.value;
}

/**
 * Why an abandon was declined, in the operator's terms. Each message names the
 * act that DOES apply, because every refusal here means the caller's mental
 * model of the run's tenure is stale in a specific, correctable way.
 */
export function abandonRefusalMessage(
  requestedExecutionId: string,
  refusal: Exclude<AbandonExecutionResult, { ok: true }>,
): string {
  switch (refusal.reason) {
    case "no_active_execution":
      return `This session owns no graph workflow execution, so ${requestedExecutionId} cannot be abandoned. Re-check with 'cctl workflow status'.`;
    case "execution_mismatch":
      return `Execution ${requestedExecutionId} does not hold this session's execution lease; ${refusal.activeExecutionId} does. Re-check with 'cctl workflow status', then abandon the run you mean.`;
    case "not_lease_holding_halt":
      return refusal.abandoned
        ? `Execution ${requestedExecutionId} was already abandoned and belongs to History.`
        : refusal.status === "halted"
          ? `Execution ${requestedExecutionId} halted for a reason that cannot be resumed, so it already belongs to History and holds no lease.`
          : `A ${refusal.status} graph workflow execution cannot be abandoned. Abort it with 'cctl workflow live abort --reason <reason>' instead.`;
    default:
      return assertNever(refusal, "unhandled abandon refusal");
  }
}

export type LifecycleDefinitionApprovalResult =
  | import("./workflow-manager").RecordDefinitionApprovalResult
  | import("./workflow-manager").ClaimDefinitionApprovalResult
  | { ok: false; reason: "unavailable" }
  | {
      ok: false;
      reason: "gate_refused";
      refusal: Exclude<
        import("./execution-lifecycle-port").DefinitionApprovalGateDecision,
        { ok: true }
      >;
    };

export type LifecycleAbandonResult =
  | AbandonExecutionResult
  | { ok: false; reason: "unavailable" };
export type LifecycleDefinitionRejectionResult =
  | {
      ok: true;
      execution: GraphWorkflowLaunchOutcome["execution"];
      archived: boolean;
    }
  | Exclude<import("./workflow-manager").RejectDefinitionResult, { ok: true }>
  | { ok: false; reason: "unavailable" };
