import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ThreadEvent,
  ThreadStartedEvent,
  TurnCompletedEvent,
  TurnFailedEvent,
  ItemStartedEvent,
  ItemCompletedEvent,
  Usage,
  Input,
  TurnOptions,
  AgentMessageItem,
  CommandExecutionItem,
  McpToolCallItem,
  FileChangeItem,
  ReasoningItem,
  TodoListItem,
  WebSearchItem,
} from "@openai/codex-sdk";

// Infrastructure mocks (acceptable per project rules)
vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  CodexConversationRuntime,
  codexConversationBackendFactory,
  type CodexConversationRuntimeDeps,
  type CodexThreadLike,
} from "./conversation-runtime";
import type {
  ConversationBackendCreateInput,
  ConversationBackendTurnInput,
} from "../conversation";
import type { PortableMcpConfig } from "../portable-mcp";
import {
  projectConversationTarget,
  sessionConversationTarget,
} from "@/lib/conversations/conversation-target";
import { CONVERSATION_CAPABILITY_ENV_VAR } from "@/lib/agent-gateway/conversation-capability";
import { getDefaultCodexModel } from "@/lib/agent-backends/schemas";
import { turnContinuationSchema } from "../errors";
import {
  buildAgentProfileSnapshot,
  PROFILE_BLOCK_BEGIN,
  PROFILE_BLOCK_END,
  PROFILE_LAYER_HEADING,
} from "@/lib/agent-profiles/composer";
import { computeContentHash } from "@/lib/agent-profiles/hashing";
import { findBuiltinAgentProfile } from "@/lib/agent-profiles/builtins";
import type {
  AgentProfileSnapshot,
  ResolvedAgentProfile,
} from "@/lib/agent-profiles/schemas";

// ============================================================
// Helpers
// ============================================================

function makeCreateInput(
  overrides?: Partial<ConversationBackendCreateInput> & {
    sessionName?: string;
  },
): ConversationBackendCreateInput {
  const { sessionName, ...rest } = overrides ?? {};
  const conversationId = rest.conversationId ?? "conv-123";
  const projectName = rest.projectName ?? "test-project";
  return {
    conversationId,
    projectPath: "/test/project",
    projectName,
    // Scope is DECLARED create-input; session is the default for these tests.
    conversationTarget: sessionConversationTarget(
      projectName,
      sessionName ?? "test-session",
      conversationId,
    ),
    worktreePath: "/test/worktree",
    persistedRef: null,
    sessionInstructions: ["Be helpful"],
    tooling: {},
    ...rest,
  };
}

function makeTurnInput(
  overrides?: Partial<ConversationBackendTurnInput>,
): ConversationBackendTurnInput {
  return {
    promptText: "Do the thing",
    imageRefs: [],
    sessionInstructions: [],
    autonomous: true,
    signal: new AbortController().signal,
    onEvent: vi.fn(),
    ...overrides,
  };
}

function makeThread(
  events: ThreadEvent[],
  opts?: { runStreamedThrows?: Error },
): CodexThreadLike {
  return {
    id: null,
    async runStreamed(
      _input: Input,
      _turnOptions?: TurnOptions,
    ): Promise<{ events: AsyncGenerator<ThreadEvent> }> {
      if (opts?.runStreamedThrows) {
        throw opts.runStreamedThrows;
      }
      return {
        events: (async function* () {
          for (const event of events) {
            yield event;
          }
        })(),
      };
    },
  };
}

function makeAbortingThread(eventsBeforeAbort: ThreadEvent[]): CodexThreadLike {
  return {
    id: null,
    async runStreamed(): Promise<{ events: AsyncGenerator<ThreadEvent> }> {
      return {
        events: (async function* () {
          for (const event of eventsBeforeAbort) {
            yield event;
          }
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          throw err;
        })(),
      };
    },
  };
}

/** Capture the Input and TurnOptions passed to runStreamed */
function makeCapturingThread(events: ThreadEvent[]): CodexThreadLike & {
  capturedInput: Input | null;
  capturedTurnOptions: TurnOptions | undefined;
} {
  const thread: CodexThreadLike & {
    capturedInput: Input | null;
    capturedTurnOptions: TurnOptions | undefined;
  } = {
    id: null,
    capturedInput: null,
    capturedTurnOptions: undefined,
    async runStreamed(
      input: Input,
      turnOptions?: TurnOptions,
    ): Promise<{ events: AsyncGenerator<ThreadEvent> }> {
      thread.capturedInput = input;
      thread.capturedTurnOptions = turnOptions;
      return {
        events: (async function* () {
          for (const event of events) {
            yield event;
          }
        })(),
      };
    },
  };
  return thread;
}

function threadStarted(threadId = "thread-123"): ThreadStartedEvent {
  return { type: "thread.started", thread_id: threadId };
}

function turnCompleted(
  usage: Usage = {
    input_tokens: 100,
    cached_input_tokens: 10,
    output_tokens: 50,
    reasoning_output_tokens: 0,
  },
): TurnCompletedEvent {
  return { type: "turn.completed", usage };
}

function turnFailed(message = "Something went wrong"): TurnFailedEvent {
  return { type: "turn.failed", error: { message } };
}

function agentMessageCompleted(text: string, id = "msg-1"): ItemCompletedEvent {
  const item: AgentMessageItem = { id, type: "agent_message", text };
  return { type: "item.completed", item };
}

function commandStarted(command: string, id = "cmd-1"): ItemStartedEvent {
  const item: CommandExecutionItem = {
    id,
    type: "command_execution",
    command,
    aggregated_output: "",
    status: "in_progress",
  };
  return { type: "item.started", item };
}

function commandCompleted(
  command: string,
  output: string,
  id = "cmd-1",
  opts: { exitCode?: number; failed?: boolean } = {},
): ItemCompletedEvent {
  const item: CommandExecutionItem = {
    id,
    type: "command_execution",
    command,
    aggregated_output: output,
    ...(opts.exitCode !== undefined ? { exit_code: opts.exitCode } : {}),
    status: opts.failed ? "failed" : "completed",
  };
  return { type: "item.completed", item };
}

function mcpToolStarted(
  tool: string,
  server: string,
  args: unknown,
  id = "mcp-1",
): ItemStartedEvent {
  const item: McpToolCallItem = {
    id,
    type: "mcp_tool_call",
    server,
    tool,
    arguments: args,
    status: "in_progress",
  };
  return { type: "item.started", item };
}

function mcpToolCompleted(
  tool: string,
  server: string,
  args: unknown,
  result?: McpToolCallItem["result"],
  error?: McpToolCallItem["error"],
  id = "mcp-1",
): ItemCompletedEvent {
  const item: McpToolCallItem = {
    id,
    type: "mcp_tool_call",
    server,
    tool,
    arguments: args,
    ...(result ? { result } : {}),
    ...(error ? { error } : {}),
    status: result ? "completed" : "failed",
  };
  return { type: "item.completed", item };
}

function fileChangeCompleted(
  changes: { path: string; kind: "add" | "delete" | "update" }[],
  id = "fc-1",
): ItemCompletedEvent {
  const item: FileChangeItem = {
    id,
    type: "file_change",
    changes,
    status: "completed",
  };
  return { type: "item.completed", item };
}

function reasoningCompleted(text: string, id = "reason-1"): ItemCompletedEvent {
  const item: ReasoningItem = { id, type: "reasoning", text };
  return { type: "item.completed", item };
}

function todoListCompleted(
  items: { text: string; completed: boolean }[],
  id = "todo-1",
): ItemCompletedEvent {
  const item: TodoListItem = { id, type: "todo_list", items };
  return { type: "item.completed", item };
}

function webSearchStarted(query: string, id = "search-1"): ItemStartedEvent {
  const item: WebSearchItem = { id, type: "web_search", query };
  return { type: "item.started", item };
}

function webSearchCompleted(
  query: string,
  id = "search-1",
): ItemCompletedEvent {
  const item: WebSearchItem = { id, type: "web_search", query };
  return { type: "item.completed", item };
}

/**
 * Makes a thread that yields some events then crashes with the given error
 * (simulating the Codex process exiting with a non-zero code after partial output).
 */
function makeCrashingThread(
  eventsBeforeCrash: ThreadEvent[],
  crashError: Error,
): CodexThreadLike {
  return {
    id: null,
    async runStreamed(): Promise<{ events: AsyncGenerator<ThreadEvent> }> {
      return {
        events: (async function* () {
          for (const event of eventsBeforeCrash) {
            yield event;
          }
          throw crashError;
        })(),
      };
    },
  };
}

// ============================================================
// Minimal event sequence for a successful turn
// ============================================================

function minimalSuccessEvents(threadId = "thread-123"): ThreadEvent[] {
  return [
    threadStarted(threadId),
    { type: "turn.started" as const },
    agentMessageCompleted("Hello, world!"),
    turnCompleted(),
  ];
}

