import type { WorkflowSemanticDefinition } from "@/lib/workflow-graph/definition-schemas";
import type {
  CriterionElementPayload,
  RequirementElementPayload,
  SpecRevisionElement,
  SpecRevisionSnapshot,
  TaskElementPayload,
  ValidationStrategy,
} from "./schemas";
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

interface IndexedTask {
  element: SpecRevisionElement;
  payload: TaskElementPayload;
  handle: string;
}

interface RevisionIndex {
  requirements: Map<string, IndexedRequirement>;
  criteria: Map<string, IndexedCriterion>;
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

  const revisionId = input.revisionSnapshot.revision.id;
  const revisionSourceUri = `spec://${input.spec.slug}/revisions/${revisionId}?scope=${input.scopeHash}`;
  const executionOriginSourceUri = specExecutionOriginSourceUri(
    input.spec.id,
    revisionId,
    input.scopeHash,
  );
  const executionContexts = selectedTasks.map((task, index) => {
    const contextId = contextIdForTask(task.element.element.id);
    return {
      id: contextId,
      title: `Execution group ${index + 1}`,
      description:
        "Execution-only grouping shell. Task instructions and locked task metadata carry the approved contract for every task assigned here.",
      acceptanceCriteria: GROUP_ACCEPTANCE_CRITERIA,
      origin: {
        sourceUri: revisionSourceUri,
        label: `${input.spec.slug} scoped execution group ${index + 1}`,
      },
    };
  });

  const tasks = selectedTasks.map((task) => {
    const criteria = coveredSelectedCriteria(task, selectedCriterionIds, index);
    const requirements = task.payload.tracedRequirementElementIds.map(
      (requirementId) => requireRequirement(index, requirementId, task.handle),
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

    return {
      id: compiledWorkflowTaskId(task.element.element.id),
      contextId: contextIdForTask(task.element.element.id),
      order: 1,
      title: `${task.handle} ${task.payload.title}`,
      instructions: taskInstructions(task, requirements, criteria),
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
        [metadataKeys.validationStrategies]:
          JSON.stringify(validationStrategies),
        [metadataKeys.criterionBriefs]: JSON.stringify(criterionBriefs),
      },
      source: "user" as const,
    };
  });

  const edges = selectedTasks.flatMap((task) =>
    task.payload.dependsOnTaskElementIds.map((dependencyTaskId) => {
      if (!selectedTaskIds.has(dependencyTaskId)) {
        throw new Error(
          `Cannot compile ${task.handle}: dependency ${dependencyTaskId} is outside the validated scope.`,
        );
      }
      requireTask(index, dependencyTaskId);
      return {
        id: edgeId(dependencyTaskId, task.element.element.id),
        sourceContextId: contextIdForTask(dependencyTaskId),
        targetContextId: contextIdForTask(task.element.element.id),
      };
    }),
  );

  const lockedRegions = [
    {
      paths: ["/approvalRequired", "/origin", "/charter"],
      sourceUri: revisionSourceUri,
      reason:
        "Pinned revision, execution scope, and approval policy come from the approved spec contract.",
    },
    ...selectedTasks.map((task) => ({
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
    ...edges.map((edge) => {
      const targetTaskId = edge.targetContextId.slice("context-".length);
      const targetTask = requireTask(index, targetTaskId);
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
    charter: {
      mission: `Deliver ${input.spec.name} revision ${input.revisionSnapshot.revision.number} for scoped criteria ${selectedTasks
        .flatMap((task) =>
          coveredSelectedCriteria(task, selectedCriterionIds, index).map(
            (criterion) => criterion.handle,
          ),
        )
        .join(", ")}.`,
      conventions: [
        "Implement only the task and criterion contract in the current lane context pack.",
        "Treat approved validation strategy notes as the boundary of validator judgment.",
      ],
      nonGoals: ["Work excluded from the pinned execution scope."],
      testStrategy:
        "Use the required validation strategy attached to each scoped criterion.",
      sourcesOfTruth: [
        {
          rank: 1,
          id: `spec-${input.spec.id}-revision-${revisionId}`,
          label: `${input.spec.name} approved revision ${input.revisionSnapshot.revision.number}`,
          type: "spec",
          locator: revisionSourceUri,
          description:
            "The immutable approved revision and validated execution scope.",
          appliesTo: "all execution contexts",
          accessPolicy: "worktree-relative",
        },
      ],
    },
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

  return { requirements, criteria, tasks };
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

function taskInstructions(
  task: IndexedTask,
  requirements: readonly IndexedRequirement[],
  criteria: readonly IndexedCriterion[],
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
  prefix: "R" | "T",
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

export function compiledWorkflowTaskId(taskElementId: string): string {
  return `spec-task-${taskElementId}`;
}

function edgeId(
  sourceTaskElementId: string,
  targetTaskElementId: string,
): string {
  return `edge-${sourceTaskElementId}-${targetTaskElementId}`;
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
