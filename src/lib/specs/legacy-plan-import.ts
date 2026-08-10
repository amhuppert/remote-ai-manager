import { createHash } from "node:crypto";

import { indexLegacyRevision, renderCriterion } from "./compiler";
import type { IndexedCriterion, IndexedTask, RevisionIndex } from "./compiler";
import {
  emptyDeliveryPlanDocument,
  type DeliveryPlanContext,
  type DeliveryPlanDocument,
  type DeliveryPlanEdge,
  type DeliveryPlanTask,
} from "./delivery-plan";
import {
  contractTaskGroups,
  type ContractedTaskGroup,
} from "./group-contraction";
import {
  bareHandle,
  legacyContextTitle,
  legacyCriterionBrief,
  legacyTaskInstructions,
} from "./legacy-plan-render";
import { executionScopeSchema, type ExecutionScope } from "./scope-validation";
import type { SpecExecutionRow, SpecRevisionSnapshot } from "./schemas";

/**
 * The one-way importer from a legacy approved evergreen plan to a
 * `DeliveryPlanAttempt` document.
 *
 * The legacy plan already carries the graph in an implicit form — `laneGroup`
 * says which tasks share a context, `dependsOnTaskElementIds` says which
 * contexts wait on which, `coveredCriterionElementIds` says who owns what — so
 * the import states those three things explicitly and stops. It never invents
 * an owner: a criterion whose covering tasks land in more than one context is
 * reported for a human split rather than duplicated into both contexts, which
 * is the failure the plan lint would refuse anyway (`plan/selected-multi-owned`)
 * and which silently double-counts delivery when it slips through.
 *
 * Rendering is shared with the compiler (`legacy-plan-render.ts`), so an
 * imported task carries the same approved narrow context pack the legacy run
 * executed — minus the compiler's apology for a task no criterion mapped to,
 * which the plan now says structurally with a typed integration context.
 *
 * The import is total: a legacy plan with a dependency cycle or an unowned
 * criterion still produces a document. Refusing is the plan lint's job, and a
 * lint finding names its remedy where a thrown importer would not.
 */

/**
 * A legacy source that exists but cannot be read. Distinct from having no
 * legacy delivery at all: reading damage as absence would open an empty
 * attempt and present it as a fresh plan, silently dropping the delivery the
 * author asked to seed from.
 */
export class LegacyDeliverySourceDamagedError extends Error {
  constructor(
    readonly executionId: string,
    readonly revisionId: string,
    readonly problem: string,
  ) {
    super(`legacy delivery source ${executionId} cannot be read: ${problem}`);
    this.name = "LegacyDeliverySourceDamagedError";
  }
}

/** One legacy execution read as an import source. */
export interface LegacyDeliverySource {
  readonly executionId: string;
  /** The approved revision that execution pinned, read whole. */
  readonly snapshot: SpecRevisionSnapshot;
  /** That execution's validated scope; nothing outside it is imported. */
  readonly scope: ExecutionScope;
}

/**
 * The spec's most recent legacy delivery source, or null when it has none to
 * import. One owner for the rule, because the production factory and the test
 * compositions must agree on which execution "the last one" is.
 *
 * Every execution state counts, abandoned included: the scope a human
 * validated is the best starting point for the next plan however that run
 * ended. What does not count is a pin that no longer reads as an approved
 * revision — a plan cannot be lifted out of text nobody approved.
 */
