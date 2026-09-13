import type { ParsedConversationCommand } from "./schemas";

const COMMANDS = ["commit", "merge", "rebase", "align", "ticket"] as const;

/**
 * `/collab` is dispatched by the collaboration manager rather than the
 * conversation-command dispatcher, so it is matched separately — but it is the
 * same surface syntax and shares the matcher below.
 */
const COLLAB = "collab";

/**
 * Match a leading `/<name>` slash command, returning the text that follows it.
 *
 * The separator between the command and its argument is any single whitespace
 * character, not just a space: a composer message whose body starts on the line
 * below the command (`/collab\nbrief…`) is the same invocation as
 * `/collab brief…`, and treating it as ordinary prompt text sends a bare
 * `/collab` line to the agent, which rejects it as an unknown command.
 *
 * Returns null for non-command text, including near-misses like `/committed`
 * and mid-message occurrences.
 */
function matchSlashCommand(
  text: string,
  name: string,
): { rest: string } | null {
  const trimmed = text.trimStart();
  const prefix = `/${name}`;
  if (trimmed === prefix) return { rest: "" };
  if (!trimmed.startsWith(prefix)) return null;
  if (!/^\s/.test(trimmed.slice(prefix.length))) return null;
  // Consume the single separator character only; any further whitespace belongs
  // to the argument and is the caller's to trim or keep.
  return { rest: trimmed.slice(prefix.length + 1) };
}

/**
 * Detect `/commit`, `/merge`, `/rebase`, `/align`, or `/ticket` as a
 * whole-message conversation command. The command must be the entire trimmed
 * message or followed by whitespace plus optional hint text.
 */
export function parseConversationCommand(
  text: string,
): ParsedConversationCommand | null {
  for (const command of COMMANDS) {
    const match = matchSlashCommand(text, command);
    if (!match) continue;
    const hint = match.rest.trim();
    if (command === "merge" && /^--no-mark-merged(?:\s|$)/.test(hint)) {
      return {
        command,
        hint: hint.slice("--no-mark-merged".length).trim(),
        skipMarkMerged: true,
      };
    }
    return { command, hint };
  }
  return null;
}

/** True when the message invokes `/collab` (with or without a brief). */
export function hasCollabPrefix(text: string): boolean {
  return matchSlashCommand(text, COLLAB) !== null;
}

/**
 * The `/collab` brief: everything after the command and its single separator
 * character. Returns the leading-trimmed input unchanged when the message is
 * not a `/collab` invocation.
 */
export function stripCollabPrefix(text: string): string {
  return matchSlashCommand(text, COLLAB)?.rest ?? text.trimStart();
}
