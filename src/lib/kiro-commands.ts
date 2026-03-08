/**
 * Kiro SDD command detection and utility functions.
 *
 * Used to detect Kiro commands in assistant response text and
 * build prompt strings for running them.
 */

/**
 * Regex for detecting Kiro commands in flowing text (text nodes).
 * Only matches the command name — does NOT try to capture args from prose
 * because it's impossible to reliably delimit args in flowing text.
 *
 * For full command+args parsing (e.g., from inline code), use parseKiroCommand.
 *
 * Captures: [1]=command suffix (e.g. "spec-design")
 */
export const KIRO_COMMAND_RE = /\/kiro:([\w-]+)/g;

/**
 * Regex for parsing a full Kiro command string (including args).
 * Used for inline code content where boundaries are clear (backtick-delimited).
 *
 * Captures: [1]=command suffix, [2]=args or undefined
 */
const KIRO_FULL_COMMAND_RE = /^\/kiro:([\w-]+)(?:\s+(.+))?$/;

/** Commands that accept the -y (auto-approve) flag */
const AUTO_APPROVE_COMMANDS: ReadonlySet<string> = new Set([
  "spec-design",
  "spec-tasks",
  "spec-impl",
]);

export interface KiroCommandMatch {
  commandName: string; // e.g. "/kiro:spec-design"
  args: string | null; // e.g. "feature-name" (null for text-node matches)
  fullText: string; // the matched text
  startIndex: number;
  endIndex: number;
}

/** Find all Kiro command matches in a text string (command name only, no args) */
export function findKiroCommands(text: string): KiroCommandMatch[] {
  const results: KiroCommandMatch[] = [];
  const re = new RegExp(KIRO_COMMAND_RE.source, KIRO_COMMAND_RE.flags);
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    const commandSuffix = match[1]!;
    const fullText = match[0]!;

    results.push({
      commandName: `/kiro:${commandSuffix}`,
      args: null,
      fullText,
      startIndex: match.index,
      endIndex: match.index + fullText.length,
    });
  }

  return results;
}

/**
 * Parse a full Kiro command string into structured data.
 * Works with delimited content (e.g., from inline code blocks).
 * Returns null if the input is not a Kiro command.
 */
export function parseKiroCommand(
  input: string,
): Omit<KiroCommandMatch, "startIndex" | "endIndex"> | null {
  const trimmed = input.trim();
  const match = trimmed.match(KIRO_FULL_COMMAND_RE);
  if (!match) return null;

  const commandSuffix = match[1]!;
  const rawArgs = match[2]?.trim() ?? null;

  // Strip trailing -y / --sequential from args (user controls these via popover)
  const args = rawArgs
    ? rawArgs.replace(/\s+(?:-y|--sequential)$/g, "").trim() || null
    : null;

  return {
    commandName: `/kiro:${commandSuffix}`,
    args,
    fullText: trimmed,
  };
}

/** Check if a command name supports the -y (auto-approve) flag */
export function supportsAutoApprove(commandName: string): boolean {
  const suffix = commandName.replace(/^\/kiro:/, "");
  return AUTO_APPROVE_COMMANDS.has(suffix);
}

/** Build the full command string to send as a prompt */
export function buildKiroPrompt(
  commandName: string,
  args: string | null,
  autoApprove: boolean,
): string {
  let prompt = commandName;
  if (args) prompt += ` ${args}`;
  if (autoApprove) prompt += " -y";
  return prompt;
}
