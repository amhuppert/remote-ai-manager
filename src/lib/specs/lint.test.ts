import { describe, expect, it } from "vitest";
import {
  lint,
  type MaterializedTaskRecord,
  type RevisionElement,
  type RevisionSnapshot,
  type SpecRecords,
} from "./lint";

const requirement = (
  id: string,
  handle: string,
  payloadHash = `${id}-hash`,
): RevisionElement => ({
  id,
  handle,
  payloadHash,
  payload: {
    kind: "requirement",
    statement: `Requirement ${handle}`,
    priority: "must",
    risk: "medium",
  },
});

const criterion = (
  id: string,
  handle: string,
  parentElementId: string,
  payloadHash = `${id}-hash`,
): RevisionElement => ({
  id,
  handle,
  parentElementId,
  payloadHash,
  payload: {
    kind: "criterion",
    text: `Criterion ${handle}`,
    validationStrategy: { kinds: ["test_run"] },
  },
});

const task = (
  id: string,
  handle: string,
  options: {
    tracedRequirementElementIds?: string[];
    tracedDecisionElementIds?: string[];
    coveredCriterionElementIds?: string[];
    dependsOnTaskElementIds?: string[];
    laneGroup?: string;
    executionLane?: string;
    touchedPaths?: string[];
    payloadHash?: string;
  } = {},
): RevisionElement => ({
  id,
  handle,
  payloadHash: options.payloadHash ?? `${id}-hash`,
  payload: {
    kind: "task",
    title: `Task ${handle}`,
    instructions: `Implement ${handle}`,
    tracedRequirementElementIds: options.tracedRequirementElementIds ?? [
      "requirement-1",
    ],
    tracedDecisionElementIds: options.tracedDecisionElementIds ?? [],
    coveredCriterionElementIds: options.coveredCriterionElementIds ?? [
      "criterion-1",
    ],
    dependsOnTaskElementIds: options.dependsOnTaskElementIds ?? [],
    ...(options.laneGroup === undefined
      ? {}
      : { laneGroup: options.laneGroup }),
    ...(options.executionLane === undefined
      ? {}
      : { executionLane: options.executionLane }),
    ...(options.touchedPaths === undefined
      ? {}
      : { touchedPaths: options.touchedPaths }),
  },
});

const cleanElements = (): RevisionElement[] => [
  requirement("requirement-1", "R1"),
  criterion("criterion-1", "R1.1", "requirement-1"),
  task("task-1", "T1"),
];

const snapshot = (
  elements: RevisionElement[],
  authoringStage: RevisionSnapshot["authoringStage"] = "plan",
): RevisionSnapshot => ({
  specHandle: "native-sdd",
  authoringStage,
  elements,
});

const cleanDraft = (): RevisionSnapshot => snapshot(cleanElements());

const records = (overrides: Partial<SpecRecords> = {}): SpecRecords => ({
  ...overrides,
});

