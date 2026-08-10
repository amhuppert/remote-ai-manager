import { z } from "zod";
import type { WorkflowSemanticDefinition } from "@/lib/workflow-graph/definition-schemas";
import { findCriteriaWithoutMustRunCoverage } from "@/lib/workflow-graph/criterion-coverage";
import {
  evidenceKindSchema,
  isMachineValidationEvidenceKind,
  type CriterionElementPayload,
  type DecisionElementPayload,
  type EvidenceKind,
  type RequirementElementPayload,
  type SectionElementPayload,
  type SpecRevisionElement,
  type SpecRevisionSnapshot,
  type TaskElementPayload,
  type ValidationStrategy,
} from "./schemas";
import {
  contractTaskGroups,
  type ContractedTaskGroup,
} from "./group-contraction";
import {
  bareHandle,
  LEGACY_GROUP_ACCEPTANCE_CRITERIA,
  legacyContextTitle,
  legacyCriterionBrief,
  legacyTaskInstructions,
} from "./legacy-plan-render";
import type { ExecutionScope } from "./scope-validation";
import type { ScopePlan } from "./scope-validation";

export interface CompilerSpecIdentity {
  id: string;
  slug: string;
  name: string;
}

export interface CompileSpecExecutionPlanInput {
  spec: CompilerSpecIdentity;
  revisionSnapshot: SpecRevisionSnapshot;
  scope: ExecutionScope;
  scopeHash: string;
  approvalRequired: boolean;
}

export interface IndexedRequirement {
  element: SpecRevisionElement;
  payload: RequirementElementPayload;
  handle: string;
}

export interface IndexedCriterion {
  element: SpecRevisionElement;
  payload: CriterionElementPayload;
  handle: string;
}

export interface IndexedDecision {
  element: SpecRevisionElement;
  payload: DecisionElementPayload;
  handle: string;
}

export interface IndexedSection {
  element: SpecRevisionElement;
  payload: SectionElementPayload;
}

export interface IndexedTask {
  element: SpecRevisionElement;
  payload: TaskElementPayload;
  handle: string;
}

export interface RevisionIndex {
  requirements: Map<string, IndexedRequirement>;
  criteria: Map<string, IndexedCriterion>;
  decisions: Map<string, IndexedDecision>;
  sections: IndexedSection[];
  tasks: Map<string, IndexedTask>;
}

export interface CompiledOriginMapEntry {
  contextId: string;
  taskElementId: string;
  taskHandle: string;
  touchedPaths: string[];
  criterionElementIds: string[];
  criterionHandles: string[];
  validationStrategies: Record<string, ValidationStrategy>;
  criterionBriefs: Record<string, string>;
}

export interface CompiledContextContract {
  contextId: string;
  taskElementIds: string[];
  criterionElementIds: string[];
  criterionHandles: string[];
  validationStrategies: Record<string, ValidationStrategy>;
  acceptanceCriteria: string;
}

const metadataKeys = {
  revisionId: "specRevisionId",
  taskElementId: "specTaskElementId",
  taskHandle: "specTaskHandle",
  criterionElementIds: "specCriterionElementIds",
  criterionHandles: "specCriterionHandles",
  dependsOnTaskElementIds: "specDependsOnTaskElementIds",
  validationStrategies: "specValidationStrategies",
  criterionBriefs: "specCriterionBriefs",
  touchedPaths: "specTouchedPaths",
} as const;

const GROUP_ACCEPTANCE_CRITERIA = LEGACY_GROUP_ACCEPTANCE_CRITERIA;

export function compileSpecExecutionPlan(
  input: CompileSpecExecutionPlanInput,
): WorkflowSemanticDefinition {
  if (input.revisionSnapshot.revision.state !== "approved") {
    throw new Error(
      `Cannot compile revision ${input.revisionSnapshot.revision.id}: revision is not approved.`,
    );
  }
  return materializeSpecExecutionPlan(input);
}

/**
 * The legacy evergreen materialization, without the approved-revision
 * precondition.
 *
 * Only the retired read-only evergreen preview calls this. Active execution
 * starts read the immutable candidate a DeliveryPlanAttempt materialized at
 * propose time; neither function in this module participates in launch.
 */
