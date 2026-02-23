/**
 * Formatted tool use with separate name and context parts.
 * Allows the UI to style the tool name distinctly from its context.
 */
export interface FormattedToolUse {
  /** Tool name (e.g. "Read", "Bash", "TodoWrite") */
  name: string;
  /** Brief context string, or null if none available */
  context: string | null;
}

/** Truncate a string to maxLen, appending "..." if truncated. */
function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? `${s.slice(0, maxLen)}...` : s;
}

/**
 * Format a tool_use block for display in the UI.
 * Returns structured name + context for flexible rendering.
 */
export function formatToolUse(
  name: string,
  input?: Record<string, unknown>,
): FormattedToolUse {
  if (!input) return { name, context: null };

  switch (name) {
    case "Read":
      return {
        name,
        context: input["file_path"] ? String(input["file_path"]) : null,
      };
    case "Write":
      return {
        name,
        context: input["file_path"] ? String(input["file_path"]) : null,
      };
    case "Edit":
    case "MultiEdit":
      return {
        name: "Edit",
        context: input["file_path"] ? String(input["file_path"]) : null,
      };
    case "Bash": {
      if (input["description"])
        return { name, context: String(input["description"]) };
      if (input["command"])
        return { name, context: truncate(String(input["command"]), 50) };
      return { name, context: null };
    }
    case "Grep":
      return {
        name: "Search",
        context: input["pattern"] ? `"${input["pattern"]}"` : null,
      };
    case "Glob":
      return {
        name: "Find files",
        context: input["pattern"] ? `"${input["pattern"]}"` : null,
      };
    case "Task": {
      if (input["description"])
        return { name, context: truncate(String(input["description"]), 50) };
      return { name, context: null };
    }
    case "TodoWrite":
    case "TodoRead": {
      const todos = input["todos"];
      if (Array.isArray(todos))
        return {
          name,
          context: `${todos.length} task${todos.length === 1 ? "" : "s"}`,
        };
      return { name, context: null };
    }
    case "WebSearch":
      return {
        name,
        context: input["query"] ? truncate(String(input["query"]), 60) : null,
      };
    case "WebFetch":
      return {
        name,
        context: input["url"] ? truncate(String(input["url"]), 60) : null,
      };
    case "NotebookEdit":
      return {
        name,
        context: input["notebook_path"] ? String(input["notebook_path"]) : null,
      };
    case "TaskCreate":
      return {
        name,
        context: input["subject"]
          ? truncate(String(input["subject"]), 50)
          : null,
      };
    case "TaskUpdate":
      return { name, context: input["status"] ? `→ ${input["status"]}` : null };
    default:
      return { name, context: null };
  }
}
