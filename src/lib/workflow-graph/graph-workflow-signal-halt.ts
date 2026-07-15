import { createLogger } from "@/lib/logging";
import { transitionContextStatus } from "@/lib/workflow-graph/context-transitions";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
} from "@/lib/workflow-graph/schemas";
import type {
  RecordPendingHaltReasonInput,
  RecordPendingHaltReasonResult,
} from "@/lib/workflow-graph/workflow-manager";

interface GraphWorkflowSignalHaltManager {
  recordPendingHaltReason(
    input: RecordPendingHaltReasonInput,
  ): Promise<RecordPendingHaltReasonResult>;
}

interface GraphWorkflowSignalHaltInput {
  projectPath: string;
  sessionName: string;
  contextId?: string;
  reason: GraphWorkflowHaltReason;
}

const logger = createLogger("graph-workflow-signal-halt");

function getReasonContextId(reason: GraphWorkflowHaltReason): string | null {
  return "contextId" in reason ? reason.contextId : null;
}

export function createGraphWorkflowSignalHaltHandler(
  workflowManager: GraphWorkflowSignalHaltManager,
): (input: GraphWorkflowSignalHaltInput) => Promise<GraphWorkflowExecution> {
  return async function signalHalt(input) {
    const contextId = input.contextId ?? getReasonContextId(input.reason);
    const result = await workflowManager.recordPendingHaltReason({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      reason: input.reason,
      applyAdditionalMutation(execution) {
        if (!contextId) return;

        const contextState = execution.contextStates[contextId];
        if (contextState && contextState.status !== "completed") {
          transitionContextStatus(execution, contextId, "halted", {
            reason: `signal_halt.${input.reason.type}`,
          });
        }
        execution.activeContextIds = execution.activeContextIds.filter(
          (activeContextId) => activeContextId !== contextId,
        );
      },
    });

    logger.info("graph-workflow.parallel.context_halt_recorded", {
      executionId: result.execution.id,
      contextId,
      haltReasonType: input.reason.type,
      accepted: result.accepted,
    });

    return result.execution;
  };
}
