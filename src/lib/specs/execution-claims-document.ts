import type { SeededWorkflowDocument } from "@/lib/workflow-graph/spec-bridge";
import { renderGraphRolePromptProjection } from "@/lib/workflow-graph/prompt-composer";

import { candidateClaimsDocumentPath } from "./delivery-plan-finalization";
import type { SpecOwnershipProjection } from "./spec-ownership-projection";

/**
 * Renders the human-readable ownership map from the immutable execution
 * binding only. Graph runtime state is intentionally absent from the input so
 * live edits, loop passes, and expanded contexts cannot change these bytes.
 */
export function buildSpecExecutionClaimsDocument(
  projection: SpecOwnershipProjection,
): SeededWorkflowDocument {
  return {
    relativePath: candidateClaimsDocumentPath(projection.candidateId),
    contents: `${renderGraphRolePromptProjection(projection)}\n`,
    description: `The immutable native SDD criterion dispositions and authored-context claims for candidate ${projection.candidateId}.`,
    readWhen:
      "Read before implementing or validating spec-owned work; these frozen claims identify which authored contexts own each criterion.",
  };
}
