import { describe, expect, it } from "vitest";

import { candidateClaimsDocumentPath } from "./delivery-plan-finalization";
import { buildSpecExecutionClaimsDocument } from "./execution-claims-document";
import type { SpecExecutionBindingSnapshotV2 } from "./execution-binding";
import { buildSpecOwnershipProjection } from "./spec-ownership-projection";
import type { SpecRevisionSnapshot } from "./schemas";

const binding: SpecExecutionBindingSnapshotV2 = {
  schemaVersion: 2,
  candidateId: "candidate-claims-document",
  candidateHash: `sha256:${"a".repeat(64)}`,
  pinnedRevisionId: "revision-claims-document",
  dispositions: [
    {
      criterionElementId: "criterion-selected",
      disposition: "in_scope",
      deliveredByExecutionId: null,
    },
    {
      criterionElementId: "criterion-external",
      disposition: "delivered_elsewhere",
      deliveredByExecutionId: "execution-earlier",
    },
  ],
  claims: [
    {
      contextId: "context-spawner",
      criterionElementIds: ["criterion-selected"],
    },
    {
      contextId: "context-integrate",
      criterionElementIds: ["criterion-selected"],
    },
  ],
};

const NOW = "2026-08-15T12:00:00.000Z";
const snapshot: SpecRevisionSnapshot = {
  revision: {
    id: binding.pinnedRevisionId,
    specId: "spec-claims-document",
    number: 1,
    state: "approved",
    authoringStage: "plan",
    basedOnRevisionId: null,
    contentHash: "sha256:claims-document",
    proposedAt: NOW,
    approvedAt: NOW,
    externalDelivery: null,
    createdAt: NOW,
  },
  elements: binding.dispositions.map((disposition, index) => ({
    element: {
      id: disposition.criterionElementId,
      specId: "spec-claims-document",
      kind: "criterion" as const,
      number: index + 1,
      parentElementId: null,
      createdAt: NOW,
    },
    version: {
      revisionId: binding.pinnedRevisionId,
      elementId: disposition.criterionElementId,
      position: index,
      payload: {
        kind: "criterion" as const,
        text: `Brief for ${disposition.criterionElementId}.`,
        validationStrategy: { kinds: ["test_run" as const] },
      },
      payloadHash: `sha256:${disposition.criterionElementId}`,
      elementVersion: 1,
      createdAt: NOW,
      updatedAt: NOW,
    },
  })),
};

describe("spec execution claims document", () => {
  it("renders one deterministic candidate-specific document from the frozen binding", () => {
    const projection = buildSpecOwnershipProjection(binding, snapshot);
    const document = buildSpecExecutionClaimsDocument(projection);

    expect(document).toEqual({
      relativePath: candidateClaimsDocumentPath(binding.candidateId),
      contents: `# Spec ownership (authoritative)

- Candidate: \`candidate-claims-document\`
- Candidate hash: \`sha256:${"a".repeat(64)}\`
- Pinned revision: \`revision-claims-document\`

This immutable binding is the authority for criterion ownership. A claimant is accountable for delivery; it need not perform every implementation step itself.

| Criterion id | Brief guidance | Disposition | Delivered by execution | Claimant context ids | Validation guidance |
| --- | --- | --- | --- | --- | --- |
| \`criterion-selected\` | Brief for criterion-selected. | \`in_scope\` | — | \`context-spawner\`, \`context-integrate\` | Pinned validation guidance only (not an evidence checklist): \`test_run\` |
| \`criterion-external\` | Brief for criterion-external. | \`delivered_elsewhere\` | \`execution-earlier\` | — | Pinned validation guidance only (not an evidence checklist): \`test_run\` |
`,
      description:
        "The immutable native SDD criterion dispositions and authored-context claims for candidate candidate-claims-document.",
      readWhen:
        "Read before implementing or validating spec-owned work; these frozen claims identify which authored contexts own each criterion.",
    });
    expect(
      buildSpecExecutionClaimsDocument(
        buildSpecOwnershipProjection(
          structuredClone(binding),
          structuredClone(snapshot),
        ),
      ),
    ).toEqual(document);
  });
});
