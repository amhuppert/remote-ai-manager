/**
 * Advisory-only assists on a successful capture (spec R9, D8): a vague-hook
 * warning and the lexical query behind overlap candidates. Nothing here can
 * refuse a write; the service returns what these produce beside the note.
 */

/**
 * A hook is one index line. Past this many characters it is a paragraph that
 * belongs in the body, and the index budget pays for every character of it.
 */
export const MEMORY_HOOK_ADVISORY_MAX_CHARS = 250;

/** Fewer words than this cannot state a fact — they name a topic. */
const MIN_FACT_BEARING_WORDS = 4;

/**
 * Openers that label a subject rather than assert something about it. `re:`
 * needs its colon because "Re-running the build wipes .next" is a fact.
 */
const TOPIC_LABEL_OPENER =
  /^(?:(?:notes?|about|regarding|misc|todo|thoughts?|ideas?)\b|re:)/i;

/** A hook that ends on a colon or dash is a heading awaiting its content. */
const TRAILING_LABEL_PUNCTUATION = /[:\-–—]$/;

export type MemoryHookWarningCode = "hook_too_long" | "hook_topic_only";

export interface MemoryHookWarning {
  readonly code: MemoryHookWarningCode;
  readonly message: string;
}

/**
 * Deterministic heuristics, not a language model: the warning is advice the
 * static contract already gives ("a one-line fact-bearing hook"), surfaced at
 * the moment the agent can still act on it.
 */
export function assessMemoryHook(hook: string): MemoryHookWarning[] {
  const trimmed = hook.trim();
  const warnings: MemoryHookWarning[] = [];

  if (trimmed.length > MEMORY_HOOK_ADVISORY_MAX_CHARS) {
    warnings.push({
      code: "hook_too_long",
      message: `The hook is ${trimmed.length} characters; a hook states one fact in a line under ${MEMORY_HOOK_ADVISORY_MAX_CHARS} characters, so move the detail into the body.`,
    });
  }

  const words = trimmed.split(/\s+/).filter((word) => word !== "");
  const topicOnly =
    words.length < MIN_FACT_BEARING_WORDS ||
    TOPIC_LABEL_OPENER.test(trimmed) ||
    TRAILING_LABEL_PUNCTUATION.test(trimmed);
  if (topicOnly) {
    warnings.push({
      code: "hook_topic_only",
      message:
        "The hook names a topic without stating a fact; write what is true (what breaks, what to do, what holds) so the index line stands on its own.",
    });
  }

  return warnings;
}

/** Shortest token worth matching on: below this, hits are function words. */
const MIN_OVERLAP_TOKEN_LENGTH = 4;

/**
 * Function words at or above the length floor. The FTS5 index has no stopword
 * list, so without this every hook containing "with" overlaps every other.
 */
const OVERLAP_STOPWORDS: ReadonlySet<string> = new Set([
  "about",
  "after",
  "again",
  "also",
  "always",
  "before",
  "been",
  "being",
  "between",
  "both",
  "does",
  "each",
  "every",
  "from",
  "have",
  "having",
  "here",
  "into",
  "just",
  "more",
  "most",
  "must",
  "never",
  "only",
  "other",
  "over",
  "same",
  "should",
  "since",
  "some",
  "still",
  "such",
  "than",
  "that",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "under",
  "until",
  "very",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "will",
  "with",
  "within",
  "without",
  "would",
  "your",
]);

/**
 * The lexical query overlap candidates are searched with: the hook's and
 * aliases' content words, deduplicated. Null when nothing is worth searching,
 * so a hook of function words produces no candidates rather than every note.
 */
export function memoryOverlapQuery(
  hook: string,
  aliases: readonly string[],
): string | null {
  const tokens = [hook, ...aliases]
    .join(" ")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(
      (token) =>
        token.length >= MIN_OVERLAP_TOKEN_LENGTH &&
        !OVERLAP_STOPWORDS.has(token),
    );
  const unique = [...new Set(tokens)];
  return unique.length === 0 ? null : unique.join(" ");
}
