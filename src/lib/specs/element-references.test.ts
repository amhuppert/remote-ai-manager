import { describe, expect, it } from "vitest";
import {
  describeReferenceIssue,
  elementReferences,
  enumerateElementReferences,
  validateAffectedReferences,
  type ReferenceSourceElement,
} from "./element-references";
import { lint, type RevisionElement, type RevisionSnapshot } from "./lint";
import {
  specElementPayloadSchema,
  type CriterionElementPayload,
  type DecisionElementPayload,
  type RequirementElementPayload,
  type SectionElementPayload,
  type SpecElementKind,
  type TaskElementPayload,
} from "./schemas";

const sectionPayload = (): SectionElementPayload => ({
  kind: "section",
  role: "context",
  title: "Context",
  body: "Background.",
});

const requirementPayload = (): RequirementElementPayload => ({
  kind: "requirement",
  statement: "The system persists spec content.",
  priority: "must",
  risk: "medium",
});

const criterionPayload = (): CriterionElementPayload => ({
  kind: "criterion",
  text: "A reload returns the written content.",
  validationStrategy: { kinds: ["test_run"] },
});

const decisionPayload = (
  tracedRequirementElementIds: string[] = [],
): DecisionElementPayload => ({
  kind: "decision",
  title: "Store elements immutably",
  chosenApproach: "Append versions per revision.",
  rejectedAlternatives: [],
  reason: "Approved history must stay readable.",
  tracedRequirementElementIds,
});

const taskPayload = (
  scope: Partial<
    Pick<
      TaskElementPayload,
      | "tracedRequirementElementIds"
      | "tracedDecisionElementIds"
      | "coveredCriterionElementIds"
      | "dependsOnTaskElementIds"
    >
  > = {},
): TaskElementPayload => ({
  kind: "task",
  title: "Write the repository mapping",
  instructions: "Map every persisted field.",
  tracedRequirementElementIds: scope.tracedRequirementElementIds ?? [],
  tracedDecisionElementIds: scope.tracedDecisionElementIds ?? [],
  coveredCriterionElementIds: scope.coveredCriterionElementIds ?? [],
  dependsOnTaskElementIds: scope.dependsOnTaskElementIds ?? [],
});

const element = (
  id: string,
  payload: ReferenceSourceElement["payload"],
  citations?: ReferenceSourceElement["citations"],
): ReferenceSourceElement => ({
  id,
  payload,
  ...(citations === undefined ? {} : { citations }),
});

