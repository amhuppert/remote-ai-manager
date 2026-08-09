import type {
  SpecAssumptionDisposition,
  SpecAuthoringStage,
  SpecElementKind,
  SpecQuestionStatus,
} from "./schemas";
import {
  contractTaskGroups,
  contractedGroupsHavePath,
  type ContractedTaskGroup,
  type GroupContraction,
} from "./group-contraction";
import {
  elementReferences,
  type ReferenceSourceElement,
  type SpecReferenceRelation,
} from "./element-references";

export type LintSeverity =
  | "blocks_propose"
  | "blocks_claim"
  | "blocks_signoff"
  | "advisory";

export interface LintFinding {
  ruleId: string;
  severity: LintSeverity;
  elementHandle: string;
  message: string;
}

export interface RevisionElement extends ReferenceSourceElement {
  handle: string;
  parentElementId?: string;
  payloadHash: string;
}

export interface RevisionSnapshot {
  specHandle: string;
  authoringStage: SpecAuthoringStage;
  elements: RevisionElement[];
}

export interface KnownElementRecord {
  elementId: string;
  handle: string;
  kind: SpecElementKind;
}

export interface ApprovedElementRecord {
  elementId: string;
  approvedPayloadHash: string;
}

export interface QuestionRecord {
  questionId: string;
  handle: string;
  status: SpecQuestionStatus;
}

export interface AssumptionRecord {
  assumptionId: string;
  handle: string;
  disposition: SpecAssumptionDisposition;
}

export interface EvidenceRecord {
  evidenceId: string;
  criterionElementId: string;
}

export interface PendingTaskClaim {
  taskElementId: string;
}

export interface TaskScope {
  tracedRequirementElementIds: string[];
  tracedDecisionElementIds: string[];
  coveredCriterionElementIds: string[];
  dependsOnTaskElementIds: string[];
}

export interface MaterializedTaskRecord {
  taskElementId: string;
  handle: string;
  scope: TaskScope;
}

export interface SpecRecords {
  baseRevision?: RevisionSnapshot;
  knownElements?: KnownElementRecord[];
  approvedElements?: ApprovedElementRecord[];
  questions?: QuestionRecord[];
  assumptions?: AssumptionRecord[];
  evidence?: EvidenceRecord[];
  pendingTaskClaims?: PendingTaskClaim[];
  materializedTasks?: MaterializedTaskRecord[];
}

const RULE_ORDER = [
  "9.2.empty-spec",
  "9.3.uncovered-criterion",
  "9.3.task-without-criterion",
  "9.4.untraced-task",
  "9.5.dependency-cycle",
  "9.5.removed-task-dependency",
  "9.6.dangling-handle",
  "9.7.claim-without-evidence",
  "9.8.rejected-cited-assumption",
  "9.9.approval-freshness",
  "9.9.cited-element-change",
  "9.9.open-question",
  "9.9.materialized-task-change",
  "9.11.lane-group-cycle",
  "9.11.lane-group-execution-lane-mismatch",
  "9.12.serialized-plan",
  "9.12.overloaded-task",
  "9.12.conflicting-parallel-surfaces",
] as const;

export const GRAPH_SHAPE_MINIMUM_TASKS = 3;
export const OVERLOADED_TASK_CRITERION_SHARE = 0.5;

const ruleOrder = new Map<string, number>(
  RULE_ORDER.map((ruleId, index) => [ruleId, index]),
);

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function compareElements(
  left: RevisionElement,
  right: RevisionElement,
): number {
  return (
    compareText(left.handle, right.handle) || compareText(left.id, right.id)
  );
}

function sortFindings(findings: LintFinding[]): LintFinding[] {
  return findings.sort((left, right) => {
    const leftOrder = ruleOrder.get(left.ruleId) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = ruleOrder.get(right.ruleId) ?? Number.MAX_SAFE_INTEGER;
    return (
      leftOrder - rightOrder ||
      compareText(left.elementHandle, right.elementHandle) ||
      compareText(left.message, right.message)
    );
  });
}

function taskScope(element: RevisionElement): TaskScope | undefined {
  if (element.payload.kind !== "task") {
    return undefined;
  }

  return {
    tracedRequirementElementIds: element.payload.tracedRequirementElementIds,
    tracedDecisionElementIds: element.payload.tracedDecisionElementIds,
    coveredCriterionElementIds: element.payload.coveredCriterionElementIds,
    dependsOnTaskElementIds: element.payload.dependsOnTaskElementIds,
  };
}

