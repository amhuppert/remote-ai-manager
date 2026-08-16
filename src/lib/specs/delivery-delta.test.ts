import { describe, expect, it } from "vitest";

import {
  projectDeliveryDelta,
  type DeliveryDeltaInput,
} from "./delivery-delta";
import type {
  SpecCriterionDisposition,
  SpecCriterionDispositionRow,
  SpecDeliveryVerdictRow,
  SpecElementKind,
  SpecElementPayload,
  SpecExecutionRow,
  SpecRevisionSnapshot,
  SpecWaiverRow,
} from "./schemas";

const SPEC_ID = "spec-1";
const SLUG = "native-sdd";
const TS = "2026-08-07T00:00:00.000Z";

interface RowInput {
  id: string;
  kind: SpecElementKind;
  number: number | null;
  parentElementId?: string | null;
  payload: SpecElementPayload;
  payloadHash: string;
  elementVersion?: number;
}

function snapshotOf(
  revisionId: string,
  revisionNumber: number,
  rows: readonly RowInput[],
): SpecRevisionSnapshot {
  return {
    revision: {
      id: revisionId,
      specId: SPEC_ID,
      number: revisionNumber,
      state: "approved",
      authoringStage: "plan",
      basedOnRevisionId: null,
      contentHash: `content-${revisionId}`,
      proposedAt: TS,
      approvedAt: TS,
      externalDelivery: null,
      createdAt: TS,
    },
    elements: rows.map((row, index) => ({
      element: {
        id: row.id,
        specId: SPEC_ID,
        kind: row.kind,
        number: row.number,
        parentElementId: row.parentElementId ?? null,
        createdAt: TS,
      },
      version: {
        revisionId,
        elementId: row.id,
        position: index,
        payload: row.payload,
        payloadHash: row.payloadHash,
        elementVersion: row.elementVersion ?? 1,
        createdAt: TS,
        updatedAt: TS,
      },
    })),
  };
}

function requirementRow(
  id: string,
  number: number,
  statement: string,
  payloadHash = `${id}-h1`,
  elementVersion?: number,
): RowInput {
  return {
    id,
    kind: "requirement",
    number,
    payload: { kind: "requirement", statement, priority: "must", risk: "high" },
    payloadHash,
    elementVersion,
  };
}

function criterionRow(
  id: string,
  number: number,
  parentElementId: string,
  text: string,
  payloadHash = `${id}-h1`,
  elementVersion?: number,
): RowInput {
  return {
    id,
    kind: "criterion",
    number,
    parentElementId,
    payload: {
      kind: "criterion",
      text,
      validationStrategy: { kinds: ["test_run"] },
    },
    payloadHash,
    elementVersion,
  };
}

function decisionRow(
  id: string,
  number: number,
  title: string,
  tracedRequirementElementIds: readonly string[],
  payloadHash = `${id}-h1`,
): RowInput {
  return {
    id,
    kind: "decision",
    number,
    payload: {
      kind: "decision",
      title,
      chosenApproach: "Use stable rows",
      rejectedAlternatives: [],
      reason: "Stable identity is required.",
      tracedRequirementElementIds: [...tracedRequirementElementIds],
    },
    payloadHash,
  };
}

function sectionRow(id: string, title: string, payloadHash = `${id}-h1`) {
  return {
    id,
    kind: "section" as const,
    number: null,
    payload: {
      kind: "section" as const,
      role: "intent_constraints" as const,
      title,
      body: "The constraint body.",
    },
    payloadHash,
  };
}

function taskRow(
  id: string,
  number: number,
  title: string,
  payloadHash = `${id}-h1`,
): RowInput {
  return {
    id,
    kind: "task",
    number,
    payload: {
      kind: "task",
      title,
      instructions: `Implement ${title}`,
      tracedRequirementElementIds: [],
      tracedDecisionElementIds: [],
      coveredCriterionElementIds: [],
      dependsOnTaskElementIds: [],
    },
    payloadHash,
  };
}

function deliveredExecution(
  revisionId: string,
  overrides: Partial<SpecExecutionRow> = {},
): SpecExecutionRow {
  return {
    id: "exec-1",
    spec_id: SPEC_ID,
    revision_id: revisionId,
    scope_json: "{}",
    state: "delivered",
    execution_start_dial: null,
    workflow_definition_id: "wf-1",
    workflow_definition_revision: 1,
    workflow_execution_id: "wfx-1",
    session_name: "session-1",
    delivered_at: TS,
    abandoned_reason: null,
    cleanup_phase: null,
    linked_workflow_execution_id: null,
    cleanup_last_error: null,
    cleanup_last_error_at: null,
    created_at: TS,
    updated_at: TS,
    ...overrides,
  };
}

