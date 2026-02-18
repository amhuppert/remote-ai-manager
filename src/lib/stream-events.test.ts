import { describe, it, expect } from "vitest";
import { parseStreamLine, formatToolUse } from "./stream-events";

describe("parseStreamLine", () => {
  it("parses system init events", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "abc-123",
    });
    const result = parseStreamLine(line);
    expect(result).toEqual({
      type: "system",
      subtype: "init",
      session_id: "abc-123",
    });
  });

  it("parses assistant events", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello!" }],
      },
    });
    const result = parseStreamLine(line);
    expect(result).toEqual({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello!" }],
      },
    });
  });

  it("parses user (tool_result) events", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "xyz", content: "ok" }],
      },
    });
    const result = parseStreamLine(line);
    expect(result).toEqual({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "xyz", content: "ok" }],
      },
    });
  });

  it("parses result success events", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "abc-123",
      cost_usd: 0.05,
      num_turns: 3,
    });
    const result = parseStreamLine(line);
    expect(result).toEqual({
      type: "result",
      subtype: "success",
      session_id: "abc-123",
      cost_usd: 0.05,
      num_turns: 3,
    });
  });

  it("returns null for malformed JSON", () => {
    expect(parseStreamLine("not json")).toBeNull();
    expect(parseStreamLine("{ broken")).toBeNull();
  });

  it("returns null for unrecognized event types", () => {
    expect(
      parseStreamLine(JSON.stringify({ type: "progress", data: {} })),
    ).toBeNull();
    expect(
      parseStreamLine(
        JSON.stringify({ type: "file-history-snapshot", data: {} }),
      ),
    ).toBeNull();
  });

  it("returns null for system events without init subtype", () => {
    expect(
      parseStreamLine(
        JSON.stringify({ type: "system", subtype: "other", data: {} }),
      ),
    ).toBeNull();
  });
});

describe("formatToolUse", () => {
  it("returns tool name with null context when no input provided", () => {
    expect(formatToolUse("Read")).toEqual({ name: "Read", context: null });
  });

  it("formats Read tool with file path", () => {
    expect(formatToolUse("Read", { file_path: "src/lib/auth.ts" })).toEqual({
      name: "Read",
      context: "src/lib/auth.ts",
    });
  });

  it("formats Write tool with file path", () => {
    expect(formatToolUse("Write", { file_path: "src/new.ts" })).toEqual({
      name: "Write",
      context: "src/new.ts",
    });
  });

  it("formats Edit tool with file path", () => {
    expect(formatToolUse("Edit", { file_path: "src/lib/config.ts" })).toEqual({
      name: "Edit",
      context: "src/lib/config.ts",
    });
  });

  it("formats MultiEdit as Edit", () => {
    expect(
      formatToolUse("MultiEdit", { file_path: "src/lib/config.ts" }),
    ).toEqual({ name: "Edit", context: "src/lib/config.ts" });
  });

  it("formats Bash with description", () => {
    expect(
      formatToolUse("Bash", {
        description: "Run tests",
        command: "npm test",
      }),
    ).toEqual({ name: "Bash", context: "Run tests" });
  });

  it("formats Bash with command when no description", () => {
    expect(formatToolUse("Bash", { command: "npm test" })).toEqual({
      name: "Bash",
      context: "npm test",
    });
  });

  it("truncates long Bash commands", () => {
    const longCmd = "a".repeat(100);
    expect(formatToolUse("Bash", { command: longCmd })).toEqual({
      name: "Bash",
      context: `${"a".repeat(50)}...`,
    });
  });

  it("formats Grep with pattern", () => {
    expect(formatToolUse("Grep", { pattern: "TODO" })).toEqual({
      name: "Search",
      context: '"TODO"',
    });
  });

  it("formats Glob with pattern", () => {
    expect(formatToolUse("Glob", { pattern: "**/*.ts" })).toEqual({
      name: "Find files",
      context: '"**/*.ts"',
    });
  });

  it("formats Task with description", () => {
    expect(formatToolUse("Task", { description: "Explore codebase" })).toEqual({
      name: "Task",
      context: "Explore codebase",
    });
  });

  it("truncates long Task descriptions", () => {
    const longDesc = "b".repeat(100);
    expect(formatToolUse("Task", { description: longDesc })).toEqual({
      name: "Task",
      context: `${"b".repeat(50)}...`,
    });
  });

  it("returns name with null context for unknown tools without matching fields", () => {
    expect(formatToolUse("CustomTool", { foo: "bar" })).toEqual({
      name: "CustomTool",
      context: null,
    });
  });

  it("formats TodoWrite with task count", () => {
    expect(
      formatToolUse("TodoWrite", {
        todos: [
          { subject: "A", status: "pending" },
          { subject: "B", status: "pending" },
          { subject: "C", status: "done" },
        ],
      }),
    ).toEqual({ name: "TodoWrite", context: "3 tasks" });
  });

  it("formats TodoWrite singular task", () => {
    expect(
      formatToolUse("TodoWrite", {
        todos: [{ subject: "A", status: "pending" }],
      }),
    ).toEqual({ name: "TodoWrite", context: "1 task" });
  });

  it("formats TodoWrite with no todos array", () => {
    expect(formatToolUse("TodoWrite", {})).toEqual({
      name: "TodoWrite",
      context: null,
    });
  });

  it("formats WebSearch with query", () => {
    expect(formatToolUse("WebSearch", { query: "next.js app router" })).toEqual(
      { name: "WebSearch", context: "next.js app router" },
    );
  });

  it("formats WebFetch with url", () => {
    expect(
      formatToolUse("WebFetch", { url: "https://example.com/docs" }),
    ).toEqual({ name: "WebFetch", context: "https://example.com/docs" });
  });

  it("formats TaskCreate with subject", () => {
    expect(
      formatToolUse("TaskCreate", { subject: "Implement auth flow" }),
    ).toEqual({ name: "TaskCreate", context: "Implement auth flow" });
  });

  it("formats TaskUpdate with status", () => {
    expect(
      formatToolUse("TaskUpdate", { taskId: "1", status: "completed" }),
    ).toEqual({ name: "TaskUpdate", context: "→ completed" });
  });
});
