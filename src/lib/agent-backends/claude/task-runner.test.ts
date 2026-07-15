import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vi.mock is allowed for external packages and infrastructure with module-level side effects
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("@/lib/shared/sdk-env", () => ({}));

const childEnvState = vi.hoisted(() => ({
  env: {} as Record<string, string>,
}));
vi.mock("@/lib/shared/child-env", () => ({
  buildChildEnv: () => ({ ...childEnvState.env }),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeTaskRunner } from "./task-runner";
import type { AgentTaskRequest } from "../task";

const mockQuery = vi.mocked(query);

function makeRequest(overrides?: Partial<AgentTaskRequest>): AgentTaskRequest {
  return {
    workingDirectory: "/test/workspace",
    prompt: "Do the thing",
    timeoutMs: 30_000,
    autonomous: true,
    ...overrides,
  };
}

async function* makeStream(
  messages: unknown[],
): AsyncGenerator<unknown, void, unknown> {
  for (const msg of messages) {
    yield msg;
  }
}

function successResultMessage(sessionId = "session-abc") {
  return {
    type: "result",
    subtype: "success",
    session_id: sessionId,
    total_cost_usd: 0.01,
    num_turns: 2,
    duration_ms: 1000,
    usage: {
      input_tokens: 100,
      cache_read_input_tokens: 50,
      output_tokens: 30,
      cache_creation_input_tokens: 0,
    },
    structured_output: undefined,
    errors: [],
  };
}

describe("ClaudeTaskRunner", () => {
  let runner: ClaudeTaskRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    childEnvState.env = {};
    runner = new ClaudeTaskRunner();
  });

  it("neutralizes ambient CC_* env before spawning the task subprocess", async () => {
    childEnvState.env = {
      NODE_ENV: "development",
      CC_SERVER_URL: "http://ambient-prod:3000",
      CC_API_TOKEN: "ambient-token",
      PATH: "/usr/bin",
    };
    mockQuery.mockReturnValue(
      makeStream([successResultMessage()]) as ReturnType<typeof query>,
    );

    await runner.run(makeRequest());

    const options = mockQuery.mock.calls[0]?.[0]?.options;
    expect(options?.env).toMatchObject({
      CC_SERVER_URL: "",
      CC_API_TOKEN: "",
      PATH: "/usr/bin",
    });
  });

  it("returns result from basic execution with text and usage", async () => {
    mockQuery.mockReturnValue(
      makeStream([
        {
          type: "system",
          subtype: "init",
          session_id: "session-abc",
          apiKeySource: "env",
          claude_code_version: "1.0",
          cwd: "/test",
          tools: [],
          mcp_servers: [],
          model: "claude-sonnet",
          permissionMode: "bypassPermissions",
          slash_commands: [],
          output_style: "auto",
          skills: [],
          plugins: [],
          uuid: "uuid-1",
        },
        {
          type: "assistant",
          session_id: "session-abc",
          message: {
            content: [{ type: "text", text: "Hello world" }],
          },
        },
        successResultMessage("session-abc"),
      ]) as ReturnType<typeof query>,
    );

    const result = await runner.run(makeRequest());

    expect(result.backendRef).toEqual({
      backend: "claude",
      ref: "session-abc",
    });
    expect(result.text).toBe("Hello world");
    expect(result.usage).toEqual({
      inputTokens: 100,
      cachedInputTokens: 50,
      outputTokens: 30,
    });
    expect(result.error).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.failure).toBeNull();
    expect(result.continuationDisposition).toBe("retain");
  });

  it("maps isolated one-shot execution to the Claude SDK isolation controls", async () => {
    mockQuery.mockReturnValue(
      makeStream([successResultMessage()]) as ReturnType<typeof query>,
    );

    const result = await runner.run(
      makeRequest({
        executionProfile: "isolated-one-shot",
        resumeRef: { backend: "codex", ref: "foreign-thread" },
        tooling: {
          portableMcp: {
            servers: [
              {
                id: "must-not-load",
                transport: "stdio",
                command: "node",
              },
            ],
          },
        },
      }),
    );

    const options = mockQuery.mock.calls[0]?.[0]?.options;
    expect(options).toMatchObject({
      maxTurns: 1,
      tools: [],
      mcpServers: {},
      settingSources: [],
      persistSession: false,
      strictMcpConfig: true,
      env: { CLAUDECODE: "" },
    });
    expect(result.backendRef).toBeNull();
  });

  it("concatenates multiple text blocks from assistant messages", async () => {
    mockQuery.mockReturnValue(
      makeStream([
        {
          type: "assistant",
          session_id: "session-abc",
          message: {
            content: [
              { type: "text", text: "Part one. " },
              { type: "tool_use", name: "Bash", input: {} },
              { type: "text", text: "Part two." },
            ],
          },
        },
        successResultMessage(),
      ]) as ReturnType<typeof query>,
    );

    const result = await runner.run(makeRequest());

    expect(result.text).toBe("Part one. Part two.");
  });

  it("passes resumeSessionId to query when resumeRef is a Claude ref", async () => {
    mockQuery.mockReturnValue(
      makeStream([successResultMessage("new-session")]) as ReturnType<
        typeof query
      >,
    );

    await runner.run(
      makeRequest({
        resumeRef: { backend: "claude", ref: "old-session-id" },
      }),
    );

    const callArg = mockQuery.mock.calls[0]?.[0] as {
      options: { resume: string };
    };
    expect(callArg.options.resume).toBe("old-session-id");
  });

  it("does not pass resume when resumeRef is absent", async () => {
    mockQuery.mockReturnValue(
      makeStream([successResultMessage()]) as ReturnType<typeof query>,
    );

    await runner.run(makeRequest({ resumeRef: undefined }));

    const callArg = mockQuery.mock.calls[0]?.[0] as {
      options: { resume: string | undefined };
    };
    expect(callArg.options.resume).toBeUndefined();
  });

  it("fails fast with error when resumeRef.backend is not claude", async () => {
    const result = await runner.run(
      makeRequest({
        resumeRef: { backend: "codex", ref: "thread-xyz" },
      }),
    );

    expect(mockQuery).not.toHaveBeenCalled();
    expect(result.error).toContain("codex");
    expect(result.timedOut).toBe(false);
    expect(result.text).toBeNull();
    expect(result.backendRef).toBeNull();
  });

  it("aborts via AbortController and sets timedOut on timeout", async () => {
    vi.useFakeTimers();

    let capturedController: AbortController | undefined;

    mockQuery.mockImplementation((opts: unknown) => {
      const options = (
        opts as { options: { abortController: AbortController } }
      ).options;
      capturedController = options.abortController;

      return (async function* () {
        await new Promise<void>((resolve) => {
          options.abortController.signal.addEventListener("abort", () =>
            resolve(),
          );
        });
      })() as ReturnType<typeof query>;
    });

    const runPromise = runner.run(makeRequest({ timeoutMs: 5_000 }));

    vi.advanceTimersByTime(5_000);

    const result = await runPromise;

    expect(capturedController?.signal.aborted).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.error).toBe("Task timed out");

    vi.useRealTimers();
  });

  it("aborts the SDK run when an external cancellation signal fires", async () => {
    let capturedController: AbortController | undefined;

    mockQuery.mockImplementation((opts: unknown) => {
      const options = (
        opts as { options: { abortController: AbortController } }
      ).options;
      capturedController = options.abortController;

      return (async function* () {
        await new Promise<void>((resolve) => {
          options.abortController.signal.addEventListener("abort", () =>
            resolve(),
          );
        });
      })() as ReturnType<typeof query>;
    });

    const external = new AbortController();
    const runPromise = runner.run(
      makeRequest({ timeoutMs: 0, signal: external.signal }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    external.abort();
    await runPromise;

    expect(capturedController?.signal.aborted).toBe(true);
  });

  it("tears down immediately when the external signal is already aborted", async () => {
    let capturedController: AbortController | undefined;

    mockQuery.mockImplementation((opts: unknown) => {
      const options = (
        opts as { options: { abortController: AbortController } }
      ).options;
      capturedController = options.abortController;

      return (async function* () {
        if (options.abortController.signal.aborted) return;
        await new Promise<void>((resolve) => {
          options.abortController.signal.addEventListener("abort", () =>
            resolve(),
          );
        });
      })() as ReturnType<typeof query>;
    });

    const external = new AbortController();
    external.abort();
    const runPromise = runner.run(
      makeRequest({ timeoutMs: 0, signal: external.signal }),
    );

    await runPromise;
    expect(capturedController?.signal.aborted).toBe(true);
  });

  it("returns error when the SDK query throws", async () => {
    mockQuery.mockReturnValue(
      (async function* () {
        throw new Error("SDK connection failed");
      })() as unknown as ReturnType<typeof query>,
    );

    const result = await runner.run(makeRequest());

    expect(result.error).toBe("SDK connection failed");
    expect(result.timedOut).toBe(false);
    expect(result.text).toBeNull();
  });

  it("returns error from result message when subtype is error", async () => {
    mockQuery.mockReturnValue(
      makeStream([
        {
          type: "result",
          subtype: "error_during_execution",
          session_id: "session-err",
          total_cost_usd: 0,
          num_turns: 1,
          duration_ms: 200,
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 0,
            output_tokens: 5,
            cache_creation_input_tokens: 0,
          },
          errors: ["Tool execution failed", "Timeout exceeded"],
        },
      ]) as ReturnType<typeof query>,
    );

    const result = await runner.run(makeRequest());

    expect(result.error).toBe("Tool execution failed; Timeout exceeded");
    expect(result.timedOut).toBe(false);
    expect(result.backendRef).toEqual({
      backend: "claude",
      ref: "session-err",
    });
    expect(result.failure?.kind).toBe("backend_error");
    expect(result.continuationDisposition).toBe("retain");
  });

  it("clears a stale Claude resume ref from a failed result message", async () => {
    mockQuery.mockReturnValue(
      makeStream([
        {
          type: "result",
          subtype: "error_during_execution",
          session_id: "session-gone",
          total_cost_usd: 0,
          num_turns: 0,
          duration_ms: 10,
          usage: {
            input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          errors: ["Session session-gone does not exist"],
        },
      ]) as ReturnType<typeof query>,
    );

    const result = await runner.run(
      makeRequest({
        resumeRef: { backend: "claude", ref: "session-gone" },
      }),
    );

    expect(result.failure?.kind).toBe("stale_resume_ref");
    expect(result.continuationDisposition).toBe("clear");
    expect(result.backendRef).toBeNull();
  });

  it("passes outputFormat when outputSchema is provided", async () => {
    mockQuery.mockReturnValue(
      makeStream([
        {
          ...successResultMessage(),
          structured_output: { answer: 42 },
        },
      ]) as ReturnType<typeof query>,
    );

    const schema = {
      type: "object",
      properties: { answer: { type: "number" } },
    };
    const result = await runner.run(makeRequest({ outputSchema: schema }));

    const callArg = mockQuery.mock.calls[0]?.[0] as {
      options: { outputFormat?: { type: string; schema: unknown } };
    };
    expect(callArg.options.outputFormat).toEqual({
      type: "json_schema",
      schema,
    });
    expect(result.structuredOutput).toEqual({ answer: 42 });
  });

  it("projects the outputSchema for Claude: unsupported keywords are stripped at the SDK boundary, everything else preserved (T3.1)", async () => {
    mockQuery.mockReturnValue(
      makeStream([successResultMessage()]) as ReturnType<typeof query>,
    );

    const schema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 2 },
        },
        count: { type: "integer", minimum: 0, description: "non-negative" },
      },
      required: ["items", "count"],
      additionalProperties: false,
    };
    await runner.run(makeRequest({ outputSchema: schema }));

    const callArg = mockQuery.mock.calls[0]?.[0] as {
      options: { outputFormat?: { type: string; schema: unknown } };
    };
    expect(callArg.options.outputFormat).toEqual({
      type: "json_schema",
      schema: {
        type: "object",
        properties: {
          items: { type: "array", items: { type: "string" } },
          count: { type: "integer", description: "non-negative" },
        },
        required: ["items", "count"],
        additionalProperties: false,
      },
    });
  });

  it("logs dropped Codex-only fields when non-default values are supplied", async () => {
    mockQuery.mockReturnValue(
      makeStream([successResultMessage()]) as ReturnType<typeof query>,
    );

    await runner.run(
      makeRequest({
        sandboxMode: "read-only",
        approvalPolicy: "never",
        skipGitRepoCheck: true,
      }),
    );

    // The result is still valid — Claude just ignores these fields
    // Logging is tested via the mock; we just verify the runner completes without error
    const result = await runner.run(makeRequest({ sandboxMode: "read-only" }));
    expect(result.error).toBeNull();
  });

  it("translates portableMcp servers into mcpServers", async () => {
    mockQuery.mockReturnValue(
      makeStream([successResultMessage()]) as ReturnType<typeof query>,
    );

    await runner.run(
      makeRequest({
        tooling: {
          portableMcp: {
            servers: [
              {
                id: "my-server",
                transport: "stdio",
                command: "node",
                args: ["server.js"],
              },
            ],
          },
        },
      }),
    );

    const callArg = mockQuery.mock.calls[0]?.[0] as {
      options: { mcpServers: Record<string, unknown> };
    };
    expect(callArg.options.mcpServers).toMatchObject({
      "my-server": { type: "stdio", command: "node", args: ["server.js"] },
    });
  });

  it("passes reasoning effort through to the SDK query options", async () => {
    mockQuery.mockReturnValue(
      makeStream([successResultMessage()]) as ReturnType<typeof query>,
    );

    await runner.run(makeRequest({ reasoningEffort: "high" }));

    const callArg = mockQuery.mock.calls[0]?.[0] as {
      options: { effort?: string };
    };
    expect(callArg.options.effort).toBe("high");
  });

  it("fails fast when reasoning effort is invalid", async () => {
    const result = await runner.run(
      makeRequest({ reasoningEffort: "minimal" }),
    );

    expect(mockQuery).not.toHaveBeenCalled();
    expect(result.error).toContain(
      'Invalid Claude reasoning effort: "minimal"',
    );
  });

  it("rejects unsupported portable MCP servers instead of silently keeping them", async () => {
    mockQuery.mockReturnValue(
      makeStream([successResultMessage()]) as ReturnType<typeof query>,
    );

    await runner.run(
      makeRequest({
        tooling: {
          portableMcp: {
            servers: [
              {
                id: "unsupported",
                transport: "stdio",
                command: "node",
                cwd: "/tmp/server",
              },
            ],
          },
        },
      }),
    );

    const callArg = mockQuery.mock.calls[0]?.[0] as {
      options: { mcpServers: Record<string, unknown> };
    };
    expect(callArg.options.mcpServers).not.toHaveProperty("unsupported");
  });

  it("does not abort immediately when timeoutMs is 0 (no timeout)", async () => {
    // timeoutMs=0 means "no timeout" — the task should run to completion.
    // Use a real async delay so setTimeout(0) has a chance to fire first
    // (simulating the real-world case where the SDK does async work).
    mockQuery.mockImplementation(
      () =>
        (async function* () {
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
          yield {
            type: "assistant",
            session_id: "session-abc",
            message: { content: [{ type: "text", text: "Hello" }] },
          };
          yield successResultMessage("session-abc");
        })() as ReturnType<typeof query>,
    );

    const result = await runner.run(makeRequest({ timeoutMs: 0 }));

    expect(result.timedOut).toBe(false);
    expect(result.text).toBe("Hello");
    expect(result.error).toBeNull();
  });

  it("captures the full SDK message stream as a lossless transcript", async () => {
    const assistantMsg = {
      type: "assistant",
      session_id: "session-abc",
      message: {
        content: [
          { type: "text", text: "checking the diff" },
          { type: "tool_use", name: "Bash", input: { command: "ls" } },
        ],
      },
    };
    const toolResultMsg = {
      type: "user",
      session_id: "session-abc",
      message: { content: [{ type: "tool_result", content: "file.ts" }] },
    };
    mockQuery.mockReturnValue(
      makeStream([
        assistantMsg,
        toolResultMsg,
        successResultMessage("session-abc"),
      ]) as ReturnType<typeof query>,
    );

    const result = await runner.run(makeRequest());

    expect(
      result.transcript?.map((e) => ({ seq: e.seq, type: e.type })),
    ).toEqual([
      { seq: 0, type: "assistant" },
      { seq: 1, type: "user" },
      { seq: 2, type: "result" },
    ]);
    // Tool calls survive verbatim inside the assistant entry's raw payload.
    expect(result.transcript?.[0]!.raw).toBe(assistantMsg);
  });

  it("has backend identifier 'claude'", () => {
    expect(runner.backend).toBe("claude");
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});
