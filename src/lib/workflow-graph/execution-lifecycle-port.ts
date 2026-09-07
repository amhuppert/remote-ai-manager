import { getGlobalSingleton } from "@/lib/shared/global-singleton";
import type { GraphWorkflowExecutionOrigin } from "@/lib/workflow-graph/schemas";

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
   * Reports a started workflow execution. The recorded ORIGIN travels with the
   * execution id so a registered consumer can decide for itself how to
   * correlate the start — by the immutable definition revision it prepared, or
   * not at all for a run authored inline — while the workflow machinery stays
   * ignorant of who listens. The seed fields never appear here: on a one-off
   * row they are legacy-shaped filler naming a definition that does not exist.
   */
  markRunning(
    context: GraphExecutionLifecycleContext,
    workflowExecutionId: string,
    origin?: GraphWorkflowExecutionOrigin,
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
    origin: GraphWorkflowExecutionOrigin,
  ): Promise<void>;
  /**
   * Consulted before a pending definition approval is recorded — for EVERY
   * parked run, whatever its origin, because approval is one execution-
   * addressed act. A registered consumer records its own side of the admission
   * for work it prepared (the caller has already established human transport)
   * or refuses with a machine-readable reason; a park no consumer claims
   * admits by default.
   */
  admitDefinitionApproval?(
    context: GraphExecutionLifecycleContext,
    workflowExecutionId: string,
    origin: GraphWorkflowExecutionOrigin,
  ): Promise<DefinitionApprovalGateDecision>;
  /**
   * Reports an execution that was aborted, so a registered consumer can
   * terminalize work it pinned to the run (e.g. abandon a spec execution)
   * without waiting for a read-path reconcile.
   */
  executionAborted?(workflowExecutionId: string): Promise<void>;
}

interface GraphExecutionLifecyclePortState {
  callbacks: Required<GraphExecutionLifecycleCallbacks> | null;
}

function state(): GraphExecutionLifecyclePortState {
  return getGlobalSingleton(EXECUTION_LIFECYCLE_PORT_KEY, () => ({
    callbacks: null,
  }));
}

async function ignoreUnclaimedExecution(): Promise<void> {}
async function admitUnclaimedDefinition(): Promise<DefinitionApprovalGateDecision> {
  return { ok: true };
}

export function normalizeGraphExecutionLifecycleCallbacks(
  callbacks: GraphExecutionLifecycleCallbacks,
): Required<GraphExecutionLifecycleCallbacks> {
  return {
    markRunning: callbacks.markRunning,
    markDelivered: callbacks.markDelivered,
    awaitingDefinitionApproval:
      callbacks.awaitingDefinitionApproval ?? ignoreUnclaimedExecution,
    admitDefinitionApproval:
      callbacks.admitDefinitionApproval ?? admitUnclaimedDefinition,
    executionAborted: callbacks.executionAborted ?? ignoreUnclaimedExecution,
  };
}

export function assertGraphExecutionLifecycleCallbacksRegistered(): void {
  if (state().callbacks === null)
    throw new Error("Graph execution lifecycle callbacks are not registered");
}

export function registerGraphExecutionLifecycleCallbacks(
  callbacks: GraphExecutionLifecycleCallbacks,
): void {
  state().callbacks = normalizeGraphExecutionLifecycleCallbacks(callbacks);
}

export function createRegisteredGraphExecutionLifecycleCallbacks(): GraphExecutionLifecycleCallbacks {
  return {
    async markRunning(context, workflowExecutionId, origin) {
      const callbacks = state().callbacks;
      if (callbacks === null) {
        throw new Error(
          "Graph execution lifecycle callbacks are not registered",
        );
      }
      await callbacks.markRunning(context, workflowExecutionId, origin);
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
    async awaitingDefinitionApproval(context, workflowExecutionId, origin) {
      await state().callbacks?.awaitingDefinitionApproval?.(
        context,
        workflowExecutionId,
        origin,
      );
    },
    async admitDefinitionApproval(context, workflowExecutionId, origin) {
      const callbacks = state().callbacks;
      if (callbacks?.admitDefinitionApproval === undefined) {
        return { ok: true };
      }
      return callbacks.admitDefinitionApproval(
        context,
        workflowExecutionId,
        origin,
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
