import { describe, expect, it } from "vitest";

import {
  danglingReferenceRefusal,
  stageRevisionWrite,
  validateStagedWrite,
  type GuardedElement,
  type StagedElementMutation,
} from "./element-write-guard";
import type {
  CriterionElementPayload,
  RequirementElementPayload,
  TaskElementPayload,
} from "./schemas";

const requirementPayload = (
  statement = "The revision keeps its references resolvable.",
): RequirementElementPayload => ({
  kind: "requirement",
  statement,
  priority: "must",
  risk: "high",
});

const criterionPayload = (
  text = "Every reference resolves.",
): CriterionElementPayload => ({
  kind: "criterion",
  text,
  validationStrategy: { kinds: ["test_run"] },
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
  title: "Route the write",
  instructions: "Stage, validate, commit.",
  tracedRequirementElementIds: scope.tracedRequirementElementIds ?? [],
  tracedDecisionElementIds: scope.tracedDecisionElementIds ?? [],
  coveredCriterionElementIds: scope.coveredCriterionElementIds ?? [],
  dependsOnTaskElementIds: scope.dependsOnTaskElementIds ?? [],
});

const requirement = (id: string): GuardedElement => ({
  id,
  payload: requirementPayload(),
  parentElementId: null,
});

const criterion = (id: string, parentElementId: string): GuardedElement => ({
  id,
  payload: criterionPayload(),
  parentElementId,
});

const task = (
  id: string,
  scope: Parameters<typeof taskPayload>[0] = {},
): GuardedElement => ({
  id,
  payload: taskPayload(scope),
  parentElementId: null,
});

const write = (element: GuardedElement): StagedElementMutation => ({
  op: "write",
  elementId: element.id,
  payload: element.payload,
  parentElementId: element.parentElementId,
});

const remove = (elementId: string): StagedElementMutation => ({
  op: "remove",
  elementId,
});

function issuesFor(
  current: readonly GuardedElement[],
  mutations: readonly StagedElementMutation[],
) {
  return validateStagedWrite(stageRevisionWrite(current, mutations));
}

describe("stageRevisionWrite", () => {
  it("replaces an existing element in place and appends an introduced one", () => {
    const staged = stageRevisionWrite(
      [requirement("requirement-1"), task("task-1")],
      [
        write(
          task("task-1", { tracedRequirementElementIds: ["requirement-1"] }),
        ),
        write(criterion("criterion-1", "requirement-1")),
      ],
    );

    expect(staged.finalSnapshot.map(({ id }) => id)).toEqual([
      "requirement-1",
      "task-1",
      "criterion-1",
    ]);
    expect(staged.finalSnapshot[1]?.payload).toMatchObject({
      tracedRequirementElementIds: ["requirement-1"],
    });
  });

  it("treats every written element as an affected source and only introductions and removals as affected targets", () => {
    const staged = stageRevisionWrite(
      [requirement("requirement-1"), task("task-1"), task("task-2")],
      [
        write(task("task-1")),
        write(criterion("criterion-1", "requirement-1")),
        remove("task-2"),
      ],
    );

    expect([...staged.affectedSources].sort()).toEqual([
      "criterion-1",
      "task-1",
    ]);
    expect([...staged.affectedTargets].sort()).toEqual([
      "criterion-1",
      "task-2",
    ]);
  });

  it("drops a removed element from the final snapshot", () => {
    const staged = stageRevisionWrite(
      [requirement("requirement-1"), task("task-1")],
      [remove("task-1")],
    );

    expect(staged.finalSnapshot.map(({ id }) => id)).toEqual(["requirement-1"]);
  });
});