function normalizedIds(ids: string[]): string[] {
  return [...new Set(ids)].sort(compareText);
}

function hasSameScope(left: TaskScope, right: TaskScope): boolean {
  return (
    JSON.stringify(normalizedIds(left.tracedRequirementElementIds)) ===
      JSON.stringify(normalizedIds(right.tracedRequirementElementIds)) &&
    JSON.stringify(normalizedIds(left.tracedDecisionElementIds)) ===
      JSON.stringify(normalizedIds(right.tracedDecisionElementIds)) &&
    JSON.stringify(normalizedIds(left.coveredCriterionElementIds)) ===
      JSON.stringify(normalizedIds(right.coveredCriterionElementIds)) &&
    JSON.stringify(normalizedIds(left.dependsOnTaskElementIds)) ===
      JSON.stringify(normalizedIds(right.dependsOnTaskElementIds))
  );
}

function canonicalCycle(cycle: RevisionElement[]): {
  signature: string;
  handles: string[];
  anchor: string;
} {
  const handles = cycle.map((element) => element.handle);
  let firstIndex = 0;

  for (let index = 1; index < handles.length; index += 1) {
    if (compareText(handles[index]!, handles[firstIndex]!) < 0) {
      firstIndex = index;
    }
  }

  const rotated = [
    ...handles.slice(firstIndex),
    ...handles.slice(0, firstIndex),
  ];

  return {
    signature: rotated.join("\u0000"),
    handles: [...rotated, rotated[0]!],
    anchor: rotated[0]!,
  };
}

function dependencyCycleFindings(tasks: RevisionElement[]): LintFinding[] {
  const tasksById = new Map(
    tasks.map((taskElement) => [taskElement.id, taskElement]),
  );
  const state = new Map<string, "visiting" | "visited">();
  const stack: RevisionElement[] = [];
  const emittedCycles = new Set<string>();
  const findings: LintFinding[] = [];

  const visit = (current: RevisionElement): void => {
    state.set(current.id, "visiting");
    stack.push(current);

    const dependencies = taskScope(current)?.dependsOnTaskElementIds ?? [];
    const sortedDependencies = dependencies
      .map((dependencyId) => tasksById.get(dependencyId))
      .filter(
        (dependency): dependency is RevisionElement => dependency !== undefined,
      )
      .sort(compareElements);

    for (const dependency of sortedDependencies) {
      const dependencyState = state.get(dependency.id);
      if (dependencyState === "visited") {
        continue;
      }
      if (dependencyState === "visiting") {
        const cycleStart = stack.findIndex(
          (element) => element.id === dependency.id,
        );
        const cycle = canonicalCycle(stack.slice(cycleStart));
        if (!emittedCycles.has(cycle.signature)) {
          emittedCycles.add(cycle.signature);
          findings.push({
            ruleId: "9.5.dependency-cycle",
            severity: "blocks_propose",
            elementHandle: cycle.anchor,
            message: `Task dependency cycle: ${cycle.handles.join(" → ")}.`,
          });
        }
        continue;
      }

      visit(dependency);
    }

    stack.pop();
    state.set(current.id, "visited");
  };

  for (const taskElement of tasks) {
    if (!state.has(taskElement.id)) {
      visit(taskElement);
    }
  }

  return findings;
}

function graphShapeFindings(
  tasks: RevisionElement[],
  criteria: RevisionElement[],
): LintFinding[] {
  const findings: LintFinding[] = [];
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const contraction = contractTaskGroups(
    tasks.map((task) => {
      if (task.payload.kind !== "task") {
        throw new Error(`Cannot contract non-task element ${task.id}.`);
      }
      return {
        id: task.id,
        handle: task.handle,
        laneGroup: task.payload.laneGroup,
        dependsOnTaskIds: task.payload.dependsOnTaskElementIds,
      };
    }),
  );
  const groupsById = new Map(
    contraction.groups.map((group) => [group.id, group]),
  );

  findings.push(...laneGroupExecutionLaneFindings(contraction, tasksById));

  if (contraction.groupCycle !== undefined) {
    const cyclicGroups = contraction.groupCycle
      .map((groupId) => groupsById.get(groupId))
      .filter((group): group is ContractedTaskGroup => group !== undefined);
    const cycleUsesLaneGrouping = cyclicGroups.some(
      (group) => group.laneGroup !== undefined,
    );
    if (!cycleUsesLaneGrouping) {
      return graphShapeAdvisoryFindings(findings, tasks, criteria, contraction);
    }
    const anchor = cyclicGroups[0];
    const anchorTask =
      anchor === undefined
        ? undefined
        : tasksById.get(anchor.memberTaskIds[0] ?? "");
    findings.push({
      ruleId: "9.11.lane-group-cycle",
      severity: "blocks_propose",
      elementHandle: anchorTask?.handle ?? tasks[0]?.handle ?? "unknown",
      message: `Lane-group cycle: ${cyclicGroups
        .map((group) => groupDisplayName(group, tasksById))
        .join(" → ")}.`,
    });
  }

  return graphShapeAdvisoryFindings(findings, tasks, criteria, contraction);
}

