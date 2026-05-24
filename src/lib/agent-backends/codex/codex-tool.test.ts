import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import type { CodexToolDeps } from "./codex-tool";
import {
  CODEX_OUTPUT_SCHEMA,
  getCodexToolPromptHint,
  parseCodexStructuredResponse,
  registerCodexTool,
  wrapCodexPrompt,
} from "./codex-tool";
import type {
  ArtifactRegistry,
  ArtifactRegisterRequest,
} from "../../workflows/primitives/artifact-registry";

type ToolHandler = (args: unknown) => Promise<unknown>;

const TOOLS_KEY = "__test_codex_tool_captured";

function getCapturedTools(): Map<
  string,
  { name: string; handler: ToolHandler }
> {
  const g = globalThis as Record<string, unknown>;
  if (!g[TOOLS_KEY]) {
    g[TOOLS_KEY] = new Map();
  }
  return g[TOOLS_KEY] as Map<string, { name: string; handler: ToolHandler }>;
}

function createCapturingServer() {
  return {
    registerTool(name: string, _config: unknown, handler: ToolHandler): void {
      getCapturedTools().set(name, { name, handler });
    },
  };
}

function registerTool(
  deps: CodexToolDeps,
  overrides: Partial<{
    worktreePath: string;
    sessionName: string;
    defaultModel: string;
    defaultReasoningEffort: "minimal" | "low" | "medium" | "high" | "xhigh";
    timeoutMs: number;
  }> = {},
): void {
  registerCodexTool(
    createCapturingServer() as never,
    {
      worktreePath: "/wt",
      sessionName: "s1",
      ...overrides,
    },
    deps,
  );
}

function getHandler(name: string): ToolHandler {
  const tool = getCapturedTools().get(name);
  if (!tool) {
    throw new Error(`Tool ${name} not found in captured tools`);
  }
  return tool.handler;
}