function disposition(
  criterionElementId: string,
  value: SpecCriterionDisposition,
  overrides: Partial<SpecCriterionDispositionRow> = {},
): SpecCriterionDispositionRow {
  return {
    execution_id: "exec-1",
    criterion_element_id: criterionElementId,
    disposition: value,
    waiver_id: null,
    delivered_by_execution_id: null,
    created_at: TS,
    updated_at: TS,
    ...overrides,
  };
}

function verdict(
  criterionElementId: string,
  _revisionId: string,
  overrides: Partial<SpecDeliveryVerdictRow> = {},
): SpecDeliveryVerdictRow {
  return {
    id: `delivery-verdict-${criterionElementId}`,
    spec_execution_id: "exec-1",
    workflow_execution_id: "wfx-1",
    candidate_id: "candidate-1",
    candidate_hash: `sha256:${"a".repeat(64)}`,
    criterion_element_id: criterionElementId,
    satisfying_context_id: `context-${criterionElementId}`,
    verdict_at: TS,
    ...overrides,
  };
}

function waiver(
  criterionElementId: string,
  revisionId: string,
  overrides: Partial<SpecWaiverRow> = {},
): SpecWaiverRow {
  return {
    id: `waiver-${criterionElementId}`,
    spec_id: SPEC_ID,
    criterion_element_id: criterionElementId,
    revision_id: revisionId,
    reason: "Accepted risk for this run.",
    waived_at: TS,
    stale: 0,
    ...overrides,
  };
}

function input(overrides: Partial<DeliveryDeltaInput>): DeliveryDeltaInput {
  return {
    specSlug: SLUG,
    current: snapshotOf("rev-2", 2, []),
    base: snapshotOf("rev-1", 1, []),
    comparedExecution: deliveredExecution("rev-1"),
    dispositions: [],
    deliveryVerdicts: [],
    executionBinding: {
      specExecutionId: "exec-1",
      workflowExecutionId: "wfx-1",
      binding: {
        schemaVersion: 2,
        candidateId: "candidate-1",
        candidateHash: `sha256:${"a".repeat(64)}`,
        pinnedRevisionId: "rev-1",
        dispositions: [],
        claims: [],
      },
      createdAt: TS,
    },
    waivers: [],
    priorDelivery: { isEarlierMergedDelivery: () => false },
    ...overrides,
  };
}

function elementClassOf(
  projection: ReturnType<typeof projectDeliveryDelta>,
  elementId: string,
): string | undefined {
  return projection.elements.find((row) => row.elementId === elementId)?.class;
}

function criterionClassOf(
  projection: ReturnType<typeof projectDeliveryDelta>,
  criterionElementId: string,
): string | undefined {
  return projection.criteria.find(
    (row) => row.criterionElementId === criterionElementId,
  )?.class;
}

