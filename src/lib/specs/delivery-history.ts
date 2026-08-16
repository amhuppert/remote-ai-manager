import type { SpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import type { SpecCriterionDispositionRow, SpecExecutionRow } from "./schemas";

export type EarlierMergedDeliveryVerdict =
  | { readonly code: "accepted"; readonly baseExecutionId: string }
  | { readonly code: "missing_base"; readonly baseExecutionId: null }
  | { readonly code: "self_reference"; readonly baseExecutionId: string }
  | { readonly code: "unknown_base"; readonly baseExecutionId: string }
  | { readonly code: "foreign_spec"; readonly baseExecutionId: string }
  | { readonly code: "not_merged"; readonly baseExecutionId: string }
  | { readonly code: "not_earlier"; readonly baseExecutionId: string }
  | { readonly code: "base_did_not_deliver"; readonly baseExecutionId: string };

export function classifyEarlierMergedDelivery(
  repo: Pick<
    SpecDeliveryRepo,
    "findExecutionById" | "findCriterionDisposition"
  >,
  execution: Pick<SpecExecutionRow, "id" | "spec_id" | "created_at">,
  disposition: Pick<
    SpecCriterionDispositionRow,
    "criterion_element_id" | "delivered_by_execution_id"
  >,
): EarlierMergedDeliveryVerdict {
  const priorId = disposition.delivered_by_execution_id;
  if (priorId === null) return { code: "missing_base", baseExecutionId: null };
  if (priorId === execution.id) {
    return { code: "self_reference", baseExecutionId: priorId };
  }
  const prior = repo.findExecutionById(priorId);
  if (prior === null) {
    return { code: "unknown_base", baseExecutionId: priorId };
  }
  if (prior.spec_id !== execution.spec_id) {
    return { code: "foreign_spec", baseExecutionId: priorId };
  }
  if (prior.state !== "delivered" || prior.delivered_at === null) {
    return { code: "not_merged", baseExecutionId: priorId };
  }
  if (
    prior.created_at >= execution.created_at ||
    prior.delivered_at > execution.created_at
  ) {
    return { code: "not_earlier", baseExecutionId: priorId };
  }
  const priorDisposition = repo.findCriterionDisposition(
    prior.id,
    disposition.criterion_element_id,
  );
  return priorDisposition?.delivered_by_execution_id === prior.id
    ? { code: "accepted", baseExecutionId: priorId }
    : { code: "base_did_not_deliver", baseExecutionId: priorId };
}

export function isEarlierMergedDelivery(
  repo: Pick<
    SpecDeliveryRepo,
    "findExecutionById" | "findCriterionDisposition"
  >,
  execution: SpecExecutionRow,
  disposition: SpecCriterionDispositionRow,
): boolean {
  return (
    classifyEarlierMergedDelivery(repo, execution, disposition).code ===
    "accepted"
  );
}