export function materializeSpecExecutionPlan(
  input: CompileSpecExecutionPlanInput,
): WorkflowSemanticDefinition {
  if (input.scopeHash.length === 0) {
    throw new Error("Cannot compile an execution scope without a scope hash.");
  }

  const index = indexRevision(input.spec.slug, input.revisionSnapshot);
  const selectedTaskIds = new Set(input.scope.selectedTaskIds);
  const selectedCriterionIds = new Set(input.scope.selectedCriterionIds);
  const selectedTasks = input.revisionSnapshot.elements
    .map(({ element }) => index.tasks.get(element.id))
    .filter(
      (task): task is IndexedTask =>
        task !== undefined && selectedTaskIds.has(task.element.element.id),
    );
  assertSelectedElementsExist(input.scope, index);
  for (const task of selectedTasks) {
    for (const dependencyTaskId of task.payload.dependsOnTaskElementIds) {
      if (!selectedTaskIds.has(dependencyTaskId)) {
        throw new Error(
          `Cannot compile ${task.handle}: dependency ${dependencyTaskId} is outside the validated scope.`,
        );
      }
      requireTask(index, dependencyTaskId);
    }
  }

  const contraction = contractTaskGroups(
    selectedTasks.map((task) => ({
      id: task.element.element.id,
      handle: task.handle,
      laneGroup: task.payload.laneGroup,
      dependsOnTaskIds: task.payload.dependsOnTaskElementIds,
    })),
  );
  if (contraction.intraGroupCycleTaskIds !== undefined) {
    throw new Error(
      `Cannot compile task dependency cycle: ${contraction.intraGroupCycleTaskIds.join(", ")}.`,
    );
  }
  if (contraction.groupCycle !== undefined) {
    throw new Error(
      `Cannot compile lane-group cycle: ${contraction.groupCycle.join(" -> ")}.`,
    );
  }

  const revisionId = input.revisionSnapshot.revision.id;
  const revisionSourceUri = `spec://${input.spec.slug}/revisions/${revisionId}?scope=${input.scopeHash}`;
  const executionOriginSourceUri = specExecutionOriginSourceUri(
    input.spec.id,
    revisionId,
    input.scopeHash,
  );
  const taskContracts = new Map(
    selectedTasks.map((task) => {
      const criteria = coveredSelectedCriteria(
        task,
        selectedCriterionIds,
        index,
      );
      const requirements = task.payload.tracedRequirementElementIds.map(
        (requirementId) =>
          requireRequirement(index, requirementId, task.handle),
      );
      const decisions = task.payload.tracedDecisionElementIds.map(
        (decisionId) => requireDecision(index, decisionId, task.handle),
      );
      const validationStrategies = Object.fromEntries(
        criteria.map((criterion) => [
          criterion.element.element.id,
          criterion.payload.validationStrategy,
        ]),
      );
      const criterionBriefs = Object.fromEntries(
        criteria.map((criterion) => [
          criterion.element.element.id,
          validatorBrief([criterion]),
        ]),
      );
      return [
        task.element.element.id,
        {
          task,
          criteria,
          requirements,
          decisions,
          validationStrategies,
          criterionBriefs,
        },
      ] as const;
    }),
  );
  const groupsById = new Map(
    contraction.groups.map((group) => [group.id, group]),
  );
  const contextIdsByGroupId = contextIdsForGroups(contraction.groups);
  const orderedSelectedTasks = contraction.groups.flatMap((group) =>
    group.orderedTaskIds.map((taskId) => requireTask(index, taskId)),
  );
  const tasks = contraction.groups.flatMap((group) =>
    group.orderedTaskIds.map((taskId, orderIndex) => {
      const contract = taskContracts.get(taskId);
      if (contract === undefined) {
        throw new Error(`Cannot compile missing selected task ${taskId}.`);
      }
      const { task, criteria, requirements, decisions } = contract;
      return {
        id: compiledWorkflowTaskId(task.element.element.id),
        contextId: requiredMapValue(
          contextIdsByGroupId,
          group.id,
          "task context",
        ),
        order: orderIndex + 1,
        title: `${task.handle} ${task.payload.title}`,
        instructions: taskInstructions(task, requirements, criteria, decisions),
        metadata: {
          [metadataKeys.revisionId]: revisionId,
          [metadataKeys.taskElementId]: task.element.element.id,
          [metadataKeys.taskHandle]: task.handle,
          [metadataKeys.criterionElementIds]: JSON.stringify(
            criteria.map((criterion) => criterion.element.element.id),
          ),
          [metadataKeys.criterionHandles]: JSON.stringify(
            criteria.map((criterion) => criterion.handle),
          ),
          [metadataKeys.dependsOnTaskElementIds]: JSON.stringify(
            task.payload.dependsOnTaskElementIds,
          ),
          [metadataKeys.validationStrategies]: JSON.stringify(
            contract.validationStrategies,
          ),
          [metadataKeys.criterionBriefs]: JSON.stringify(
            contract.criterionBriefs,
          ),
          ...(task.payload.touchedPaths === undefined
            ? {}
            : {
                [metadataKeys.touchedPaths]: JSON.stringify(
                  task.payload.touchedPaths,
                ),
              }),
        },
        source: "user" as const,
      };
    }),
  );
  const executionContexts = contraction.groups.map((group) => {
    const members = group.orderedTaskIds.map((taskId) => {
      const contract = taskContracts.get(taskId);
      if (contract === undefined) {
        throw new Error(`Cannot compile missing selected task ${taskId}.`);
      }
      return contract;
    });
    const title = contextTitle(
      group,
      members.map(({ task }) => task),
    );
    return {
      id: requiredMapValue(contextIdsByGroupId, group.id, "execution context"),
      title,
      description: contextDescription(
        group,
        members.map(({ task }) => task),
      ),
      acceptanceCriteria: contextAcceptanceCriteria(
        members.map(({ criterionBriefs }) => criterionBriefs),
      ),
      origin: {
        sourceUri: revisionSourceUri,
        label: `${input.spec.slug} ${title}`,
      },
    };
  });

  const compiledEdges = contraction.edges.map((contractedEdge) => {
    const sourceGroup = groupsById.get(contractedEdge.sourceGroupId);
    const targetGroup = groupsById.get(contractedEdge.targetGroupId);
    if (sourceGroup === undefined || targetGroup === undefined) {
      throw new Error("Cannot compile an edge for an unknown task group.");
    }
    const dependentTasks = contractedEdge.dependencyPairs
      .map(({ targetTaskId }) => requireTask(index, targetTaskId))
      .sort(compareIndexedTasks);
    const targetTask = dependentTasks[0];
    if (targetTask === undefined) {
      throw new Error("Cannot compile a dependency edge without provenance.");
    }
    const sourceContextId = requiredMapValue(
      contextIdsByGroupId,
      sourceGroup.id,
      "source context",
    );
    const targetContextId = requiredMapValue(
      contextIdsByGroupId,
      targetGroup.id,
      "target context",
    );
    return {
      edge: {
        id: edgeIdForGroups(sourceGroup, targetGroup),
        sourceContextId,
        targetContextId,
      },
      targetTask,
    };
  });
  const edges = compiledEdges.map(({ edge }) => edge);

  assertCriterionMustRunCoverage({
    executionContexts,
    edges,
    index,
    selectedCriterionIds: input.scope.selectedCriterionIds,
    coveringContextIdsByCriterionId: criterionCoverage(
      contraction.groups,
      contextIdsByGroupId,
      taskContracts,
    ),
  });

  const lockedRegions = [
    {
      paths: ["/approvalRequired", "/origin", "/charter"],
      sourceUri: revisionSourceUri,
      reason:
        "Pinned revision, execution scope, and approval policy come from the approved spec contract.",
    },
    ...orderedSelectedTasks.map((task) => ({
      paths: [
        `/tasks/${compiledWorkflowTaskId(task.element.element.id)}/id`,
        `/tasks/${compiledWorkflowTaskId(task.element.element.id)}/title`,
        `/tasks/${compiledWorkflowTaskId(task.element.element.id)}/instructions`,
        `/tasks/${compiledWorkflowTaskId(task.element.element.id)}/metadata`,
      ],
      sourceUri: taskSourceUri(input.spec.slug, task.handle, revisionId),
      reason:
        "Task content, criterion mapping, and validation strategy come from the approved spec contract.",
    })),
    ...compiledEdges.map(({ edge, targetTask }) => {
      return {
        paths: [
          `/edges/${edge.id}/id`,
          `/edges/${edge.id}/sourceContextId`,
          `/edges/${edge.id}/targetContextId`,
        ],
        sourceUri: taskSourceUri(
          input.spec.slug,
          targetTask.handle,
          revisionId,
        ),
        reason: "The dependency edge is compiled from the approved task plan.",
      };
    }),
  ];

  return {
    schemaVersion: 1,
    approvalRequired: input.approvalRequired,
    origin: {
      sourceUri: executionOriginSourceUri,
      label: `${input.spec.name} revision ${input.revisionSnapshot.revision.number}`,
    },
    lockedRegions,
    workflowConfig: {},
    charter: compileCharter(
      input,
      index,
      selectedTasks,
      selectedCriterionIds,
      revisionSourceUri,
    ),
    parameters: [],
    prerequisites: [],
    executionContexts,
    tasks,
    edges,
  };
}

