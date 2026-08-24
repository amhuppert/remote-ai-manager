import { describe, expect, it } from "vitest";

import { composeGraphRolePrompt } from "@/lib/workflow-graph/prompt-composer";
import {
  createWorkflowExecution,
  makeSeededValidatorAssignment,
} from "@/lib/workflow-graph/test-fixtures";
import { buildContextValidationPrompt } from "@/lib/workflow-graph/validator-runner";
import type { ValidationPromptSelections } from "@/lib/workflow-graph/validation-prompt-section";

import type { SpecExecutionBindingReader } from "./execution-binding";
import {
  createSpecExecutionBindingGraphContract,
  createSpecExecutionBindingPorts,
} from "./execution-binding-service";
import type { SpecRevisionSnapshot } from "./schemas";

// ============================================================
// Spec-side criteria rendering parity (#69 change 4 stage 1)
//
// src/lib/specs renders criteria into prompt text in exactly one place:
// `buildSpecOwnershipProjection`, whose rows are the pinned revision's spec
// criterion ELEMENTS (element id + brief in a table) — a different entity
// from a context's acceptance criteria, untouched by the records schema.
// Context acceptance criteria never render inside src/lib/specs: the port's
// `deriveContextAcceptanceCriteria` sends the empty Record<string, string>,
// and the prompt a spec-BOUND run reads is composed by the graph builders
// through the shared criterion-records helper. This suite pins that parity:
// a spec-bound context renders records in the same numbered `N. [id]
// statement` dialect as any graph run, prose byte-identical, and the
// authoritative spec-ownership bytes do not vary with the criteria shape.
// ============================================================

const NOW = "2026-08-15T12:00:00.000Z";
const WORKFLOW_EXECUTION_ID = "workflow-execution-parity";
const EMPTY_VALIDATION_SELECTIONS = {
  registry: "none",
  enabled: { kind: "commands", commands: [] },
  disabled: [],
  scriptGate: { kind: "off" },
} satisfies ValidationPromptSelections;