export async function resolveLegacyDeliverySource(
  executions: readonly SpecExecutionRow[],
  getRevisionSnapshot: (
    revisionId: string,
  ) => Promise<SpecRevisionSnapshot | null>,
): Promise<LegacyDeliverySource | null> {
  const latest = [...executions].sort(
    (left, right) =>
      left.created_at.localeCompare(right.created_at) ||
      left.id.localeCompare(right.id),
  )[executions.length - 1];
  if (latest === undefined) return null;
  const snapshot = await getRevisionSnapshot(latest.revision_id);
  if (snapshot === null) {
    throw new LegacyDeliverySourceDamagedError(
      latest.id,
      latest.revision_id,
      "the revision it pinned no longer exists",
    );
  }
  // Not damage: a plan cannot be lifted out of text nobody approved, so an
  // unapproved pin is simply nothing to import.
  if (snapshot.revision.state !== "approved") return null;
  let rawScope: unknown;
  try {
    rawScope = JSON.parse(latest.scope_json);
  } catch (error) {
    throw new LegacyDeliverySourceDamagedError(
      latest.id,
      latest.revision_id,
      `its stored scope is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const scope = executionScopeSchema.safeParse(rawScope);
  if (!scope.success) {
    throw new LegacyDeliverySourceDamagedError(
      latest.id,
      latest.revision_id,
      `its stored scope does not match the execution-scope schema (${scope.error.issues
        .map((issue) => issue.path.join("."))
        .join(", ")})`,
    );
  }
  return { executionId: latest.id, snapshot, scope: scope.data };
}

export interface LegacyDeliveryPlanImportInput {
  readonly specSlug: string;
  readonly specName: string;
  /** The legacy `spec_executions` row the plan is being lifted from. */
  readonly sourceExecutionId: string;
  /** The approved revision that execution pinned. */
  readonly snapshot: SpecRevisionSnapshot;
  /** That execution's validated scope; nothing outside it is imported. */
  readonly scope: ExecutionScope;
}

/**
 * A criterion the legacy plan spread across what are now separate contexts.
 * The entry names the contexts and the act that resolves it, because an author
 * told only "this criterion is ambiguous" has nowhere to go.
 */
export interface LegacyPlanSplitRequirement {
  readonly criterionElementId: string;
  readonly handle: string;
  readonly contextIds: readonly string[];
  readonly resolution: string;
}

export interface LegacyDeliveryPlanImport {
  readonly document: DeliveryPlanDocument;
  readonly requiresHumanSplit: readonly LegacyPlanSplitRequirement[];
  /** Anything the import could not carry, stated rather than dropped. */
  readonly notes: readonly string[];
}

/**
 * The document's own bounds (`delivery-plan.ts`), restated where the import
 * has to stay inside them. An approved spec's section bodies are unbounded, so
 * an import that assumed they fit could produce a document the write route
 * refuses — with no receipt saying which sentence was the problem.
 */
const MAX_TOUCHED_SURFACES = 300;
const MAX_MISSION = 8000;
const MAX_INVARIANT_STATEMENT = 8000;

function withinBound(
  value: string,
  bound: number,
  onOverflow: () => void,
  fallback: string,
): string {
  if (value.length <= bound) return value;
  onOverflow();
  return fallback.length <= bound ? fallback : fallback.slice(0, bound);
}

export function importLegacyDeliveryPlan(
  input: LegacyDeliveryPlanImportInput,
): LegacyDeliveryPlanImport {
  const index = indexLegacyRevision(input.specSlug, input.snapshot);
  const selectedTaskIds = new Set(input.scope.selectedTaskIds);
  const selectedCriterionIds = new Set(input.scope.selectedCriterionIds);
  const notes: string[] = [];

  // Snapshot order, not scope order: the compiled plan read tasks in the
  // revision's own order, and an import that reordered them would renumber
  // every context for no authored reason.
  const selectedTasks = input.snapshot.elements.flatMap(({ element }) => {
    const task = index.tasks.get(element.id);
    return task !== undefined && selectedTaskIds.has(element.id) ? [task] : [];
  });
  const missingTaskIds = [...selectedTaskIds].filter(
    (taskId) => !index.tasks.has(taskId),
  );
  if (missingTaskIds.length > 0) {
    notes.push(
      `The legacy scope named ${missingTaskIds.length} task element${missingTaskIds.length === 1 ? "" : "s"} revision ${input.snapshot.revision.id} does not carry (${missingTaskIds.join(", ")}); they were not imported.`,
    );
  }

  const contraction = contractTaskGroups(
    selectedTasks.map((task) => ({
      id: task.element.element.id,
      handle: task.handle,
      ...(task.payload.laneGroup === undefined
        ? {}
        : { laneGroup: task.payload.laneGroup }),
      dependsOnTaskIds: task.payload.dependsOnTaskElementIds,
    })),
  );
  if (contraction.intraGroupCycleTaskIds !== undefined) {
    notes.push(
      `The legacy plan's lane members form a dependency cycle (${contraction.intraGroupCycleTaskIds.join(", ")}); the cycle's tasks were appended in handle order and their sequence needs an author's decision.`,
    );
  }

  const contextIdsByGroupId = contextIdsForGroups(contraction.groups, index);
  const contextIdByTaskId = new Map<string, string>();
  for (const group of contraction.groups) {
    const contextId = required(contextIdsByGroupId, group.id);
    for (const taskId of group.orderedTaskIds) {
      contextIdByTaskId.set(taskId, contextId);
    }
  }

  const ownership = resolveOwnership(
    contraction.groups,
    contextIdsByGroupId,
    index,
    selectedCriterionIds,
    input.specSlug,
  );

  const contexts: DeliveryPlanContext[] = contraction.groups.map((group) => {
    const contextId = required(contextIdsByGroupId, group.id);
    const members = group.orderedTaskIds.flatMap((taskId) => {
      const task = index.tasks.get(taskId);
      return task === undefined ? [] : [task];
    });
    const owned = ownership.ownedByContextId.get(contextId) ?? [];
    return {
      contextId,
      title: legacyContextTitle({
        laneGroup: group.laneGroup,
        // Handle order, not execution order — the same order the compiler
        // named a lane's members in, so a lane title carried over from a
        // legacy plan reads identically to the one that ran.
        members: [...members]
          .sort((left, right) => (left.handle < right.handle ? -1 : 1))
          .map((member) => ({
            handle: member.handle,
            title: member.payload.title,
          })),
        fallbackId: contextId,
      }),
      // A context that owns no criterion cannot be a delivery context: the
      // plan says with a type what the compiler used to say with an apology.
      contextType: owned.length === 0 ? "integration" : "delivery",
      criterionElementIds: owned.map(
        (criterion) => criterion.element.element.id,
      ),
      // Only what the approved revision already said. Authoring a contract for
      // a criterion-less context would manufacture the one thing a validator
      // is held to, so lint asks the human for it instead.
      acceptanceContract: owned.map((criterion) =>
        legacyCriterionBrief([renderCriterion(criterion)]),
      ),
      proofPlan: owned.map((criterion) => ({
        criterionElementId: criterion.element.element.id,
        evidenceKinds: [...criterion.payload.validationStrategy.kinds],
        note:
          criterion.payload.validationStrategy.note ??
          "Imported from the approved validation strategy; the revision approved no additional note.",
      })),
    };
  });

  const tasks: DeliveryPlanTask[] = contraction.groups.flatMap((group) => {
    const contextId = required(contextIdsByGroupId, group.id);
    return group.orderedTaskIds.flatMap((taskId, order) => {
      const task = index.tasks.get(taskId);
      if (task === undefined) return [];
      const covered = coveredSelectedCriteria(
        task,
        selectedCriterionIds,
        index,
      );
      return [
        {
          taskId: planNodeId(task.handle),
          contextId,
          title: `${task.handle} ${task.payload.title}`,
          instructions: legacyTaskInstructions({
            task: {
              handle: task.handle,
              title: task.payload.title,
              instructions: task.payload.instructions,
            },
            requirements: task.payload.tracedRequirementElementIds.flatMap(
              (requirementId) => {
                const requirement = index.requirements.get(requirementId);
                return requirement === undefined
                  ? []
                  : [
                      {
                        handle: requirement.handle,
                        statement: requirement.payload.statement,
                      },
                    ];
              },
            ),
            decisions: task.payload.tracedDecisionElementIds.flatMap(
              (decisionId) => {
                const decision = index.decisions.get(decisionId);
                return decision === undefined
                  ? []
                  : [
                      {
                        handle: decision.handle,
                        title: decision.payload.title,
                        chosenApproach: decision.payload.chosenApproach,
                        reason: decision.payload.reason,
                      },
                    ];
              },
            ),
            criteria: covered.map(renderCriterion),
            unmappedCriterionNotice: "omit",
          }),
          order,
          // Provenance, not a contract: a criterion sent to the split list
          // still shows which tasks reached it, which is how an author decides
          // where it belongs.
          contributesToCriterionElementIds: covered.map(
            (criterion) => criterion.element.element.id,
          ),
        },
      ];
    });
  });

  const edges = contractedEdges(contraction.edges, contextIdsByGroupId);
  const touched = touchedSurfaces(selectedTasks, notes);

  return {
    document: {
      ...emptyDeliveryPlanDocument(),
      contexts,
      tasks,
      edges,
      touchedSurfaces: touched,
      governance: governanceOf(input, index, ownership.ownedInOrder, notes),
    },
    requiresHumanSplit: ownership.requiresHumanSplit,
    notes,
  };
}