export interface SpecCriterionCoverageGap {
  criterionElementId: string;
  criterionHandle: string;
  coveringContextIds: string[];
}

/**
 * A scope whose criterion is covered only on contexts that a route could skip
 * (R5.1). Typed and criterion-naming because the caller's remedy is a scope
 * change — select the task that covers it, or cover it on a context that runs
 * on every path — not a retry.
 */
export class SpecCriterionCoverageError extends Error {
  readonly code = "spec-criterion-without-must-run-coverage";
  readonly gaps: readonly SpecCriterionCoverageGap[];

  constructor(gaps: readonly SpecCriterionCoverageGap[]) {
    super(
      `Cannot compile the execution scope: ${gaps
        .map(
          (gap) =>
            `${gap.criterionHandle} has no coverage on a context that runs on every path${
              gap.coveringContextIds.length === 0
                ? ""
                : ` (covered only on ${gap.coveringContextIds.join(", ")})`
            }`,
        )
        .join("; ")}.`,
    );
    this.name = "SpecCriterionCoverageError";
    this.gaps = gaps;
  }
}

/** Which compiled contexts carry a task covering each criterion. */
function criterionCoverage(
  groups: readonly ContractedTaskGroup[],
  contextIdsByGroupId: ReadonlyMap<string, string>,
  taskContracts: ReadonlyMap<string, { criteria: readonly IndexedCriterion[] }>,
): Map<string, string[]> {
  const coverage = new Map<string, string[]>();
  for (const group of groups) {
    const contextId = requiredMapValue(
      contextIdsByGroupId,
      group.id,
      "criterion coverage context",
    );
    for (const taskId of group.orderedTaskIds) {
      const contract = taskContracts.get(taskId);
      if (contract === undefined) continue;
      for (const criterion of contract.criteria) {
        const criterionId = criterion.element.element.id;
        const covering = coverage.get(criterionId) ?? [];
        if (!covering.includes(contextId)) covering.push(contextId);
        coverage.set(criterionId, covering);
      }
    }
  }
  return coverage;
}