describe("projectDeliveryDelta element classes", () => {
  it("classifies every governed element by stable id and payload hash", () => {
    const base = snapshotOf("rev-1", 1, [
      requirementRow("req-1", 1, "Kept requirement"),
      criterionRow("crit-1", 1, "req-1", "Kept criterion"),
      requirementRow("req-2", 2, "Amended requirement", "req-2-h1"),
      decisionRow("dec-1", 1, "Removed decision", ["req-1"]),
      sectionRow("sec-1", "Constraint"),
      taskRow("task-1", 1, "Legacy task"),
    ]);
    const current = snapshotOf("rev-2", 2, [
      requirementRow("req-1", 1, "Kept requirement"),
      criterionRow("crit-1", 1, "req-1", "Kept criterion"),
      requirementRow("req-2", 2, "Amended requirement text", "req-2-h2"),
      sectionRow("sec-1", "Constraint"),
      taskRow("task-1", 1, "Legacy task"),
      requirementRow("req-3", 3, "Added requirement"),
    ]);

    const projection = projectDeliveryDelta(input({ base, current }));

    expect(elementClassOf(projection, "req-1")).toBe("unchanged");
    expect(elementClassOf(projection, "crit-1")).toBe("unchanged");
    expect(elementClassOf(projection, "req-2")).toBe("amended");
    expect(elementClassOf(projection, "req-3")).toBe("added");
    expect(elementClassOf(projection, "dec-1")).toBe("removed");
    expect(elementClassOf(projection, "sec-1")).toBe("unchanged");
    expect(elementClassOf(projection, "task-1")).toBe("unchanged");
  });

  it("returns old and current hashes plus the handle for each element", () => {
    const base = snapshotOf("rev-1", 1, [
      requirementRow("req-2", 2, "Amended requirement", "req-2-h1"),
      decisionRow("dec-1", 1, "Removed decision", ["req-2"], "dec-1-h1"),
    ]);
    const current = snapshotOf("rev-2", 2, [
      requirementRow("req-2", 2, "Amended requirement text", "req-2-h2"),
      criterionRow("crit-9", 4, "req-2", "Added criterion", "crit-9-h1"),
    ]);

    const projection = projectDeliveryDelta(input({ base, current }));

    expect(
      projection.elements.find((row) => row.elementId === "req-2"),
    ).toMatchObject({
      handle: "R2",
      kind: "requirement",
      class: "amended",
      baseHash: "req-2-h1",
      currentHash: "req-2-h2",
    });
    expect(
      projection.elements.find((row) => row.elementId === "dec-1"),
    ).toMatchObject({
      handle: "D1",
      class: "removed",
      baseHash: "dec-1-h1",
      currentHash: null,
    });
    expect(
      projection.elements.find((row) => row.elementId === "crit-9"),
    ).toMatchObject({
      handle: "R2.4",
      class: "added",
      baseHash: null,
      currentHash: "crit-9-h1",
    });
  });

  it("does not classify an elementVersion-only difference as amended", () => {
    const base = snapshotOf("rev-1", 1, [
      requirementRow("req-1", 1, "Same statement", "req-1-stable", 1),
      criterionRow("crit-1", 1, "req-1", "Same text", "crit-1-stable", 7),
    ]);
    const current = snapshotOf("rev-2", 2, [
      requirementRow("req-1", 1, "Same statement", "req-1-stable", 4),
      criterionRow("crit-1", 1, "req-1", "Same text", "crit-1-stable", 1),
    ]);

    const projection = projectDeliveryDelta(input({ base, current }));

    expect(elementClassOf(projection, "req-1")).toBe("unchanged");
    expect(elementClassOf(projection, "crit-1")).toBe("unchanged");
    expect(projection.counts.elements.amended).toBe(0);
  });

  it("orders elements by handle", () => {
    const rows = [
      taskRow("task-2", 2, "Second task"),
      requirementRow("req-10", 10, "Tenth requirement"),
      criterionRow("crit-2", 2, "req-2", "Second criterion"),
      requirementRow("req-2", 2, "Second requirement"),
      decisionRow("dec-1", 1, "First decision", ["req-2"]),
    ];
    const projection = projectDeliveryDelta(
      input({
        base: snapshotOf("rev-1", 1, rows),
        current: snapshotOf("rev-2", 2, rows),
      }),
    );

    expect(projection.elements.map((row) => row.handle)).toEqual([
      "R2",
      "R10",
      "R2.2",
      "D1",
      "T2",
    ]);
  });
});

