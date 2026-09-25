import { createHash } from "node:crypto";

import { stableStringify } from "@/lib/state-store/serialization";
import { computeSpecRevisionContentHash } from "@/lib/state-store/specs-repo";

import type { SpecRevisionSnapshot } from "./schemas";

/**
 * The token a human review act echoes back. It changes whenever the draft's
 * elements or assumption citations change, so an approval or sign-off refuses
 * content the human did not read — the author keeps editing the same draft
 * while it is reviewed.
 */
export function revisionReviewHash(snapshot: SpecRevisionSnapshot): string {
  return createHash("sha256")
    .update(
      stableStringify({
        contentHash: computeSpecRevisionContentHash(
          snapshot.revision.authoringStage,
          snapshot.elements,
        ),
        citationContractVersion: snapshot.revision.citationContractVersion,
        citationHash: snapshot.revision.citationHash,
      }),
    )
    .digest("hex");
}
