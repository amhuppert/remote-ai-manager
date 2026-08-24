import type {
  SpecAssumptionDisposition,
  SpecAuthoringStage,
  SpecElementKind,
  SpecElementPayload,
  SpecQuestionStatus,
} from "./schemas";
import {
  elementReferences,
  type ReferenceSourceElement,
  type SpecReferenceRelation,
} from "./element-references";
import {
  formatElementHandle,
  isWellFormedElementHandle,
  parseElementHandle,
} from "./handles";
import { extractProseHandleReferences } from "./prose-references";

export type LintSeverity = "blocks_propose" | "blocks_signoff" | "advisory";

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
  materializedTasks?: MaterializedTaskRecord[];
}

export interface EvergreenLintRuleDefinition {
  readonly ruleId: string;
  readonly severity: LintSeverity;
}

export const EVERGREEN_LINT_RULES = [
  { ruleId: "9.2.empty-spec", severity: "blocks_propose" },
  { ruleId: "9.3.uncovered-criterion", severity: "blocks_propose" },
  { ruleId: "9.3.task-without-criterion", severity: "blocks_propose" },
  { ruleId: "9.4.untraced-task", severity: "blocks_propose" },
  { ruleId: "9.5.dependency-cycle", severity: "blocks_propose" },
  { ruleId: "9.5.removed-task-dependency", severity: "blocks_propose" },
  { ruleId: "9.6.dangling-handle", severity: "blocks_propose" },
  { ruleId: "9.8.rejected-cited-assumption", severity: "blocks_signoff" },
  { ruleId: "9.9.approval-freshness", severity: "advisory" },
  { ruleId: "9.9.cited-element-change", severity: "advisory" },
  { ruleId: "9.9.open-question", severity: "advisory" },
  { ruleId: "9.9.materialized-task-change", severity: "advisory" },
  {
    ruleId: "9.13.design-stage-without-design-content",
    severity: "advisory",
  },
] as const satisfies readonly EvergreenLintRuleDefinition[];

export type EvergreenLintRuleId =
  (typeof EVERGREEN_LINT_RULES)[number]["ruleId"];

const ruleOrder = new Map<string, number>(
  EVERGREEN_LINT_RULES.map(({ ruleId }, index) => [ruleId, index]),
);
const evergreenLintRulesById = new Map(
  EVERGREEN_LINT_RULES.map((definition) => [definition.ruleId, definition]),
);

function finding(
  ruleId: EvergreenLintRuleId,
  elementHandle: string,
  message: string,
): LintFinding {
  const definition = evergreenLintRulesById.get(ruleId);
  if (definition === undefined) {
    throw new Error(`Unknown evergreen lint rule ${ruleId}.`);
  }
  return {
    ruleId,
    severity: definition.severity,
    elementHandle,
    message,
  };
}

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
          findings.push(
            finding(
              "9.5.dependency-cycle",
              cycle.anchor,
              `Task dependency cycle: ${cycle.handles.join(" → ")}.`,
            ),
          );
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
    return finding(
      "9.6.dangling-handle",
      sourceElement.handle,
      `${sourceElement.handle} ${relation} ${currentTarget.handle}, which is not a ${expectedKind}.`,
    );
  }

  const knownTarget = knownElementsById.get(targetId);
  if (removedTaskDependencyHasSpecificFinding && knownTarget?.kind === "task") {
    return undefined;
  }
  if (knownTarget?.kind === expectedKind) {
    return finding(
      "9.6.dangling-handle",
      sourceElement.handle,
      `${sourceElement.handle} ${relation} removed ${expectedKind} ${knownTarget.handle}.`,
    );
  }
  if (knownTarget) {
    return finding(
      "9.6.dangling-handle",
      sourceElement.handle,
      `${sourceElement.handle} ${relation} ${knownTarget.handle}, which is not a ${expectedKind}.`,
    );
  }

  return finding(
    "9.6.dangling-handle",
    sourceElement.handle,
    `${sourceElement.handle} ${relation} unknown ${expectedKind} element ${targetId}.`,
  );
}

interface ProseField {
  readonly field: string;
  readonly text: string;
}

/**
 * Every Markdown-rendered string an element carries. Exhaustive per kind — the
 * `typedReferenceGroups` contract applied to prose instead of ids — so a new
 * element kind is a compile error here rather than a silently unscanned field.
 *
 * `rejectedAlternatives[].label` is excluded: it is plain text, not Markdown,
 * so a handle-shaped run of characters in it asserts nothing.
 */