describe("projectDeliveryDelta criterion delivery classes", () => {
  const requirement = requirementRow("req-1", 1, "The requirement");

  function criterionCase(overrides: Partial<DeliveryDeltaInput>) {
    return projectDeliveryDelta(input(overrides));
  }

  it("classifies a proven, unchanged criterion as delivered-and-fresh", () => {
    const rows = [requirement, criterionRow("crit-1", 1, "req-1", "Prove it")];
    const projection = criterionCase({
      base: snapshotOf("rev-1", 1, rows),
      current: snapshotOf("rev-2", 2, rows),
      dispositions: [disposition("crit-1", "in_scope")],
      deliveryVerdicts: [verdict("crit-1", "rev-1")],
    });

    expect(criterionClassOf(projection, "crit-1")).toBe("delivered_and_fresh");
    expect(
      projection.criteria.find((row) => row.criterionElementId === "crit-1"),
    ).toMatchObject({ handle: "R1.1", priorDisposition: "in_scope" });
  });

  it("classifies a proven criterion whose text changed as hard-stale", () => {
    const projection = criterionCase({
      base: snapshotOf("rev-1", 1, [
        requirement,
        criterionRow("crit-1", 1, "req-1", "Prove it", "crit-1-h1"),
      ]),
      current: snapshotOf("rev-2", 2, [
        requirement,
        criterionRow("crit-1", 1, "req-1", "Prove it twice", "crit-1-h2"),
      ]),
      dispositions: [disposition("crit-1", "in_scope")],
      deliveryVerdicts: [verdict("crit-1", "rev-1")],
    });

    expect(criterionClassOf(projection, "crit-1")).toBe("hard_stale");
  });

  it("classifies a criterion the compared execution never proved as never-delivered", () => {
    const rows = [requirement, criterionRow("crit-1", 1, "req-1", "Prove it")];
    const projection = criterionCase({
      base: snapshotOf("rev-1", 1, rows),
      current: snapshotOf("rev-2", 2, rows),
      dispositions: [disposition("crit-1", "in_scope")],
      deliveryVerdicts: [],
    });

    expect(criterionClassOf(projection, "crit-1")).toBe("never_delivered");
  });

  it("classifies a current Studio waiver accepted during an in-scope execution as waived", () => {
    const rows = [
      requirement,
      criterionRow("crit-1", 1, "req-1", "Accepted risk"),
    ];
    const projection = criterionCase({
      base: snapshotOf("rev-1", 1, rows),
      current: snapshotOf("rev-2", 2, rows),
      dispositions: [disposition("crit-1", "in_scope")],
      deliveryVerdicts: [],
      waivers: [waiver("crit-1", "rev-1")],
    });

    expect(criterionClassOf(projection, "crit-1")).toBe("waived");
  });

  it("classifies a criterion added after the compared revision as never-delivered", () => {
    const projection = criterionCase({
      base: snapshotOf("rev-1", 1, [requirement]),
      current: snapshotOf("rev-2", 2, [
        requirement,
        criterionRow("crit-new", 1, "req-1", "Brand new"),
      ]),
    });

    expect(criterionClassOf(projection, "crit-new")).toBe("never_delivered");
    expect(
      projection.criteria.find((row) => row.criterionElementId === "crit-new"),
    ).toMatchObject({ priorDisposition: null, freshness: null });
  });

  it("classifies a deferred disposition as deferred", () => {
    const rows = [requirement, criterionRow("crit-1", 1, "req-1", "Later")];
    const projection = criterionCase({
      base: snapshotOf("rev-1", 1, rows),
      current: snapshotOf("rev-2", 2, rows),
      dispositions: [disposition("crit-1", "deferred")],
    });

    expect(criterionClassOf(projection, "crit-1")).toBe("deferred");
  });

  it("classifies an honored waiver as waived and a stale waiver as never-delivered", () => {
    const rows = [
      requirement,
      criterionRow("crit-1", 1, "req-1", "Waived"),
      criterionRow("crit-2", 2, "req-1", "Stale waiver"),
    ];
    const projection = criterionCase({
      base: snapshotOf("rev-1", 1, rows),
      current: snapshotOf("rev-2", 2, rows),
      dispositions: [
        disposition("crit-1", "waived", { waiver_id: "waiver-crit-1" }),
        disposition("crit-2", "waived", { waiver_id: "waiver-crit-2" }),
      ],
      waivers: [
        waiver("crit-1", "rev-1"),
        waiver("crit-2", "rev-1", { stale: 1 }),
      ],
    });

    expect(criterionClassOf(projection, "crit-1")).toBe("waived");
    expect(criterionClassOf(projection, "crit-2")).toBe("never_delivered");
    expect(
      projection.criteria.find((row) => row.criterionElementId === "crit-2"),
    ).toMatchObject({ priorDisposition: "waived" });
  });

  /**
   * The gate refuses a waiver that belongs to another revision or another
   * spec. If the projection accepted one, it would advertise a criterion as
   * waived that delivery will refuse, and the plan authored from this delta
   * would be short exactly that criterion.
   */
  it("refuses a waiver pinned to another revision or another spec, as the gate does", () => {
    const rows = [
      requirement,
      criterionRow("crit-1", 1, "req-1", "Waiver from another revision"),
      criterionRow("crit-2", 2, "req-1", "Waiver from another spec"),
    ];
    const projection = criterionCase({
      base: snapshotOf("rev-1", 1, rows),
      current: snapshotOf("rev-2", 2, rows),
      dispositions: [
        disposition("crit-1", "waived", { waiver_id: "waiver-crit-1" }),
        disposition("crit-2", "waived", { waiver_id: "waiver-crit-2" }),
      ],
      waivers: [
        waiver("crit-1", "rev-0"),
        waiver("crit-2", "rev-1", { spec_id: "spec-other" }),
      ],
    });

    expect(criterionClassOf(projection, "crit-1")).toBe("never_delivered");
    expect(criterionClassOf(projection, "crit-2")).toBe("never_delivered");
  });

  it("honors the delivery gate's earlier-merged-delivery rule for delivered_elsewhere", () => {
    const rows = [
      requirement,
      criterionRow("crit-1", 1, "req-1", "Shipped earlier"),
      criterionRow("crit-2", 2, "req-1", "Claimed but unproven"),
    ];
    const projection = criterionCase({
      base: snapshotOf("rev-1", 1, rows),
      current: snapshotOf("rev-2", 2, rows),
      dispositions: [
        disposition("crit-1", "delivered_elsewhere", {
          delivered_by_execution_id: "exec-0",
        }),
        disposition("crit-2", "delivered_elsewhere", {
          delivered_by_execution_id: "exec-0",
        }),
      ],
      priorDelivery: {
        isEarlierMergedDelivery: (row) => row.criterion_element_id === "crit-1",
      },
    });

    expect(criterionClassOf(projection, "crit-1")).toBe("delivered_and_fresh");
    expect(criterionClassOf(projection, "crit-2")).toBe("never_delivered");
  });

  it("ignores verdicts from another spec execution or graph execution", () => {
    const rows = [
      requirement,
      criterionRow("crit-1", 1, "req-1", "Stale verdict"),
      criterionRow("crit-2", 2, "req-1", "Wrong revision"),
    ];
    const projection = criterionCase({
      base: snapshotOf("rev-1", 1, rows),
      current: snapshotOf("rev-2", 2, rows),
      dispositions: [
        disposition("crit-1", "in_scope"),
        disposition("crit-2", "in_scope"),
      ],
      deliveryVerdicts: [
        verdict("crit-1", "rev-1", {
          spec_execution_id: "exec-prior",
        }),
        verdict("crit-2", "rev-2", {
          workflow_execution_id: "wfx-prior",
        }),
      ],
    });

    expect(criterionClassOf(projection, "crit-1")).toBe("never_delivered");
    expect(criterionClassOf(projection, "crit-2")).toBe("never_delivered");
  });

  it("ignores a verdict whose candidate identity differs from the frozen binding", () => {
    const rows = [
      requirement,
      criterionRow("crit-1", 1, "req-1", "Bound candidate only"),
    ];
    const projection = criterionCase({
      base: snapshotOf("rev-1", 1, rows),
      current: snapshotOf("rev-2", 2, rows),
      dispositions: [disposition("crit-1", "in_scope")],
      deliveryVerdicts: [
        verdict("crit-1", "rev-1", {
          candidate_id: "candidate-other",
          candidate_hash: `sha256:${"b".repeat(64)}`,
        }),
      ],
      executionBinding: {
        specExecutionId: "exec-1",
        workflowExecutionId: "wfx-1",
        binding: {
          schemaVersion: 2,
          candidateId: "candidate-1",
          candidateHash: `sha256:${"a".repeat(64)}`,
          pinnedRevisionId: "rev-1",
          dispositions: [],
          claims: [],
        },
        createdAt: TS,
      },
    } as Partial<DeliveryDeltaInput>);

    expect(criterionClassOf(projection, "crit-1")).toBe("never_delivered");
  });

  it("reports every current criterion as never-delivered when no execution has delivered", () => {
    const projection = criterionCase({
      base: null,
      comparedExecution: null,
      current: snapshotOf("rev-1", 1, [
        requirement,
        criterionRow("crit-1", 1, "req-1", "Nothing shipped yet"),
      ]),
    });

    expect(projection.base).toBeNull();
    expect(projection.comparedExecution).toBeNull();
    expect(criterionClassOf(projection, "crit-1")).toBe("never_delivered");
    expect(elementClassOf(projection, "crit-1")).toBe("added");
  });

  it("refuses a base snapshot that is not the compared execution's pinned revision", () => {
    expect(() =>
      projectDeliveryDelta(
        input({
          base: snapshotOf("rev-0", 1, []),
          comparedExecution: deliveredExecution("rev-1"),
        }),
      ),
    ).toThrow(/pinned revision/i);
  });

  it("counts criteria by class", () => {
    const rows = [
      requirement,
      criterionRow("crit-1", 1, "req-1", "Proven"),
      criterionRow("crit-2", 2, "req-1", "Deferred"),
    ];
    const projection = criterionCase({
      base: snapshotOf("rev-1", 1, rows),
      current: snapshotOf("rev-2", 2, rows),
      dispositions: [
        disposition("crit-1", "in_scope"),
        disposition("crit-2", "deferred"),
      ],
      deliveryVerdicts: [verdict("crit-1", "rev-1")],
    });

    expect(projection.counts.criteria).toMatchObject({
      delivered_and_fresh: 1,
      deferred: 1,
      never_delivered: 0,
    });
  });
});

