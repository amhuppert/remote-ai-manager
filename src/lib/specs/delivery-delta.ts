import { z } from "zod";

import { elementHandleInSnapshot } from "./review-state";
import {
  specCriterionDispositionSchema,
  specElementKindSchema,
  specExecutionStateSchema,
  type SpecCriterionDispositionRow,
  type SpecElementKind,
  type SpecElementPayload,
  type SpecExecutionRow,
  type SpecProofVerdictRow,
  type SpecRevisionSnapshot,
  type SpecWaiverRow,
  type ValidationStrategy,
} from "./schemas";
import { isWaiverValidForExecution } from "./waiver-staleness";

/**
 * P1 — the delivery-delta projection. Read-time only: it compares the current
 * approved revision against the revision a chosen execution pinned, using
 * stable element ids and immutable payload hashes. `elementVersion` resets per
 * revision, so it is never an input to any comparison here; nothing this module
 * computes is persisted or derived from a persisted classification.
 */

export const deliveryDeltaElementClassSchema = z.enum([
  "added",
  "amended",
  "unchanged",
  "removed",
]);
export type DeliveryDeltaElementClass = z.infer<
  typeof deliveryDeltaElementClassSchema
>;

export const criterionDeliveryClassSchema = z.enum([
  "delivered_and_fresh",
  "soft_stale",
  "hard_stale",
  "never_delivered",
  "deferred",
  "waived",
]);
export type CriterionDeliveryClass = z.infer<
  typeof criterionDeliveryClassSchema
>;

export const criterionFreshnessGradeSchema = z.enum([
  "fresh",
  "soft_stale",
  "hard_stale",
]);
export type CriterionFreshnessGrade = z.infer<
  typeof criterionFreshnessGradeSchema
>;

export const criterionStalenessReasonSchema = z.enum([
  "criterion_text",
  "criterion_validation_strategy",
  "criterion_payload",
  "parent_requirement",
  "governing_decision",
]);
export type CriterionStalenessReason = z.infer<
  typeof criterionStalenessReasonSchema
>;

export const deliveryDeltaBasisElementSchema = z
  .object({
    elementId: z.string().min(1),
    kind: specElementKindSchema,
    handle: z.string().min(1),
    reason: criterionStalenessReasonSchema,
    baseHash: z.string().min(1).nullable(),
    currentHash: z.string().min(1).nullable(),
  })
  .strict();
export type DeliveryDeltaBasisElement = z.infer<
  typeof deliveryDeltaBasisElementSchema
>;

export const criterionFreshnessSchema = z
  .object({
    grade: criterionFreshnessGradeSchema,
    basis: z.array(deliveryDeltaBasisElementSchema),
  })
  .strict();
export type CriterionFreshness = z.infer<typeof criterionFreshnessSchema>;

export const deliveryDeltaElementSchema = z
  .object({
    elementId: z.string().min(1),
    kind: specElementKindSchema,
    handle: z.string().min(1),
    class: deliveryDeltaElementClassSchema,
    baseHash: z.string().min(1).nullable(),
    currentHash: z.string().min(1).nullable(),
  })
  .strict();
export type DeliveryDeltaElement = z.infer<typeof deliveryDeltaElementSchema>;

export const deliveryDeltaCriterionSchema = z
  .object({
    criterionElementId: z.string().min(1),
    handle: z.string().min(1),
    class: criterionDeliveryClassSchema,
    /** The compared execution's disposition, or null when it held none. */
    priorDisposition: specCriterionDispositionSchema.nullable(),
    /** Null when there is no pinned revision to compare the criterion against. */
    freshness: criterionFreshnessSchema.nullable(),
  })
  .strict();
export type DeliveryDeltaCriterion = z.infer<
  typeof deliveryDeltaCriterionSchema
>;

