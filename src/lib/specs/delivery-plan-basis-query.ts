import {
  loadDeliveryDelta,
  type DeliveryDeltaQueryDeps,
} from "./delivery-delta-query";
import type { DeliveryPlanSeedBasisResult } from "./delivery-plan-seed";
import type {
  Spec,
  SpecCriterionDispositionRow,
  SpecRevisionSnapshot,
} from "./schemas";

/**
 * Assembles the delivery a new plan attempt is measured against. The
 * classification is the read-only delivery-delta projection — this module only
 * resolves which execution each delivered criterion should be attributed to,
 * which the projection deliberately does not persist.
 */
export type DeliveryPlanBasisQueryDeps = DeliveryDeltaQueryDeps;

export async function loadDeliveryPlanSeedBasis(
  deps: DeliveryPlanBasisQueryDeps,
  input: { spec: Spec; pinnedRevision: SpecRevisionSnapshot },
): Promise<DeliveryPlanSeedBasisResult> {
  const delta = await loadDeliveryDelta(deps, {
    spec: input.spec,
    currentApprovedSnapshot: input.pinnedRevision,
  });
  if (!delta.ok) return { ok: false, message: delta.message };

  const compared = delta.projection.comparedExecution;
  if (compared === null) {
    return { ok: true, basis: { comparedExecutionId: null, criteria: [] } };
  }
  const rows = new Map(
    deps
      .findCriterionDispositionsByExecution(compared.executionId)
      .map((row) => [row.criterion_element_id, row]),
  );
  return {
    ok: true,
    basis: {
      comparedExecutionId: compared.executionId,
      criteria: delta.projection.criteria.map((criterion) => ({
        criterionElementId: criterion.criterionElementId,
        deliveryClass: criterion.class,
        deliveredByExecutionId: attributedDelivery(
          rows.get(criterion.criterionElementId),
          compared.executionId,
        ),
      })),
    },
  };
}

/**
 * A criterion the compared run itself proved is attributed to that run; one it
 * carried as `delivered_elsewhere` keeps the earlier execution that proved it,
 * so a chain of carried-forward deliveries never loses the run that holds the
 * evidence.
 */
function attributedDelivery(
  row: SpecCriterionDispositionRow | undefined,
  comparedExecutionId: string,
): string | null {
  if (row === undefined) return null;
  return row.delivered_by_execution_id ?? comparedExecutionId;
}
