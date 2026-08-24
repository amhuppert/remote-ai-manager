import { describe, expect, it } from "vitest";

import type {
  SpecAssumptionCitationSnapshot,
  SpecElementPayload,
} from "./schemas";
import type { RevisionCitation, RevisionElement } from "./revision-diff";
import { diffRevisions } from "./revision-diff";

function element(
  elementId: string,
  payloadHash: string,
  payload: SpecElementPayload,
  parentElementId: string | null = null,
): RevisionElement {
  return { elementId, parentElementId, payloadHash, payload };
}

const requirement = (statement: string): SpecElementPayload => ({
  kind: "requirement",
  statement,
  priority: "must",
  risk: "high",
});

const criterion = (statement: string): SpecElementPayload => ({
  kind: "criterion",
  text: statement,
  validationStrategy: { kinds: ["test_run"] },
});

const decision = (
  title: string,
  chosenApproach = "Use stable rows",
): SpecElementPayload => ({
  kind: "decision",
  title,
  chosenApproach,
  rejectedAlternatives: [],
  reason: "Stable identity is required.",
  tracedRequirementElementIds: ["requirement-1"],
});

function task(
  title: string,
  scope: {
    requirements?: string[];
    decisions?: string[];
    criteria?: string[];
    dependencies?: string[];
  } = {},
): SpecElementPayload {
  return {
    kind: "task",
    title,
    instructions: `Implement ${title}`,
    tracedRequirementElementIds: scope.requirements ?? ["requirement-1"],
    tracedDecisionElementIds: scope.decisions ?? [],
    coveredCriterionElementIds: scope.criteria ?? ["criterion-1"],
    dependsOnTaskElementIds: scope.dependencies ?? [],
  };
}

function citation(
  elementId: string,
  assumptionId: string,
  number: number,
  overrides: Partial<SpecAssumptionCitationSnapshot> = {},
): RevisionCitation {
  return {
    elementId,
    assumptionId,
    snapshot: {
      schemaVersion: 1,
      captureKind: "native",
      capturedAt: "2026-08-23T10:00:00.000Z",
      assumptionId,
      number,
      recordVersion: 1,
      text: `Premise ${number}`,
      elementId,
      proposedBy: { kind: "agent", conversationId: "conversation-diff" },
      disposition: "proposed",
      disposedAt: null,
      withdrawnAt: null,
      supersedesAssumptionId: null,
      createdAt: "2026-08-23T09:00:00.000Z",
      updatedAt: "2026-08-23T09:00:00.000Z",
      ...overrides,
    },
  };
}

