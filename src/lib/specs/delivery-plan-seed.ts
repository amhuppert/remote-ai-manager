import type { CriterionDeliveryClass } from "./delivery-delta";
import {
  emptyDeliveryPlanDocument,
  type DeliveryPlanContext,
  type DeliveryPlanCriterionDisposition,
  type DeliveryPlanDisposition,
  type DeliveryPlanDocument,
  type DeliveryPlanTask,
} from "./delivery-plan";

/**
 * `spec plan open --seed-from last`: the total-disposition-preserving seed.
 *
 * The point of seeding is that the author starts from a plan that already
 * accounts for EVERY criterion of the pinned revision rather than from an empty
 * document they must reconcile by hand — which is how a criterion silently
 * leaves scope. So the seed assigns exactly one disposition per pinned
 * criterion, derived from the delivery-delta class the projection computed, and
 * carries the prior plan's shape forward only where the work is still selected.
 *
 * The seed never asserts a human act: a soft-stale criterion seeds as
 * `pending_reaffirmation`, which a draft may carry and a proposal may not, so
 * lint names the two resolutions instead of the seed choosing one.
 */

export interface PlanSeedCriterion {
  readonly criterionElementId: string;
  readonly handle: string;
  /** P1/P2 classification against the delta basis (`projectDeliveryDelta`). */
  readonly deliveryClass: CriterionDeliveryClass;
}

/**
 * Work a running execution captured as a discovery. It is work the run found
 * and deliberately did not do, so the next plan is exactly where it belongs.
 */
export interface PlanSeedDiscovery {
  readonly discoveryId: string;
  readonly title: string;
  readonly instructions: string;
  readonly coveredCriterionElementIds: readonly string[];
}

/** The task id a discovery takes in a seeded plan, and its dedupe key. */
export function discoveryTaskId(discoveryId: string): string {
  return `discovery-${discoveryId}`;
}

export interface DeliveryPlanSeedInput {
  /** Every criterion judgment is made against this revision, never the head. */
  readonly pinnedRevisionId: string;
  readonly criteria: readonly PlanSeedCriterion[];
  /** The earlier merged execution a `delivered_elsewhere` seed rests on. */
  readonly deliveredByExecutionId: string | null;
  /** The last launched attempt's document, or null when this is the first. */
  readonly priorPlan: DeliveryPlanDocument | null;
  readonly discoveries: readonly PlanSeedDiscovery[];
}

/**
 * Where a discovery goes when no selected criterion it covers has an owner.
 * Typed rather than delivery, because it owns no criterion; its acceptance
 * contract is deliberately left empty so lint asks the author what the context
 * must make observable. Auto-writing a contract from the discovery titles would
 * manufacture the one thing a validator is held to.
 */
const DISCOVERY_CONTEXT_ID = "discovered-work";

export function seedDeliveryPlanDocument(
  input: DeliveryPlanSeedInput,
): DeliveryPlanDocument {
  const dispositions = input.criteria.map((criterion) =>
    seedDisposition(criterion, input.deliveredByExecutionId),
  );
  const selectedIds = new Set(
    dispositions
      .filter((entry) => entry.disposition === "selected")
      .map((entry) => entry.criterionElementId),
  );
  const pinnedIds = new Set(
    input.criteria.map((criterion) => criterion.criterionElementId),
  );

  const contexts = carriedContexts(input.priorPlan, selectedIds);
  const keptContextIds = new Set(contexts.map((context) => context.contextId));
  const tasks = carriedTasks(input.priorPlan, keptContextIds, pinnedIds);

  const staged = stageDiscoveries(
    input.discoveries,
    contexts,
    tasks,
    selectedIds,
    pinnedIds,
  );

  return {
    ...emptyDeliveryPlanDocument(),
    dispositions,
    contexts: staged.contexts,
    tasks: renumbered(staged.tasks),
    edges: (input.priorPlan?.edges ?? []).filter(
      (edge) =>
        keptContextIds.has(edge.fromContextId) &&
        keptContextIds.has(edge.toContextId),
    ),
    wiring: (input.priorPlan?.wiring ?? [])
      .filter((entry) => keptContextIds.has(entry.owner.contextId))
      .map((entry) => ({
        ...entry,
        criterionElementIds: entry.criterionElementIds.filter((id) =>
          pinnedIds.has(id),
        ),
      })),
    policyOverrides: input.priorPlan?.policyOverrides ?? [],
    touchedSurfaces: input.priorPlan?.touchedSurfaces ?? [],
    governance:
      input.priorPlan?.governance ?? emptyDeliveryPlanDocument().governance,
  };
}

/**
 * The class-to-disposition law. `deferred` maps to `selected` because a
 * criterion the last run deferred is due in the plan that follows it — a
 * deferral that re-seeded as a deferral is how work disappears one round at a
 * time.
 */
