/**
 * Shared command parsing utilities for detecting slash commands
 * in user message text.
 *
 * Extracted from transcript.ts to allow client-side reuse
 * (this module has no server-only dependencies).
 */

import type { MessageContentBlock } from "@/lib/conversations/schemas";
/** XML-tagged commands from prompt templates */
const COMMAND_NAME_RE = /<command-name>\/?(.+?)<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;

/**
 * Pattern that matches plain text slash commands typed by users.
 * Example: "/spec voice-transcription-integration"
 * Requires the message to start with "/" followed by a command name
 * (letters, digits, colons, hyphens).
 */
const PLAIN_COMMAND_RE = /^\/([a-zA-Z][\w:-]*)(?:\s+([\s\S]*))?$/;

/**
 * Try to parse a command invocation from a user message's string content.
 * Detects both XML-tagged commands (from prompt templates) and plain text
 * slash commands typed directly by users.
 * Returns a command content block if the message is a slash command, null otherwise.
 */
export function parseCommandContent(
  content: string,
): MessageContentBlock | null {
  // First try XML-tagged commands (from prompt templates like focus mode)
  const nameMatch = content.match(COMMAND_NAME_RE);
  if (nameMatch) {
    const name = nameMatch[1]!;
    const argsMatch = content.match(COMMAND_ARGS_RE);
    const args = argsMatch?.[1]?.trim() || null;
    return { type: "command" as const, name: `/${name}`, args };
  }

  // Then try plain text slash commands (e.g., "/commit", "/spec feature")
  const plainMatch = content.trim().match(PLAIN_COMMAND_RE);
  if (plainMatch) {
    const name = plainMatch[1]!;
    const args = plainMatch[2]?.trim() || null;
    return { type: "command" as const, name: `/${name}`, args };
  }

  return null;
}
