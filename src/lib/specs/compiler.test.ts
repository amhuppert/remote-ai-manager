import { describe, expect, it } from "vitest";
import { workflowSemanticDefinitionSchema } from "@/lib/workflow-graph/definition-schemas";
import { applyDefinitionEdits } from "@/lib/workflow-graph/definition-edits";
import { validateWorkflowDefinition } from "@/lib/workflow-graph/validation";
import type { SpecRevisionSnapshot } from "./schemas";
import type { ExecutionScope } from "./scope-validation";
import {
  compileSpecExecutionPlan,
  readCompiledContextContract,
} from "./compiler";

const timestamp = "2026-07-18T12:00:00.000Z";

const snapshot: SpecRevisionSnapshot = {
  revision: {
    id: "revision-7",
    specId: "spec-native-sdd",
    number: 7,
    state: "approved",
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
      validationStrategy: { kinds: ["human_signoff"] },
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
  number: number,
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
