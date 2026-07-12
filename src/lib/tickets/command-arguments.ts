/**
 * Quote one dynamic argument for the POSIX-style shell commands embedded in
 * agent context. Single quotes suppress expansion; an embedded apostrophe is
 * represented by closing the quote, emitting a quoted apostrophe, and
 * reopening it.
 */
export function quoteAgentCommandArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
