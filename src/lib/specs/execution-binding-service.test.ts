import { describe, expect, it } from "vitest";

import {
  SpecExecutionBindingMismatchError,
  type SpecExecutionBindingReader,
} from "./execution-binding";
import {
  createSpecExecutionBindingGraphContract,
  createSpecExecutionBindingPorts,
} from "./execution-binding-service";
import { criterionRecordsOf } from "@/lib/workflow-graph/criteria/criterion-records";
import {
  resolvedWorkflowSemanticDefinitionSchema,
  workflowSemanticDefinitionSchema,
} from "@/lib/workflow-graph/definition-schemas";
import {
  createResolvedWorkflowDefinition,
  createWorkflowDefinitionRecord,
  createWorkflowExecution,
} from "@/lib/workflow-graph/test-fixtures";
import {
  applyLiveExecutionEdits,
  type LiveEditDeps,
} from "@/lib/workflow-graph/runtime-edits";
import { workflowLiveEditOperationSchema } from "@/lib/workflows/edit-schemas";

const WORKFLOW_EXECUTION_ID = "workflow-execution-bound";

function boundExecution() {
  const launch = createWorkflowDefinitionRecord();
  return createWorkflowExecution({
    id: WORKFLOW_EXECUTION_ID,
    origin: {
      kind: "spec_delivery",
      specSlug: "spec-bound",
      candidateId: "candidate-bound",
    },
    launchDocument: {
      name: launch.name,
      description: launch.description,
      definition: launch.definition,
      layout: launch.layout,
    },
  });
}

function reader(): SpecExecutionBindingReader {
  const linked = {
    specExecutionId: "spec-execution-bound",
    workflowExecutionId: WORKFLOW_EXECUTION_ID,
    binding: {
      schemaVersion: 2 as const,
      candidateId: "candidate-bound",
      candidateHash: `sha256:${"a".repeat(64)}`,
      pinnedRevisionId: "revision-bound",
      dispositions: [
        {
          criterionElementId: "criterion-a",
          disposition: "in_scope" as const,
          deliveredByExecutionId: null,
        },
        {
          criterionElementId: "criterion-b",
          disposition: "in_scope" as const,
          deliveredByExecutionId: null,
        },
        {
          criterionElementId: "criterion-deferred",
          disposition: "deferred" as const,
          deliveredByExecutionId: null,
        },
      ],
      claims: [
        {
          contextId: "context-implement",
          criterionElementIds: ["criterion-a", "criterion-b"],
        },
        {
          contextId: "context-verify",
          criterionElementIds: ["criterion-a", "criterion-b"],
        },
      ],
    },
    createdAt: "2026-08-15T12:00:00.000Z",
  };
  return {
    findByWorkflowExecutionId(workflowExecutionId) {
      return workflowExecutionId === WORKFLOW_EXECUTION_ID ? linked : null;
    },
    requireByWorkflowExecutionId(workflowExecutionId, expected = {}) {
      if (workflowExecutionId !== WORKFLOW_EXECUTION_ID) {
        throw new Error(`missing ${workflowExecutionId}`);
      }
      if (
        expected.candidateId !== undefined &&
        expected.candidateId !== linked.binding.candidateId
      ) {
        throw new SpecExecutionBindingMismatchError(
          workflowExecutionId,
          "candidateId",
        );
      }
      return linked;
    },
  };
}

