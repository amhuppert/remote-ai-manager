import { createHash } from "node:crypto";

import type { ContentHash } from "./schemas";

/**
 * The persisted content hash for profile provenance: `sha256:<lowercase hex>`
 * over NFC-normalized UTF-8.
 *
 * Two hashes use this one util and each covers bytes that persist:
 * `sourceContentHash` covers a library record's instruction content exactly as
 * stored, and `resolvedInstructionHash` covers a snapshot's stored rendered
 * block exactly as delivered. Normalization is NFC only — canonically
 * equivalent Unicode spellings of the same text agree, while whitespace and
 * casing are content and change the hash.
 *
 * Lives apart from `./schemas` so client-side schema consumers (profile
 * pickers, forms) never pull node:crypto into the browser bundle; the envelope
 * FORMAT is `contentHashSchema` there.
 */
export function computeContentHash(content: string): ContentHash {
  const digest = createHash("sha256")
    .update(content.normalize("NFC"), "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}
