import { z } from "zod";

import { stableStringify } from "@/lib/state-store/serialization";

import {
  deliveryPlanDispositionSchema,
  type DeliveryPlanDocument,
  type DeliveryPlanEdge,
  type DeliveryPlanTask,
} from "./delivery-plan";

/**
 * The semantic diff between two delivery-plan snapshots (design §5): what a
 * reviewer needs to see when a plan is re-proposed after a reopen. It answers
 * in the plan's own vocabulary — which contexts appeared, disappeared, or moved
 * and in what respect, and which criterion changed hands — rather than as a
 * text diff over serialized JSON, which would report key reordering as change
 * and an ownership move as noise.
 *
 * It is a pure comparison of two immutable snapshots, so nothing here is
 * persisted and nothing is classified twice (`computed-projections`).
 */

export const deliveryPlanContextChangeAspectSchema = z.enum([
  "title",
  "context_type",
  "acceptance_contract",
  "criterion_ownership",
  "tasks",
  "edges",
  "proof_plan",
]);
export type DeliveryPlanContextChangeAspect = z.infer<
  typeof deliveryPlanContextChangeAspectSchema
>;

/** Aspect order is presentation order: coarse identity first, wiring last. */
const ASPECT_ORDER: readonly DeliveryPlanContextChangeAspect[] = [
  "title",
  "context_type",
  "acceptance_contract",
  "criterion_ownership",
  "proof_plan",
  "tasks",
  "edges",
];

export const deliveryPlanContextDiffSchema = z
  .object({
    contextId: z.string().min(1),
    /** The target's title, or the base's for a context the target dropped. */
    title: z.string().min(1),
    class: z.enum(["added", "removed", "changed", "unchanged"]),
    changed: z.array(deliveryPlanContextChangeAspectSchema),
  })
  .strict();
export type DeliveryPlanContextDiff = z.infer<
  typeof deliveryPlanContextDiffSchema
>;

export const deliveryPlanDispositionDiffSchema = z
  .object({
    criterionElementId: z.string().min(1),
    /** Null when the snapshot in question disposed the criterion not at all. */
    from: deliveryPlanDispositionSchema.nullable(),
    to: deliveryPlanDispositionSchema.nullable(),
  })
  .strict();
export type DeliveryPlanDispositionDiff = z.infer<
  typeof deliveryPlanDispositionDiffSchema
>;

export const deliveryPlanDocumentDiffSchema = z
  .object({
    contexts: z.array(deliveryPlanContextDiffSchema),
    dispositions: z.array(deliveryPlanDispositionDiffSchema),
  })
  .strict();
export type DeliveryPlanDocumentDiff = z.infer<
  typeof deliveryPlanDocumentDiffSchema
>;

function tasksOf(
  document: DeliveryPlanDocument,
  contextId: string,
): DeliveryPlanTask[] {
  return document.tasks
    .filter((task) => task.contextId === contextId)
    .sort((left, right) => left.order - right.order);
}

/** Both directions, because either end moving changes where the context sits. */
function edgesOf(
  document: DeliveryPlanDocument,
  contextId: string,
): DeliveryPlanEdge[] {
  return document.edges
    .filter(
      (edge) =>
        edge.fromContextId === contextId || edge.toContextId === contextId,
    )
    .map((edge) => ({ ...edge }))
    .sort((left, right) =>
      `${left.fromContextId}->${left.toContextId}`.localeCompare(
        `${right.fromContextId}->${right.toContextId}`,
      ),
    );
}

function differs(left: unknown, right: unknown): boolean {
  return stableStringify(left) !== stableStringify(right);
}

export function deliveryPlanDocumentDiff(
  base: DeliveryPlanDocument,
  target: DeliveryPlanDocument,
): DeliveryPlanDocumentDiff {
  const baseContexts = new Map(
    base.contexts.map((context) => [context.contextId, context]),
  );
  const targetContexts = new Map(
    target.contexts.map((context) => [context.contextId, context]),
  );

  // Base order first, then whatever the target added: a reviewer reads the plan
  // they knew and sees the new work arrive at the end.
  const contextIds = [
    ...base.contexts.map((context) => context.contextId),
    ...target.contexts
      .map((context) => context.contextId)
      .filter((contextId) => !baseContexts.has(contextId)),
  ];

  const contexts: DeliveryPlanContextDiff[] = contextIds.map((contextId) => {
    const before = baseContexts.get(contextId);
    const after = targetContexts.get(contextId);
    if (before === undefined && after !== undefined) {
      return {
        contextId,
        title: after.title,
        class: "added",
        changed: [],
      };
    }
    if (after === undefined && before !== undefined) {
      return {
        contextId,
        title: before.title,
        class: "removed",
        changed: [],
      };
    }
    if (before === undefined || after === undefined) {
      // Unreachable: `contextIds` is built from the two maps this reads.
      throw new Error(`delivery plan diff lost context ${contextId}`);
    }
    const moved: Record<DeliveryPlanContextChangeAspect, boolean> = {
      title: before.title !== after.title,
      context_type: before.contextType !== after.contextType,
      acceptance_contract: differs(
        before.acceptanceContract,
        after.acceptanceContract,
      ),
      criterion_ownership: differs(
        before.criterionElementIds,
        after.criterionElementIds,
      ),
      proof_plan: differs(before.proofPlan, after.proofPlan),
      tasks: differs(tasksOf(base, contextId), tasksOf(target, contextId)),
      edges: differs(edgesOf(base, contextId), edgesOf(target, contextId)),
    };
    const changed = ASPECT_ORDER.filter((aspect) => moved[aspect]);
    return {
      contextId,
      title: after.title,
      class: changed.length === 0 ? "unchanged" : "changed",
      changed,
    };
  });

  const baseDispositions = new Map(
    base.dispositions.map((entry) => [entry.criterionElementId, entry]),
  );
  const targetDispositions = new Map(
    target.dispositions.map((entry) => [entry.criterionElementId, entry]),
  );
  const criterionIds = [
    ...base.dispositions.map((entry) => entry.criterionElementId),
    ...target.dispositions
      .map((entry) => entry.criterionElementId)
      .filter(
        (criterionElementId) => !baseDispositions.has(criterionElementId),
      ),
  ];

  const dispositions = criterionIds.flatMap((criterionElementId) => {
    const from = baseDispositions.get(criterionElementId)?.disposition ?? null;
    const to = targetDispositions.get(criterionElementId)?.disposition ?? null;
    return from === to ? [] : [{ criterionElementId, from, to }];
  });

  return { contexts, dispositions };
}
