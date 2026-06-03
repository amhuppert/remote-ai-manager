/**
 * Pure mode router for the unified composer. Classifies the current draft into
 * one of three input modes the cockpit composer routes by leading content:
 *
 * - `command` — the draft begins with `/` (opens the command palette).
 * - `filter`  — the draft begins with a recognized filter key followed by `:`
 *               (`is`, `status` [alias of `is`], `target`, `branch`, `archived`),
 *               including the trailing-colon-no-value case (e.g. `is:`).
 * - `chat`    — anything else (prompt the active conversation).
 *
 * This is intentionally dependency-free and side-effect-free so it can be unit
 * tested directly and called on every keystroke. It only decides the *mode*
 * (which drives the mode-chip color and routing); tokenization of a filter
 * value is owned by `filter-tokens` / `computeSuggestions`.
 */
export type ComposerMode = "chat" | "command" | "filter";

const FILTER_KEY = /^(is|status|target|branch|archived):/i;

export function detectComposerMode(draft: string): ComposerMode {
  const trimmed = draft.trim();
  if (trimmed.startsWith("/")) return "command";
  if (FILTER_KEY.test(trimmed)) return "filter";
  return "chat";
}
