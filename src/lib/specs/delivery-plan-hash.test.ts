import { describe, expect, it } from "vitest";

import { createWorkflowDefinitionRecord } from "@/lib/workflow-graph/test-fixtures";

import {
  deliveryPlanCandidateManifestV3Schema,
  deliveryPlanV3DocumentSchema,
} from "./delivery-plan";
import {
  deliveryPlanBindingHash,
  deliveryPlanCandidateHash,
  workflowDefinitionHash,
} from "./delivery-plan-hash";

function binding() {
  return deliveryPlanV3DocumentSchema.parse({
    schemaVersion: 3,
    binding: {
      dispositions: [
        {
          criterionElementId: "criterion-one",
          disposition: "in_scope",
          deliveredByExecutionId: null,
        },
      ],
      claims: [
        {
          contextId: "context-implement",
          criterionElementIds: ["criterion-one"],
        },
      ],
    },
  }).binding;
}

function manifest() {
  const planBinding = binding();
  return deliveryPlanCandidateManifestV3Schema.parse({
    protocol: "native-sdd-delivery-candidate/v3",
    schemaVersion: 3,
    specId: "spec-one",
    attemptId: "workflow-one",
    candidateId: "workflow-one",
    pinnedRevisionId: "revision-one",
    draftRevision: 4,
    workflowDefinition: {
      id: "workflow-one",
      revision: 7,
      definitionHash: workflowDefinitionHash(createWorkflowDefinitionRecord()),
    },
    binding: planBinding,
    bindingHash: deliveryPlanBindingHash(planBinding),
  });
}

describe("delivery plan version-3 hashes", () => {
  it("hashes only authored workflow draft fields", () => {
    const first = createWorkflowDefinitionRecord();
    const recordOnlyChange = {
      ...first,
      id: "workflow-other",
      revision: first.revision + 1,
      createdAt: "2026-08-31T12:00:00.000Z",
      updatedAt: "2026-08-31T12:01:00.000Z",
    };

    expect(workflowDefinitionHash(recordOnlyChange)).toBe(
      workflowDefinitionHash(first),
    );
    expect(
      workflowDefinitionHash({ ...first, name: "Changed workflow" }),
    ).not.toBe(workflowDefinitionHash(first));
  });

  it("hashes binding bytes independently from workflow identity", () => {
    const first = binding();
    const changed = structuredClone(first);
    changed.claims[0]!.contextId = "context-verify";

    expect(deliveryPlanBindingHash(changed)).not.toBe(
      deliveryPlanBindingHash(first),
    );
  });

  it("hashes the complete immutable candidate manifest", () => {
    const first = manifest();
    const changed = {
      ...first,
      workflowDefinition: {
        ...first.workflowDefinition,
        revision: first.workflowDefinition.revision + 1,
      },
    };

    expect(deliveryPlanCandidateHash(first)).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(deliveryPlanCandidateHash(changed)).not.toBe(
      deliveryPlanCandidateHash(first),
    );
  });
});