describe("revision diff classification", () => {
  it("classifies unchanged, modified, removed, and newly added elements", () => {
    const base = [
      element("requirement-1", "same", requirement("Stable identity")),
      element("decision-1", "old-decision", decision("Storage model")),
      element("task-1", "old-task", task("Build storage")),
    ];
    const draft = [
      element("requirement-1", "same", requirement("Stable identity")),
      element("decision-1", "new-decision", decision("Storage model")),
      element("section-1", "new-section", {
        kind: "section",
        role: "context",
        title: "Background",
        body: "Relevant context.",
      }),
    ];

    expect(diffRevisions(base, draft)).toEqual({
      classifications: [
        {
          elementId: "requirement-1",
          kind: "requirement",
          classification: "unchanged",
          directlyChanged: false,
        },
        {
          elementId: "decision-1",
          kind: "decision",
          classification: "modified",
          directlyChanged: true,
        },
        {
          elementId: "section-1",
          kind: "section",
          classification: "added",
          directlyChanged: true,
        },
        {
          elementId: "task-1",
          kind: "task",
          classification: "removed",
          directlyChanged: true,
        },
      ],
      changeList: [
        {
          elementId: "decision-1",
          kind: "decision",
          change: "modified",
          summary: "Modified decision: Storage model",
        },
        {
          elementId: "section-1",
          kind: "section",
          change: "added",
          summary: "Added section: Background",
        },
        {
          elementId: "task-1",
          kind: "task",
          change: "removed",
          summary: "Removed task: Build storage",
        },
      ],
      planStale: true,
    });
  });

  it("marks a requirement modified when one of its nested criteria changes", () => {
    const base = [
      element("requirement-1", "same", requirement("Stable identity")),
      element(
        "criterion-1",
        "criterion-old",
        criterion("IDs survive edits"),
        "requirement-1",
      ),
    ];
    const draft = [
      element("requirement-1", "same", requirement("Stable identity")),
      element(
        "criterion-1",
        "criterion-new",
        criterion("IDs survive every revision edit"),
        "requirement-1",
      ),
    ];

    const result = diffRevisions(base, draft);

    expect(result.classifications).toEqual([
      {
        elementId: "requirement-1",
        kind: "requirement",
        classification: "modified",
        directlyChanged: false,
      },
      {
        elementId: "criterion-1",
        kind: "criterion",
        classification: "modified",
        directlyChanged: true,
      },
    ]);
    expect(result.changeList).toEqual([
      {
        elementId: "requirement-1",
        kind: "requirement",
        change: "modified",
        summary: "Modified requirement criteria: Stable identity",
      },
      {
        elementId: "criterion-1",
        kind: "criterion",
        change: "modified",
        summary:
          "Modified acceptance criterion: IDs survive every revision edit",
      },
    ]);
  });

  it.each([
    {
      name: "adds a task",
      base: [],
      draft: [element("task-1", "task", task("Build storage"))],
    },
    {
      name: "removes a task",
      base: [element("task-1", "task", task("Build storage"))],
      draft: [],
    },
    {
      name: "changes traced requirements",
      base: [
        element(
          "task-1",
          "old",
          task("Build storage", { requirements: ["requirement-1"] }),
        ),
      ],
      draft: [
        element(
          "task-1",
          "new",
          task("Build storage", { requirements: ["requirement-2"] }),
        ),
      ],
    },
    {
      name: "changes covered criteria",
      base: [
        element(
          "task-1",
          "old",
          task("Build storage", { criteria: ["criterion-1"] }),
        ),
      ],
      draft: [
        element(
          "task-1",
          "new",
          task("Build storage", { criteria: ["criterion-2"] }),
        ),
      ],
    },
    {
      name: "changes task dependencies",
      base: [
        element("task-1", "old", task("Build storage", { dependencies: [] })),
      ],
      draft: [
        element(
          "task-1",
          "new",
          task("Build storage", { dependencies: ["task-0"] }),
        ),
      ],
    },
  ])("marks the plan stale when a change $name", ({ base, draft }) => {
    expect(diffRevisions(base, draft).planStale).toBe(true);
  });

  it("marks the plan stale for an instructions-only task payload edit", () => {
    const original = task("Build storage");
    const revised = {
      ...task("Build storage"),
      instructions: "Implement storage with durable fixtures.",
    };

    expect(
      diffRevisions(
        [element("task-1", "old", original)],
        [element("task-1", "new", revised)],
      ).planStale,
    ).toBe(true);
  });

  it("keeps cited elements unchanged when only their cited element changes", () => {
    const unchangedDecision = decision(
      "Storage model",
      "Satisfy requirement-1 with stable rows",
    );
    const result = diffRevisions(
      [
        element("requirement-1", "old", requirement("Stable identity")),
        element("decision-1", "same", unchangedDecision),
      ],
      [
        element(
          "requirement-1",
          "new",
          requirement("Stable identity across revisions"),
        ),
        element("decision-1", "same", unchangedDecision),
      ],
    );

    expect(result.classifications).toContainEqual({
      elementId: "decision-1",
      kind: "decision",
      classification: "unchanged",
      directlyChanged: false,
    });
    expect(result.changeList.map(({ elementId }) => elementId)).not.toContain(
      "decision-1",
    );
  });

  it("emits kind-aware semantic summaries for every element kind", () => {
    const base = [
      element("section-1", "old-section", {
        kind: "section",
        role: "context",
        title: "Context",
        body: "Old context.",
      }),
      element("requirement-1", "same", requirement("Stable identity")),
      element(
        "criterion-1",
        "old-criterion",
        criterion("IDs survive edits"),
        "requirement-1",
      ),
      element("decision-1", "old-decision", decision("Storage model")),
    ];
    const draft = [
      element("section-1", "new-section", {
        kind: "section",
        role: "context",
        title: "Context",
        body: "New context.",
      }),
      element("requirement-1", "same", requirement("Stable identity")),
      element("decision-1", "new-decision", decision("Storage model")),
      element("task-1", "new-task", task("Build storage")),
    ];

    expect(diffRevisions(base, draft).changeList).toEqual([
      {
        elementId: "section-1",
        kind: "section",
        change: "modified",
        summary: "Modified section: Context",
      },
      {
        elementId: "requirement-1",
        kind: "requirement",
        change: "modified",
        summary: "Modified requirement criteria: Stable identity",
      },
      {
        elementId: "decision-1",
        kind: "decision",
        change: "modified",
        summary: "Modified decision: Storage model",
      },
      {
        elementId: "task-1",
        kind: "task",
        change: "added",
        summary: "Added task: Build storage",
      },
      {
        elementId: "criterion-1",
        kind: "criterion",
        change: "removed",
        summary: "Removed acceptance criterion: IDs survive edits",
      },
    ]);
  });
});