/**
 * The per-class cases above each isolate one criterion. This one spec carries
 * all six classes at once against a single delivered execution, because the
 * classes have to hold side by side: a stale neighbour must not drag a fresh
 * criterion with it, and an untouched parent must keep its criteria fresh
 * while an amended parent softens only its own.
 */
describe("one delivered execution with subsequent amendments", () => {
  const baseRows = [
    requirementRow("req-1", 1, "Stable requirement", "req-1-h1"),
    criterionRow(
      "crit-fresh",
      1,
      "req-1",
      "Prove the fresh one",
      "crit-fresh-h1",
    ),
    criterionRow(
      "crit-hard",
      2,
      "req-1",
      "Prove the original words",
      "crit-hard-h1",
    ),
    criterionRow(
      "crit-deferred",
      3,
      "req-1",
      "Deferred work",
      "crit-deferred-h1",
    ),
    criterionRow("crit-waived", 4, "req-1", "Waived work", "crit-waived-h1"),
    requirementRow("req-2", 2, "Amended requirement", "req-2-h1"),
    criterionRow(
      "crit-soft",
      1,
      "req-2",
      "Unchanged criterion text",
      "crit-soft-h1",
    ),
  ];

  const currentRows = [
    requirementRow("req-1", 1, "Stable requirement", "req-1-h1"),
    criterionRow(
      "crit-fresh",
      1,
      "req-1",
      "Prove the fresh one",
      "crit-fresh-h1",
    ),
    criterionRow(
      "crit-hard",
      2,
      "req-1",
      "Prove the rewritten words",
      "crit-hard-h2",
    ),
    criterionRow(
      "crit-deferred",
      3,
      "req-1",
      "Deferred work",
      "crit-deferred-h1",
    ),
    criterionRow("crit-waived", 4, "req-1", "Waived work", "crit-waived-h1"),
    criterionRow("crit-new", 5, "req-1", "Newly added", "crit-new-h1"),
    requirementRow("req-2", 2, "Amended requirement text", "req-2-h2"),
    criterionRow(
      "crit-soft",
      1,
      "req-2",
      "Unchanged criterion text",
      "crit-soft-h1",
    ),
  ];

  const projection = projectDeliveryDelta(
    input({
      base: snapshotOf("rev-1", 1, baseRows),
      current: snapshotOf("rev-2", 2, currentRows),
      comparedExecution: deliveredExecution("rev-1"),
      dispositions: [
        disposition("crit-fresh", "in_scope"),
        disposition("crit-hard", "in_scope"),
        disposition("crit-soft", "in_scope"),
        disposition("crit-deferred", "deferred"),
        disposition("crit-waived", "waived", {
          waiver_id: "waiver-crit-waived",
        }),
      ],
      deliveryVerdicts: [
        verdict("crit-fresh", "rev-1"),
        verdict("crit-hard", "rev-1"),
        verdict("crit-soft", "rev-1"),
      ],
      waivers: [waiver("crit-waived", "rev-1")],
    }),
  );

  it("classifies every criterion against the delivered execution's pinned revision", () => {
    expect(criterionClassOf(projection, "crit-fresh")).toBe(
      "delivered_and_fresh",
    );
    expect(criterionClassOf(projection, "crit-hard")).toBe("hard_stale");
    expect(criterionClassOf(projection, "crit-soft")).toBe("soft_stale");
    expect(criterionClassOf(projection, "crit-deferred")).toBe("deferred");
    expect(criterionClassOf(projection, "crit-waived")).toBe("waived");
    expect(criterionClassOf(projection, "crit-new")).toBe("never_delivered");
  });

  it("counts each class exactly once", () => {
    expect(projection.counts.criteria).toEqual({
      delivered_and_fresh: 1,
      soft_stale: 1,
      hard_stale: 1,
      never_delivered: 1,
      deferred: 1,
      waived: 1,
    });
  });

  it("explains each staleness with the basis element's old and current hashes", () => {
    expect(
      projection.criteria.find((row) => row.criterionElementId === "crit-hard")
        ?.freshness,
    ).toMatchObject({
      grade: "hard_stale",
      basis: [
        {
          elementId: "crit-hard",
          handle: "R1.2",
          reason: "criterion_text",
          baseHash: "crit-hard-h1",
          currentHash: "crit-hard-h2",
        },
      ],
    });
    expect(
      projection.criteria.find((row) => row.criterionElementId === "crit-soft")
        ?.freshness,
    ).toMatchObject({
      grade: "soft_stale",
      basis: [
        {
          elementId: "req-2",
          handle: "R2",
          reason: "parent_requirement",
          baseHash: "req-2-h1",
          currentHash: "req-2-h2",
        },
      ],
    });
  });
});