interface ResolvedOwnership {
  readonly ownedByContextId: ReadonlyMap<string, IndexedCriterion[]>;
  /** Every owned criterion in context order, for the mission line. */
  readonly ownedInOrder: readonly IndexedCriterion[];
  readonly requiresHumanSplit: readonly LegacyPlanSplitRequirement[];
}

/**
 * Which context owns which criterion. A criterion covered only from inside one
 * context belongs to it; a criterion reached from two contexts belongs to
 * neither until a human says so, and the plan lint's `plan/selected-unowned`
 * finding keeps it from proposing in the meantime.
 */
function resolveOwnership(
  groups: readonly ContractedTaskGroup[],
  contextIdsByGroupId: ReadonlyMap<string, string>,
  index: RevisionIndex,
  selectedCriterionIds: ReadonlySet<string>,
  specSlug: string,
): ResolvedOwnership {
  const contextIdsByCriterion = new Map<string, string[]>();
  const orderedCriterionIds: string[] = [];
  for (const group of groups) {
    const contextId = required(contextIdsByGroupId, group.id);
    for (const taskId of group.orderedTaskIds) {
      const task = index.tasks.get(taskId);
      if (task === undefined) continue;
      for (const criterion of coveredSelectedCriteria(
        task,
        selectedCriterionIds,
        index,
      )) {
        const criterionId = criterion.element.element.id;
        const contextIds = contextIdsByCriterion.get(criterionId);
        if (contextIds === undefined) {
          contextIdsByCriterion.set(criterionId, [contextId]);
          orderedCriterionIds.push(criterionId);
        } else if (!contextIds.includes(contextId)) {
          contextIds.push(contextId);
        }
      }
    }
  }

  const ownedByContextId = new Map<string, IndexedCriterion[]>();
  const ownedInOrder: IndexedCriterion[] = [];
  const ambiguous: {
    criterion: IndexedCriterion;
    contextIds: readonly string[];
  }[] = [];
  for (const criterionId of orderedCriterionIds) {
    const criterion = index.criteria.get(criterionId);
    const contextIds = contextIdsByCriterion.get(criterionId) ?? [];
    if (criterion === undefined) continue;
    const soleOwner = contextIds.length === 1 ? contextIds[0] : undefined;
    if (soleOwner === undefined) {
      ambiguous.push({
        criterion,
        contextIds: [...contextIds].sort((left, right) =>
          left.localeCompare(right),
        ),
      });
      continue;
    }
    const owned = ownedByContextId.get(soleOwner) ?? [];
    owned.push(criterion);
    ownedByContextId.set(soleOwner, owned);
    ownedInOrder.push(criterion);
  }

  // Built only once ownership is final: whether a contender can be re-typed as
  // an integration context depends on what else it ends up owning, which is
  // not known while the criteria are still being assigned.
  const requiresHumanSplit = ambiguous.map(({ criterion, contextIds }) => ({
    criterionElementId: criterion.element.element.id,
    handle: criterion.handle,
    contextIds,
    resolution: splitResolution(
      criterion.handle,
      contextIds,
      ownedByContextId,
      specSlug,
    ),
  }));

  return { ownedByContextId, ownedInOrder, requiresHumanSplit };
}

