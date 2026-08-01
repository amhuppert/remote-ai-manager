import { describe, expect, it } from "vitest";
import { workflowSemanticDefinitionSchema } from "@/lib/workflow-graph/definition-schemas";
import { applyDefinitionEdits } from "@/lib/workflow-graph/definition-edits";
import { validateWorkflowDefinition } from "@/lib/workflow-graph/validation";
import type { SpecRevisionSnapshot } from "./schemas";
import type { ExecutionScope } from "./scope-validation";
import {
  compileSpecExecutionPlan,
  readCompiledContextContract,
  readCompiledOriginMap,
} from "./compiler";

const timestamp = "2026-07-18T12:00:00.000Z";

const snapshot: SpecRevisionSnapshot = {
  revision: {
    id: "revision-7",
    specId: "spec-native-sdd",
    number: 7,
    state: "approved",
    authoringStage: "plan",
    basedOnRevisionId: "revision-6",
    contentHash: "approved-content-hash",
    proposedAt: timestamp,
    approvedAt: timestamp,
    createdAt: timestamp,
  },
  elements: [
    revisionElement("requirement-1", "requirement", 1, null, 0, {
      kind: "requirement",
      statement: "Compile the approved delivery contract.",
      priority: "must",
      risk: "high",
    }),
    revisionElement("criterion-1", "criterion", 1, "requirement-1", 1, {
      kind: "criterion",
      text: "The compiler emits a valid graph workflow definition.",
      validationStrategy: {
        kinds: ["test_run", "validator_verdict"],
        note: "Run the compiler contract test and inspect every provenance lock.",
      },
    }),
    revisionElement("criterion-2", "criterion", 2, "requirement-1", 2, {
      kind: "criterion",
      text: "Dependent work starts after its prerequisite.",
      validationStrategy: {
        kinds: ["validator_verdict"],
        note: "Inspect the compiled dependency edge.",
      },
    }),
    revisionElement("requirement-2", "requirement", 2, null, 3, {
      kind: "requirement",
      statement: "Keep unrelated work out of each lane context pack.",
      priority: "should",
      risk: "low",
    }),
    revisionElement("criterion-3", "criterion", 1, "requirement-2", 4, {
      kind: "criterion",
      text: "Unselected work is absent from lane briefs.",
      validationStrategy: { kinds: ["validator_verdict"] },
    }),
    revisionElement("task-1", "task", 1, null, 5, {
      kind: "task",
      title: "Compile the contract",
      instructions: "Implement the pure compiler.",
      tracedRequirementElementIds: ["requirement-1"],
      tracedDecisionElementIds: [],
      coveredCriterionElementIds: ["criterion-1"],
      dependsOnTaskElementIds: [],
    }),
    revisionElement("task-2", "task", 2, null, 6, {
      kind: "task",
      title: "Verify dependency provenance",
      instructions: "Verify the compiled dependency and strategy brief.",
      tracedRequirementElementIds: ["requirement-1"],
      tracedDecisionElementIds: [],
      coveredCriterionElementIds: ["criterion-2"],
      dependsOnTaskElementIds: ["task-1"],
    }),
  ],
};

const scope: ExecutionScope = {
  selectedTaskIds: ["task-1", "task-2"],
  selectedCriterionIds: ["criterion-1", "criterion-2"],
  exclusionDispositions: [
    { criterionId: "criterion-3", disposition: "deferred" },
  ],
};

