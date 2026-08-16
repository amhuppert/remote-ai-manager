import { createLogger } from "@/lib/logging";
import type { GraphWorkflowExecution } from "./schemas";
import { resolveExpansionProvenance } from "./expansion-receipts";
import { findLoopBodyMembership } from "./loop-resolver";
import {
  isRouteSourceLanded,
  isUpstreamVisibleToLane,
  landGatedPublishSettlement,
  reachableLanesFrom,
} from "./lane-readiness";

const logger = createLogger("workflow-graph-authored-context-outcome");

export type AuthoredContextOutcome =
  | {
      status: "pending";
      reason:
        | "context_unsettled"
        | "approval_pending"
        | "landing_pending"
        | "integration_pending";
      executionLocation: "active" | "archived";
    }
  | {
      status: "skipped";
      reason: "route_skipped";
      executionLocation: "active" | "archived";
    }
  | {
      status: "failed";
      reason:
        | "execution_not_found"
        | "authored_context_not_found"
        | "generated_context_not_authored"
        | "loop_body_template_not_authored_source"
        | "loop_instance_not_authored_source"
        | "execution_halted"
        | "execution_aborted"
        | "context_state_missing"
        | "script_gate_failed"
        | "validator_gate_failed"
        | "approval_gate_failed"
        | "validation_gate_failed"
        | "output_gate_failed"
        | "landing_failed"
        | "integration_failed"
        | "write_result_not_integrated";
      executionLocation: "active" | "archived" | "missing";
    }
  | {
      status: "satisfied";
      reason: "read_only_completed" | "write_result_integrated";
      executionLocation: "active" | "archived";
    };

export type IntegrationReadyFinalCandidateOutcome =
  | {
      status: "pending";
      reason:
        | "execution_unsettled"
        | "final_publish_pending"
        | "required_claimant_unsettled";
      executionLocation: "active" | "archived";
    }
  | {
      status: "failed";
      reason:
        | "execution_not_found"
        | "execution_halted"
        | "execution_aborted"
        | "final_publish_failed"
        | "publish_settlement_incomplete"
        | "required_claimant_not_integrated";
      executionLocation: "active" | "archived" | "missing";
    }
  | {
      status: "satisfied";
      reason: "integration_ready";
      executionLocation: "active" | "archived";
    };

export interface LocatedGraphWorkflowExecution {
  readonly execution: GraphWorkflowExecution;
  readonly location: "active" | "archived";
}

export interface AuthoredContextOutcomeServiceDeps {
  findExecutionById(
    executionId: string,
  ): Promise<LocatedGraphWorkflowExecution | null>;
}

export interface AuthoredContextOutcomeService {
  getAuthoredContextOutcome(
    executionId: string,
    authoredContextId: string,
  ): Promise<AuthoredContextOutcome>;
  getIntegrationReadyFinalCandidate(
    executionId: string,
    requiredAuthoredContextIds: readonly string[],
  ): Promise<IntegrationReadyFinalCandidateOutcome>;
}

function validationGatePassed(
  execution: GraphWorkflowExecution,
  authoredContextId: string,
): boolean {
  const context = execution.workingDefinition.executionContexts.find(
    (candidate) => candidate.id === authoredContextId,
  );
  if (context === undefined) return false;
  const validationRequired =
    context.scriptValidator.commands.length > 0 ||
    context.contextValidator.enabled;
  if (!validationRequired) return true;
  const round = execution.contextStates[authoredContextId]?.validationRound;
  return round?.phase === "concluded" && round.outcome === "passed";
}

function concludedValidationFailure(
  execution: GraphWorkflowExecution,
  authoredContextId: string,
): "script_gate_failed" | "validator_gate_failed" | null {
  const round = execution.contextStates[authoredContextId]?.validationRound;
  if (round?.phase !== "concluded") return null;
  if (round.outcome === "script_failed") return "script_gate_failed";
  if (round.outcome === "failed") {
    return "validator_gate_failed";
  }
  return null;
}

