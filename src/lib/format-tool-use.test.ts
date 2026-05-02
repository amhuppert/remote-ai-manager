import { describe, it, expect } from "vitest";
import { formatToolUse } from "./format-tool-use";

describe("formatToolUse", () => {
  it("returns tool name with null context when no input provided", () => {
    expect(formatToolUse("Read")).toEqual({
      name: "Read",
      context: null,
      metricsLabel: null,
      isError: false,
    });
  });

  it("formats Read tool with file path", () => {
    expect(formatToolUse("Read", { file_path: "src/lib/auth.ts" })).toEqual({
      name: "Read",
      context: "src/lib/auth.ts",
      metricsLabel: null,
      isError: false,
    });
  });

  it("formats Write tool with file path", () => {
    expect(formatToolUse("Write", { file_path: "src/new.ts" })).toEqual({
      name: "Write",
      context: "src/new.ts",
      metricsLabel: null,
      isError: false,
    });
  });

  it("formats Edit tool with file path", () => {
    expect(formatToolUse("Edit", { file_path: "src/lib/config.ts" })).toEqual({
      name: "Edit",
      context: "src/lib/config.ts",
      metricsLabel: null,
      isError: false,
    });
  });

  it("formats MultiEdit as Edit", () => {
    expect(
      formatToolUse("MultiEdit", { file_path: "src/lib/config.ts" }),
    ).toEqual({
      name: "Edit",
      context: "src/lib/config.ts",
      metricsLabel: null,
      isError: false,
    });
  });

  it("formats Bash with description", () => {
    expect(
      formatToolUse("Bash", {
        description: "Run tests",
        command: "npm test",
      }),
    ).toEqual({
      name: "Bash",
      context: "Run tests",
      metricsLabel: null,
      isError: false,
    });
  });

  it("formats Bash with command when no description", () => {
    expect(formatToolUse("Bash", { command: "npm test" })).toEqual({
      name: "Bash",
      context: "npm test",
      metricsLabel: null,
      isError: false,
    });
  });

  it("truncates long Bash commands", () => {
    const longCmd = "a".repeat(100);
    expect(formatToolUse("Bash", { command: longCmd })).toEqual({
      name: "Bash",
      context: `${"a".repeat(50)}...`,
      metricsLabel: null,
      isError: false,
    });
  });

  it("formats Grep with pattern", () => {
    expect(formatToolUse("Grep", { pattern: "TODO" })).toEqual({
      name: "Search",
      context: '"TODO"',
      metricsLabel: null,
      isError: false,
    });
  });

  it("formats Glob with pattern", () => {
    expect(formatToolUse("Glob", { pattern: "**/*.ts" })).toEqual({
      name: "Find files",
      context: '"**/*.ts"',
      metricsLabel: null,
      isError: false,
    });
  });

  it("formats Task with description", () => {
    expect(formatToolUse("Task", { description: "Explore codebase" })).toEqual({
      name: "Task",
      context: "Explore codebase",
      metricsLabel: null,
      isError: false,
    });
  });

  it("truncates long Task descriptions", () => {
    const longDesc = "b".repeat(100);
    expect(formatToolUse("Task", { description: longDesc })).toEqual({
      name: "Task",
      context: `${"b".repeat(50)}...`,
      metricsLabel: null,
      isError: false,
    });
  });

  it("returns name with null context for unknown tools without matching fields", () => {
    expect(formatToolUse("CustomTool", { foo: "bar" })).toEqual({
      name: "CustomTool",
      context: null,
      metricsLabel: null,
      isError: false,
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
    ).toEqual({
      name: "TodoWrite",
      context: "3 tasks",
      metricsLabel: null,
      isError: false,
    });
  });

  it("formats TodoWrite singular task", () => {
    expect(
      formatToolUse("TodoWrite", {
        todos: [{ subject: "A", status: "pending" }],
      }),
    ).toEqual({
      name: "TodoWrite",
      context: "1 task",
      metricsLabel: null,
      isError: false,
    });
  });

  it("formats TodoWrite with no todos array", () => {
    expect(formatToolUse("TodoWrite", {})).toEqual({
      name: "TodoWrite",
      context: null,
      metricsLabel: null,
      isError: false,
    });
  });

  it("formats WebSearch with query", () => {
    expect(formatToolUse("WebSearch", { query: "next.js app router" })).toEqual(
      {
        name: "WebSearch",
        context: "next.js app router",
        metricsLabel: null,
        isError: false,
      },
    );
  });

  it("formats WebFetch with url", () => {
    expect(
      formatToolUse("WebFetch", { url: "https://example.com/docs" }),
    ).toEqual({
      name: "WebFetch",
      context: "https://example.com/docs",
      metricsLabel: null,
      isError: false,
    });
  });

  it("formats TaskCreate with subject", () => {
    expect(
      formatToolUse("TaskCreate", { subject: "Implement auth flow" }),
    ).toEqual({
      name: "TaskCreate",
      context: "Implement auth flow",
      metricsLabel: null,
      isError: false,
    });
  });

  it("formats TaskUpdate with status", () => {
    expect(
      formatToolUse("TaskUpdate", { taskId: "1", status: "completed" }),
    ).toEqual({
      name: "TaskUpdate",
      context: "→ completed",
      metricsLabel: null,
      isError: false,
    });
  });

  describe("worktree-relative paths", () => {
    const worktreePath = "/home/alex/github/repo/.worktrees/feature-x";

    it("strips worktree prefix from Read paths", () => {
      const r = formatToolUse(
        "Read",
        { file_path: `${worktreePath}/src/lib/auth.ts` },
        { worktreePath },
      );
      expect(r.context).toBe("src/lib/auth.ts");
    });

    it("strips worktree prefix from Write paths", () => {
      const r = formatToolUse(
        "Write",
        { file_path: `${worktreePath}/memory-bank/notes.md` },
        { worktreePath },
      );
      expect(r.context).toBe("memory-bank/notes.md");
    });

    it("strips worktree prefix from Edit/MultiEdit paths", () => {
      const r = formatToolUse(
        "MultiEdit",
        { file_path: `${worktreePath}/src/x.ts` },
        { worktreePath },
      );
      expect(r.context).toBe("src/x.ts");
    });

    it("keeps absolute path when file is outside worktree", () => {
      const r = formatToolUse(
        "Read",
        { file_path: "/etc/hosts" },
        { worktreePath },
      );
      expect(r.context).toBe("/etc/hosts");
    });

    it("keeps absolute path when path is sibling of worktree (not nested)", () => {
      const r = formatToolUse(
        "Read",
        { file_path: `${worktreePath}-other/file.ts` },
        { worktreePath },
      );
      expect(r.context).toBe(`${worktreePath}-other/file.ts`);
    });

    it("tolerates trailing slash on worktreePath", () => {
      const r = formatToolUse(
        "Read",
        { file_path: `${worktreePath}/src/x.ts` },
        { worktreePath: `${worktreePath}/` },
      );
      expect(r.context).toBe("src/x.ts");
    });

    it("keeps full path when no worktreePath provided", () => {
      const r = formatToolUse("Read", {
        file_path: `${worktreePath}/src/x.ts`,
      });
      expect(r.context).toBe(`${worktreePath}/src/x.ts`);
    });

    it("displays worktree root itself as '.'", () => {
      const r = formatToolUse(
        "Read",
        { file_path: worktreePath },
        { worktreePath },
      );
      expect(r.context).toBe(".");
    });
  });

  describe("with tool result", () => {
    it("surfaces isError flag", () => {
      const r = formatToolUse(
        "Bash",
        { command: "false" },
        { result: { isError: true } },
      );
      expect(r.isError).toBe(true);
    });

    it("formats Read line count from metrics", () => {
      const r = formatToolUse(
        "Read",
        { file_path: "src/x.ts" },
        { result: { metrics: { lineCount: 234 } } },
      );
      expect(r.metricsLabel).toBe("234 lines");
    });

    it("singular line", () => {
      const r = formatToolUse(
        "Read",
        { file_path: "src/x.ts" },
        { result: { metrics: { lineCount: 1 } } },
      );
      expect(r.metricsLabel).toBe("1 line");
    });

    it("formats Grep match count", () => {
      const r = formatToolUse(
        "Grep",
        { pattern: "TODO" },
        { result: { metrics: { matchCount: 12 } } },
      );
      expect(r.metricsLabel).toBe("12 matches");
    });

    it("formats Grep file count", () => {
      const r = formatToolUse(
        "Grep",
        { pattern: "TODO" },
        { result: { metrics: { fileCount: 7 } } },
      );
      expect(r.metricsLabel).toBe("7 files");
    });

    it("formats Glob file count", () => {
      const r = formatToolUse(
        "Glob",
        { pattern: "**/*.ts" },
        { result: { metrics: { fileCount: 47 } } },
      );
      expect(r.metricsLabel).toBe("47 files");
    });

    it("formats non-zero exit code on Bash", () => {
      const r = formatToolUse(
        "Bash",
        { command: "false" },
        { result: { isError: true, metrics: { exitCode: 1 } } },
      );
      expect(r.metricsLabel).toBe("exit 1");
    });

    it("hides exit 0 metric on success", () => {
      const r = formatToolUse(
        "Bash",
        { command: "true" },
        { result: { metrics: { exitCode: 0 } } },
      );
      expect(r.metricsLabel).toBe(null);
    });

    it("derives MultiEdit edit count from input", () => {
      const r = formatToolUse("MultiEdit", {
        file_path: "src/x.ts",
        edits: [
          { old_string: "a", new_string: "b" },
          { old_string: "c", new_string: "d" },
        ],
      });
      expect(r.metricsLabel).toBe("2 edits");
    });

    it("derives MultiEdit singular edit", () => {
      const r = formatToolUse("MultiEdit", {
        file_path: "src/x.ts",
        edits: [{ old_string: "a", new_string: "b" }],
      });
      expect(r.metricsLabel).toBe("1 edit");
    });
  });
});