describe("enumerateElementReferences", () => {
  it("yields every typed element-id field of a task with its field, index, expected kind and relation", () => {
    const task = element(
      "task-1",
      taskPayload({
        tracedRequirementElementIds: ["requirement-1", "requirement-2"],
        tracedDecisionElementIds: ["decision-1"],
        coveredCriterionElementIds: ["criterion-1"],
        dependsOnTaskElementIds: ["task-0"],
      }),
    );

    expect(elementReferences(task)).toEqual([
      {
        sourceElementId: "task-1",
        field: "tracedRequirementElementIds",
        index: 0,
        targetId: "requirement-1",
        targetHandle: null,
        expectedKind: "requirement",
        relation: "traces to",
        targetSpace: "element",
      },
      {
        sourceElementId: "task-1",
        field: "tracedRequirementElementIds",
        index: 1,
        targetId: "requirement-2",
        targetHandle: null,
        expectedKind: "requirement",
        relation: "traces to",
        targetSpace: "element",
      },
      {
        sourceElementId: "task-1",
        field: "tracedDecisionElementIds",
        index: 0,
        targetId: "decision-1",
        targetHandle: null,
        expectedKind: "decision",
        relation: "traces to",
        targetSpace: "element",
      },
      {
        sourceElementId: "task-1",
        field: "coveredCriterionElementIds",
        index: 0,
        targetId: "criterion-1",
        targetHandle: null,
        expectedKind: "criterion",
        relation: "covers",
        targetSpace: "element",
      },
      {
        sourceElementId: "task-1",
        field: "dependsOnTaskElementIds",
        index: 0,
        targetId: "task-0",
        targetHandle: null,
        expectedKind: "task",
        relation: "depends on",
        targetSpace: "element",
      },
    ]);
  });

  it("yields a decision's requirement traces", () => {
    expect(
      elementReferences(
        element("decision-1", decisionPayload(["requirement-1"])),
      ),
    ).toEqual([
      {
        sourceElementId: "decision-1",
        field: "tracedRequirementElementIds",
        index: 0,
        targetId: "requirement-1",
        targetHandle: null,
        expectedKind: "requirement",
        relation: "traces to",
        targetSpace: "element",
      },
    ]);
  });

  it("yields structured citations of any kind, separating assumption targets from element targets", () => {
    expect(
      elementReferences(
        element("section-1", sectionPayload(), [
          { kind: "element", elementId: "requirement-1", handle: "R1" },
          { kind: "assumption", assumptionId: "assumption-1", handle: "A1" },
        ]),
      ),
    ).toEqual([
      {
        sourceElementId: "section-1",
        field: "citations",
        index: 0,
        targetId: "requirement-1",
        targetHandle: "R1",
        expectedKind: null,
        relation: "cites",
        targetSpace: "element",
      },
      {
        sourceElementId: "section-1",
        field: "citations",
        index: 1,
        targetId: "assumption-1",
        targetHandle: "A1",
        expectedKind: null,
        relation: "cites",
        targetSpace: "assumption",
      },
    ]);
  });

  it("yields nothing for reference-free payloads and empty id arrays", () => {
    expect(
      enumerateElementReferences([
        element("section-1", sectionPayload()),
        element("requirement-1", requirementPayload()),
        element("criterion-1", criterionPayload()),
        element("decision-1", decisionPayload()),
        element("task-1", taskPayload()),
      ]),
    ).toEqual([]);
  });

  it("covers every element-id field declared by every element payload schema", () => {
    const populated: Record<SpecElementKind, ReferenceSourceElement> = {
      section: element("section-1", sectionPayload()),
      requirement: element("requirement-1", requirementPayload()),
      criterion: element("criterion-1", criterionPayload()),
      decision: element("decision-1", decisionPayload(["requirement-1"])),
      task: element(
        "task-1",
        taskPayload({
          tracedRequirementElementIds: ["requirement-1"],
          tracedDecisionElementIds: ["decision-1"],
          coveredCriterionElementIds: ["criterion-1"],
          dependsOnTaskElementIds: ["task-0"],
        }),
      ),
    };

    for (const option of specElementPayloadSchema.options) {
      const declaredIdFields = Object.keys(option.shape)
        .filter((field) => field.endsWith("ElementIds"))
        .sort();
      const source = populated[option.shape.kind.value];
      const enumeratedIdFields = [
        ...new Set(
          elementReferences(source)
            .filter((reference) => reference.field !== "citations")
            .map((reference) => reference.field),
        ),
      ].sort();

      expect(enumeratedIdFields).toEqual(declaredIdFields);
    }
  });
});

describe("validateAffectedReferences", () => {
  const criterion = element("criterion-1", criterionPayload());
  const decision = element("decision-1", decisionPayload());

  it("reports a changed task that covers a criterion missing from the final snapshot", () => {
    const task = element(
      "task-1",
      taskPayload({ coveredCriterionElementIds: ["criterion-gone"] }),
    );

    const issues = validateAffectedReferences([task], ["task-1"], []);

    expect(issues).toEqual([
      {
        code: "missing_target",
        sourceElementId: "task-1",
        field: "coveredCriterionElementIds",
        index: 0,
        targetId: "criterion-gone",
        expectedKind: "criterion",
        actualKind: null,
        relation: "covers",
      },
    ]);
    expect(describeReferenceIssue(issues[0]!)).toBe(
      "task-1.coveredCriterionElementIds[0] covers criterion criterion-gone, which is not in this revision.",
    );
  });

  it("reports a covered id that resolves to a decision as a wrong-kind reference", () => {
    const task = element(
      "task-1",
      taskPayload({ coveredCriterionElementIds: ["decision-1"] }),
    );

    const issues = validateAffectedReferences([decision, task], ["task-1"], []);

    expect(issues).toEqual([
      {
        code: "wrong_kind",
        sourceElementId: "task-1",
        field: "coveredCriterionElementIds",
        index: 0,
        targetId: "decision-1",
        expectedKind: "criterion",
        actualKind: "decision",
        relation: "covers",
      },
    ]);
    expect(describeReferenceIssue(issues[0]!)).toBe(
      "task-1.coveredCriterionElementIds[0] covers decision-1, which is a decision, not a criterion.",
    );
  });

  it("accepts a forward reference the final snapshot resolves regardless of position", () => {
    const task = element(
      "task-1",
      taskPayload({ coveredCriterionElementIds: ["criterion-1"] }),
    );

    expect(
      validateAffectedReferences(
        [task, criterion],
        ["task-1", "criterion-1"],
        [],
      ),
    ).toEqual([]);
  });

  it("accepts empty id arrays", () => {
    expect(
      validateAffectedReferences(
        [element("task-1", taskPayload())],
        ["task-1"],
        [],
      ),
    ).toEqual([]);
  });

  it("ignores pre-existing dangling references from sources the write did not change", () => {
    const untouched = element(
      "task-0",
      taskPayload({ coveredCriterionElementIds: ["criterion-gone"] }),
    );
    const changed = element(
      "task-1",
      taskPayload({ coveredCriterionElementIds: ["criterion-1"] }),
    );

    expect(
      validateAffectedReferences(
        [untouched, changed, criterion],
        ["task-1"],
        [],
      ),
    ).toEqual([]);
  });

  it("reports unchanged sources whose target the write removed", () => {
    const survivor = element(
      "task-0",
      taskPayload({ dependsOnTaskElementIds: ["task-1"] }),
    );

    const issues = validateAffectedReferences([survivor], [], ["task-1"]);

    expect(issues).toEqual([
      {
        code: "missing_target",
        sourceElementId: "task-0",
        field: "dependsOnTaskElementIds",
        index: 0,
        targetId: "task-1",
        expectedKind: "task",
        actualKind: null,
        relation: "depends on",
      },
    ]);
  });

  it("reports a changed citation whose element target is absent", () => {
    const source = element("section-1", sectionPayload(), [
      { kind: "element", elementId: "requirement-gone", handle: "R9" },
    ]);

    expect(validateAffectedReferences([source], ["section-1"], [])).toEqual([
      {
        code: "missing_target",
        sourceElementId: "section-1",
        field: "citations",
        index: 0,
        targetId: "requirement-gone",
        expectedKind: null,
        actualKind: null,
        relation: "cites",
      },
    ]);
  });

  it("leaves assumption citations to the assumption record, not the element snapshot", () => {
    const source = element("section-1", sectionPayload(), [
      { kind: "assumption", assumptionId: "assumption-1", handle: "A1" },
    ]);

    expect(validateAffectedReferences([source], ["section-1"], [])).toEqual([]);
  });

  it("does nothing when no source changed and no target moved", () => {
    const task = element(
      "task-1",
      taskPayload({ coveredCriterionElementIds: ["criterion-gone"] }),
    );

    expect(validateAffectedReferences([task], [], [])).toEqual([]);
  });
});

