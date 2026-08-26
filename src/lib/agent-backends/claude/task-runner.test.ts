import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vi.mock is allowed for external packages and infrastructure with module-level side effects
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

// Records every emitted event so the secrets-discipline checks can read the
// payloads the real loggers (this module's and session-env's) would write.
const logState = vi.hoisted(() => ({
  entries: [] as Array<{ event: string; fields?: unknown }>,
}));
vi.mock("@/lib/logging", () => {
  const record = (event: string, fields?: unknown) => {
    logState.entries.push({ event, fields });
  };
  return {
    createLogger: () => ({
      info: record,
      debug: record,
      warn: record,
      error: record,
    }),
  };
});

vi.mock("@/lib/shared/sdk-env", () => ({}));

const childEnvState = vi.hoisted(() => ({
  env: {} as Record<string, string>,
}));
vi.mock("@/lib/shared/child-env", () => ({
  buildChildEnv: () => ({ ...childEnvState.env }),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeTaskRunner } from "./task-runner";
import { CLAUDE_DEFAULT_STALL_TIMEOUT_MS } from "./shared";
import type { AgentTaskRequest } from "../task";
import { renderStructuredOutputInstruction } from "../structured-output-prompt";
import { CONVERSATION_CAPABILITY_ENV_VAR } from "@/lib/agent-gateway/conversation-capability";

const mockQuery = vi.mocked(query);

function makeRequest(overrides?: Partial<AgentTaskRequest>): AgentTaskRequest {
  return {
    workingDirectory: "/test/workspace",
    prompt: "Do the thing",
    timeoutMs: 30_000,
    autonomous: true,
    modelSelection: {
      modelId: "opus",
      parameters: { effort: "high" },
    },
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
    logState.entries = [];
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

  describe("opted-in CC session scope", () => {
    const SCOPE = {
      project: "command-center",
      session: "csm/collab-session",
      conversationId: "conv-originating",
    } as const;
    const RESOLVED_SERVER_URL = "http://127.0.0.1:4321";
    const RESOLVED_TOKEN = "instance-token-secret";

    function makeScopedRunner(): ClaudeTaskRunner {
      return new ClaudeTaskRunner({
        runQuery: (args) => query(args),
        getServerUrl: () => RESOLVED_SERVER_URL,
        getApiToken: () => RESOLVED_TOKEN,
        getConfigDir: () => "/cc/config",
      });
    }

    beforeEach(() => {
      childEnvState.env = {
        NODE_ENV: "development",
        PATH: "/usr/bin",
        CC_SERVER_URL: "http://ambient-prod:3000",
        CC_API_TOKEN: "ambient-token",
        CC_CONVERSATION_ID: "ambient-conversation",
        CC_WORKFLOW_EXECUTION_ID: "ambient-exec",
        CC_WORKFLOW_CONTEXT_ID: "ambient-ctx",
      };
      mockQuery.mockReturnValue(
        makeStream([successResultMessage()]) as ReturnType<typeof query>,
      );
    });

    it("gives the child the originating session identity with server-side credentials", async () => {
      await makeScopedRunner().run(
        makeRequest({ ccSessionScope: { ...SCOPE } }),
      );

      expect(mockQuery.mock.calls[0]?.[0]?.options?.env).toMatchObject({
        CC_SERVER_URL: RESOLVED_SERVER_URL,
        CC_API_TOKEN: RESOLVED_TOKEN,
        CC_PROJECT: SCOPE.project,
        CC_SESSION: SCOPE.session,
        CC_CONVERSATION_ID: SCOPE.conversationId,
      });
    });

    it("carries no launch capability, so the reserved planner and collaboration task runs cannot launch workflows (D7 D11/D12)", async () => {
      // A task run has the exact shape a shape-based rule would admit: a real
      // session, a real conversation id, and no lane identity. The reserved
      // planner runs through this path, so a capability here would hand the
      // planner the launch authority D12 refuses it. This path never receives
      // one because only the conversation actor mints, and it never spawns here.
      await makeScopedRunner().run(
        makeRequest({ ccSessionScope: { ...SCOPE } }),
      );

      const env = mockQuery.mock.calls[0]?.[0]?.options?.env;
      expect(env?.[CONVERSATION_CAPABILITY_ENV_VAR]).toBe(undefined);
    });

    it("neutralizes ambient CC_* first, so no outer workflow identity survives", async () => {
      await makeScopedRunner().run(
        makeRequest({ ccSessionScope: { ...SCOPE } }),
      );

      expect(mockQuery.mock.calls[0]?.[0]?.options?.env).toMatchObject({
        CC_WORKFLOW_EXECUTION_ID: "",
        CC_WORKFLOW_CONTEXT_ID: "",
      });
    });

    it("makes cctl resolvable by prepending the config bin directory to PATH", async () => {
      await makeScopedRunner().run(
        makeRequest({ ccSessionScope: { ...SCOPE } }),
      );

      expect(mockQuery.mock.calls[0]?.[0]?.options?.env?.PATH).toBe(
        "/cc/config/bin:/usr/bin",
      );
    });

    it("keeps the server URL and token out of logs and the task result", async () => {
      const result = await makeScopedRunner().run(
        makeRequest({ ccSessionScope: { ...SCOPE } }),
      );

      const emittedLogs = JSON.stringify(logState.entries);
      expect(emittedLogs).not.toContain(RESOLVED_TOKEN);
      expect(emittedLogs).not.toContain(RESOLVED_SERVER_URL);
      expect(logState.entries.length).toBeGreaterThan(0);
      const serializedResult = JSON.stringify(result);
      expect(serializedResult).not.toContain(RESOLVED_TOKEN);
      expect(serializedResult).not.toContain(RESOLVED_SERVER_URL);
    });

    it("leaves a scope-less run's env byte-identical to the neutralized env", async () => {
      await makeScopedRunner().run(makeRequest());

      // Exact object equality, not a subset match: a generic task run gains no
      // identity, no credentials, no PATH prepend, and no BASH ceiling.
      expect(mockQuery.mock.calls[0]?.[0]?.options?.env).toEqual({
        NODE_ENV: "development",
        PATH: "/usr/bin",
        CC_SERVER_URL: "",
        CC_API_TOKEN: "",
        CC_CONVERSATION_ID: "",
        CC_WORKFLOW_EXECUTION_ID: "",
        CC_WORKFLOW_CONTEXT_ID: "",
      });
    });

    it("fails the run without dispatching when the scope is malformed", async () => {
      const result = await makeScopedRunner().run(
        makeRequest({ ccSessionScope: { ...SCOPE, conversationId: "" } }),
      );

      expect(result.error).toContain("ccSessionScope");
      expect(result.text).toBeNull();
      expect(mockQuery).not.toHaveBeenCalled();
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

    // Async advance: the runner awaits managed-skills resolution before
    // dispatching, so the mock stream subscribes to the abort signal only
    // after a microtask — the async form yields to it before firing timers.
    await vi.advanceTimersByTimeAsync(5_000);

    const result = await runPromise;

    expect(capturedController?.signal.aborted).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.error).toBe("Task timed out");

    vi.useRealTimers();
  });

  it("bounds a task run with dead air even when the caller sets no stall bound", async () => {
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

    // No safety net and no explicit bound: without the backend default this
    // run has nothing to end it.
    const runPromise = runner.run(makeRequest({ timeoutMs: 0 }));

    await vi.advanceTimersByTimeAsync(CLAUDE_DEFAULT_STALL_TIMEOUT_MS);

    expect(capturedController?.signal.aborted).toBe(true);

    const result = await runPromise;
    expect(result.timedOut).toBe(true);
    expect(result.error).toBe(
      `Task stalled: no backend activity for ${CLAUDE_DEFAULT_STALL_TIMEOUT_MS}ms`,
    );

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

  it("classifies the typed structured-output retry exhaustion when errors are empty", async () => {
    mockQuery.mockReturnValue(
      makeStream([
        {
          type: "result",
          subtype: "error_max_structured_output_retries",
          session_id: "session-structured-output",
          total_cost_usd: 0,
          num_turns: 5,
          duration_ms: 200,
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 0,
            output_tokens: 5,
            cache_creation_input_tokens: 0,
          },
          errors: [],
        },
      ]) as ReturnType<typeof query>,
    );

    const result = await runner.run(makeRequest());

    expect(result.error).toBe("Agent exceeded structured output retry limit");
    expect(result.failure?.kind).toBe("structured_output_exhausted");
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

  it("renders the full output schema into the prompt without using SDK outputFormat", async () => {
    const responseText = '{"answer":42}';
    mockQuery.mockReturnValue(
      makeStream([
        {
          type: "assistant",
          session_id: "session-abc",
          message: {
            content: [{ type: "text", text: responseText }],
          },
        },
        {
          ...successResultMessage(),
          structured_output: { shouldNotSurface: true },
        },
      ]) as ReturnType<typeof query>,
    );

    const schema = {
      type: "object",
      properties: {
        answer: { type: "number", minimum: 1, maximum: 100 },
        label: { type: "string", minLength: 1 },
      },
      required: ["answer"],
    };
    const result = await runner.run(makeRequest({ outputSchema: schema }));

    const callArg = mockQuery.mock.calls[0]?.[0] as {
      prompt: string;
      options: { outputFormat?: { type: string; schema: unknown } };
    };
    expect(callArg.options).not.toHaveProperty("outputFormat");
    expect(callArg.prompt).toBe(
      `Do the thing\n\n${renderStructuredOutputInstruction(schema)}`,
    );
    expect(callArg.prompt).toContain('"minLength": 1');
    expect(callArg.prompt).toContain('"maximum": 100');
    expect(result.text).toBe(responseText);
    expect(result).not.toHaveProperty("structuredOutput");
  });

  it("uses the canonical final response text for structured output", async () => {
    const responseText = '{"answer":42}';
    mockQuery.mockReturnValue(
      makeStream([
        {
          type: "assistant",
          session_id: "session-abc",
          message: {
            content: [
              {
                type: "text",
                text: "I will inspect the inputs before formatting the answer.",
              },
            ],
          },
        },
        {
          type: "assistant",
          session_id: "session-abc",
          message: {
            content: [{ type: "text", text: responseText }],
          },
        },
        {
          ...successResultMessage(),
          result: responseText,
        },
      ]) as ReturnType<typeof query>,
    );

    const result = await runner.run(
      makeRequest({
        outputSchema: {
          type: "object",
          properties: { answer: { type: "number" } },
          required: ["answer"],
        },
      }),
    );

    expect(result.text).toBe(responseText);
  });

  it("does not append a duplicate schema contract when the prompt already contains it", async () => {
    mockQuery.mockReturnValue(
      makeStream([successResultMessage()]) as ReturnType<typeof query>,
    );
    const schema = {
      type: "object",
      properties: { answer: { type: "number" } },
      required: ["answer"],
    };
    const instruction = renderStructuredOutputInstruction(schema);
    const prompt = `Correct the prior response.\n\n${instruction}\n\nReturn only the corrected JSON object.`;

    await runner.run(makeRequest({ prompt, outputSchema: schema }));

    const callArg = mockQuery.mock.calls[0]?.[0] as { prompt: string };
    expect(callArg.prompt).toBe(prompt);
    expect(callArg.prompt.split(instruction)).toHaveLength(2);
  });

  it("leaves the prompt unchanged when no output schema is provided", async () => {
    mockQuery.mockReturnValue(
      makeStream([successResultMessage()]) as ReturnType<typeof query>,
    );

    await runner.run(makeRequest({ prompt: "Unchanged task prompt" }));

    const callArg = mockQuery.mock.calls[0]?.[0] as {
      prompt: string;
      options: { outputFormat?: unknown };
    };
    expect(callArg.prompt).toBe("Unchanged task prompt");
    expect(callArg.options).not.toHaveProperty("outputFormat");
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

  it("translates the complete model selection into SDK query options", async () => {
    mockQuery.mockReturnValue(
      makeStream([successResultMessage()]) as ReturnType<typeof query>,
    );

    await runner.run(
      makeRequest({
        modelSelection: {
          modelId: "fable",
          parameters: { effort: "max" },
        },
      }),
    );

    const callArg = mockQuery.mock.calls[0]?.[0] as {
      options: { model?: string; effort?: string };
    };
    expect(callArg.options).toMatchObject({ model: "fable", effort: "max" });
  });

  it("fails fast when the complete model selection is invalid", async () => {
    const result = await runner.run(
      makeRequest({
        modelSelection: {
          modelId: "opus",
          parameters: { effort: "minimal" },
        },
      }),
    );

    expect(mockQuery).not.toHaveBeenCalled();
    expect(result.error).toContain(
      'Value "minimal" is not supported for parameter "effort"',
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

  /**
   * R10.1 — governing instructions travel through Claude's privileged channel.
   *
   * Asserted on the options object handed to the SDK query, not on an internal
   * seam: `systemPrompt.append` on the `claude_code` preset is the system-role
   * channel, and the check that it is not folded into the user prompt is what
   * keeps a role contract from silently degrading to user priority.
   */
  describe("privileged instruction channel", () => {
    const INSTRUCTIONS = "# Role contract\nYou are read-only.";

    it("delivers systemInstructions as a system-prompt append", async () => {
      mockQuery.mockReturnValue(
        makeStream([successResultMessage()]) as ReturnType<typeof query>,
      );

      await runner.run(makeRequest({ systemInstructions: [INSTRUCTIONS] }));

      const options = mockQuery.mock.calls[0]?.[0]?.options;
      expect(options?.systemPrompt).toEqual({
        type: "preset",
        preset: "claude_code",
        append: INSTRUCTIONS,
      });
      expect(mockQuery.mock.calls[0]?.[0]?.prompt).toBe("Do the thing");
    });

    it("joins multiple instruction entries into the one append", async () => {
      mockQuery.mockReturnValue(
        makeStream([successResultMessage()]) as ReturnType<typeof query>,
      );

      await runner.run(
        makeRequest({ systemInstructions: ["first", "second"] }),
      );

      const systemPrompt = mockQuery.mock.calls[0]?.[0]?.options?.systemPrompt;
      expect(systemPrompt).toMatchObject({ append: "first\n\nsecond" });
    });

    it("appends nothing when a run governs nothing", async () => {
      mockQuery.mockReturnValue(
        makeStream([successResultMessage()]) as ReturnType<typeof query>,
      );

      await runner.run(makeRequest());

      const systemPrompt = mockQuery.mock.calls[0]?.[0]?.options?.systemPrompt;
      expect(systemPrompt).toEqual({
        type: "preset",
        preset: "claude_code",
        append: undefined,
      });
    });
  });

  /**
   * R7.1 — the adapter's half of the write envelope: what the real Claude CLI is
   * actually launched with when a run carries a server-derived policy. The OS
   * and the permission layer enforcing it are proven separately against the
   * installed runner; these assertions are the reason that proof stays true for
   * every future run.
   */
  describe("filesystem write envelope", () => {
    const SCRATCH = "/private/tmp/cc-validator-lanes/exec/ctx/reviewer";
    const LANE_TMP = `${SCRATCH}/tmp`;
    const WORKTREE = "/test/workspace";
    const SERVER_URL = "https://cc.tailnet.example:8443";
    const POLICY = {
      mode: "allowlist" as const,
      allowWrite: [SCRATCH, LANE_TMP],
      denyWrite: [WORKTREE],
    };

    beforeEach(() => {
      mockQuery.mockReturnValue(
        makeStream([successResultMessage()]) as ReturnType<typeof query>,
      );
      runner = new ClaudeTaskRunner({
        runQuery: (args) => query(args),
        getServerUrl: () => SERVER_URL,
        getApiToken: () => null,
        getConfigDir: () => "/cc/config",
      });
    });

    function deliveredOptions() {
      return mockQuery.mock.calls[0]?.[0]?.options;
    }

    it("enables the sandbox as a hard gate carrying the policy", async () => {
      await runner.run(makeRequest({ fsWritePolicy: POLICY }));

      expect(deliveredOptions()?.sandbox).toMatchObject({
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        filesystem: {
          allowWrite: [SCRATCH, LANE_TMP],
          denyWrite: [WORKTREE],
        },
      });
      expect(deliveredOptions()?.sandbox?.network).toEqual({
        allowedDomains: ["cc.tailnet.example"],
        strictAllowlist: true,
      });
    });

    it("drops the permission bypass a write-capable lane runs under", async () => {
      await runner.run(makeRequest({ fsWritePolicy: POLICY }));

      expect(deliveredOptions()?.permissionMode).toBe("dontAsk");
      expect(deliveredOptions()?.allowDangerouslySkipPermissions).not.toBe(
        true,
      );
    });

    it("loads no filesystem settings, so a candidate-committed settings file cannot widen its reviewer", async () => {
      await runner.run(makeRequest({ fsWritePolicy: POLICY }));

      expect(deliveredOptions()?.settingSources).toEqual([]);
    });

    it("scopes the file-mutation tools to the allowlist and denies them in the worktree", async () => {
      await runner.run(makeRequest({ fsWritePolicy: POLICY }));

      const permissions = deliveredOptions()?.settings as
        | { permissions?: { allow?: string[]; deny?: string[] } }
        | undefined;
      expect(permissions?.permissions?.allow).toEqual(
        expect.arrayContaining([
          `Write(//${SCRATCH}/**)`,
          `Edit(//${SCRATCH}/**)`,
          `NotebookEdit(//${SCRATCH}/**)`,
        ]),
      );
      expect(permissions?.permissions?.deny).toEqual(
        expect.arrayContaining([
          `Write(//${WORKTREE}/**)`,
          `Edit(//${WORKTREE}/**)`,
          `NotebookEdit(//${WORKTREE}/**)`,
        ]),
      );
    });

    it("keeps reading the candidate from its own directory", async () => {
      await runner.run(makeRequest({ fsWritePolicy: POLICY }));

      // Only writes are confined — a reviewer still works from the tree under
      // review, so relative paths in its instructions keep resolving.
      expect(deliveredOptions()?.cwd).toBe(WORKTREE);
    });

    it("uses the policy working root when the candidate cwd is not wholly denied", async () => {
      const implementerScratch =
        "/private/tmp/cc-implementer-contexts/exec/ctx";
      const ownedPath = `${WORKTREE}/src/owned`;

      await runner.run(
        makeRequest({
          resumeRef: { backend: "claude", ref: "session-confined" },
          fsWritePolicy: {
            mode: "allowlist",
            allowWrite: [
              implementerScratch,
              ownedPath,
              `${implementerScratch}/tmp`,
            ],
            denyWrite: [`${WORKTREE}/.git`],
          },
        }),
      );

      // A partial-worktree implementer cannot run from the worktree: Claude's
      // sandbox makes cwd writable by default, bypassing the path allowlist.
      // The same cwd also keeps its persisted session discoverable on a
      // follow-up structured-output turn.
      expect(deliveredOptions()?.cwd).toBe(implementerScratch);
      expect(deliveredOptions()?.resume).toBe("session-confined");
      expect(deliveredOptions()?.persistSession).toBe(true);
      expect(deliveredOptions()?.env).toMatchObject({
        CLAUDE_CODE_TMPDIR: `${implementerScratch}/tmp`,
        TMPDIR: `${implementerScratch}/tmp`,
      });
    });

    it("uses one server-owned URL snapshot for the sandbox and scoped child environment", async () => {
      const getServerUrl = vi
        .fn<() => string | null>()
        .mockReturnValueOnce(SERVER_URL)
        .mockReturnValue("https://changed.example:9443");
      runner = new ClaudeTaskRunner({
        runQuery: (args) => query(args),
        getServerUrl,
        getApiToken: () => "instance-token",
        getConfigDir: () => "/cc/config",
      });

      await runner.run(
        makeRequest({
          fsWritePolicy: POLICY,
          ccSessionScope: {
            project: "command-center",
            session: "csm/collab-session",
            conversationId: "conv-originating",
          },
        }),
      );

      expect(getServerUrl).toHaveBeenCalledTimes(1);
      expect(deliveredOptions()?.env?.["CC_SERVER_URL"]).toBe(SERVER_URL);
      expect(deliveredOptions()?.sandbox?.network).toEqual({
        allowedDomains: ["cc.tailnet.example"],
        strictAllowlist: true,
      });
    });

    it("leaves an unrestricted run exactly as it was", async () => {
      await runner.run(makeRequest());

      expect(deliveredOptions()?.sandbox).toBeUndefined();
      expect(deliveredOptions()?.permissionMode).toBe("bypassPermissions");
      expect(deliveredOptions()?.settingSources).toEqual([
        "user",
        "project",
        "local",
      ]);
    });

    describe("fail-closed establishment", () => {
      it("refuses to start a query when the trusted server URL is unavailable", async () => {
        const runnerWithoutServer = new ClaudeTaskRunner({
          runQuery: (args) => query(args),
          getServerUrl: () => null,
          getApiToken: () => null,
          getConfigDir: () => "/cc/config",
        });

        const result = await runnerWithoutServer.run(
          makeRequest({ fsWritePolicy: POLICY }),
        );

        expect(result.error).toMatch(/write envelope/i);
        expect(result.failure).not.toBeNull();
        expect(mockQuery).not.toHaveBeenCalled();
      });

      it("refuses to start a query when the policy cannot be translated", async () => {
        const result = await runner.run(
          makeRequest({ fsWritePolicy: { ...POLICY, allowWrite: [] } }),
        );

        expect(result.error).toMatch(/write envelope/i);
        expect(result.failure).not.toBeNull();
        expect(mockQuery).not.toHaveBeenCalled();
      });

      it("surfaces a sandbox that could not start as a failed run, not a quiet one", async () => {
        mockQuery.mockReturnValue(
          makeStream([
            {
              type: "result",
              subtype: "error_during_execution",
              session_id: "session-sandbox",
              total_cost_usd: 0,
              num_turns: 0,
              duration_ms: 5,
              usage: {
                input_tokens: 0,
                cache_read_input_tokens: 0,
                output_tokens: 0,
                cache_creation_input_tokens: 0,
              },
              errors: ["sandbox dependencies are unavailable"],
            },
          ]) as ReturnType<typeof query>,
        );

        const result = await runner.run(makeRequest({ fsWritePolicy: POLICY }));

        expect(result.error).not.toBeNull();
        expect(result.failure).not.toBeNull();
        expect(result.text).toBeNull();
      });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});
