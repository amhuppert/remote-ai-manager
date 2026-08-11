import { createHash } from "node:crypto";

import { stableStringify } from "@/lib/state-store/serialization";

import type { DeliveryPlanDocument } from "./delivery-plan";

/**
 * Plan-proposal identity, kept apart from `./delivery-plan` so that module
 * stays free of `node:crypto`: its schemas and document vocabulary are read by
 * the review surfaces, and a browser bundle cannot carry the builtin.
 */

export interface DeliveryPlanHashInput {
  readonly pinnedRevisionId: string;
  /** The attempt draft revision the proposal froze. */
  readonly draftRevision: number;
  readonly document: DeliveryPlanDocument;
}

/**
 * The identity of one plan proposal, which is what an approval is granted
 * against. Three things make it up:
 *
 * - the document, so any authored change is a different plan;
 * - the pinned revision, because the same contexts against a different
 *   revision are a different plan — dispositions name criteria whose text
 *   lives in that revision;
 * - the attempt's draft revision, because a reopen invalidates the approval
 *   and the re-propose that follows must require a new one even when the
 *   author put back byte-identical content.
 *
 * A stable stringify makes the hash independent of the key order a caller's
 * JSON happened to carry.
 */
export function deliveryPlanHash(input: DeliveryPlanHashInput): string {
  const digest = createHash("sha256")
    .update(
      stableStringify({
        pinnedRevisionId: input.pinnedRevisionId,
        draftRevision: input.draftRevision,
        document: input.document,
      }),
    )
    .digest("hex");
  return `sha256:${digest}`;
}