// ============================================================
// Tests
// ============================================================

describe("CodexConversationRuntime", () => {
  let deps: CodexConversationRuntimeDeps;
  let startThreadFn: ReturnType<typeof vi.fn>;
  let resumeThreadFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    startThreadFn = vi.fn();
    resumeThreadFn = vi.fn();

    deps = {
      createCodex: vi.fn().mockReturnValue({
        startThread: startThreadFn,
        resumeThread: resumeThreadFn,
      }),
      buildChildEnv: vi.fn().mockReturnValue({}),
      toStringEnv: vi.fn().mockImplementation((env: NodeJS.ProcessEnv) => {
        const result: Record<string, string> = {};
        for (const [k, v] of Object.entries(env)) {
          if (v !== undefined) result[k] = v;
        }
        return result;
      }),
      getServerUrl: vi.fn().mockReturnValue("http://127.0.0.1:3000"),
      getApiToken: vi.fn().mockReturnValue("tok-abc"),
      getConfigDir: vi.fn().mockReturnValue("/cfg"),
      translatePortableMcpToCodex: vi
        .fn()
        .mockReturnValue({ mcpServers: {}, droppedFields: [] }),
      listNativeCodexMcpServers: vi.fn().mockResolvedValue([]),
      getCodexPricingOverrides: vi.fn().mockResolvedValue(null),
      readPersistedCostBaseline: vi.fn().mockResolvedValue(null),
      ensureManagedSkillsBridge: vi
        .fn()
        .mockResolvedValue({ status: "skipped", reason: "no_bundle" }),
      now: vi.fn().mockReturnValue(1000),
    };
  });

  function setupThread(events: ThreadEvent[]): void {
    const thread = makeThread(events);
    startThreadFn.mockReturnValue(thread);
    resumeThreadFn.mockReturnValue(thread);
  }

  // --------------------------------------------------------
  // sendTurn — first turn
  // --------------------------------------------------------

  describe("sendTurn — first turn", () => {
    it("creates a new thread, emits backend_init, and returns a codex backendRef", async () => {
      setupThread(minimalSuccessEvents());
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      const onEvent = vi.fn();
      const result = await runtime.sendTurn(makeTurnInput({ onEvent }));

      // Should call startThread, not resumeThread
      expect(startThreadFn).toHaveBeenCalled();
      expect(resumeThreadFn).not.toHaveBeenCalled();

      // Should emit backend_init with the thread ID
      expect(onEvent).toHaveBeenCalledWith({
        type: "backend_init",
        backendRef: { backend: "codex", ref: "thread-123" },
      });

      // Should return a valid backendRef
      expect(result.backendRef).toEqual({
        backend: "codex",
        ref: "thread-123",
      });
      expect(result.failure).toBeNull();
      expect(result.continuationDisposition).toBe("retain");
      expect(result.aborted).toBe(false);
    });

    it("prepends session instructions and synthetic fork seed on first turn only", async () => {
      const thread = makeCapturingThread(minimalSuccessEvents());
      startThreadFn.mockReturnValue(thread);

      const runtime = new CodexConversationRuntime(
        makeCreateInput({
          sessionInstructions: ["Rule A", "Rule B"],
        }),
        deps,
      );

      await runtime.sendTurn(
        makeTurnInput({
          promptText: "Do the thing",
          syntheticForkSeed: "Previous context here",
        }),
      );

      const inputStr = thread.capturedInput as string;
      expect(typeof inputStr).toBe("string");
      // Instructions should appear before the fork seed and prompt
      expect(inputStr).toContain("## System Instructions");
      expect(inputStr).toContain("Rule A");
      expect(inputStr).toContain("Rule B");
      expect(inputStr).toContain("Previous context here");
      expect(inputStr).toContain("Do the thing");

      // Verify order: instructions → fork seed → prompt
      const instructionsIdx = inputStr.indexOf("## System Instructions");
      const forkSeedIdx = inputStr.indexOf("Previous context here");
      const promptIdx = inputStr.indexOf("Do the thing");
      expect(instructionsIdx).toBeLessThan(forkSeedIdx);
      expect(forkSeedIdx).toBeLessThan(promptIdx);
    });

    it("passes thread options matching the task runner defaults", async () => {
      setupThread(minimalSuccessEvents());
      const runtime = new CodexConversationRuntime(
        makeCreateInput({ modelId: "o3-pro", reasoningEffort: "high" }),
        deps,
      );

      await runtime.sendTurn(makeTurnInput());

      expect(startThreadFn).toHaveBeenCalledWith(
        expect.objectContaining({
          workingDirectory: "/test/worktree",
          sandboxMode: "danger-full-access",
          approvalPolicy: "never",
          webSearchMode: "disabled",
          skipGitRepoCheck: true,
          model: "o3-pro",
          modelReasoningEffort: "high",
        }),
      );
    });

    it("defaults model to the global default codex model and omits effort when not set", async () => {
      setupThread(minimalSuccessEvents());
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);

      await runtime.sendTurn(makeTurnInput());

      const threadOpts = startThreadFn.mock.calls[0]![0];
      expect(threadOpts.model).toBe(getDefaultCodexModel());
      expect(threadOpts).not.toHaveProperty("modelReasoningEffort");
    });

    it("builds env with CLAUDECODE empty string", async () => {
      setupThread(minimalSuccessEvents());
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);

      await runtime.sendTurn(makeTurnInput());

      expect(deps.buildChildEnv).toHaveBeenCalled();
      expect(deps.toStringEnv).toHaveBeenCalledWith(
        expect.objectContaining({ CLAUDECODE: "" }),
      );
    });
  });

  // --------------------------------------------------------
  // sendTurn — cctl env contract
  // --------------------------------------------------------

  describe("sendTurn — cctl env contract", () => {
    /** Read the env handed to the Codex SDK on the first createCodex call. */
    function envOfFirstTurn(): Record<string, string> {
      const codexCall = (deps.createCodex as ReturnType<typeof vi.fn>).mock
        .calls[0]![0];
      return codexCall.env as Record<string, string>;
    }

    it("injects the full cctl identity + server contract for a non-lane conversation", async () => {
      setupThread(minimalSuccessEvents());
      const runtime = new CodexConversationRuntime(
        makeCreateInput({
          projectName: "command-center",
          sessionName: "my-session",
          conversationId: "conv-123",
        }),
        deps,
      );

      await runtime.sendTurn(makeTurnInput());

      const env = envOfFirstTurn();
      expect(env.CC_PROJECT).toBe("command-center");
      expect(env.CC_SESSION).toBe("my-session");
      expect(env.CC_CONVERSATION_SCOPE).toBe("session");
      expect(env.CC_CONVERSATION_ID).toBe("conv-123");
      expect(env.CC_SERVER_URL).toBe("http://127.0.0.1:3000");
      expect(env.CC_API_TOKEN).toBe("tok-abc");
      // configDir/bin prepended so `cctl` resolves on PATH.
      expect(env.PATH).toContain("/cfg/bin");
      // Non-lane conversation carries neither workflow identity var.
      expect("CC_WORKFLOW_EXECUTION_ID" in env).toBe(false);
      expect("CC_WORKFLOW_CONTEXT_ID" in env).toBe(false);
    });

    it("exports the project scope discriminator and a neutralized CC_SESSION for a project conversation", async () => {
      setupThread(minimalSuccessEvents());
      const runtime = new CodexConversationRuntime(
        makeCreateInput({
          projectName: "command-center",
          conversationId: "conv-plc",
          // Scope arrives as declared input; the runtime never infers it.
          conversationTarget: projectConversationTarget(
            "command-center",
            "conv-plc",
          ),
        }),
        deps,
      );

      await runtime.sendTurn(makeTurnInput());

      const env = envOfFirstTurn();
      expect(env.CC_CONVERSATION_SCOPE).toBe("project");
      expect("CC_SESSION" in env).toBe(true);
      expect(env.CC_SESSION).toBe("");
      for (const [key, value] of Object.entries(env)) {
        expect(value, `${key} must not carry the sentinel`).not.toContain(
          "__project__",
        );
      }
    });

    it("injects the CC-scope conversation id when the runtime's own id is synthetic", async () => {
      setupThread(minimalSuccessEvents());
      const runtime = new CodexConversationRuntime(
        makeCreateInput({
          conversationId: "collab-wf-1-9f3a2b",
          ccScopeConversationId: "conv-originating",
        }),
        deps,
      );

      await runtime.sendTurn(makeTurnInput());

      expect(envOfFirstTurn().CC_CONVERSATION_ID).toBe("conv-originating");
    });

    describe("launch capability (D7 D11/D12)", () => {
      it("carries the capability it was handed into the agent env", async () => {
        setupThread(minimalSuccessEvents());
        const runtime = new CodexConversationRuntime(
          makeCreateInput({ conversationCapability: "cccc1.spawn-minted.sig" }),
          deps,
        );

        await runtime.sendTurn(makeTurnInput());

        expect(envOfFirstTurn()[CONVERSATION_CAPABILITY_ENV_VAR]).toBe(
          "cccc1.spawn-minted.sig",
        );
      });

      it("gives a collaboration-internal runtime none, even though its env names the originating conversation", async () => {
        // The redirect is why this runtime must never derive a capability from
        // the id it exports: that id belongs to the originating human.
        setupThread(minimalSuccessEvents());
        const runtime = new CodexConversationRuntime(
          makeCreateInput({
            conversationId: "collab-wf-1-9f3a2b",
            ccScopeConversationId: "conv-originating",
          }),
          deps,
        );

        await runtime.sendTurn(makeTurnInput());

        expect(envOfFirstTurn().CC_CONVERSATION_ID).toBe("conv-originating");
        expect(envOfFirstTurn()[CONVERSATION_CAPABILITY_ENV_VAR]).toBe(
          undefined,
        );
      });
    });

    it("injects both lane identity vars for a graph-workflow lane conversation", async () => {
      setupThread(minimalSuccessEvents());
      const runtime = new CodexConversationRuntime(
        makeCreateInput({
          workflowExecutionId: "exec-9",
          workflowContextId: "context-plan",
        }),
        deps,
      );

      await runtime.sendTurn(makeTurnInput());

      const env = envOfFirstTurn();
      expect(env.CC_WORKFLOW_EXECUTION_ID).toBe("exec-9");
      expect(env.CC_WORKFLOW_CONTEXT_ID).toBe("context-plan");
    });

    it("omits CC_SERVER_URL / CC_API_TOKEN when the server has not resolved them", async () => {
      deps.getServerUrl = vi.fn().mockReturnValue(null);
      deps.getApiToken = vi.fn().mockReturnValue(null);
      setupThread(minimalSuccessEvents());
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);

      await runtime.sendTurn(makeTurnInput());

      const env = envOfFirstTurn();
      expect("CC_SERVER_URL" in env).toBe(false);
      expect("CC_API_TOKEN" in env).toBe(false);
    });

    it("re-derives the contract every turn so a late-resolved server URL is picked up", async () => {
      deps.getServerUrl = vi
        .fn()
        .mockReturnValueOnce(null)
        .mockReturnValue("http://127.0.0.1:3000");

      setupThread(minimalSuccessEvents());
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);

      await runtime.sendTurn(makeTurnInput());
      setupThread(minimalSuccessEvents("thread-123"));
      await runtime.sendTurn(makeTurnInput());

      const createCodexCalls = (deps.createCodex as ReturnType<typeof vi.fn>)
        .mock.calls;
      const firstEnv = createCodexCalls[0]![0].env as Record<string, string>;
      const secondEnv = createCodexCalls[1]![0].env as Record<string, string>;
      expect("CC_SERVER_URL" in firstEnv).toBe(false);
      expect(secondEnv.CC_SERVER_URL).toBe("http://127.0.0.1:3000");
    });
  });

  // --------------------------------------------------------
  // sendTurn — resumed turn
  // --------------------------------------------------------

  describe("sendTurn — resumed turn", () => {
    it("calls resumeThread with the persisted threadId", async () => {
      setupThread(minimalSuccessEvents("thread-resumed"));
      const runtime = new CodexConversationRuntime(
        makeCreateInput({
          persistedRef: { backend: "codex", ref: "thread-existing" },
        }),
        deps,
      );

      await runtime.sendTurn(makeTurnInput());

      expect(resumeThreadFn).toHaveBeenCalledWith(
        "thread-existing",
        expect.any(Object),
      );
      expect(startThreadFn).not.toHaveBeenCalled();
    });

    it("does not prepend session instructions on resumed turns", async () => {
      const thread = makeCapturingThread(
        minimalSuccessEvents("thread-resumed"),
      );
      resumeThreadFn.mockReturnValue(thread);

      const runtime = new CodexConversationRuntime(
        makeCreateInput({
          persistedRef: { backend: "codex", ref: "thread-existing" },
          sessionInstructions: ["Rule A"],
        }),
        deps,
      );

      await runtime.sendTurn(makeTurnInput({ promptText: "Next prompt" }));

      const inputStr = thread.capturedInput as string;
      expect(inputStr).not.toContain("## System Instructions");
      expect(inputStr).not.toContain("Rule A");
      expect(inputStr).toBe("Next prompt");
    });

    it("does not prepend instructions on second turn after first turn", async () => {
      // First turn
      setupThread(minimalSuccessEvents());
      const runtime = new CodexConversationRuntime(
        makeCreateInput({ sessionInstructions: ["Rule A"] }),
        deps,
      );
      await runtime.sendTurn(makeTurnInput());

      // Second turn — thread.started already fired, isFirstTurn should be false
      const thread2 = makeCapturingThread(minimalSuccessEvents("thread-123"));
      resumeThreadFn.mockReturnValue(thread2);
      await runtime.sendTurn(makeTurnInput({ promptText: "Second prompt" }));

      const inputStr = thread2.capturedInput as string;
      expect(inputStr).not.toContain("## System Instructions");
      expect(inputStr).toBe("Second prompt");
    });
  });

  // --------------------------------------------------------
  // sendTurn — event mapping
  // --------------------------------------------------------

  describe("sendTurn — event mapping", () => {
    it("maps agent_message completion to text content block", async () => {
      setupThread([
        threadStarted(),
        agentMessageCompleted("Response text"),
        turnCompleted(),
      ]);
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      const onEvent = vi.fn();
      const result = await runtime.sendTurn(makeTurnInput({ onEvent }));

      expect(result.contentBlocks).toContainEqual({
        type: "text",
        text: "Response text",
      });

      // Should also emit as a content event
      expect(onEvent).toHaveBeenCalledWith({
        type: "content",
        block: { type: "text", text: "Response text" },
      });
    });

    it("serializes async event delivery in provider order", async () => {
      setupThread([
        threadStarted(),
        agentMessageCompleted("First progress", "msg-1"),
        agentMessageCompleted("Second progress", "msg-2"),
        turnCompleted(),
      ]);
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      const observed: string[] = [];

      await runtime.sendTurn(
        makeTurnInput({
          onEvent: async (event) => {
            if (event.type === "input_accepted") {
              await Promise.resolve();
              observed.push("accepted");
              return;
            }
            if (event.type === "backend_init") {
              observed.push("init");
              return;
            }
            if (event.type === "content" && event.block.type === "text") {
              await Promise.resolve();
              observed.push(event.block.text);
            }
          },
        }),
      );

      expect(observed).toEqual([
        "accepted",
        "init",
        "First progress",
        "Second progress",
      ]);
    });

    it("maps command_execution start to tool_use and completion to tool_result", async () => {
      setupThread([
        threadStarted(),
        commandStarted("ls -la"),
        commandCompleted("ls -la", "total 42\nfile.txt"),
        turnCompleted(),
      ]);
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      const onEvent = vi.fn();
      const result = await runtime.sendTurn(makeTurnInput({ onEvent }));

      // Command start → tool_use with name "Bash"
      expect(result.contentBlocks).toContainEqual({
        type: "tool_use",
        id: "cmd-1",
        name: "Bash",
        input: { command: "ls -la" },
      });

      // Command completion → tool_result with the output
      expect(result.contentBlocks).toContainEqual({
        type: "tool_result",
        tool_use_id: "cmd-1",
        content: "total 42\nfile.txt",
      });

      // Should emit content events for both
      expect(onEvent).toHaveBeenCalledWith({
        type: "content",
        block: {
          type: "tool_use",
          id: "cmd-1",
          name: "Bash",
          input: { command: "ls -la" },
        },
      });
      expect(onEvent).toHaveBeenCalledWith({
        type: "content",
        block: {
          type: "tool_result",
          tool_use_id: "cmd-1",
          content: "total 42\nfile.txt",
        },
      });
    });

    it("unwraps /bin/bash -lc wrapper from command", async () => {
      setupThread([
        threadStarted(),
        commandStarted("/bin/bash -lc 'pwd && ls -la'"),
        commandCompleted("/bin/bash -lc 'pwd && ls -la'", "output"),
        turnCompleted(),
      ]);
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      const result = await runtime.sendTurn(makeTurnInput());

      const toolUse = result.contentBlocks.find((b) => b.type === "tool_use");
      expect(toolUse).toEqual({
        type: "tool_use",
        id: "cmd-1",
        name: "Bash",
        input: { command: "pwd && ls -la" },
      });
    });

    it("skips command tool_result when aggregated_output is empty", async () => {
      setupThread([
        threadStarted(),
        commandStarted("mkdir test"),
        commandCompleted("mkdir test", ""),
        turnCompleted(),
      ]);
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      const result = await runtime.sendTurn(makeTurnInput());

      // Should have the tool_use but no tool_result for empty output
      const toolUses = result.contentBlocks.filter(
        (b) => b.type === "tool_use",
      );
      const toolResults = result.contentBlocks.filter(
        (b) => b.type === "tool_result",
      );
      expect(toolUses).toHaveLength(1);
      expect(toolUses[0]).toEqual({
        type: "tool_use",
        id: "cmd-1",
        name: "Bash",
        input: { command: "mkdir test" },
      });
      expect(toolResults).toHaveLength(0);
    });

    it("marks command tool_result as error on non-zero exit code", async () => {
      setupThread([
        threadStarted(),
        commandStarted("false"),
        commandCompleted("false", "boom", "cmd-1", { exitCode: 1 }),
        turnCompleted(),
      ]);
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      const result = await runtime.sendTurn(makeTurnInput());

      const toolResult = result.contentBlocks.find(
        (b) => b.type === "tool_result",
      );
      expect(toolResult).toEqual({
        type: "tool_result",
        tool_use_id: "cmd-1",
        content: "boom",
        isError: true,
        metrics: { exitCode: 1 },
      });
    });

    it("emits failed-status command tool_result even with empty output", async () => {
      setupThread([
        threadStarted(),
        commandStarted("blowup"),
        commandCompleted("blowup", "", "cmd-1", { failed: true }),
        turnCompleted(),
      ]);
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      const result = await runtime.sendTurn(makeTurnInput());

      const toolResult = result.contentBlocks.find(
        (b) => b.type === "tool_result",
      );
      expect(toolResult).toEqual({
        type: "tool_result",
        tool_use_id: "cmd-1",
        isError: true,
      });
    });

    it("does not set isError on command success with exit 0", async () => {
      setupThread([
        threadStarted(),
        commandStarted("true"),
        commandCompleted("true", "ok", "cmd-1", { exitCode: 0 }),
        turnCompleted(),
      ]);
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      const result = await runtime.sendTurn(makeTurnInput());

      const toolResult = result.contentBlocks.find(
        (b) => b.type === "tool_result",
      );
      expect(toolResult).toEqual({
        type: "tool_result",
        tool_use_id: "cmd-1",
        content: "ok",
        metrics: { exitCode: 0 },
      });
    });

    it("maps mcp_tool_call start to tool_use and completion to tool_result", async () => {
      setupThread([
        threadStarted(),
        mcpToolStarted("read-file", "fs-server", { path: "/foo" }),
        mcpToolCompleted(
          "read-file",
          "fs-server",
          { path: "/foo" },
          {
            content: [{ type: "text", text: "file contents here" }],
            structured_content: null,
          },
        ),
        turnCompleted(),
      ]);
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      const result = await runtime.sendTurn(makeTurnInput());

      expect(result.contentBlocks).toContainEqual(
        expect.objectContaining({
          type: "tool_use",
          name: "read-file",
        }),
      );
      expect(result.contentBlocks).toContainEqual(
        expect.objectContaining({
          type: "tool_result",
          tool_use_id: "mcp-1",
          content: "file contents here",
        }),
      );
    });

    it("uses error message for mcp_tool_call when result has error", async () => {
      setupThread([
        threadStarted(),
        mcpToolStarted("bad-tool", "server", {}),
        mcpToolCompleted("bad-tool", "server", {}, undefined, {
          message: "tool failed",
        }),
        turnCompleted(),
      ]);
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      const result = await runtime.sendTurn(makeTurnInput());

      expect(result.contentBlocks).toContainEqual(
        expect.objectContaining({
          type: "tool_result",
          tool_use_id: "mcp-1",
          content: "tool failed",
          isError: true,
        }),
      );
    });

    it("maps file_change completion to a text summary", async () => {
      setupThread([
        threadStarted(),
        fileChangeCompleted([
          { path: "src/foo.ts", kind: "update" },
          { path: "src/bar.ts", kind: "add" },
        ]),
        turnCompleted(),
      ]);
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      const result = await runtime.sendTurn(makeTurnInput());

      const textBlocks = result.contentBlocks.filter((b) => b.type === "text");
      const summary = textBlocks.find(
        (b) => b.type === "text" && b.text.includes("src/foo.ts"),
      );
      expect(summary).toBeDefined();
      expect(summary!.type === "text" && summary!.text).toContain("src/bar.ts");
    });

    it("maps reasoning and todo_list into visible conversation blocks", async () => {
      setupThread([
        threadStarted(),
        reasoningCompleted("Thinking hard..."),
        todoListCompleted([{ text: "Step 1", completed: false }]),
        agentMessageCompleted("Done"),
        turnCompleted(),
      ]);
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      const result = await runtime.sendTurn(makeTurnInput());

      expect(result.contentBlocks).toEqual([
        { type: "thinking", text: "Thinking hard..." },
        {
          type: "tool_use",
          id: "todo-1",
          name: "TodoWrite",
          input: { todos: [{ text: "Step 1", completed: false }] },
        },
        { type: "text", text: "Done" },
      ]);
    });

    it("maps web_search start into a visible tool block", async () => {
      setupThread([
        threadStarted(),
        webSearchStarted("Codex SDK streaming"),
        webSearchCompleted("Codex SDK streaming"),
        turnCompleted(),
      ]);
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      const result = await runtime.sendTurn(makeTurnInput());

      expect(result.contentBlocks).toEqual([
        {
          type: "tool_use",
          id: "search-1",
          name: "WebSearch",
          input: { query: "Codex SDK streaming" },
        },
      ]);
    });

    it("captures usage from turn.completed", async () => {
      setupThread([
        threadStarted(),
        agentMessageCompleted("ok"),
        turnCompleted({
          input_tokens: 200,
          cached_input_tokens: 50,
          output_tokens: 100,
          reasoning_output_tokens: 0,
        }),
      ]);
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      const result = await runtime.sendTurn(makeTurnInput());

      expect(result.contextTokens).toBe(200);
      expect(result.numTurns).toBe(1);
    });

    it("handles turn.failed by storing error without discarding content", async () => {
      setupThread([
        threadStarted(),
        agentMessageCompleted("partial output"),
        turnFailed("Model overloaded"),
      ]);
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      const result = await runtime.sendTurn(makeTurnInput());

      expect(result.failure?.message).toContain("Model overloaded");
      expect(result.continuationDisposition).toBe("retain");
      // Partial content should be preserved
      expect(result.contentBlocks).toContainEqual({
        type: "text",
        text: "partial output",
      });
      expect(result.backendRef).toEqual({
        backend: "codex",
        ref: "thread-123",
      });
      expect(
        turnContinuationSchema.safeParse({
          backendRef: result.backendRef,
          continuationDisposition: result.continuationDisposition,
        }).success,
      ).toBe(true);
    });

    it("handles top-level error event", async () => {
      setupThread([
        threadStarted(),
        { type: "error", message: "Stream error" } satisfies ThreadEvent,
      ]);
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      const result = await runtime.sendTurn(makeTurnInput());

      expect(result.failure?.message).toContain("Stream error");
      expect(result.continuationDisposition).toBe("retain");
      expect(result.backendRef).toEqual({
        backend: "codex",
        ref: "thread-123",
      });
    });
  });

  // --------------------------------------------------------
  // sendTurn — abort and error handling
  // --------------------------------------------------------

  describe("sendTurn — input acceptance", () => {
    // The SDK's runStreamed returns a LAZY generator — the codex process only
    // spawns on the first iteration. Acceptance must therefore be signaled by
    // the first ThreadEvent, never by runStreamed resolving: a false
    // acceptance marks queued rows delivered for a message the agent never
    // received (req 4.2).

    it("emits input_accepted exactly once, before any other backend event", async () => {
      setupThread(minimalSuccessEvents());
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      const onEvent = vi.fn();
      await runtime.sendTurn(makeTurnInput({ onEvent }));

      const acceptedCalls = onEvent.mock.calls.filter(
        ([e]) => (e as { type: string }).type === "input_accepted",
      );
      expect(acceptedCalls).toHaveLength(1);
      expect(onEvent.mock.calls[0]?.[0]).toEqual({ type: "input_accepted" });
    });

    it("does not emit input_accepted when the process dies before producing any event", async () => {
      const thread = makeCrashingThread([], new Error("spawn codex ENOENT"));
      startThreadFn.mockReturnValue(thread);

      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      const onEvent = vi.fn();
      const result = await runtime.sendTurn(makeTurnInput({ onEvent }));

      expect(result.failure?.message).toContain("spawn codex ENOENT");
      expect(onEvent).not.toHaveBeenCalledWith({ type: "input_accepted" });
    });

    it("does not emit input_accepted when a resumed thread has no rollout", async () => {
      const thread = makeCrashingThread(
        [],
        new Error('thread/resume: no rollout found for thread id "t-gone"'),
      );
      resumeThreadFn.mockReturnValue(thread);

      const runtime = new CodexConversationRuntime(
        makeCreateInput({
          persistedRef: { backend: "codex", ref: "t-gone" },
        }),
        deps,
      );
      const onEvent = vi.fn();
      const result = await runtime.sendTurn(makeTurnInput({ onEvent }));

      expect(result.failure?.message).toContain(
        "Failed to resume Codex thread",
      );
      expect(onEvent).not.toHaveBeenCalledWith({ type: "input_accepted" });
    });

    it("does not emit input_accepted when aborted before any event", async () => {
      const thread = makeAbortingThread([]);
      startThreadFn.mockReturnValue(thread);

      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      const onEvent = vi.fn();
      const result = await runtime.sendTurn(makeTurnInput({ onEvent }));

      expect(result.aborted).toBe(true);
      expect(onEvent).not.toHaveBeenCalledWith({ type: "input_accepted" });
    });
  });

  describe("sendTurn — abort and error handling", () => {
    it("preserves partial contentBlocks and backendRef on abort", async () => {
      const thread = makeAbortingThread([
        threadStarted(),
        agentMessageCompleted("partial response"),
      ]);
      startThreadFn.mockReturnValue(thread);

      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      const result = await runtime.sendTurn(makeTurnInput());

      expect(result.aborted).toBe(true);
      expect(result.contentBlocks).toContainEqual({
        type: "text",
        text: "partial response",
      });
      expect(result.backendRef).toEqual({
        backend: "codex",
        ref: "thread-123",
      });
    });

    it("reports aborted, not a provider failure, when an external abort surfaces as a graceful turn.failed", async () => {
      // Incident shape (2026-07-18 pause of the hung SDD turn): the abort
      // signal fires, codex answers the interrupt with turn.failed
      // ("Aborted: user") and the stream ENDS without throwing. The turn was
      // cancelled — it must classify as aborted, never as an sdk_error.
      const abortController = new AbortController();
      const thread = makeThread([threadStarted(), turnFailed("Aborted: user")]);
      startThreadFn.mockReturnValue(thread);

      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      abortController.abort();
      const result = await runtime.sendTurn(
        makeTurnInput({ signal: abortController.signal }),
      );

      expect(result.aborted).toBe(true);
      expect(result.failure).toBeNull();
      // A cancelled resume leaves the server-side thread viable.
      expect(result.continuationDisposition).toBe("retain");
    });

    it("returns backendRef null when thread.started never arrived before failure", async () => {
      const thread = makeThread([], {
        runStreamedThrows: new Error("Spawn failed"),
      });
      startThreadFn.mockReturnValue(thread);

      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      const result = await runtime.sendTurn(makeTurnInput());

      expect(result.backendRef).toBeNull();
      expect(result.failure?.message).toContain("Spawn failed");
      // isFirstTurn should remain true so next attempt can retry
    });

    it("keeps isFirstTurn true when thread.started never arrived", async () => {
      // First attempt fails before thread.started
      const failThread = makeThread([], {
        runStreamedThrows: new Error("Spawn failed"),
      });
      startThreadFn.mockReturnValue(failThread);

      const runtime = new CodexConversationRuntime(
        makeCreateInput({ sessionInstructions: ["Rule A"] }),
        deps,
      );
      await runtime.sendTurn(makeTurnInput());

      // Second attempt should still prepend instructions (isFirstTurn still true)
      const thread2 = makeCapturingThread(minimalSuccessEvents());
      startThreadFn.mockReturnValue(thread2);
      await runtime.sendTurn(makeTurnInput({ promptText: "Retry" }));

      const inputStr = thread2.capturedInput as string;
      expect(inputStr).toContain("## System Instructions");
    });

    it("returns clear error for missing resumed thread without falling back to startThread", async () => {
      const thread = makeThread([], {
        runStreamedThrows: new Error(
          'thread/resume: no rollout found for thread id "thread-gone"',
        ),
      });
      resumeThreadFn.mockReturnValue(thread);

      const runtime = new CodexConversationRuntime(
        makeCreateInput({
          persistedRef: { backend: "codex", ref: "thread-gone" },
        }),
        deps,
      );
      const result = await runtime.sendTurn(makeTurnInput());

      expect(result.failure?.message).toContain(
        "Failed to resume Codex thread",
      );
      expect(result.failure?.message).toContain("thread-gone");
      expect(result.failure?.kind).toBe("stale_resume_ref");
      expect(startThreadFn).not.toHaveBeenCalled();
      // "clear" must clear: returning the attempted stale id here would make
      // the orchestrator retry the missing rollout forever.
      expect(result.backendRef).toBeNull();
      expect(result.continuationDisposition).toBe("clear");
      expect(
        turnContinuationSchema.safeParse({
          backendRef: result.backendRef,
          continuationDisposition: result.continuationDisposition,
        }).success,
      ).toBe(true);
    });

    it("starts a fresh thread on the turn after a stale resume", async () => {
      const staleThread = makeThread([], {
        runStreamedThrows: new Error(
          'thread/resume: no rollout found for thread id "thread-gone"',
        ),
      });
      resumeThreadFn.mockReturnValue(staleThread);

      const runtime = new CodexConversationRuntime(
        makeCreateInput({
          persistedRef: { backend: "codex", ref: "thread-gone" },
          sessionInstructions: ["Be helpful"],
        }),
        deps,
      );
      await runtime.sendTurn(makeTurnInput());

      const freshThread = makeCapturingThread(
        minimalSuccessEvents("thread-new"),
      );
      startThreadFn.mockReturnValue(freshThread);

      const result = await runtime.sendTurn(
        makeTurnInput({ promptText: "Try again" }),
      );

      // The stale ref was invalidated: the runtime must not attempt the same
      // missing rollout again.
      expect(resumeThreadFn).toHaveBeenCalledTimes(1);
      expect(startThreadFn).toHaveBeenCalledTimes(1);
      // Effectively a fresh start — instructions are delivered again.
      expect(freshThread.capturedInput as string).toContain(
        "## System Instructions",
      );
      expect(result.failure).toBeNull();
      expect(result.backendRef).toEqual({
        backend: "codex",
        ref: "thread-new",
      });
    });

    it("does not rethrow SDK errors — returns them as result.failure", async () => {
      const thread = makeThread([], {
        runStreamedThrows: new Error("Unexpected SDK failure"),
      });
      startThreadFn.mockReturnValue(thread);

      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      // Should not throw
      const result = await runtime.sendTurn(makeTurnInput());
      expect(result.failure?.message).toContain("Unexpected SDK failure");
    });

    it("preserves turn.failed error when process also crashes with exit code", async () => {
      // Simulates: thread starts → turn.failed with useful message → process exits code 1
      const thread = makeCrashingThread(
        [
          threadStarted(),
          turnFailed(
            "API error: model gpt-5.4-nano is temporarily unavailable",
          ),
        ],
        new Error(
          "Codex Exec exited with code 1: Reading prompt from stdin...\n",
        ),
      );
      startThreadFn.mockReturnValue(thread);

      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      const result = await runtime.sendTurn(makeTurnInput());

      // Should keep the informative turn.failed message, not the generic exit code error
      expect(result.failure?.message).toContain(
        "model gpt-5.4-nano is temporarily unavailable",
      );
      expect(result.failure?.message).not.toContain(
        "Reading prompt from stdin",
      );
      expect(result.continuationDisposition).toBe("clear");
      expect(result.backendRef).toBeNull();
    });

    it("retains a resumed thread when the local Codex process crashes", async () => {
      const thread = makeCrashingThread(
        [threadStarted("thread-existing")],
        new Error("Codex Exec exited with code 1"),
      );
      resumeThreadFn.mockReturnValue(thread);

      const runtime = new CodexConversationRuntime(
        makeCreateInput({
          persistedRef: { backend: "codex", ref: "thread-existing" },
        }),
        deps,
      );
      const result = await runtime.sendTurn(makeTurnInput());

      expect(result.failure?.kind).toBe("backend_error");
      expect(result.continuationDisposition).toBe("retain");
      expect(result.backendRef).toEqual({
        backend: "codex",
        ref: "thread-existing",
      });
    });

    it("resets to fresh state after thread.started received but turn crashes", async () => {
      // First turn: thread starts but then crashes
      const crashThread = makeCrashingThread(
        [threadStarted("thread-dead")],
        new Error(
          "Codex Exec exited with code 1: Reading prompt from stdin...\n",
        ),
      );
      startThreadFn.mockReturnValue(crashThread);

      const runtime = new CodexConversationRuntime(
        makeCreateInput({ sessionInstructions: ["Be helpful"] }),
        deps,
      );
      const result1 = await runtime.sendTurn(makeTurnInput());
      expect(result1.failure).toBeTruthy();
      expect(result1.continuationDisposition).toBe("clear");

      // Second turn: should start a fresh thread, not try to resume the dead one
      const thread2 = makeCapturingThread(minimalSuccessEvents("thread-new"));
      startThreadFn.mockReturnValue(thread2);

      const result2 = await runtime.sendTurn(
        makeTurnInput({ promptText: "Try again" }),
      );

      // Should have called startThread (not resumeThread)
      expect(startThreadFn).toHaveBeenCalledTimes(2);
      expect(resumeThreadFn).not.toHaveBeenCalled();

      // Should re-include session instructions since it's effectively a fresh start
      const inputStr = thread2.capturedInput as string;
      expect(inputStr).toContain("## System Instructions");
      expect(inputStr).toContain("Be helpful");

      // Second turn should succeed
      expect(result2.failure).toBeNull();
      expect(result2.backendRef).toEqual({
        backend: "codex",
        ref: "thread-new",
      });
    });

    it("returns null backendRef when thread started but turn failed", async () => {
      const crashThread = makeCrashingThread(
        [threadStarted("thread-dead")],
        new Error(
          "Codex Exec exited with code 1: Reading prompt from stdin...\n",
        ),
      );
      startThreadFn.mockReturnValue(crashThread);

      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      const result = await runtime.sendTurn(makeTurnInput());

      // Should NOT return the dead thread's ID as backendRef
      expect(result.backendRef).toBeNull();
    });
  });

  // --------------------------------------------------------
  // sendTurn — structured output
  // --------------------------------------------------------

  describe("sendTurn — structured output", () => {
    it("uses the LAST agent_message for structured output, not the first", async () => {
      setupThread([
        threadStarted(),
        agentMessageCompleted('{"version": 1}', "msg-1"),
        agentMessageCompleted('{"version": 2}', "msg-2"),
        turnCompleted(),
      ]);
      const runtime = new CodexConversationRuntime(
        makeCreateInput({
          outputFormat: {
            type: "json_schema",
            schema: { type: "object" },
          },
        }),
        deps,
      );
      const result = await runtime.sendTurn(makeTurnInput());

      expect(result.structuredOutput).toEqual({ version: 2 });
    });

    it("returns undefined structuredOutput when text is not valid JSON", async () => {
      setupThread([
        threadStarted(),
        agentMessageCompleted("This is not JSON"),
        turnCompleted(),
      ]);
      const runtime = new CodexConversationRuntime(
        makeCreateInput({
          outputFormat: {
            type: "json_schema",
            schema: { type: "object" },
          },
        }),
        deps,
      );
      const result = await runtime.sendTurn(makeTurnInput());

      expect(result.structuredOutput).toBeUndefined();
    });

    it("returns undefined structuredOutput when outputFormat is not set", async () => {
      setupThread([
        threadStarted(),
        agentMessageCompleted('{"result": "success"}'),
        turnCompleted(),
      ]);
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      const result = await runtime.sendTurn(makeTurnInput());

      expect(result.structuredOutput).toBeUndefined();
    });

    it("passes outputSchema to runStreamed when outputFormat is set", async () => {
      const schema = { type: "object", properties: { x: { type: "number" } } };
      const thread = makeCapturingThread(minimalSuccessEvents());
      startThreadFn.mockReturnValue(thread);

      const runtime = new CodexConversationRuntime(
        makeCreateInput({ outputFormat: { type: "json_schema", schema } }),
        deps,
      );
      await runtime.sendTurn(makeTurnInput());

      expect(thread.capturedTurnOptions).toBeDefined();
      expect(thread.capturedTurnOptions!.outputSchema).toEqual(schema);
    });

    it("adds the provider-required type to const-only schema nodes while retaining the authored output format", async () => {
      const schema = {
        type: "object",
        properties: {
          marker: { const: "fixed" },
        },
        required: ["marker"],
        additionalProperties: false,
      };
      const outputFormat = { type: "json_schema" as const, schema };
      const thread = makeCapturingThread(minimalSuccessEvents());
      startThreadFn.mockReturnValue(thread);

      const runtime = new CodexConversationRuntime(
        makeCreateInput({ outputFormat }),
        deps,
      );
      await runtime.sendTurn(makeTurnInput());

      expect(runtime.outputFormat).toBe(outputFormat);
      expect(thread.capturedTurnOptions?.outputSchema).toEqual({
        type: "object",
        properties: {
          marker: { const: "fixed", type: "string" },
        },
        required: ["marker"],
        additionalProperties: false,
      });
      expect(schema.properties.marker).toEqual({ const: "fixed" });
    });
  });

  // --------------------------------------------------------
  // sendTurn — images
  // --------------------------------------------------------

  describe("sendTurn — images", () => {
    it("forwards persistent image paths as local_image inputs without temp materialization", async () => {
      const thread = makeCapturingThread(minimalSuccessEvents());
      startThreadFn.mockReturnValue(thread);

      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      await runtime.sendTurn(
        makeTurnInput({
          imageRefs: [
            {
              index: 1,
              mediaType: "image/png",
              path: "/cfg/transcripts/images/conv-123/1.png",
              base64Data: "aGVsbG8=",
            },
            {
              index: 2,
              mediaType: "image/jpeg",
              path: "/cfg/transcripts/images/conv-123/2.jpg",
              base64Data: "d29ybGQ=",
            },
          ],
        }),
      );

      const input = thread.capturedInput as Array<{
        type: string;
        path?: string;
        text?: string;
      }>;
      expect(Array.isArray(input)).toBe(true);
      const localImages = input.filter((i) => i.type === "local_image");
      expect(localImages).toHaveLength(2);
      expect(localImages[0]?.path).toBe(
        "/cfg/transcripts/images/conv-123/1.png",
      );
      expect(localImages[1]?.path).toBe(
        "/cfg/transcripts/images/conv-123/2.jpg",
      );
      expect(input.some((i) => i.type === "text")).toBe(true);
    });
  });

  // --------------------------------------------------------
  // sendTurn — result metadata
  // --------------------------------------------------------

  describe("sendTurn — result metadata", () => {
    it("returns durationMs computed from deps.now()", async () => {
      let callCount = 0;
      deps.now = vi.fn().mockImplementation(() => {
        callCount++;
        return callCount === 1 ? 1000 : 2500;
      });
      setupThread(minimalSuccessEvents());
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      const result = await runtime.sendTurn(makeTurnInput());

      expect(result.durationMs).toBe(1500);
    });
  });

  describe("sendTurn — cost estimation", () => {
    it("estimates costUsd from turn usage at the effective model's default rates", async () => {
      // No modelId → default model (gpt-5.4: $2.50/$0.25/$15 per 1M);
      // fixture usage: 100 input (10 cached), 50 output.
      setupThread(minimalSuccessEvents());
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);

      const result = await runtime.sendTurn(makeTurnInput());

      expect(result.costUsd).toBeCloseTo(0.0009775, 10);
    });

    it("returns null costUsd for a model with no known rates", async () => {
      setupThread(minimalSuccessEvents());
      const runtime = new CodexConversationRuntime(
        makeCreateInput({ modelId: "o3-pro" }),
        deps,
      );

      const result = await runtime.sendTurn(makeTurnInput());

      expect(result.costUsd).toBeNull();
    });

    it("prices with config pricing overrides when the dep provides them", async () => {
      deps.getCodexPricingOverrides = vi.fn().mockResolvedValue({
        "gpt-5.4": {
          inputPerMillion: 10,
          cachedInputPerMillion: 1,
          outputPerMillion: 100,
        },
      });
      setupThread(minimalSuccessEvents());
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);

      const result = await runtime.sendTurn(makeTurnInput());

      expect(result.costUsd).toBeCloseTo(
        (90 * 10 + 10 * 1 + 50 * 100) / 1_000_000,
        10,
      );
    });

    it("returns null costUsd when the turn produced no usage", async () => {
      setupThread([threadStarted(), turnFailed()]);
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);

      const result = await runtime.sendTurn(makeTurnInput());

      expect(result.costUsd).toBeNull();
    });

    it("falls back to default rates when the pricing-overrides dep rejects", async () => {
      deps.getCodexPricingOverrides = vi
        .fn()
        .mockRejectedValue(new Error("config unreadable"));
      setupThread(minimalSuccessEvents());
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);

      const result = await runtime.sendTurn(makeTurnInput());

      expect(result.costUsd).toBeCloseTo(0.0009775, 10);
    });
  });

  describe("sendTurn — cumulative cost attribution", () => {
    // Codex `turn.completed` usage is CUMULATIVE for the thread (across
    // separate exec processes), so per-turn cost must be the delta between
    // consecutive cumulative estimates — summing snapshots inflates totals
    // (audit 1beec403: regenerate-api DB row = sum of its two cumulative
    // snapshots, ~1.8x real).
    const cumulativeUsage1: Usage = {
      input_tokens: 100,
      cached_input_tokens: 10,
      output_tokens: 50,
      reasoning_output_tokens: 0,
    };
    // Cumulative totals as of turn 2 (turn itself: 200 in / 20 cached / 70 out)
    const cumulativeUsage2: Usage = {
      input_tokens: 300,
      cached_input_tokens: 30,
      output_tokens: 120,
      reasoning_output_tokens: 0,
    };
    // gpt-5.4 default rates: $2.50 / $0.25 / $15 per 1M
    const COST_1 = 0.0009775; // 90*2.5 + 10*0.25 + 50*15 (per 1M)
    const COST_2 = 0.0024825; // 270*2.5 + 30*0.25 + 120*15 (per 1M)

    it("attributes only the delta when a later turn reports thread-cumulative usage", async () => {
      setupThread([
        threadStarted("thread-123"),
        agentMessageCompleted("first"),
        turnCompleted(cumulativeUsage1),
      ]);
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      const first = await runtime.sendTurn(makeTurnInput());
      expect(first.costUsd).toBeCloseTo(COST_1, 10);

      resumeThreadFn.mockReturnValue(
        makeThread([
          threadStarted("thread-123"),
          agentMessageCompleted("second"),
          turnCompleted(cumulativeUsage2),
        ]),
      );
      const second = await runtime.sendTurn(makeTurnInput());

      expect(second.costUsd).toBeCloseTo(COST_2 - COST_1, 10);
    });

    it("reports the thread-cumulative estimate separately on each result", async () => {
      setupThread([
        threadStarted("thread-123"),
        agentMessageCompleted("first"),
        turnCompleted(cumulativeUsage1),
      ]);
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      const first = await runtime.sendTurn(makeTurnInput());
      expect(first.cumulativeCostUsd).toBeCloseTo(COST_1, 10);

      resumeThreadFn.mockReturnValue(
        makeThread([
          threadStarted("thread-123"),
          agentMessageCompleted("second"),
          turnCompleted(cumulativeUsage2),
        ]),
      );
      const second = await runtime.sendTurn(makeTurnInput());

      expect(second.cumulativeCostUsd).toBeCloseTo(COST_2, 10);
      expect(second.costUsd).toBeCloseTo(COST_2 - COST_1, 10);
    });

    it("re-attributes in full when the thread's cumulative counters reset", async () => {
      setupThread([
        threadStarted("thread-123"),
        agentMessageCompleted("first"),
        turnCompleted(cumulativeUsage2),
      ]);
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      const first = await runtime.sendTurn(makeTurnInput());
      expect(first.costUsd).toBeCloseTo(COST_2, 10);

      // Cumulative DROPPED below the baseline — thread restarted server-side.
      resumeThreadFn.mockReturnValue(
        makeThread([
          threadStarted("thread-123"),
          agentMessageCompleted("second"),
          turnCompleted(cumulativeUsage1),
        ]),
      );
      const second = await runtime.sendTurn(makeTurnInput());

      expect(second.costUsd).toBeCloseTo(COST_1, 10);
    });

    it("seeds the baseline from the persisted cost record when resuming a prior thread", async () => {
      deps.readPersistedCostBaseline = vi.fn().mockResolvedValue({
        threadRef: "thread-existing",
        cumulativeCostUsd: COST_1,
      });
      setupThread([
        threadStarted("thread-existing"),
        agentMessageCompleted("resumed"),
        turnCompleted(cumulativeUsage2),
      ]);
      const runtime = new CodexConversationRuntime(
        makeCreateInput({
          persistedRef: { backend: "codex", ref: "thread-existing" },
        }),
        deps,
      );

      const result = await runtime.sendTurn(makeTurnInput());

      expect(deps.readPersistedCostBaseline).toHaveBeenCalledWith(
        "conv-123",
        "thread-existing",
      );
      expect(result.costUsd).toBeCloseTo(COST_2 - COST_1, 10);
      expect(result.cumulativeCostUsd).toBeCloseTo(COST_2, 10);
    });

    it("ignores a persisted cost record for a different thread", async () => {
      deps.readPersistedCostBaseline = vi.fn().mockResolvedValue({
        threadRef: "some-other-thread",
        cumulativeCostUsd: COST_1,
      });
      setupThread([
        threadStarted("thread-existing"),
        agentMessageCompleted("resumed"),
        turnCompleted(cumulativeUsage2),
      ]);
      const runtime = new CodexConversationRuntime(
        makeCreateInput({
          persistedRef: { backend: "codex", ref: "thread-existing" },
        }),
        deps,
      );

      const result = await runtime.sendTurn(makeTurnInput());

      expect(result.costUsd).toBeCloseTo(COST_2, 10);
    });
  });

  // --------------------------------------------------------
  // applyPortableMcpConfig
  // --------------------------------------------------------

  describe("applyPortableMcpConfig", () => {
    it("returns deferred_to_next_turn disposition", async () => {
      const runtime = new CodexConversationRuntime(
        makeCreateInput({ tooling: {} }),
        deps,
      );
      const config: PortableMcpConfig = {
        servers: [
          {
            id: "test-server",
            transport: "stdio",
            command: "node",
            args: ["server.js"],
          },
        ],
      };
      const result = await runtime.applyPortableMcpConfig!(config);

      expect(result.disposition).toBe("deferred_to_next_turn");
      expect(result.errors).toEqual({});
    });

    it("staged MCP config appears in the next turn's CodexOptions", async () => {
      const translatedMcp = {
        mcpServers: { "test-server": { command: "node" } },
        droppedFields: [],
      };
      deps.translatePortableMcpToCodex = vi.fn().mockReturnValue(translatedMcp);

      setupThread(minimalSuccessEvents());
      const runtime = new CodexConversationRuntime(
        makeCreateInput({ tooling: {} }),
        deps,
      );

      await runtime.applyPortableMcpConfig!({
        servers: [
          {
            id: "test-server",
            transport: "stdio",
            command: "node",
          },
        ],
      });

      await runtime.sendTurn(makeTurnInput());

      // createCodex should have been called with config containing mcp_servers
      expect(deps.createCodex).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            mcp_servers: { "test-server": { command: "node" } },
          }),
        }),
      );
    });

    it("each next turn reconstructs Codex with the latest staged config after repeated applies", async () => {
      // Per-turn instance reconstruction must pick up the most recent apply so
      // mid-conversation MCP changes take effect on the following turn and any
      // turn after that — not only the first.
      const firstMcp = {
        mcpServers: { "srv-a": { command: "a" } },
        droppedFields: [],
      };
      const secondMcp = {
        mcpServers: { "srv-b": { command: "b" } },
        droppedFields: [],
      };
      deps.translatePortableMcpToCodex = vi
        .fn()
        .mockReturnValueOnce(firstMcp)
        .mockReturnValueOnce(firstMcp) // called once per sendTurn's buildCodexOptions
        .mockReturnValueOnce(secondMcp)
        .mockReturnValueOnce(secondMcp);

      setupThread(minimalSuccessEvents());
      const runtime = new CodexConversationRuntime(
        makeCreateInput({ tooling: {} }),
        deps,
      );

      await runtime.applyPortableMcpConfig!({
        servers: [{ id: "srv-a", transport: "stdio", command: "a" }],
      });
      await runtime.sendTurn(makeTurnInput());

      // Second apply mid-conversation replaces the staged config.
      await runtime.applyPortableMcpConfig!({
        servers: [{ id: "srv-b", transport: "stdio", command: "b" }],
      });
      setupThread(minimalSuccessEvents("thread-123"));
      await runtime.sendTurn(makeTurnInput());

      const createCodexCalls = (deps.createCodex as ReturnType<typeof vi.fn>)
        .mock.calls;
      expect(createCodexCalls).toHaveLength(2);

      const firstConfig = createCodexCalls[0]![0].config;
      const secondConfig = createCodexCalls[1]![0].config;
      expect(firstConfig.mcp_servers).toEqual({ "srv-a": { command: "a" } });
      expect(secondConfig.mcp_servers).toEqual({ "srv-b": { command: "b" } });
    });

    it("emits empty config.mcp_servers when no managed or native servers are present", async () => {
      deps.translatePortableMcpToCodex = vi
        .fn()
        .mockReturnValue({ mcpServers: {}, droppedFields: [] });

      setupThread(minimalSuccessEvents());
      const runtime = new CodexConversationRuntime(
        makeCreateInput({ tooling: {} }),
        deps,
      );

      await runtime.applyPortableMcpConfig!({ servers: [] });
      await runtime.sendTurn(makeTurnInput());

      const codexCall = (deps.createCodex as ReturnType<typeof vi.fn>).mock
        .calls[0]![0];
      expect(codexCall).toHaveProperty("config");
      expect(codexCall.config).toEqual({
        mcp_servers: {},
        service_tier: "default",
        features: { fast_mode: false },
      });
    });

    it("adds enabled=false entries for native Codex MCP servers not managed by Command Center", async () => {
      deps.translatePortableMcpToCodex = vi.fn().mockReturnValue({
        mcpServers: {
          "external-tools": { url: "http://localhost/mcp" },
          "next-devtools-project": { command: "npx", args: ["next"] },
        },
        droppedFields: [],
      });
      deps.listNativeCodexMcpServers = vi.fn().mockResolvedValue([
        {
          name: "playwright",
          configEntry: {
            command: "npx",
            args: ["-y", "@playwright/mcp@latest"],
          },
        },
        {
          name: "external-tools",
          configEntry: { url: "http://localhost/mcp" },
        },
        {
          name: "next-devtools",
          configEntry: {
            command: "npx",
            args: ["-y", "next-devtools-mcp@latest"],
          },
        },
      ]);

      setupThread(minimalSuccessEvents());
      const runtime = new CodexConversationRuntime(
        makeCreateInput({
          tooling: {
            portableMcp: {
              servers: [
                {
                  id: "external-tools",
                  transport: "streamable-http",
                  url: "http://localhost/mcp",
                },
                {
                  id: "next-devtools-project",
                  transport: "stdio",
                  command: "npx",
                  args: ["next"],
                },
              ],
            },
          },
        }),
        deps,
      );

      await runtime.sendTurn(makeTurnInput());

      expect(deps.listNativeCodexMcpServers).toHaveBeenCalledWith({
        cwd: "/test/worktree",
        env: expect.any(Object),
      });
      const codexCall = (deps.createCodex as ReturnType<typeof vi.fn>).mock
        .calls[0]![0];
      expect(codexCall.config).toEqual({
        mcp_servers: {
          "external-tools": { url: "http://localhost/mcp" },
          "next-devtools-project": { command: "npx", args: ["next"] },
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

    it("still emits the explicit standard speed when no portable MCP has been staged", async () => {
      setupThread(minimalSuccessEvents());
      const runtime = new CodexConversationRuntime(
        makeCreateInput({ tooling: {} }),
        deps,
      );

      await runtime.sendTurn(makeTurnInput());

      const codexCall = (deps.createCodex as ReturnType<typeof vi.fn>).mock
        .calls[0]![0];
      expect(codexCall.config).toEqual({
        service_tier: "default",
        features: { fast_mode: false },
      });
    });
  });

  describe("Codex fast mode", () => {
    it("rebuilds SDK options from the speed selected for each turn", async () => {
      setupThread(minimalSuccessEvents());
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);

      await runtime.sendTurn(makeTurnInput({ codexFastMode: false }));
      setupThread(minimalSuccessEvents("thread-123"));
      await runtime.sendTurn(makeTurnInput({ codexFastMode: true }));

      const createCodexCalls = (deps.createCodex as ReturnType<typeof vi.fn>)
        .mock.calls;
      expect(createCodexCalls[0]![0].config).toEqual({
        service_tier: "default",
        features: { fast_mode: false },
      });
      expect(createCodexCalls[1]![0].config).toEqual({
        service_tier: "fast",
        features: { fast_mode: true },
      });
    });

    it("defaults omitted speed settings to standard", async () => {
      setupThread(minimalSuccessEvents());
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);

      await runtime.sendTurn(makeTurnInput());

      const codexCall = (deps.createCodex as ReturnType<typeof vi.fn>).mock
        .calls[0]![0];
      expect(codexCall.config).toMatchObject({
        service_tier: "default",
        features: { fast_mode: false },
      });
    });
  });

  // --------------------------------------------------------
  // close
  // --------------------------------------------------------

  describe("close", () => {
    it("sets status to dead", () => {
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      expect(runtime.status).toBe("alive");

      runtime.close();
      expect(runtime.status).toBe("dead");
    });
  });

  // --------------------------------------------------------
  // Agent profile delivery (agent-profile-library R9.5)
  // --------------------------------------------------------

  /**
   * Codex delivers session instructions inside a fenced "## System Instructions"
   * header on the first turn — weaker, textual semantics than Claude's system
   * prompt. Containment of the profile layer has to hold against THAT framing,
   * so these drive the real first-turn prompt build.
   */
  describe("agent profile delivery", () => {
    const CHARTER_LAYER =
      "# Session Alignment (governing context)\nThis charter governs the session.";
    const ROLE_HARNESS_LAYER =
      "# Role harness\nReturn your final answer through the structured output tool.";

    /**
     * The production ordering: resolve → compose → persist the snapshot →
     * deliver the STORED block. Runtime creation never re-renders, so this
     * drives `buildAgentProfileSnapshot` and hands the backend exactly the
     * bytes a restart would replay.
     */
    async function deliverProfile(
      profile: ResolvedAgentProfile,
    ): Promise<{ input: string; snapshot: AgentProfileSnapshot }> {
      const thread = makeCapturingThread(minimalSuccessEvents());
      startThreadFn.mockReturnValue(thread);

      const snapshot = buildAgentProfileSnapshot(profile);

      const runtime = new CodexConversationRuntime(
        makeCreateInput({
          sessionInstructions: [
            CHARTER_LAYER,
            ROLE_HARNESS_LAYER,
            snapshot.renderedInstructionBlock,
          ],
        }),
        deps,
      );
      await runtime.sendTurn(makeTurnInput({ promptText: "Review the diff" }));

      const captured = thread.capturedInput;
      if (typeof captured !== "string") {
        throw new Error("expected a string prompt input");
      }
      return { input: captured, snapshot };
    }

    function resolvedProfile(
      instructions: string,
      overrides?: Partial<ResolvedAgentProfile>,
    ): ResolvedAgentProfile {
      return {
        tier: "builtin",
        id: "security-reviewer",
        name: "Security Reviewer",
        revision: 1,
        sourceContentHash: computeContentHash(instructions),
        instructions,
        ...overrides,
      };
    }

    /** The delivered profile layer, cut out of the transport's own output. */
    function deliveredProfileLayer(delivered: string): string {
      const start = delivered.indexOf(PROFILE_LAYER_HEADING);
      const end = delivered.lastIndexOf(PROFILE_BLOCK_END);
      return delivered.slice(start, end + PROFILE_BLOCK_END.length);
    }

    it("delivers a built-in profile's stored block as its own subordinate layer", async () => {
      const builtin = findBuiltinAgentProfile("security-reviewer");
      if (builtin === undefined) throw new Error("missing built-in");

      const { input, snapshot } = await deliverProfile(
        resolvedProfile(builtin.instructions, {
          name: builtin.name,
          revision: builtin.revision,
        }),
      );

      expect(input).toContain("## System Instructions");
      expect(input).toContain(CHARTER_LAYER);
      expect(input).toContain("cannot expand your scope");
      expect(input.indexOf(CHARTER_LAYER)).toBeLessThan(
        input.indexOf(PROFILE_BLOCK_BEGIN),
      );
      // The user request stays in its own channel, after the instruction frame.
      expect(input.indexOf(PROFILE_BLOCK_END)).toBeLessThan(
        input.indexOf("Review the diff"),
      );
      // What reached the transport is byte-identical to the stored block, and
      // resolvedInstructionHash covers exactly those delivered bytes.
      expect(deliveredProfileLayer(input)).toBe(
        snapshot.renderedInstructionBlock,
      );
      expect(computeContentHash(deliveredProfileLayer(input))).toBe(
        snapshot.resolvedInstructionHash,
      );
    });
  });
});

