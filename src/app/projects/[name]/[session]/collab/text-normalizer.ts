// Collaboration agent outputs occasionally arrive with literal JSON escape
// sequences (e.g. "\n", "\u2013") embedded as text rather than the decoded
// characters. This happens when the model double-encodes its structured output.
// Decode the safe, common subset before rendering so Markdown sees real
// newlines and Unicode chars. Backslash sequences not in this allowlist
// (e.g. "\d" in a regex) are left intact.
const RECOGNIZED_ESCAPE = /\\(u[0-9a-fA-F]{4}|n|r|t)/g;

export function normalizeCollabMarkdown(input: string): string {
  return input.replace(RECOGNIZED_ESCAPE, (_, code: string) => {
    if (code.startsWith("u")) {
      return String.fromCharCode(parseInt(code.slice(1), 16));
    }
    if (code === "n") return "\n";
    if (code === "r") return "\r";
    return "\t";
  });
}