function proseFields(payload: SpecElementPayload): readonly ProseField[] {
  switch (payload.kind) {
    case "section":
      return [
        { field: "title", text: payload.title },
        { field: "body", text: payload.body },
      ];
    case "requirement":
      return [{ field: "statement", text: payload.statement }];
    case "criterion":
      return [
        { field: "text", text: payload.text },
        ...(payload.validationStrategy.note === undefined
          ? []
          : [
              {
                field: "validationStrategy.note",
                text: payload.validationStrategy.note,
              },
            ]),
      ];
    case "decision":
      return [
        { field: "title", text: payload.title },
        { field: "chosenApproach", text: payload.chosenApproach },
        { field: "reason", text: payload.reason },
        ...payload.rejectedAlternatives.map((alternative, index) => ({
          field: `rejectedAlternatives[${index}].reason`,
          text: alternative.reason,
        })),
      ];
    case "task":
      return [
        { field: "title", text: payload.title },
        { field: "instructions", text: payload.instructions },
      ];
  }
}

/**
 * The addressable handle an element answers to as a prose target, or null when
 * it has none.
 *
 * The projection displays an element id when an element has no derived handle —
 * sections always, and anything not yet numbered — so the `handle` field is a
 * DISPLAY value, correct for naming the source of a finding but not an address.
 * Element ids are opaque (`z.string().min(1)`), so admitting one into the target
 * lookup would let a section whose id reads like `R9` satisfy prose citing a
 * requirement that does not exist, clearing propose on a phantom. Requiring the
 * handle to parse as a canonical handle of the element's own kind keeps the two
 * roles apart — no handle kind is ever `section`, so a section can never become
 * a target.
 */
function addressableHandle(
  handle: string,
  kind: SpecElementKind,
  contextSlug: string,
): string | null {
  if (!isWellFormedElementHandle(handle, contextSlug)) return null;
  const parsed = parseElementHandle(handle, contextSlug);
  return parsed.kind === kind ? formatElementHandle(parsed, "bare") : null;
}

/**
 * A handle written into prose is as much a reference as one written into a
 * typed id array, and renumbering leaves the prose one pointing at nothing.
 *
 * `Qn`/`An` resolve on the existence of the record, whatever its lifecycle
 * state: a withdrawn question still happened, and a reference to it asserts
 * that it exists, not that it is still live.
 */
