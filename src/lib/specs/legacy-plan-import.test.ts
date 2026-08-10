import { describe, expect, it } from "vitest";

import {
  importLegacyDeliveryPlan,
  LegacyDeliverySourceDamagedError,
  resolveLegacyDeliverySource,
} from "./legacy-plan-import";
import { LEGACY_UNMAPPED_CRITERION_NOTICE } from "./legacy-plan-render";
import { executionScopeSchema } from "./scope-validation";
import type {
  SpecElementPayload,
  SpecRevisionElement,
  SpecRevisionSnapshot,
} from "./schemas";

const SPEC_ID = "spec-legacy";
const REVISION_ID = "revision-legacy";
const AT = "2026-08-08T00:00:00.000Z";

function element(
  id: string,
  kind: SpecRevisionElement["element"]["kind"],
  number: number | null,
  parentElementId: string | null,
  position: number,
  payload: SpecElementPayload,
): SpecRevisionElement {
  return {
    element: {
      id,
      specId: SPEC_ID,
      kind,
      number,
      parentElementId,
      createdAt: AT,
    },
    version: {
      revisionId: REVISION_ID,
      elementId: id,
      position,
      payload,
      payloadHash: `hash-${id}`,
      elementVersion: 1,
      createdAt: AT,
      updatedAt: AT,
    },
  };
}

function criterion(id: string, number: number, position: number) {
  return element(id, "criterion", number, "req", position, {
    kind: "criterion",
    text: `Criterion ${id} holds.`,
    validationStrategy: { kinds: ["test_run"], note: `note ${id}` },
  });
}

interface TaskSpec {
  id: string;
  number: number;
  laneGroup?: string;
  dependsOn?: string[];
  covers?: string[];
  traced?: string[];
  decisions?: string[];
  touchedPaths?: string[];
}

function task(spec: TaskSpec, position: number): SpecRevisionElement {
  return element(spec.id, "task", spec.number, null, position, {
    kind: "task",
    title: `Task ${spec.id}`,
    instructions: `Do ${spec.id}.`,
    tracedRequirementElementIds: spec.traced ?? [],
    tracedDecisionElementIds: spec.decisions ?? [],
    coveredCriterionElementIds: spec.covers ?? [],
    dependsOnTaskElementIds: spec.dependsOn ?? [],
    ...(spec.laneGroup === undefined ? {} : { laneGroup: spec.laneGroup }),
    ...(spec.touchedPaths === undefined
      ? {}
      : { touchedPaths: spec.touchedPaths }),
  });
}

function snapshotOf(
  criterionIds: readonly { id: string; number: number }[],
  tasks: readonly TaskSpec[],
  extra: readonly SpecRevisionElement[] = [],
): SpecRevisionSnapshot {
  let position = 0;
  return {
    revision: {
      id: REVISION_ID,
      specId: SPEC_ID,
      number: 3,
      state: "approved",
      authoringStage: "plan",
      basedOnRevisionId: null,
      contentHash: "sha256:legacy",
      proposedAt: AT,
      approvedAt: AT,
      createdAt: AT,
    },
    elements: [
      element("req", "requirement", 1, null, position++, {
        kind: "requirement",
        statement: "The system delivers.",
        priority: "must",
        risk: "medium",
      }),
      ...criterionIds.map((entry) =>
        criterion(entry.id, entry.number, position++),
      ),
      ...extra,
      ...tasks.map((entry) => task(entry, position++)),
    ],
  };
}

function scopeOf(taskIds: readonly string[], criterionIds: readonly string[]) {
  return executionScopeSchema.parse({
    selectedTaskIds: [...taskIds],
    selectedCriterionIds: [...criterionIds],
    exclusionDispositions: [],
  });
}

function importOf(
  snapshot: SpecRevisionSnapshot,
  scope: ReturnType<typeof scopeOf>,
) {
  return importLegacyDeliveryPlan({
    specSlug: "demo",
    specName: "Demo spec",
    sourceExecutionId: "execution-legacy",
    snapshot,
    scope,
  });
}