/**
 * R5.1: refuse a scope in which some selected criterion has no coverage on any
 * must-run context. Today's compiler emits only unconditional edges, so every
 * compiled context is must-run and the check can only fire on a criterion no
 * selected task covers at all — it passes vacuously, by design, and becomes
 * load-bearing the moment authoring inputs can express routing. It shares
 * `findCriteriaWithoutMustRunCoverage` with the runtime frontier lock so both
 * refusals mean the same thing.
 */
function assertCriterionMustRunCoverage(input: {
  executionContexts: readonly { id: string }[];
  edges: readonly {
    id: string;
    sourceContextId: string;
    targetContextId: string;
  }[];
  index: RevisionIndex;
  selectedCriterionIds: readonly string[];
  coveringContextIdsByCriterionId: ReadonlyMap<string, string[]>;
}): void {
  const gaps = findCriteriaWithoutMustRunCoverage({
    executionContexts: input.executionContexts,
    edges: input.edges,
    coverageByCriterionId: Object.fromEntries(
      input.selectedCriterionIds.map((criterionId) => [
        criterionId,
        input.coveringContextIdsByCriterionId.get(criterionId) ?? [],
      ]),
    ),
  });
  if (gaps.length === 0) return;
  throw new SpecCriterionCoverageError(
    gaps.map((gap) => ({
      criterionElementId: gap.criterionId,
      criterionHandle:
        input.index.criteria.get(gap.criterionId)?.handle ?? gap.criterionId,
      coveringContextIds: [...gap.coveringContextIds],
    })),
  );
}

export function specExecutionOriginSourceUri(
  specId: string,
  revisionId: string,
  scopeHash: string,
): string {
  return `spec-execution://${specId}/revisions/${revisionId}?scope=${scopeHash}`;
}

export function scopePlanFromRevision(
  specSlug: string,
  snapshot: SpecRevisionSnapshot,
): ScopePlan {
  const index = indexRevision(specSlug, snapshot);
  return {
    tasks: snapshot.elements.flatMap(({ element }) => {
      const task = index.tasks.get(element.id);
      if (task === undefined) return [];
      return [
        {
          id: element.id,
          handle: task.handle,
          dependsOnTaskIds: [...task.payload.dependsOnTaskElementIds],
          coveredCriterionIds: [...task.payload.coveredCriterionElementIds],
        },
      ];
    }),
    criteria: snapshot.elements.flatMap(({ element }) => {
      const criterion = index.criteria.get(element.id);
      if (criterion === undefined) return [];
      return [{ id: element.id, handle: criterion.handle }];
    }),
  };
}