describe("validateStagedWrite", () => {
  it("resolves a forward reference regardless of the order the batch arrives in", () => {
    const forward = [
      write(task("task-1", { coveredCriterionElementIds: ["criterion-1"] })),
      write(criterion("criterion-1", "requirement-1")),
    ];

    expect(issuesFor([requirement("requirement-1")], forward)).toEqual([]);
    expect(
      issuesFor([requirement("requirement-1")], [...forward].reverse()),
    ).toEqual([]);
  });

  it("reports the field, entry index, target and expected kind of a dangling write", () => {
    const issues = issuesFor(
      [requirement("requirement-1")],
      [
        write(
          task("task-1", {
            tracedRequirementElementIds: ["requirement-1"],
            coveredCriterionElementIds: ["criterion-typo"],
          }),
        ),
      ],
    );

    expect(issues).toEqual([
      {
        code: "missing_target",
        sourceElementId: "task-1",
        field: "coveredCriterionElementIds",
        index: 0,
        targetId: "criterion-typo",
        expectedKind: "criterion",
        actualKind: null,
        relation: "covers",
      },
    ]);
  });

  it("reports an introduced target whose kind contradicts an existing reference", () => {
    const issues = issuesFor(
      [
        requirement("requirement-1"),
        task("task-1", { coveredCriterionElementIds: ["late-1"] }),
      ],
      [write(requirement("late-1"))],
    );

    expect(issues).toEqual([
      expect.objectContaining({
        code: "wrong_kind",
        sourceElementId: "task-1",
        targetId: "late-1",
        expectedKind: "criterion",
        actualKind: "requirement",
      }),
    ]);
  });

  it("keeps empty id arrays legal", () => {
    expect(issuesFor([], [write(task("task-1"))])).toEqual([]);
  });

  it("lets an unrelated repair through while other elements are already dangling", () => {
    const current = [
      requirement("requirement-1"),
      task("task-broken", { coveredCriterionElementIds: ["criterion-gone"] }),
    ];

    expect(
      issuesFor(current, [
        write(
          task("task-1", { tracedRequirementElementIds: ["requirement-1"] }),
        ),
      ]),
    ).toEqual([]);
  });

  it("refuses a removal that would leave a surviving element dangling", () => {
    const issues = issuesFor(
      [
        requirement("requirement-1"),
        task("task-1", { dependsOnTaskElementIds: ["task-2"] }),
        task("task-2"),
      ],
      [remove("task-2")],
    );

    expect(issues).toEqual([
      {
        code: "missing_target",
        sourceElementId: "task-1",
        field: "dependsOnTaskElementIds",
        index: 0,
        targetId: "task-2",
        expectedKind: "task",
        actualKind: null,
        relation: "depends on",
      },
    ]);
  });

  it("accepts a removal whose only referent is removed in the same write", () => {
    expect(
      issuesFor(
        [
          task("task-1", { dependsOnTaskElementIds: ["task-2"] }),
          task("task-2", { dependsOnTaskElementIds: ["task-1"] }),
        ],
        [remove("task-1"), remove("task-2")],
      ),
    ).toEqual([]);
  });

  it("accepts a removal whose referent is rewritten in the same write", () => {
    expect(
      issuesFor(
        [
          requirement("requirement-1"),
          task("task-1", { dependsOnTaskElementIds: ["task-2"] }),
          task("task-2"),
        ],
        [remove("task-2"), write(task("task-1"))],
      ),
    ).toEqual([]);
  });

  it("refuses a removal that would orphan a criterion child", () => {
    const issues = issuesFor(
      [requirement("requirement-1"), criterion("criterion-1", "requirement-1")],
      [remove("requirement-1")],
    );

    expect(issues).toEqual([
      {
        code: "missing_target",
        sourceElementId: "criterion-1",
        field: "parentElementId",
        index: 0,
        targetId: "requirement-1",
        expectedKind: "requirement",
        actualKind: null,
        relation: "is contained by",
      },
    ]);
  });

  it("accepts a requirement removed together with its criterion child", () => {
    expect(
      issuesFor(
        [
          requirement("requirement-1"),
          criterion("criterion-1", "requirement-1"),
        ],
        [remove("requirement-1"), remove("criterion-1")],
      ),
    ).toEqual([]);
  });

  it("does not re-judge containment the write never touched", () => {
    const orphan: GuardedElement = {
      id: "criterion-orphan",
      payload: criterionPayload(),
      parentElementId: "requirement-gone",
    };

    expect(
      issuesFor(
        [orphan, requirement("requirement-1")],
        [write(task("task-1"))],
      ),
    ).toEqual([]);
  });
});

describe("danglingReferenceRefusal", () => {
  it("names the source element, its field entry, the target and the kinds involved", () => {
    const issues = issuesFor(
      [requirement("requirement-1")],
      [
        write(
          task("task-1", { coveredCriterionElementIds: ["criterion-typo"] }),
        ),
      ],
    );

    const refusal = danglingReferenceRefusal(issues);

    expect(refusal.code).toBe("dangling_reference");
    expect(refusal.unmetConditions).toEqual([
      "task-1.coveredCriterionElementIds[0] covers criterion criterion-typo, which is not in this revision.",
    ]);
    expect(refusal.instruction).toContain("task-1");
    expect(refusal.details).toEqual({
      references: [
        {
          code: "missing_target",
          sourceElementId: "task-1",
          field: "coveredCriterionElementIds",
          index: 0,
          targetId: "criterion-typo",
          expectedKind: "criterion",
          actualKind: null,
          relation: "covers",
        },
      ],
    });
  });

  it("names a containment break's real recoveries instead of repointing, which the write cannot do", () => {
    const issues = issuesFor(
      [requirement("requirement-1"), criterion("criterion-1", "requirement-1")],
      [remove("requirement-1")],
    );

    const refusal = danglingReferenceRefusal(issues);

    expect(refusal.instruction).toContain("criterion-1");
    expect(refusal.instruction).toContain("requirement-1");
    // Containment is fixed at creation, so "repoint it" is an instruction the
    // caller can obey forever without ever clearing the refusal.
    expect(refusal.instruction).not.toContain("repoint it at an element");
    expect(refusal.instruction).toContain('"reintroduceHistorical": true');
  });

  it("keeps both recoveries when one write breaks a payload reference and a containment link", () => {
    const issues = issuesFor(
      [
        requirement("requirement-1"),
        criterion("criterion-1", "requirement-1"),
        task("task-1", { dependsOnTaskElementIds: ["task-2"] }),
        task("task-2"),
      ],
      [remove("requirement-1"), remove("task-2")],
    );

    const refusal = danglingReferenceRefusal(issues);

    expect(refusal.instruction).toContain("repoint it at an element");
    expect(refusal.instruction).toContain('"reintroduceHistorical": true');
  });
});
