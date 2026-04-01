import { describe, it, expect, vi, beforeEach } from "vitest";

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

import type { CodexToolDeps } from "./codex-tool";

describe("codex-tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCapturedTools().clear();
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

    it("passes config timeout (seconds) as timeoutMs to context", async () => {
      const { maybeCreateCodexToolServer } = await import("./codex-tool");
      const mockDeps = createMockDeps();

      maybeCreateCodexToolServer(
        { enabled: true, timeout: 120 },
        { worktreePath: "/wt", sessionName: "s1" },
        mockDeps,
      );

      const handler = getHandler("run_codex");
      await handler({ prompt: "test" });

      const callArgs = mockDeps.mockRunCodex.mock.calls[0]![0] as {
        timeoutMs: number;
      };
      expect(callArgs.timeoutMs).toBe(120_000);
    });

    it("uses default timeout when config timeout is undefined", async () => {
      const { maybeCreateCodexToolServer } = await import("./codex-tool");
      const mockDeps = createMockDeps();

      maybeCreateCodexToolServer(
        { enabled: true },
        { worktreePath: "/wt", sessionName: "s1" },
        mockDeps,
      );

      const handler = getHandler("run_codex");
      await handler({ prompt: "test" });

      const callArgs = mockDeps.mockRunCodex.mock.calls[0]![0] as {
        timeoutMs: number;
      };
      expect(callArgs.timeoutMs).toBe(600_000);
    });

    it("disables timeout when config timeout is null", async () => {
      const { maybeCreateCodexToolServer } = await import("./codex-tool");
      const mockDeps = createMockDeps();

      maybeCreateCodexToolServer(
        { enabled: true, timeout: null },
        { worktreePath: "/wt", sessionName: "s1" },
        mockDeps,
      );

      const handler = getHandler("run_codex");
      await handler({ prompt: "test" });

      const callArgs = mockDeps.mockRunCodex.mock.calls[0]![0] as {
        timeoutMs: number;
      };
      // null means no timeout — pass 0 to signal "no timeout"
      expect(callArgs.timeoutMs).toBe(0);
    });
  });

  // ============================================================
  // 3. Handler behavior
  // ============================================================

  describe("run_codex handler", () => {
    it("uses context defaults when tool args omit them", async () => {
      const { createCodexToolServer } = await import("./codex-tool");
      const mockDeps = createMockDeps();

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

      const callArgs = mockDeps.mockRunCodex.mock.calls[0]![0] as {
        model?: string;
        reasoningEffort?: string;
      };
      expect(callArgs.model).toBe("o3");
      expect(callArgs.reasoningEffort).toBe("medium");
    });

    it("tool args override context defaults", async () => {
      const { createCodexToolServer } = await import("./codex-tool");
      const mockDeps = createMockDeps();

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

      const callArgs = mockDeps.mockRunCodex.mock.calls[0]![0] as {
        model?: string;
        reasoningEffort?: string;
      };
      expect(callArgs.model).toBe("gpt-5-codex");
      expect(callArgs.reasoningEffort).toBe("xhigh");
    });

    it("ensures memory-bank/codex dir exists before invocation", async () => {
      const { createCodexToolServer } = await import("./codex-tool");
      const mockDeps = createMockDeps();

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

    it("wraps the user prompt with Codex instructions", async () => {
      const { createCodexToolServer } = await import("./codex-tool");
      const mockDeps = createMockDeps();

      createCodexToolServer(
        { worktreePath: "/wt", sessionName: "s1" },
        mockDeps,
      );

      const handler = getHandler("run_codex");
      await handler({ prompt: "fix the login bug" });

      const callArgs = mockDeps.mockRunCodex.mock.calls[0]![0] as {
        prompt: string;
      };
      expect(callArgs.prompt).toContain("memory-bank/codex/");
      expect(callArgs.prompt).toContain("fix the login bug");
      expect(callArgs.prompt).not.toBe("fix the login bug");
    });

    it("passes outputSchema to runCodex", async () => {
      const { createCodexToolServer, CODEX_OUTPUT_SCHEMA } =
        await import("./codex-tool");
      const mockDeps = createMockDeps();

      createCodexToolServer(
        { worktreePath: "/wt", sessionName: "s1" },
        mockDeps,
      );

      const handler = getHandler("run_codex");
      await handler({ prompt: "do it" });

      const callArgs = mockDeps.mockRunCodex.mock.calls[0]![0] as {
        outputSchema: unknown;
      };
      expect(callArgs.outputSchema).toEqual(CODEX_OUTPUT_SCHEMA);
    });

    it("passes workingDirectory to runCodex", async () => {
      const { createCodexToolServer } = await import("./codex-tool");
      const mockDeps = createMockDeps();

      createCodexToolServer(
        { worktreePath: "/wt", sessionName: "s1" },
        mockDeps,
      );

      const handler = getHandler("run_codex");
      await handler({ prompt: "do it" });

      const callArgs = mockDeps.mockRunCodex.mock.calls[0]![0] as {
        workingDirectory: string;
      };
      expect(callArgs.workingDirectory).toBe("/wt");
    });

    it("returns structured JSON when Codex produces valid structured response", async () => {
      const { createCodexToolServer } = await import("./codex-tool");
      const structured = JSON.stringify({
        summary: "Fixed the bug",
        referenceDocuments: [
          { filePath: "memory-bank/codex/report.md", description: "Details" },
        ],
      });
      const mockDeps = createMockDeps({ response: structured });

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
      const mockDeps = createMockDeps({ response: "All tests pass now." });

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
        response: null,
        timedOut: true,
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
      const mockDeps = createMockDeps({
        response: null,
        error: "spawn codex ENOENT: not found",
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
      expect(result.content[0]!.text).toContain("not installed");
    });

    it("returns isError for execution errors", async () => {
      const { createCodexToolServer } = await import("./codex-tool");
      const mockDeps = createMockDeps({
        response: null,
        error: "authentication failed",
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
      expect(result.content[0]!.text).toContain("authentication failed");
    });

    it("returns isError when no response is returned", async () => {
      const { createCodexToolServer } = await import("./codex-tool");
      const mockDeps = createMockDeps({
        response: null,
        error: null,
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
      expect(result.content[0]!.text).toContain(
        "without emitting a final response",
      );
    });

    it("sets CLAUDECODE env var to empty string", async () => {
      const { createCodexToolServer } = await import("./codex-tool");
      const mockDeps = createMockDeps();

      createCodexToolServer(
        { worktreePath: "/wt", sessionName: "s1" },
        mockDeps,
      );

      const handler = getHandler("run_codex");
      await handler({ prompt: "do it" });

      const callArgs = mockDeps.mockRunCodex.mock.calls[0]![0] as {
        env: Record<string, string>;
      };
      expect(callArgs.env.CLAUDECODE).toBe("");
    });
  });

  // ============================================================
  // 4. Prompt wrapping
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
  // 5. Structured response parsing
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
  // 6. Prompt hint helper
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

  // ============================================================
  // 7. toStringEnv helper
  // ============================================================

  describe("toStringEnv", () => {
    it("strips undefined values from env", async () => {
      const { toStringEnv } = await import("./codex-tool");
      const result = toStringEnv({
        FOO: "bar",
        BAZ: undefined,
        QUX: "quux",
      } as unknown as NodeJS.ProcessEnv);
      expect(result).toEqual({ FOO: "bar", QUX: "quux" });
      expect("BAZ" in result).toBe(false);
    });
  });
});

// ============================================================
// Mock deps factory
// ============================================================

function createMockDeps(runResult?: {
  response?: string | null;
  error?: string | null;
  timedOut?: boolean;
}): CodexToolDeps & {
  mockRunCodex: ReturnType<typeof vi.fn>;
  mockEnsureDir: ReturnType<typeof vi.fn>;
} {
  const mockRunCodex = vi.fn().mockResolvedValue({
    response: "response" in (runResult ?? {}) ? runResult!.response : "ok",
    error: "error" in (runResult ?? {}) ? runResult!.error : null,
    timedOut: runResult?.timedOut ?? false,
  });
  const mockEnsureDir = vi.fn().mockResolvedValue(undefined);

  return {
    buildChildEnv: vi.fn(
      () => ({}),
    ) as unknown as CodexToolDeps["buildChildEnv"],
    ensureDir: mockEnsureDir,
    runCodex: mockRunCodex,
    mockRunCodex,
    mockEnsureDir,
  };
}
