import type { WorkflowDefinitionMutation } from "@/lib/workflow-graph/definition-schemas";

import {
  NATIVE_SDD_CLAIMS_SOURCE_ID,
  NATIVE_SDD_PINNED_SPEC_SOURCE_ID,
  deliveryPlanDocumentSchema,
  type DeliveryPlanBinding,
  type DeliveryPlanDocument,
} from "./delivery-plan";
import type { CriterionDeliveryClass } from "./delivery-delta";

const RESERVED_SOURCE_IDS = new Set([
  NATIVE_SDD_PINNED_SPEC_SOURCE_ID,
  NATIVE_SDD_CLAIMS_SOURCE_ID,
]);
const RESERVED_SOURCE_LOCATOR_PREFIXES = [
  ".cc/graph-workflow-docs/spec/",
  ".cc/graph-workflow-docs/spec-bindings/",
] as const;

/**
 * The only thing a new attempt can seed from: a finalized version-2 candidate.
 * There is no translation from an older dialect — a spec with nothing to copy
 * opens an unseeded draft and authors its launch.
 */
export interface DeliveryPlanSeedSource {
  readonly candidateId: string;
  readonly launch: WorkflowDefinitionMutation;
  readonly binding: DeliveryPlanBinding;
}

/** One pinned criterion as the compared delivery left it. */
export interface DeliveryPlanSeedBasisCriterion {
  readonly criterionElementId: string;
  readonly deliveryClass: CriterionDeliveryClass;
  /** The execution whose delivery proved it, or null when none did. */
  readonly deliveredByExecutionId: string | null;
}

/**
 * The delivery a new attempt is measured against: the compared execution and
 * how that delivery left each pinned criterion. Assembled from the read-only
 * delivery-delta projection, never from a persisted classification.
 */
export interface DeliveryPlanSeedBasis {
  readonly comparedExecutionId: string | null;
  readonly criteria: readonly DeliveryPlanSeedBasisCriterion[];
}

export type DeliveryPlanSeedBasisResult =
  | { readonly ok: true; readonly basis: DeliveryPlanSeedBasis }
  | { readonly ok: false; readonly message: string };

/**
 * Total over the pinned revision: every criterion gets exactly one disposition,
 * derived from the delivery delta rather than carried forward from the previous
 * candidate. A criterion the last delivery proved and nothing has invalidated
 * auto-proposes `delivered_elsewhere` against the execution that proved it; one
 * whose governing content moved becomes `pending_reaffirmation`, which a draft
 * may carry and a proposal may not; a criterion whose own text moved, one never
 * delivered, and one the last plan deferred are selected again; an honoured
 * waiver stays waived. A criterion the compared delivery never saw is new work
 * and is selected.
 */
export function seedDispositionsFromDelivery(input: {
  readonly basis: DeliveryPlanSeedBasis;
  readonly pinnedCriterionElementIds: readonly string[];
}): DeliveryPlanBinding["dispositions"] {
  const byCriterion = new Map(
    input.basis.criteria.map((entry) => [entry.criterionElementId, entry]),
  );
  return input.pinnedCriterionElementIds.map((criterionElementId) => {
    const measured = byCriterion.get(criterionElementId);
    const selected = {
      criterionElementId,
      disposition: "in_scope" as const,
      deliveredByExecutionId: null,
    };
    if (measured === undefined) return selected;
    switch (measured.deliveryClass) {
      case "delivered_and_fresh":
        return {
          criterionElementId,
          disposition: "delivered_elsewhere" as const,
          deliveredByExecutionId: requireDelivery(measured),
        };
      case "soft_stale":
        return {
          criterionElementId,
          disposition: "pending_reaffirmation" as const,
          deliveredByExecutionId: requireDelivery(measured),
        };
      case "waived":
        return {
          criterionElementId,
          disposition: "waived" as const,
          deliveredByExecutionId: null,
        };
      case "hard_stale":
      case "never_delivered":
      case "deferred":
        return selected;
    }
  });
}

/**
 * A disposition that stands on an earlier delivery must name it: the delivery
 * gate resolves the attribution, and a null would silently become an unproven
 * exclusion at gate time.
 */
function requireDelivery(criterion: DeliveryPlanSeedBasisCriterion): string {
  if (criterion.deliveredByExecutionId === null) {
    throw new Error(
      `Criterion ${criterion.criterionElementId} is ${criterion.deliveryClass} but names no delivering execution, so its disposition cannot be attributed.`,
    );
  }
  return criterion.deliveredByExecutionId;
}

export function seedDeliveryPlanFromLast(input: {
  readonly source: DeliveryPlanSeedSource;
  readonly dispositions: DeliveryPlanBinding["dispositions"];
}): DeliveryPlanDocument {
  const launch = structuredClone(input.source.launch);
  const {
    approvalRequired: _approvalRequired,
    lockedRegions: _lockedRegions,
    origin: _origin,
    ...definition
  } = launch.definition;
  const reservedRanks = definition.charter.sourcesOfTruth.flatMap((source) =>
    RESERVED_SOURCE_IDS.has(source.id) ||
    RESERVED_SOURCE_LOCATOR_PREFIXES.some((prefix) =>
      source.locator.startsWith(prefix),
    )
      ? [source.rank]
      : [],
  );
  const sourcesOfTruth = definition.charter.sourcesOfTruth
    .filter(
      (source) =>
        !RESERVED_SOURCE_IDS.has(source.id) &&
        !RESERVED_SOURCE_LOCATOR_PREFIXES.some((prefix) =>
          source.locator.startsWith(prefix),
        ),
    )
    .map((source) => ({
      ...source,
      rank:
        source.rank - reservedRanks.filter((rank) => rank < source.rank).length,
    }));
  const selectedCriteria = new Set(
    input.dispositions
      .filter((disposition) => disposition.disposition === "in_scope")
      .map((disposition) => disposition.criterionElementId),
  );
  const claims = input.source.binding.claims.flatMap((claim) => {
    const criterionElementIds = claim.criterionElementIds.filter((id) =>
      selectedCriteria.has(id),
    );
    return criterionElementIds.length === 0
      ? []
      : [{ contextId: claim.contextId, criterionElementIds }];
  });

  return deliveryPlanDocumentSchema.parse({
    schemaVersion: 2,
    launch: {
      ...launch,
      definition: {
        ...definition,
        charter: {
          ...definition.charter,
          sourcesOfTruth,
        },
      },
    },
    binding: {
      dispositions: input.dispositions,
      claims,
    },
  });
}
