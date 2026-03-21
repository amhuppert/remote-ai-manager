import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for the Codex MCP tool server.
 *
 * Mocks createSdkMcpServer and tool to capture handlers,
 * then tests each component directly.
 */

const TOOLS_KEY = "__test_codex_tool_captured";

function getCapturedTools(): Map<
  string,
  { name: string; handler: (args: unknown) => Promise<unknown> }
> {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g[TOOLS_KEY]) {
    g[TOOLS_KEY] = new Map();
  }
  return g[TOOLS_KEY] as Map<
    string,
    { name: string; handler: (args: unknown) => Promise<unknown> }
  >;
}

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  const TOOLS_KEY_INNER = "__test_codex_tool_captured";
  function getTools(): Map<
    string,
    { name: string; handler: (args: unknown) => Promise<unknown> }
  > {
    const g = globalThis as unknown as Record<string, unknown>;
    if (!g[TOOLS_KEY_INNER]) {
      g[TOOLS_KEY_INNER] = new Map();
    }
    return g[TOOLS_KEY_INNER] as Map<
      string,
      { name: string; handler: (args: unknown) => Promise<unknown> }
    >;
  }

  return {
    createSdkMcpServer: vi.fn(
      (config: {
        tools: Array<{
          name: string;
          handler: (args: unknown) => Promise<unknown>;
        }>;
      }) => {
        const tools = getTools();
        for (const t of config.tools) {
          tools.set(t.name, t);
        }
        return { __mock: true, tools: config.tools };
      },
    ),
    tool: vi.fn(
      (
        name: string,
        _description: string,
        _schema: unknown,
        handler: (args: unknown) => Promise<unknown>,
      ) => ({
        name,
        handler,
      }),
    ),
  };
});

vi.mock("./logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function getHandler(name: string): (args: unknown) => Promise<unknown> {
  const t = getCapturedTools().get(name);
  if (!t) throw new Error(`Tool ${name} not found in captured tools`);
  return t.handler;
}

// ============================================================
// Imports — after mocks
// ============================================================

import type { CodexToolDeps, CodexJsonParseState } from "./codex-tool";

