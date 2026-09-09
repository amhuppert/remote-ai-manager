/**
 * Safe log identity for an opaque provider continuation reference.
 *
 * A backend reference (a Claude session id, a Codex thread id) is the handle
 * that addresses a provider-side conversation. It belongs in the conversation
 * row and in protected evidence, never in an ordinary log: the log files are a
 * public identity surface, and a reference read out of one addresses the
 * provider session directly.
 *
 * The digest keeps what a diagnostic actually needs — whether two turns ran
 * against the same reference, and whether a reference changed across a
 * checkpoint — without carrying the reference itself.
 */

import { createHash } from "node:crypto";

/**
 * `sha256:<hex>` of `ref`, or null when there is no reference to describe.
 *
 * The full digest is deliberate: protected probe evidence and checkpoint
 * receipts record provider references the same way, so an operator can join a
 * log line to a receipt without either surface holding the raw value.
 */
export function providerRefDigest(
  ref: string | null | undefined,
): string | null {
  if (ref === null || ref === undefined || ref === "") return null;
  return `sha256:${createHash("sha256").update(ref, "utf-8").digest("hex")}`;
}