describe("revision citation diff", () => {
  const rows = [
    element("requirement-1", "same-r1", requirement("Stable premise")),
    element("decision-1", "same-d1", decision("Premise ownership")),
  ];

  it("emits citation add and removal entries and marks their subjects modified", () => {
    const result = diffRevisions(rows, rows, {
      baseCitationContractVersion: 2,
      draftCitationContractVersion: 2,
      baseCitations: [citation("requirement-1", "assumption-1", 1)],
      draftCitations: [citation("decision-1", "assumption-2", 2)],
    });

    expect(result.classifications).toEqual([
      {
        elementId: "requirement-1",
        kind: "requirement",
        classification: "modified",
        directlyChanged: true,
      },
      {
        elementId: "decision-1",
        kind: "decision",
        classification: "modified",
        directlyChanged: true,
      },
    ]);
    expect(result.changeList).toEqual([
      {
        elementId: "decision-1",
        kind: "assumption_citation",
        assumptionId: "assumption-2",
        change: "citation_added",
        summary: "Added assumption A2 citation to decision-1.",
      },
      {
        elementId: "requirement-1",
        kind: "assumption_citation",
        assumptionId: "assumption-1",
        change: "citation_removed",
        summary: "Removed assumption A1 citation from requirement-1.",
      },
    ]);
  });

  it("represents a move as one deterministic remove plus add", () => {
    const premise = citation("requirement-1", "assumption-1", 1);
    const moved = { ...premise, elementId: "decision-1" };
    const result = diffRevisions(rows, rows, {
      baseCitationContractVersion: 2,
      draftCitationContractVersion: 2,
      baseCitations: [premise],
      draftCitations: [moved],
    });

    expect(
      result.changeList.map(({ change, elementId }) => [change, elementId]),
    ).toEqual([
      ["citation_added", "decision-1"],
      ["citation_removed", "requirement-1"],
    ]);
  });

  it("detects cited snapshot changes even when the element payload is unchanged", () => {
    const before = citation("requirement-1", "assumption-1", 1);
    const after = citation("requirement-1", "assumption-1", 1, {
      recordVersion: 2,
      text: "Corrected premise",
      disposition: "rejected",
      disposedAt: "2026-08-23T10:30:00.000Z",
      updatedAt: "2026-08-23T10:30:00.000Z",
    });

    expect(
      diffRevisions(rows, rows, {
        baseCitationContractVersion: 2,
        draftCitationContractVersion: 2,
        baseCitations: [before],
        draftCitations: [after],
      }).changeList,
    ).toEqual([
      {
        elementId: "requirement-1",
        kind: "assumption_citation",
        assumptionId: "assumption-1",
        change: "citation_snapshot_changed",
        summary:
          "Updated assumption A1 citation on requirement-1 (proposed → rejected).",
      },
    ]);
  });

  it("reports a citation contract boundary with no element changes", () => {
    expect(
      diffRevisions(rows, rows, {
        baseCitationContractVersion: 1,
        draftCitationContractVersion: 2,
        baseCitations: [],
        draftCitations: [],
      }).changeList,
    ).toEqual([
      {
        elementId: "revision",
        kind: "citation_contract",
        change: "citation_contract_changed",
        summary: "Changed assumption citation contract from 1 to 2.",
      },
    ]);
  });

  it("sorts citation changes without mutating either input", () => {
    const baseCitations = [
      citation("requirement-1", "assumption-2", 2),
      citation("decision-1", "assumption-1", 1),
    ];
    const draftCitations: RevisionCitation[] = [];
    const before = structuredClone(baseCitations);

    const result = diffRevisions(rows, rows, {
      baseCitationContractVersion: 2,
      draftCitationContractVersion: 2,
      baseCitations,
      draftCitations,
    });

    expect(
      result.changeList
        .filter((change) => change.kind === "assumption_citation")
        .map((change) => [change.elementId, change.assumptionId]),
    ).toEqual([
      ["decision-1", "assumption-1"],
      ["requirement-1", "assumption-2"],
    ]);
    expect(baseCitations).toEqual(before);
  });
});