function hasFailedIntegration(
  execution: GraphWorkflowExecution,
  authoredContextId: string,
): boolean {
  const laneId = execution.contextStates[authoredContextId]?.laneId;
  if (laneId === null || laneId === undefined) return false;
  const reachableLaneIds = reachableLanesFrom(laneId, execution);
  return Object.values(execution.joins ?? {}).some(
    (join) =>
      (join.status === "failed" || join.status === "conflicts") &&
      join.sourceLaneIds.some((sourceLaneId) =>
        reachableLaneIds.has(sourceLaneId),
      ),
  );
}

function resolveOutcome(
  located: LocatedGraphWorkflowExecution,
  authoredContextId: string,
): AuthoredContextOutcome {
  const { execution, location: executionLocation } = located;
  const loopMembership = findLoopBodyMembership(
    authoredContextId,
    execution.workingDefinition.loopGroups ?? [],
  );
  if (loopMembership !== null) {
    return {
      status: "failed",
      reason:
        loopMembership.pass === null
          ? "loop_body_template_not_authored_source"
          : "loop_instance_not_authored_source",
      executionLocation,
    };
  }

  if (
    resolveExpansionProvenance(execution.expansionReceipts, authoredContextId)
      ?.nodeKind === "context"
  ) {
    return {
      status: "failed",
      reason: "generated_context_not_authored",
      executionLocation,
    };
  }

  const context = execution.workingDefinition.executionContexts.find(
    (candidate) => candidate.id === authoredContextId,
  );
  if (context === undefined) {
    return {
      status: "failed",
      reason: "authored_context_not_found",
      executionLocation,
    };
  }

  const state = execution.contextStates[authoredContextId];
  if (state === undefined) {
    return {
      status: "failed",
      reason: "context_state_missing",
      executionLocation,
    };
  }
  if (state.status === "skipped") {
    return { status: "skipped", reason: "route_skipped", executionLocation };
  }
  if (execution.status === "aborted") {
    return {
      status: "failed",
      reason: "execution_aborted",
      executionLocation,
    };
  }
  if (execution.status === "halted" || state.status === "halted") {
    return {
      status: "failed",
      reason: "execution_halted",
      executionLocation,
    };
  }
  if (state.status === "awaiting_approval") {
    if (state.pendingApproval?.decision?.type === "rejected") {
      return {
        status: "failed",
        reason: "approval_gate_failed",
        executionLocation,
      };
    }
    return { status: "pending", reason: "approval_pending", executionLocation };
  }
  const validationFailure = concludedValidationFailure(
    execution,
    authoredContextId,
  );
  if (validationFailure !== null) {
    return {
      status: "failed",
      reason: validationFailure,
      executionLocation,
    };
  }
  if (state.status !== "completed") {
    return {
      status: "pending",
      reason: "context_unsettled",
      executionLocation,
    };
  }
  if (!validationGatePassed(execution, authoredContextId)) {
    return {
      status: "failed",
      reason: "validation_gate_failed",
      executionLocation,
    };
  }
  if (
    context.outputSchema !== undefined &&
    execution.contextOutputs[authoredContextId] === undefined
  ) {
    return {
      status: "failed",
      reason: "output_gate_failed",
      executionLocation,
    };
  }
  if (context.placement.mode === "readOnly") {
    return {
      status: "satisfied",
      reason: "read_only_completed",
      executionLocation,
    };
  }

  if (state.landingIntent?.state === "failed") {
    return {
      status: "failed",
      reason: "landing_failed",
      executionLocation,
    };
  }
  if (!isRouteSourceLanded(execution, authoredContextId)) {
    return { status: "pending", reason: "landing_pending", executionLocation };
  }
  if (isUpstreamVisibleToLane(authoredContextId, null, execution)) {
    return {
      status: "satisfied",
      reason: "write_result_integrated",
      executionLocation,
    };
  }
  if (hasFailedIntegration(execution, authoredContextId)) {
    return {
      status: "failed",
      reason: "integration_failed",
      executionLocation,
    };
  }
  return execution.status === "completed"
    ? {
        status: "failed",
        reason: "write_result_not_integrated",
        executionLocation,
      }
    : { status: "pending", reason: "integration_pending", executionLocation };
}