describe("criterion freshness grades", () => {
  /**
   * Every case here delivers `crit-1` through the same proven in_scope
   * disposition, so the only thing that moves the grade is what changed
   * between the pinned revision and the current one.
   */
  function graded(
    baseRows: readonly RowInput[],
    currentRows: readonly RowInput[],
  ) {
    const projection = projectDeliveryDelta(
      input({
        base: snapshotOf("rev-1", 1, baseRows),
        current: snapshotOf("rev-2", 2, currentRows),
        dispositions: [disposition("crit-1", "in_scope")],
        deliveryVerdicts: [verdict("crit-1", "rev-1")],
      }),
    );
    const criterion = projection.criteria.find(
      (row) => row.criterionElementId === "crit-1",
    );
    return { projection, criterion };
  }

  const req = requirementRow("req-1", 1, "The requirement", "req-1-h1");
  const reqAmended = requirementRow(
    "req-1",
    1,
    "The requirement, restated",
    "req-1-h2",
  );
  const crit = criterionRow("crit-1", 1, "req-1", "Prove it", "crit-1-h1");

  it("grades an untouched criterion fresh with no basis", () => {
    const { criterion } = graded([req, crit], [req, crit]);

    expect(criterion?.class).toBe("delivered_and_fresh");
    expect(criterion?.freshness).toEqual({ grade: "fresh", basis: [] });
  });

  it("grades a changed criterion text hard-stale and names the criterion basis", () => {
    const { criterion } = graded(
      [req, crit],
      [req, criterionRow("crit-1", 1, "req-1", "Prove it twice", "crit-1-h2")],
    );

    expect(criterion?.class).toBe("hard_stale");
    expect(criterion?.freshness?.grade).toBe("hard_stale");
    expect(criterion?.freshness?.basis).toEqual([
      {
        elementId: "crit-1",
        kind: "criterion",
        handle: "R1.1",
        reason: "criterion_text",
        baseHash: "crit-1-h1",
        currentHash: "crit-1-h2",
      },
    ]);
  });

  it("grades a changed validation strategy hard-stale", () => {
    const restrategized: RowInput = {
      id: "crit-1",
      kind: "criterion",
      number: 1,
      parentElementId: "req-1",
      payload: {
        kind: "criterion",
        text: "Prove it",
        validationStrategy: { kinds: ["validator_verdict"] },
      },
      payloadHash: "crit-1-h3",
    };
    const { criterion } = graded([req, crit], [req, restrategized]);

    expect(criterion?.class).toBe("hard_stale");
    expect(criterion?.freshness?.basis.map((entry) => entry.reason)).toEqual([
      "criterion_validation_strategy",
    ]);
  });

  it("grades a parent-requirement-only change soft-stale and names the requirement basis", () => {
    const { criterion } = graded([req, crit], [reqAmended, crit]);

    expect(criterion?.class).toBe("soft_stale");
    expect(criterion?.freshness?.basis).toEqual([
      {
        elementId: "req-1",
        kind: "requirement",
        handle: "R1",
        reason: "parent_requirement",
        baseHash: "req-1-h1",
        currentHash: "req-1-h2",
      },
    ]);
  });

  it("grades a governing-decision-only change soft-stale and names the decision basis", () => {
    const { criterion } = graded(
      [req, crit, decisionRow("dec-1", 1, "Chosen shape", ["req-1"], "d1")],
      [req, crit, decisionRow("dec-1", 1, "Reshaped", ["req-1"], "d2")],
    );

    expect(criterion?.class).toBe("soft_stale");
    expect(criterion?.freshness?.basis).toEqual([
      {
        elementId: "dec-1",
        kind: "decision",
        handle: "D1",
        reason: "governing_decision",
        baseHash: "d1",
        currentHash: "d2",
      },
    ]);
  });

  it("grades a removed governing decision soft-stale with a null current hash", () => {
    const { criterion } = graded(
      [req, crit, decisionRow("dec-1", 1, "Chosen shape", ["req-1"], "d1")],
      [req, crit],
    );

    expect(criterion?.class).toBe("soft_stale");
    expect(criterion?.freshness?.basis).toEqual([
      {
        elementId: "dec-1",
        kind: "decision",
        handle: "D1",
        reason: "governing_decision",
        baseHash: "d1",
        currentHash: null,
      },
    ]);
  });

  it("ignores a decision that governs the requirement only in the current revision", () => {
    const { criterion } = graded(
      [req, crit],
      [req, crit, decisionRow("dec-2", 2, "Newly traced", ["req-1"], "d9")],
    );

    expect(criterion?.class).toBe("delivered_and_fresh");
    expect(criterion?.freshness?.grade).toBe("fresh");
  });

  it("ignores a changed decision that never traced the criterion's requirement", () => {
    const other = requirementRow("req-2", 2, "Another requirement", "req-2-h1");
    const { criterion } = graded(
      [req, crit, other, decisionRow("dec-1", 1, "Elsewhere", ["req-2"], "d1")],
      [req, crit, other, decisionRow("dec-1", 1, "Elsewhere", ["req-2"], "d2")],
    );

    expect(criterion?.class).toBe("delivered_and_fresh");
  });

  it("prefers hard staleness when the criterion and its requirement both changed", () => {
    const { criterion } = graded(
      [req, crit],
      [
        reqAmended,
        criterionRow("crit-1", 1, "req-1", "Prove it twice", "crit-1-h2"),
      ],
    );

    expect(criterion?.class).toBe("hard_stale");
    expect(criterion?.freshness?.basis.map((entry) => entry.reason)).toEqual([
      "criterion_text",
    ]);
  });
});