function proseReferenceFindings(
  draft: RevisionSnapshot,
  records: SpecRecords,
  elements: readonly RevisionElement[],
  elementsByHandle: ReadonlyMap<string, RevisionElement>,
  knownElementsByHandle: ReadonlyMap<string, KnownElementRecord>,
): LintFinding[] {
  const recordHandles = new Set([
    ...(records.questions ?? []).map((question) => question.handle),
    ...(records.assumptions ?? []).map((assumption) => assumption.handle),
  ]);
  const findings: LintFinding[] = [];

  for (const sourceElement of elements) {
    const reported = new Set<string>();
    for (const { field, text } of proseFields(sourceElement.payload)) {
      for (const { token, handle } of extractProseHandleReferences(
        text,
        draft.specHandle,
      )) {
        const key = `${field}\u0000${token}`;
        if (reported.has(key)) continue;
        reported.add(key);

        const bareHandle = formatElementHandle(handle, "bare");
        const unknown = () =>
          finding(
            "9.6.dangling-handle",
            sourceElement.handle,
            `${sourceElement.handle} prose references unknown handle ${token} in ${field}.`,
          );

        if (handle.kind === "question" || handle.kind === "assumption") {
          if (!recordHandles.has(bareHandle)) findings.push(unknown());
          continue;
        }
        if (elementsByHandle.has(bareHandle)) continue;

        const removed = knownElementsByHandle.get(bareHandle);
        findings.push(
          removed === undefined
            ? unknown()
            : finding(
                "9.6.dangling-handle",
                sourceElement.handle,
                `${sourceElement.handle} prose references removed ${removed.kind} ${removed.handle} in ${field}.`,
              ),
        );
      }
    }
  }

  return findings;
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
    findings.push(
      finding(
        "9.2.empty-spec",
        draft.specHandle,
        "Empty spec — nothing to review.",
      ),
    );
  }

  const hasDesignContent = elements.some(
    (element) =>
      element.payload.kind === "decision" ||
      (element.payload.kind === "section" &&
        element.payload.role === "design_narrative"),
  );
  if (draft.authoringStage === "design" && !hasDesignContent) {
    findings.push(
      finding(
        "9.13.design-stage-without-design-content",
        draft.specHandle,
        "Design-stage revision carries no decision or design narrative elements.",
      ),
    );
  }

  if (draft.authoringStage === "plan") {
    for (const criterionElement of criteria) {
      const isCovered = tasks.some((taskElement) =>
        taskScope(taskElement)?.coveredCriterionElementIds.includes(
          criterionElement.id,
        ),
      );
      if (!isCovered) {
        findings.push(
          finding(
            "9.3.uncovered-criterion",
            criterionElement.handle,
            `${criterionElement.handle} has no covering task.`,
          ),
        );
      }
    }

    for (const taskElement of tasks) {
      const coveredCriterionElementIds =
        taskScope(taskElement)?.coveredCriterionElementIds ?? [];
      if (coveredCriterionElementIds.length > 0) {
        continue;
      }
      findings.push(
        finding(
          "9.3.task-without-criterion",
          taskElement.handle,
          `${taskElement.handle} covers no acceptance criterion.`,
        ),
      );
    }
  }

  for (const taskElement of tasks) {
    const tracesCurrentRequirement = taskScope(
      taskElement,
    )?.tracedRequirementElementIds.some((elementId) =>
      requirementIds.has(elementId),
    );
    if (!tracesCurrentRequirement) {
      findings.push(
        finding(
          "9.4.untraced-task",
          taskElement.handle,
          `${taskElement.handle} traces to no requirement — possible scope creep.`,
        ),
      );
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
      findings.push(
        finding(
          "9.5.removed-task-dependency",
          taskElement.handle,
          `${taskElement.handle} depends on removed task ${knownDependency.handle}.`,
        ),
      );
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
        findings.push(
          finding(
            "9.6.dangling-handle",
            sourceElement.handle,
            `${sourceElement.handle} cites ${
              knownElementsById.has(reference.targetId) ? "removed" : "unknown"
            } element ${reference.targetHandle ?? reference.targetId}.`,
          ),
        );
        continue;
      }

      const referenceFinding = danglingTypedReferenceFinding(
        sourceElement,
        reference.targetId,
        reference.expectedKind,
        reference.relation,
        elementsById,
        knownElementsById,
        reference.field === "dependsOnTaskElementIds",
      );
      if (referenceFinding) {
        findings.push(referenceFinding);
      }
    }
  }

  const knownElementsByHandle = new Map<string, KnownElementRecord>();
  for (const known of knownElementsById.values()) {
    const handle = addressableHandle(
      known.handle,
      known.kind,
      draft.specHandle,
    );
    if (handle !== null && !knownElementsByHandle.has(handle)) {
      knownElementsByHandle.set(handle, known);
    }
  }
  const elementsByHandle = new Map<string, RevisionElement>();
  for (const element of elements) {
    const handle = addressableHandle(
      element.handle,
      element.payload.kind,
      draft.specHandle,
    );
    if (handle !== null && !elementsByHandle.has(handle)) {
      elementsByHandle.set(handle, element);
    }
  }
  findings.push(
    ...proseReferenceFindings(
      draft,
      records,
      elements,
      elementsByHandle,
      knownElementsByHandle,
    ),
  );

  for (const sourceElement of elements) {
    for (const reference of elementReferences(sourceElement)) {
      if (reference.targetSpace !== "assumption") {
        continue;
      }
      const assumption = assumptionsById.get(reference.targetId);
      if (assumption?.disposition !== "rejected") {
        continue;
      }
      findings.push(
        finding(
          "9.8.rejected-cited-assumption",
          sourceElement.handle,
          `${assumption.handle} was rejected but ${sourceElement.handle} still cites it.`,
        ),
      );
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
      findings.push(
        finding(
          "9.9.approval-freshness",
          currentElement.handle,
          `${currentElement.handle} changed since its approval.`,
        ),
      );
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
      findings.push(
        finding(
          "9.9.cited-element-change",
          sourceElement.handle,
          `${sourceElement.handle} cites ${currentTarget.handle}, which changed in this draft.`,
        ),
      );
    }
  }

  for (const question of records.questions ?? []) {
    if (question.status !== "open") {
      continue;
    }
    findings.push(
      finding(
        "9.9.open-question",
        question.handle,
        `${question.handle} remains unresolved at propose.`,
      ),
    );
  }

  for (const materializedTask of records.materializedTasks ?? []) {
    const currentTask = tasksById.get(materializedTask.taskElementId);
    if (!currentTask) {
      findings.push(
        finding(
          "9.9.materialized-task-change",
          materializedTask.handle,
          `Materialized task ${materializedTask.handle} was removed from this draft.`,
        ),
      );
      continue;
    }

    const currentScope = taskScope(currentTask);
    if (currentScope && !hasSameScope(currentScope, materializedTask.scope)) {
      findings.push(
        finding(
          "9.9.materialized-task-change",
          currentTask.handle,
          `Materialized task ${currentTask.handle} was re-scoped in this draft.`,
        ),
      );
    }
  }

  return sortFindings(findings);
}