describe("codex-tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCapturedTools().clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock("node:child_process");
  });

  // ============================================================
  // 1. MCP server creation
  // ============================================================

  describe("createCodexToolServer", () => {
    it("registers one tool named run_codex", async () => {
      const { createCodexToolServer } = await import("./codex-tool");
      const mockDeps = createMockDeps();
      createCodexToolServer(
        { worktreePath: "/wt", sessionName: "s1" },
        mockDeps,
      );
      expect(getCapturedTools().has("run_codex")).toBe(true);
      expect(getCapturedTools().size).toBe(1);
    });
  });

  // ============================================================
  // 2. Feature gating helper
  // ============================================================

  describe("maybeCreateCodexToolServer", () => {
    it("returns null when config is undefined", async () => {
      const { maybeCreateCodexToolServer } = await import("./codex-tool");
      const result = maybeCreateCodexToolServer(undefined, {
        worktreePath: "/wt",
        sessionName: "s1",
      });
      expect(result).toBeNull();
    });

    it("returns null when enabled is false", async () => {
      const { maybeCreateCodexToolServer } = await import("./codex-tool");
      const result = maybeCreateCodexToolServer(
        { enabled: false },
        { worktreePath: "/wt", sessionName: "s1" },
      );
      expect(result).toBeNull();
    });

    it("returns a server when enabled is true", async () => {
      const { maybeCreateCodexToolServer } = await import("./codex-tool");
      const result = maybeCreateCodexToolServer(
        { enabled: true },
        { worktreePath: "/wt", sessionName: "s1" },
      );
      expect(result).not.toBeNull();
    });
  });

  // ============================================================
  // 3. Arg construction
  // ============================================================

  describe("buildCodexExecArgs", () => {
    it("uses --sandbox workspace-write (not --full-auto)", async () => {
      const { buildCodexExecArgs } = await import("./codex-tool");
      const args = buildCodexExecArgs({
        worktreePath: "/wt",
        prompt: "hello",
      });
      expect(args).toContain("--sandbox");
      expect(args).toContain("workspace-write");
      expect(args).not.toContain("--full-auto");
    });

    it("does not include --ask-for-approval (flag removed in v0.116)", async () => {
      const { buildCodexExecArgs } = await import("./codex-tool");
      const args = buildCodexExecArgs({
        worktreePath: "/wt",
        prompt: "hello",
      });
      expect(args).not.toContain("--ask-for-approval");
    });

    it("includes the four sandbox override -c args", async () => {
      const { buildCodexExecArgs } = await import("./codex-tool");
      const args = buildCodexExecArgs({
        worktreePath: "/wt",
        prompt: "hello",
      });
      expect(args).toContain("sandbox_workspace_write.exclude_slash_tmp=true");
      expect(args).toContain(
        "sandbox_workspace_write.exclude_tmpdir_env_var=true",
      );
      expect(args).toContain("sandbox_workspace_write.writable_roots=[]");
      expect(args).toContain("sandbox_workspace_write.network_access=true");
    });

    it("includes model when provided", async () => {
      const { buildCodexExecArgs } = await import("./codex-tool");
      const args = buildCodexExecArgs({
        worktreePath: "/wt",
        prompt: "hello",
        model: "o4-mini",
      });
      const mIdx = args.indexOf("-m");
      expect(mIdx).toBeGreaterThan(-1);
      expect(args[mIdx + 1]).toBe("o4-mini");
    });

    it("omits model when not provided", async () => {
      const { buildCodexExecArgs } = await import("./codex-tool");
      const args = buildCodexExecArgs({
        worktreePath: "/wt",
        prompt: "hello",
      });
      expect(args).not.toContain("-m");
    });

    it("includes reasoning effort when provided", async () => {
      const { buildCodexExecArgs } = await import("./codex-tool");
      const args = buildCodexExecArgs({
        worktreePath: "/wt",
        prompt: "hello",
        reasoningEffort: "high",
      });
      expect(args).toContain("model_reasoning_effort=high");
    });

    it("omits reasoning effort when not provided", async () => {
      const { buildCodexExecArgs } = await import("./codex-tool");
      const args = buildCodexExecArgs({
        worktreePath: "/wt",
        prompt: "hello",
      });
      const hasReasoning = args.some((a) =>
        a.includes("model_reasoning_effort"),
      );
      expect(hasReasoning).toBe(false);
    });

    it("places prompt as the last argument", async () => {
      const { buildCodexExecArgs } = await import("./codex-tool");
      const args = buildCodexExecArgs({
        worktreePath: "/wt",
        prompt: "do the thing",
      });
      expect(args[args.length - 1]).toBe("do the thing");
    });

    it("includes --output-schema when provided", async () => {
      const { buildCodexExecArgs } = await import("./codex-tool");
      const args = buildCodexExecArgs({
        worktreePath: "/wt",
        prompt: "hello",
        outputSchemaPath: "/wt/memory-bank/codex/.output-schema.json",
      });
      const idx = args.indexOf("--output-schema");
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe("/wt/memory-bank/codex/.output-schema.json");
      // prompt is still last
      expect(args[args.length - 1]).toBe("hello");
    });

    it("omits --output-schema when not provided", async () => {
      const { buildCodexExecArgs } = await import("./codex-tool");
      const args = buildCodexExecArgs({
        worktreePath: "/wt",
        prompt: "hello",
      });
      expect(args).not.toContain("--output-schema");
    });
  });

  // ============================================================
  // 4. Parser behavior
  // ============================================================

  describe("consumeCodexJsonLine / finalizeCodexJsonParse", () => {
    it("captures final text from item.completed agent_message", async () => {
      const { consumeCodexJsonLine, finalizeCodexJsonParse } =
        await import("./codex-tool");
      const state: CodexJsonParseState = {
        lineCount: 0,
        lastAgentMessage: null,
        lastErrorMessage: null,
      };
      consumeCodexJsonLine(
        state,
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "I fixed the bug." },
        }),
      );
      expect(finalizeCodexJsonParse(state)).toBe("I fixed the bug.");
    });

    it("uses the last agent_message when multiple appear", async () => {
      const { consumeCodexJsonLine, finalizeCodexJsonParse } =
        await import("./codex-tool");
      const state: CodexJsonParseState = {
        lineCount: 0,
        lastAgentMessage: null,
        lastErrorMessage: null,
      };
      consumeCodexJsonLine(
        state,
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "first" },
        }),
      );
      consumeCodexJsonLine(
        state,
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "second" },
        }),
      );
      expect(finalizeCodexJsonParse(state)).toBe("second");
    });

    it("ignores non-agent items", async () => {
      const { consumeCodexJsonLine } = await import("./codex-tool");
      const state: CodexJsonParseState = {
        lineCount: 0,
        lastAgentMessage: null,
        lastErrorMessage: null,
      };
      consumeCodexJsonLine(
        state,
        JSON.stringify({
          type: "item.completed",
          item: { type: "tool_call", name: "Read" },
        }),
      );
      expect(state.lastAgentMessage).toBeNull();
    });

    it("ignores blank lines", async () => {
      const { consumeCodexJsonLine } = await import("./codex-tool");
      const state: CodexJsonParseState = {
        lineCount: 0,
        lastAgentMessage: null,
        lastErrorMessage: null,
      };
      consumeCodexJsonLine(state, "");
      consumeCodexJsonLine(state, "  ");
      expect(state.lineCount).toBe(0);
    });

    it("throws line-numbered JSON parse errors", async () => {
      const { consumeCodexJsonLine } = await import("./codex-tool");
      const state: CodexJsonParseState = {
        lineCount: 0,
        lastAgentMessage: null,
        lastErrorMessage: null,
      };
      expect(() => consumeCodexJsonLine(state, "not json")).toThrow(/line 1/);
    });

    it("captures error event messages", async () => {
      const { consumeCodexJsonLine, finalizeCodexJsonParse } =
        await import("./codex-tool");
      const state: CodexJsonParseState = {
        lineCount: 0,
        lastAgentMessage: null,
        lastErrorMessage: null,
      };
      consumeCodexJsonLine(
        state,
        JSON.stringify({ type: "error", message: "rate limit hit" }),
      );
      expect(state.lastErrorMessage).toBe("rate limit hit");
      expect(() => finalizeCodexJsonParse(state)).toThrow("rate limit hit");
    });

    it("captures turn.failed messages", async () => {
      const { consumeCodexJsonLine, finalizeCodexJsonParse } =
        await import("./codex-tool");
      const state: CodexJsonParseState = {
        lineCount: 0,
        lastAgentMessage: null,
        lastErrorMessage: null,
      };
      consumeCodexJsonLine(
        state,
        JSON.stringify({
          type: "turn.failed",
          error: { message: "context overflow" },
        }),
      );
      expect(() => finalizeCodexJsonParse(state)).toThrow("context overflow");
    });

    it("throws generic message when no agent_message or error", async () => {
      const { finalizeCodexJsonParse } = await import("./codex-tool");
      const state: CodexJsonParseState = {
        lineCount: 0,
        lastAgentMessage: null,
        lastErrorMessage: null,
      };
      expect(() => finalizeCodexJsonParse(state)).toThrow(
        "Codex completed without emitting a final agent_message event",
      );
    });
  });

  // ============================================================
  // 5. Handler behavior
  // ============================================================

  describe("default subprocess runner", () => {
    it("returns an invalid JSONL error when Codex emits malformed JSON", async () => {
      const child = new FakeCodexChild();
      const { createCodexToolServer } = await importCodexToolWithSpawn(
        vi.fn(() => child),
      );

      createCodexToolServer({ worktreePath: "/wt", sessionName: "s1" });

      const handler = getHandler("run_codex");
      const resultPromise = handler({ prompt: "fix tests" }) as Promise<{
        content: Array<{ text: string }>;
        isError?: boolean;
      }>;

      child.stdout.write("not json\n");
      child.stdout.end();
      child.emit("close", 0);

      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain(
        "Codex produced invalid JSONL output at line 1",
      );
    });

    it("sends SIGKILL if Codex does not exit after SIGTERM", async () => {
      vi.useFakeTimers();

      const child = new FakeCodexChild();
      const { defaultCodexToolDeps } = await importCodexToolWithSpawn(
        vi.fn(() => child),
      );

      const runPromise = defaultCodexToolDeps.runCodexExec({
        args: ["exec", "prompt"],
        cwd: "/wt",
        env: { NODE_ENV: "test" },
        timeoutMs: 10_000,
      });

      await vi.advanceTimersByTimeAsync(10_000);
      expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");

      await vi.advanceTimersByTimeAsync(5_000);
      expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");

      child.emit("close", null);
      await expect(runPromise).resolves.toMatchObject({
        timedOut: true,
        exitCode: null,
      });
    });
  });

  describe("run_codex handler", () => {
    it("uses context defaults when tool args omit them", async () => {
      const { createCodexToolServer } = await import("./codex-tool");
      const mockDeps = createMockDeps({
        exitCode: 0,
        parseState: {
          lineCount: 1,
          lastAgentMessage: "done",
          lastErrorMessage: null,
        },
      });

      createCodexToolServer(
        {
          worktreePath: "/wt",
          sessionName: "s1",
          defaultModel: "o3",
          defaultReasoningEffort: "medium",
        },
        mockDeps,
      );

      const handler = getHandler("run_codex");
      await handler({ prompt: "fix tests" });

      const callArgs = mockDeps.mockRunCodexExec.mock.calls[0]![0] as {
        args: string[];
      };
      expect(callArgs.args).toContain("o3");
      expect(
        callArgs.args.some((a: string) =>
          a.includes("model_reasoning_effort=medium"),
        ),
      ).toBe(true);
    });

    it("tool args override context defaults", async () => {
      const { createCodexToolServer } = await import("./codex-tool");
      const mockDeps = createMockDeps({
        exitCode: 0,
        parseState: {
          lineCount: 1,
          lastAgentMessage: "done",
          lastErrorMessage: null,
        },
      });

      createCodexToolServer(
        {
          worktreePath: "/wt",
          sessionName: "s1",
          defaultModel: "o3",
          defaultReasoningEffort: "medium",
        },
        mockDeps,
      );

      const handler = getHandler("run_codex");
      await handler({
        prompt: "fix tests",
        model: "gpt-5-codex",
        reasoning_effort: "xhigh",
      });

      const callArgs = mockDeps.mockRunCodexExec.mock.calls[0]![0] as {
        args: string[];
      };
      expect(callArgs.args).toContain("gpt-5-codex");
      expect(callArgs.args).not.toContain("o3");
      expect(
        callArgs.args.some((a: string) =>
          a.includes("model_reasoning_effort=xhigh"),
        ),
      ).toBe(true);
    });

    it("ensures memory-bank/codex dir exists before invocation", async () => {
      const { createCodexToolServer } = await import("./codex-tool");
      const mockDeps = createMockDeps({
        exitCode: 0,
        parseState: {
          lineCount: 1,
          lastAgentMessage: "ok",
          lastErrorMessage: null,
        },
      });

      createCodexToolServer(
        { worktreePath: "/wt", sessionName: "s1" },
        mockDeps,
      );

      const handler = getHandler("run_codex");
      await handler({ prompt: "do it" });

      expect(mockDeps.mockEnsureDir).toHaveBeenCalledWith(
        "/wt/memory-bank/codex",
      );
    });

    it("writes the output schema file before invocation", async () => {
      const { createCodexToolServer, CODEX_OUTPUT_SCHEMA } =
        await import("./codex-tool");
      const mockDeps = createMockDeps({
        exitCode: 0,
        parseState: {
          lineCount: 1,
          lastAgentMessage: "ok",
          lastErrorMessage: null,
        },
      });

      createCodexToolServer(
        { worktreePath: "/wt", sessionName: "s1" },
        mockDeps,
      );

      const handler = getHandler("run_codex");
      await handler({ prompt: "do it" });

      expect(mockDeps.mockWriteFile).toHaveBeenCalledWith(
        "/wt/memory-bank/codex/.output-schema.json",
        JSON.stringify(CODEX_OUTPUT_SCHEMA, null, 2),
      );
    });

    it("wraps the user prompt with Codex instructions", async () => {
      const { createCodexToolServer } = await import("./codex-tool");
      const mockDeps = createMockDeps({
        exitCode: 0,
        parseState: {
          lineCount: 1,
          lastAgentMessage: "ok",
          lastErrorMessage: null,
        },
      });

      createCodexToolServer(
        { worktreePath: "/wt", sessionName: "s1" },
        mockDeps,
      );

      const handler = getHandler("run_codex");
      await handler({ prompt: "fix the login bug" });

      const callArgs = mockDeps.mockRunCodexExec.mock.calls[0]![0] as {
        args: string[];
      };
      const promptArg = callArgs.args[callArgs.args.length - 1]!;
      expect(promptArg).toContain("memory-bank/codex/");
      expect(promptArg).toContain("fix the login bug");
      expect(promptArg).not.toBe("fix the login bug");
    });

    it("passes --output-schema pointing to the schema file", async () => {
      const { createCodexToolServer } = await import("./codex-tool");
      const mockDeps = createMockDeps({
        exitCode: 0,
        parseState: {
          lineCount: 1,
          lastAgentMessage: "ok",
          lastErrorMessage: null,
        },
      });

      createCodexToolServer(
        { worktreePath: "/wt", sessionName: "s1" },
        mockDeps,
      );

      const handler = getHandler("run_codex");
      await handler({ prompt: "do it" });

      const callArgs = mockDeps.mockRunCodexExec.mock.calls[0]![0] as {
        args: string[];
      };
      const idx = callArgs.args.indexOf("--output-schema");
      expect(idx).toBeGreaterThan(-1);
      expect(callArgs.args[idx + 1]).toBe(
        "/wt/memory-bank/codex/.output-schema.json",
      );
    });

    it("returns structured JSON when Codex produces valid structured response", async () => {
      const { createCodexToolServer } = await import("./codex-tool");
      const structured = JSON.stringify({
        summary: "Fixed the bug",
        referenceDocuments: [
          { filePath: "memory-bank/codex/report.md", description: "Details" },
        ],
      });
      const mockDeps = createMockDeps({
        exitCode: 0,
        parseState: {
          lineCount: 3,
          lastAgentMessage: structured,
          lastErrorMessage: null,
        },
      });

      createCodexToolServer(
        { worktreePath: "/wt", sessionName: "s1" },
        mockDeps,
      );

      const handler = getHandler("run_codex");
      const result = (await handler({ prompt: "fix tests" })) as {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      };

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.summary).toBe("Fixed the bug");
      expect(parsed.referenceDocuments).toHaveLength(1);
      expect(result.isError).toBeUndefined();
    });

    it("falls back to raw text when response is not valid structured JSON", async () => {
      const { createCodexToolServer } = await import("./codex-tool");
      const mockDeps = createMockDeps({
        exitCode: 0,
        parseState: {
          lineCount: 3,
          lastAgentMessage: "All tests pass now.",
          lastErrorMessage: null,
        },
      });

      createCodexToolServer(
        { worktreePath: "/wt", sessionName: "s1" },
        mockDeps,
      );

      const handler = getHandler("run_codex");
      const result = (await handler({ prompt: "fix tests" })) as {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      };

      expect(result.content[0]!.text).toBe("All tests pass now.");
      expect(result.isError).toBeUndefined();
    });

    it("returns isError for timeout", async () => {
      const { createCodexToolServer } = await import("./codex-tool");
      const mockDeps = createMockDeps({
        exitCode: null,
        timedOut: true,
        parseState: {
          lineCount: 0,
          lastAgentMessage: null,
          lastErrorMessage: null,
        },
      });

      createCodexToolServer(
        { worktreePath: "/wt", sessionName: "s1" },
        mockDeps,
      );

      const handler = getHandler("run_codex");
      const result = (await handler({ prompt: "fix" })) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("timed out");
    });

    it("returns isError when CLI is not found", async () => {
      const { createCodexToolServer } = await import("./codex-tool");
      const mockDeps = createMockDeps();
      mockDeps.mockRunCodexExec.mockRejectedValue(
        new Error("Codex CLI not found"),
      );

      createCodexToolServer(
        { worktreePath: "/wt", sessionName: "s1" },
        mockDeps,
      );

      const handler = getHandler("run_codex");
      const result = (await handler({ prompt: "fix" })) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("not installed");
    });

    it("returns isError for non-zero exit with error message", async () => {
      const { createCodexToolServer } = await import("./codex-tool");
      const mockDeps = createMockDeps({
        exitCode: 1,
        stderr: "authentication failed",
        parseState: {
          lineCount: 0,
          lastAgentMessage: null,
          lastErrorMessage: "auth error from event",
        },
      });

      createCodexToolServer(
        { worktreePath: "/wt", sessionName: "s1" },
        mockDeps,
      );

      const handler = getHandler("run_codex");
      const result = (await handler({ prompt: "fix" })) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("exited with code 1");
      expect(result.content[0]!.text).toContain("auth error from event");
    });

    it("returns isError for non-zero exit with stderr fallback", async () => {
      const { createCodexToolServer } = await import("./codex-tool");
      const mockDeps = createMockDeps({
        exitCode: 1,
        stderr: "process killed",
        parseState: {
          lineCount: 0,
          lastAgentMessage: null,
          lastErrorMessage: null,
        },
      });

      createCodexToolServer(
        { worktreePath: "/wt", sessionName: "s1" },
        mockDeps,
      );

      const handler = getHandler("run_codex");
      const result = (await handler({ prompt: "fix" })) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("process killed");
    });

    it("returns isError for zero exit with no final message", async () => {
      const { createCodexToolServer } = await import("./codex-tool");
      const mockDeps = createMockDeps({
        exitCode: 0,
        parseState: {
          lineCount: 2,
          lastAgentMessage: null,
          lastErrorMessage: null,
        },
      });

      createCodexToolServer(
        { worktreePath: "/wt", sessionName: "s1" },
        mockDeps,
      );

      const handler = getHandler("run_codex");
      const result = (await handler({ prompt: "fix" })) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("without emitting");
    });

    it("returns parser-derived errors on zero exit instead of collapsing them", async () => {
      const { createCodexToolServer } = await import("./codex-tool");
      const mockDeps = createMockDeps({
        exitCode: 0,
        parseState: {
          lineCount: 2,
          lastAgentMessage: null,
          lastErrorMessage: "context overflow",
        },
      });

      createCodexToolServer(
        { worktreePath: "/wt", sessionName: "s1" },
        mockDeps,
      );

      const handler = getHandler("run_codex");
      const result = (await handler({ prompt: "fix" })) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("context overflow");
    });
  });

  // ============================================================
  // 6. Prompt wrapping
  // ============================================================

  describe("wrapCodexPrompt", () => {
    it("prepends instructions and preserves the original prompt", async () => {
      const { wrapCodexPrompt } = await import("./codex-tool");
      const wrapped = wrapCodexPrompt("Fix the login bug");
      expect(wrapped).toContain("memory-bank/codex/");
      expect(wrapped).toContain("summary");
      expect(wrapped).toContain("referenceDocuments");
      expect(wrapped).toContain("Fix the login bug");
    });

    it("includes the 1000-character limit instruction", async () => {
      const { wrapCodexPrompt } = await import("./codex-tool");
      const wrapped = wrapCodexPrompt("Do something");
      expect(wrapped).toContain("1000");
    });

    it("places the original prompt after the instructions", async () => {
      const { wrapCodexPrompt } = await import("./codex-tool");
      const wrapped = wrapCodexPrompt("Do something");
      const instructionsEnd = wrapped.indexOf("Task:");
      const promptStart = wrapped.indexOf("Do something");
      expect(instructionsEnd).toBeGreaterThan(-1);
      expect(promptStart).toBeGreaterThan(instructionsEnd);
    });
  });

  // ============================================================
  // 7. Structured response parsing
  // ============================================================

  describe("parseCodexStructuredResponse", () => {
    it("parses valid structured JSON", async () => {
      const { parseCodexStructuredResponse } = await import("./codex-tool");
      const input = JSON.stringify({
        summary: "Fixed the bug",
        referenceDocuments: [
          { filePath: "memory-bank/codex/report.md", description: "Details" },
        ],
      });
      const result = parseCodexStructuredResponse(input);
      expect(result).toEqual({
        summary: "Fixed the bug",
        referenceDocuments: [
          { filePath: "memory-bank/codex/report.md", description: "Details" },
        ],
      });
    });

    it("returns null for non-JSON text", async () => {
      const { parseCodexStructuredResponse } = await import("./codex-tool");
      expect(parseCodexStructuredResponse("just plain text")).toBeNull();
    });

    it("returns null when summary is missing", async () => {
      const { parseCodexStructuredResponse } = await import("./codex-tool");
      const input = JSON.stringify({
        referenceDocuments: [],
      });
      expect(parseCodexStructuredResponse(input)).toBeNull();
    });

    it("returns null when referenceDocuments is missing", async () => {
      const { parseCodexStructuredResponse } = await import("./codex-tool");
      const input = JSON.stringify({
        summary: "done",
      });
      expect(parseCodexStructuredResponse(input)).toBeNull();
    });

    it("returns null when referenceDocuments items have wrong shape", async () => {
      const { parseCodexStructuredResponse } = await import("./codex-tool");
      const input = JSON.stringify({
        summary: "done",
        referenceDocuments: [{ path: "wrong-key" }],
      });
      expect(parseCodexStructuredResponse(input)).toBeNull();
    });

    it("accepts empty referenceDocuments array", async () => {
      const { parseCodexStructuredResponse } = await import("./codex-tool");
      const input = JSON.stringify({
        summary: "No files needed",
        referenceDocuments: [],
      });
      const result = parseCodexStructuredResponse(input);
      expect(result).toEqual({
        summary: "No files needed",
        referenceDocuments: [],
      });
    });
  });

  // ============================================================
  // 8. Prompt hint helper
  // ============================================================

  describe("getCodexToolPromptHint", () => {
    it("returns null when disabled", async () => {
      const { getCodexToolPromptHint } = await import("./codex-tool");
      expect(getCodexToolPromptHint(false)).toBeNull();
    });

    it("returns a hint string when enabled", async () => {
      const { getCodexToolPromptHint } = await import("./codex-tool");
      const hint = getCodexToolPromptHint(true);
      expect(hint).not.toBeNull();
      expect(hint).toContain("run_codex");
      expect(hint).toContain("summary");
      expect(hint).toContain("referenceDocuments");
    });
  });
});

