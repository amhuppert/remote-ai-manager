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

import { getConversationBackendFactory } from "../registry-core";
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
import { getDefaultCodexModel } from "@/lib/agent-backends/schemas";

// ============================================================
// Helpers
// ============================================================

function makeCreateInput(
  overrides?: Partial<ConversationBackendCreateInput>,
): ConversationBackendCreateInput {
  return {
    conversationId: "conv-123",
    projectPath: "/test/project",
    projectName: "test-project",
    sessionName: "test-session",
    worktreePath: "/test/worktree",
    persistedRef: null,
    sessionInstructions: ["Be helpful"],
    tooling: {},
    ...overrides,
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
      translatePortableMcpToCodex: vi
        .fn()
        .mockReturnValue({ mcpServers: {}, droppedFields: [] }),
      listNativeCodexMcpServerNames: vi.fn().mockResolvedValue([]),
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
        backendRef: { backend: "codex", threadId: "thread-123" },
      });

      // Should return a valid backendRef
      expect(result.backendRef).toEqual({
        backend: "codex",
        threadId: "thread-123",
      });
      expect(result.error).toBeNull();
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
  // sendTurn — resumed turn
  // --------------------------------------------------------

  describe("sendTurn — resumed turn", () => {
    it("calls resumeThread with the persisted threadId", async () => {
      setupThread(minimalSuccessEvents("thread-resumed"));
      const runtime = new CodexConversationRuntime(
        makeCreateInput({
          persistedRef: { backend: "codex", threadId: "thread-existing" },
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
          persistedRef: { backend: "codex", threadId: "thread-existing" },
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

    it("ignores reasoning and todo_list events", async () => {
      setupThread([
        threadStarted(),
        reasoningCompleted("Thinking hard..."),
        todoListCompleted([{ text: "Step 1", completed: false }]),
        agentMessageCompleted("Done"),
        turnCompleted(),
      ]);
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      const result = await runtime.sendTurn(makeTurnInput());

      // Only the agent_message block should appear
      expect(result.contentBlocks).toHaveLength(1);
      expect(result.contentBlocks[0]).toEqual({
        type: "text",
        text: "Done",
      });
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

      expect(result.error).toContain("Model overloaded");
      // Partial content should be preserved
      expect(result.contentBlocks).toContainEqual({
        type: "text",
        text: "partial output",
      });
      expect(result.backendRef).toEqual({
        backend: "codex",
        threadId: "thread-123",
      });
    });

    it("handles top-level error event", async () => {
      setupThread([
        threadStarted(),
        { type: "error", message: "Stream error" } satisfies ThreadEvent,
      ]);
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      const result = await runtime.sendTurn(makeTurnInput());

      expect(result.error).toContain("Stream error");
    });
  });

  // --------------------------------------------------------
  // sendTurn — abort and error handling
  // --------------------------------------------------------

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
        threadId: "thread-123",
      });
    });

    it("returns backendRef null when thread.started never arrived before failure", async () => {
      const thread = makeThread([], {
        runStreamedThrows: new Error("Spawn failed"),
      });
      startThreadFn.mockReturnValue(thread);

      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      const result = await runtime.sendTurn(makeTurnInput());

      expect(result.backendRef).toBeNull();
      expect(result.error).toContain("Spawn failed");
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
          persistedRef: { backend: "codex", threadId: "thread-gone" },
        }),
        deps,
      );
      const result = await runtime.sendTurn(makeTurnInput());

      expect(result.error).toContain("Failed to resume Codex thread");
      expect(result.error).toContain("thread-gone");
      expect(startThreadFn).not.toHaveBeenCalled();
      // Should still return the attempted threadId in backendRef
      expect(result.backendRef).toEqual({
        backend: "codex",
        threadId: "thread-gone",
      });
    });

    it("does not rethrow SDK errors — returns them as result.error", async () => {
      const thread = makeThread([], {
        runStreamedThrows: new Error("Unexpected SDK failure"),
      });
      startThreadFn.mockReturnValue(thread);

      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      // Should not throw
      const result = await runtime.sendTurn(makeTurnInput());
      expect(result.error).toContain("Unexpected SDK failure");
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
      expect(result.error).toContain(
        "model gpt-5.4-nano is temporarily unavailable",
      );
      expect(result.error).not.toContain("Reading prompt from stdin");
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
      expect(result1.error).toBeTruthy();

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
      expect(result2.error).toBeNull();
      expect(result2.backendRef).toEqual({
        backend: "codex",
        threadId: "thread-new",
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
    it("parses structured output from last agent_message when outputFormat is set", async () => {
      setupThread([
        threadStarted(),
        agentMessageCompleted('{"result": "success", "score": 42}'),
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

      expect(result.structuredOutput).toEqual({
        result: "success",
        score: 42,
      });
    });

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

    it("passes prompt as plain string when there are no imageRefs", async () => {
      const thread = makeCapturingThread(minimalSuccessEvents());
      startThreadFn.mockReturnValue(thread);

      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      await runtime.sendTurn(makeTurnInput({ imageRefs: [] }));

      expect(typeof thread.capturedInput).toBe("string");
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

    it("returns costUsd as null", async () => {
      setupThread(minimalSuccessEvents());
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      const result = await runtime.sendTurn(makeTurnInput());

      expect(result.costUsd).toBeNull();
    });

    it("returns contextWindowMax as null", async () => {
      setupThread(minimalSuccessEvents());
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      const result = await runtime.sendTurn(makeTurnInput());

      expect(result.contextWindowMax).toBeNull();
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
      expect(codexCall.config).toEqual({ mcp_servers: {} });
    });

    it("adds enabled=false entries for native Codex MCP servers not managed by Command Center", async () => {
      deps.translatePortableMcpToCodex = vi.fn().mockReturnValue({
        mcpServers: {
          "cc-session-tools": { url: "http://localhost/mcp" },
          "next-devtools-project": { command: "npx", args: ["next"] },
        },
        droppedFields: [],
      });
      deps.listNativeCodexMcpServerNames = vi
        .fn()
        .mockResolvedValue(["playwright", "cc-session-tools", "next-devtools"]);

      setupThread(minimalSuccessEvents());
      const runtime = new CodexConversationRuntime(
        makeCreateInput({
          tooling: {
            portableMcp: {
              servers: [
                {
                  id: "cc-session-tools",
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

      expect(deps.listNativeCodexMcpServerNames).toHaveBeenCalledWith({
        cwd: "/test/worktree",
        env: expect.any(Object),
      });
      const codexCall = (deps.createCodex as ReturnType<typeof vi.fn>).mock
        .calls[0]![0];
      expect(codexCall.config).toEqual({
        mcp_servers: {
          "cc-session-tools": { url: "http://localhost/mcp" },
          "next-devtools-project": { command: "npx", args: ["next"] },
          playwright: { enabled: false },
          "next-devtools": { enabled: false },
        },
      });
    });

    it("omits config entirely when no portable MCP has been staged", async () => {
      setupThread(minimalSuccessEvents());
      const runtime = new CodexConversationRuntime(
        makeCreateInput({ tooling: {} }),
        deps,
      );

      await runtime.sendTurn(makeTurnInput());

      const codexCall = (deps.createCodex as ReturnType<typeof vi.fn>).mock
        .calls[0]![0];
      expect(codexCall).not.toHaveProperty("config");
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

    it("is idempotent", () => {
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      runtime.close();
      runtime.close(); // should not throw
      expect(runtime.status).toBe("dead");
    });
  });

  // --------------------------------------------------------
  // capabilities
  // --------------------------------------------------------

  describe("capabilities", () => {
    it("reports correct capabilities", () => {
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      expect(runtime.capabilities).toEqual({
        queueWhileRunning: false,
        askUserQuestion: true,
        preciseFork: false,
        portableMcpAtStart: true,
        portableMcpBetweenTurns: true,
        contextWindowMetrics: false,
      });
    });

    it("has backend set to codex", () => {
      const runtime = new CodexConversationRuntime(makeCreateInput(), deps);
      expect(runtime.backend).toBe("codex");
    });
  });
});

// ============================================================
// Factory tests
// ============================================================

describe("codexConversationBackendFactory", () => {
  it("registers the factory on module load", () => {
    const factory = getConversationBackendFactory("codex");
    expect(factory.backend).toBe("codex");
    expect(factory).toBe(codexConversationBackendFactory);
  });

  it("has backend set to codex", () => {
    expect(codexConversationBackendFactory.backend).toBe("codex");
  });

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
          reasoningEffort: "max",
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

    it("accepts all supported levels for gpt-5.4", () => {
      for (const effort of ["low", "medium", "high", "xhigh"]) {
        expect(() =>
          codexConversationBackendFactory.validateModelAndEffort!({
            modelId: "gpt-5.4",
            reasoningEffort: effort,
          }),
        ).not.toThrow();
      }
    });

    it("rejects minimal effort for gpt-5.4-mini", () => {
      expect(() =>
        codexConversationBackendFactory.validateModelAndEffort!({
          modelId: "gpt-5.4-mini",
          reasoningEffort: "minimal",
        }),
      ).toThrow();
    });

    it("accepts all supported levels for gpt-5.4-mini", () => {
      for (const effort of ["low", "medium", "high", "xhigh"]) {
        expect(() =>
          codexConversationBackendFactory.validateModelAndEffort!({
            modelId: "gpt-5.4-mini",
            reasoningEffort: effort,
          }),
        ).not.toThrow();
      }
    });

    it("rejects minimal effort for gpt-5.4-nano", () => {
      expect(() =>
        codexConversationBackendFactory.validateModelAndEffort!({
          modelId: "gpt-5.4-nano",
          reasoningEffort: "minimal",
        }),
      ).toThrow();
    });

    it("accepts all supported levels for gpt-5.4-nano", () => {
      for (const effort of ["low", "medium", "high", "xhigh"]) {
        expect(() =>
          codexConversationBackendFactory.validateModelAndEffort!({
            modelId: "gpt-5.4-nano",
            reasoningEffort: effort,
          }),
        ).not.toThrow();
      }
    });

    it("allows unknown model with valid reasoning effort", () => {
      expect(() =>
        codexConversationBackendFactory.validateModelAndEffort!({
          modelId: "unknown-model-42",
          reasoningEffort: "high",
        }),
      ).not.toThrow();
    });

    it("allows no model and no effort", () => {
      expect(() =>
        codexConversationBackendFactory.validateModelAndEffort!({}),
      ).not.toThrow();
    });
  });

  describe("createRuntime", () => {
    it("creates a runtime with the right model and effort", async () => {
      const runtime = await codexConversationBackendFactory.createRuntime({
        conversationId: "conv-1",
        projectPath: "/p",
        projectName: "proj",
        sessionName: "sess",
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