describe("lint reference parity", () => {
  const revisionElement = (
    source: ReferenceSourceElement,
    handle: string,
  ): RevisionElement => ({
    id: source.id,
    handle,
    payloadHash: `${source.id}-hash`,
    payload: source.payload,
    ...(source.citations === undefined
      ? {}
      : { citations: [...source.citations] }),
  });

  it("reports exactly one dangling-handle finding per enumerated reference", () => {
    const elements: RevisionElement[] = [
      revisionElement(
        element("section-1", sectionPayload(), [
          { kind: "element", elementId: "element-gone", handle: "R9" },
          { kind: "assumption", assumptionId: "assumption-gone", handle: "A9" },
        ]),
        "S1",
      ),
      revisionElement(element("requirement-1", requirementPayload()), "R1"),
      {
        ...revisionElement(element("criterion-1", criterionPayload()), "R1.1"),
        parentElementId: "requirement-1",
      },
      revisionElement(
        element("decision-1", decisionPayload(["requirement-gone"]), [
          { kind: "element", elementId: "other-gone", handle: "R8" },
        ]),
        "D1",
      ),
      revisionElement(
        element(
          "task-1",
          taskPayload({
            tracedRequirementElementIds: [
              "requirement-gone-a",
              "requirement-gone-b",
            ],
            tracedDecisionElementIds: ["decision-gone"],
            coveredCriterionElementIds: ["criterion-gone"],
            dependsOnTaskElementIds: ["task-gone"],
          }),
        ),
        "T1",
      ),
    ];
    const handlesById = new Map(
      elements.map((revision) => [revision.id, revision.handle]),
    );
    const draft: RevisionSnapshot = {
      specHandle: "spec-slug",
      authoringStage: "plan",
      elements,
    };

    const expectedMessages = enumerateElementReferences(elements)
      .map((reference) => {
        const sourceHandle = handlesById.get(reference.sourceElementId);
        if (reference.field === "citations") {
          return `${sourceHandle} cites unknown element ${reference.targetHandle}.`;
        }
        return `${sourceHandle} ${reference.relation} unknown ${reference.expectedKind} element ${reference.targetId}.`;
      })
      .sort();

    const danglingMessages = lint(draft, {})
      .filter((finding) => finding.ruleId === "9.6.dangling-handle")
      .map((finding) => finding.message)
      .sort();

    expect(expectedMessages).toHaveLength(9);
    expect(danglingMessages).toEqual(expectedMessages);
  });
});