function compileCharter(
  input: CompileSpecExecutionPlanInput,
  index: RevisionIndex,
  selectedTasks: readonly IndexedTask[],
  selectedCriterionIds: ReadonlySet<string>,
  revisionSourceUri: string,
): WorkflowSemanticDefinition["charter"] {
  const scopedMission = `Deliver ${input.spec.name} revision ${input.revisionSnapshot.revision.number} for scoped criteria ${selectedTasks
    .flatMap((task) =>
      coveredSelectedCriteria(task, selectedCriterionIds, index).map(
        (criterion) => criterion.handle,
      ),
    )
    .join(", ")}.`;
  const outcomes = index.sections
    .filter(({ payload }) => payload.role === "intent_outcomes")
    .map(({ payload }) => payload.body);
  const nonGoals = index.sections
    .filter(({ payload }) => payload.role === "intent_non_goals")
    .map(({ payload }) => `${payload.title}: ${payload.body}`);
  const invariants = index.sections
    .filter(({ payload }) => payload.role === "intent_constraints")
    .map(({ element, payload }) => ({
      id: `spec-constraint-${element.element.id}`,
      statement: payload.body,
    }));

  return {
    mission: [scopedMission, ...outcomes].join("\n\n"),
    conventions: [
      "Implement only the task and criterion contract in the current lane context pack.",
      "Treat approved validation strategy notes as the boundary of validator judgment.",
    ],
    nonGoals: [...nonGoals, "Work excluded from the pinned execution scope."],
    ...(invariants.length === 0 ? {} : { invariants }),
    testStrategy:
      "Use the required validation strategy attached to each scoped criterion.",
    sourcesOfTruth: [
      {
        rank: 1,
        id: `spec-${input.spec.id}-revision-${input.revisionSnapshot.revision.id}`,
        label: `${input.spec.name} approved revision ${input.revisionSnapshot.revision.number}`,
        type: "spec",
        locator: revisionSourceUri,
        description:
          "The immutable approved revision and validated execution scope.",
        appliesTo: "all execution contexts",
        accessPolicy: "worktree-relative",
      },
    ],
  };
}

/**
 * Frozen copy of the pre-narrowing six-kind vocabulary. Compiled workflow
 * definitions are persisted (config-dir definition records and the immutable
 * `graph_workflow_executions.definition_json` pin), so strategy metadata
 * written before the vocabulary narrowed can still carry dropped kinds. This
 * lenient schema accepts those historical bytes so the read boundary can
 * normalize them — the pinned bytes themselves are never rewritten.
 */
const frozenSixKindEvidenceKindSchema = z.enum([
  "diff",
  "commit",
  "test_run",
  "validator_verdict",
  "screenshot",
  "human_signoff",
]);
const frozenLenientStrategySchema = z
  .object({
    kinds: z.array(frozenSixKindEvidenceKindSchema),
    note: z.string().optional(),
  })
  .strict();
const compiledStrategyMetadataSchema = z.record(
  z.string(),
  frozenLenientStrategySchema,
);

/**
 * The same pure rule migration 0009 applies to persisted strategies: strip
 * dropped kinds, dedupe, and append `validator_verdict` when no machine kind
 * remains, so every strategy a reader sees is machine-provable.
 */
function normalizeCompiledStrategy(
  strategy: z.infer<typeof frozenLenientStrategySchema>,
): ValidationStrategy {
  const surviving = [
    ...new Set(
      strategy.kinds.filter(
        (kind): kind is EvidenceKind =>
          evidenceKindSchema.safeParse(kind).success,
      ),
    ),
  ];
  const kinds = surviving.some(isMachineValidationEvidenceKind)
    ? surviving
    : [...surviving, "validator_verdict" as const];
  return {
    kinds,
    ...(strategy.note === undefined ? {} : { note: strategy.note }),
  };
}

