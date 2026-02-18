/**
 * Types and parsers for Claude CLI `--output-format stream-json` events.
 *
 * The Claude CLI emits NDJSON lines with these event types:
 * - system (subtype: init) — session start with session_id
 * - assistant — message with content blocks (text, tool_use)
 * - user — tool_result messages (internal, not displayed)
 * - result (subtype: success) — completion with session_id and cost
 *
 * Other event types (progress, file-history-snapshot, etc.) are ignored.
 */

// ============================================================
// Stream Event Types
// ============================================================

export interface StreamInitEvent {
  type: "system";
  subtype: "init";
  session_id: string;
}

export interface StreamAssistantEvent {
  type: "assistant";
  message: {
    role: "assistant";
    content: Array<{ type: string; [key: string]: unknown }>;
  };
}

export interface StreamUserEvent {
  type: "user";
  message: {
    role: "user";
    content: Array<{ type: string; [key: string]: unknown }>;
  };
}

export interface StreamResultEvent {
  type: "result";
  subtype: "success";
  session_id: string;
  cost_usd?: number;
  num_turns?: number;
}

export type StreamEvent =
  | StreamInitEvent
  | StreamAssistantEvent
  | StreamUserEvent
  | StreamResultEvent;

// ============================================================
// Line Parser
// ============================================================

/**
 * Parse a single NDJSON line from stream-json output.
 * Returns null for malformed JSON or unrecognized event types.
 */
export function parseStreamLine(line: string): StreamEvent | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }

  const type = parsed["type"];

  if (type === "system" && parsed["subtype"] === "init") {
    return {
      type: "system",
      subtype: "init",
      session_id: String(parsed["session_id"] ?? ""),
    };
  }

  if (type === "assistant" && parsed["message"]) {
    return {
      type: "assistant",
      message: parsed["message"] as StreamAssistantEvent["message"],
    };
  }

  if (type === "user" && parsed["message"]) {
    return {
      type: "user",
      message: parsed["message"] as StreamUserEvent["message"],
    };
  }

  if (type === "result" && parsed["subtype"] === "success") {
    return {
      type: "result",
      subtype: "success",
      session_id: String(parsed["session_id"] ?? ""),
      cost_usd: parsed["cost_usd"] as number | undefined,
      num_turns: parsed["num_turns"] as number | undefined,
    };
  }

  // Unrecognized event type (progress, file-history-snapshot, etc.)
  return null;
}

// ============================================================
// Tool Use Formatting
// ============================================================

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