// ============================================================
// Mock deps factory
// ============================================================

function createMockDeps(runResult?: {
  exitCode?: number | null;
  stderr?: string;
  timedOut?: boolean;
  parseState?: CodexJsonParseState;
}): CodexToolDeps & {
  mockRunCodexExec: ReturnType<typeof vi.fn>;
  mockEnsureDir: ReturnType<typeof vi.fn>;
  mockWriteFile: ReturnType<typeof vi.fn>;
} {
  const mockRunCodexExec = vi.fn().mockResolvedValue({
    exitCode: runResult?.exitCode ?? 0,
    stderr: runResult?.stderr ?? "",
    timedOut: runResult?.timedOut ?? false,
    parseState: runResult?.parseState ?? {
      lineCount: 1,
      lastAgentMessage: "ok",
      lastErrorMessage: null,
    },
  });
  const mockEnsureDir = vi.fn().mockResolvedValue(undefined);
  const mockWriteFile = vi.fn().mockResolvedValue(undefined);

  return {
    buildChildEnv: vi.fn(
      () => ({}),
    ) as unknown as CodexToolDeps["buildChildEnv"],
    ensureDir: mockEnsureDir,
    writeFile: mockWriteFile,
    runCodexExec: mockRunCodexExec,
    mockRunCodexExec,
    mockEnsureDir,
    mockWriteFile,
  };
}

class FakeCodexChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill = vi.fn((signal?: NodeJS.Signals) => {
    this.killed = true;
    return signal !== undefined;
  });
}

async function importCodexToolWithSpawn(spawnImpl: ReturnType<typeof vi.fn>) {
  vi.resetModules();
  getCapturedTools().clear();
  vi.doMock("node:child_process", () => ({
    spawn: spawnImpl,
  }));
  vi.doMock("node:fs/promises", () => ({
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
  }));
  return import("./codex-tool");
}
