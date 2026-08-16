import { createHash } from "node:crypto";

import {
  canonicalDeliveryPlanCandidateBytes,
  type DeliveryPlanCandidateRecord,
} from "./delivery-plan";

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
  candidate: DeliveryPlanCandidateRecord,
): string {
  return deliveryPlanCandidateHashFromBytes(
    canonicalDeliveryPlanCandidateBytes(candidate),
  );
}

export function deliveryPlanCandidateHashFromBytes(
  candidateBytes: string,
): string {
  const digest = createHash("sha256").update(candidateBytes).digest("hex");
  return `sha256:${digest}`;
}