/**
 * The act that resolves one ambiguous criterion. Typing a losing contender as
 * an integration context is only sound when it owns nothing else — telling an
 * author to re-type a context that still owns another criterion would strand
 * that work — so the remedy names re-typing only where it actually applies.
 */
function splitResolution(
  handle: string,
  contextIds: readonly string[],
  ownedByContextId: ReadonlyMap<string, IndexedCriterion[]>,
  specSlug: string,
): string {
  const ownsNothingElse = contextIds.filter(
    (contextId) => (ownedByContextId.get(contextId) ?? []).length === 0,
  );
  const reType =
    ownsNothingElse.length === contextIds.length
      ? " and type the others as integration contexts"
      : ownsNothingElse.length === 0
        ? " and leave the others owning the criteria they already own"
        : ` and type ${ownsNothingElse.join(", ")} as integration contexts if left owning nothing`;
  return `Split ${handle} into one criterion per context, or give one of ${contextIds.join(", ")} sole ownership${reType}, then re-run \`cctl spec plan edit ${specSlug} --file <plan.json>\`.`;
}

function contractedEdges(
  contractedEdgeList: readonly {
    sourceGroupId: string;
    targetGroupId: string;
  }[],
  contextIdsByGroupId: ReadonlyMap<string, string>,
): DeliveryPlanEdge[] {
  // Deduplicated on the context PAIR rather than on the composed id: a node id
  // is bounded, so two distinct pairs can share a truncated id, and collapsing
  // on that would silently delete every pair but the first.
  const seen = new Set<string>();
  return contractedEdgeList.flatMap((edge) => {
    const fromContextId = required(contextIdsByGroupId, edge.sourceGroupId);
    const toContextId = required(contextIdsByGroupId, edge.targetGroupId);
    const pair = `${fromContextId}|${toContextId}`;
    if (seen.has(pair)) return [];
    seen.add(pair);
    return [
      {
        edgeId: boundedNodeId(`${fromContextId}-to-${toContextId}`),
        fromContextId,
        toContextId,
      },
    ];
  });
}

