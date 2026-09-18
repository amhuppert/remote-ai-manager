/**
 * Fixed seed budgets and the UTF-8 arithmetic that enforces them.
 *
 * Every limit is a byte count of the FINAL rendered string, section markup and
 * separators included, because the seed is injected verbatim: a limit measured
 * in JavaScript string length or estimated tokens would be a different promise
 * from the one the checkpoint makes.
 */

/** Bumped when section layout or these limits change. Recorded in the payload. */
export const CHECKPOINT_BUILDER_VERSION = "2";

/**
 * Initial fixed product defaults. The three sections partition the total
 * exactly, so a seed whose sections each fit is within the total by
 * construction — there is no retention tuning or preview in this slice.
 */
export const CHECKPOINT_SEED_BUDGET = {
  workingState: 18_432,
  recentDialogue: 10_240,
  recoveryFraming: 4_096,
  total: 32_768,
} as const;

export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Longest prefix of `text` that fits in `maxBytes` UTF-8 bytes without
 * splitting a code point. Iterating code points (not UTF-16 units) is what
 * keeps a surrogate pair — an emoji, an astral-plane character — whole rather
 * than emitting a lone half that no longer decodes.
 */
export function truncateToUtf8Bytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (utf8ByteLength(text) <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const codePoint of text) {
    const cost = utf8ByteLength(codePoint);
    if (bytes + cost > maxBytes) break;
    bytes += cost;
    end += codePoint.length;
  }
  return text.slice(0, end);
}

/** Fixed capture limits; adapters enforce these independently of seed budgets. */
export const CHECKPOINT_CAPTURE_POLICY_VERSION = "1";
export const CHECKPOINT_CAPTURE_LIMITS = Object.freeze({
  maxSubmissions: 1,
  executionMs: 60_000,
  settlementMs: 5_000,
  inputBytes: 8_192,
  outputBytes: 6_144,
  nativeInspectionBytes: 8_388_608,
  nativeInspectionMs: 2_000,
} as const satisfies import("@/lib/agent-backends/schemas").CaptureLimits);
