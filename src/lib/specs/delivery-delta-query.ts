import { isEarlierMergedDelivery } from "./delivery-gate";
import {
  projectDeliveryDelta,
  type DeliveryDeltaProjection,
  type EarlierDeliveryProbe,
} from "./delivery-delta";
import type {
  Spec,
  SpecCriterionDispositionRow,
  SpecExecutionRow,
  SpecProofVerdictRow,
  SpecRevisionSnapshot,
  SpecWaiverRow,
} from "./schemas";

/**
 * Assembles the delivery-delta projection's inputs from durable state. The
 * classification itself lives in the pure projection; this module only chooses
 * which execution to compare against and reads the rows that choice implies.
 */
export interface DeliveryDeltaQueryDeps {
  getRevisionSnapshot(revisionId: string): Promise<SpecRevisionSnapshot | null>;
  findExecutionsBySpecId(specId: string): SpecExecutionRow[];
  findCriterionDispositionsByExecution(
    executionId: string,
  ): SpecCriterionDispositionRow[];
  findProofVerdictsByCriterionRevision(
    criterionElementId: string,
    revisionId: string,
  ): SpecProofVerdictRow[];
  findWaiverById(waiverId: string): SpecWaiverRow | null;
}

export interface DeliveryDeltaQueryInput {
  spec: Spec;
  /** The revision the next delivery plan would be authored against. */
  currentApprovedSnapshot: SpecRevisionSnapshot;
  /** Compare against this execution instead of the last delivered one. */
  sinceExecutionId?: string;
}

export type DeliveryDeltaQueryFailureCode =
  | "execution_not_found"
  | "pinned_revision_unavailable";

export type DeliveryDeltaQueryResult =
  | { ok: true; projection: DeliveryDeltaProjection }
  | {
      ok: false;
      code: DeliveryDeltaQueryFailureCode;
      message: string;
    };

/**
 * The delivery this spec's next plan starts from: the most recent execution
 * that actually delivered. Ties break on creation order and then id so the
 * default is stable across reads.
 */
function lastDeliveredExecution(
  executions: readonly SpecExecutionRow[],
): SpecExecutionRow | null {
  return (
    [...executions]
      .filter((row) => row.state === "delivered" && row.delivered_at !== null)
      .sort((left, right) => {
        const delivered = (right.delivered_at ?? "").localeCompare(
          left.delivered_at ?? "",
        );
        if (delivered !== 0) return delivered;
        const created = right.created_at.localeCompare(left.created_at);
        return created !== 0 ? created : right.id.localeCompare(left.id);
      })[0] ?? null
  );
}

function criterionElementIds(
  snapshot: SpecRevisionSnapshot,
): readonly string[] {
  return snapshot.elements
    .filter(({ version }) => version.payload.kind === "criterion")
    .map(({ element }) => element.id);
}

/**
 * The delivery gate owns `isEarlierMergedDelivery`; this adapter feeds it the
 * spec's own executions and their dispositions so the projection reaches the
 * same verdict the gate would, without a second copy of the rule.
 */
function earlierDeliveryProbe(
  deps: DeliveryDeltaQueryDeps,
  execution: SpecExecutionRow,
  executions: readonly SpecExecutionRow[],
): EarlierDeliveryProbe {
  const executionsById = new Map(executions.map((row) => [row.id, row]));
  const dispositionCache = new Map<string, SpecCriterionDispositionRow[]>();
  function dispositionsFor(executionId: string): SpecCriterionDispositionRow[] {
    const cached = dispositionCache.get(executionId);
    if (cached !== undefined) return cached;
    const loaded = deps.findCriterionDispositionsByExecution(executionId);
    dispositionCache.set(executionId, loaded);
    return loaded;
  }

  return {
    isEarlierMergedDelivery: (disposition) =>
      isEarlierMergedDelivery(
        {
          findExecutionById: (id) => executionsById.get(id) ?? null,
          findCriterionDisposition: (executionId, criterionElementId) =>
            dispositionsFor(executionId).find(
              (row) => row.criterion_element_id === criterionElementId,
            ) ?? null,
        },
        execution,
        disposition,
      ),
  };
}

export async function loadDeliveryDelta(
  deps: DeliveryDeltaQueryDeps,
  input: DeliveryDeltaQueryInput,
): Promise<DeliveryDeltaQueryResult> {
  const executions = deps.findExecutionsBySpecId(input.spec.id);
  const selected =
    input.sinceExecutionId === undefined
      ? lastDeliveredExecution(executions)
      : (executions.find((row) => row.id === input.sinceExecutionId) ?? null);

  if (selected === null && input.sinceExecutionId !== undefined) {
    return {
      ok: false,
      code: "execution_not_found",
      message: `No execution ${input.sinceExecutionId} belongs to spec ${input.spec.slug}. Run \`cctl spec status ${input.spec.slug}\` to list this spec's executions, then retry with one of those ids.`,
    };
  }

  if (selected === null) {
    return {
      ok: true,
      projection: projectDeliveryDelta({
        specSlug: input.spec.slug,
        current: input.currentApprovedSnapshot,
        base: null,
        comparedExecution: null,
        dispositions: [],
        proofVerdicts: [],
        waivers: [],
        priorDelivery: { isEarlierMergedDelivery: () => false },
      }),
    };
  }

  const base = await deps.getRevisionSnapshot(selected.revision_id);
  if (base === null) {
    return {
      ok: false,
      code: "pinned_revision_unavailable",
      message: `Execution ${selected.id} pins revision ${selected.revision_id}, which cannot be read, so nothing can be compared against it. Re-run with \`--since <executionId>\` naming an execution whose pinned revision is intact, or run \`cctl spec verify ${input.spec.slug}\` to report the damaged revision.`,
    };
  }

  const dispositions = deps.findCriterionDispositionsByExecution(selected.id);
  const proofVerdicts = criterionElementIds(base).flatMap((criterionId) =>
    deps.findProofVerdictsByCriterionRevision(criterionId, base.revision.id),
  );
  const waivers = dispositions.flatMap((disposition) => {
    if (disposition.waiver_id === null) return [];
    const waiver = deps.findWaiverById(disposition.waiver_id);
    return waiver === null ? [] : [waiver];
  });

  return {
    ok: true,
    projection: projectDeliveryDelta({
      specSlug: input.spec.slug,
      current: input.currentApprovedSnapshot,
      base,
      comparedExecution: selected,
      dispositions,
      proofVerdicts,
      waivers,
      priorDelivery: earlierDeliveryProbe(deps, selected, executions),
    }),
  };
}
