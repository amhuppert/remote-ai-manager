import type {
  SpecAssumptionDisposition,
  SpecElementKind,
  SpecElementPayload,
  SpecQuestionStatus,
} from "./schemas";

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

export interface ElementCitation {
  kind: "element";
  elementId: string;
  handle: string;
}

export interface AssumptionCitation {
  kind: "assumption";
  assumptionId: string;
  handle: string;
}

export type InternalCitation = ElementCitation | AssumptionCitation;

export interface RevisionElement {
  id: string;
  handle: string;
  parentElementId?: string;
  payloadHash: string;
  payload: SpecElementPayload;
  citations?: InternalCitation[];
}

export interface RevisionSnapshot {
  specHandle: string;
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
] as const;

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

function danglingTypedReferenceFinding(
  sourceElement: RevisionElement,
  targetId: string,
  expectedKind: "requirement" | "criterion" | "decision" | "task",
  relation: "traces to" | "covers" | "depends on",
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
  const decisions = elements.filter(
    (element) => element.payload.kind === "decision",
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

  for (const taskElement of tasks) {
    const scope = taskScope(taskElement);
    if (!scope) {
      continue;
    }
    const references = [
      ...scope.tracedRequirementElementIds.map((targetId) => ({
        targetId,
        expectedKind: "requirement" as const,
        relation: "traces to" as const,
        removedTaskDependencyHasSpecificFinding: false,
      })),
      ...scope.tracedDecisionElementIds.map((targetId) => ({
        targetId,
        expectedKind: "decision" as const,
        relation: "traces to" as const,
        removedTaskDependencyHasSpecificFinding: false,
      })),
      ...scope.coveredCriterionElementIds.map((targetId) => ({
        targetId,
        expectedKind: "criterion" as const,
        relation: "covers" as const,
        removedTaskDependencyHasSpecificFinding: false,
      })),
      ...scope.dependsOnTaskElementIds.map((targetId) => ({
        targetId,
        expectedKind: "task" as const,
        relation: "depends on" as const,
        removedTaskDependencyHasSpecificFinding: true,
      })),
    ];

    for (const reference of references) {
      const finding = danglingTypedReferenceFinding(
        taskElement,
        reference.targetId,
        reference.expectedKind,
        reference.relation,
        elementsById,
        knownElementsById,
        reference.removedTaskDependencyHasSpecificFinding,
      );
      if (finding) {
        findings.push(finding);
      }
    }
  }

  for (const decisionElement of decisions) {
    if (decisionElement.payload.kind !== "decision") {
      continue;
    }
    for (const requirementId of decisionElement.payload
      .tracedRequirementElementIds) {
      const finding = danglingTypedReferenceFinding(
        decisionElement,
        requirementId,
        "requirement",
        "traces to",
        elementsById,
        knownElementsById,
      );
      if (finding) {
        findings.push(finding);
      }
    }
  }

  const assumptionsById = new Map(
    (records.assumptions ?? []).map((assumption) => [
      assumption.assumptionId,
      assumption,
    ]),
  );
  for (const sourceElement of elements) {
    for (const citation of sourceElement.citations ?? []) {
      const targetExists =
        citation.kind === "element"
          ? elementsById.has(citation.elementId)
          : assumptionsById.has(citation.assumptionId);
      if (targetExists) {
        continue;
      }

      const targetId =
        citation.kind === "element"
          ? citation.elementId
          : citation.assumptionId;
      const targetWasKnown = knownElementsById.has(targetId);
      findings.push({
        ruleId: "9.6.dangling-handle",
        severity: "blocks_propose",
        elementHandle: sourceElement.handle,
        message: `${sourceElement.handle} cites ${
          targetWasKnown ? "removed" : "unknown"
        } element ${citation.handle}.`,
      });
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
    for (const citation of sourceElement.citations ?? []) {
      if (citation.kind !== "assumption") {
        continue;
      }
      const assumption = assumptionsById.get(citation.assumptionId);
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
    for (const citation of sourceElement.citations ?? []) {
      if (citation.kind !== "element") {
        continue;
      }
      const baseTarget = baseElementsById.get(citation.elementId);
      const currentTarget = elementsById.get(citation.elementId);
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