describe("lint", () => {
  it("returns no findings for a clean spec", () => {
    expect(lint(cleanDraft(), records())).toEqual([]);
  });

  it("9.2 blocks propose for an empty spec", () => {
    expect(lint(snapshot([]), records())).toEqual([
      {
        ruleId: "9.2.empty-spec",
        severity: "blocks_propose",
        elementHandle: "native-sdd",
        message: "Empty spec — nothing to review.",
      },
    ]);
  });

  it("9.3 names an uncovered criterion", () => {
    const draft = snapshot([
      requirement("requirement-1", "R1"),
      criterion("criterion-1", "R1.1", "requirement-1"),
    ]);

    expect(lint(draft, records())).toEqual([
      {
        ruleId: "9.3.uncovered-criterion",
        severity: "blocks_propose",
        elementHandle: "R1.1",
        message: "R1.1 has no covering task.",
      },
    ]);
  });

  it.each(["requirements", "design"] as const)(
    "9.3 defers criterion coverage before the %s stage reaches plan",
    (authoringStage) => {
      const draft = snapshot(
        [
          requirement("requirement-1", "R1"),
          criterion("criterion-1", "R1.1", "requirement-1"),
        ],
        authoringStage,
      );

      expect(
        lint(draft, records()).filter((finding) =>
          finding.ruleId.startsWith("9.3."),
        ),
      ).toEqual([]);
    },
  );

  it("9.3 blocks a plan task that covers no criterion", () => {
    const draft = snapshot([
      ...cleanElements(),
      task("task-2", "T2", { coveredCriterionElementIds: [] }),
    ]);

    expect(lint(draft, records())).toContainEqual({
      ruleId: "9.3.task-without-criterion",
      severity: "blocks_propose",
      elementHandle: "T2",
      message: "T2 covers no acceptance criterion.",
    });
  });

  it.each(["requirements", "design"] as const)(
    "9.3 defers task coverage before the %s stage reaches plan",
    (authoringStage) => {
      const draft = snapshot(
        [
          ...cleanElements(),
          task("task-2", "T2", { coveredCriterionElementIds: [] }),
        ],
        authoringStage,
      );

      expect(
        lint(draft, records()).filter((finding) =>
          finding.ruleId.startsWith("9.3."),
        ),
      ).toEqual([]);
    },
  );

  it("9.13 advises when a design-stage revision carries no design content", () => {
    const draft = snapshot(
      [
        requirement("requirement-1", "R1"),
        criterion("criterion-1", "R1.1", "requirement-1"),
      ],
      "design",
    );

    expect(lint(draft, records())).toContainEqual({
      ruleId: "9.13.design-stage-without-design-content",
      severity: "advisory",
      elementHandle: "native-sdd",
      message:
        "Design-stage revision carries no decision or design narrative elements.",
    });
  });

  it.each([
    {
      name: "decision",
      element: {
        id: "decision-1",
        handle: "D1",
        payloadHash: "decision-1-hash",
        payload: {
          kind: "decision" as const,
          title: "Design authority",
          chosenApproach: "Keep design state explicit.",
          rejectedAlternatives: [],
          reason: "The stage should carry its own substance.",
          tracedRequirementElementIds: ["requirement-1"],
        },
      },
    },
    {
      name: "design narrative",
      element: {
        id: "section-design",
        handle: "S-design",
        payloadHash: "section-design-hash",
        payload: {
          kind: "section" as const,
          role: "design_narrative" as const,
          title: "Design",
          body: "The server owns the authoring state projection.",
        },
      },
    },
  ])("9.13 accepts a design-stage $name", ({ element }) => {
    const draft = snapshot(
      [
        requirement("requirement-1", "R1"),
        criterion("criterion-1", "R1.1", "requirement-1"),
        element,
      ],
      "design",
    );

    expect(
      lint(draft, records()).filter(
        (finding) =>
          finding.ruleId === "9.13.design-stage-without-design-content",
      ),
    ).toEqual([]);
  });

  it("9.13 does not advise before the design stage", () => {
    const draft = snapshot(
      [
        requirement("requirement-1", "R1"),
        criterion("criterion-1", "R1.1", "requirement-1"),
      ],
      "requirements",
    );

    expect(
      lint(draft, records()).filter(
        (finding) =>
          finding.ruleId === "9.13.design-stage-without-design-content",
      ),
    ).toEqual([]);
  });

  it("9.4 names an untraced task", () => {
    const draft = snapshot([
      ...cleanElements(),
      task("task-2", "T2", { tracedRequirementElementIds: [] }),
    ]);

    expect(lint(draft, records())).toEqual([
      {
        ruleId: "9.4.untraced-task",
        severity: "blocks_propose",
        elementHandle: "T2",
        message: "T2 traces to no requirement — possible scope creep.",
      },
    ]);
  });

  it("9.5 names a task dependency cycle", () => {
    const draft = snapshot([
      requirement("requirement-1", "R1"),
      criterion("criterion-1", "R1.1", "requirement-1"),
      task("task-1", "T1", { dependsOnTaskElementIds: ["task-2"] }),
      task("task-2", "T2", { dependsOnTaskElementIds: ["task-1"] }),
    ]);

    expect(lint(draft, records())).toEqual([
      {
        ruleId: "9.5.dependency-cycle",
        severity: "blocks_propose",
        elementHandle: "T1",
        message: "Task dependency cycle: T1 → T2 → T1.",
      },
    ]);
  });

  it("9.5 names a dependency on a removed task", () => {
    const draft = snapshot([
      requirement("requirement-1", "R1"),
      criterion("criterion-1", "R1.1", "requirement-1"),
      task("task-1", "T1", { dependsOnTaskElementIds: ["task-2"] }),
    ]);

    expect(
      lint(
        draft,
        records({
          knownElements: [{ elementId: "task-2", handle: "T2", kind: "task" }],
        }),
      ),
    ).toEqual([
      {
        ruleId: "9.5.removed-task-dependency",
        severity: "blocks_propose",
        elementHandle: "T1",
        message: "T1 depends on removed task T2.",
      },
    ]);
  });

  it("9.6 names a dangling handle citation", () => {
    const draft = cleanDraft();
    draft.elements.push({
      id: "decision-1",
      handle: "D1",
      payloadHash: "decision-1-hash",
      payload: {
        kind: "decision",
        title: "Decision D1",
        chosenApproach: "Use immutable snapshots.",
        rejectedAlternatives: [],
        reason: "Preserve approved history.",
        tracedRequirementElementIds: ["requirement-1"],
      },
      citations: [
        { kind: "element", elementId: "requirement-9", handle: "R9" },
      ],
    });

    expect(lint(draft, records())).toEqual([
      {
        ruleId: "9.6.dangling-handle",
        severity: "blocks_propose",
        elementHandle: "D1",
        message: "D1 cites unknown element R9.",
      },
    ]);
  });

  it.each([
    {
      reference: "dependency",
      task: task("task-1", "T1", {
        dependsOnTaskElementIds: ["task-unknown"],
      }),
      message: "T1 depends on unknown task element task-unknown.",
    },
    {
      reference: "requirement trace",
      task: task("task-1", "T1", {
        tracedRequirementElementIds: ["requirement-1", "requirement-unknown"],
      }),
      message: "T1 traces to unknown requirement element requirement-unknown.",
    },
    {
      reference: "decision trace",
      task: task("task-1", "T1", {
        tracedDecisionElementIds: ["decision-unknown"],
      }),
      message: "T1 traces to unknown decision element decision-unknown.",
    },
    {
      reference: "criterion coverage",
      task: task("task-1", "T1", {
        coveredCriterionElementIds: ["criterion-1", "criterion-unknown"],
      }),
      message: "T1 covers unknown criterion element criterion-unknown.",
    },
  ])(
    "9.6 blocks an unknown typed task $reference",
    ({ task: taskElement, message }) => {
      const draft = snapshot([
        requirement("requirement-1", "R1"),
        criterion("criterion-1", "R1.1", "requirement-1"),
        taskElement,
      ]);

      expect(lint(draft, records())).toEqual([
        {
          ruleId: "9.6.dangling-handle",
          severity: "blocks_propose",
          elementHandle: "T1",
          message,
        },
      ]);
    },
  );

  it("9.6 blocks a decision trace to an unknown requirement", () => {
    const draft = cleanDraft();
    draft.elements.push({
      id: "decision-1",
      handle: "D1",
      payloadHash: "decision-1-hash",
      payload: {
        kind: "decision",
        title: "Decision D1",
        chosenApproach: "Use immutable snapshots.",
        rejectedAlternatives: [],
        reason: "Preserve approved history.",
        tracedRequirementElementIds: ["requirement-unknown"],
      },
    });

    expect(lint(draft, records())).toEqual([
      {
        ruleId: "9.6.dangling-handle",
        severity: "blocks_propose",
        elementHandle: "D1",
        message:
          "D1 traces to unknown requirement element requirement-unknown.",
      },
    ]);
  });

  it("9.7 names a covered criterion without evidence for a claim", () => {
    expect(
      lint(
        cleanDraft(),
        records({ pendingTaskClaims: [{ taskElementId: "task-1" }] }),
      ),
    ).toEqual([
      {
        ruleId: "9.7.claim-without-evidence",
        severity: "blocks_claim",
        elementHandle: "R1.1",
        message: "T1 cannot be claimed complete because R1.1 has no evidence.",
      },
    ]);
  });

  it("9.8 names a rejected assumption that remains cited", () => {
    const draft = cleanDraft();
    draft.elements.push({
      id: "decision-1",
      handle: "D1",
      payloadHash: "decision-1-hash",
      payload: {
        kind: "decision",
        title: "Decision D1",
        chosenApproach: "Use immutable snapshots.",
        rejectedAlternatives: [],
        reason: "Preserve approved history.",
        tracedRequirementElementIds: ["requirement-1"],
      },
      citations: [
        { kind: "assumption", assumptionId: "assumption-1", handle: "A1" },
      ],
    });

    expect(
      lint(
        draft,
        records({
          assumptions: [
            {
              assumptionId: "assumption-1",
              handle: "A1",
              disposition: "rejected",
            },
          ],
        }),
      ),
    ).toEqual([
      {
        ruleId: "9.8.rejected-cited-assumption",
        severity: "blocks_signoff",
        elementHandle: "D1",
        message: "A1 was rejected but D1 still cites it.",
      },
    ]);
  });

  it("9.9 advises when an approved element changed", () => {
    const draft = cleanDraft();
    draft.elements[0] = requirement("requirement-1", "R1", "changed-hash");

    expect(
      lint(
        draft,
        records({
          approvedElements: [
            {
              elementId: "requirement-1",
              approvedPayloadHash: "requirement-1-hash",
            },
          ],
        }),
      ),
    ).toEqual([
      {
        ruleId: "9.9.approval-freshness",
        severity: "advisory",
        elementHandle: "R1",
        message: "R1 changed since its approval.",
      },
    ]);
  });

  it("9.9 advises an approved citing element when its dependency changed", () => {
    const base = cleanDraft();
    const draft = cleanDraft();
    const decision: RevisionElement = {
      id: "decision-1",
      handle: "D1",
      payloadHash: "decision-1-hash",
      payload: {
        kind: "decision",
        title: "Decision D1",
        chosenApproach: "Use immutable snapshots.",
        rejectedAlternatives: [],
        reason: "Preserve approved history.",
        tracedRequirementElementIds: ["requirement-1"],
      },
      citations: [
        { kind: "element", elementId: "requirement-1", handle: "R1" },
      ],
    };
    base.elements.push(decision);
    draft.elements.push(decision);
    draft.elements[0] = requirement("requirement-1", "R1", "changed-hash");

    expect(
      lint(
        draft,
        records({
          baseRevision: base,
          approvedElements: [
            {
              elementId: "decision-1",
              approvedPayloadHash: "decision-1-hash",
            },
          ],
        }),
      ),
    ).toEqual([
      {
        ruleId: "9.9.cited-element-change",
        severity: "advisory",
        elementHandle: "D1",
        message: "D1 cites R1, which changed in this draft.",
      },
    ]);
  });

  it("9.9 advises for each open question at propose", () => {
    expect(
      lint(
        cleanDraft(),
        records({
          questions: [
            { questionId: "question-2", handle: "Q2", status: "open" },
          ],
        }),
      ),
    ).toEqual([
      {
        ruleId: "9.9.open-question",
        severity: "advisory",
        elementHandle: "Q2",
        message: "Q2 remains unresolved at propose.",
      },
    ]);
  });

  it.each([
    {
      name: "removed",
      materialized: {
        taskElementId: "task-2",
        handle: "T2",
        scope: {
          tracedRequirementElementIds: ["requirement-1"],
          tracedDecisionElementIds: [],
          coveredCriterionElementIds: ["criterion-1"],
          dependsOnTaskElementIds: [],
        },
      } satisfies MaterializedTaskRecord,
      currentTask: undefined,
      message: "Materialized task T2 was removed from this draft.",
    },
    {
      name: "re-scoped",
      materialized: {
        taskElementId: "task-2",
        handle: "T2",
        scope: {
          tracedRequirementElementIds: ["requirement-1"],
          tracedDecisionElementIds: [],
          coveredCriterionElementIds: ["criterion-1"],
          dependsOnTaskElementIds: [],
        },
      } satisfies MaterializedTaskRecord,
      currentTask: task("task-2", "T2", {
        dependsOnTaskElementIds: ["task-1"],
      }),
      message: "Materialized task T2 was re-scoped in this draft.",
    },
  ])(
    "9.9 advises when a materialized task is $name",
    ({ currentTask, materialized, message }) => {
      const elements = cleanElements();
      if (currentTask) {
        elements.push(currentTask);
      }

      expect(
        lint(
          snapshot(elements),
          records({ materializedTasks: [materialized] }),
        ),
      ).toEqual([
        {
          ruleId: "9.9.materialized-task-change",
          severity: "advisory",
          elementHandle: "T2",
          message,
        },
      ]);
    },
  );

  it("9.11 blocks a cycle introduced by lane-group contraction", () => {
    const draft = snapshot([
      requirement("requirement-1", "R1"),
      criterion("criterion-1", "R1.1", "requirement-1"),
      task("task-1", "T1", { laneGroup: "api" }),
      task("task-2", "T2", {
        laneGroup: "ui",
        dependsOnTaskElementIds: ["task-1"],
      }),
      task("task-3", "T3", { laneGroup: "ui" }),
      task("task-4", "T4", {
        laneGroup: "api",
        dependsOnTaskElementIds: ["task-3"],
      }),
    ]);

    expect(lint(draft, records())).toContainEqual({
      ruleId: "9.11.lane-group-cycle",
      severity: "blocks_propose",
      elementHandle: "T1",
      message: "Lane-group cycle: api → ui → api.",
    });
  });

  /**
   * R12: contraction and lane sharing compose only if their interaction is a
   * validation rule. Members of one laneGroup become ONE context, which can sit
   * on exactly one lane, so disagreement has no compilable answer — it has to be
   * refused before the compiler has to guess.
   */
  it("9.11 blocks a lane group whose members disagree about executionLane", () => {
    const draft = snapshot([
      requirement("requirement-1", "R1"),
      criterion("criterion-1", "R1.1", "requirement-1"),
      task("task-1", "T1", { laneGroup: "api", executionLane: "backend" }),
      task("task-2", "T2", { laneGroup: "api", executionLane: "frontend" }),
    ]);

    expect(lint(draft, records())).toContainEqual({
      ruleId: "9.11.lane-group-execution-lane-mismatch",
      severity: "blocks_propose",
      elementHandle: "T1",
      message:
        "Lane group api mixes execution lanes: T1 → backend, T2 → frontend. Members contracted into one context must all declare the same executionLane or all omit it.",
    });
  });

  it("9.11 blocks a lane group in which only some members declare executionLane", () => {
    const draft = snapshot([
      requirement("requirement-1", "R1"),
      criterion("criterion-1", "R1.1", "requirement-1"),
      task("task-1", "T1", { laneGroup: "api", executionLane: "backend" }),
      task("task-2", "T2", { laneGroup: "api" }),
    ]);

    expect(lint(draft, records())).toContainEqual({
      ruleId: "9.11.lane-group-execution-lane-mismatch",
      severity: "blocks_propose",
      elementHandle: "T1",
      message:
        "Lane group api mixes execution lanes: T1 → backend, T2 → none. Members contracted into one context must all declare the same executionLane or all omit it.",
    });
  });

  it("9.11 admits agreeing and absent executionLane declarations", () => {
    const draft = snapshot([
      requirement("requirement-1", "R1"),
      criterion("criterion-1", "R1.1", "requirement-1"),
      task("task-1", "T1", { laneGroup: "api", executionLane: "backend" }),
      task("task-2", "T2", { laneGroup: "api", executionLane: "backend" }),
      task("task-3", "T3", { laneGroup: "ui" }),
      task("task-4", "T4", { laneGroup: "ui" }),
      // Ungrouped tasks are never contracted together, so different lanes here
      // are the ordinary shared-lane case rather than a conflict.
      task("task-5", "T5", { executionLane: "backend" }),
      task("task-6", "T6", { executionLane: "frontend" }),
    ]);

    expect(
      lint(draft, records()).filter((finding) =>
        finding.ruleId.endsWith("execution-lane-mismatch"),
      ),
    ).toEqual([]);
  });

  it("9.12 advises when three or more tasks contract to a serialized plan", () => {
    const draft = snapshot([
      requirement("requirement-1", "R1"),
      criterion("criterion-1", "R1.1", "requirement-1"),
      task("task-1", "T1", { laneGroup: "one-lane" }),
      task("task-2", "T2", { laneGroup: "one-lane" }),
      task("task-3", "T3", { laneGroup: "one-lane" }),
    ]);

    expect(lint(draft, records())).toContainEqual({
      ruleId: "9.12.serialized-plan",
      severity: "advisory",
      elementHandle: "T1",
      message:
        "The 3-task plan contracts to 1 context with no parallel execution path.",
    });
  });

  it("9.12 advises when one task covers more than half of draft criteria", () => {
    const draft = snapshot([
      requirement("requirement-1", "R1"),
      criterion("criterion-1", "R1.1", "requirement-1"),
      criterion("criterion-2", "R1.2", "requirement-1"),
      criterion("criterion-3", "R1.3", "requirement-1"),
      task("task-1", "T1", {
        coveredCriterionElementIds: ["criterion-1", "criterion-2"],
      }),
      task("task-2", "T2", {
        coveredCriterionElementIds: ["criterion-3"],
      }),
      task("task-3", "T3", {
        coveredCriterionElementIds: ["criterion-3"],
      }),
    ]);

    expect(lint(draft, records())).toContainEqual({
      ruleId: "9.12.overloaded-task",
      severity: "advisory",
      elementHandle: "T1",
      message: "T1 covers 2 of 3 criteria, more than half of the draft.",
    });
  });

  it("9.12 advises for whole-segment path overlap in independent contexts", () => {
    const draft = snapshot([
      requirement("requirement-1", "R1"),
      criterion("criterion-1", "R1.1", "requirement-1"),
      task("task-1", "T1", { touchedPaths: ["src/lib"] }),
      task("task-2", "T2", { touchedPaths: ["src/lib/specs"] }),
      task("task-3", "T3", { touchedPaths: ["src/library"] }),
    ]);

    expect(lint(draft, records())).toContainEqual({
      ruleId: "9.12.conflicting-parallel-surfaces",
      severity: "advisory",
      elementHandle: "T1",
      message:
        "Independent tasks T1 and T2 declare overlapping touched paths src/lib and src/lib/specs.",
    });
    expect(
      lint(draft, records()).filter(
        (finding) => finding.ruleId === "9.12.conflicting-parallel-surfaces",
      ),
    ).toHaveLength(1);
  });

  it("orders findings deterministically regardless of input order", () => {
    const draft = snapshot([
      criterion("criterion-2", "R2.1", "requirement-2"),
      requirement("requirement-2", "R2"),
      criterion("criterion-1", "R1.1", "requirement-1"),
      requirement("requirement-1", "R1"),
    ]);

    expect(
      lint(draft, records()).map((finding) => finding.elementHandle),
    ).toEqual(["R1.1", "R2.1"]);
  });
});
