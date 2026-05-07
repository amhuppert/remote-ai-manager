import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const queryMock = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
}));

vi.mock("@/lib/sdk-env", () => ({}));

import { claudeConversationBackendFactory } from "./conversation-runtime";
import type { ConversationBackendEvent } from "../conversation";

function createControllableMockQuery() {
  const messages: SDKMessage[] = [];
  let resolveNext: ((value: IteratorResult<SDKMessage, void>) => void) | null =
    null;
  let done = false;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const generator: any = {
    close: vi.fn(() => {
      done = true;
      if (resolveNext) {
        resolveNext({ value: undefined, done: true });
        resolveNext = null;
      }
    }),
    streamInput: vi.fn(),
    interrupt: vi.fn(),
    mcpServerStatus: vi.fn().mockResolvedValue([]),
    setMcpServers: vi
      .fn()
      .mockResolvedValue({ added: [], removed: [], errors: {} }),
    next() {
      if (messages.length > 0) {
        return Promise.resolve({
          value: messages.shift()!,
          done: false,
        } as IteratorResult<SDKMessage, void>);
      }
      if (done) {
        return Promise.resolve({
          value: undefined,
          done: true,
        } as IteratorResult<SDKMessage, void>);
      }
      return new Promise<IteratorResult<SDKMessage, void>>((resolve) => {
        resolveNext = resolve;
      });
    },
    return() {
      done = true;
      return Promise.resolve({ value: undefined, done: true });
    },
    throw(err: Error) {
      done = true;
      return Promise.reject(err);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };

  return {
    query: generator,
    pushMessage(msg: SDKMessage) {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: msg, done: false });
      } else {
        messages.push(msg);
      }
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ClaudeConversationRuntime — SDK options", () => {
  it("disallows the native AskUserQuestion tool so the MCP version is the only path", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const runtime = await claudeConversationBackendFactory.createRuntime({
      conversationId: "conv-disallow",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {},
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const callArg = queryMock.mock.calls[0]![0]! as {
      options: { disallowedTools?: string[] };
    };
    expect(callArg.options.disallowedTools).toContain("AskUserQuestion");

    runtime.close();
  });
});