export const deliveryDeltaAdvisoryCodeSchema = z.enum([
  "delivered_elsewhere_refused",
  "delivered_elsewhere_requires_reaffirmation",
]);
export type DeliveryDeltaAdvisoryCode = z.infer<
  typeof deliveryDeltaAdvisoryCodeSchema
>;

export const deliveryDeltaAdvisorySchema = z
  .object({
    criterionElementId: z.string().min(1),
    handle: z.string().min(1),
    code: deliveryDeltaAdvisoryCodeSchema,
    freshness: z.enum(["soft_stale", "hard_stale"]),
    priorDisposition: specCriterionDispositionSchema.nullable(),
    message: z.string().min(1),
  })
  .strict();
export type DeliveryDeltaAdvisory = z.infer<typeof deliveryDeltaAdvisorySchema>;

const deliveryDeltaRevisionRefSchema = z
  .object({
    revisionId: z.string().min(1),
    revisionNumber: z.number().int().positive(),
  })
  .strict();

const deliveryDeltaExecutionRefSchema = z
  .object({
    executionId: z.string().min(1),
    revisionId: z.string().min(1),
    state: specExecutionStateSchema,
    deliveredAt: z.string().min(1).nullable(),
  })
  .strict();

const nonNegativeInt = z.number().int().nonnegative();

export const deliveryDeltaCountsSchema = z
  .object({
    elements: z
      .object({
        added: nonNegativeInt,
        amended: nonNegativeInt,
        unchanged: nonNegativeInt,
        removed: nonNegativeInt,
      })
      .strict(),
    criteria: z
      .object({
        delivered_and_fresh: nonNegativeInt,
        soft_stale: nonNegativeInt,
        hard_stale: nonNegativeInt,
        never_delivered: nonNegativeInt,
        deferred: nonNegativeInt,
        waived: nonNegativeInt,
      })
      .strict(),
  })
  .strict();
export type DeliveryDeltaCounts = z.infer<typeof deliveryDeltaCountsSchema>;

export const deliveryDeltaProjectionSchema = z
  .object({
    specSlug: z.string().min(1),
    current: deliveryDeltaRevisionRefSchema,
    base: deliveryDeltaRevisionRefSchema.nullable(),
    comparedExecution: deliveryDeltaExecutionRefSchema.nullable(),
    elements: z.array(deliveryDeltaElementSchema),
    criteria: z.array(deliveryDeltaCriterionSchema),
    /** Read-only: staleness that makes a carried-forward disposition illegal. */
    advisories: z.array(deliveryDeltaAdvisorySchema),
    counts: deliveryDeltaCountsSchema,
  })
  .strict();
export type DeliveryDeltaProjection = z.infer<
  typeof deliveryDeltaProjectionSchema
>;

/**
 * The delivery gate owns the prior-run rule for `delivered_elsewhere`
 * (`isEarlierMergedDelivery`). The projection consumes that verdict rather
 * than re-deriving it, so a criterion the gate would refuse can never read as
 * delivered here.
 */
export interface EarlierDeliveryProbe {
  isEarlierMergedDelivery(disposition: SpecCriterionDispositionRow): boolean;
}

export interface DeliveryDeltaInput {
  specSlug: string;
  /** The revision the next delivery plan would be authored against. */
  current: SpecRevisionSnapshot;
  /** The compared execution's pinned revision; null when none has delivered. */
  base: SpecRevisionSnapshot | null;
  comparedExecution: SpecExecutionRow | null;
  /** The compared execution's criterion dispositions. */
  dispositions: readonly SpecCriterionDispositionRow[];
  /** Proof verdicts for the spec; each pins the revision it was proved against. */
  proofVerdicts: readonly SpecProofVerdictRow[];
  waivers: readonly SpecWaiverRow[];
  priorDelivery: EarlierDeliveryProbe;
}

type SortKey = readonly [number, number, number, string, string];

