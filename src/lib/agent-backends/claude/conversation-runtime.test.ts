import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const queryMock = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
}));

vi.mock("@/lib/sdk-env", () => ({}));

import {
  claudeConversationBackendFactory,
  type ClaudeFactoryDeps,
} from "./conversation-runtime";
import { CLAUDE_AGENT_SUPPRESSION_STRATEGY } from "@/lib/agent-capabilities/claude-agent-suppression";
import type { ConversationBackendEvent } from "../conversation";
import {
  isUndeliveredQuerySessionError,
  QUERY_SESSION_ERROR_CODES,
  tagQuerySessionError,
} from "./query-session-errors";

function createFakeMcpServer(): {
  instance: McpServer;
  closeSpy: ReturnType<typeof vi.fn>;
} {
  const closeSpy = vi.fn().mockResolvedValue(undefined);
  const instance = { close: closeSpy } as unknown as McpServer;
  return { instance, closeSpy };
}

function depsWithFakeServer(): {
  deps: ClaudeFactoryDeps;
  instance: McpServer;
  closeSpy: ReturnType<typeof vi.fn>;
  createSpy: ReturnType<typeof vi.fn>;
} {
  const { instance, closeSpy } = createFakeMcpServer();
  const createSpy = vi.fn().mockResolvedValue(instance);
  return {
    deps: { createSessionMcpServer: createSpy },
    instance,
    closeSpy,
    createSpy,
  };
}

