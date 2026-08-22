import type { GraphWorkflowStatus } from "@/lib/workflow-graph/definition-schemas";
import type {
  GraphWorkflowAbandonment,
  GraphWorkflowDefinitionApproval,
  GraphWorkflowHaltReason,
} from "@/lib/workflow-graph/schemas";
import {
  awaitsDefinitionApproval,
  holdsExecutionLease,
} from "@/lib/workflow-graph/lifecycle-classifier";

/**
 * The execution page's control matrix (design README §9), as a pure function.
 *
 * One table rather than a predicate per button: the previous bar computed
 * `showPause`/`showResume`/`showAbort`/`showAbandon` independently, so no single
 * place stated what a state offers and the definition decision lived in a
 * separate banner that duplicated the lease question. Tenure — not terminality —
 * is what admits a control, and tenure is `holdsExecutionLease`, so this reads
 * the same classifier the rail's Current/History split does.
 */

export type ExecutionControlKind =
  | "pause"
  | "resume"
  | "abort"
  | "abandon"
  | "approve-definition"
  | "reject-definition";

export interface ExecutionControlConfirm {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
}

export interface ExecutionControlDescriptor {
  readonly kind: ExecutionControlKind;
  readonly idleLabel: string;
  readonly pendingLabel: string;
  readonly variant: "default" | "primary" | "danger" | "success";
  /** Non-null for a destructive act: the prompt shown before it fires. */
  readonly confirm: ExecutionControlConfirm | null;
  /**
   * Non-null when the state admits this control but a precondition the operator
   * has not met yet withholds it. Hosts render it disabled — never omitted: a
   * missing Resume reads as "this run is over", while an enabled one contradicts
   * the card that explains what is still unrepaired.
   */
  readonly blockedReason: string | null;
}

export interface ExecutionControlInput {
  readonly status: GraphWorkflowStatus;
  readonly haltReason: GraphWorkflowHaltReason | null;
  readonly abandonment: GraphWorkflowAbandonment | null;
  readonly definitionApproval: GraphWorkflowDefinitionApproval | null;
  /** False for a historical selection — History never gains controls. */
  readonly allowActions: boolean;
  /** Whether the page wired an abandon mutation for this selection. */
  readonly canAbandon: boolean;
  /** Whether the page wired the definition approve/reject mutations. */
  readonly canDecideDefinition: boolean;
  /**
   * Why a resume this state would otherwise offer cannot be taken yet — the
   * output-schema halt's unrepaired contract is the one case today. Null when
   * nothing withholds it. Held here rather than decided by each host so the
   * status bar, the halt-details dialog and the halt card cannot disagree about
   * whether the run may be resumed.
   */
  readonly resumeBlockedReason: string | null;
}

const PAUSE: ExecutionControlDescriptor = {
  kind: "pause",
  idleLabel: "Pause",
  pendingLabel: "Pausing…",
  variant: "default",
  confirm: null,
  blockedReason: null,
};

const RESUME: ExecutionControlDescriptor = {
  kind: "resume",
  idleLabel: "Resume",
  pendingLabel: "Resuming…",
  variant: "primary",
  confirm: null,
  blockedReason: null,
};

const ABORT: ExecutionControlDescriptor = {
  kind: "abort",
  idleLabel: "Abort",
  pendingLabel: "Aborting…",
  variant: "danger",
  confirm: {
    title: "Abort workflow execution?",
    message:
      "Stop this execution and move it to History. It cannot be resumed afterwards.",
    confirmLabel: "Abort execution",
  },
  blockedReason: null,
};

const ABANDON: ExecutionControlDescriptor = {
  kind: "abandon",
  idleLabel: "Abandon",
  pendingLabel: "Abandoning…",
  variant: "danger",
  confirm: {
    title: "Abandon halted execution?",
    message:
      "End this resumably halted execution's lease and move it to History.",
    confirmLabel: "Abandon execution",
  },
  blockedReason: null,
};

const APPROVE_DEFINITION: ExecutionControlDescriptor = {
  kind: "approve-definition",
  idleLabel: "Approve",
  pendingLabel: "Approving…",
  variant: "success",
  confirm: null,
  blockedReason: null,
};

const REJECT_DEFINITION: ExecutionControlDescriptor = {
  kind: "reject-definition",
  idleLabel: "Reject",
  pendingLabel: "Rejecting…",
  variant: "danger",
  confirm: {
    title: "Reject workflow definition?",
    message: "Reject this parked definition and move the execution to History.",
    confirmLabel: "Reject definition",
  },
  blockedReason: null,
};

export function resolveExecutionControls(
  input: ExecutionControlInput,
): ExecutionControlDescriptor[] {
  if (!input.allowActions) return [];

  // The definition gate replaces the ordinary controls rather than adding to
  // them: rejection is the way out of a parked plan, and it is what moves the
  // run to History (README §10), so a second ending act would only offer a
  // less-audited version of the same outcome.
  if (awaitsDefinitionApproval(input.status, input.definitionApproval)) {
    return input.canDecideDefinition
      ? [APPROVE_DEFINITION, REJECT_DEFINITION]
      : [];
  }

  if (!holdsExecutionLease(input.status, input.haltReason, input.abandonment)) {
    return [];
  }

  const resume =
    input.resumeBlockedReason === null
      ? RESUME
      : {
          ...RESUME,
          idleLabel: `Resume — ${input.resumeBlockedReason}`,
          blockedReason: input.resumeBlockedReason,
        };

  switch (input.status) {
    case "pending":
      return [ABORT];
    case "running":
      return [PAUSE, ABORT];
    case "paused":
      return [resume, ABORT];
    case "halted":
      return input.canAbandon ? [resume, ABANDON] : [resume];
    default:
      // `completed` and `aborted` never hold the lease, so the guard above has
      // already returned for them.
      return [];
  }
}