interface IndexedElement {
  elementId: string;
  kind: SpecElementKind;
  handle: string;
  parentElementId: string | null;
  payload: SpecElementPayload;
  payloadHash: string;
  sortKey: SortKey;
}

/**
 * The immutable pinned state both staleness bases are computed from. The
 * governing-decision map is built from the BASE snapshot alone: a decision
 * that did not trace the requirement at the revision the proof was recorded
 * against did not govern that proof, so a decision newly traced in the current
 * revision is new design rather than invalidated design.
 */
interface FreshnessContext {
  baseIndex: ReadonlyMap<string, IndexedElement>;
  currentIndex: ReadonlyMap<string, IndexedElement>;
  governingDecisionIdsByRequirement: ReadonlyMap<string, readonly string[]>;
}

/**
 * Handle order: elements group by kind, then ascend numerically within it, so
 * `R2` precedes `R10` rather than sorting as text. Elements with no handle
 * (sections, unnumbered rows) are addressed by element id and sort last.
 */
const KIND_ORDER: Record<SpecElementKind, number> = {
  requirement: 0,
  criterion: 1,
  decision: 2,
  task: 3,
  section: 4,
};

const UNNUMBERED = Number.MAX_SAFE_INTEGER;

function indexSnapshot(
  snapshot: SpecRevisionSnapshot,
): Map<string, IndexedElement> {
  const numbersById = new Map(
    snapshot.elements.map(({ element }) => [element.id, element.number]),
  );
  const index = new Map<string, IndexedElement>();
  for (const { element, version } of snapshot.elements) {
    if (index.has(element.id)) {
      throw new Error(`Duplicate spec element id in snapshot: ${element.id}`);
    }
    const handle = elementHandleInSnapshot(snapshot, element.id) ?? element.id;
    const parentNumber =
      element.parentElementId === null
        ? null
        : (numbersById.get(element.parentElementId) ?? null);
    const primary =
      (element.kind === "criterion" ? parentNumber : element.number) ??
      UNNUMBERED;
    const secondary = element.kind === "criterion" ? (element.number ?? 0) : 0;
    index.set(element.id, {
      elementId: element.id,
      kind: element.kind,
      handle,
      parentElementId: element.parentElementId,
      payload: version.payload,
      payloadHash: version.payloadHash,
      sortKey: [
        KIND_ORDER[element.kind],
        primary,
        secondary,
        handle,
        element.id,
      ],
    });
  }
  return index;
}

function inHandleOrder<T>(
  entries: readonly { sortKey: SortKey; row: T }[],
): T[] {
  return [...entries]
    .sort((left, right) => compareSortKeys(left.sortKey, right.sortKey))
    .map((entry) => entry.row);
}

function compareSortKeys(left: SortKey, right: SortKey): number {
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === b) continue;
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a) < String(b) ? -1 : 1;
  }
  return 0;
}

function classifyElement(
  base: IndexedElement | undefined,
  current: IndexedElement | undefined,
): DeliveryDeltaElementClass {
  if (base === undefined) return "added";
  if (current === undefined) return "removed";
  return base.payloadHash === current.payloadHash ? "unchanged" : "amended";
}

/**
 * HARD — the criterion's own words or its validation strategy changed since
 * the revision the proof was recorded against, so the old proof proved
 * different words and the criterion must be re-proved. SOFT — the criterion
 * itself is untouched but the requirement it serves, or a decision that
 * governed that requirement at the pinned revision, changed: cheap
 * reaffirmation, not re-implementation, or staleness becomes an amendment tax
 * that discourages truthful specs. Hard outranks soft; both bases are read
 * from immutable pinned payloads.
 */
