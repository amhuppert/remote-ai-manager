import { createHash } from "node:crypto";

import { truncate } from "@/lib/shared/truncate";

// Canonical worktree mirror location for the active charter (R7/R8). The
// service materializes the full charter here on activation; the digest path
// points agents at this file for the untruncated content.
export const ALIGNMENT_DOCUMENT_PATH = ".cc/session-alignment/charter.md";

// Character budget below which the whole charter is inlined into the governing
// section. Above it, only a bounded head digest is injected plus a pointer to
// the full mirror file — keeping the per-turn system prompt bounded for large
// charters (R7.2/R7.4). Chosen as a generous small-charter ceiling: most
// session charters (mission + a handful of decisions/constraints) fit inline.
export const ALIGNMENT_INLINE_THRESHOLD = 4000;

// Characters of the charter body kept in the digest head excerpt. The full
// untruncated content lives at ALIGNMENT_DOCUMENT_PATH; the digest is a compact
// orientation excerpt, not the whole charter.
const DIGEST_BODY_BUDGET = 1200;

// Governing preamble stating the charter's authority and conflict-resolution
// rule (R7.1, R7.4). Present in both the inline and digest paths so every turn
// receives the same governing framing regardless of charter size.
const GOVERNING_PREAMBLE = [
  "# Session Alignment (governing context)",
  "This Alignment charter governs the session. It is stronger than passive reference documents: treat it as authoritative shared context for every conversation in this session. When guidance conflicts, conflicts resolve via the charter's stated hierarchy or its active decisions.",
].join("\n");

/**
 * Single per-turn instruction injected when an attended normal session has no
 * active Alignment charter (R2.5). It nudges the agent to suggest the user run
 * `/align` to capture shared context — the agent only *suggests*; there is no
 * agent-proposed-creation tool or card.
 */
export const ALIGN_SUGGESTION_INSTRUCTIONS = [
  "This session has no shared Alignment charter yet. If durable shared context (mission, key decisions, constraints, non-goals) would help the work, suggest that the user run `/align` to capture it. Do not create or assume a charter yourself; only the user can establish one.",
].join("\n");

/**
 * Soft-scaffold first-charter template (R3.2). Free-text markdown headings the
 * agent may adapt, restructure, or remove — not a required schema. Contains the
 * six scaffold sections: Mission, Decisions, Constraints, Non-goals, Known
 * ambiguities, Relevant sources.
 */
export const SCAFFOLD_TEMPLATE = [
  "## Mission",
  "",
  "## Decisions",
  "",
  "## Constraints",
  "",
  "## Non-goals",
  "",
  "## Known ambiguities",
  "",
  "## Relevant sources",
  "",
].join("\n");

export interface RenderAlignmentInput {
  /** The active charter's free-text markdown content. */
  content: string;
  /** Worktree path of the full mirror file the digest pointer references. */
  filePath?: string;
}

/**
 * The governing injection for the active charter, composable with the service's
 * `getActiveInjection`. `text` is the exact section injected into the system
 * prompt; `version`/`contentHash` let the service gate runtime recreation and
 * stale detection without re-rendering.
 */
export interface AlignmentInjection {
  version: number;
  contentHash: string;
  text: string;
}

/**
 * Whether a charter of this size renders as a digest that dereferences a file
 * rather than inlining its whole content. Callers that must materialize the
 * file the pointer targets ask here instead of re-deriving the threshold.
 */
export function usesDigestPointer(content: string): boolean {
  return content.length > ALIGNMENT_INLINE_THRESHOLD;
}

/**
 * Render the governing-context section for an active charter. Below
 * ALIGNMENT_INLINE_THRESHOLD the full content is inlined; above it, a bounded
 * head digest plus an explicit read-the-full-file pointer is emitted. Both
 * paths carry the governing preamble (R7.1–R7.4).
 */
export function renderAlignmentPromptSection(
  input: RenderAlignmentInput,
): string {
  const { content } = input;
  const filePath = input.filePath ?? ALIGNMENT_DOCUMENT_PATH;

  if (!usesDigestPointer(content)) {
    return [GOVERNING_PREAMBLE, content].join("\n\n");
  }

  return [
    GOVERNING_PREAMBLE,
    "## Charter digest (excerpt)",
    truncate(content, DIGEST_BODY_BUDGET, {
      countEllipsisInBudget: true,
      trimEnd: true,
    }),
    `This is a digest. Read the full charter at \`${filePath}\` for the complete governing content.`,
  ].join("\n\n");
}

/**
 * Normalize free-text so trivially-different whitespace hashes identically:
 * CRLF→LF, strip per-line trailing whitespace, collapse 3+ blank lines to one
 * blank line, and trim leading/trailing blank lines. The hash defines the
 * version boundary (R8), so two charters that differ only in incidental
 * whitespace are the same version.
 */
function normalizeContent(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

/** Deterministic sha256 hex digest over normalized free-text content. */
export function computeAlignmentHash(content: string): string {
  return createHash("sha256").update(normalizeContent(content)).digest("hex");
}