/**
 * Contraction and lane sharing compose only as a validation rule (R12).
 *
 * A `laneGroup`'s members become ONE execution context, and a context sits on
 * exactly one lane, so members declaring different `executionLane` values — or
 * only some of them declaring one — describe a placement no compilation can
 * honour. Refusing it here, before propose, is what keeps the compiler from
 * having to guess which member's intent wins.
 *
 * Ungrouped tasks are untouched: distinct contexts sharing a lane is the whole
 * point of the field, not a conflict.
 */
function laneGroupExecutionLaneFindings(
  contraction: GroupContraction,
  tasksById: ReadonlyMap<string, RevisionElement>,
): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const group of contraction.groups) {
    if (group.laneGroup === undefined) continue;
    const members = group.memberTaskIds.flatMap((taskId) => {
      const task = tasksById.get(taskId);
      if (task === undefined || task.payload.kind !== "task") return [];
      return [{ handle: task.handle, lane: task.payload.executionLane }];
    });
    if (new Set(members.map(({ lane }) => lane)).size <= 1) continue;
    findings.push({
      ruleId: "9.11.lane-group-execution-lane-mismatch",
      severity: "blocks_propose",
      elementHandle: members[0]?.handle ?? group.id,
      message: `Lane group ${group.laneGroup} mixes execution lanes: ${members
        .map(({ handle, lane }) => `${handle} → ${lane ?? "none"}`)
        .join(
          ", ",
        )}. Members contracted into one context must all declare the same executionLane or all omit it.`,
    });
  }
  return findings;
}

function graphShapeAdvisoryFindings(
  findings: LintFinding[],
  tasks: RevisionElement[],
  criteria: RevisionElement[],
  contraction: GroupContraction,
): LintFinding[] {
  if (tasks.length < GRAPH_SHAPE_MINIMUM_TASKS) return findings;

  if (
    contraction.groupCycle === undefined &&
    contraction.intraGroupCycleTaskIds === undefined &&
    contractedGraphIsSerialized(contraction)
  ) {
    findings.push({
      ruleId: "9.12.serialized-plan",
      severity: "advisory",
      elementHandle: tasks[0]?.handle ?? "unknown",
      message: `The ${tasks.length}-task plan contracts to ${contraction.groups.length} ${contraction.groups.length === 1 ? "context" : "contexts"} with no parallel execution path.`,
    });
  }

  const criterionIds = new Set(criteria.map((criterion) => criterion.id));
  for (const task of tasks) {
    if (task.payload.kind !== "task" || criteria.length === 0) continue;
    const coveredCount = new Set(
      task.payload.coveredCriterionElementIds.filter((criterionId) =>
        criterionIds.has(criterionId),
      ),
    ).size;
    if (coveredCount / criteria.length <= OVERLOADED_TASK_CRITERION_SHARE) {
      continue;
    }
    findings.push({
      ruleId: "9.12.overloaded-task",
      severity: "advisory",
      elementHandle: task.handle,
      message: `${task.handle} covers ${coveredCount} of ${criteria.length} criteria, more than half of the draft.`,
    });
  }

  if (contraction.groupCycle !== undefined) return findings;
  for (let leftIndex = 0; leftIndex < tasks.length; leftIndex += 1) {
    const left = tasks[leftIndex];
    if (left?.payload.kind !== "task") continue;
    const leftGroupId = contraction.taskGroupIds.get(left.id);
    if (leftGroupId === undefined) continue;
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < tasks.length;
      rightIndex += 1
    ) {
      const right = tasks[rightIndex];
      if (right?.payload.kind !== "task") continue;
      const rightGroupId = contraction.taskGroupIds.get(right.id);
      if (
        rightGroupId === undefined ||
        leftGroupId === rightGroupId ||
        contractedGroupsHavePath(contraction, leftGroupId, rightGroupId) ||
        contractedGroupsHavePath(contraction, rightGroupId, leftGroupId)
      ) {
        continue;
      }
      const overlap = firstTouchedPathOverlap(
        left.payload.touchedPaths ?? [],
        right.payload.touchedPaths ?? [],
      );
      if (overlap === undefined) continue;
      findings.push({
        ruleId: "9.12.conflicting-parallel-surfaces",
        severity: "advisory",
        elementHandle: left.handle,
        message: `Independent tasks ${left.handle} and ${right.handle} declare overlapping touched paths ${overlap[0]} and ${overlap[1]}.`,
      });
    }
  }

  return findings;
}

