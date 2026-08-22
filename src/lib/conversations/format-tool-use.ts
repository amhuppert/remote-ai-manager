import type { ToolResultMetrics } from "@/lib/conversations/schemas";
import { truncate } from "@/lib/shared/truncate";
/**
 * Formatted tool use with separate name, context, metrics, and error parts.
 * Allows the UI to style the tool name distinctly from its context.
 */
export interface FormattedToolUse {
  /** Tool name (e.g. "Read", "Bash", "TodoWrite") */
  name: string;
  /** Brief context string, or null if none available */
  context: string | null;
  /** Full command text rendered as a code block (Bash tool), or null */
  command: string | null;
  /** Result-derived metric label (e.g. "234 lines", "12 matches"), or null */
  metricsLabel: string | null;
  /** Whether the tool errored */
  isError: boolean;
}

export interface FormatToolUseOptions {
  /** Session worktree path — used to display tool file paths as relative when nested. */
  worktreePath?: string;
  /** Paired tool_result metadata (matched by tool_use.id ↔ tool_result.tool_use_id). */
  result?: { isError?: boolean; metrics?: ToolResultMetrics };
}

function pluralize(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : (plural ?? `${singular}s`)}`;
}

function shortenPath(filePath: string, worktreePath?: string): string {
  if (!worktreePath) return filePath;
  const root = worktreePath.replace(/\/+$/, "");
  if (filePath === root) return ".";
  const prefix = `${root}/`;
  if (filePath.startsWith(prefix)) return filePath.slice(prefix.length);
  return filePath;
}

function formatPathContext(
  input: Record<string, unknown>,
  worktreePath: string | undefined,
): string | null {
  const filePath = input["file_path"];
  if (typeof filePath !== "string") return null;
  return shortenPath(filePath, worktreePath);
}

/**
 * Build a metricsLabel from input + result metrics. Returns null when nothing
 * meaningful exists. Input-derived metrics (TodoWrite task count, MultiEdit
 * edit count) are computed here even when no result is available.
 */
function buildMetricsLabel(
  toolName: string,
  input: Record<string, unknown> | undefined,
  metrics: ToolResultMetrics | undefined,
): string | null {
  switch (toolName) {
    case "Read": {
      if (metrics?.lineCount != null)
        return pluralize(metrics.lineCount, "line");
      return null;
    }
    case "Grep": {
      if (metrics?.matchCount != null)
        return pluralize(metrics.matchCount, "match", "matches");
      if (metrics?.fileCount != null)
        return pluralize(metrics.fileCount, "file");
      return null;
    }
    case "Glob": {
      if (metrics?.fileCount != null)
        return pluralize(metrics.fileCount, "file");
      return null;
    }
    case "Bash": {
      if (typeof metrics?.exitCode === "number" && metrics.exitCode !== 0) {
        return `exit ${metrics.exitCode}`;
      }
      return null;
    }
    case "MultiEdit": {
      const edits = input?.["edits"];
      if (Array.isArray(edits)) return pluralize(edits.length, "edit");
      return null;
    }
    default:
      return null;
  }
}

/**
 * Format a tool_use block for display in the UI.
 * Returns structured name + context + metricsLabel + isError for flexible rendering.
 */
export function formatToolUse(
  name: string,
  input?: Record<string, unknown>,
  options?: FormatToolUseOptions,
): FormattedToolUse {
  const worktreePath = options?.worktreePath;
  const result = options?.result;
  const isError = result?.isError === true;
  const metricsLabel = buildMetricsLabel(name, input, result?.metrics);

  if (!input) {
    return { name, context: null, command: null, metricsLabel, isError };
  }

  const base: Pick<FormattedToolUse, "metricsLabel" | "isError" | "command"> = {
    metricsLabel,
    isError,
    command: null,
  };

  switch (name) {
    case "Read":
      return { name, context: formatPathContext(input, worktreePath), ...base };
    case "Write":
      return { name, context: formatPathContext(input, worktreePath), ...base };
    case "Delete":
      return { name, context: formatPathContext(input, worktreePath), ...base };
    case "Edit":
    case "MultiEdit":
      return {
        name: "Edit",
        context: formatPathContext(input, worktreePath),
        ...base,
      };
    case "Bash": {
      const command =
        typeof input["command"] === "string" ? input["command"] : null;
      const description =
        typeof input["description"] === "string" ? input["description"] : null;
      return {
        name,
        context: description,
        ...base,
        command,
      };
    }
    case "Grep":
      return {
        name: "Search",
        context: input["pattern"] ? `"${input["pattern"]}"` : null,
        ...base,
      };
    case "Glob":
      return {
        name: "Find files",
        context: input["pattern"] ? `"${input["pattern"]}"` : null,
        ...base,
      };
    case "Task": {
      if (input["description"])
        return {
          name,
          context: truncate(String(input["description"]), 50, {
            ellipsis: "...",
          }),
          ...base,
        };
      return { name, context: null, ...base };
    }
    case "TodoWrite":
    case "TodoRead": {
      const todos = input["todos"];
      if (Array.isArray(todos))
        return { name, context: pluralize(todos.length, "task"), ...base };
      return { name, context: null, ...base };
    }
    case "WebSearch":
      return {
        name,
        context: input["query"]
          ? truncate(String(input["query"]), 60, { ellipsis: "..." })
          : null,
        ...base,
      };
    case "WebFetch":
      return {
        name,
        context: input["url"]
          ? truncate(String(input["url"]), 60, { ellipsis: "..." })
          : null,
        ...base,
      };
    case "Skill":
      return {
        name,
        context: input["skill"] ? String(input["skill"]) : null,
        ...base,
      };
    case "NotebookEdit": {
      const notebookPath = input["notebook_path"];
      return {
        name,
        context:
          typeof notebookPath === "string"
            ? shortenPath(notebookPath, worktreePath)
            : null,
        ...base,
      };
    }
    case "TaskCreate":
      return {
        name,
        context: input["subject"]
          ? truncate(String(input["subject"]), 50, { ellipsis: "..." })
          : null,
        ...base,
      };
    case "TaskUpdate":
      return {
        name,
        context: input["status"] ? `→ ${input["status"]}` : null,
        ...base,
      };
    default:
      return { name, context: null, ...base };
  }
}