// ============================================================
// Factory tests
// ============================================================

describe("codexConversationBackendFactory", () => {
  describe("validateModelAndEffort", () => {
    it("accepts valid reasoning effort", () => {
      expect(() =>
        codexConversationBackendFactory.validateModelAndEffort!({
          reasoningEffort: "high",
        }),
      ).not.toThrow();
    });

    it("rejects invalid reasoning effort", () => {
      expect(() =>
        codexConversationBackendFactory.validateModelAndEffort!({
          reasoningEffort: "turbo",
        }),
      ).toThrow();
    });

    it("rejects known-model with unsupported reasoning effort", () => {
      // gpt-5.4 supports: low, medium, high, xhigh (not minimal)
      expect(() =>
        codexConversationBackendFactory.validateModelAndEffort!({
          modelId: "gpt-5.4",
          reasoningEffort: "minimal",
        }),
      ).toThrow();
    });

    it("allows unknown model with valid reasoning effort", () => {
      expect(() =>
        codexConversationBackendFactory.validateModelAndEffort!({
          modelId: "unknown-model-42",
          reasoningEffort: "high",
        }),
      ).not.toThrow();
    });
  });

  describe("createRuntime", () => {
    it("creates a runtime with the right model and effort", async () => {
      const runtime = await codexConversationBackendFactory.createRuntime({
        conversationId: "conv-1",
        projectPath: "/p",
        projectName: "proj",
        conversationTarget: sessionConversationTarget("proj", "sess", "conv-1"),
        worktreePath: "/w",
        persistedRef: null,
        modelId: "o3-pro",
        reasoningEffort: "high",
        sessionInstructions: [],
        tooling: {},
      });

      expect(runtime.modelId).toBe("o3-pro");
      expect(runtime.reasoningEffort).toBe("high");
    });
  });
});