describe("codex-tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCapturedTools().clear();
  });

  describe("registerCodexTool", () => {
    it("registers one tool named run_codex", () => {
      registerTool(createMockDeps());

      expect(getCapturedTools().has("run_codex")).toBe(true);
      expect(getCapturedTools().size).toBe(1);
    });
  });

  describe("run_codex handler", () => {
    it("uses context defaults when tool args omit them", async () => {
      const mockDeps = createMockDeps();
      registerTool(mockDeps, {
        defaultModel: "o3",
        defaultReasoningEffort: "medium",
      });

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
      const mockDeps = createMockDeps();
      registerTool(mockDeps, {
        defaultModel: "o3",
        defaultReasoningEffort: "medium",
      });

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
      const mockDeps = createMockDeps();
      registerTool(mockDeps);

      const handler = getHandler("run_codex");
      await handler({ prompt: "do it" });

      expect(mockDeps.mockEnsureDir).toHaveBeenCalledWith(
        "/wt/memory-bank/codex",
      );
    });

    it("wraps the user prompt with Codex instructions", async () => {
      const mockDeps = createMockDeps();
      registerTool(mockDeps);

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
      const mockDeps = createMockDeps();
      registerTool(mockDeps);

      const handler = getHandler("run_codex");
      await handler({ prompt: "do it" });

      const callArgs = mockDeps.mockRunCodex.mock.calls[0]![0] as {
        outputSchema: unknown;
      };
      expect(callArgs.outputSchema).toEqual(CODEX_OUTPUT_SCHEMA);
    });

    it("passes workingDirectory to runCodex", async () => {
      const mockDeps = createMockDeps();
      registerTool(mockDeps);

      const handler = getHandler("run_codex");
      await handler({ prompt: "do it" });

      const callArgs = mockDeps.mockRunCodex.mock.calls[0]![0] as {
        workingDirectory: string;
      };
      expect(callArgs.workingDirectory).toBe("/wt");
    });

    it("uses no timeout when context timeout is undefined", async () => {
      const mockDeps = createMockDeps();
      registerTool(mockDeps);

      const handler = getHandler("run_codex");
      await handler({ prompt: "test" });

      const callArgs = mockDeps.mockRunCodex.mock.calls[0]![0] as {
        timeoutMs: number;
      };
      expect(callArgs.timeoutMs).toBe(0);
    });

    it("passes context timeoutMs through to runCodex", async () => {
      const mockDeps = createMockDeps();
      registerTool(mockDeps, { timeoutMs: 120_000 });

      const handler = getHandler("run_codex");
      await handler({ prompt: "test" });

      const callArgs = mockDeps.mockRunCodex.mock.calls[0]![0] as {
        timeoutMs: number;
      };
      expect(callArgs.timeoutMs).toBe(120_000);
    });

    it("supports disabling the timeout with timeoutMs 0", async () => {
      const mockDeps = createMockDeps();
      registerTool(mockDeps, { timeoutMs: 0 });

      const handler = getHandler("run_codex");
      await handler({ prompt: "test" });

      const callArgs = mockDeps.mockRunCodex.mock.calls[0]![0] as {
        timeoutMs: number;
      };
      expect(callArgs.timeoutMs).toBe(0);
    });

    it("returns structured JSON when Codex produces valid structured response", async () => {
      const structured = JSON.stringify({
        summary: "Fixed the bug",
        referenceDocuments: [
          { filePath: "memory-bank/codex/report.md", description: "Details" },
        ],
      });
      const mockDeps = createMockDeps({ response: structured });
      registerTool(mockDeps);

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

    it("prefers SDK structuredOutput over reparsing final text", async () => {
      const structuredOutput = {
        summary: "Used SDK structured output",
        referenceDocuments: [
          { filePath: "memory-bank/codex/sdk.md", description: "SDK result" },
        ],
      };
      const mockDeps = createMockDeps({
        response: "not valid json",
        structuredOutput,
      });
      registerTool(mockDeps);

      const handler = getHandler("run_codex");
      const result = (await handler({ prompt: "fix tests" })) as {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      };

      expect(JSON.parse(result.content[0]!.text)).toEqual(structuredOutput);
      expect(result.isError).toBeUndefined();
    });

    it("falls back to raw text when response is not valid structured JSON", async () => {
      const mockDeps = createMockDeps({ response: "All tests pass now." });
      registerTool(mockDeps);

      const handler = getHandler("run_codex");
      const result = (await handler({ prompt: "fix tests" })) as {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      };

      expect(result.content[0]!.text).toBe("All tests pass now.");
      expect(result.isError).toBeUndefined();
    });

    it("returns isError for timeout", async () => {
      const mockDeps = createMockDeps({
        response: null,
        timedOut: true,
      });
      registerTool(mockDeps);

      const handler = getHandler("run_codex");
      const result = (await handler({ prompt: "fix" })) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("timed out");
    });

    it("returns isError when CLI is not found", async () => {
      const mockDeps = createMockDeps({
        response: null,
        error: "spawn codex ENOENT: not found",
      });
      registerTool(mockDeps);

      const handler = getHandler("run_codex");
      const result = (await handler({ prompt: "fix" })) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("not installed");
    });

    it("returns isError for execution errors", async () => {
      const mockDeps = createMockDeps({
        response: null,
        error: "authentication failed",
      });
      registerTool(mockDeps);

      const handler = getHandler("run_codex");
      const result = (await handler({ prompt: "fix" })) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("authentication failed");
    });

    it("returns isError when no response is returned", async () => {
      const mockDeps = createMockDeps({
        response: null,
        error: null,
      });
      registerTool(mockDeps);

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
  });

  describe("reference document registration", () => {
    it("registers each structured reference document with the artifact registry", async () => {
      const structured = JSON.stringify({
        summary: "Did the thing",
        referenceDocuments: [
          {
            filePath: "memory-bank/codex/report.md",
            description: "Detailed report",
          },
          {
            filePath: "memory-bank/codex/notes.md",
            description: "Investigation notes",
          },
        ],
      });
      const mockDeps = createMockDeps({ response: structured });
      registerTool(mockDeps, { worktreePath: "/wt" });

      const handler = getHandler("run_codex");
      await handler({ prompt: "investigate" });

      expect(mockDeps.mockRegister).toHaveBeenCalledTimes(2);
      const first = mockDeps.mockRegister.mock
        .calls[0]![0] as ArtifactRegisterRequest;
      expect(first).toMatchObject({
        kind: "reference_document",
        worktreePath: "/wt",
        relativePath: "memory-bank/codex/report.md",
        description: "Detailed report",
      });
      const second = mockDeps.mockRegister.mock
        .calls[1]![0] as ArtifactRegisterRequest;
      expect(second).toMatchObject({
        kind: "reference_document",
        worktreePath: "/wt",
        relativePath: "memory-bank/codex/notes.md",
        description: "Investigation notes",
      });
    });

    it("prefers SDK structuredOutput when registering reference documents", async () => {
      const structuredOutput = {
        summary: "ok",
        referenceDocuments: [
          {
            filePath: "memory-bank/codex/sdk.md",
            description: "from sdk",
          },
        ],
      };
      const mockDeps = createMockDeps({
        response: "not json",
        structuredOutput,
      });
      registerTool(mockDeps);

      const handler = getHandler("run_codex");
      await handler({ prompt: "x" });

      expect(mockDeps.mockRegister).toHaveBeenCalledTimes(1);
      const req = mockDeps.mockRegister.mock
        .calls[0]![0] as ArtifactRegisterRequest;
      expect(req.relativePath).toBe("memory-bank/codex/sdk.md");
    });

    it("does not register when no structured response is parsed", async () => {
      const mockDeps = createMockDeps({ response: "plain text result" });
      registerTool(mockDeps);

      const handler = getHandler("run_codex");
      await handler({ prompt: "x" });

      expect(mockDeps.mockRegister).not.toHaveBeenCalled();
    });

    it("does not register when referenceDocuments is empty", async () => {
      const structured = JSON.stringify({
        summary: "nothing to file",
        referenceDocuments: [],
      });
      const mockDeps = createMockDeps({ response: structured });
      registerTool(mockDeps);

      const handler = getHandler("run_codex");
      await handler({ prompt: "x" });

      expect(mockDeps.mockRegister).not.toHaveBeenCalled();
    });

    it("continues registering remaining docs and returns structured response when one registration fails", async () => {
      const structured = JSON.stringify({
        summary: "two docs, one bad path",
        referenceDocuments: [
          { filePath: "/absolute/bad.md", description: "outside worktree" },
          {
            filePath: "memory-bank/codex/good.md",
            description: "good doc",
          },
        ],
      });
      const mockDeps = createMockDeps(
        { response: structured },
        {
          registerImpl: async (req) => {
            if (req.relativePath === "/absolute/bad.md") {
              throw new Error("absolute paths not permitted");
            }
            return {
              artifactId: "art",
              kind: req.kind,
              relativePath: req.relativePath,
              audience: "user_facing" as const,
              source: { createdAt: "2025-01-01T00:00:00.000Z" },
            };
          },
        },
      );
      registerTool(mockDeps);

      const handler = getHandler("run_codex");
      const result = (await handler({ prompt: "x" })) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };

      expect(mockDeps.mockRegister).toHaveBeenCalledTimes(2);
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.summary).toBe("two docs, one bad path");
    });

    it("does not call the registry when artifactRegistry dep is not provided", async () => {
      const structured = JSON.stringify({
        summary: "ok",
        referenceDocuments: [
          { filePath: "memory-bank/codex/x.md", description: "x" },
        ],
      });
      const mockDeps = createMockDeps(
        { response: structured },
        { artifactRegistry: null },
      );
      registerTool(mockDeps);

      const handler = getHandler("run_codex");
      const result = (await handler({ prompt: "x" })) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };

      expect(mockDeps.mockRegister).not.toHaveBeenCalled();
      expect(result.isError).toBeUndefined();
    });
  });

  describe("wrapCodexPrompt", () => {
    it("prepends instructions and preserves the original prompt", () => {
      const wrapped = wrapCodexPrompt("Fix the login bug");
      expect(wrapped).toContain("memory-bank/codex/");
      expect(wrapped).toContain("summary");
      expect(wrapped).toContain("referenceDocuments");
      expect(wrapped).toContain("Fix the login bug");
    });

    it("includes the 1000-character limit instruction", () => {
      const wrapped = wrapCodexPrompt("Do something");
      expect(wrapped).toContain("1000");
    });

    it("places the original prompt after the instructions", () => {
      const wrapped = wrapCodexPrompt("Do something");
      const instructionsEnd = wrapped.indexOf("Task:");
      const promptStart = wrapped.indexOf("Do something");
      expect(instructionsEnd).toBeGreaterThan(-1);
      expect(promptStart).toBeGreaterThan(instructionsEnd);
    });
  });

  describe("parseCodexStructuredResponse", () => {
    it("parses valid structured JSON", () => {
      const input = JSON.stringify({
        summary: "Fixed the bug",
        referenceDocuments: [
          { filePath: "memory-bank/codex/report.md", description: "Details" },
        ],
      });

      expect(parseCodexStructuredResponse(input)).toEqual({
        summary: "Fixed the bug",
        referenceDocuments: [
          { filePath: "memory-bank/codex/report.md", description: "Details" },
        ],
      });
    });

    it("returns null for non-JSON text", () => {
      expect(parseCodexStructuredResponse("just plain text")).toBeNull();
    });

    it("returns null when summary is missing", () => {
      const input = JSON.stringify({
        referenceDocuments: [],
      });
      expect(parseCodexStructuredResponse(input)).toBeNull();
    });

    it("returns null when referenceDocuments is missing", () => {
      const input = JSON.stringify({
        summary: "done",
      });
      expect(parseCodexStructuredResponse(input)).toBeNull();
    });

    it("returns null when referenceDocuments items have wrong shape", () => {
      const input = JSON.stringify({
        summary: "done",
        referenceDocuments: [{ path: "wrong-key" }],
      });
      expect(parseCodexStructuredResponse(input)).toBeNull();
    });

    it("accepts empty referenceDocuments array", () => {
      const input = JSON.stringify({
        summary: "No files needed",
        referenceDocuments: [],
      });
      expect(parseCodexStructuredResponse(input)).toEqual({
        summary: "No files needed",
        referenceDocuments: [],
      });
    });
  });

  describe("getCodexToolPromptHint", () => {
    it("returns null when disabled", () => {
      expect(getCodexToolPromptHint(false)).toBeNull();
    });

    it("returns a hint string when enabled", () => {
      const hint = getCodexToolPromptHint(true);
      expect(hint).not.toBeNull();
      expect(hint).toContain("run_codex");
      expect(hint).toContain("summary");
      expect(hint).toContain("referenceDocuments");
    });
  });
});

