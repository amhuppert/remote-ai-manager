import { describe, expect, it } from "vitest";
import {
  lint,
  type LintFinding,
  type MaterializedTaskRecord,
  type RevisionElement,
  type RevisionSnapshot,
  type SpecRecords,
} from "./lint";
import {
  specAssumptionDispositionSchema,
  specQuestionStatusSchema,
} from "./schemas";

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

/**
 * The prose half of 9.6: a handle an author wrote into Markdown text is as much
 * a reference as one written into a typed id array, and renumbering leaves the
 * prose one silently pointing at nothing. The scanner's false-positive boundary
 * lives in `prose-references.test.ts`; these tests own which fields are read,
 * how a finding reads, and what counts as resolved.
 */
describe("lint 9.6 over Markdown prose", () => {
  const proseFindings = (
    elements: RevisionElement[],
    overrides: Partial<SpecRecords> = {},
  ): LintFinding[] =>
    lint(snapshot(elements, "design"), records(overrides)).filter((finding) =>
      finding.message.includes("prose references"),
    );

  const section = (
    id: string,
    title: string,
    body: string,
  ): RevisionElement => ({
    id,
    // Sections have no handle, so the projection addresses them by element id.
    handle: id,
    payloadHash: `${id}-hash`,
    payload: { kind: "section", role: "design_narrative", title, body },
  });

  const decision = (
    id: string,
    handle: string,
    overrides: Partial<{
      title: string;
      chosenApproach: string;
      reason: string;
      rejectedAlternatives: Array<{ label: string; reason: string }>;
    }> = {},
  ): RevisionElement => ({
    id,
    handle,
    payloadHash: `${id}-hash`,
    payload: {
      kind: "decision",
      title: overrides.title ?? `Decision ${handle}`,
      chosenApproach: overrides.chosenApproach ?? "Use immutable snapshots.",
      rejectedAlternatives: overrides.rejectedAlternatives ?? [],
      reason: overrides.reason ?? "Preserve approved history.",
      tracedRequirementElementIds: ["requirement-1"],
    },
  });

  const taskWith = (
    id: string,
    handle: string,
    prose: { title?: string; instructions?: string },
  ): RevisionElement => {
    const base = task(id, handle, { coveredCriterionElementIds: [] });
    if (base.payload.kind !== "task") throw new Error("expected a task");
    return { ...base, payload: { ...base.payload, ...prose } };
  };

  const unknownIn = (
    elementHandle: string,
    token: string,
    field: string,
  ): LintFinding => ({
    ruleId: "9.6.dangling-handle",
    severity: "blocks_propose",
    elementHandle,
    message: `${elementHandle} prose references unknown handle ${token} in ${field}.`,
  });

  it.each([
    {
      kind: "section title",
      element: section("overview", "How R9 lands", "Nothing to see."),
      expected: unknownIn("overview", "R9", "title"),
    },
    {
      kind: "section body",
      element: section("overview", "Overview", "The shape follows R9 exactly."),
      expected: unknownIn("overview", "R9", "body"),
    },
    {
      kind: "requirement statement",
      element: {
        ...requirement("requirement-2", "R2"),
        payload: {
          kind: "requirement",
          statement: "The importer must satisfy R9.",
          priority: "must",
          risk: "medium",
        },
      } satisfies RevisionElement,
      expected: unknownIn("R2", "R9", "statement"),
    },
    {
      kind: "criterion text",
      element: {
        ...criterion("criterion-2", "R1.2", "requirement-1"),
        payload: {
          kind: "criterion",
          text: "Given R9, the import is refused.",
          validationStrategy: { kinds: ["test_run"] },
        },
      } satisfies RevisionElement,
      expected: unknownIn("R1.2", "R9", "text"),
    },
    {
      kind: "criterion validation note",
      element: {
        ...criterion("criterion-2", "R1.2", "requirement-1"),
        payload: {
          kind: "criterion",
          text: "The import is refused.",
          validationStrategy: {
            kinds: ["test_run"],
            note: "Reuse the harness from R9.",
          },
        },
      } satisfies RevisionElement,
      expected: unknownIn("R1.2", "R9", "validationStrategy.note"),
    },
    {
      kind: "decision title",
      element: decision("decision-1", "D1", { title: "Why R9 wins" }),
      expected: unknownIn("D1", "R9", "title"),
    },
    {
      kind: "decision chosen approach",
      element: decision("decision-1", "D1", {
        chosenApproach: "Adopt the shape R9 describes.",
      }),
      expected: unknownIn("D1", "R9", "chosenApproach"),
    },
    {
      kind: "decision reason",
      element: decision("decision-1", "D1", {
        reason: "R9 leaves no alternative.",
      }),
      expected: unknownIn("D1", "R9", "reason"),
    },
    {
      kind: "rejected alternative reason",
      element: decision("decision-1", "D1", {
        rejectedAlternatives: [
          { label: "A parallel store", reason: "It contradicts R9." },
        ],
      }),
      expected: unknownIn("D1", "R9", "rejectedAlternatives[0].reason"),
    },
    {
      kind: "task title",
      element: taskWith("task-2", "T2", { title: "Finish R9" }),
      expected: unknownIn("T2", "R9", "title"),
    },
    {
      kind: "task instructions",
      element: taskWith("task-2", "T2", { instructions: "Implement R9" }),
      expected: unknownIn("T2", "R9", "instructions"),
    },
  ])("scans the $kind field", ({ element, expected }) => {
    expect(proseFindings([...cleanElements(), element])).toEqual([expected]);
  });

  it("excludes a rejected alternative's label, which is plain text", () => {
    expect(
      proseFindings([
        ...cleanElements(),
        decision("decision-1", "D1", {
          rejectedAlternatives: [
            { label: "The R9 approach", reason: "It costs too much." },
          ],
        }),
      ]),
    ).toEqual([]);
  });

  it("distinguishes a removed target from an unknown one", () => {
    const elements = [
      ...cleanElements(),
      decision("decision-1", "D1", {
        reason: "Superseded by R2 and R9.",
      }),
    ];

    expect(
      proseFindings(elements, {
        knownElements: [
          { elementId: "requirement-2", handle: "R2", kind: "requirement" },
        ],
      }),
    ).toEqual([
      {
        ruleId: "9.6.dangling-handle",
        severity: "blocks_propose",
        elementHandle: "D1",
        message: "D1 prose references removed requirement R2 in reason.",
      },
      unknownIn("D1", "R9", "reason"),
    ]);
  });

  it("resolves a handle the draft still carries, bare or qualified with its own slug", () => {
    expect(
      proseFindings([
        ...cleanElements(),
        decision("decision-1", "D1", {
          reason: "R1 and native-sdd/R1.1 are both current.",
        }),
      ]),
    ).toEqual([]);
  });

  it("deduplicates per element, field, and token", () => {
    expect(
      proseFindings([
        ...cleanElements(),
        decision("decision-1", "D1", {
          reason: "R9 restates R9, and R9 again.",
          chosenApproach: "R9 once more.",
        }),
      ]),
    ).toEqual([
      unknownIn("D1", "R9", "chosenApproach"),
      unknownIn("D1", "R9", "reason"),
    ]);
  });

  /**
   * A reference asserts that a record exists, not that it is still live, so
   * every lifecycle state must resolve. The cases are derived from the enums
   * rather than listed: a lifecycle state added later joins this matrix instead
   * of quietly escaping it, and filtering prose resolution by state — the
   * regression this guards — turns the whole matrix red.
   */
  it.each(specQuestionStatusSchema.options.map((status) => ({ status })))(
    "resolves a question reference to a $status record",
    ({ status }) => {
      expect(
        proseFindings(
          [
            ...cleanElements(),
            decision("decision-1", "D1", { reason: "Settled by Q1." }),
          ],
          {
            questions: [{ questionId: "question-1", handle: "Q1", status }],
          },
        ),
      ).toEqual([]);
    },
  );

  it.each(
    specAssumptionDispositionSchema.options.map((disposition) => ({
      disposition,
    })),
  )(
    "resolves an assumption reference to a $disposition record",
    ({ disposition }) => {
      expect(
        proseFindings(
          [
            ...cleanElements(),
            decision("decision-1", "D1", { reason: "Rests on A4." }),
          ],
          {
            assumptions: [
              { assumptionId: "assumption-4", handle: "A4", disposition },
            ],
          },
        ),
      ).toEqual([]);
    },
  );

  /**
   * Supersession retires an assumption without deleting it: the predecessor row
   * survives under its own number and the successor is allocated a new one, so
   * both handles stay addressable and prose citing either side resolves.
   */
  it("resolves both sides of a supersession", () => {
    expect(
      proseFindings(
        [
          ...cleanElements(),
          decision("decision-1", "D1", {
            reason: "A4 was superseded by A5.",
          }),
        ],
        {
          assumptions: [
            {
              assumptionId: "assumption-4",
              handle: "A4",
              disposition: "confirmed",
            },
            {
              assumptionId: "assumption-5",
              handle: "A5",
              disposition: "proposed",
            },
          ],
        },
      ),
    ).toEqual([]);
  });

  it("reports a question or assumption reference with no record behind it", () => {
    expect(
      proseFindings([
        ...cleanElements(),
        decision("decision-1", "D1", { reason: "Rests on Q7 and A8." }),
      ]),
    ).toEqual([
      unknownIn("D1", "A8", "reason"),
      unknownIn("D1", "Q7", "reason"),
    ]);
  });

  /**
   * A section has no handle, so the projection displays its element id — and an
   * element id is an opaque string (`z.string().min(1)`), not an address. If a
   * display id were admitted into the target lookup, a section whose id happens
   * to read like a handle would silently satisfy prose citing a requirement
   * that does not exist, and the draft would clear propose on a phantom.
   */
  it("never resolves a prose reference against a section's element-id fallback", () => {
    expect(
      proseFindings([
        ...cleanElements(),
        section("R9", "Overview", "Nothing to see."),
        decision("decision-1", "D1", { reason: "Rests on R9." }),
      ]),
    ).toEqual([unknownIn("D1", "R9", "reason")]);
  });

  it("never resolves a prose reference against a removed section's element id", () => {
    expect(
      proseFindings(
        [
          ...cleanElements(),
          decision("decision-1", "D1", { reason: "Rests on R9." }),
        ],
        {
          knownElements: [{ elementId: "R9", handle: "R9", kind: "section" }],
        },
      ),
    ).toEqual([unknownIn("D1", "R9", "reason")]);
  });

  it("ignores a token inside fenced or inline code", () => {
    expect(
      proseFindings([
        ...cleanElements(),
        section(
          "overview",
          "Overview",
          "Write `R9` literally.\n\n```\nR9\n```\n",
        ),
      ]),
    ).toEqual([]);
  });
});
