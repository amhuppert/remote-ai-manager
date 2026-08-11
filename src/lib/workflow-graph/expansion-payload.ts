import { createHash } from "node:crypto";

import { stableStringify } from "@/lib/state-store/serialization";

/**
 * Canonicalization, identity, and size for a parsed expansion request — the
 * three facts the expansion service measures a request by.
 *
 * They live apart from `./expansion-receipts` so the receipts ledger stays free
 * of `node:crypto` and `Buffer`: the graph UI reads that ledger to attribute
 * generated nodes to the request that added them, and a browser bundle cannot
 * carry either.
 */

/**
 * The canonical JSON form of a parsed expansion request. Key order is
 * normalized recursively, so the hash identifies the request's CONTENT rather
 * than the byte layout the lane's serializer happened to produce.
 */
export function expansionCanonicalPayload(request: object): string {
  return stableStringify(request);
}

/** The identity of a canonicalized request: lowercase SHA-256 hex. */
export function expansionPayloadHash(canonicalPayload: string): string {
  return createHash("sha256").update(canonicalPayload, "utf8").digest("hex");
}

/** Canonical payload size in UTF-8 bytes — what the 64 KB cap measures. */
export function expansionCanonicalByteLength(canonicalPayload: string): number {
  return Buffer.byteLength(canonicalPayload, "utf8");
}
