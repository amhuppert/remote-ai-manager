import type { GraphWorkflowExecutionOrigin } from "./schemas";

/**
 * The composition's verdict on recording a pending definition approval.
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
   * execution id so the consumer can correlate the start — by the immutable definition revision it prepared, or
   * not at all for a run authored inline — while the workflow machinery stays
   * ignorant of who listens. One-off runs have no saved definition identity.
   */
  markRunning(
    context: GraphExecutionLifecycleContext,
    workflowExecutionId: string,
    origin?: GraphWorkflowExecutionOrigin,
  ): Promise<void>;
  markDelivered(workflowExecutionId: string, mergeHash: string): Promise<void>;
  /**
   * Reports an execution that started but parked awaiting definition
   * approval, so a consumer can open its own review request for
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
   * addressed act. A consumer records its own side of the admission
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
   * Reports an execution that was aborted, so a consumer can
   * terminalize work it pinned to the run (e.g. abandon a spec execution)
   * without waiting for a read-path reconcile.
   */
  executionAborted?(workflowExecutionId: string): Promise<void>;
}