/**
 * The imported plan's node identity. It is the bare approved handle rather than
 * the compiler's `context-<elementId>`, because a plan document is authored and
 * re-read by humans: `t7` and `lane-persistence` address a node an author can
 * find in the spec, while an element id addresses a row.
 */
function contextIdsForGroups(
  groups: readonly ContractedTaskGroup[],
  index: RevisionIndex,
): ReadonlyMap<string, string> {
  const contextIds = new Map<string, string>();
  const used = new Set<string>();
  for (const group of groups) {
    const firstTask = group.orderedTaskIds
      .map((taskId) => index.tasks.get(taskId))
      .find((task): task is IndexedTask => task !== undefined);
    const base =
      group.laneGroup === undefined
        ? planNodeId(firstTask?.handle ?? group.id)
        : boundedNodeId(`lane-${slugComponent(group.laneGroup)}`);
    let contextId = base;
    let suffix = 2;
    // Terminates because a bounded id keeps a digest of its whole input: two
    // suffixes never reduce to the same id however long the lane name is.
    while (used.has(contextId)) {
      contextId = boundedNodeId(`${base}-${suffix}`);
      suffix += 1;
    }
    used.add(contextId);
    contextIds.set(group.id, contextId);
  }
  return contextIds;
}

function planNodeId(qualifiedHandle: string): string {
  return boundedNodeId(slugComponent(bareHandle(qualifiedHandle)));
}

function slugComponent(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length === 0 ? "node" : slug;
}

/**
 * `nodeIdSchema` caps a node id at 120 characters. Truncating alone would map
 * two distinct long ids onto one, and a collision here does not surface as an
 * error — it drops a context or an edge — so an over-long id keeps a digest of
 * the whole value it was cut from. `laneGroup` is unbounded free text in an
 * approved revision, which is what makes this reachable rather than theoretical.
 */
const MAX_NODE_ID = 120;
const NODE_ID_DIGEST = 8;

function boundedNodeId(value: string): string {
  if (value.length <= MAX_NODE_ID) return value;
  const digest = createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, NODE_ID_DIGEST);
  return `${value.slice(0, MAX_NODE_ID - NODE_ID_DIGEST - 1)}-${digest}`;
}

