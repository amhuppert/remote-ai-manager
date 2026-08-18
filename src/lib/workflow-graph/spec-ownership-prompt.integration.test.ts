import { describe, expect, it } from "vitest";

import { acceptanceCriteriaText } from "@/lib/workflow-graph/criteria/criterion-records";
import type { SpecExecutionBindingReader } from "@/lib/specs/execution-binding";
import {
  createSpecExecutionBindingGraphContract,
  createSpecExecutionBindingPorts,
} from "@/lib/specs/execution-binding-service";
import { buildSpecExecutionClaimsDocument } from "@/lib/specs/execution-claims-document";
import type { SpecRevisionSnapshot } from "@/lib/specs/schemas";
import { buildSpecOwnershipProjection } from "@/lib/specs/spec-ownership-projection";
import { composeGraphRolePrompt } from "@/lib/workflow-graph/prompt-composer";
import {
  createWorkflowDefinition,
  createWorkflowExecution,
  createWorkflowLayout,
  makeSeededValidatorAssignment,
} from "@/lib/workflow-graph/test-fixtures";
import type { ValidationPromptSelections } from "@/lib/workflow-graph/validation-prompt-section";

import { buildIterationPrompt } from "./iteration-prompt";
import { buildContextValidationPrompt } from "./validator-runner";

const NOW = "2026-08-15T12:00:00.000Z";
const WORKFLOW_EXECUTION_ID = "workflow-execution-ownership";
const CANDIDATE_HASH = `sha256:${"a".repeat(64)}`;
const EMPTY_VALIDATION_SELECTIONS = {
  registry: "none",
  enabled: { kind: "commands", commands: [] },
  disabled: [],
  scriptGate: { kind: "off" },
} satisfies ValidationPromptSelections;

