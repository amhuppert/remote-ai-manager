import { createLogger } from "@/lib/logging";
import type {
  MergeAssociationResolution,
  MergeAssociationResolver,
} from "@/lib/workflows/merge/association-port";
import type { SpecExecutionRow } from "./schemas";

const logger = createLogger("specs.merge-association");

export interface MergeAssociationResolverDeps {
  findActiveExecutionsBySessionName(
    projectPath: string,
    sessionName: string,
  ): SpecExecutionRow[];
  /** The branch the session delivers to (its configured merge target). */
  getSessionTargetBranch(
    projectPath: string,
    sessionName: string,
  ): string | null;
}

/**
 * The MA2 association rule: a fresh user merge of a session that hosts exactly
 * one running spec execution carries that execution's workflow provenance; a
 * not-started or ambiguous association refuses at dispatch, before any merge
 * job exists. finalPublish is true only when the merge targets the session's
 * delivery branch — an egress merge to any other branch is still gated
 * (linked) but never marks Delivered.
 */
export function createMergeAssociationResolver(
  deps: MergeAssociationResolverDeps,
): MergeAssociationResolver {
  return {
    resolve(input) {
      const active = deps.findActiveExecutionsBySessionName(
        input.projectPath,
        input.sessionName,
      );
      const resolution = decide(active, input.sessionName, () => {
        if (input.targetBranch === undefined) return true;
        const deliveryTarget = deps.getSessionTargetBranch(
          input.projectPath,
          input.sessionName,
        );
        return deliveryTarget !== null && input.targetBranch === deliveryTarget;
      });
      logger.info("merge.association", {
        projectName: input.projectName,
        sessionName: input.sessionName,
        targetBranch: input.targetBranch ?? null,
        outcome:
          resolution.kind !== "refused"
            ? resolution.kind
            : active.length > 1
              ? "refused_ambiguous"
              : "refused_not_started",
        ...(resolution.kind === "linked" && {
          executionId: resolution.executionId,
          finalPublish: resolution.finalPublish,
        }),
        candidateExecutionIds: active.map((execution) => execution.id),
        basis: {
          activeExecutionCount: active.length,
          activeExecutions: active.map((execution) => ({
            specExecutionId: execution.id,
            state: execution.state,
            workflowExecutionId: execution.workflow_execution_id,
          })),
        },
      });
      return resolution;
    },
  };
}

function decide(
  active: SpecExecutionRow[],
  sessionName: string,
  isDeliveryTarget: () => boolean,
): MergeAssociationResolution {
  if (active.length === 0) return { kind: "none" };

  if (active.length > 1) {
    const ids = active.map((execution) => execution.id).join(", ");
    return {
      kind: "refused",
      reason: `Session "${sessionName}" hosts ${active.length} active spec executions (${ids}); merge association is ambiguous.`,
      instruction:
        "Deliver, complete, or abandon the other executions so exactly one remains, then retry the merge.",
    };
  }

  const execution = active[0];
  if (execution === undefined) return { kind: "none" };
  if (
    execution.state !== "running" ||
    execution.workflow_execution_id === null
  ) {
    const stateLabel =
      execution.state === "definition_review"
        ? "definition review"
        : `state ${execution.state} with no linked workflow execution`;
    return {
      kind: "refused",
      reason: `Session "${sessionName}" hosts spec execution ${execution.id} in ${stateLabel}; the delivery gate cannot evaluate it.`,
      instruction:
        "Start the execution (approve and launch its workflow definition) or abandon it in Spec Studio, then retry the merge.",
    };
  }

  return {
    kind: "linked",
    executionId: execution.workflow_execution_id,
    finalPublish: isDeliveryTarget(),
  };
}