describe("importLegacyDeliveryPlan", () => {
  it("turns each laneGroup into one context whose members are ordered by the intra-group topology", () => {
    // T1 depends on T2 inside the lane, so topology — not the handle order —
    // decides which runs first.
    const snapshot = snapshotOf(
      [
        { id: "c1", number: 1 },
        { id: "c2", number: 2 },
      ],
      [
        {
          id: "t-one",
          number: 1,
          laneGroup: "backend",
          dependsOn: ["t-two"],
          covers: ["c1"],
        },
        { id: "t-two", number: 2, laneGroup: "backend", covers: ["c2"] },
      ],
    );

    const result = importOf(
      snapshot,
      scopeOf(["t-one", "t-two"], ["c1", "c2"]),
    );

    expect(result.document.contexts).toHaveLength(1);
    const context = result.document.contexts[0]!;
    expect(context.contextId).toBe("lane-backend");
    expect(context.contextType).toBe("delivery");
    expect(context.criterionElementIds).toEqual(["c2", "c1"]);
    expect(
      result.document.tasks.map((entry) => [entry.taskId, entry.order]),
    ).toEqual([
      ["t2", 0],
      ["t1", 1],
    ]);
    expect(
      result.document.tasks.every(
        (entry) => entry.contextId === "lane-backend",
      ),
    ).toBe(true);
  });

  it("gives every ungrouped task its own singleton context and collapses dependencies to one edge per context pair", () => {
    const snapshot = snapshotOf(
      [
        { id: "c1", number: 1 },
        { id: "c2", number: 2 },
        { id: "c3", number: 3 },
        { id: "c4", number: 4 },
      ],
      [
        { id: "t-a", number: 1, laneGroup: "backend", covers: ["c1"] },
        {
          id: "t-b",
          number: 2,
          laneGroup: "backend",
          dependsOn: ["t-a"],
          covers: ["c2"],
        },
        { id: "t-c", number: 3, dependsOn: ["t-a"], covers: ["c3"] },
        // Two dependencies reaching into the same lane must produce ONE edge.
        {
          id: "t-d",
          number: 4,
          dependsOn: ["t-a", "t-b", "t-c"],
          covers: ["c4"],
        },
      ],
    );

    const result = importOf(
      snapshot,
      scopeOf(["t-a", "t-b", "t-c", "t-d"], ["c1", "c2", "c3", "c4"]),
    );

    expect(
      result.document.contexts.map((entry) => entry.contextId).sort(),
    ).toEqual(["lane-backend", "t3", "t4"]);
    expect(
      result.document.edges
        .map((edge) => `${edge.fromContextId}->${edge.toContextId}`)
        .sort(),
    ).toEqual(["lane-backend->t3", "lane-backend->t4", "t3->t4"]);
    expect(new Set(result.document.edges.map((edge) => edge.edgeId)).size).toBe(
      3,
    );
  });

  it("binds covered criteria to the owning context and annotates the task that covered them", () => {
    const snapshot = snapshotOf(
      [
        { id: "c1", number: 1 },
        { id: "c2", number: 2 },
      ],
      [{ id: "t-a", number: 1, covers: ["c1", "c2"] }],
    );

    const result = importOf(snapshot, scopeOf(["t-a"], ["c1", "c2"]));

    const context = result.document.contexts[0]!;
    expect(context.criterionElementIds).toEqual(["c1", "c2"]);
    expect(context.proofPlan.map((step) => step.criterionElementId)).toEqual([
      "c1",
      "c2",
    ]);
    expect(result.document.tasks[0]!.contributesToCriterionElementIds).toEqual([
      "c1",
      "c2",
    ]);
    expect(result.requiresHumanSplit).toEqual([]);
  });

  it("never duplicates a criterion covered across contexts: it lands on the split list, owned by neither", () => {
    const snapshot = snapshotOf(
      [
        { id: "c1", number: 1 },
        { id: "c2", number: 2 },
      ],
      [
        { id: "t-a", number: 1, covers: ["c1", "c2"] },
        { id: "t-b", number: 2, covers: ["c2"] },
      ],
    );

    const result = importOf(snapshot, scopeOf(["t-a", "t-b"], ["c1", "c2"]));

    const owners = result.document.contexts.flatMap(
      (context) => context.criterionElementIds,
    );
    expect(owners).toEqual(["c1"]);
    expect(result.requiresHumanSplit).toEqual([
      {
        criterionElementId: "c2",
        handle: "demo/R1.2",
        contextIds: ["t1", "t2"],
        // t1 still owns c1, so the remedy must not tell the author to re-type
        // it as an integration context — that would strand the work it owns.
        resolution:
          "Split demo/R1.2 into one criterion per context, or give one of t1, t2 sole ownership and type t2 as integration contexts if left owning nothing, then re-run `cctl spec plan edit demo --file <plan.json>`.",
      },
    ]);
    // Provenance survives on both tasks even though ownership does not.
    expect(
      result.document.tasks.map(
        (entry) => entry.contributesToCriterionElementIds,
      ),
    ).toEqual([["c1", "c2"], ["c2"]]);
  });

  it("types a context that owns no criterion as integration and leaves its contract for the author", () => {
    const snapshot = snapshotOf(
      [{ id: "c1", number: 1 }],
      [
        { id: "t-a", number: 1, covers: ["c1"] },
        { id: "t-b", number: 2, dependsOn: ["t-a"] },
      ],
    );

    const result = importOf(snapshot, scopeOf(["t-a", "t-b"], ["c1"]));

    const prerequisite = result.document.contexts.find(
      (context) => context.contextId === "t2",
    );
    expect(prerequisite?.contextType).toBe("integration");
    expect(prerequisite?.criterionElementIds).toEqual([]);
    // Authoring a contract here would manufacture the one thing a validator is
    // held to, so lint asks the human instead.
    expect(prerequisite?.acceptanceContract).toEqual([]);
  });

  it("carries the approved narrow context pack into task instructions without the compiler's prerequisite apology", () => {
    const decision = element("dec", "decision", 1, null, 900, {
      kind: "decision",
      title: "Use the importer",
      chosenApproach: "Map lanes to contexts.",
      rejectedAlternatives: [],
      reason: "The graph vocabulary is the plan.",
      tracedRequirementElementIds: ["req"],
    });
    const snapshot = snapshotOf(
      [{ id: "c1", number: 1 }],
      [
        {
          id: "t-a",
          number: 1,
          covers: ["c1"],
          traced: ["req"],
          decisions: ["dec"],
        },
        { id: "t-b", number: 2, dependsOn: ["t-a"] },
      ],
      [decision],
    );

    const result = importOf(snapshot, scopeOf(["t-a", "t-b"], ["c1"]));

    const covered = result.document.tasks.find(
      (entry) => entry.taskId === "t1",
    );
    expect(covered?.instructions).toContain("Approved task demo/T1");
    expect(covered?.instructions).toContain("- demo/R1: The system delivers.");
    expect(covered?.instructions).toContain("- demo/D1: Use the importer");
    expect(covered?.instructions).toContain("- demo/R1.1: Criterion c1 holds.");

    const prerequisite = result.document.tasks.find(
      (entry) => entry.taskId === "t2",
    );
    expect(prerequisite?.instructions).not.toContain(
      LEGACY_UNMAPPED_CRITERION_NOTICE,
    );
    expect(prerequisite?.instructions).toContain(
      "Acceptance criteria and required validation:",
    );
  });

  it("authors the governance the legacy charter carried and the surfaces the plan touched", () => {
    const snapshot = snapshotOf(
      [{ id: "c1", number: 1 }],
      [
        {
          id: "t-a",
          number: 1,
          covers: ["c1"],
          touchedPaths: ["src/a.ts", "src/b.ts"],
        },
      ],
      [
        element("sec-out", "section", null, null, 800, {
          kind: "section",
          role: "intent_outcomes",
          title: "Outcomes",
          body: "The importer lands.",
        }),
        element("sec-con", "section", null, null, 801, {
          kind: "section",
          role: "intent_constraints",
          title: "Constraints",
          body: "Never duplicate a criterion.",
        }),
      ],
    );

    const result = importOf(snapshot, scopeOf(["t-a"], ["c1"]));

    expect(result.document.governance.mission).toContain(
      "Demo spec revision 3",
    );
    expect(result.document.governance.mission).toContain("The importer lands.");
    expect(result.document.governance.charterInvariants).toEqual([
      {
        id: "spec-constraint-sec-con",
        statement: "Never duplicate a criterion.",
      },
    ]);
    expect(result.document.governance.sourcesOfTruth).toHaveLength(1);
    expect(result.document.governance.sourcesOfTruth[0]?.rank).toBe(1);
    expect(result.document.governance.validationCommandNames).toEqual([]);
    expect(result.document.touchedSurfaces).toEqual(["src/a.ts", "src/b.ts"]);
    // Dispositions are the seed's job: the disposition law is computed against
    // the delivery delta, not against a legacy execution scope.
    expect(result.document.dispositions).toEqual([]);
  });

  it("ignores tasks and criteria the legacy scope never selected", () => {
    const snapshot = snapshotOf(
      [
        { id: "c1", number: 1 },
        { id: "c2", number: 2 },
      ],
      [
        { id: "t-a", number: 1, covers: ["c1", "c2"] },
        { id: "t-b", number: 2, covers: ["c2"] },
      ],
    );

    const result = importOf(snapshot, scopeOf(["t-a"], ["c1"]));

    expect(result.document.contexts.map((entry) => entry.contextId)).toEqual([
      "t1",
    ]);
    expect(result.document.contexts[0]?.criterionElementIds).toEqual(["c1"]);
    expect(result.document.tasks[0]?.contributesToCriterionElementIds).toEqual([
      "c1",
    ]);
  });

  it("keeps lane names that agree past the node-id cap in separate contexts, with every edge", () => {
    // `laneGroup` is unbounded free text in an approved revision and a node id
    // caps at 120 characters, so two real lanes can agree well past the cap.
    const shared = `backend-${"segment-".repeat(20)}`;
    const snapshot = snapshotOf(
      [
        { id: "c1", number: 1 },
        { id: "c2", number: 2 },
        { id: "c3", number: 3 },
      ],
      [
        { id: "t-a", number: 1, laneGroup: `${shared}alpha`, covers: ["c1"] },
        { id: "t-b", number: 2, laneGroup: `${shared}beta`, covers: ["c2"] },
        {
          id: "t-c",
          number: 3,
          laneGroup: "closeout",
          dependsOn: ["t-a", "t-b"],
          covers: ["c3"],
        },
      ],
    );

    const result = importOf(
      snapshot,
      scopeOf(["t-a", "t-b", "t-c"], ["c1", "c2", "c3"]),
    );

    const contextIds = result.document.contexts.map(
      (context) => context.contextId,
    );
    expect(new Set(contextIds).size).toBe(3);
    expect(contextIds.every((id) => id.length <= 120)).toBe(true);
    // Both long lanes still reach the closeout lane. Deduplicating edges on a
    // truncated id would have kept only one of these two.
    const intoCloseout = result.document.edges.filter(
      (edge) => edge.toContextId === "lane-closeout",
    );
    expect(intoCloseout).toHaveLength(2);
    expect(new Set(intoCloseout.map((edge) => edge.fromContextId)).size).toBe(
      2,
    );
    expect(new Set(result.document.edges.map((edge) => edge.edgeId)).size).toBe(
      result.document.edges.length,
    );
  });
});