function gradeCriterionFreshness(
  base: IndexedElement,
  current: IndexedElement,
  context: FreshnessContext,
): CriterionFreshness {
  if (base.payloadHash !== current.payloadHash) {
    return {
      grade: "hard_stale",
      basis: criterionChangeReasons(base, current).map((reason) => ({
        elementId: current.elementId,
        kind: current.kind,
        handle: current.handle,
        reason,
        baseHash: base.payloadHash,
        currentHash: current.payloadHash,
      })),
    };
  }

  const softBasis = governingChanges(base, context);
  return softBasis.length === 0
    ? { grade: "fresh", basis: [] }
    : { grade: "soft_stale", basis: softBasis };
}

function governingChanges(
  base: IndexedElement,
  context: FreshnessContext,
): DeliveryDeltaBasisElement[] {
  const requirementId = base.parentElementId;
  if (requirementId === null) return [];
  const governingDecisionIds =
    context.governingDecisionIdsByRequirement.get(requirementId) ?? [];
  return [
    changedSince(requirementId, "parent_requirement", context),
    ...governingDecisionIds.map((decisionId) =>
      changedSince(decisionId, "governing_decision", context),
    ),
  ].filter((entry): entry is DeliveryDeltaBasisElement => entry !== null);
}

/**
 * The element's own change between the two pinned revisions, or null when it
 * did not change. An element absent from the current revision was removed, and
 * removal changes what governs the criterion as surely as an edit does.
 */
function changedSince(
  elementId: string,
  reason: CriterionStalenessReason,
  context: FreshnessContext,
): DeliveryDeltaBasisElement | null {
  const base = context.baseIndex.get(elementId);
  if (base === undefined) return null;
  const current = context.currentIndex.get(elementId);
  if (current !== undefined && current.payloadHash === base.payloadHash) {
    return null;
  }
  return {
    elementId,
    kind: base.kind,
    handle: current?.handle ?? base.handle,
    reason,
    baseHash: base.payloadHash,
    currentHash: current?.payloadHash ?? null,
  };
}

function governingDecisionIndex(
  baseIndex: ReadonlyMap<string, IndexedElement>,
): ReadonlyMap<string, readonly string[]> {
  const byRequirement = new Map<string, string[]>();
  const decisions = [...baseIndex.values()]
    .filter((element) => element.payload.kind === "decision")
    .sort((left, right) => compareSortKeys(left.sortKey, right.sortKey));
  for (const decision of decisions) {
    if (decision.payload.kind !== "decision") continue;
    for (const requirementId of decision.payload.tracedRequirementElementIds) {
      const traced = byRequirement.get(requirementId);
      if (traced === undefined) {
        byRequirement.set(requirementId, [decision.elementId]);
      } else if (!traced.includes(decision.elementId)) {
        traced.push(decision.elementId);
      }
    }
  }
  return byRequirement;
}

function criterionChangeReasons(
  base: IndexedElement,
  current: IndexedElement,
): CriterionStalenessReason[] {
  if (
    base.payload.kind !== "criterion" ||
    current.payload.kind !== "criterion"
  ) {
    return ["criterion_payload"];
  }
  const reasons: CriterionStalenessReason[] = [];
  if (base.payload.text !== current.payload.text) {
    reasons.push("criterion_text");
  }
  if (
    !sameValidationStrategy(
      base.payload.validationStrategy,
      current.payload.validationStrategy,
    )
  ) {
    reasons.push("criterion_validation_strategy");
  }
  return reasons.length === 0 ? ["criterion_payload"] : reasons;
}

function sameValidationStrategy(
  base: ValidationStrategy,
  current: ValidationStrategy,
): boolean {
  return (
    base.note === current.note &&
    base.kinds.length === current.kinds.length &&
    base.kinds.every((kind, index) => kind === current.kinds[index])
  );
}

function hasFreshProofAtPinnedRevision(
  input: DeliveryDeltaInput,
  criterionElementId: string,
  pinnedRevisionId: string,
): boolean {
  return input.proofVerdicts.some(
    (row) =>
      row.criterion_element_id === criterionElementId &&
      row.revision_id === pinnedRevisionId &&
      row.stale_at === null,
  );
}

