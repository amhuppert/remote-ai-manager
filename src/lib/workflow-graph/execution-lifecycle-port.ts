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

export interface GraphExecutionLifecycleContext {
  projectPath: string;
  sessionName: string;
}

export interface GraphExecutionLifecycleCallbacks {
  /**
   * Reports a started workflow execution. The definition identity lets a
   * registered consumer correlate the start with the exact immutable revision
   * it prepared while the workflow machinery stays ignorant of who listens.
   */
  markRunning(
    context: GraphExecutionLifecycleContext,
    workflowExecutionId: string,
    definitionId?: string,
    definitionRevision?: number,
  ): Promise<void>;
  markDelivered(workflowExecutionId: string, mergeHash: string): Promise<void>;
  /**
   * Reports an execution that started but parked awaiting definition
   * approval, so a registered consumer can open its own review request for
   * the pending definition (e.g. surface the waiting gate for humans).
   */
  awaitingDefinitionApproval?(
    context: GraphExecutionLifecycleContext,
    workflowExecutionId: string,
    definitionId: string,
    definitionRevision: number,
  ): Promise<void>;
  /**
   * Consulted before a pending definition approval is recorded. A registered
   * consumer records its own side of the admission for definitions it
   * prepared (the caller has already established human transport) or refuses
   * with a machine-readable reason; definitions no consumer claims admit by
   * default.
   */
  admitDefinitionApproval?(
    context: GraphExecutionLifecycleContext,
    workflowExecutionId: string,
    definitionId: string,
    definitionRevision: number,
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
    async markRunning(
      context,
      workflowExecutionId,
      definitionId,
      definitionRevision,
    ) {
      const callbacks = state().callbacks;
      if (callbacks === null) {
        throw new Error(
          "Graph execution lifecycle callbacks are not registered",
        );
      }
      await callbacks.markRunning(
        context,
        workflowExecutionId,
        definitionId,
        definitionRevision,
      );
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
    async awaitingDefinitionApproval(
      context,
      workflowExecutionId,
      definitionId,
      definitionRevision,
    ) {
      await state().callbacks?.awaitingDefinitionApproval?.(
        context,
        workflowExecutionId,
        definitionId,
        definitionRevision,
      );
    },
    async admitDefinitionApproval(
      context,
      workflowExecutionId,
      definitionId,
      definitionRevision,
    ) {
      const callbacks = state().callbacks;
      if (callbacks?.admitDefinitionApproval === undefined) {
        return { ok: true };
      }
      return callbacks.admitDefinitionApproval(
        context,
        workflowExecutionId,
        definitionId,
        definitionRevision,
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