describe("compileSpecExecutionPlan", () => {
  it("17.1 compiles the approved scoped plan into a valid standard workflow", () => {
    const definition = compileSpecExecutionPlan({
      spec: {
        id: "spec-native-sdd",
        slug: "native-sdd",
        name: "Native SDD",
      },
      revisionSnapshot: snapshot,
      scope,
      scopeHash: "scope-hash-1",
      approvalRequired: true,
    });

    expect(workflowSemanticDefinitionSchema.safeParse(definition).success).toBe(
      true,
    );
    expect(validateWorkflowDefinition(definition)).toEqual({
      ok: true,
      errors: [],
    });
    expect(definition.origin?.sourceUri).toBe(
      "spec-execution://spec-native-sdd/revisions/revision-7?scope=scope-hash-1",
    );
    expect(definition.executionContexts.map(({ id }) => id)).toEqual([
      "context-task-1",
      "context-task-2",
    ]);
    expect(definition.executionContexts.map(({ title }) => title)).toEqual([
      "T1 — Compile the contract",
      "T2 — Verify dependency provenance",
    ]);
    expect(
      definition.tasks.map(({ id, contextId, order }) => ({
        id,
        contextId,
        order,
      })),
    ).toEqual([
      {
        id: "spec-task-task-1",
        contextId: "context-task-1",
        order: 1,
      },
      {
        id: "spec-task-task-2",
        contextId: "context-task-2",
        order: 1,
      },
    ]);
    expect(definition.edges).toEqual([
      {
        id: "edge-task-1-task-2",
        sourceContextId: "context-task-1",
        targetContextId: "context-task-2",
      },
    ]);
    expect(
      readCompiledContextContract(definition, "context-task-1")
        .acceptanceCriteria,
    ).toContain("native-sdd/R1.1");
    expect(
      readCompiledContextContract(definition, "context-task-1")
        .acceptanceCriteria,
    ).toContain(
      "Run the compiler contract test and inspect every provenance lock.",
    );
    expect(definition.tasks[0]?.instructions).toContain(
      "Compile the approved delivery contract.",
    );
    expect(definition.tasks[0]?.instructions).not.toContain(
      "Keep unrelated work out of each lane context pack.",
    );
    expect(definition.tasks[0]?.instructions).not.toContain(
      "Approved decisions:",
    );
    expect(definition.tasks[0]?.metadata).not.toHaveProperty(
      "specTouchedPaths",
    );
  });

  it("23.2 compiles a lane group into one content-derived context with ordered tasks and union criteria", () => {
    const groupedSnapshot = structuredClone(snapshot);
    setTaskPayload(groupedSnapshot, "task-1", { laneGroup: "compiler" });
    setTaskPayload(groupedSnapshot, "task-2", { laneGroup: "compiler" });

    const definition = compileSpecExecutionPlan({
      spec: {
        id: "spec-native-sdd",
        slug: "native-sdd",
        name: "Native SDD",
      },
      revisionSnapshot: groupedSnapshot,
      scope,
      scopeHash: "scope-hash-1",
      approvalRequired: true,
    });

    expect(definition.executionContexts).toHaveLength(1);
    expect(definition.executionContexts[0]).toMatchObject({
      id: "context-lane-compiler",
      title: "compiler — T1, T2",
      description:
        "Lane group compiler: T1 — Compile the contract; T2 — Verify dependency provenance.",
      acceptanceCriteria: expect.stringContaining("native-sdd/R1.1"),
    });
    expect(definition.executionContexts[0]?.acceptanceCriteria).toContain(
      "native-sdd/R1.2",
    );
    expect(
      definition.tasks.map(({ id, contextId, order }) => ({
        id,
        contextId,
        order,
      })),
    ).toEqual([
      {
        id: "spec-task-task-1",
        contextId: "context-lane-compiler",
        order: 1,
      },
      {
        id: "spec-task-task-2",
        contextId: "context-lane-compiler",
        order: 2,
      },
    ]);
    expect(definition.edges).toEqual([]);
    expect(
      readCompiledContextContract(definition, "context-lane-compiler"),
    ).toMatchObject({
      taskElementIds: ["task-1", "task-2"],
      criterionElementIds: ["criterion-1", "criterion-2"],
    });
  });

  it("23.7 and 23.8 carry touched paths and approved traced decisions into the task pack", () => {
    const enrichedSnapshot = structuredClone(snapshot);
    enrichedSnapshot.elements.push(
      revisionElement("decision-1", "decision", 1, null, 7, {
        kind: "decision",
        title: "Use one contraction primitive",
        chosenApproach:
          "Share the pure contraction result between lint and compilation.",
        rejectedAlternatives: [],
        reason: "The reviewer and executor must see the same graph.",
        tracedRequirementElementIds: ["requirement-1"],
      }),
    );
    setTaskPayload(enrichedSnapshot, "task-1", {
      tracedDecisionElementIds: ["decision-1"],
      touchedPaths: ["src/lib/specs", "src/lib/workflow-graph"],
    });

    const definition = compileSpecExecutionPlan({
      spec: {
        id: "spec-native-sdd",
        slug: "native-sdd",
        name: "Native SDD",
      },
      revisionSnapshot: enrichedSnapshot,
      scope,
      scopeHash: "scope-hash-1",
      approvalRequired: true,
    });
    const compiledTask = definition.tasks.find(
      (task) => task.id === "spec-task-task-1",
    );

    expect(compiledTask?.metadata?.specTouchedPaths).toBe(
      '["src/lib/specs","src/lib/workflow-graph"]',
    );
    expect(readCompiledOriginMap(definition)[0]?.touchedPaths).toEqual([
      "src/lib/specs",
      "src/lib/workflow-graph",
    ]);
    expect(compiledTask?.instructions).toContain(
      "native-sdd/D1: Use one contraction primitive",
    );
    expect(compiledTask?.instructions).toContain(
      "Chosen approach: Share the pure contraction result between lint and compilation.",
    );
    expect(compiledTask?.instructions).toContain(
      "Reason: The reviewer and executor must see the same graph.",
    );
    expect(definition.tasks[1]?.metadata).not.toHaveProperty(
      "specTouchedPaths",
    );
  });

  it("23.2 deduplicates inter-group dependencies into one provenance-locked context edge", () => {
    const groupedSnapshot = structuredClone(snapshot);
    setTaskPayload(groupedSnapshot, "task-1", { laneGroup: "source" });
    setTaskPayload(groupedSnapshot, "task-2", { laneGroup: "target" });
    groupedSnapshot.elements.push(
      revisionElement("task-3", "task", 3, null, 7, {
        kind: "task",
        title: "Prepare the second source",
        instructions: "Prepare another prerequisite in the source lane.",
        tracedRequirementElementIds: ["requirement-1"],
        tracedDecisionElementIds: [],
        coveredCriterionElementIds: [],
        dependsOnTaskElementIds: [],
        laneGroup: "source",
      }),
      revisionElement("task-4", "task", 4, null, 8, {
        kind: "task",
        title: "Consume the second source",
        instructions: "Consume the prerequisite in the target lane.",
        tracedRequirementElementIds: ["requirement-1"],
        tracedDecisionElementIds: [],
        coveredCriterionElementIds: [],
        dependsOnTaskElementIds: ["task-3"],
        laneGroup: "target",
      }),
    );

    const definition = compileSpecExecutionPlan({
      spec: {
        id: "spec-native-sdd",
        slug: "native-sdd",
        name: "Native SDD",
      },
      revisionSnapshot: groupedSnapshot,
      scope: {
        ...scope,
        selectedTaskIds: ["task-1", "task-2", "task-3", "task-4"],
      },
      scopeHash: "scope-hash-1",
      approvalRequired: true,
    });

    expect(definition.edges).toEqual([
      {
        id: "edge-groups-%5B%22lane%3Asource%22%2C%22lane%3Atarget%22%5D",
        sourceContextId: "context-lane-source",
        targetContextId: "context-lane-target",
      },
    ]);
    expect(definition.lockedRegions).toContainEqual({
      paths: [
        "/edges/edge-groups-%5B%22lane%3Asource%22%2C%22lane%3Atarget%22%5D/id",
        "/edges/edge-groups-%5B%22lane%3Asource%22%2C%22lane%3Atarget%22%5D/sourceContextId",
        "/edges/edge-groups-%5B%22lane%3Asource%22%2C%22lane%3Atarget%22%5D/targetContextId",
      ],
      sourceUri: "spec://native-sdd/T2?revision=revision-7",
      reason: "The dependency edge is compiled from the approved task plan.",
    });
  });

  it("23.2 preserves singleton context ids when a lane-group-derived id would collide", () => {
    const collisionSnapshot = structuredClone(snapshot);
    setTaskPayload(collisionSnapshot, "task-1", { laneGroup: "compiler" });
    setTaskPayload(collisionSnapshot, "task-2", { laneGroup: "compiler" });
    collisionSnapshot.elements.push(
      revisionElement("lane-compiler", "task", 3, null, 7, {
        kind: "task",
        title: "Keep the singleton identity",
        instructions: "Compile without changing the task-derived context id.",
        tracedRequirementElementIds: ["requirement-1"],
        tracedDecisionElementIds: [],
        coveredCriterionElementIds: [],
        dependsOnTaskElementIds: [],
      }),
    );

    const definition = compileSpecExecutionPlan({
      spec: {
        id: "spec-native-sdd",
        slug: "native-sdd",
        name: "Native SDD",
      },
      revisionSnapshot: collisionSnapshot,
      scope: {
        ...scope,
        selectedTaskIds: ["task-1", "task-2", "lane-compiler"],
      },
      scopeHash: "scope-hash-1",
      approvalRequired: true,
    });

    expect(definition.executionContexts.map(({ id }) => id)).toEqual([
      "context-lane-compiler-2",
      "context-lane-compiler",
    ]);
    expect(
      definition.tasks.find((task) => task.id === "spec-task-lane-compiler")
        ?.contextId,
    ).toBe("context-lane-compiler");
  });

  it("23.2 derives distinct edge ids from opaque lane-group key pairs", () => {
    const opaqueSnapshot = structuredClone(snapshot);
    setTaskPayload(opaqueSnapshot, "task-1", { laneGroup: "a-lane:b" });
    setTaskPayload(opaqueSnapshot, "task-2", { laneGroup: "c" });
    opaqueSnapshot.elements.push(
      revisionElement("task-3", "task", 3, null, 7, {
        kind: "task",
        title: "Start the second edge",
        instructions: "Provide another independent prerequisite.",
        tracedRequirementElementIds: ["requirement-1"],
        tracedDecisionElementIds: [],
        coveredCriterionElementIds: [],
        dependsOnTaskElementIds: [],
        laneGroup: "a",
      }),
      revisionElement("task-4", "task", 4, null, 8, {
        kind: "task",
        title: "Finish the second edge",
        instructions: "Consume the second prerequisite.",
        tracedRequirementElementIds: ["requirement-1"],
        tracedDecisionElementIds: [],
        coveredCriterionElementIds: [],
        dependsOnTaskElementIds: ["task-3"],
        laneGroup: "b-lane:c",
      }),
    );

    const definition = compileSpecExecutionPlan({
      spec: {
        id: "spec-native-sdd",
        slug: "native-sdd",
        name: "Native SDD",
      },
      revisionSnapshot: opaqueSnapshot,
      scope: {
        ...scope,
        selectedTaskIds: ["task-1", "task-2", "task-3", "task-4"],
      },
      scopeHash: "scope-hash-1",
      approvalRequired: true,
    });

    expect(new Set(definition.edges.map(({ id }) => id))).toHaveLength(2);
    expect(workflowSemanticDefinitionSchema.safeParse(definition).success).toBe(
      true,
    );
  });

  it("23.3 assembles the charter deterministically from approved intent sections", () => {
    const intentSnapshot = structuredClone(snapshot);
    intentSnapshot.elements.push(
      revisionElement("constraint-2", "section", null, null, 12, {
        kind: "section",
        role: "intent_constraints",
        title: "Auditability",
        body: "Every compiled promise retains approved provenance.",
      }),
      revisionElement("outcome-2", "section", null, null, 9, {
        kind: "section",
        role: "intent_outcomes",
        title: "Review",
        body: "Reviewers see the execution graph before approval.",
      }),
      revisionElement("non-goal-1", "section", null, null, 10, {
        kind: "section",
        role: "intent_non_goals",
        title: "Runtime scheduling",
        body: "Do not add agent judgment during compilation.",
      }),
      revisionElement("constraint-1", "section", null, null, 11, {
        kind: "section",
        role: "intent_constraints",
        title: "Determinism",
        body: "Identical approved input produces identical output.",
      }),
      revisionElement("outcome-1", "section", null, null, 8, {
        kind: "section",
        role: "intent_outcomes",
        title: "Planning",
        body: "One reviewed plan becomes the executable workflow.",
      }),
    );

    const definition = compileSpecExecutionPlan({
      spec: {
        id: "spec-native-sdd",
        slug: "native-sdd",
        name: "Native SDD",
      },
      revisionSnapshot: intentSnapshot,
      scope,
      scopeHash: "scope-hash-1",
      approvalRequired: true,
    });

    expect({
      ...definition.charter,
      mission: definition.charter.mission.split("\n\n"),
    }).toMatchInlineSnapshot(`
      {
        "conventions": [
          "Implement only the task and criterion contract in the current lane context pack.",
          "Treat approved validation strategy notes as the boundary of validator judgment.",
        ],
        "invariants": [
          {
            "id": "spec-constraint-constraint-1",
            "statement": "Identical approved input produces identical output.",
          },
          {
            "id": "spec-constraint-constraint-2",
            "statement": "Every compiled promise retains approved provenance.",
          },
        ],
        "mission": [
          "Deliver Native SDD revision 7 for scoped criteria native-sdd/R1.1, native-sdd/R1.2.",
          "One reviewed plan becomes the executable workflow.",
          "Reviewers see the execution graph before approval.",
        ],
        "nonGoals": [
          "Runtime scheduling: Do not add agent judgment during compilation.",
          "Work excluded from the pinned execution scope.",
        ],
        "sourcesOfTruth": [
          {
            "accessPolicy": "worktree-relative",
            "appliesTo": "all execution contexts",
            "description": "The immutable approved revision and validated execution scope.",
            "id": "spec-spec-native-sdd-revision-revision-7",
            "label": "Native SDD approved revision 7",
            "locator": "spec://native-sdd/revisions/revision-7?scope=scope-hash-1",
            "rank": 1,
            "type": "spec",
          },
        ],
        "testStrategy": "Use the required validation strategy attached to each scoped criterion.",
      }
    `);

    const reorderedSnapshot = structuredClone(intentSnapshot);
    const firstConstraint = reorderedSnapshot.elements.find(
      ({ element }) => element.id === "constraint-1",
    );
    const secondConstraint = reorderedSnapshot.elements.find(
      ({ element }) => element.id === "constraint-2",
    );
    if (firstConstraint === undefined || secondConstraint === undefined) {
      throw new Error("Missing intent constraint fixtures.");
    }
    firstConstraint.version.position = 13;
    secondConstraint.version.position = 11;
    const reordered = compileSpecExecutionPlan({
      spec: {
        id: "spec-native-sdd",
        slug: "native-sdd",
        name: "Native SDD",
      },
      revisionSnapshot: reorderedSnapshot,
      scope,
      scopeHash: "scope-hash-1",
      approvalRequired: true,
    });
    expect(reordered.charter.invariants).toEqual([
      {
        id: "spec-constraint-constraint-2",
        statement: "Every compiled promise retains approved provenance.",
      },
      {
        id: "spec-constraint-constraint-1",
        statement: "Identical approved input produces identical output.",
      },
    ]);
  });

  it("17.4 locks exactly the contract-derived fields with spec-handle links", () => {
    const definition = compileSpecExecutionPlan({
      spec: {
        id: "spec-native-sdd",
        slug: "native-sdd",
        name: "Native SDD",
      },
      revisionSnapshot: snapshot,
      scope,
      scopeHash: "scope-hash-1",
      approvalRequired: true,
    });

    expect(definition.lockedRegions).toEqual([
      {
        paths: ["/approvalRequired", "/origin", "/charter"],
        sourceUri: "spec://native-sdd/revisions/revision-7?scope=scope-hash-1",
        reason:
          "Pinned revision, execution scope, and approval policy come from the approved spec contract.",
      },
      contractRegion("task-1", "T1"),
      contractRegion("task-2", "T2"),
      {
        paths: [
          "/edges/edge-task-1-task-2/id",
          "/edges/edge-task-1-task-2/sourceContextId",
          "/edges/edge-task-1-task-2/targetContextId",
        ],
        sourceUri: "spec://native-sdd/T2?revision=revision-7",
        reason: "The dependency edge is compiled from the approved task plan.",
      },
    ]);

    const lockedPaths = definition.lockedRegions?.flatMap(
      (region) => region.paths,
    );
    expect(lockedPaths).not.toContain("/workflowConfig");
    expect(lockedPaths).not.toContain(
      "/executionContexts/context-task-1/acceptanceCriteria",
    );
    expect(lockedPaths).not.toContain("/tasks/spec-task-task-1/contextId");
    expect(lockedPaths).not.toContain("/tasks/spec-task-task-1/order");
    expect(lockedPaths).not.toContain(
      "/executionContexts/context-task-1/iterationPolicy",
    );
  });

  it("17.4 keeps locked criterion briefs and provenance with a task after legal regrouping", () => {
    const definition = compileSpecExecutionPlan({
      spec: {
        id: "spec-native-sdd",
        slug: "native-sdd",
        name: "Native SDD",
      },
      revisionSnapshot: snapshot,
      scope,
      scopeHash: "scope-hash-1",
      approvalRequired: true,
    });
    const edited = applyDefinitionEdits(
      {
        id: "definition-regrouping",
        name: "Regrouping",
        description: "Regrouping contract",
        schemaVersion: 1,
        revision: 1,
        definition,
        layout: {
          workflowId: "definition-regrouping",
          contextPositions: {
            "context-task-1": { x: 0, y: 0 },
            "context-task-2": { x: 360, y: 0 },
          },
          viewport: { x: 0, y: 0, zoom: 1 },
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      [
        {
          type: "move-task",
          taskId: "spec-task-task-2",
          contextId: "context-task-1",
        },
      ],
    );
    if (!edited.ok) throw new Error(JSON.stringify(edited.issues));

    expect(
      edited.record.definition.executionContexts[0]?.acceptanceCriteria,
    ).toContain("locked criterion briefs of every task currently assigned");
    expect(
      readCompiledContextContract(edited.record.definition, "context-task-1"),
    ).toMatchObject({
      criterionElementIds: ["criterion-1", "criterion-2"],
      criterionHandles: ["native-sdd/R1.1", "native-sdd/R1.2"],
      acceptanceCriteria: expect.stringContaining(
        "Inspect the compiled dependency edge.",
      ),
    });
    expect(
      edited.record.definition.tasks.find(
        (task) => task.id === "spec-task-task-2",
      )?.metadata,
    ).toHaveProperty("specCriterionBriefs");
  });

  it("normalizes persisted origin-map strategies that carry dropped evidence kinds", () => {
    // Execution pins compiled before the vocabulary narrowed carry six-kind
    // strategy metadata; the read boundary must strip dropped kinds and keep
    // every strategy machine-provable without rewriting the pinned bytes.
    const definition = compileSpecExecutionPlan({
      spec: { id: "spec-native-sdd", slug: "native-sdd", name: "Native SDD" },
      revisionSnapshot: snapshot,
      scope,
      scopeHash: "scope-hash-legacy",
      approvalRequired: false,
    });
    const legacyDefinition = {
      ...definition,
      tasks: definition.tasks.map((task) =>
        task.id === "spec-task-task-1"
          ? {
              ...task,
              metadata: {
                ...task.metadata,
                specValidationStrategies: JSON.stringify({
                  "criterion-1": { kinds: ["test_run", "screenshot"] },
                }),
              },
            }
          : {
              ...task,
              metadata: {
                ...task.metadata,
                specValidationStrategies: JSON.stringify({
                  "criterion-2": {
                    kinds: ["human_signoff"],
                    note: "Captured before the vocabulary narrowed.",
                  },
                }),
              },
            },
      ),
    };

    const origins = readCompiledOriginMap(legacyDefinition);

    // A surviving machine kind needs no fallback; only a zero-machine list
    // gains validator_verdict.
    expect(origins[0]?.validationStrategies["criterion-1"]).toEqual({
      kinds: ["test_run"],
    });
    expect(origins[1]?.validationStrategies["criterion-2"]).toEqual({
      kinds: ["validator_verdict"],
      note: "Captured before the vocabulary narrowed.",
    });
  });

  it("throws a typed error on malformed origin-map strategy metadata", () => {
    const definition = compileSpecExecutionPlan({
      spec: { id: "spec-native-sdd", slug: "native-sdd", name: "Native SDD" },
      revisionSnapshot: snapshot,
      scope,
      scopeHash: "scope-hash-malformed",
      approvalRequired: false,
    });
    const malformed = {
      ...definition,
      tasks: definition.tasks.map((task) => ({
        ...task,
        metadata: {
          ...task.metadata,
          specValidationStrategies: JSON.stringify({
            "criterion-1": { kinds: "not-a-list" },
          }),
        },
      })),
    };

    expect(() => readCompiledOriginMap(malformed)).toThrow(
      /specValidationStrategies/,
    );
  });
});

function contractRegion(taskId: string, handle: string) {
  return {
    paths: [
      `/tasks/spec-task-${taskId}/id`,
      `/tasks/spec-task-${taskId}/title`,
      `/tasks/spec-task-${taskId}/instructions`,
      `/tasks/spec-task-${taskId}/metadata`,
    ],
    sourceUri: `spec://native-sdd/${handle}?revision=revision-7`,
    reason:
      "Task content, criterion mapping, and validation strategy come from the approved spec contract.",
  };
}

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
      specId: "spec-native-sdd",
      kind,
      number,
      parentElementId,
      createdAt: timestamp,
    },
    version: {
      revisionId: "revision-7",
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

function setTaskPayload(
  targetSnapshot: SpecRevisionSnapshot,
  taskId: string,
  changes: Partial<
    Extract<
      SpecRevisionSnapshot["elements"][number]["version"]["payload"],
      { kind: "task" }
    >
  >,
): void {
  const element = targetSnapshot.elements.find(
    ({ element: candidate }) => candidate.id === taskId,
  );
  if (element?.version.payload.kind !== "task") {
    throw new Error(`Missing task payload ${taskId}.`);
  }
  element.version.payload = { ...element.version.payload, ...changes };
}