/**
 * A waiver counts only through the disposition's own `waiver_id` link and only
 * while the gate's own validity rule holds, which is why that rule is imported
 * rather than restated: a waiver pinned to another revision or another spec
 * excuses nothing here because it excuses nothing at delivery. A waiver that
 * went stale when its criterion changed likewise excuses nothing, so the
 * criterion falls back to undelivered while `priorDisposition` still reports
 * `waived`.
 */
function waiverHonored(
  input: DeliveryDeltaInput,
  dispositionRow: SpecCriterionDispositionRow,
): boolean {
  const execution = input.comparedExecution;
  const waiverId = dispositionRow.waiver_id;
  if (execution === null || waiverId === null) return false;
  const waiver = input.waivers.find((row) => row.id === waiverId) ?? null;
  return isWaiverValidForExecution(
    waiver,
    execution,
    dispositionRow.criterion_element_id,
  );
}

function wasDelivered(
  input: DeliveryDeltaInput,
  dispositionRow: SpecCriterionDispositionRow | undefined,
  pinnedRevisionId: string | null,
): boolean {
  if (
    dispositionRow === undefined ||
    pinnedRevisionId === null ||
    input.comparedExecution?.state !== "delivered"
  ) {
    return false;
  }
  if (dispositionRow.disposition === "in_scope") {
    return hasFreshProofAtPinnedRevision(
      input,
      dispositionRow.criterion_element_id,
      pinnedRevisionId,
    );
  }
  return (
    dispositionRow.disposition === "delivered_elsewhere" &&
    input.priorDelivery.isEarlierMergedDelivery(dispositionRow)
  );
}

function classifyCriterion(
  input: DeliveryDeltaInput,
  dispositionRow: SpecCriterionDispositionRow | undefined,
  freshness: CriterionFreshness | null,
  pinnedRevisionId: string | null,
): CriterionDeliveryClass {
  if (dispositionRow?.disposition === "waived") {
    return waiverHonored(input, dispositionRow) ? "waived" : "never_delivered";
  }
  if (dispositionRow?.disposition === "deferred") return "deferred";
  if (!wasDelivered(input, dispositionRow, pinnedRevisionId)) {
    return "never_delivered";
  }
  return freshness === null || freshness.grade === "fresh"
    ? "delivered_and_fresh"
    : freshness.grade;
}

/**
 * Enforcement belongs to the DeliveryPlanAttempt lint, not here — this
 * projection writes nothing and refuses nothing. Naming where the refusal
 * lands is what keeps the advisory actionable rather than a dead warning.
 */
const DPA_LINT_NOTE =
  "Enforcement lands in the DeliveryPlanAttempt lint (execution context dpa-document).";

function deliveredElsewhereAdvisory(
  criterion: DeliveryDeltaCriterion,
): DeliveryDeltaAdvisory | null {
  if (criterion.class !== "hard_stale" && criterion.class !== "soft_stale") {
    return null;
  }
  const handle = criterion.handle;
  const because = (criterion.freshness?.basis ?? [])
    .map((entry) => entry.reason)
    .join(", ");
  const shared = {
    criterionElementId: criterion.criterionElementId,
    handle,
    priorDisposition: criterion.priorDisposition,
  };
  return criterion.class === "hard_stale"
    ? {
        ...shared,
        freshness: "hard_stale",
        code: "delivered_elsewhere_refused",
        message: `${handle} changed since the delivery that proved it (${because}), so a delivered_elsewhere disposition for ${handle} is illegal: select ${handle} in the next delivery plan and re-prove it. ${DPA_LINT_NOTE}`,
      }
    : {
        ...shared,
        freshness: "soft_stale",
        code: "delivered_elsewhere_requires_reaffirmation",
        message: `${handle} is unchanged but content governing it changed since the delivery that proved it (${because}), so a plain delivered_elsewhere disposition for ${handle} is illegal: disposition ${handle} as reaffirmed in the next delivery plan. ${DPA_LINT_NOTE}`,
      };
}

