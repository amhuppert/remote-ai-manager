import { beforeEach, describe, expect, it, vi } from "vitest";

const startThreadMock = vi.fn();
const resumeThreadMock = vi.fn();
const runMock = vi.fn();
const runStreamedMock = vi.fn();

vi.mock("@openai/codex-sdk", () => ({
  Codex: vi.fn().mockImplementation(() => ({
    startThread: startThreadMock,
    resumeThread: resumeThreadMock,
  })),
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

vi.mock("@/lib/shared/child-env", () => ({
  buildChildEnv: () => ({}),
}));

import { Codex } from "@openai/codex-sdk";
import { CodexTaskRunner, type CodexTaskRunnerDeps } from "./task-runner";
import type { AgentTaskRequest } from "../task";
import { getDefaultCodexModel } from "@/lib/agent-backends/schemas";

function makeRequest(overrides?: Partial<AgentTaskRequest>): AgentTaskRequest {
  return {
    workingDirectory: "/test/workspace",
    prompt: "Do the thing",
    timeoutMs: 30_000,
    autonomous: true,
    ...overrides,
  };
}

describe("CodexTaskRunner", () => {
  let runner: CodexTaskRunner;
  let listNativeCodexMcpServers: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logState.entries = [];
    listNativeCodexMcpServers = vi.fn().mockResolvedValue([]);
    runner = new CodexTaskRunner({
      createCodex: (options) =>
        new Codex(options) as unknown as ReturnType<
          CodexTaskRunnerDeps["createCodex"]
        >,
      buildChildEnv: () => ({}) as NodeJS.ProcessEnv,
      listNativeCodexMcpServers,
      getCodexPricingOverrides: async () => null,
      getServerUrl: () => null,
      getApiToken: () => null,
      getConfigDir: () => "/test/config",
      ensureManagedSkillsBridge: async () =>
        ({ status: "skipped", reason: "no_bundle" }) as const,
    });

    // Model the real SDK: a fresh thread has `id: null` until the
    // `thread.started` event arrives during its first run.
    startThreadMock.mockImplementation(() => {
      const thread = {
        id: null as string | null,
        run: (input: unknown, options?: unknown) => {
          thread.id = "thread-abc";
          return runMock(input, options);
        },
      };
      return thread;
    });
    resumeThreadMock.mockReturnValue({
      id: "thread-resumed",
      run: runMock,
    });
    runMock.mockResolvedValue({
      finalResponse: "done",
      usage: {
        input_tokens: 12,
        cached_input_tokens: 3,
        output_tokens: 7,
      },
    });
  });

  it("passes modelReasoningEffort to thread options", async () => {
    await runner.run(makeRequest({ reasoningEffort: "high" }));

    expect(startThreadMock).toHaveBeenCalledWith(
      expect.objectContaining({ modelReasoningEffort: "high" }),
    );
  });

  it("neutralizes ambient CC_* env before spawning the codex subprocess", async () => {
    const createCodex = vi.fn(
      (options) =>
        new Codex(options) as unknown as ReturnType<
          CodexTaskRunnerDeps["createCodex"]
        >,
    );
    const contaminatedRunner = new CodexTaskRunner({
      createCodex,
      buildChildEnv: () =>
        ({
          NODE_ENV: "development",
          CC_SERVER_URL: "http://ambient-prod:3000",
          CC_API_TOKEN: "ambient-token",
          PATH: "/usr/bin",
        }) as NodeJS.ProcessEnv,
      listNativeCodexMcpServers,
      getCodexPricingOverrides: async () => null,
      getServerUrl: () => null,
      getApiToken: () => null,
      getConfigDir: () => "/test/config",
      ensureManagedSkillsBridge: async () =>
        ({ status: "skipped", reason: "no_bundle" }) as const,
    });

    await contaminatedRunner.run(makeRequest());

    const options = createCodex.mock.calls[0]?.[0] as
      | { env?: Record<string, string> }
      | undefined;
    expect(options?.env).toMatchObject({
      CC_SERVER_URL: "",
      CC_API_TOKEN: "",
      PATH: "/usr/bin",
      CLAUDECODE: "",
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

    const AMBIENT_ENV = {
      NODE_ENV: "development",
      PATH: "/usr/bin",
      CC_SERVER_URL: "http://ambient-prod:3000",
      CC_API_TOKEN: "ambient-token",
      CC_CONVERSATION_ID: "ambient-conversation",
      CC_WORKFLOW_EXECUTION_ID: "ambient-exec",
      CC_WORKFLOW_CONTEXT_ID: "ambient-ctx",
    };

    function makeScopedRunner(): {
      runner: CodexTaskRunner;
      readEnv: () => Record<string, string> | undefined;
    } {
      const createCodex = vi.fn(
        (options) =>
          new Codex(options) as unknown as ReturnType<
            CodexTaskRunnerDeps["createCodex"]
          >,
      );
      return {
        runner: new CodexTaskRunner({
          createCodex,
          buildChildEnv: () => ({ ...AMBIENT_ENV }) as NodeJS.ProcessEnv,
          listNativeCodexMcpServers,
          getCodexPricingOverrides: async () => null,
          getServerUrl: () => RESOLVED_SERVER_URL,
          getApiToken: () => RESOLVED_TOKEN,
          getConfigDir: () => "/cc/config",
          ensureManagedSkillsBridge: async () =>
            ({ status: "skipped", reason: "no_bundle" }) as const,
        }),
        readEnv: () =>
          (
            createCodex.mock.calls[0]?.[0] as
              | { env?: Record<string, string> }
              | undefined
          )?.env,
      };
    }

    it("gives the child the originating session identity with server-side credentials", async () => {
      const { runner: scopedRunner, readEnv } = makeScopedRunner();

      await scopedRunner.run(makeRequest({ ccSessionScope: { ...SCOPE } }));

      expect(readEnv()).toMatchObject({
        CC_SERVER_URL: RESOLVED_SERVER_URL,
        CC_API_TOKEN: RESOLVED_TOKEN,
        CC_PROJECT: SCOPE.project,
        CC_SESSION: SCOPE.session,
        CC_CONVERSATION_ID: SCOPE.conversationId,
        CLAUDECODE: "",
      });
    });

    it("neutralizes ambient CC_* first, so no outer workflow identity survives", async () => {
      const { runner: scopedRunner, readEnv } = makeScopedRunner();

      await scopedRunner.run(makeRequest({ ccSessionScope: { ...SCOPE } }));

      // A lane's own workflow ids must never leak into a collaboration task
      // subprocess: no workflow ids are supplied, and the ambient ones are
      // blanked rather than inherited.
      expect(readEnv()).toMatchObject({
        CC_WORKFLOW_EXECUTION_ID: "",
        CC_WORKFLOW_CONTEXT_ID: "",
      });
    });

    it("makes cctl resolvable by prepending the config bin directory to PATH", async () => {
      const { runner: scopedRunner, readEnv } = makeScopedRunner();

      await scopedRunner.run(makeRequest({ ccSessionScope: { ...SCOPE } }));

      expect(readEnv()?.PATH).toBe("/cc/config/bin:/usr/bin");
    });

    it("keeps the server URL and token out of logs and the task result", async () => {
      const { runner: scopedRunner } = makeScopedRunner();

      const result = await scopedRunner.run(
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
      const { runner: scopedRunner, readEnv } = makeScopedRunner();

      await scopedRunner.run(makeRequest());

      // Exact object equality, not a subset match: a generic task run gains no
      // identity, no credentials, no PATH prepend, and no BASH ceiling.
      expect(readEnv()).toEqual({
        NODE_ENV: "development",
        PATH: "/usr/bin",
        CC_SERVER_URL: "",
        CC_API_TOKEN: "",
        CC_CONVERSATION_ID: "",
        CC_WORKFLOW_EXECUTION_ID: "",
        CC_WORKFLOW_CONTEXT_ID: "",
        CLAUDECODE: "",
      });
    });

    it("fails the run without dispatching when the scope is malformed", async () => {
      const { runner: scopedRunner, readEnv } = makeScopedRunner();

      const result = await scopedRunner.run(
        makeRequest({ ccSessionScope: { ...SCOPE, conversationId: "" } }),
      );

      expect(result.error).toContain("ccSessionScope");
      expect(result.text).toBeNull();
      expect(readEnv()).toBeUndefined();
      expect(startThreadMock).not.toHaveBeenCalled();
    });
  });

  it("defaults to the global default codex model when no modelId is provided", async () => {
    await runner.run(makeRequest());

    expect(startThreadMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: getDefaultCodexModel() }),
    );
  });

  it("passes an explicit modelId to thread options", async () => {
    await runner.run(makeRequest({ modelId: "gpt-5.5" }));

    expect(startThreadMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5.5" }),
    );
  });

  it("forwards persistent image paths as Codex local_image input", async () => {
    await runner.run(
      makeRequest({ imagePaths: ["/images/first.png", "/images/second.jpg"] }),
    );

    expect(runMock).toHaveBeenCalledWith(
      [
        { type: "text", text: "Do the thing" },
        { type: "local_image", path: "/images/first.png" },
        { type: "local_image", path: "/images/second.jpg" },
      ],
      expect.any(Object),
    );
  });

  it("fails fast when reasoning effort is invalid", async () => {
    const result = await runner.run(makeRequest({ reasoningEffort: "turbo" }));

    expect(startThreadMock).not.toHaveBeenCalled();
    expect(result.error).toContain('Invalid Codex reasoning effort: "turbo"');
  });

  it("passes the GPT-5.6 max/ultra effort through to the SDK thread options", async () => {
    for (const effort of ["max", "ultra"]) {
      startThreadMock.mockClear();
      await runner.run(
        makeRequest({ modelId: "gpt-5.6-sol", reasoningEffort: effort }),
      );
      expect(startThreadMock).toHaveBeenCalledWith(
        expect.objectContaining({ modelReasoningEffort: effort }),
      );
    }
  });

  it("passes populated mcp_servers to Codex when portableMcp translates to a non-empty map", async () => {
    await runner.run(
      makeRequest({
        tooling: {
          portableMcp: {
            servers: [
              {
                id: "test-server",
                transport: "stdio",
                command: "node",
                args: ["server.js"],
              },
            ],
          },
        },
      }),
    );

    const codexCalls = vi.mocked(Codex).mock.calls;
    expect(codexCalls).toHaveLength(1);
    const passedOptions = codexCalls[0]![0]!;
    expect(passedOptions).toHaveProperty("config");
    expect(passedOptions.config).toEqual({
      mcp_servers: {
        "test-server": {
          command: "node",
          args: ["server.js"],
        },
      },
      service_tier: "default",
      features: { fast_mode: false },
    });
  });

  it("passes enabled=false entries for native Codex MCP servers not managed by Command Center", async () => {
    listNativeCodexMcpServers.mockResolvedValue([
      {
        name: "playwright",
        configEntry: { command: "npx", args: ["-y", "@playwright/mcp@latest"] },
      },
      {
        name: "test-server",
        configEntry: { command: "node", args: ["server.js"] },
      },
      {
        name: "next-devtools",
        configEntry: {
          command: "npx",
          args: ["-y", "next-devtools-mcp@latest"],
        },
      },
    ]);

    await runner.run(
      makeRequest({
        tooling: {
          portableMcp: {
            servers: [
              {
                id: "test-server",
                transport: "stdio",
                command: "node",
                args: ["server.js"],
              },
            ],
          },
        },
      }),
    );

    expect(listNativeCodexMcpServers).toHaveBeenCalledWith({
      cwd: "/test/workspace",
      env: { CLAUDECODE: "" },
    });
    const codexCalls = vi.mocked(Codex).mock.calls;
    const passedOptions = codexCalls[0]![0]!;
    expect(passedOptions.config).toEqual({
      mcp_servers: {
        "test-server": {
          command: "node",
          args: ["server.js"],
        },
        playwright: {
          command: "npx",
          args: ["-y", "@playwright/mcp@latest"],
          enabled: false,
        },
        "next-devtools": {
          command: "npx",
          args: ["-y", "next-devtools-mcp@latest"],
          enabled: false,
        },
      },
      service_tier: "default",
      features: { fast_mode: false },
    });
  });

  it("passes empty mcp_servers to Codex when no managed or native servers are present", async () => {
    await runner.run(
      makeRequest({
        tooling: {
          portableMcp: { servers: [] },
        },
      }),
    );

    const codexCalls = vi.mocked(Codex).mock.calls;
    expect(codexCalls).toHaveLength(1);
    const passedOptions = codexCalls[0]![0]!;
    expect(passedOptions).toHaveProperty("config");
    expect(passedOptions.config).toEqual({
      mcp_servers: {},
      service_tier: "default",
      features: { fast_mode: false },
    });
  });

  it("uses standard mode when a task omits an explicit choice", async () => {
    await runner.run(makeRequest());

    const passedOptions = vi.mocked(Codex).mock.calls[0]![0]!;
    expect(passedOptions.config).toEqual({
      service_tier: "default",
      features: { fast_mode: false },
    });
  });

  it("honors an explicit standard-mode task choice", async () => {
    await runner.run(makeRequest({ codexFastMode: false }));

    const passedOptions = vi.mocked(Codex).mock.calls[0]![0]!;
    expect(passedOptions.config).toEqual({
      service_tier: "default",
      features: { fast_mode: false },
    });
  });

  it("honors an explicit fast-mode task choice", async () => {
    await runner.run(makeRequest({ codexFastMode: true }));

    const passedOptions = vi.mocked(Codex).mock.calls[0]![0]!;
    expect(passedOptions.config).toEqual({
      service_tier: "fast",
      features: { fast_mode: true },
    });
  });

  it("maps isolated one-shot execution to a fresh constrained Codex thread", async () => {
    const items = [
      { type: "command_execution", command: "pwd", exit_code: 0 },
      { type: "agent_message", text: "done" },
    ];
    runMock.mockResolvedValue({
      finalResponse: "done",
      usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      items,
    });
    listNativeCodexMcpServers.mockResolvedValue([
      {
        name: "native-tools",
        configEntry: { command: "native-server" },
      },
    ]);

    const result = await runner.run(
      makeRequest({
        executionProfile: "isolated-one-shot",
        resumeRef: { backend: "codex", ref: "thread-old" },
        sandboxMode: "danger-full-access",
        networkAccessEnabled: true,
        webSearchMode: "live",
        additionalDirectories: ["/must-not-be-added"],
        tooling: {
          portableMcp: {
            servers: [
              {
                id: "managed-tools",
                transport: "stdio",
                command: "managed-server",
              },
            ],
          },
        },
      }),
    );

    const codexOptions = vi.mocked(Codex).mock.calls[0]?.[0];
    expect(codexOptions?.config).toEqual({
      apps: { _default: { enabled: false } },
      features: {
        apps: false,
        auth_elicitation: false,
        browser_use: false,
        browser_use_external: false,
        browser_use_full_cdp_access: false,
        code_mode: false,
        code_mode_host: false,
        code_mode_only: false,
        computer_use: false,
        deferred_executor: false,
        enable_fanout: false,
        enable_mcp_apps: false,
        fast_mode: false,
        goals: false,
        hooks: false,
        image_generation: false,
        in_app_browser: false,
        js_repl: false,
        js_repl_tools_only: false,
        memories: false,
        memory_tool: false,
        multi_agent: false,
        multi_agent_mode: false,
        multi_agent_v2: false,
        plugin_sharing: false,
        plugins: false,
        remote_plugin: false,
        request_permissions: false,
        request_permissions_tool: false,
        search_tool: false,
        shell_tool: false,
        skill_mcp_dependency_install: false,
        standalone_web_search: false,
        tool_call_mcp_elicitation: false,
        tool_search: false,
        tool_suggest: false,
        unified_exec: false,
        web_search: false,
        web_search_cached: false,
        web_search_request: false,
        workspace_dependencies: false,
      },
      developer_instructions: "",
      history: { persistence: "none" },
      include_apps_instructions: false,
      include_collaboration_mode_instructions: false,
      include_environment_context: false,
      include_permissions_instructions: false,
      memories: {
        dedicated_tools: false,
        generate_memories: false,
        use_memories: false,
      },
      mcp_servers: {
        "native-tools": {
          command: "native-server",
          enabled: false,
        },
      },
      project_doc_fallback_filenames: [],
      project_doc_max_bytes: 0,
      service_tier: "default",
      skills: {
        bundled: { enabled: false },
        include_instructions: false,
      },
    });
    expect(codexOptions?.config).not.toHaveProperty("instructions");
    expect(startThreadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxMode: "read-only",
        approvalPolicy: "never",
        networkAccessEnabled: false,
        webSearchMode: "disabled",
      }),
    );
    expect(startThreadMock.mock.calls[0]?.[0]).not.toHaveProperty(
      "additionalDirectories",
    );
    expect(resumeThreadMock).not.toHaveBeenCalled();
    expect(listNativeCodexMcpServers).toHaveBeenCalledTimes(1);
    expect(result.backendRef).toBeNull();
    expect(result.text).toBe("done");
    expect(result.error).toBeNull();
    expect(result.failure).toBeNull();
    expect(result.transcript).toEqual([
      { seq: 0, backend: "codex", type: "command_execution", raw: items[0] },
      { seq: 1, backend: "codex", type: "agent_message", raw: items[1] },
    ]);
  });

  it("captures turn.items as a lossless transcript", async () => {
    const items = [
      { type: "reasoning", text: "weigh AC vs prototype" },
      { type: "command_execution", command: "npm run verify", exit_code: 0 },
      { type: "agent_message", text: "GO" },
    ];
    runMock.mockResolvedValue({
      finalResponse: "GO",
      usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      items,
    });

    const result = await runner.run(makeRequest());

    expect(result.transcript).toEqual([
      { seq: 0, backend: "codex", type: "reasoning", raw: items[0] },
      { seq: 1, backend: "codex", type: "command_execution", raw: items[1] },
      { seq: 2, backend: "codex", type: "agent_message", raw: items[2] },
    ]);
  });

  it("captures streamed items before a failed Codex turn", async () => {
    const items = [
      { type: "reasoning", text: "checking the repo" },
      { type: "command_execution", command: "npm run verify", exit_code: 1 },
    ];
    async function* events() {
      yield { type: "item.completed", item: items[0] };
      yield { type: "item.completed", item: items[1] };
      yield {
        type: "turn.failed",
        error: { message: "command failed" },
      };
    }
    runStreamedMock.mockResolvedValue({ events: events() });
    startThreadMock.mockReturnValue({
      id: "thread-abc",
      run: runMock,
      runStreamed: runStreamedMock,
    });

    const result = await runner.run(makeRequest());

    expect(runStreamedMock).toHaveBeenCalled();
    expect(runMock).not.toHaveBeenCalled();
    expect(result.error).toBe("command failed");
    expect(result.failure).toEqual({
      kind: "backend_error",
      message: "command failed",
      retryable: false,
    });
    expect(result.backendRef).toEqual({
      backend: "codex",
      ref: "thread-abc",
    });
    expect(result.continuationDisposition).toBe("retain");
    expect(result.transcript).toEqual([
      { seq: 0, backend: "codex", type: "reasoning", raw: items[0] },
      { seq: 1, backend: "codex", type: "command_execution", raw: items[1] },
    ]);
  });

  it("returns the thread id assigned during a fresh run as the backendRef", async () => {
    // The real SDK creates fresh threads with `id: null` and assigns the id
    // only when the `thread.started` event arrives mid-run, so the id must be
    // read after the turn completes.
    const thread = {
      id: null as string | null,
      run: (input: unknown, options?: unknown) => {
        thread.id = "thread-late";
        return runMock(input, options);
      },
    };
    startThreadMock.mockReturnValue(thread);

    const result = await runner.run(makeRequest());

    expect(result.backendRef).toEqual({ backend: "codex", ref: "thread-late" });
  });

  it("clears a stale resumed thread while preserving the typed classification", async () => {
    resumeThreadMock.mockReturnValue({
      id: "thread-gone",
      run: vi
        .fn()
        .mockRejectedValue(
          new Error(
            'thread/resume: no rollout found for thread id "thread-gone"',
          ),
        ),
    });

    const result = await runner.run(
      makeRequest({
        resumeRef: { backend: "codex", ref: "thread-gone" },
      }),
    );

    expect(result.failure?.kind).toBe("stale_resume_ref");
    expect(result.continuationDisposition).toBe("clear");
    expect(result.backendRef).toBeNull();
  });

  it("retains a resumed thread after a transient process failure", async () => {
    resumeThreadMock.mockReturnValue({
      id: "thread-viable",
      run: vi.fn().mockRejectedValue(new Error("local process crashed")),
    });

    const result = await runner.run(
      makeRequest({
        resumeRef: { backend: "codex", ref: "thread-viable" },
      }),
    );

    expect(result.failure?.kind).toBe("backend_error");
    expect(result.continuationDisposition).toBe("retain");
    expect(result.backendRef).toEqual({
      backend: "codex",
      ref: "thread-viable",
    });
  });

  it("omits transcript when the turn returned no items", async () => {
    // Default runMock has no `items`.
    const result = await runner.run(makeRequest());
    expect(result.transcript).toBeUndefined();
  });

  it("passes the outputSchema to Codex unmodified — identity projection, no keyword stripping (T3.3)", async () => {
    const schema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 2 },
        },
        count: { type: "integer", minimum: 0 },
      },
      required: ["items", "count"],
      additionalProperties: false,
    };

    await runner.run(makeRequest({ outputSchema: schema }));

    const runOptions = runMock.mock.calls[0]?.[1] as {
      outputSchema?: unknown;
    };
    expect(runOptions.outputSchema).toEqual(schema);
  });

  it("aborts the running thread when an external signal fires", async () => {
    const external = new AbortController();
    runMock.mockImplementation(
      (_prompt: string, opts: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );

    const promise = runner.run(
      makeRequest({ timeoutMs: 0, signal: external.signal }),
    );
    external.abort();
    const result = await promise;

    expect(result.timedOut).toBe(true);
  });

  it("aborts immediately when handed an already-aborted external signal", async () => {
    const external = new AbortController();
    external.abort();
    runMock.mockImplementation(
      (_prompt: string, opts: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          if (opts.signal?.aborted) {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
            return;
          }
          resolve({ finalResponse: "done" });
        }),
    );

    const result = await runner.run(
      makeRequest({ timeoutMs: 0, signal: external.signal }),
    );

    expect(result.timedOut).toBe(true);
  });

  it("does not abort immediately when timeoutMs is 0 (no timeout)", async () => {
    // timeoutMs=0 means "no timeout" — the task should run to completion.
    // Use a real async delay so setTimeout(0) has a chance to fire first
    // (simulating the real-world case where thread.run() does async work).
    runMock.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                finalResponse: "done",
                usage: {
                  input_tokens: 1,
                  cached_input_tokens: 0,
                  output_tokens: 1,
                },
              }),
            50,
          ),
        ),
    );

    const result = await runner.run(makeRequest({ timeoutMs: 0 }));

    expect(result.timedOut).toBe(false);
    expect(result.text).toBe("done");
    expect(result.error).toBeNull();
  });

  describe("stall watchdog", () => {
    it("aborts a run with no backend activity after stallTimeoutMs and reports the stall", async () => {
      vi.useFakeTimers();
      try {
        runMock.mockImplementation(
          (_prompt: string, opts: { signal?: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              opts.signal?.addEventListener("abort", () => {
                const err = new Error("aborted");
                err.name = "AbortError";
                reject(err);
              });
            }),
        );

        const promise = runner.run(
          makeRequest({ timeoutMs: 0, stallTimeoutMs: 1_000 }),
        );
        await vi.advanceTimersByTimeAsync(1_000);
        const result = await promise;

        expect(result.timedOut).toBe(true);
        expect(result.error).toBe(
          "Task stalled: no backend activity for 1000ms",
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("applies the codex default stall bound when the request sets none", async () => {
      vi.useFakeTimers();
      try {
        runMock.mockImplementation(
          (_prompt: string, opts: { signal?: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              opts.signal?.addEventListener("abort", () => {
                const err = new Error("aborted");
                err.name = "AbortError";
                reject(err);
              });
            }),
        );

        const promise = runner.run(makeRequest({ timeoutMs: 0 }));
        await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
        const result = await promise;

        expect(result.timedOut).toBe(true);
        expect(result.error).toBe(
          "Task stalled: no backend activity for 1200000ms",
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not trip while streamed events keep arriving", async () => {
      vi.useFakeTimers();
      try {
        startThreadMock.mockImplementation(() => {
          const thread = {
            id: null as string | null,
            runStreamed: async () => {
              thread.id = "thread-stream";
              return {
                events: (async function* () {
                  for (let i = 0; i < 5; i++) {
                    await new Promise((r) => setTimeout(r, 800));
                    yield {
                      type: "item.completed",
                      item: {
                        id: `msg-${i}`,
                        type: "agent_message",
                        text: `part ${i}`,
                      },
                    };
                  }
                  yield {
                    type: "turn.completed",
                    usage: {
                      input_tokens: 1,
                      cached_input_tokens: 0,
                      output_tokens: 1,
                    },
                  };
                })(),
              };
            },
          };
          return thread;
        });

        const promise = runner.run(
          makeRequest({ timeoutMs: 0, stallTimeoutMs: 1_000 }),
        );
        await vi.advanceTimersByTimeAsync(4_100);
        const result = await promise;

        expect(result.timedOut).toBe(false);
        expect(result.error).toBeNull();
        expect(result.text).toBe("part 4");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("cost estimation", () => {
    // beforeEach runMock usage: 12 input (3 cached), 7 output.

    it("estimates usage.costUsd at the requested model's default rates", async () => {
      const result = await runner.run(makeRequest({ modelId: "gpt-5.5" }));

      // gpt-5.5: $5/$0.50/$30 per 1M
      expect(result.usage?.costUsd).toBeCloseTo(
        (9 * 5 + 3 * 0.5 + 7 * 30) / 1_000_000,
        10,
      );
    });

    it("prices at the default codex model when no modelId is provided", async () => {
      const result = await runner.run(makeRequest());

      // gpt-5.4: $2.50/$0.25/$15 per 1M
      expect(result.usage?.costUsd).toBeCloseTo(
        (9 * 2.5 + 3 * 0.25 + 7 * 15) / 1_000_000,
        10,
      );
    });

    it("keeps token usage but null costUsd for a model with no known rates", async () => {
      const result = await runner.run(makeRequest({ modelId: "o3-pro" }));

      expect(result.usage).toMatchObject({
        inputTokens: 12,
        cachedInputTokens: 3,
        outputTokens: 7,
        costUsd: null,
      });
    });

    it("prices with config pricing overrides from the injected dep", async () => {
      const overriddenRunner = new CodexTaskRunner({
        createCodex: (options) =>
          new Codex(options) as unknown as ReturnType<
            CodexTaskRunnerDeps["createCodex"]
          >,
        buildChildEnv: () => ({}) as NodeJS.ProcessEnv,
        listNativeCodexMcpServers,
        getCodexPricingOverrides: async () => ({
          "gpt-5.5": {
            inputPerMillion: 10,
            cachedInputPerMillion: 1,
            outputPerMillion: 100,
          },
        }),
        getServerUrl: () => null,
        getApiToken: () => null,
        getConfigDir: () => "/test/config",
        ensureManagedSkillsBridge: async () =>
          ({ status: "skipped", reason: "no_bundle" }) as const,
      });

      const result = await overriddenRunner.run(
        makeRequest({ modelId: "gpt-5.5" }),
      );

      expect(result.usage?.costUsd).toBeCloseTo(
        (9 * 10 + 3 * 1 + 7 * 100) / 1_000_000,
        10,
      );
    });
  });
});