function resolveIntegrationReadyFinalCandidate(
  located: LocatedGraphWorkflowExecution,
  requiredAuthoredContextIds: readonly string[],
): IntegrationReadyFinalCandidateOutcome {
  const { execution, location: executionLocation } = located;
  if (execution.status === "aborted") {
    return {
      status: "failed",
      reason: "execution_aborted",
      executionLocation,
    };
  }
  if (execution.status === "halted") {
    return {
      status: "failed",
      reason: "execution_halted",
      executionLocation,
    };
  }

  const finalPublishJoins = Object.values(execution.joins ?? {}).filter(
    (join) => join.kind === "final_publish",
  );
  if (
    finalPublishJoins.some(
      (join) => join.status === "failed" || join.status === "conflicts",
    )
  ) {
    return {
      status: "failed",
      reason: "final_publish_failed",
      executionLocation,
    };
  }
  if (finalPublishJoins.some((join) => join.status !== "succeeded")) {
    return {
      status: "pending",
      reason: "final_publish_pending",
      executionLocation,
    };
  }
  if (execution.status !== "completed") {
    return {
      status: "pending",
      reason: "execution_unsettled",
      executionLocation,
    };
  }
  if (!landGatedPublishSettlement(execution).settled) {
    return {
      status: "failed",
      reason: "publish_settlement_incomplete",
      executionLocation,
    };
  }

  for (const contextId of new Set(requiredAuthoredContextIds)) {
    const outcome = resolveOutcome(located, contextId);
    if (outcome.status === "pending") {
      return {
        status: "pending",
        reason: "required_claimant_unsettled",
        executionLocation,
      };
    }
    if (outcome.status !== "satisfied") {
      return {
        status: "failed",
        reason: "required_claimant_not_integrated",
        executionLocation,
      };
    }
  }

  return {
    status: "satisfied",
    reason: "integration_ready",
    executionLocation,
  };
}

export function createAuthoredContextOutcomeService(
  deps: AuthoredContextOutcomeServiceDeps,
): AuthoredContextOutcomeService {
  return {
    async getAuthoredContextOutcome(executionId, authoredContextId) {
      const located = await deps.findExecutionById(executionId);
      const outcome: AuthoredContextOutcome =
        located === null
          ? {
              status: "failed",
              reason: "execution_not_found",
              executionLocation: "missing",
            }
          : resolveOutcome(located, authoredContextId);
      logger.debug("graph-workflow.authored-context-outcome.resolved", {
        executionId,
        authoredContextId,
        status: outcome.status,
        reason: outcome.reason,
        executionLocation: outcome.executionLocation,
      });
      return outcome;
    },
    async getIntegrationReadyFinalCandidate(
      executionId,
      requiredAuthoredContextIds,
    ) {
      const located = await deps.findExecutionById(executionId);
      const outcome: IntegrationReadyFinalCandidateOutcome =
        located === null
          ? {
              status: "failed",
              reason: "execution_not_found",
              executionLocation: "missing",
            }
          : resolveIntegrationReadyFinalCandidate(
              located,
              requiredAuthoredContextIds,
            );
      logger.debug("graph-workflow.final-candidate-outcome.resolved", {
        executionId,
        requiredAuthoredContextCount: new Set(requiredAuthoredContextIds).size,
        status: outcome.status,
        reason: outcome.reason,
        executionLocation: outcome.executionLocation,
      });
      return outcome;
    },
  };
}