describe("delivered_elsewhere staleness advisory", () => {
  const req = requirementRow("req-1", 1, "The requirement", "req-1-h1");
  const crit = criterionRow("crit-1", 1, "req-1", "Prove it", "crit-1-h1");

  function advised(
    currentRows: readonly RowInput[],
    dispositions: readonly SpecCriterionDispositionRow[] = [
      disposition("crit-1", "in_scope"),
    ],
  ) {
    return projectDeliveryDelta(
      input({
        base: snapshotOf("rev-1", 1, [req, crit]),
        current: snapshotOf("rev-2", 2, currentRows),
        dispositions,
        deliveryVerdicts: [verdict("crit-1", "rev-1")],
        priorDelivery: { isEarlierMergedDelivery: () => true },
      }),
    );
  }

  it("marks a hard-stale criterion as refused for delivered_elsewhere", () => {
    const projection = advised([
      req,
      criterionRow("crit-1", 1, "req-1", "Prove it twice", "crit-1-h2"),
    ]);

    expect(projection.advisories).toHaveLength(1);
    const advisory = projection.advisories[0];
    expect(advisory).toMatchObject({
      criterionElementId: "crit-1",
      handle: "R1.1",
      code: "delivered_elsewhere_refused",
      freshness: "hard_stale",
      priorDisposition: "in_scope",
    });
    expect(advisory?.message).toContain("R1.1");
    expect(advisory?.message).toContain("dpa-document");
    expect(advisory?.message).toMatch(/re-prove/i);
  });

  it("marks a soft-stale criterion as needing a reaffirmed disposition", () => {
    const projection = advised([
      requirementRow("req-1", 1, "The requirement, restated", "req-1-h2"),
      crit,
    ]);

    expect(projection.advisories).toHaveLength(1);
    expect(projection.advisories[0]).toMatchObject({
      code: "delivered_elsewhere_requires_reaffirmation",
      freshness: "soft_stale",
    });
    expect(projection.advisories[0]?.message).toMatch(/reaffirmed/i);
    expect(projection.advisories[0]?.message).toContain("dpa-document");
  });

  it("carries the compared execution's own delivered_elsewhere disposition", () => {
    const projection = advised(
      [req, criterionRow("crit-1", 1, "req-1", "Prove it twice", "crit-1-h2")],
      [
        disposition("crit-1", "delivered_elsewhere", {
          delivered_by_execution_id: "exec-0",
        }),
      ],
    );

    expect(projection.advisories[0]).toMatchObject({
      code: "delivered_elsewhere_refused",
      priorDisposition: "delivered_elsewhere",
    });
  });

  it("marks nothing when every delivered criterion is fresh", () => {
    expect(advised([req, crit]).advisories).toEqual([]);
  });

  it("marks nothing for a criterion that was never delivered", () => {
    const projection = projectDeliveryDelta(
      input({
        base: snapshotOf("rev-1", 1, [req]),
        current: snapshotOf("rev-2", 2, [req, crit]),
      }),
    );

    expect(projection.advisories).toEqual([]);
  });
});