function readCompiledStrategyMetadata(
  metadata: Record<string, string>,
  taskId: string,
): Record<string, ValidationStrategy> {
  const raw = parseMetadataJson<unknown>(
    metadata,
    metadataKeys.validationStrategies,
  );
  const parsed = compiledStrategyMetadataSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Compiled workflow task ${taskId} metadata ${metadataKeys.validationStrategies} does not parse as validation strategies: ${parsed.error.message}`,
    );
  }
  return Object.fromEntries(
    Object.entries(parsed.data).map(([criterionId, strategy]) => [
      criterionId,
      normalizeCompiledStrategy(strategy),
    ]),
  );
}

export function readCompiledOriginMap(
  definition: WorkflowSemanticDefinition,
): CompiledOriginMapEntry[] {
  return definition.tasks.map((task) => {
    const metadata = task.metadata;
    if (metadata === undefined) {
      throw new Error(
        `Workflow task ${task.id} has no compiled spec metadata.`,
      );
    }
    return {
      contextId: task.contextId,
      taskElementId: requiredMetadata(metadata, metadataKeys.taskElementId),
      taskHandle: requiredMetadata(metadata, metadataKeys.taskHandle),
      touchedPaths:
        metadata[metadataKeys.touchedPaths] === undefined
          ? []
          : parseMetadataJson<string[]>(metadata, metadataKeys.touchedPaths),
      criterionElementIds: parseMetadataJson<string[]>(
        metadata,
        metadataKeys.criterionElementIds,
      ),
      criterionHandles: parseMetadataJson<string[]>(
        metadata,
        metadataKeys.criterionHandles,
      ),
      validationStrategies: readCompiledStrategyMetadata(metadata, task.id),
      criterionBriefs: parseMetadataJson<Record<string, string>>(
        metadata,
        metadataKeys.criterionBriefs,
      ),
    };
  });
}

export function readCompiledContextContract(
  definition: WorkflowSemanticDefinition,
  contextId: string,
): CompiledContextContract {
  const origins = readCompiledOriginMap(definition).filter(
    (origin) => origin.contextId === contextId,
  );
  const criterionElementIds: string[] = [];
  const criterionHandles: string[] = [];
  const validationStrategies: Record<string, ValidationStrategy> = {};
  const briefs: string[] = [];
  const seenCriteria = new Set<string>();

  for (const origin of origins) {
    for (let index = 0; index < origin.criterionElementIds.length; index += 1) {
      const criterionId = origin.criterionElementIds[index]!;
      if (seenCriteria.has(criterionId)) continue;
      seenCriteria.add(criterionId);
      criterionElementIds.push(criterionId);
      criterionHandles.push(origin.criterionHandles[index] ?? criterionId);
      const strategy = origin.validationStrategies[criterionId];
      if (strategy !== undefined) validationStrategies[criterionId] = strategy;
      const brief = origin.criterionBriefs[criterionId];
      if (brief !== undefined) briefs.push(brief);
    }
  }

  return {
    contextId,
    taskElementIds: origins.map((origin) => origin.taskElementId),
    criterionElementIds,
    criterionHandles,
    validationStrategies,
    acceptanceCriteria:
      briefs.length === 0
        ? GROUP_ACCEPTANCE_CRITERIA
        : [GROUP_ACCEPTANCE_CRITERIA, "", ...briefs].join("\n"),
  };
}

/**
 * The approved revision read in the legacy plan vocabulary: qualified handles
 * and by-id lookups for every element a compiled task cites. Exported because
 * the legacy plan importer must resolve exactly the same handles the compiler
 * did — a second indexing rule would rewrite every handle in every imported
 * instruction.
 */
export function indexLegacyRevision(
  slug: string,
  snapshot: SpecRevisionSnapshot,
): RevisionIndex {
  return indexRevision(slug, snapshot);
}

function indexRevision(
  slug: string,
  snapshot: SpecRevisionSnapshot,
): RevisionIndex {
  const requirements = new Map<string, IndexedRequirement>();
  const criteria = new Map<string, IndexedCriterion>();
  const decisions = new Map<string, IndexedDecision>();
  const sections: IndexedSection[] = [];
  const tasks = new Map<string, IndexedTask>();

  for (const element of snapshot.elements) {
    const { payload } = element.version;
    if (payload.kind === "requirement") {
      requirements.set(element.element.id, {
        element,
        payload,
        handle: qualifiedHandle(slug, "R", element.element.number),
      });
      continue;
    }
    if (payload.kind === "decision") {
      decisions.set(element.element.id, {
        element,
        payload,
        handle: qualifiedHandle(slug, "D", element.element.number),
      });
      continue;
    }
    if (payload.kind === "section") {
      sections.push({ element, payload });
      continue;
    }
    if (payload.kind === "task") {
      tasks.set(element.element.id, {
        element,
        payload,
        handle: qualifiedHandle(slug, "T", element.element.number),
      });
    }
  }

  for (const element of snapshot.elements) {
    const { payload } = element.version;
    if (payload.kind !== "criterion") continue;
    const parentId = element.element.parentElementId;
    const requirement =
      parentId === null ? undefined : requirements.get(parentId);
    if (requirement === undefined) {
      throw new Error(
        `Criterion ${element.element.id} has no requirement in approved revision ${snapshot.revision.id}.`,
      );
    }
    const criterionNumber = requireElementNumber(element, "criterion");
    criteria.set(element.element.id, {
      element,
      payload,
      handle: `${requirement.handle}.${criterionNumber}`,
    });
  }

  sections.sort(
    (left, right) =>
      left.element.version.position - right.element.version.position ||
      compareText(left.element.element.id, right.element.element.id),
  );

  return { requirements, criteria, decisions, sections, tasks };
}

function assertSelectedElementsExist(
  scope: ExecutionScope,
  index: RevisionIndex,
): void {
  for (const taskId of scope.selectedTaskIds) {
    requireTask(index, taskId);
  }
  for (const criterionId of scope.selectedCriterionIds) {
    if (!index.criteria.has(criterionId)) {
      throw new Error(
        `Cannot compile unknown selected criterion ${criterionId}.`,
      );
    }
  }
}

function requireTask(index: RevisionIndex, taskId: string): IndexedTask {
  const task = index.tasks.get(taskId);
  if (task === undefined) {
    throw new Error(`Cannot compile unknown selected task ${taskId}.`);
  }
  return task;
}

function requireRequirement(
  index: RevisionIndex,
  requirementId: string,
  taskHandle: string,
): IndexedRequirement {
  const requirement = index.requirements.get(requirementId);
  if (requirement === undefined) {
    throw new Error(
      `Cannot compile ${taskHandle}: traced requirement ${requirementId} is absent from the approved revision.`,
    );
  }
  return requirement;
}

function requireDecision(
  index: RevisionIndex,
  decisionId: string,
  taskHandle: string,
): IndexedDecision {
  const decision = index.decisions.get(decisionId);
  if (decision === undefined) {
    throw new Error(
      `Cannot compile ${taskHandle}: traced decision ${decisionId} is absent from the approved revision.`,
    );
  }
  return decision;
}

function coveredSelectedCriteria(
  task: IndexedTask,
  selectedCriterionIds: ReadonlySet<string>,
  index: RevisionIndex,
): IndexedCriterion[] {
  return task.payload.coveredCriterionElementIds
    .filter((criterionId) => selectedCriterionIds.has(criterionId))
    .map((criterionId) => {
      const criterion = index.criteria.get(criterionId);
      if (criterion === undefined) {
        throw new Error(
          `Cannot compile ${task.handle}: covered criterion ${criterionId} is absent from the approved revision.`,
        );
      }
      return criterion;
    });
}

function validatorBrief(criteria: readonly IndexedCriterion[]): string {
  return legacyCriterionBrief(criteria.map(renderCriterion));
}

/** One indexed element as the shared renderer's plain input. */
export function renderCriterion(criterion: IndexedCriterion) {
  return {
    handle: criterion.handle,
    text: criterion.payload.text,
    validationStrategy: criterion.payload.validationStrategy,
  };
}

function contextTitle(
  group: ContractedTaskGroup,
  inputMembers: readonly IndexedTask[],
): string {
  const members = [...inputMembers].sort(compareIndexedTasks);
  return legacyContextTitle({
    laneGroup: group.laneGroup,
    members: members.map((member) => ({
      handle: member.handle,
      title: member.payload.title,
    })),
    fallbackId: group.id,
  });
}

function contextDescription(
  group: ContractedTaskGroup,
  inputMembers: readonly IndexedTask[],
): string {
  const members = [...inputMembers].sort(compareIndexedTasks);
  if (group.laneGroup === undefined) {
    const member = members[0];
    if (member === undefined) return `Execute ${group.id}.`;
    return `Task ${bareHandle(member.handle)}: ${member.payload.title}.`;
  }
  return `Lane group ${group.laneGroup}: ${members
    .map((member) => `${bareHandle(member.handle)} — ${member.payload.title}`)
    .join("; ")}.`;
}

function contextAcceptanceCriteria(
  criterionBriefRecords: readonly Readonly<Record<string, string>>[],
): string {
  const briefs: string[] = [];
  const seenCriterionIds = new Set<string>();
  for (const record of criterionBriefRecords) {
    for (const [criterionId, brief] of Object.entries(record)) {
      if (seenCriterionIds.has(criterionId)) continue;
      seenCriterionIds.add(criterionId);
      briefs.push(brief);
    }
  }
  return briefs.length === 0
    ? GROUP_ACCEPTANCE_CRITERIA
    : [GROUP_ACCEPTANCE_CRITERIA, "", ...briefs].join("\n");
}

function taskInstructions(
  task: IndexedTask,
  requirements: readonly IndexedRequirement[],
  criteria: readonly IndexedCriterion[],
  decisions: readonly IndexedDecision[],
): string {
  return legacyTaskInstructions({
    task: {
      handle: task.handle,
      title: task.payload.title,
      instructions: task.payload.instructions,
    },
    requirements: requirements.map((requirement) => ({
      handle: requirement.handle,
      statement: requirement.payload.statement,
    })),
    criteria: criteria.map(renderCriterion),
    decisions: decisions.map((decision) => ({
      handle: decision.handle,
      title: decision.payload.title,
      chosenApproach: decision.payload.chosenApproach,
      reason: decision.payload.reason,
    })),
    unmappedCriterionNotice: "keep",
  });
}

function qualifiedHandle(
  slug: string,
  prefix: "R" | "D" | "T",
  number: number | null,
): string {
  if (number === null) {
    throw new Error(`Cannot compile unnumbered ${prefix} element.`);
  }
  return `${slug}/${prefix}${number}`;
}

function requireElementNumber(
  element: SpecRevisionElement,
  kind: string,
): number {
  if (element.element.number === null) {
    throw new Error(`Cannot compile unnumbered ${kind} ${element.element.id}.`);
  }
  return element.element.number;
}

function contextIdForTask(taskElementId: string): string {
  return `context-${taskElementId}`;
}

function contextIdsForGroups(
  groups: readonly ContractedTaskGroup[],
): ReadonlyMap<string, string> {
  const contextIds = new Map<string, string>();
  const usedIds = new Set<string>();
  for (const group of groups) {
    if (group.laneGroup !== undefined) continue;
    const contextId = singletonContextId(group);
    contextIds.set(group.id, contextId);
    usedIds.add(contextId);
  }
  for (const group of groups) {
    if (group.laneGroup === undefined) continue;
    const baseId = `context-lane-${opaqueIdComponent(group.laneGroup)}`;
    let contextId = baseId;
    let suffix = 2;
    while (usedIds.has(contextId)) {
      contextId = `${baseId}-${suffix}`;
      suffix += 1;
    }
    contextIds.set(group.id, contextId);
    usedIds.add(contextId);
  }
  return contextIds;
}

function singletonContextId(group: ContractedTaskGroup): string {
  const taskId = group.memberTaskIds[0];
  if (taskId === undefined) {
    throw new Error(`Cannot compile empty task group ${group.id}.`);
  }
  return contextIdForTask(taskId);
}

export function compiledWorkflowTaskId(taskElementId: string): string {
  return `spec-task-${taskElementId}`;
}

function edgeId(
  sourceTaskElementId: string,
  targetTaskElementId: string,
): string {
  return `edge-${sourceTaskElementId}-${targetTaskElementId}`;
}

function edgeIdForGroups(
  sourceGroup: ContractedTaskGroup,
  targetGroup: ContractedTaskGroup,
): string {
  const sourceTaskId = sourceGroup.memberTaskIds[0];
  const targetTaskId = targetGroup.memberTaskIds[0];
  if (
    sourceGroup.laneGroup === undefined &&
    targetGroup.laneGroup === undefined &&
    sourceTaskId !== undefined &&
    targetTaskId !== undefined
  ) {
    return edgeId(sourceTaskId, targetTaskId);
  }
  return `edge-groups-${opaqueIdComponent(
    JSON.stringify([sourceGroup.id, targetGroup.id]),
  )}`;
}

function opaqueIdComponent(value: string): string {
  try {
    return encodeURIComponent(value);
  } catch {
    const codeUnits: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      codeUnits.push(value.charCodeAt(index).toString(16).padStart(4, "0"));
    }
    return `utf16/${codeUnits.join("")}`;
  }
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareIndexedTasks(left: IndexedTask, right: IndexedTask): number {
  return (
    compareText(left.handle, right.handle) ||
    compareText(left.element.element.id, right.element.element.id)
  );
}

function requiredMapValue(
  values: ReadonlyMap<string, string>,
  key: string,
  label: string,
): string {
  const value = values.get(key);
  if (value === undefined) {
    throw new Error(`Cannot compile missing ${label} ${key}.`);
  }
  return value;
}

function taskSourceUri(
  slug: string,
  qualifiedHandle: string,
  revisionId: string,
): string {
  const bareHandle = qualifiedHandle.slice(slug.length + 1);
  return `spec://${slug}/${bareHandle}?revision=${revisionId}`;
}

function requiredMetadata(
  metadata: Record<string, string>,
  key: string,
): string {
  const value = metadata[key];
  if (value === undefined) {
    throw new Error(`Compiled workflow task metadata is missing ${key}.`);
  }
  return value;
}

function parseMetadataJson<T>(
  metadata: Record<string, string>,
  key: string,
): T {
  const value = requiredMetadata(metadata, key);
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(
      `Compiled workflow task metadata ${key} is not valid JSON.`,
    );
  }
}
