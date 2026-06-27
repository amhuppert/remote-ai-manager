import type { ParsedConversationCommand } from "./schemas";

const COMMANDS = ["commit", "merge", "align"] as const;

/**
 * Detect `/commit`, `/merge`, or `/align` as a whole-message conversation
 * command. The command must be the entire trimmed message or followed by
 * whitespace plus optional hint text (mirrors `hasCollabPrefix` semantics).
 * Returns null for non-command text, including near-misses like `/committed`
 * and mid-message occurrences.
 */
export function parseConversationCommand(
  text: string,
): ParsedConversationCommand | null {
  const trimmed = text.trimStart();
  for (const command of COMMANDS) {
    const prefix = `/${command}`;
    if (trimmed === prefix) return { command, hint: "" };
    if (
      trimmed.startsWith(prefix) &&
      /^\s/.test(trimmed.slice(prefix.length))
    ) {
      return { command, hint: trimmed.slice(prefix.length).trim() };
    }
  }
  return null;
}