function pinnedRevision(): SpecRevisionSnapshot {
  const criteria = [
    {
      id: "criterion-implementer-a",
      brief: "Implement capability A in the production path.",
      kinds: ["test_run" as const],
      note: "Run the focused capability A test.",
    },
    {
      id: "criterion-sibling-b",
      brief: "Wire capability B from the sibling context.",
      kinds: ["validator_verdict" as const],
      note: "Inspect the production caller.",
    },
    {
      id: "criterion-redundant",
      brief: "Preserve the redundant delivery route.",
      kinds: ["test_run" as const],
      note: "Exercise either stable claimant.",
    },
    {
      id: "criterion-deferred",
      brief: "Track the explicitly deferred external dependency.",
      kinds: ["commit" as const],
      note: "Pinned planning guidance only.",
    },
  ];

  return {
    revision: {
      id: "revision-ownership",
      specId: "spec-ownership",
      number: 7,
      state: "approved",
      authoringStage: "plan",
      basedOnRevisionId: null,
      contentHash: "sha256:revision-ownership",
      proposedAt: NOW,
      approvedAt: NOW,
      externalDelivery: null,
      createdAt: NOW,
    },
    elements: criteria.map((criterion, index) => ({
      element: {
        id: criterion.id,
        specId: "spec-ownership",
        kind: "criterion" as const,
        number: index + 1,
        parentElementId: null,
        createdAt: NOW,
      },
      version: {
        revisionId: "revision-ownership",
        elementId: criterion.id,
        position: index,
        payload: {
          kind: "criterion" as const,
          text: criterion.brief,
          validationStrategy: {
            kinds: criterion.kinds,
            note: criterion.note,
          },
        },
        payloadHash: `sha256:${criterion.id}`,
        elementVersion: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
    })),
  };
}

function bindingReader(): SpecExecutionBindingReader {
  const linked = {
    specExecutionId: "spec-execution-ownership",
    workflowExecutionId: WORKFLOW_EXECUTION_ID,
    binding: {
      schemaVersion: 2 as const,
      candidateId: "candidate-ownership",
      candidateHash: CANDIDATE_HASH,
      pinnedRevisionId: "revision-ownership",
      dispositions: [
        {
          criterionElementId: "criterion-implementer-a",
          disposition: "in_scope" as const,
          deliveredByExecutionId: null,
        },
        {
          criterionElementId: "criterion-sibling-b",
          disposition: "in_scope" as const,
          deliveredByExecutionId: null,
        },
        {
          criterionElementId: "criterion-redundant",
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
          criterionElementIds: [
            "criterion-implementer-a",
            "criterion-redundant",
          ],
        },
        {
          contextId: "context-verify",
          criterionElementIds: ["criterion-sibling-b", "criterion-redundant"],
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

function boundExecution() {
  return createWorkflowExecution({
    id: WORKFLOW_EXECUTION_ID,
    origin: {
      kind: "spec_delivery",
      specSlug: "spec-ownership",
      candidateId: "candidate-ownership",
    },
    launchDocument: {
      name: "Spec-owned launch",
      description: null,
      definition: createWorkflowDefinition(),
      layout: createWorkflowLayout(),
    },
  });
}

function promptInputs() {
  const execution = boundExecution();
  const baseContext = execution.workingDefinition.executionContexts.find(
    (context) => context.id === "context-implement",
  );
  if (baseContext === undefined) throw new Error("missing context-implement");
  const validator = makeSeededValidatorAssignment({
    authority: "blocking",
  });
  const context = {
    ...baseContext,
    contextValidator: { enabled: true as const, assignments: [validator] },
  };
  const tasks = execution.workingDefinition.tasks.filter(
    (task) => task.contextId === context.id,
  );
  return { execution, context, tasks, validator };
}

describe("native SDD ownership prompt projection", () => {
  it("injects the same authoritative ownership bytes into implementer A and validator A", async () => {
    const { execution, context, tasks, validator } = promptInputs();
    const reader = bindingReader();
    const contract = createSpecExecutionBindingGraphContract(
      createSpecExecutionBindingPorts(reader),
      { loadRevisionSnapshot: async () => pinnedRevision() },
    );

    const implementerPrompt = await composeGraphRolePrompt({
      execution,
      executionContract: contract,
      prompt: buildIterationPrompt({
        context,
        tasks,
        taskStates: execution.taskStates,
        sharedDocuments: [],
        allowAgentTaskAdd: false,
        contextValidationAcceptanceCriteria: acceptanceCriteriaText(
          context.acceptanceCriteria,
        ),
        validationSelections: EMPTY_VALIDATION_SELECTIONS,
      }),
    });
    const validatorPrompt = await composeGraphRolePrompt({
      execution,
      executionContract: contract,
      role: "context-validator",
      contextId: context.id,
      prompt: buildContextValidationPrompt({
        context,
        tasks,
        taskStates: execution.taskStates,
        validator,
        validationSelections: EMPTY_VALIDATION_SELECTIONS,
      }),
    });

    const ownership = implementerPrompt.slice(
      0,
      implementerPrompt.indexOf("\n\n# Execution Context:"),
    );
    expect(validatorPrompt).toContain(
      `${ownership}\n\n## Acceptance-criteria cohort for deferral checks`,
    );
    expect(validatorPrompt).toContain("# Context Validation");
    expect(ownership).toContain("# Spec ownership (authoritative)");
    expect(ownership).toContain("criterion-implementer-a");
    expect(ownership).toContain(
      "Implement capability A in the production path.",
    );
    expect(ownership).toContain("criterion-sibling-b");
    expect(ownership).toContain("context-verify");
    expect(ownership).toContain("criterion-redundant");
    expect(ownership).toMatch(
      /criterion-redundant.*context-implement.*context-verify/s,
    );
    expect(ownership).toContain("criterion-deferred");
    expect(ownership).toContain("deferred");
    expect(ownership).toContain("Pinned validation guidance only");
    expect(ownership).toContain("not an evidence checklist");

    const projection = await contract.loadPromptProjection?.(execution);
    expect(projection).not.toBeNull();
    if (projection === null || projection === undefined) return;
    const documentProjection = buildSpecOwnershipProjection(
      reader.requireByWorkflowExecutionId(execution.id).binding,
      pinnedRevision(),
    );
    expect(projection).toEqual(documentProjection);
    expect(
      buildSpecExecutionClaimsDocument(documentProjection).contents.trimEnd(),
    ).toBe(ownership);
  });

  it("leaves an ordinary unbound implementer execution free of a spec section", async () => {
    const ordinary = createWorkflowExecution({ id: "ordinary-execution" });
    const reader = bindingReader();
    const contract = createSpecExecutionBindingGraphContract(
      createSpecExecutionBindingPorts(reader),
      { loadRevisionSnapshot: async () => pinnedRevision() },
    );

    const prompt = await composeGraphRolePrompt({
      execution: ordinary,
      executionContract: contract,
      prompt: "ordinary graph prompt",
    });

    expect(prompt).toBe("ordinary graph prompt");
    expect(prompt).not.toContain("Spec ownership");
  });
});