function coveredSelectedCriteria(
  task: IndexedTask,
  selectedCriterionIds: ReadonlySet<string>,
  index: RevisionIndex,
): IndexedCriterion[] {
  return task.payload.coveredCriterionElementIds.flatMap((criterionId) => {
    if (!selectedCriterionIds.has(criterionId)) return [];
    const criterion = index.criteria.get(criterionId);
    return criterion === undefined ? [] : [criterion];
  });
}

function touchedSurfaces(
  selectedTasks: readonly IndexedTask[],
  notes: string[],
): string[] {
  const surfaces: string[] = [];
  const seen = new Set<string>();
  for (const task of selectedTasks) {
    for (const path of task.payload.touchedPaths ?? []) {
      if (seen.has(path)) continue;
      seen.add(path);
      surfaces.push(path);
    }
  }
  if (surfaces.length <= MAX_TOUCHED_SURFACES) return surfaces;
  notes.push(
    `The legacy plan declared ${surfaces.length} touched paths; the plan document carries ${MAX_TOUCHED_SURFACES} and the remaining ${surfaces.length - MAX_TOUCHED_SURFACES} were not imported.`,
  );
  return surfaces.slice(0, MAX_TOUCHED_SURFACES);
}

/**
 * The governance the legacy charter carried, restated in the plan's own
 * vocabulary. The compiler synthesized a charter at compile time from the
 * revision's intent sections; the plan authors it once, so the import seeds it
 * from the same sections and leaves it editable.
 */
function governanceOf(
  input: LegacyDeliveryPlanImportInput,
  index: RevisionIndex,
  ownedInOrder: readonly IndexedCriterion[],
  notes: string[],
): DeliveryPlanDocument["governance"] {
  const revision = input.snapshot.revision;
  const scopedMission = `Deliver ${input.specName} revision ${revision.number} for scoped criteria ${ownedInOrder
    .map((criterion) => criterion.handle)
    .join(", ")}.`;
  const outcomes = index.sections
    .filter(({ payload }) => payload.role === "intent_outcomes")
    .map(({ payload }) => payload.body);
  return {
    // Prose the schema cannot hold is left out and named, never cut: a charter
    // truncated mid-sentence reads as a complete instruction.
    mission: withinBound(
      [scopedMission, ...outcomes].join("\n\n"),
      MAX_MISSION,
      () =>
        notes.push(
          `The legacy charter's mission and intent outcomes exceed the plan document's ${MAX_MISSION}-character mission; only the scoped mission was imported. Re-read them with \`cctl spec get ${input.specSlug} --revision ${revision.id}\`.`,
        ),
      scopedMission,
    ),
    charterInvariants: index.sections
      .filter(({ payload }) => payload.role === "intent_constraints")
      .flatMap(({ element, payload }) => {
        if (payload.body.length > MAX_INVARIANT_STATEMENT) {
          notes.push(
            `Constraint section ${element.element.id} is ${payload.body.length} characters, past the plan document's ${MAX_INVARIANT_STATEMENT}-character invariant bound; it was not imported as a charter invariant. Author it with \`cctl spec plan edit ${input.specSlug} --file <plan.json>\`.`,
          );
          return [];
        }
        return [
          {
            id: `spec-constraint-${element.element.id}`,
            statement: payload.body,
          },
        ];
      }),
    sourcesOfTruth: [
      {
        rank: 1,
        id: `spec-${revision.specId}-revision-${revision.id}`,
        label: `${input.specName} approved revision ${revision.number}`,
        type: "spec",
        // The revision alone, with no scope query: the plan document is the
        // scope now, so pinning a legacy scope hash here would name a second
        // answer to the same question.
        locator: `spec://${input.specSlug}/revisions/${revision.id}`,
        description: `The immutable approved revision the legacy execution ${input.sourceExecutionId} delivered against.`,
        appliesTo: "all execution contexts",
        accessPolicy: "worktree-relative",
      },
    ],
    // The legacy path selected validation through global workflow defaults, so
    // there is nothing authored to carry; the author states the selection.
    validationCommandNames: [],
  };
}

function required(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined) {
    throw new Error(`Cannot import legacy plan: unknown task group ${key}.`);
  }
  return value;
}
