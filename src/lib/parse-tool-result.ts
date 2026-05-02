import type { ToolResultMetrics } from "@/lib/schemas";

/**
 * Extract per-tool metrics from a tool_result `content` string.
 * Returns an empty object when nothing meaningful can be parsed.
 *
 * Only metrics that must be derived from the result are extracted here —
 * input-derived metrics (e.g. TodoWrite task count) belong in `formatToolUse`.
 */
export function parseToolResultMetrics(
  toolName: string,
  content: string | undefined,
): ToolResultMetrics {
  if (!content) return {};

  switch (toolName) {
    case "Read":
      return parseReadMetrics(content);
    case "Grep":
    case "Search":
      return parseGrepMetrics(content);
    case "Glob":
    case "Find files":
      return parseGlobMetrics(content);
    default:
      return {};
  }
}

const READ_NUMBERED_LINE_RE = /^\s*\d+\t/;

function parseReadMetrics(content: string): ToolResultMetrics {
  const lines = content.split("\n");
  let numbered = 0;
  for (const line of lines) {
    if (READ_NUMBERED_LINE_RE.test(line)) numbered++;
  }
  if (numbered > 0) return { lineCount: numbered };

  const trimmed = content.replace(/\n+$/, "");
  if (trimmed.length === 0) return {};
  return { lineCount: trimmed.split("\n").length };
}

const GREP_FOUND_FILES_RE = /^Found (\d+) files?\b/m;

function parseGrepMetrics(content: string): ToolResultMetrics {
  if (/^No matches found\b/m.test(content)) return { matchCount: 0 };

  const found = GREP_FOUND_FILES_RE.exec(content);
  if (found?.[1]) return { fileCount: Number.parseInt(found[1], 10) };

  const lines = content.split("\n").filter((l) => l.length > 0);
  return { matchCount: lines.length };
}

function parseGlobMetrics(content: string): ToolResultMetrics {
  if (/^No files found\b/m.test(content)) return { fileCount: 0 };
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  return { fileCount: lines.length };
}