export function projectDeliveryDelta(
  input: DeliveryDeltaInput,
): DeliveryDeltaProjection {
  const execution = input.comparedExecution;
  if (
    execution !== null &&
    input.base !== null &&
    input.base.revision.id !== execution.revision_id
  ) {
    throw new Error(
      `The base snapshot ${input.base.revision.id} is not execution ${execution.id}'s pinned revision ${execution.revision_id}.`,
    );
  }

  const currentIndex = indexSnapshot(input.current);
  const baseIndex =
    input.base === null
      ? new Map<string, IndexedElement>()
      : indexSnapshot(input.base);
  const pinnedRevisionId = input.base?.revision.id ?? null;
  const dispositionsById = new Map(
    input.dispositions.map((row) => [row.criterion_element_id, row]),
  );
  const freshnessContext: FreshnessContext = {
    baseIndex,
    currentIndex,
    governingDecisionIdsByRequirement: governingDecisionIndex(baseIndex),
  };

  const elementIds = new Set([...baseIndex.keys(), ...currentIndex.keys()]);
  const elements = inHandleOrder(
    [...elementIds].flatMap((elementId) => {
      const base = baseIndex.get(elementId);
      const current = currentIndex.get(elementId);
      const anchor = current ?? base;
      if (anchor === undefined) return [];
      return [
        {
          sortKey: anchor.sortKey,
          row: {
            elementId,
            kind: anchor.kind,
            handle: anchor.handle,
            class: classifyElement(base, current),
            baseHash: base?.payloadHash ?? null,
            currentHash: current?.payloadHash ?? null,
          },
        },
      ];
    }),
  );

  const criteria = inHandleOrder(
    [...currentIndex.values()].flatMap((current) => {
      if (current.kind !== "criterion") return [];
      const base = baseIndex.get(current.elementId);
      const freshness =
        base === undefined
          ? null
          : gradeCriterionFreshness(base, current, freshnessContext);
      const dispositionRow = dispositionsById.get(current.elementId);
      return [
        {
          sortKey: current.sortKey,
          row: {
            criterionElementId: current.elementId,
            handle: current.handle,
            class: classifyCriterion(
              input,
              dispositionRow,
              freshness,
              pinnedRevisionId,
            ),
            priorDisposition: dispositionRow?.disposition ?? null,
            freshness,
          },
        },
      ];
    }),
  );

  return {
    specSlug: input.specSlug,
    current: {
      revisionId: input.current.revision.id,
      revisionNumber: input.current.revision.number,
    },
    base:
      input.base === null
        ? null
        : {
            revisionId: input.base.revision.id,
            revisionNumber: input.base.revision.number,
          },
    comparedExecution:
      execution === null
        ? null
        : {
            executionId: execution.id,
            revisionId: execution.revision_id,
            state: execution.state,
            deliveredAt: execution.delivered_at,
          },
    elements,
    criteria,
    advisories: criteria.flatMap((criterion) => {
      const advisory = deliveredElsewhereAdvisory(criterion);
      return advisory === null ? [] : [advisory];
    }),
    counts: countClasses(elements, criteria),
  };
}

function countClasses(
  elements: readonly DeliveryDeltaElement[],
  criteria: readonly DeliveryDeltaCriterion[],
): DeliveryDeltaCounts {
  const counts: DeliveryDeltaCounts = {
    elements: { added: 0, amended: 0, unchanged: 0, removed: 0 },
    criteria: {
      delivered_and_fresh: 0,
      soft_stale: 0,
      hard_stale: 0,
      never_delivered: 0,
      deferred: 0,
      waived: 0,
    },
  };
  for (const element of elements) counts.elements[element.class] += 1;
  for (const criterion of criteria) counts.criteria[criterion.class] += 1;
  return counts;
}