describe("spec execution binding graph contract", () => {
  it("derives immutable opaque coverage groups for every selected criterion and leaves ordinary graphs unbound", () => {
    const ports = createSpecExecutionBindingPorts(reader());
    const contract = createSpecExecutionBindingGraphContract(ports);
    const bound = boundExecution();
    const ordinary = createWorkflowExecution({ id: "ordinary-execution" });

    const boundLiveEdit = contract.loadLiveEdit(bound);
    expect(boundLiveEdit.validateOperation(bound, {} as never)).toEqual({
      ok: true,
    });
    expect(boundLiveEdit.accountabilityCoverageGroups).toEqual([
      {
        bindingKey: "criterion-a",
        claimantContextIds: ["context-implement", "context-verify"],
      },
      {
        bindingKey: "criterion-b",
        claimantContextIds: ["context-implement", "context-verify"],
      },
    ]);
    const ordinaryLiveEdit = contract.loadLiveEdit(ordinary);
    expect(ordinaryLiveEdit.validateOperation(ordinary, {} as never)).toEqual({
      ok: true,
    });
    expect(ordinaryLiveEdit.accountabilityCoverageGroups).toEqual([]);

    if (bound.origin.kind !== "spec_delivery") {
      throw new Error("expected a spec-delivery fixture");
    }
    const crossCandidate = {
      ...bound,
      origin: { ...bound.origin, candidateId: "candidate-other" },
    };
    expect(() => contract.loadLiveEdit(crossCandidate)).toThrow(
      SpecExecutionBindingMismatchError,
    );
  });

  it("binds claims unchanged against a records-authored plan", () => {
    // The same bound run as above, launched from a plan whose contexts author
    // acceptance criteria as records (#69 change 4 stage 1) instead of prose.
    // Both records-shaped definitions are re-parsed through the production
    // schemas, so a schema that stopped accepting records fails here rather
    // than sliding through the plain-object fixture builder.
    const launch = createWorkflowDefinitionRecord();
    const resolved = createResolvedWorkflowDefinition();
    const bound = createWorkflowExecution({
      id: WORKFLOW_EXECUTION_ID,
      origin: {
        kind: "spec_delivery",
        specSlug: "spec-bound",
        candidateId: "candidate-bound",
      },
      launchDocument: {
        name: launch.name,
        description: launch.description,
        definition: workflowSemanticDefinitionSchema.parse({
          ...launch.definition,
          executionContexts: launch.definition.executionContexts.map(
            (context) => ({
              ...context,
              acceptanceCriteria: criterionRecordsOf(
                context.acceptanceCriteria,
              ),
            }),
          ),
        }),
        layout: launch.layout,
      },
      workingDefinition: resolvedWorkflowSemanticDefinitionSchema.parse({
        ...resolved,
        executionContexts: resolved.executionContexts.map((context) => ({
          ...context,
          acceptanceCriteria: criterionRecordsOf(context.acceptanceCriteria),
        })),
      }),
    });
    const contract = createSpecExecutionBindingGraphContract(
      createSpecExecutionBindingPorts(reader()),
    );

    const liveEdit = contract.loadLiveEdit(bound);
    expect(liveEdit.accountabilityCoverageGroups).toEqual([
      {
        bindingKey: "criterion-a",
        claimantContextIds: ["context-implement", "context-verify"],
      },
      {
        bindingKey: "criterion-b",
        claimantContextIds: ["context-implement", "context-verify"],
      },
    ]);
    expect(contract.validateTaskCompletion(bound, "task-implement-1")).toEqual({
      ok: true,
    });
  });

  it("protects bound criteria at the ordinary live-edit frontier", () => {
    const ports = createSpecExecutionBindingPorts(reader());
    const contract = createSpecExecutionBindingGraphContract(ports);
    const base = boundExecution();
    const execution = createWorkflowExecution({
      id: WORKFLOW_EXECUTION_ID,
      status: "paused",
      origin: base.origin,
      launchDocument: base.launchDocument,
      workingDefinition: {
        ...base.workingDefinition,
        executionContexts: base.workingDefinition.executionContexts.map(
          (context) =>
            context.id === "context-plan"
              ? {
                  ...context,
                  outputSchema: {
                    type: "object",
                    properties: {
                      verdict: { type: "string", enum: ["ship", "hold"] },
                    },
                    required: ["verdict"],
                  },
                }
              : context,
        ),
      },
    });

    const result = applyLiveExecutionEdits(
      execution,
      {
        operations: [
          {
            type: "update-edge",
            edgeId: "edge-plan-implement",
            when: {
              schema: {
                type: "object",
                properties: { verdict: { const: "ship" } },
                required: ["verdict"],
              },
            },
          },
        ],
      },
      { executionContract: contract.loadLiveEdit(execution) } as LiveEditDeps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "criterion-must-run-coverage-lost",
        message: expect.stringContaining("criterion-a"),
      }),
    );
  });

  it("leaves the entire ordinary live-edit vocabulary available to version-2 bindings", () => {
    const contract = createSpecExecutionBindingGraphContract(
      createSpecExecutionBindingPorts(reader()),
    );
    const execution = boundExecution();
    const loaded = contract.loadLiveEdit(execution);
    const operationTypes = workflowLiveEditOperationSchema.options.map(
      (option) => option.shape.type.value,
    );

    expect(operationTypes).toEqual(
      expect.arrayContaining([
        "amend-charter",
        "update-context",
        "add-context",
        "remove-context",
        "add-task",
        "update-task",
        "remove-task",
        "move-task",
        "reorder-tasks",
        "add-edge",
        "update-edge",
        "remove-edge",
        "materialize-loop-pass",
        "raise-loop-max-passes",
        "amend-loop-predicate",
        "edit-loop-template",
        "update-lane-merge-validation",
      ]),
    );
    for (const type of operationTypes) {
      expect(
        loaded.validateOperation(execution, { type } as never),
        `version-2 binding rejected ordinary operation ${type}`,
      ).toEqual({ ok: true });
    }
  });

  it("accepts removal of one overlapping claimant but refuses removal of the stable alternative", () => {
    const ports = createSpecExecutionBindingPorts(reader());
    const contract = createSpecExecutionBindingGraphContract(ports);
    const execution = createWorkflowExecution({
      ...boundExecution(),
      status: "paused",
    });
    const bindingBefore = structuredClone(
      reader().requireByWorkflowExecutionId(WORKFLOW_EXECUTION_ID).binding,
    );

    const redundantRemoval = applyLiveExecutionEdits(
      execution,
      {
        operations: [
          { type: "remove-edge", edgeId: "edge-implement-verify" },
          { type: "remove-edge", edgeId: "edge-plan-implement" },
          {
            type: "remove-context",
            contextId: "context-implement",
            deleteTasks: true,
          },
          {
            type: "add-edge",
            sourceContextId: "context-plan",
            targetContextId: "context-verify",
          },
        ],
      },
      { executionContract: contract.loadLiveEdit(execution) } as LiveEditDeps,
    );

    expect(redundantRemoval.ok).toBe(true);
    if (!redundantRemoval.ok) return;
    expect(
      reader().requireByWorkflowExecutionId(WORKFLOW_EXECUTION_ID).binding,
    ).toEqual(bindingBefore);

    const lastAlternativeRemoval = applyLiveExecutionEdits(
      redundantRemoval.execution,
      {
        operations: [
          { type: "remove-edge", edgeId: "context-plan__context-verify" },
          {
            type: "remove-context",
            contextId: "context-verify",
            deleteTasks: true,
          },
        ],
      },
      {
        executionContract: contract.loadLiveEdit(redundantRemoval.execution),
      } as LiveEditDeps,
    );

    expect(lastAlternativeRemoval.ok).toBe(false);
    if (lastAlternativeRemoval.ok) return;
    expect(lastAlternativeRemoval.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "criterion-must-run-coverage-lost",
          message: expect.stringContaining("criterion-a"),
        }),
        expect.objectContaining({
          code: "criterion-must-run-coverage-lost",
          message: expect.stringContaining("criterion-b"),
        }),
      ]),
    );
  });

  it("uses the audited ordinary charter amendment despite the finalized charter lock", () => {
    const ports = createSpecExecutionBindingPorts(reader());
    const contract = createSpecExecutionBindingGraphContract(ports);
    const base = boundExecution();
    if (base.origin.kind !== "spec_delivery" || base.launchDocument === null) {
      throw new Error("expected a spec-delivery fixture");
    }
    const lockedRegions = [
      {
        paths: ["/charter"],
        sourceUri: "cc-spec://spec/candidate-bound",
        reason: "The finalized candidate owns workflow governance.",
        instruction: "Use the audited charter-amendment act.",
      },
      {
        paths: ["/origin", "/approvalRequired"],
        sourceUri: "cc-spec://spec/candidate-bound",
        reason: "The finalized candidate owns provenance and approval policy.",
      },
    ];
    const execution = createWorkflowExecution({
      ...base,
      status: "paused",
      launchDocument: {
        ...base.launchDocument,
        definition: {
          ...base.launchDocument.definition,
          lockedRegions,
        },
      },
      workingDefinition: {
        ...base.workingDefinition,
        lockedRegions,
      },
    });

    const result = applyLiveExecutionEdits(
      execution,
      {
        source: "cli",
        operations: [
          {
            type: "amend-charter",
            rationale: "The delivery boundary was clarified.",
            mission: "Deliver the clarified candidate safely.",
          },
        ],
      },
      {
        executionContract: contract.loadLiveEdit(execution),
        now: () => "2026-08-15T13:00:00.000Z",
      } as LiveEditDeps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.execution.charter.mission).toBe(
      "Deliver the clarified candidate safely.",
    );
    expect(result.execution.charterAmendments.at(-1)).toMatchObject({
      source: "cli",
      rationale: "The delivery boundary was clarified.",
    });
  });
});