function seedDisposition(
  criterion: PlanSeedCriterion,
  deliveredByExecutionId: string | null,
): DeliveryPlanCriterionDisposition {
  const base = {
    criterionElementId: criterion.criterionElementId,
    deliveredByExecutionId: null,
    reaffirmation: null,
    note: null,
  } satisfies Omit<DeliveryPlanCriterionDisposition, "disposition">;

  switch (criterion.deliveryClass) {
    case "delivered_and_fresh":
      // Auto-proposed, not asserted: with no basis to name, the claim cannot
      // be made at all, so the criterion re-enters scope instead.
      return deliveredByExecutionId === null
        ? { ...base, disposition: "selected" }
        : {
            ...base,
            disposition: "delivered_elsewhere",
            deliveredByExecutionId,
            note: `Seeded from the delta against ${deliveredByExecutionId}, which delivered this criterion against text that has not changed since.`,
          };
    case "soft_stale":
      return { ...base, disposition: "pending_reaffirmation" };
    case "waived":
      return { ...base, disposition: "waived" };
    case "hard_stale":
    case "never_delivered":
    case "deferred":
      return { ...base, disposition: "selected" };
    default:
      return { ...base, disposition: unreachable(criterion.deliveryClass) };
  }
}

function unreachable(deliveryClass: never): DeliveryPlanDisposition {
  throw new Error(
    `unhandled criterion delivery class ${String(deliveryClass)}`,
  );
}

/**
 * A prior context survives when it still owns selected work. A typed
 * integration/closeout context owns nothing by construction, so it survives
 * with the delivery work it existed to close over — and disappears with it.
 */
function carriedContexts(
  priorPlan: DeliveryPlanDocument | null,
  selectedIds: ReadonlySet<string>,
): DeliveryPlanContext[] {
  if (priorPlan === null) return [];
  const delivering = priorPlan.contexts.filter((context) =>
    context.criterionElementIds.some((id) => selectedIds.has(id)),
  );
  if (delivering.length === 0) return [];
  return priorPlan.contexts
    .filter(
      (context) =>
        delivering.includes(context) || context.contextType !== "delivery",
    )
    .map((context) => ({
      ...context,
      criterionElementIds: context.criterionElementIds.filter((id) =>
        selectedIds.has(id),
      ),
      proofPlan: context.proofPlan.filter((step) =>
        selectedIds.has(step.criterionElementId),
      ),
    }));
}

function carriedTasks(
  priorPlan: DeliveryPlanDocument | null,
  keptContextIds: ReadonlySet<string>,
  pinnedIds: ReadonlySet<string>,
): DeliveryPlanTask[] {
  if (priorPlan === null) return [];
  return [...priorPlan.tasks]
    .filter((task) => keptContextIds.has(task.contextId))
    .sort((left, right) => left.order - right.order)
    .map((task) => ({
      ...task,
      contributesToCriterionElementIds:
        task.contributesToCriterionElementIds.filter((id) => pinnedIds.has(id)),
    }));
}

function stageDiscoveries(
  discoveries: readonly PlanSeedDiscovery[],
  contexts: readonly DeliveryPlanContext[],
  tasks: readonly DeliveryPlanTask[],
  selectedIds: ReadonlySet<string>,
  pinnedIds: ReadonlySet<string>,
): { contexts: DeliveryPlanContext[]; tasks: DeliveryPlanTask[] } {
  const nextContexts = [...contexts];
  const nextTasks = [...tasks];
  // A discovery the prior plan already placed comes forward as an ordinary
  // carried task, so re-appending it would duplicate the work. Consumption is
  // read here rather than persisted: the plan that carries the task IS the
  // record that the discovery was taken up.
  const alreadyPlaced = new Set(nextTasks.map((task) => task.taskId));
  const pending = discoveries.filter(
    (discovery) => !alreadyPlaced.has(discoveryTaskId(discovery.discoveryId)),
  );
  if (pending.length === 0) {
    return { contexts: nextContexts, tasks: nextTasks };
  }

  const ownerByCriterion = new Map<string, string>();
  for (const context of contexts) {
    for (const criterionElementId of context.criterionElementIds) {
      if (!ownerByCriterion.has(criterionElementId)) {
        ownerByCriterion.set(criterionElementId, context.contextId);
      }
    }
  }

  for (const discovery of pending) {
    const owned = discovery.coveredCriterionElementIds
      .filter((id) => selectedIds.has(id))
      .map((id) => ownerByCriterion.get(id))
      .find((contextId) => contextId !== undefined);
    const contextId = owned ?? DISCOVERY_CONTEXT_ID;
    if (
      contextId === DISCOVERY_CONTEXT_ID &&
      !nextContexts.some(
        (context) => context.contextId === DISCOVERY_CONTEXT_ID,
      )
    ) {
      nextContexts.push({
        contextId: DISCOVERY_CONTEXT_ID,
        title: "Discovered work carried forward",
        contextType: "integration",
        criterionElementIds: [],
        acceptanceContract: [],
        proofPlan: [],
      });
    }
    nextTasks.push({
      taskId: discoveryTaskId(discovery.discoveryId),
      contextId,
      title: discovery.title,
      instructions: discovery.instructions,
      // Rewritten by `renumbered`; the append position is what carries here.
      order: nextTasks.length,
      contributesToCriterionElementIds:
        discovery.coveredCriterionElementIds.filter((id) => pinnedIds.has(id)),
    });
  }

  return { contexts: nextContexts, tasks: nextTasks };
}

/**
 * Task order is per-context and contiguous, which lint enforces. Dropping a
 * context's tasks or appending a discovery both break that, so the seed
 * renumbers rather than emitting a document that refuses itself.
 */
function renumbered(tasks: readonly DeliveryPlanTask[]): DeliveryPlanTask[] {
  const nextOrder = new Map<string, number>();
  return tasks.map((task) => {
    const order = nextOrder.get(task.contextId) ?? 0;
    nextOrder.set(task.contextId, order + 1);
    return { ...task, order };
  });
}
