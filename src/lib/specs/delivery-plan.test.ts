import { describe, expect, it } from "vitest";

import {
  canonicalDeliveryPlanEnvelopeBytes,
  DELIVERY_PLAN_ENVELOPE_MAX_BYTES,
  deliveryPlanCandidateManifestV3Schema,
  deliveryPlanCandidateRecordSchema,
  deliveryPlanDocumentSchema,
} from "./delivery-plan";

const binding = {
  dispositions: [
    {
      criterionElementId: "criterion-one",
      disposition: "in_scope" as const,
      deliveredByExecutionId: null,
    },
  ],
  claims: [
    {
      contextId: "context-implement",
      criterionElementIds: ["criterion-one"],
    },
  ],
};

describe("version-4 delivery plan contracts", () => {
  it("stores dispositions in the draft and freezes derived claims only in the candidate", () => {
    const document = {
      schemaVersion: 4,
      binding: { dispositions: binding.dispositions },
    };
    const parsed = deliveryPlanDocumentSchema.safeParse(document);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(document);
    const candidate = {
      protocol: "native-sdd-delivery-candidate/v4",
      schemaVersion: 4,
      specId: "spec-one",
      attemptId: "attempt-one",
      candidateId: "workflow-one",
      pinnedRevisionId: "revision-one",
      draftRevision: 1,
      workflowDefinition: {
        id: "workflow-one",
        revision: 2,
        definitionHash: `sha256:${"a".repeat(64)}`,
      },
      binding: document.binding,
      claims: binding.claims,
      bindingHash: `sha256:${"b".repeat(64)}`,
    };
    const manifest = deliveryPlanCandidateRecordSchema.safeParse(candidate);
    expect(manifest.success).toBe(true);
    expect(manifest.data).toEqual(candidate);
  });

  it("refuses authored claims on a v4 binding with the covers remedy", () => {
    const parsed = deliveryPlanDocumentSchema.safeParse({
      schemaVersion: 4,
      binding,
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("covers");
  });
});

describe("version-3 delivery plan contracts", () => {
  it("round-trips deterministic binding-only draft bytes", () => {
    const document = deliveryPlanDocumentSchema.parse({
      schemaVersion: 3,
      binding,
    });

    expect(document).toEqual({ schemaVersion: 3, binding });
    expect(canonicalDeliveryPlanEnvelopeBytes(document)).toBe(
      canonicalDeliveryPlanEnvelopeBytes({ schemaVersion: 3, binding }),
    );
  });

  it("rejects graph content from a plan edit", () => {
    expect(
      deliveryPlanDocumentSchema.safeParse({
        schemaVersion: 3,
        binding,
        launch: { name: "Graph bytes do not belong here" },
      }).success,
    ).toBe(false);
  });

  it("round-trips a manifest that references exact workflow bytes", () => {
    const manifest = deliveryPlanCandidateManifestV3Schema.parse({
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
        definitionHash: `sha256:${"a".repeat(64)}`,
      },
      binding,
      bindingHash: `sha256:${"b".repeat(64)}`,
    });

    expect(manifest.workflowDefinition).toEqual({
      id: "workflow-one",
      revision: 7,
      definitionHash: `sha256:${"a".repeat(64)}`,
    });
    expect(manifest).not.toHaveProperty("document");
    expect(manifest).not.toHaveProperty("launch");
  });

  it("requires candidate and workflow definition identity to match", () => {
    const parsed = deliveryPlanCandidateManifestV3Schema.safeParse({
      protocol: "native-sdd-delivery-candidate/v3",
      schemaVersion: 3,
      specId: "spec-one",
      attemptId: "attempt-one",
      candidateId: "candidate-one",
      pinnedRevisionId: "revision-one",
      draftRevision: 1,
      workflowDefinition: {
        id: "different-definition",
        revision: 1,
        definitionHash: `sha256:${"a".repeat(64)}`,
      },
      binding,
      bindingHash: `sha256:${"b".repeat(64)}`,
    });

    expect(parsed.success).toBe(false);
  });

  it("bounds the complete binding document", () => {
    const parsed = deliveryPlanDocumentSchema.safeParse({
      schemaVersion: 3,
      binding: {
        ...binding,
        claims: [
          {
            contextId: "x".repeat(DELIVERY_PLAN_ENVELOPE_MAX_BYTES),
            criterionElementIds: ["criterion-one"],
          },
        ],
      },
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues).toContainEqual(
      expect.objectContaining({ path: [] }),
    );
  });

  it("rejects version-2 application documents", () => {
    expect(
      deliveryPlanDocumentSchema.safeParse({
        schemaVersion: 2,
        launch: {},
        binding,
      }).success,
    ).toBe(false);
  });
});