function groupDisplayName(
  group: ContractedTaskGroup,
  tasksById: ReadonlyMap<string, RevisionElement>,
): string {
  if (group.laneGroup !== undefined) return group.laneGroup;
  const task = tasksById.get(group.memberTaskIds[0] ?? "");
  return task?.handle ?? group.id;
}

function contractedGraphIsSerialized(contraction: GroupContraction): boolean {
  for (
    let leftIndex = 0;
    leftIndex < contraction.groups.length;
    leftIndex += 1
  ) {
    const left = contraction.groups[leftIndex];
    if (left === undefined) continue;
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < contraction.groups.length;
      rightIndex += 1
    ) {
      const right = contraction.groups[rightIndex];
      if (right === undefined) continue;
      if (
        !contractedGroupsHavePath(contraction, left.id, right.id) &&
        !contractedGroupsHavePath(contraction, right.id, left.id)
      ) {
        return false;
      }
    }
  }
  return true;
}

function firstTouchedPathOverlap(
  leftPaths: readonly string[],
  rightPaths: readonly string[],
): [string, string] | undefined {
  const leftSorted = [...new Set(leftPaths)].sort(compareText);
  const rightSorted = [...new Set(rightPaths)].sort(compareText);
  for (const left of leftSorted) {
    for (const right of rightSorted) {
      if (
        left === right ||
        left.startsWith(`${right}/`) ||
        right.startsWith(`${left}/`)
      ) {
        return [left, right];
      }
    }
  }
  return undefined;
}

function danglingTypedReferenceFinding(
  sourceElement: RevisionElement,
  targetId: string,
  expectedKind: SpecElementKind,
  relation: SpecReferenceRelation,
  elementsById: ReadonlyMap<string, RevisionElement>,
  knownElementsById: ReadonlyMap<string, KnownElementRecord>,
  removedTaskDependencyHasSpecificFinding = false,
): LintFinding | undefined {
  const currentTarget = elementsById.get(targetId);
  if (currentTarget?.payload.kind === expectedKind) {
    return undefined;
  }
  if (currentTarget) {
    return {
      ruleId: "9.6.dangling-handle",
      severity: "blocks_propose",
      elementHandle: sourceElement.handle,
      message: `${sourceElement.handle} ${relation} ${currentTarget.handle}, which is not a ${expectedKind}.`,
    };
  }

  const knownTarget = knownElementsById.get(targetId);
  if (removedTaskDependencyHasSpecificFinding && knownTarget?.kind === "task") {
    return undefined;
  }
  if (knownTarget?.kind === expectedKind) {
    return {
      ruleId: "9.6.dangling-handle",
      severity: "blocks_propose",
      elementHandle: sourceElement.handle,
      message: `${sourceElement.handle} ${relation} removed ${expectedKind} ${knownTarget.handle}.`,
    };
  }
  if (knownTarget) {
    return {
      ruleId: "9.6.dangling-handle",
      severity: "blocks_propose",
      elementHandle: sourceElement.handle,
      message: `${sourceElement.handle} ${relation} ${knownTarget.handle}, which is not a ${expectedKind}.`,
    };
  }

  return {
    ruleId: "9.6.dangling-handle",
    severity: "blocks_propose",
    elementHandle: sourceElement.handle,
    message: `${sourceElement.handle} ${relation} unknown ${expectedKind} element ${targetId}.`,
  };
}