describe("ClaudeConversationRuntime — external turn events", () => {
  it("emits external_turn_started, provider_events, and external_turn_completed for a virtual turn", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const externalEvents: ConversationBackendEvent[] = [];

    const runtime = await claudeConversationBackendFactory.createRuntime({
      conversationId: "conv-ext-1",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {},
      onExternalTurnEvent: (event: ConversationBackendEvent) => {
        externalEvents.push(event);
      },
    });

    // Run one caller-initiated turn so the session is past first-prompt state
    const turnPromise = runtime.sendTurn({
      promptText: "hello",
      imageRefs: [],
      sessionInstructions: [],
      autonomous: false,
      signal: new AbortController().signal,
      onEvent: () => {},
    });

    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      uuid: "u1",
      total_cost_usd: 0,
      duration_ms: 0,
      num_turns: 0,
      result: "",
      is_error: false,
    } as unknown as SDKMessage);

    await turnPromise;

    // Now simulate an auto-continuation turn
    mock.pushMessage({
      type: "user",
      session_id: "sess-1",
      uuid: "u2",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "<task-notification>done</task-notification>",
          },
        ],
      },
      parent_tool_use_id: null,
    } as unknown as SDKMessage);

    mock.pushMessage({
      type: "assistant",
      session_id: "sess-1",
      uuid: "u3",
      message: {
        content: [{ type: "text", text: "External response" }],
      },
    } as unknown as SDKMessage);

    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      uuid: "u4",
      total_cost_usd: 0.12,
      duration_ms: 500,
      num_turns: 2,
      result: "External response",
      is_error: false,
    } as unknown as SDKMessage);

    await new Promise((r) => setTimeout(r, 10));

    const startedIdx = externalEvents.findIndex(
      (e) => e.type === "external_turn_started",
    );
    const completedIdx = externalEvents.findIndex(
      (e) => e.type === "external_turn_completed",
    );
    const providerEvents = externalEvents.filter(
      (e) => e.type === "provider_event",
    );

    expect(startedIdx).toBeGreaterThanOrEqual(0);
    expect(completedIdx).toBeGreaterThan(startedIdx);
    expect(providerEvents.length).toBeGreaterThanOrEqual(3);

    const completedEvent = externalEvents[completedIdx]!;
    if (completedEvent.type !== "external_turn_completed") {
      throw new Error("expected external_turn_completed");
    }
    expect(completedEvent.result.costUsd).toBe(0.12);
    expect(completedEvent.result.durationMs).toBe(500);
    expect(completedEvent.result.numTurns).toBe(2);
    expect(completedEvent.result.backendRef).toEqual({
      backend: "claude",
      sessionId: "sess-1",
    });

    runtime.close();
  });

  it("emits external_turn_started only once per virtual turn (resets between virtual turns)", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const externalEvents: ConversationBackendEvent[] = [];

    const runtime = await claudeConversationBackendFactory.createRuntime({
      conversationId: "conv-ext-2",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {},
      onExternalTurnEvent: (event: ConversationBackendEvent) => {
        externalEvents.push(event);
      },
    });

    const turnPromise = runtime.sendTurn({
      promptText: "hello",
      imageRefs: [],
      sessionInstructions: [],
      autonomous: false,
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      uuid: "u1",
      total_cost_usd: 0,
      duration_ms: 0,
      num_turns: 0,
      result: "",
      is_error: false,
    } as unknown as SDKMessage);
    await turnPromise;

    // Virtual turn #1
    mock.pushMessage({
      type: "user",
      session_id: "sess-1",
      uuid: "v1-user",
      message: {
        role: "user",
        content: [{ type: "text", text: "first notif" }],
      },
      parent_tool_use_id: null,
    } as unknown as SDKMessage);
    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      uuid: "v1-result",
      total_cost_usd: 0.01,
      duration_ms: 10,
      num_turns: 1,
      result: "",
      is_error: false,
    } as unknown as SDKMessage);
    await new Promise((r) => setTimeout(r, 10));

    // Virtual turn #2
    mock.pushMessage({
      type: "user",
      session_id: "sess-1",
      uuid: "v2-user",
      message: {
        role: "user",
        content: [{ type: "text", text: "second notif" }],
      },
      parent_tool_use_id: null,
    } as unknown as SDKMessage);
    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      uuid: "v2-result",
      total_cost_usd: 0.02,
      duration_ms: 20,
      num_turns: 1,
      result: "",
      is_error: false,
    } as unknown as SDKMessage);
    await new Promise((r) => setTimeout(r, 10));

    const startedCount = externalEvents.filter(
      (e) => e.type === "external_turn_started",
    ).length;
    const completedCount = externalEvents.filter(
      (e) => e.type === "external_turn_completed",
    ).length;

    expect(startedCount).toBe(2);
    expect(completedCount).toBe(2);

    runtime.close();
  });
});