function pinnedRevision(): SpecRevisionSnapshot {
  return {
    revision: {
      id: "revision-parity",
      specId: "spec-parity",
      number: 1,
      state: "approved",
      authoringStage: "plan",
      basedOnRevisionId: null,
      contentHash: "sha256:revision-parity",
      citationContractVersion: 2,
      citationVersion: 1,
      citationHash: "0".repeat(64),
      proposedAt: NOW,
      approvedAt: NOW,
      externalDelivery: null,
      createdAt: NOW,
    },
    assumptionCitations: [],
    elements: [
      {
        element: {
          id: "criterion-parity",
          specId: "spec-parity",
          kind: "criterion" as const,
          number: 1,
          parentElementId: null,
          createdAt: NOW,
        },
        version: {
          revisionId: "revision-parity",
          elementId: "criterion-parity",
          position: 0,
          payload: {
            kind: "criterion" as const,
            text: "The parity capability is delivered.",
            validationStrategy: { kinds: ["test_run" as const] },
          },
          payloadHash: "sha256:criterion-parity",
          elementVersion: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
    ],
  };
}

function bindingReader(): SpecExecutionBindingReader {
  const linked = {
    specExecutionId: "spec-execution-parity",
    workflowExecutionId: WORKFLOW_EXECUTION_ID,
    binding: {
      schemaVersion: 2 as const,
      candidateId: "candidate-parity",
      candidateHash: `sha256:${"a".repeat(64)}`,
      pinnedRevisionId: "revision-parity",
      dispositions: [
        {
          criterionElementId: "criterion-parity",
          disposition: "in_scope" as const,
          deliveredByExecutionId: null,
        },
      ],
      claims: [
        {
          contextId: "context-implement",
          criterionElementIds: ["criterion-parity"],
        },
      ],
    },
    createdAt: NOW,
  };
  return {
    findByWorkflowExecutionId(workflowExecutionId) {
      return workflowExecutionId === WORKFLOW_EXECUTION_ID ? linked : null;
    },
    requireByWorkflowExecutionId(workflowExecutionId) {
      if (workflowExecutionId !== WORKFLOW_EXECUTION_ID) {
        throw new Error(`missing ${workflowExecutionId}`);
      }
      return linked;
    },
  };
}

async function specBoundValidatorPrompt(
  acceptanceCriteria:
    | string
    | { readonly id: string; readonly statement: string }[],
): Promise<string> {
  // The shape under test lives in the working definition itself, so the
  // composed prompt is one production could produce: the deferral-cohort
  // section and the '## Acceptance Criteria' section render the same value.
  const seeded = createWorkflowExecution({ id: WORKFLOW_EXECUTION_ID });
  const execution = {
    ...seeded,
    origin: {
      kind: "spec_delivery" as const,
      specSlug: "spec-parity",
      candidateId: "candidate-parity",
    },
    workingDefinition: {
      ...seeded.workingDefinition,
      executionContexts: seeded.workingDefinition.executionContexts.map(
        (context) =>
          context.id === "context-implement"
            ? { ...context, acceptanceCriteria }
            : context,
      ),
    },
  };
  const baseContext = execution.workingDefinition.executionContexts.find(
    (context) => context.id === "context-implement",
  );
  if (baseContext === undefined) throw new Error("missing context-implement");
  const validator = makeSeededValidatorAssignment({ authority: "blocking" });
  const context = {
    ...baseContext,
    contextValidator: { enabled: true as const, assignments: [validator] },
  };
  const contract = createSpecExecutionBindingGraphContract(
    createSpecExecutionBindingPorts(bindingReader()),
    { loadRevisionSnapshot: async () => pinnedRevision() },
  );

  return composeGraphRolePrompt({
    execution,
    executionContract: contract,
    role: "context-validator",
    contextId: context.id,
    prompt: buildContextValidationPrompt({
      context,
      tasks: execution.workingDefinition.tasks.filter(
        (task) => task.contextId === context.id,
      ),
      taskStates: execution.taskStates,
      validator,
      validationSelections: EMPTY_VALIDATION_SELECTIONS,
    }),
  });
}

function ownershipSection(prompt: string): string {
  const start = prompt.indexOf("# Spec ownership (authoritative)");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = prompt.indexOf("\n\n## Acceptance-criteria");
  expect(end).toBeGreaterThan(start);
  return prompt.slice(start, end);
}

describe("spec-bound prompt criteria parity", () => {
  it("renders a records-shaped context as the numbered id-citing list of the graph dialect", async () => {
    const prompt = await specBoundValidatorPrompt([
      {
        id: "parity-implemented",
        statement: "The capability is implemented in the production path.",
      },
      {
        id: "parity-proven",
        statement: "The capability is proven by a focused test.",
      },
    ]);

    expect(prompt).toContain(
      [
        "## Acceptance Criteria",
        "",
        "1. [parity-implemented] The capability is implemented in the production path.",
        "2. [parity-proven] The capability is proven by a focused test.",
      ].join("\n"),
    );
  });

  it("renders a prose-shaped context byte-identical and keeps the ownership bytes shape-independent", async () => {
    const prosePrompt = await specBoundValidatorPrompt("Feature implemented");
    expect(prosePrompt).toContain(
      ["## Acceptance Criteria", "", "1. [ac-1] Feature implemented", ""].join(
        "\n",
      ),
    );

    // The authoritative spec-ownership section renders the pinned criterion
    // ELEMENTS and must not vary with the context's criteria shape.
    const recordsPrompt = await specBoundValidatorPrompt([
      { id: "parity-implemented", statement: "Feature implemented" },
    ]);
    expect(ownershipSection(prosePrompt)).toContain("criterion-parity");
    expect(ownershipSection(recordsPrompt)).toBe(ownershipSection(prosePrompt));
  });
});
