import { createHash } from "node:crypto";

import type {
  WorkflowDefinitionDraft,
  WorkflowDefinitionRecord,
} from "@/lib/workflow-graph/definition-schemas";
import { stableStringify } from "@/lib/state-store/serialization";
import {
  canonicalDeliveryPlanCandidateBytes,
  type DeliveryPlanBinding,
  type DeliveryPlanCandidateRecord,
  type DeliveryPlanCandidateManifestV3,
} from "./delivery-plan";

function sha256(value: string): string {
  const digest = createHash("sha256").update(value).digest("hex");
  return `sha256:${digest}`;
}

export function workflowDefinitionHash(
  workflow: WorkflowDefinitionDraft | WorkflowDefinitionRecord,
): string {
  return sha256(
    stableStringify({
      name: workflow.name,
      description: workflow.description,
      definition: workflow.definition,
      layout: workflow.layout,
    }),
  );
}

export function deliveryPlanBindingHash(binding: DeliveryPlanBinding): string {
  return sha256(stableStringify(binding));
}

/**
 * Candidate identity, kept apart from `./delivery-plan` so that module stays
 * free of `node:crypto`: its schemas and document vocabulary are read by the
 * review surfaces, and a browser bundle cannot carry the builtin.
 *
 * The hash covers the whole frozen candidate record — pinned revision, draft
 * revision, and finalized envelope alike — so any authored change, any reopen,
 * and any different pinned revision is a different candidate to sign.
 */
export function deliveryPlanCandidateHash(
  candidate: DeliveryPlanCandidateRecord | DeliveryPlanCandidateManifestV3,
): string {
  return deliveryPlanCandidateHashFromBytes(
    canonicalDeliveryPlanCandidateBytes(candidate),
  );
}

export function deliveryPlanCandidateHashFromBytes(
  candidateBytes: string,
): string {
  return sha256(candidateBytes);
}
