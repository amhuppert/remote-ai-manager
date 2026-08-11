import { describe, expect, it } from "vitest";

import { compileSpecExecutionPlan } from "./compiler";
import {
  PLAN_PREVIEW_BRIEF_LIMIT,
  boundSpecPlanPreview,
  buildSpecPlanPreview,
  resolveEvidenceProducers,
} from "./plan-preview";
import type { SpecRevisionSnapshot } from "./schemas";
import type { ExecutionScope } from "./scope-validation";

const timestamp = "2026-08-07T12:00:00.000Z";

const spec = {
  id: "spec-native-sdd",
  slug: "native-sdd",
  name: "Native SDD",
} as const;

function revisionElement(
  id: string,
  kind: SpecRevisionSnapshot["elements"][number]["element"]["kind"],
  number: number | null,
  parentElementId: string | null,
  position: number,
  payload: SpecRevisionSnapshot["elements"][number]["version"]["payload"],
): SpecRevisionSnapshot["elements"][number] {
  return {
    element: {
      id,
      specId: spec.id,
      kind,
      number,
      parentElementId,
      createdAt: timestamp,
    },
    version: {
      revisionId: "revision-4",
      elementId: id,
      position,
      payload,
      payloadHash: `hash-${id}`,
      elementVersion: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

function snapshotIn(
  state: SpecRevisionSnapshot["revision"]["state"],
): SpecRevisionSnapshot {
  return {
    revision: {
      id: "revision-4",
      specId: spec.id,
      number: 4,
      state,
      authoringStage: "plan",
      basedOnRevisionId: "revision-3",
      contentHash: "content-hash-4",
      proposedAt: timestamp,
      approvedAt: state === "approved" ? timestamp : null,
      externalDelivery: null,
      createdAt: timestamp,
    },
    elements: [
      revisionElement("requirement-1", "requirement", 1, null, 0, {
        kind: "requirement",
        statement: "Preview the compiled plan before launching it.",
        priority: "must",
        risk: "high",
      }),
      revisionElement("criterion-1", "criterion", 1, "requirement-1", 1, {
        kind: "criterion",
        text: "Preview renders exactly what the compiler would produce.",
        validationStrategy: {
          kinds: ["test_run", "validator_verdict"],
          note: "Parity test against the compiler output.",
        },
      }),
      revisionElement("criterion-2", "criterion", 2, "requirement-1", 2, {
        kind: "criterion",
        text: "The preview names each criterion's evidence producer.",
        validationStrategy: {
          kinds: ["commit", "validator_verdict"],
          note: "Inspect the resolved producer rows.",
        },
      }),
      revisionElement("task-1", "task", 1, null, 3, {
        kind: "task",
        title: "Build the preview projection",
        instructions: "Materialize the compiled plan without launching it.",
        tracedRequirementElementIds: ["requirement-1"],
        tracedDecisionElementIds: [],
        coveredCriterionElementIds: ["criterion-1"],
        dependsOnTaskElementIds: [],
      }),
      revisionElement("task-2", "task", 2, null, 4, {
        kind: "task",
        title: "Render the preview",
        instructions: "Render the bounded preview sections.",
        tracedRequirementElementIds: ["requirement-1"],
        tracedDecisionElementIds: [],
        coveredCriterionElementIds: ["criterion-2"],
        dependsOnTaskElementIds: ["task-1"],
      }),
    ],
  };
}

const scope: ExecutionScope = {
  selectedTaskIds: ["task-1", "task-2"],
  selectedCriterionIds: ["criterion-1", "criterion-2"],
  exclusionDispositions: [],
};

const previewInput = {
  spec,
  scope,
  scopeHash: "scope-hash-preview",
  approvalRequired: true,
} as const;

describe("buildSpecPlanPreview", () => {
  it("renders exactly what compileSpecExecutionPlan produces for an approved revision", () => {
    const revisionSnapshot = snapshotIn("approved");
    const preview = buildSpecPlanPreview({ ...previewInput, revisionSnapshot });

    expect(preview.definition).toEqual(
      compileSpecExecutionPlan({ ...previewInput, revisionSnapshot }),
    );
  });

  it("decomposes each compiled context into the briefs the compiler assembled", () => {
    const preview = buildSpecPlanPreview({
      ...previewInput,
      revisionSnapshot: snapshotIn("approved"),
    });

    const contextOne = preview.contexts.find(
      (context) => context.contextId === "context-task-1",
    );
    expect(contextOne?.taskHandles).toEqual(["native-sdd/T1"]);
    expect(contextOne?.criterionBriefs.map((brief) => brief.criterionHandle)) //
      .toEqual(["native-sdd/R1.1"]);
    expect(contextOne?.criterionBriefs[0]?.text).toBe(
      "Preview renders exactly what the compiler would produce.",
    );
    // The assembled context contract is the union of its task briefs; every
    // brief the preview lists has to appear verbatim inside it.
    for (const brief of contextOne?.criterionBriefs ?? []) {
      expect(contextOne?.acceptanceCriteria).toContain(brief.brief);
    }
  });

  it("previews a proposed plan-stage revision the compiler itself refuses", () => {
    const revisionSnapshot = snapshotIn("proposed");
    expect(() =>
      compileSpecExecutionPlan({ ...previewInput, revisionSnapshot }),
    ).toThrow(/not approved/);

    const preview = buildSpecPlanPreview({ ...previewInput, revisionSnapshot });
    expect(preview.revision.state).toBe("proposed");
    expect(preview.definition.executionContexts.map(({ id }) => id)).toEqual([
      "context-task-1",
      "context-task-2",
    ]);
  });

  it("previews a draft plan-stage revision", () => {
    const preview = buildSpecPlanPreview({
      ...previewInput,
      revisionSnapshot: snapshotIn("draft"),
    });
    expect(preview.revision.state).toBe("draft");
    expect(preview.contexts).toHaveLength(2);
  });

  it("resolves every selected criterion's strategy kinds to their real producer", () => {
    const preview = buildSpecPlanPreview({
      ...previewInput,
      revisionSnapshot: snapshotIn("approved"),
    });
    const briefs = preview.contexts.flatMap(
      (context) => context.criterionBriefs,
    );

    const parity = briefs.find(
      (brief) => brief.criterionElementId === "criterion-1",
    );
    expect(parity?.evidence.map(({ kind }) => kind)).toEqual([
      "test_run",
      "validator_verdict",
    ]);
    const testRun = parity?.evidence.find(({ kind }) => kind === "test_run");
    expect(testRun?.producer).toBe("graph-workflow-validation-result");
    expect(testRun?.detail).toContain("same validation event");

    const producers = briefs.find(
      (brief) => brief.criterionElementId === "criterion-2",
    );
    expect(
      producers?.evidence.find(({ kind }) => kind === "commit")?.producer,
    ).toBe("graph-workflow-lane-commit");
    expect(preview.evidenceGaps).toEqual([]);
  });
});

describe("resolveEvidenceProducers", () => {
  // evidence-ingest.ts pushes a validator_verdict row for EVERY validation
  // result reaching the ingest loop; only proof creation additionally demands
  // a passing, sealed context validation. A preview claiming the verdict is
  // minted solely by a passing run would have a planner expect no evidence
  // from the failing runs that do in fact write rows.
  it("separates verdict evidence from admissible proof", () => {
    const [verdict] = resolveEvidenceProducers(["validator_verdict"]);
    expect(verdict?.producer).toBe("graph-workflow-validation-result");
    expect(verdict?.detail).toContain("failing or superseded");
    expect(verdict?.detail).toContain("proof");
    expect(verdict?.detail).not.toMatch(/^the context's passing validation/);
  });

  it("names a strategy kind that nothing produces as a gap", () => {
    const rows = resolveEvidenceProducers(["screenshot", "validator_verdict"]);
    const gap = rows.find(({ kind }) => kind === "screenshot");
    expect(gap?.producer).toBeNull();
    expect(gap?.detail).toContain("no evidence producer");
    expect(
      rows.find(({ kind }) => kind === "validator_verdict")?.producer,
    ).toBe("graph-workflow-validation-result");
  });
});

describe("boundSpecPlanPreview", () => {
  const wide = wideSnapshot();
  const widePreview = buildSpecPlanPreview({
    spec,
    revisionSnapshot: wide.snapshot,
    scope: wide.scope,
    scopeHash: "scope-hash-wide",
    approvalRequired: false,
  });

  // The bound is stated as a literal, not as PLAN_PREVIEW_BRIEF_LIMIT: the
  // criterion fixes the section at twenty briefs, so an assertion phrased in
  // terms of the constant would follow the constant anywhere it moved.
  it("caps each context section at twenty briefs and reports the omission", () => {
    const bounded = boundSpecPlanPreview(widePreview, {});
    expect(bounded.ok).toBe(true);
    if (!bounded.ok) return;
    expect(PLAN_PREVIEW_BRIEF_LIMIT).toBe(20);
    expect(bounded.value.briefLimit).toBe(20);
    const section = bounded.value.contexts.find(
      (context) => context.contextId === "context-task-wide",
    );
    expect(section?.totalBriefCount).toBe(25);
    expect(section?.shownBriefCount).toBe(20);
    expect(section?.omittedBriefCount).toBe(5);
    expect(section?.criterionBriefs).toHaveLength(20);
  });

  // The fixture's compiled order is the reverse of its context-id order, so a
  // preview that merely passed the compiler's own ordering through would fail
  // here rather than coincidentally agreeing.
  it("orders sections by context id so repeated previews read identically", () => {
    const bounded = boundSpecPlanPreview(widePreview, {});
    if (!bounded.ok) throw new Error("expected a bounded preview");
    expect(
      widePreview.definition.executionContexts.map(({ id }) => id),
    ).toEqual(["context-task-wide", "context-task-alpha"]);
    expect(bounded.value.contexts.map(({ contextId }) => contextId)).toEqual([
      "context-task-alpha",
      "context-task-wide",
    ]);
  });

  // AC1 pins this field to the compiler's bytes, so the bound deliberately
  // governs the enumerated brief list and not the contract string; a reader
  // who needs the omitted briefs reads them here or via --context.
  it("keeps the context contract verbatim even where the brief list is bound", () => {
    const bounded = boundSpecPlanPreview(widePreview, {});
    if (!bounded.ok) throw new Error("expected a bounded preview");
    const section = bounded.value.contexts.find(
      (context) => context.contextId === "context-task-wide",
    );
    const compiled = widePreview.contexts.find(
      (context) => context.contextId === "context-task-wide",
    );
    expect(section?.acceptanceCriteria).toBe(compiled?.acceptanceCriteria);
    expect(section?.shownBriefCount).toBe(20);
  });

  it("prints one context's complete section under --context", () => {
    const bounded = boundSpecPlanPreview(widePreview, {
      contextId: "context-task-wide",
    });
    if (!bounded.ok) throw new Error("expected a bounded preview");
    expect(bounded.value.contexts).toHaveLength(1);
    const [section] = bounded.value.contexts;
    expect(section?.shownBriefCount).toBe(25);
    expect(section?.omittedBriefCount).toBe(0);
  });

  it("refuses an unknown context id and names the ids it could have printed", () => {
    const bounded = boundSpecPlanPreview(widePreview, {
      contextId: "context-nope",
    });
    expect(bounded.ok).toBe(false);
    if (bounded.ok) return;
    expect(bounded.knownContextIds).toContain("context-task-wide");
  });
});

/**
 * One context owning more criteria than the section bound, so the omission
 * counters have something to report, plus a second task whose context id sorts
 * BEFORE it while compiling AFTER it — the disagreement is what lets the
 * ordering assertion distinguish context-id order from the compiler's own.
 */
function wideSnapshot(): {
  snapshot: SpecRevisionSnapshot;
  scope: ExecutionScope;
} {
  const criterionIds = Array.from(
    { length: 25 },
    (_unused, index) => `wide-criterion-${index + 1}`,
  );
  const elements: SpecRevisionSnapshot["elements"] = [
    revisionElement("wide-requirement", "requirement", 1, null, 0, {
      kind: "requirement",
      statement: "A context can own many criteria.",
      priority: "must",
      risk: "low",
    }),
    ...criterionIds.map((id, index) =>
      revisionElement(
        id,
        "criterion",
        index + 1,
        "wide-requirement",
        index + 1,
        {
          kind: "criterion",
          text: `Criterion ${index + 1} holds.`,
          validationStrategy: { kinds: ["validator_verdict"] },
        },
      ),
    ),
    revisionElement("task-wide", "task", 1, null, 26, {
      kind: "task",
      title: "Own every criterion",
      instructions: "Prove all of them in one context.",
      tracedRequirementElementIds: ["wide-requirement"],
      tracedDecisionElementIds: [],
      coveredCriterionElementIds: criterionIds,
      dependsOnTaskElementIds: [],
    }),
    revisionElement(
      "alpha-criterion",
      "criterion",
      26,
      "wide-requirement",
      27,
      {
        kind: "criterion",
        text: "A second context also compiles.",
        validationStrategy: { kinds: ["validator_verdict"] },
      },
    ),
    revisionElement("task-alpha", "task", 2, null, 28, {
      kind: "task",
      title: "Sort before the wide context",
      instructions: "Exist so the preview has two sections to order.",
      tracedRequirementElementIds: ["wide-requirement"],
      tracedDecisionElementIds: [],
      coveredCriterionElementIds: ["alpha-criterion"],
      dependsOnTaskElementIds: [],
    }),
  ];
  return {
    snapshot: {
      revision: {
        id: "revision-wide",
        specId: spec.id,
        number: 1,
        state: "approved",
        authoringStage: "plan",
        basedOnRevisionId: null,
        contentHash: "content-hash-wide",
        proposedAt: timestamp,
        approvedAt: timestamp,
        externalDelivery: null,
        createdAt: timestamp,
      },
      elements,
    },
    scope: {
      selectedTaskIds: ["task-wide", "task-alpha"],
      selectedCriterionIds: [...criterionIds, "alpha-criterion"],
      exclusionDispositions: [],
    },
  };
}