function createMockDeps(
  runResult?: {
    response?: string | null;
    error?: string | null;
    timedOut?: boolean;
    structuredOutput?: unknown;
  },
  opts?: {
    artifactRegistry?: ArtifactRegistry | null;
    registerImpl?: (req: ArtifactRegisterRequest) => Promise<unknown>;
  },
): CodexToolDeps & {
  mockRunCodex: ReturnType<typeof vi.fn>;
  mockEnsureDir: ReturnType<typeof vi.fn>;
  mockRegister: ReturnType<typeof vi.fn>;
} {
  const mockRunCodex = vi.fn().mockResolvedValue({
    response: "response" in (runResult ?? {}) ? runResult!.response : "ok",
    error: "error" in (runResult ?? {}) ? runResult!.error : null,
    timedOut: runResult?.timedOut ?? false,
    structuredOutput: runResult?.structuredOutput,
  });
  const mockEnsureDir = vi.fn().mockResolvedValue(undefined);
  const mockRegister = vi
    .fn<(req: ArtifactRegisterRequest) => Promise<unknown>>()
    .mockImplementation(
      opts?.registerImpl ??
        (async (req) => ({
          artifactId: "art-1",
          kind: req.kind,
          relativePath: req.relativePath,
          audience: "user_facing" as const,
          source: { createdAt: "2025-01-01T00:00:00.000Z" },
        })),
    );

  const artifactRegistry: ArtifactRegistry | undefined =
    opts?.artifactRegistry === null
      ? undefined
      : (opts?.artifactRegistry ??
        ({
          write: vi.fn(),
          writeOptional: vi.fn(),
          register: mockRegister,
        } as unknown as ArtifactRegistry));

  const deps: CodexToolDeps = {
    ensureDir: mockEnsureDir,
    runCodex: mockRunCodex,
    ...(artifactRegistry ? { artifactRegistry } : {}),
  };

  return {
    ...deps,
    mockRunCodex,
    mockEnsureDir,
    mockRegister,
  };
}