const createRuntimeWithFakeDeps: typeof claudeConversationBackendFactory.createRuntime =
  (input) =>
    claudeConversationBackendFactory.createRuntime(
      input,
      depsWithFakeServer().deps,
    );

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
    supportedCommands: vi.fn().mockResolvedValue([]),
    supportedAgents: vi.fn().mockResolvedValue([]),
    mcpServerStatus: vi.fn().mockResolvedValue([]),
    setMcpServers: vi
      .fn()
      .mockResolvedValue({ added: [], removed: [], errors: {} }),
    applyFlagSettings: vi.fn().mockResolvedValue(undefined),
    reloadPlugins: vi.fn().mockResolvedValue(undefined),
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

    const runtime = await createRuntimeWithFakeDeps({
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

    const runtime = await createRuntimeWithFakeDeps({
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

    const runtime = await createRuntimeWithFakeDeps({
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

describe("ClaudeConversationRuntime — capability runtime discovery", () => {
  it("forwards supportedCommands and supportedAgents to the live SDK query", async () => {
    const mock = createControllableMockQuery();
    mock.query.supportedCommands.mockResolvedValueOnce([{ name: "skill-a" }]);
    mock.query.supportedAgents.mockResolvedValueOnce([{ name: "agent-a" }]);
    queryMock.mockReturnValue(mock.query);

    const runtime = await createRuntimeWithFakeDeps({
      conversationId: "conv-runtime-capabilities",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {},
    });

    await expect(runtime.supportedCommands?.()).resolves.toEqual([
      { name: "skill-a" },
    ]);
    await expect(runtime.supportedAgents?.()).resolves.toEqual([
      { name: "agent-a" },
    ]);
  });
});

describe("ClaudeConversationRuntime — applyPortableMcpConfig live updates", () => {
  it("applies live via setMcpServers when runtime is idle (disposition: applied_now)", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const runtime = await createRuntimeWithFakeDeps({
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
    expect(mock.query.setMcpServers).toHaveBeenCalledTimes(2);
    const passed = (mock.query.setMcpServers as ReturnType<typeof vi.fn>).mock
      .calls[1]![0] as Record<string, unknown>;
    expect(passed).toHaveProperty("idle-stdio");

    runtime.close();
  });

  it("defers when a caller-initiated turn is running and does not call setMcpServers", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const runtime = await createRuntimeWithFakeDeps({
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
    // Initial setMcpServers from createRuntime is the only call; the deferred
    // apply does not invoke setMcpServers again.
    expect(mock.query.setMcpServers).toHaveBeenCalledTimes(1);

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

    const runtime = await createRuntimeWithFakeDeps({
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

    const runtime = await createRuntimeWithFakeDeps({
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

  it("denies disabled sub-agent Task invocations from the initial capability config", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const runtime = await createRuntimeWithFakeDeps({
      conversationId: "conv-agent-deny",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {
        claudeCapabilityConfig: {
          enabledPlugins: {},
          skillOverrides: {},
          disabledAgentNames: ["code-reviewer"],
          agentSuppressionStrategy: CLAUDE_AGENT_SUPPRESSION_STRATEGY,
        },
      },
    });

    const canUseTool = captureCanUseTool();
    const result = await canUseTool("Task", {
      subagent_type: "code-reviewer",
      prompt: "review this",
    });

    expect(result).toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("code-reviewer"),
    });

    runtime.close();
  });

  it("applies capability flags and reloads plugins so plugin-contributed children refresh", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const runtime = await createRuntimeWithFakeDeps({
      conversationId: "conv-capability-apply",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {},
    });

    const result = await runtime.applyClaudeCapabilityConfig!({
      enabledPlugins: { "owner@m": false },
      skillOverrides: { "contrib-skill": "off" },
      disabledAgentNames: [],
      agentSuppressionStrategy: CLAUDE_AGENT_SUPPRESSION_STRATEGY,
    });

    expect(result).toEqual({ status: "applied" });
    expect(mock.query.applyFlagSettings).toHaveBeenCalledWith({
      enabledPlugins: { "owner@m": false },
      skillOverrides: { "contrib-skill": "off" },
    });
    expect(mock.query.reloadPlugins).toHaveBeenCalledTimes(1);
    expect(
      mock.query.applyFlagSettings.mock.invocationCallOrder[0],
    ).toBeLessThan(mock.query.reloadPlugins.mock.invocationCallOrder[0]!);

    runtime.close();
  });

  it("reflects live updates to the portable config after applyPortableMcpConfig", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const runtime = await createRuntimeWithFakeDeps({
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

    const runtime = await createRuntimeWithFakeDeps({
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

    await createRuntimeWithFakeDeps({
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

  it("invokes setMcpServers exactly once even when the portable config carries no user servers, with cc-session-tools as the only entry", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const { deps, instance } = depsWithFakeServer();

    await claudeConversationBackendFactory.createRuntime(
      {
        conversationId: "conv-init-empty",
        projectPath: "/project",
        projectName: "proj",
        sessionName: "sess",
        worktreePath: "/project/.worktrees/sess",
        persistedRef: null,
        sessionInstructions: [],
        tooling: {},
      },
      deps,
    );

    expect(mock.query.setMcpServers).toHaveBeenCalledTimes(1);
    const payload = (mock.query.setMcpServers as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as Record<
      string,
      { type?: string; name?: string; instance?: McpServer }
    >;
    expect(Object.keys(payload)).toEqual(["cc-session-tools"]);
    const entry = payload["cc-session-tools"]!;
    expect(entry.type).toBe("sdk");
    expect(entry.name).toBe("cc-session-tools");
    expect(entry.instance).toBe(instance);
  });
});

describe("ClaudeConversationRuntime — cc-session-tools sdk entry", () => {
  it("merges the cc-session-tools sdk entry with user servers on initial setMcpServers", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const { deps, instance } = depsWithFakeServer();

    await claudeConversationBackendFactory.createRuntime(
      {
        conversationId: "conv-merge-init",
        projectPath: "/project",
        projectName: "proj",
        sessionName: "sess",
        worktreePath: "/project/.worktrees/sess",
        persistedRef: null,
        sessionInstructions: [],
        tooling: {
          portableMcp: {
            servers: [{ id: "user-srv", transport: "stdio", command: "node" }],
          },
        },
      },
      deps,
    );

    expect(mock.query.setMcpServers).toHaveBeenCalledTimes(1);
    const payload = (mock.query.setMcpServers as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as Record<
      string,
      { type?: string; name?: string; instance?: McpServer }
    >;
    expect(Object.keys(payload).sort()).toEqual([
      "cc-session-tools",
      "user-srv",
    ]);
    const entry = payload["cc-session-tools"]!;
    expect(entry.type).toBe("sdk");
    expect(entry.name).toBe("cc-session-tools");
    expect(entry.instance).toBe(instance);
  });

  it("re-merges cc-session-tools on subsequent applyPortableMcpConfig calls", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const { deps, instance } = depsWithFakeServer();

    const runtime = await claudeConversationBackendFactory.createRuntime(
      {
        conversationId: "conv-merge-apply",
        projectPath: "/project",
        projectName: "proj",
        sessionName: "sess",
        worktreePath: "/project/.worktrees/sess",
        persistedRef: null,
        sessionInstructions: [],
        tooling: {},
      },
      deps,
    );

    await runtime.applyPortableMcpConfig!({
      servers: [{ id: "applied-srv", transport: "stdio", command: "node" }],
    });

    expect(mock.query.setMcpServers).toHaveBeenCalledTimes(2);
    const payload = (mock.query.setMcpServers as ReturnType<typeof vi.fn>).mock
      .calls[1]![0] as Record<
      string,
      { type?: string; name?: string; instance?: McpServer }
    >;
    expect(Object.keys(payload).sort()).toEqual([
      "applied-srv",
      "cc-session-tools",
    ]);
    expect(payload["cc-session-tools"]?.instance).toBe(instance);
  });

  it("closes the cc-session-tools instance and the QuerySession when initial setMcpServers rejects", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);
    const setRejection = new Error("setMcpServers failed");
    (
      mock.query.setMcpServers as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(setRejection);

    const { deps, closeSpy: instanceClose } = depsWithFakeServer();

    await expect(
      claudeConversationBackendFactory.createRuntime(
        {
          conversationId: "conv-init-fail",
          projectPath: "/project",
          projectName: "proj",
          sessionName: "sess",
          worktreePath: "/project/.worktrees/sess",
          persistedRef: null,
          sessionInstructions: [],
          tooling: {},
        },
        deps,
      ),
    ).rejects.toBe(setRejection);

    expect(instanceClose).toHaveBeenCalledTimes(1);
    expect(mock.query.close).toHaveBeenCalled();
  });

  it("closes the cc-session-tools instance when runtime.close() is called", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const { deps, closeSpy: instanceClose } = depsWithFakeServer();

    const runtime = await claudeConversationBackendFactory.createRuntime(
      {
        conversationId: "conv-close",
        projectPath: "/project",
        projectName: "proj",
        sessionName: "sess",
        worktreePath: "/project/.worktrees/sess",
        persistedRef: null,
        sessionInstructions: [],
        tooling: {},
      },
      deps,
    );

    runtime.close();
    await Promise.resolve();
    expect(instanceClose).toHaveBeenCalledTimes(1);
  });
});

describe("ClaudeConversationRuntime — error result classification", () => {
  it("preserves the learned sessionId in backendRef when the turn fails after init", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const runtime = await createRuntimeWithFakeDeps({
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

    const runtime = await createRuntimeWithFakeDeps({
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

describe("ClaudeConversationRuntime — notifyTurnStarting", () => {
  it("forwards to the underlying QuerySession so the idle timer is cancelled before pre-turn work", async () => {
    vi.useFakeTimers();
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const runtime = await createRuntimeWithFakeDeps({
      conversationId: "conv-notify",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {},
    });

    // Complete a turn so the idle timer is armed
    const turn1 = runtime.sendTurn({
      promptText: "hi",
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
    await turn1;

    expect(runtime.status).toBe("alive");
    expect(runtime.notifyTurnStarting).toBeTypeOf("function");

    runtime.notifyTurnStarting!();

    // The QuerySession's default idle TTL is 5 minutes — advance past it
    vi.advanceTimersByTime(6 * 60 * 1000);

    expect(runtime.status).toBe("alive");

    vi.useRealTimers();
    runtime.close();
  });
});

describe("ClaudeConversationRuntime — retryable error propagation", () => {
  it("re-throws a promptNotDelivered error from sendPrompt instead of swallowing it into the result", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const runtime = await createRuntimeWithFakeDeps({
      conversationId: "conv-retryable",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {},
    });

    // Complete a first turn so the session moves past first-prompt state
    const turn1 = runtime.sendTurn({
      promptText: "first",
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
    await turn1;

    // Now make streamInput reject with a tagged promptNotDelivered error —
    // this is what query-session emits when the SDK pipe is gone before
    // delivery (e.g. EPIPE, ProcessTransport closed).
    mock.query.streamInput.mockRejectedValue(
      tagQuerySessionError(
        new Error("ProcessTransport is not ready for writing"),
        QUERY_SESSION_ERROR_CODES.promptNotDelivered,
      ),
    );

    let caughtError: unknown;
    try {
      await runtime.sendTurn({
        promptText: "second",
        imageRefs: [],
        sessionInstructions: [],
        autonomous: false,
        signal: new AbortController().signal,
        onEvent: () => {},
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(Error);
    expect(isUndeliveredQuerySessionError(caughtError)).toBe(true);

    runtime.close();
  });

  it("still returns an aborted result (does not throw) when the abort signal fires", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const runtime = await createRuntimeWithFakeDeps({
      conversationId: "conv-aborted-not-thrown",
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
      type: "assistant",
      session_id: "sess-abort",
      uuid: "u1",
      message: { content: [{ type: "text", text: "partial" }] },
    } as unknown as SDKMessage);

    await new Promise((r) => setTimeout(r, 5));

    ac.abort();
    runtime.close();

    const result = await turnPromise;

    expect(result.aborted).toBe(true);
    expect(result.error).toBeNull();
  });
});
