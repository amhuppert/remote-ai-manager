import { getGlobalSingleton } from "@/lib/shared/global-singleton";

const EXECUTION_LIFECYCLE_PORT_KEY =
  "__cc_graph_execution_lifecycle_port" as const;

/**
 * A registered consumer's verdict on recording a pending definition approval.
 * Refusals carry the machine-readable shape route surfaces relay verbatim.
 */
export type DefinitionApprovalGateDecision =
  | { ok: true }
  | {
      ok: false;
      code: string;
      unmetConditions: string[];
      instruction: string;
    };

export interface GraphExecutionLifecycleCallbacks {
  /**
   * Reports a started workflow execution. `definitionId` identifies the
   * definition the execution started from so a registered consumer can
   * correlate the start with work it prepared under that definition — the
   * workflow machinery stays ignorant of who is listening.
   */
  markRunning(
    workflowExecutionId: string,
    definitionId?: string,
  ): Promise<void>;
  markDelivered(workflowExecutionId: string, mergeHash: string): Promise<void>;
  /**
   * Reports an execution that started but parked awaiting definition
   * approval, so a registered consumer can open its own review request for
   * the pending definition (e.g. surface the waiting gate for humans).
   */
  awaitingDefinitionApproval?(
    workflowExecutionId: string,
    definitionId: string,
  ): Promise<void>;
  /**
   * Consulted before a pending definition approval is recorded. A registered
   * consumer records its own side of the admission for definitions it
   * prepared (the caller has already established human transport) or refuses
   * with a machine-readable reason; definitions no consumer claims admit by
   * default.
   */
  admitDefinitionApproval?(
    workflowExecutionId: string,
    definitionId: string,
  ): Promise<DefinitionApprovalGateDecision>;
  /**
   * Reports an execution that was aborted, so a registered consumer can
   * terminalize work it pinned to the run (e.g. abandon a spec execution)
   * without waiting for a read-path reconcile.
   */
  executionAborted?(workflowExecutionId: string): Promise<void>;
}

interface GraphExecutionLifecyclePortState {
  callbacks: GraphExecutionLifecycleCallbacks | null;
}

function state(): GraphExecutionLifecyclePortState {
  return getGlobalSingleton(EXECUTION_LIFECYCLE_PORT_KEY, () => ({
    callbacks: null,
  }));
}

export function registerGraphExecutionLifecycleCallbacks(
  callbacks: GraphExecutionLifecycleCallbacks,
): void {
  state().callbacks = callbacks;
}

export function createRegisteredGraphExecutionLifecycleCallbacks(): GraphExecutionLifecycleCallbacks {
  return {
    async markRunning(workflowExecutionId, definitionId) {
      const callbacks = state().callbacks;
      if (callbacks === null) {
        throw new Error(
          "Graph execution lifecycle callbacks are not registered",
        );
      }
      await callbacks.markRunning(workflowExecutionId, definitionId);
    },
    async markDelivered(workflowExecutionId, mergeHash) {
      const callbacks = state().callbacks;
      if (callbacks === null) {
        throw new Error(
          "Graph execution lifecycle callbacks are not registered",
        );
      }
      await callbacks.markDelivered(workflowExecutionId, mergeHash);
    },
    // The definition-approval callbacks are optional interest: with no
    // registered consumer (or one that doesn't implement them) a park is
    // unreported and an approval admits by default.
    async awaitingDefinitionApproval(workflowExecutionId, definitionId) {
      await state().callbacks?.awaitingDefinitionApproval?.(
        workflowExecutionId,
        definitionId,
      );
    },
    async admitDefinitionApproval(workflowExecutionId, definitionId) {
      const callbacks = state().callbacks;
      if (callbacks?.admitDefinitionApproval === undefined) {
        return { ok: true };
      }
      return callbacks.admitDefinitionApproval(
        workflowExecutionId,
        definitionId,
      );
    },
    async executionAborted(workflowExecutionId) {
      await state().callbacks?.executionAborted?.(workflowExecutionId);
    },
  };
}

export function resetGraphExecutionLifecycleCallbacksForTesting(): void {
  state().callbacks = null;
}