export function lint(
  draft: RevisionSnapshot,
  records: SpecRecords,
): LintFinding[] {
  const findings: LintFinding[] = [];
  const elements = [...draft.elements].sort(compareElements);
  const elementsById = new Map(
    elements.map((element) => [element.id, element]),
  );
  const requirements = elements.filter(
    (element) => element.payload.kind === "requirement",
  );
  const requirementIds = new Set(requirements.map((element) => element.id));
  const criteria = elements.filter(
    (element) => element.payload.kind === "criterion",
  );
  const tasks = elements.filter((element) => element.payload.kind === "task");
  const tasksById = new Map(tasks.map((element) => [element.id, element]));

  const hasReviewableRequirement = requirements.some((requirementElement) =>
    criteria.some(
      (criterionElement) =>
        criterionElement.parentElementId === requirementElement.id,
    ),
  );
  if (!hasReviewableRequirement) {
    findings.push({
      ruleId: "9.2.empty-spec",
      severity: "blocks_propose",
      elementHandle: draft.specHandle,
      message: "Empty spec — nothing to review.",
    });
  }

  if (draft.authoringStage === "plan") {
    for (const criterionElement of criteria) {
      const isCovered = tasks.some((taskElement) =>
        taskScope(taskElement)?.coveredCriterionElementIds.includes(
          criterionElement.id,
        ),
      );
      if (!isCovered) {
        findings.push({
          ruleId: "9.3.uncovered-criterion",
          severity: "blocks_propose",
          elementHandle: criterionElement.handle,
          message: `${criterionElement.handle} has no covering task.`,
        });
      }
    }

    for (const taskElement of tasks) {
      const coveredCriterionElementIds =
        taskScope(taskElement)?.coveredCriterionElementIds ?? [];
      if (coveredCriterionElementIds.length > 0) {
        continue;
      }
      findings.push({
        ruleId: "9.3.task-without-criterion",
        severity: "blocks_propose",
        elementHandle: taskElement.handle,
        message: `${taskElement.handle} covers no acceptance criterion.`,
      });
    }
  }

  for (const taskElement of tasks) {
    const tracesCurrentRequirement = taskScope(
      taskElement,
    )?.tracedRequirementElementIds.some((elementId) =>
      requirementIds.has(elementId),
    );
    if (!tracesCurrentRequirement) {
      findings.push({
        ruleId: "9.4.untraced-task",
        severity: "blocks_propose",
        elementHandle: taskElement.handle,
        message: `${taskElement.handle} traces to no requirement — possible scope creep.`,
      });
    }
  }

  findings.push(...dependencyCycleFindings(tasks));
  findings.push(...graphShapeFindings(tasks, criteria));

  const knownElementsById = new Map(
    (records.knownElements ?? []).map((element) => [
      element.elementId,
      element,
    ]),
  );
  for (const taskElement of tasks) {
    for (const dependencyId of taskScope(taskElement)
      ?.dependsOnTaskElementIds ?? []) {
      if (tasksById.has(dependencyId)) {
        continue;
      }
      const knownDependency = knownElementsById.get(dependencyId);
      if (knownDependency?.kind !== "task") {
        continue;
      }
      findings.push({
        ruleId: "9.5.removed-task-dependency",
        severity: "blocks_propose",
        elementHandle: taskElement.handle,
        message: `${taskElement.handle} depends on removed task ${knownDependency.handle}.`,
      });
    }
  }

  const assumptionsById = new Map(
    (records.assumptions ?? []).map((assumption) => [
      assumption.assumptionId,
      assumption,
    ]),
  );
  for (const sourceElement of elements) {
    for (const reference of elementReferences(sourceElement)) {
      if (reference.expectedKind === null) {
        const targetExists =
          reference.targetSpace === "assumption"
            ? assumptionsById.has(reference.targetId)
            : elementsById.has(reference.targetId);
        if (targetExists) {
          continue;
        }
        findings.push({
          ruleId: "9.6.dangling-handle",
          severity: "blocks_propose",
          elementHandle: sourceElement.handle,
          message: `${sourceElement.handle} cites ${
            knownElementsById.has(reference.targetId) ? "removed" : "unknown"
          } element ${reference.targetHandle ?? reference.targetId}.`,
        });
        continue;
      }

      const finding = danglingTypedReferenceFinding(
        sourceElement,
        reference.targetId,
        reference.expectedKind,
        reference.relation,
        elementsById,
        knownElementsById,
        reference.field === "dependsOnTaskElementIds",
      );
      if (finding) {
        findings.push(finding);
      }
    }
  }

  const evidenceCriterionIds = new Set(
    (records.evidence ?? []).map((evidence) => evidence.criterionElementId),
  );
  for (const claim of records.pendingTaskClaims ?? []) {
    const taskElement = tasksById.get(claim.taskElementId);
    if (!taskElement) {
      continue;
    }
    for (const criterionId of taskScope(taskElement)
      ?.coveredCriterionElementIds ?? []) {
      if (evidenceCriterionIds.has(criterionId)) {
        continue;
      }
      const criterionElement = elementsById.get(criterionId);
      const criterionHandle = criterionElement?.handle ?? criterionId;
      findings.push({
        ruleId: "9.7.claim-without-evidence",
        severity: "blocks_claim",
        elementHandle: criterionHandle,
        message: `${taskElement.handle} cannot be claimed complete because ${criterionHandle} has no evidence.`,
      });
    }
  }

  for (const sourceElement of elements) {
    for (const reference of elementReferences(sourceElement)) {
      if (reference.targetSpace !== "assumption") {
        continue;
      }
      const assumption = assumptionsById.get(reference.targetId);
      if (assumption?.disposition !== "rejected") {
        continue;
      }
      findings.push({
        ruleId: "9.8.rejected-cited-assumption",
        severity: "blocks_signoff",
        elementHandle: sourceElement.handle,
        message: `${assumption.handle} was rejected but ${sourceElement.handle} still cites it.`,
      });
    }
  }

  const approvedElementsById = new Map(
    (records.approvedElements ?? []).map((approval) => [
      approval.elementId,
      approval,
    ]),
  );
  for (const [elementId, approval] of approvedElementsById) {
    const currentElement = elementsById.get(elementId);
    if (
      currentElement &&
      currentElement.payloadHash !== approval.approvedPayloadHash
    ) {
      findings.push({
        ruleId: "9.9.approval-freshness",
        severity: "advisory",
        elementHandle: currentElement.handle,
        message: `${currentElement.handle} changed since its approval.`,
      });
    }
  }

  const baseElementsById = new Map(
    (records.baseRevision?.elements ?? []).map((element) => [
      element.id,
      element,
    ]),
  );
  for (const sourceElement of elements) {
    if (!approvedElementsById.has(sourceElement.id)) {
      continue;
    }
    for (const reference of elementReferences(sourceElement)) {
      if (
        reference.field !== "citations" ||
        reference.targetSpace !== "element"
      ) {
        continue;
      }
      const baseTarget = baseElementsById.get(reference.targetId);
      const currentTarget = elementsById.get(reference.targetId);
      if (
        !baseTarget ||
        !currentTarget ||
        baseTarget.payloadHash === currentTarget.payloadHash
      ) {
        continue;
      }
      findings.push({
        ruleId: "9.9.cited-element-change",
        severity: "advisory",
        elementHandle: sourceElement.handle,
        message: `${sourceElement.handle} cites ${currentTarget.handle}, which changed in this draft.`,
      });
    }
  }

  for (const question of records.questions ?? []) {
    if (question.status !== "open") {
      continue;
    }
    findings.push({
      ruleId: "9.9.open-question",
      severity: "advisory",
      elementHandle: question.handle,
      message: `${question.handle} remains unresolved at propose.`,
    });
  }

  for (const materializedTask of records.materializedTasks ?? []) {
    const currentTask = tasksById.get(materializedTask.taskElementId);
    if (!currentTask) {
      findings.push({
        ruleId: "9.9.materialized-task-change",
        severity: "advisory",
        elementHandle: materializedTask.handle,
        message: `Materialized task ${materializedTask.handle} was removed from this draft.`,
      });
      continue;
    }

    const currentScope = taskScope(currentTask);
    if (currentScope && !hasSameScope(currentScope, materializedTask.scope)) {
      findings.push({
        ruleId: "9.9.materialized-task-change",
        severity: "advisory",
        elementHandle: currentTask.handle,
        message: `Materialized task ${currentTask.handle} was re-scoped in this draft.`,
      });
    }
  }

  return sortFindings(findings);
}