describe("ClaudeConversationRuntime — applyPortableMcpConfig live updates", () => {
  it("applies live via setMcpServers when runtime is idle (disposition: applied_now)", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const runtime = await claudeConversationBackendFactory.createRuntime({
      conversationId: "conv-idle",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {},
    });

    const result = await runtime.applyPortableMcpConfig!({
      servers: [
        {
          id: "idle-stdio",
          transport: "stdio",
          command: "node",
        },
      ],
    });

    expect(result.disposition).toBe("applied_now");
    expect(mock.query.setMcpServers).toHaveBeenCalledTimes(1);
    const passed = (mock.query.setMcpServers as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as Record<string, unknown>;
    expect(passed).toHaveProperty("idle-stdio");

    runtime.close();
  });

  it("defers when a caller-initiated turn is running and does not call setMcpServers", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const runtime = await claudeConversationBackendFactory.createRuntime({
      conversationId: "conv-busy",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {},
    });

    // Kick off a turn but never push a result: it stays running.
    const turnPromise = runtime.sendTurn({
      promptText: "hello",
      imageRefs: [],
      sessionInstructions: [],
      autonomous: false,
      signal: new AbortController().signal,
      onEvent: () => {},
    });

    // Give the event loop a tick so currentTurnOptions is set.
    await Promise.resolve();

    const result = await runtime.applyPortableMcpConfig!({
      servers: [
        {
          id: "busy-stdio",
          transport: "stdio",
          command: "node",
        },
      ],
    });

    expect(result.disposition).toBe("deferred_to_next_turn");
    expect(mock.query.setMcpServers).not.toHaveBeenCalled();

    // Drain the turn so the test doesn't leak a pending promise.
    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      uuid: "u1",
      total_cost_usd: 0,
      duration_ms: 0,
      num_turns: 0,
      result: "",
      is_error: false,
    } as unknown as SDKMessage);
    await turnPromise;

    runtime.close();
  });
});

describe("ClaudeConversationRuntime — canUseTool MCP filter wiring", () => {
  function captureCanUseTool(): (
    toolName: string,
    toolInput: Record<string, unknown>,
  ) => Promise<unknown> {
    const firstCall = queryMock.mock.calls[0]!;
    const arg = firstCall[0] as {
      options: {
        canUseTool: (
          toolName: string,
          toolInput: Record<string, unknown>,
        ) => Promise<unknown>;
      };
    };
    return arg.options.canUseTool;
  }

  it("wires the resolver-backed MCP filter into canUseTool so disabled tools are denied", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const runtime = await claudeConversationBackendFactory.createRuntime({
      conversationId: "conv-wire-1",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {
        portableMcp: {
          servers: [
            {
              id: "srv",
              transport: "stdio",
              command: "node",
              disabledTools: ["forbidden"],
            },
          ],
        },
      },
    });

    const canUseTool = captureCanUseTool();
    const result = await canUseTool("mcp__srv__forbidden", { x: 1 });

    expect(result).toEqual({
      behavior: "deny",
      message: "Tool disabled by MCP configuration",
      interrupt: false,
    });

    runtime.close();
  });

  it("allows tools that the resolver-backed filter permits", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const runtime = await claudeConversationBackendFactory.createRuntime({
      conversationId: "conv-wire-2",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {
        portableMcp: {
          servers: [
            {
              id: "srv",
              transport: "stdio",
              command: "node",
              disabledTools: ["forbidden"],
            },
          ],
        },
      },
    });

    const canUseTool = captureCanUseTool();
    const result = await canUseTool("mcp__srv__permitted", { x: 1 });

    expect(result).toEqual({ behavior: "allow", updatedInput: { x: 1 } });

    runtime.close();
  });

  it("reflects live updates to the portable config after applyPortableMcpConfig", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const runtime = await claudeConversationBackendFactory.createRuntime({
      conversationId: "conv-wire-3",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {
        portableMcp: {
          servers: [{ id: "srv", transport: "stdio", command: "node" }],
        },
      },
    });

    const canUseTool = captureCanUseTool();

    const before = await canUseTool("mcp__srv__tool_a", {});
    expect(before).toEqual({ behavior: "allow", updatedInput: {} });

    await runtime.applyPortableMcpConfig!({
      servers: [
        {
          id: "srv",
          transport: "stdio",
          command: "node",
          disabledTools: ["tool_a"],
        },
      ],
    });

    const after = await canUseTool("mcp__srv__tool_a", {});
    expect(after).toEqual({
      behavior: "deny",
      message: "Tool disabled by MCP configuration",
      interrupt: false,
    });

    runtime.close();
  });

  it("does not update the filter when applyPortableMcpConfig is deferred", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const runtime = await claudeConversationBackendFactory.createRuntime({
      conversationId: "conv-wire-4",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {
        portableMcp: {
          servers: [{ id: "srv", transport: "stdio", command: "node" }],
        },
      },
    });

    const canUseTool = captureCanUseTool();

    const turnPromise = runtime.sendTurn({
      promptText: "hello",
      imageRefs: [],
      sessionInstructions: [],
      autonomous: false,
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    await Promise.resolve();

    const result = await runtime.applyPortableMcpConfig!({
      servers: [
        {
          id: "srv",
          transport: "stdio",
          command: "node",
          disabledTools: ["tool_a"],
        },
      ],
    });
    expect(result.disposition).toBe("deferred_to_next_turn");

    // Filter still reflects the original (non-deferred) config.
    const during = await canUseTool("mcp__srv__tool_a", {});
    expect(during).toEqual({ behavior: "allow", updatedInput: {} });

    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      uuid: "u1",
      total_cost_usd: 0,
      duration_ms: 0,
      num_turns: 0,
      result: "",
      is_error: false,
    } as unknown as SDKMessage);
    await turnPromise;

    runtime.close();
  });
});

