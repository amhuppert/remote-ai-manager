import type { WorkflowSemanticDefinition } from "@/lib/workflow-graph/definition-schemas";
import type {
  CriterionElementPayload,
  DecisionElementPayload,
  RequirementElementPayload,
  SectionElementPayload,
  SpecRevisionElement,
  SpecRevisionSnapshot,
  TaskElementPayload,
  ValidationStrategy,
} from "./schemas";
import {
  contractTaskGroups,
  type ContractedTaskGroup,
} from "./group-contraction";
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

interface IndexedRequirement {
  element: SpecRevisionElement;
  payload: RequirementElementPayload;
  handle: string;
}

interface IndexedCriterion {
  element: SpecRevisionElement;
  payload: CriterionElementPayload;
  handle: string;
}

interface IndexedDecision {
  element: SpecRevisionElement;
  payload: DecisionElementPayload;
  handle: string;
}

interface IndexedSection {
  element: SpecRevisionElement;
  payload: SectionElementPayload;
}

interface IndexedTask {
  element: SpecRevisionElement;
  payload: TaskElementPayload;
  handle: string;
}

interface RevisionIndex {
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

const GROUP_ACCEPTANCE_CRITERIA =
  "Validate the locked criterion briefs of every task currently assigned to this context. The effective contract is the union of those task briefs; regrouping must never drop or weaken one.";

export function compileSpecExecutionPlan(
  input: CompileSpecExecutionPlanInput,
): WorkflowSemanticDefinition {
  if (input.revisionSnapshot.revision.state !== "approved") {
    throw new Error(
      `Cannot compile revision ${input.revisionSnapshot.revision.id}: revision is not approved.`,
    );
  }
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
      criterionElementIds: parseMetadataJson<string[]>(
        metadata,
        metadataKeys.criterionElementIds,
      ),
      criterionHandles: parseMetadataJson<string[]>(
        metadata,
        metadataKeys.criterionHandles,
      ),
      validationStrategies: parseMetadataJson<
        Record<string, ValidationStrategy>
      >(metadata, metadataKeys.validationStrategies),
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
  if (criteria.length === 0) {
    return "Verify the approved task instructions are complete without expanding the pinned execution scope.";
  }
  return [
    "Validate only these approved acceptance criteria:",
    ...criteria.flatMap((criterion) => [
      `- ${criterion.handle}: ${criterion.payload.text}`,
      `  Required evidence: ${requiredKinds(criterion.payload.validationStrategy)}`,
      `  Approved strategy note: ${strategyNote(criterion.payload.validationStrategy)}`,
    ]),
  ].join("\n");
}

function contextTitle(
  group: ContractedTaskGroup,
  inputMembers: readonly IndexedTask[],
): string {
  const members = [...inputMembers].sort(compareIndexedTasks);
  const memberHandles = members.map((member) => bareHandle(member.handle));
  if (group.laneGroup !== undefined) {
    return `${group.laneGroup} — ${memberHandles.join(", ")}`;
  }
  const member = members[0];
  if (member === undefined) return group.id;
  return `${bareHandle(member.handle)} — ${member.payload.title}`;
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
  return [
    `Approved task ${task.handle}`,
    "",
    task.payload.instructions,
    "",
    "Narrow context pack",
    "Requirements:",
    ...requirements.map(
      (requirement) =>
        `- ${requirement.handle}: ${requirement.payload.statement}`,
    ),
    ...(decisions.length === 0
      ? []
      : [
          "Approved decisions:",
          ...decisions.flatMap((decision) => [
            `- ${decision.handle}: ${decision.payload.title}`,
            `  Chosen approach: ${decision.payload.chosenApproach}`,
            `  Reason: ${decision.payload.reason}`,
          ]),
        ]),
    "Acceptance criteria and required validation:",
    ...(criteria.length === 0
      ? [
          "- No selected criterion is directly mapped to this prerequisite task.",
        ]
      : criteria.flatMap((criterion) => [
          `- ${criterion.handle}: ${criterion.payload.text}`,
          `  Required evidence: ${requiredKinds(criterion.payload.validationStrategy)}`,
          `  Approved strategy note: ${strategyNote(criterion.payload.validationStrategy)}`,
        ])),
  ].join("\n");
}

function strategyNote(strategy: ValidationStrategy): string {
  return strategy.note ?? "No additional strategy note was approved.";
}

function requiredKinds(strategy: ValidationStrategy): string {
  return strategy.kinds.length === 0
    ? "none declared"
    : strategy.kinds.join(", ");
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

function bareHandle(handle: string): string {
  return handle.slice(handle.lastIndexOf("/") + 1);
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