describe("resolveLegacyDeliverySource", () => {
  const execution = (scopeJson: string, revisionId = REVISION_ID) => ({
    id: "execution-legacy",
    spec_id: SPEC_ID,
    revision_id: revisionId,
    scope_json: scopeJson,
    state: "delivered" as const,
    execution_start_dial: null,
    workflow_definition_id: "definition-1",
    workflow_definition_revision: 1,
    workflow_execution_id: null,
    session_name: null,
    delivered_at: AT,
    abandoned_reason: null,
    // A delivered run never entered the abandon coordinator, so it carries no
    // cleanup residue.
    cleanup_phase: null,
    linked_workflow_execution_id: null,
    cleanup_last_error: null,
    cleanup_last_error_at: null,
    created_at: AT,
    updated_at: AT,
  });

  const validScope = JSON.stringify({
    selectedTaskIds: ["t-a"],
    selectedCriterionIds: ["c1"],
    exclusionDispositions: [],
  });

  const approved = snapshotOf(
    [{ id: "c1", number: 1 }],
    [{ id: "t-a", number: 1, covers: ["c1"] }],
  );

  it("reads a healthy legacy source", async () => {
    const source = await resolveLegacyDeliverySource(
      [execution(validScope)],
      async () => approved,
    );

    expect(source?.executionId).toBe("execution-legacy");
    expect(source?.scope.selectedTaskIds).toEqual(["t-a"]);
  });

  it("reports no source when there is nothing approved to import", async () => {
    expect(
      await resolveLegacyDeliverySource([], async () => approved),
    ).toBeNull();
    // A pin that no longer reads as approved is absence, not damage: a plan
    // cannot be lifted out of text nobody approved.
    const unapproved = await resolveLegacyDeliverySource(
      [execution(validScope)],
      async () => ({
        ...approved,
        revision: { ...approved.revision, state: "draft" as const },
      }),
    );
    expect(unapproved).toBeNull();
  });

  it("fails closed on a damaged source rather than reporting it as absent", async () => {
    // A missing revision, unparseable scope, and schema-invalid scope are all
    // damage. Returning null for any of them would seed an empty document and
    // present it to the author as a fresh plan.
    await expect(
      resolveLegacyDeliverySource([execution(validScope)], async () => null),
    ).rejects.toThrow(LegacyDeliverySourceDamagedError);

    await expect(
      resolveLegacyDeliverySource(
        [execution("{not json")],
        async () => approved,
      ),
    ).rejects.toThrow(LegacyDeliverySourceDamagedError);

    await expect(
      resolveLegacyDeliverySource(
        [execution(JSON.stringify({ selectedTaskIds: "all" }))],
        async () => approved,
      ),
    ).rejects.toThrow(LegacyDeliverySourceDamagedError);
  });

  it("names the execution and revision it could not read", async () => {
    const failure = await resolveLegacyDeliverySource(
      [execution("{not json")],
      async () => approved,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LegacyDeliverySourceDamagedError);
    const damaged = failure as LegacyDeliverySourceDamagedError;
    expect(damaged.executionId).toBe("execution-legacy");
    expect(damaged.revisionId).toBe(REVISION_ID);
    expect(damaged.problem).toContain("not valid JSON");
  });
});