describe("ClaudeConversationRuntime — initial MCP policy extraction", () => {
  it("invokes setMcpServers during createRuntime so HTTP tool policies are extracted into alwaysDenyRules at session start", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    await claudeConversationBackendFactory.createRuntime({
      conversationId: "conv-init-policy",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {
        portableMcp: {
          servers: [
            {
              id: "context7",
              transport: "streamable-http",
              url: "https://mcp.context7.com/mcp",
              disabledTools: ["resolve-library-id"],
            },
          ],
        },
      },
    });

    expect(mock.query.setMcpServers).toHaveBeenCalledTimes(1);
    const payload = (mock.query.setMcpServers as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      context7: {
        type: "http",
        url: "https://mcp.context7.com/mcp",
        tools: [
          { name: "resolve-library-id", permission_policy: "always_deny" },
        ],
      },
    });
  });

  it("does not invoke setMcpServers when the portable config carries no servers", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    await claudeConversationBackendFactory.createRuntime({
      conversationId: "conv-init-empty",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {},
    });

    expect(mock.query.setMcpServers).not.toHaveBeenCalled();
  });
});

describe("ClaudeConversationRuntime — error result classification", () => {
  it("preserves the learned sessionId in backendRef when the turn fails after init", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const runtime = await claudeConversationBackendFactory.createRuntime({
      conversationId: "conv-err-1",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {},
    });

    const turnPromise = runtime.sendTurn({
      promptText: "hello",
      imageRefs: [],
      sessionInstructions: [],
      autonomous: false,
      signal: new AbortController().signal,
      onEvent: () => {},
    });

    mock.pushMessage({
      type: "system",
      subtype: "init",
      session_id: "sess-after-init",
      uuid: "u-init",
      tools: [],
      mcp_servers: [],
      model: "claude",
    } as unknown as SDKMessage);

    await new Promise((r) => setTimeout(r, 5));

    runtime.close();

    const result = await turnPromise;

    expect(result.error).toContain("QuerySession closed");
    expect(result.backendRef).toEqual({
      backend: "claude",
      sessionId: "sess-after-init",
    });
  });

  it("classifies a closed-during-abort failure as aborted with no error", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const runtime = await claudeConversationBackendFactory.createRuntime({
      conversationId: "conv-err-2",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {},
    });

    const ac = new AbortController();
    const turnPromise = runtime.sendTurn({
      promptText: "hello",
      imageRefs: [],
      sessionInstructions: [],
      autonomous: false,
      signal: ac.signal,
      onEvent: () => {},
    });

    mock.pushMessage({
      type: "system",
      subtype: "init",
      session_id: "sess-aborted",
      uuid: "u-init",
      tools: [],
      mcp_servers: [],
      model: "claude",
    } as unknown as SDKMessage);

    await new Promise((r) => setTimeout(r, 5));

    ac.abort();
    runtime.close();

    const result = await turnPromise;

    expect(result.aborted).toBe(true);
    expect(result.error).toBeNull();
    expect(result.backendRef).toEqual({
      backend: "claude",
      sessionId: "sess-aborted",
    });
  });
});
