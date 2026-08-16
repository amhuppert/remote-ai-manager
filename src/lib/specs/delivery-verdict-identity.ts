import type { LinkedSpecExecutionBindingV2 } from "./execution-binding";
import type { SpecDeliveryVerdictRow, SpecExecutionRow } from "./schemas";

/**
 * Delivery consumers accept a verdict only through the immutable execution
 * link. This keeps projections on the same candidate bytes the gate evaluated
 * even when persistence contains historical or conflicting rows.
 */
export function deliveryVerdictMatchesExecutionBinding(
  verdict: SpecDeliveryVerdictRow,
  execution: SpecExecutionRow,
  linkedBinding: LinkedSpecExecutionBindingV2 | null,
  criterionElementId: string = verdict.criterion_element_id,
): boolean {
  if (
    linkedBinding === null ||
    execution.workflow_execution_id === null ||
    linkedBinding.specExecutionId !== execution.id ||
    linkedBinding.workflowExecutionId !== execution.workflow_execution_id ||
    linkedBinding.binding.pinnedRevisionId !== execution.revision_id
  ) {
    return false;
  }

  return (
    verdict.spec_execution_id === execution.id &&
    verdict.workflow_execution_id === linkedBinding.workflowExecutionId &&
    verdict.candidate_id === linkedBinding.binding.candidateId &&
    verdict.candidate_hash === linkedBinding.binding.candidateHash &&
    verdict.criterion_element_id === criterionElementId &&
    verdict.satisfying_context_id.length > 0
  );
}

export function findDeliveryVerdictForExecution(
  verdicts: readonly SpecDeliveryVerdictRow[],
  execution: SpecExecutionRow,
  linkedBinding: LinkedSpecExecutionBindingV2 | null,
  criterionElementId: string,
): SpecDeliveryVerdictRow | null {
  return (
    verdicts.find((verdict) =>
      deliveryVerdictMatchesExecutionBinding(
        verdict,
        execution,
        linkedBinding,
        criterionElementId,
      ),
    ) ?? null
  );
}
