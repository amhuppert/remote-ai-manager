import { getContextOutput } from "@/lib/workflow-graph/context-outputs";
import {
  classifyContextLifecycle,
  classifyExecutionEditability,
  holdsExecutionLease,
} from "@/lib/workflow-graph/lifecycle-classifier";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { ConfigAffordance, ConfigReadOnlyReason } from "./types";

/**
 * What the execution page may offer for ONE context's configuration
 * (design README §8.1, and the execution prototype's E2 config column).
 *
 * Nothing about editability is decided here: the verdict composes the two
 * canonical classifiers the server's own edit guard consumes — the
 * execution-level gate and the per-context lifecycle — so the panel offers
 * exactly what the runtime-edit endpoint would accept, and only when it would.
 * What this module adds is the panel's third fact, which no classifier carries:
 * whether the output contract is still changeable.
 */

export interface ConfigAffordanceVerdict {
  affordance: ConfigAffordance;
  /** Present only for `read-only`; the classifier's own reason, unaltered. */
  readOnlyReason: ConfigReadOnlyReason | null;
  /**
   * The output schema is frozen INDEPENDENTLY of the mode: once a payload was
   * captured against the contract, editing it would not re-validate anything
   * that already banked (§8.1). An otherwise editable context therefore still
   * gets a locked schema editor.
   */
  schemaFrozen: boolean;
}

function readOnly(reason: ConfigReadOnlyReason): ConfigAffordanceVerdict {
  return {
    affordance: "read-only",
    readOnlyReason: reason,
    schemaFrozen: false,
  };
}

export function classifyConfigAffordance(
  execution: GraphWorkflowExecution,
  contextId: string,
): ConfigAffordanceVerdict {
  const editability = classifyExecutionEditability(execution);
  if (editability.kind === "not-editable") return readOnly(editability.reason);
  // A resumable halt whose lease has been ABANDONED keeps its editable verdict
  // from the classifier — abandonment is a tenure fact, not an engine one — but
  // E2 files that run under History with the non-resumable reason. The lease
  // predicate is asked rather than restated so the two surfaces cannot drift.
  if (
    !holdsExecutionLease(
      execution.status,
      execution.haltReason,
      execution.abandonment,
    )
  ) {
    return readOnly("halt-not-resumable");
  }

  const context = execution.workingDefinition.executionContexts.find(
    (candidate) => candidate.id === contextId,
  );
  // A context the working definition does not hold has no configuration to
  // offer, and guessing `editable` would hand an author a save the frontier
  // would refuse. `completed` is the reason with no claim about this run's
  // state — but no banner is better than a wrong one, so it says the run is
  // over rather than inventing a fifth reason.
  if (context === undefined) return readOnly("completed");

  // "Captured", never "pending" or "rejected": a refused candidate leaves the
  // contract owed, which is exactly when repairing it still means something.
  const schemaFrozen =
    getContextOutput(execution, contextId).kind === "captured";

  const lifecycle = classifyContextLifecycle(execution, contextId);
  if (lifecycle === "frozen") {
    return { affordance: "frozen", readOnlyReason: null, schemaFrozen };
  }
  if (lifecycle === "unstarted") {
    return { affordance: "editable", readOnlyReason: null, schemaFrozen };
  }
  // `started` — editable only while the execution is quiescent.
  return {
    affordance: editability.quiescent ? "editable" : "pause-to-edit",
    readOnlyReason: null,
    schemaFrozen,
  };
}
