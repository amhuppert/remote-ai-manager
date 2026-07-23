import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

const queryMock = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
}));

vi.mock("@/lib/shared/sdk-env", () => ({}));

import {
  claudeConversationBackendFactory,
  resolveIdleTtlMs,
} from "./conversation-runtime";
import { CLAUDE_AGENT_SUPPRESSION_STRATEGY } from "./runtime-config/agent-suppression";
import type {
  ConversationBackendEvent,
  ConversationBackendRuntime,
} from "../conversation";
import { renderStructuredOutputInstruction } from "../structured-output-prompt";
import type { ClaudeCapabilityApplyTarget } from "./runtime-config/adapter";
import { isUndeliveredQuerySessionError } from "./query-session-errors";

const createRuntimeWithFakeDeps: typeof claudeConversationBackendFactory.createRuntime =
  (input) => claudeConversationBackendFactory.createRuntime(input);

function createControllableMockQuery() {
  const messages: SDKMessage[] = [];
  let resolveNext: ((value: IteratorResult<SDKMessage, void>) => void) | null =
    null;
  let rejectNext: ((error: Error) => void) | null = null;
  let done = false;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const generator: any = {
    close: vi.fn(() => {
      done = true;
      if (resolveNext) {
        resolveNext({ value: undefined, done: true });
        resolveNext = null;
        rejectNext = null;
      }
    }),
    streamInput: vi.fn(),
    interrupt: vi.fn(),
    supportedCommands: vi.fn().mockResolvedValue([]),
    supportedAgents: vi.fn().mockResolvedValue([]),
    mcpServerStatus: vi.fn().mockResolvedValue([]),
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
      return new Promise<IteratorResult<SDKMessage, void>>(
        (resolve, reject) => {
          resolveNext = resolve;
          rejectNext = reject;
        },
      );
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
        rejectNext = null;
        r({ value: msg, done: false });
      } else {
        messages.push(msg);
      }
    },
    /** End the message pump normally (clean subprocess exit) */
    endPump() {
      done = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        rejectNext = null;
        r({ value: undefined, done: true });
      }
    },
    failPump(error: Error) {
      done = true;
      if (rejectNext) {
        const reject = rejectNext;
        resolveNext = null;
        rejectNext = null;
        reject(error);
      }
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveIdleTtlMs", () => {
  it("returns undefined for interactive conversations so QuerySession keeps its default", () => {
    expect(resolveIdleTtlMs(undefined)).toBeUndefined();
  });

  it("returns the 60-minute workflow-lane TTL when a workflow execution id is present", () => {
    expect(resolveIdleTtlMs("exec-1")).toBe(60 * 60 * 1000);
  });
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

  it("renders the stored full schema into each turn without using SDK outputFormat", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const schema = {
      type: "object",
      properties: {
        summary: { type: "string", minLength: 1 },
        refs: { type: "array", minItems: 1, items: { type: "string" } },
      },
      required: ["summary", "refs"],
      additionalProperties: false,
    };
    const outputFormat = {
      type: "json_schema" as const,
      schema,
    };
    const runtime = await createRuntimeWithFakeDeps({
      conversationId: "conv-projection",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {},
      outputFormat,
    });

    const callArg = queryMock.mock.calls[0]![0]! as {
      prompt: AsyncGenerator<SDKUserMessage>;
      options: { outputFormat?: unknown };
    };
    expect(callArg.options).not.toHaveProperty("outputFormat");
    expect(runtime.outputFormat).toBe(outputFormat);

    const turnPromise = runtime.sendTurn({
      promptText: "Format the result",
      imageRefs: [],
      sessionInstructions: [],
      autonomous: false,
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    const delivered = await callArg.prompt.next();
    expect(delivered.value!.message.content).toEqual([
      {
        type: "text",
        text: `Format the result\n\n${renderStructuredOutputInstruction(schema)}`,
      },
    ]);

    mock.pushMessage({
      type: "assistant",
      session_id: "sess-structured",
      uuid: "assistant-intermediate",
      message: {
        content: [
          {
            type: "text",
            text: "I will now format the inspected result.",
          },
        ],
      },
    } as unknown as SDKMessage);
    mock.pushMessage({
      type: "assistant",
      session_id: "sess-structured",
      uuid: "assistant-structured",
      message: {
        content: [
          {
            type: "text",
            text: '{"summary":"done","refs":["src/file.ts"]}',
          },
        ],
      },
    } as unknown as SDKMessage);
    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-structured",
      uuid: "result-structured",
      total_cost_usd: 0.01,
      duration_ms: 10,
      num_turns: 1,
      result: '{"summary":"done","refs":["src/file.ts"]}',
      is_error: false,
    } as unknown as SDKMessage);

    const result = await turnPromise;
    expect(result.structuredOutput).toBeUndefined();
    expect(result.finalText).toBe('{"summary":"done","refs":["src/file.ts"]}');

    runtime.close();
  });

  it("does not append a duplicate schema contract when a repair prompt already contains it", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);
    const schema = {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
    };
    const instruction = renderStructuredOutputInstruction(schema);
    const promptText = `Correct the prior response.\n\n${instruction}\n\nReturn only the corrected JSON object.`;
    const runtime = await createRuntimeWithFakeDeps({
      conversationId: "conv-structured-repair",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {},
      outputFormat: { type: "json_schema", schema },
    });
    const channel: AsyncGenerator<SDKUserMessage> =
      queryMock.mock.calls[0]![0].prompt;

    const turnPromise = runtime.sendTurn({
      promptText,
      imageRefs: [],
      sessionInstructions: [],
      autonomous: false,
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    const delivered = await channel.next();
    expect(delivered.value!.message.content).toEqual([
      { type: "text", text: promptText },
    ]);

    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-structured-repair",
      uuid: "result-structured-repair",
      total_cost_usd: 0,
      duration_ms: 1,
      num_turns: 1,
      result: '{"summary":"done"}',
      is_error: false,
    } as unknown as SDKMessage);
    await turnPromise;
    runtime.close();
  });

  it("keeps the rendered schema contract after strip-only image blocks", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);
    const schema = {
      type: "object",
      properties: { summary: { type: "string", minLength: 1 } },
      required: ["summary"],
    };
    const runtime = await createRuntimeWithFakeDeps({
      conversationId: "conv-structured-image",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {},
      outputFormat: { type: "json_schema", schema },
    });
    const channel: AsyncGenerator<SDKUserMessage> =
      queryMock.mock.calls[0]![0].prompt;

    const turnPromise = runtime.sendTurn({
      promptText: "Inspect the attachment",
      imageRefs: [
        {
          index: 1,
          path: "/project/screenshot.png",
          mediaType: "image/png",
          base64Data: "IMAGE",
        },
      ],
      sessionInstructions: [],
      autonomous: false,
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    const delivered = await channel.next();
    const content = delivered.value!.message.content;
    expect(Array.isArray(content)).toBe(true);
    expect(content.at(-1)).toEqual({
      type: "text",
      text: renderStructuredOutputInstruction(schema),
    });

    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-structured-image",
      uuid: "result-structured-image",
      total_cost_usd: 0,
      duration_ms: 1,
      num_turns: 1,
      result: "",
      is_error: false,
    } as unknown as SDKMessage);
    await turnPromise;
    runtime.close();
  });

  it("leaves turn prompts unchanged when the runtime has no output schema", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);
    const runtime = await createRuntimeWithFakeDeps({
      conversationId: "conv-unstructured",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {},
    });
    const channel: AsyncGenerator<SDKUserMessage> =
      queryMock.mock.calls[0]![0].prompt;

    const turnPromise = runtime.sendTurn({
      promptText: "Unchanged conversation prompt",
      imageRefs: [],
      sessionInstructions: [],
      autonomous: false,
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    const delivered = await channel.next();
    expect(delivered.value!.message.content).toEqual([
      { type: "text", text: "Unchanged conversation prompt" },
    ]);

    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-unstructured",
      uuid: "result-unstructured",
      total_cost_usd: 0,
      duration_ms: 1,
      num_turns: 1,
      result: "",
      is_error: false,
    } as unknown as SDKMessage);
    await turnPromise;
    runtime.close();
  });
});

describe("ClaudeConversationRuntime — alignment version metadata", () => {
  it("reports the alignment version baked in at creation", async () => {
    queryMock.mockReturnValue(createControllableMockQuery().query);
    const runtime = await createRuntimeWithFakeDeps({
      conversationId: "conv-av",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {},
      alignmentVersion: 4,
    });
    expect(runtime.alignmentVersion).toBe(4);
    runtime.close();
  });

  it("defaults the alignment version to null when none is provided", async () => {
    queryMock.mockReturnValue(createControllableMockQuery().query);
    const runtime = await createRuntimeWithFakeDeps({
      conversationId: "conv-av-none",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {},
    });
    expect(runtime.alignmentVersion).toBeNull();
    runtime.close();
  });
});

describe("ClaudeConversationRuntime — external turn events", () => {
  it("emits external_turn_started, interpreted transcript entries, and external_turn_completed for a virtual turn", async () => {
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
    const transcriptEvents = externalEvents.filter(
      (e) => e.type === "transcript_entry",
    );

    expect(startedIdx).toBeGreaterThanOrEqual(0);
    expect(completedIdx).toBeGreaterThan(startedIdx);
    // user tool-notification + assistant + result frames at minimum
    expect(transcriptEvents.length).toBeGreaterThanOrEqual(3);

    const completedEvent = externalEvents[completedIdx]!;
    if (completedEvent.type !== "external_turn_completed") {
      throw new Error("expected external_turn_completed");
    }
    expect(completedEvent.result.costUsd).toBe(0.12);
    expect(completedEvent.result.durationMs).toBe(500);
    expect(completedEvent.result.numTurns).toBe(2);
    expect(completedEvent.result.backendRef).toEqual({
      backend: "claude",
      ref: "sess-1",
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

describe("ClaudeConversationRuntime — applyPortableMcpConfig", () => {
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

  it("defers the server-set change to the next runtime but applies the tool filter live", async () => {
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
      tooling: {
        portableMcp: {
          servers: [{ id: "srv", transport: "stdio", command: "node" }],
        },
      },
    });

    const canUseTool = captureCanUseTool();
    expect(await canUseTool("mcp__srv__tool_a", {})).toEqual({
      behavior: "allow",
      updatedInput: {},
    });

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

    // The live SDK server set is fixed at creation, so a changed server list
    // takes effect only on the next runtime; the tool-level filter is live.
    expect(result.disposition).toBe("deferred_to_next_turn");
    expect(await canUseTool("mcp__srv__tool_a", {})).toEqual({
      behavior: "deny",
      message: "Tool disabled by MCP configuration",
      interrupt: false,
    });

    runtime.close();
  });

  it("rejects when every server in the config fails translation", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const runtime = await createRuntimeWithFakeDeps({
      conversationId: "conv-reject",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {},
    });

    // `cwd` is an unsupported field for a Claude stdio server, so the only
    // server in the config is dropped, leaving nothing to apply → rejected.
    const result = await runtime.applyPortableMcpConfig!({
      servers: [
        { id: "broken", transport: "stdio", command: "node", cwd: "/tmp" },
      ],
    });

    expect(result.disposition).toBe("rejected");
    expect(result.droppedServerIds).toContain("broken");

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
        capabilities: {
          backend: "claude",
          kinds: [
            {
              kind: "agents",
              items: [
                {
                  itemId: "code-reviewer",
                  enabled: false,
                  originLayer: "global",
                },
              ],
            },
          ],
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

    const applyTarget = runtime as ConversationBackendRuntime &
      ClaudeCapabilityApplyTarget;
    const result = await applyTarget.applyCapabilityConfig({
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

  it("updates the tool filter live even while a turn is active (server-set deferred, filter live)", async () => {
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
    // The server-set change lands on the next runtime, but the tool-level
    // enable/disable filter is read live — the new deny is in effect at once.
    expect(result.disposition).toBe("deferred_to_next_turn");

    const during = await canUseTool("mcp__srv__tool_a", {});
    expect(during).toEqual({
      behavior: "deny",
      message: "Tool disabled by MCP configuration",
      interrupt: false,
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

    runtime.close();
  });
});

describe("ClaudeConversationRuntime — static external MCP passthrough", () => {
  function captureStaticMcpServers(): Record<string, unknown> {
    const firstCall = queryMock.mock.calls[0]!;
    const arg = firstCall[0] as {
      options: { mcpServers?: Record<string, unknown> };
    };
    return arg.options.mcpServers ?? {};
  }

  it("passes translated external servers (with HTTP tool policies) to the SDK via the static mcpServers option at creation", async () => {
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

    // External servers reach the SDK statically, at creation, with their
    // per-tool policies already translated — no live server-set mutation.
    const mcpServers = captureStaticMcpServers();
    expect(mcpServers).toMatchObject({
      context7: {
        type: "http",
        url: "https://mcp.context7.com/mcp",
        tools: [
          { name: "resolve-library-id", permission_policy: "always_deny" },
        ],
      },
    });
    // No CC in-process server is bound; only the external server is present.
    expect(Object.keys(mcpServers)).toEqual(["context7"]);
  });

  it("passes an empty static mcpServers when the portable config carries no servers", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    await createRuntimeWithFakeDeps({
      conversationId: "conv-init-empty",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {},
    });

    expect(captureStaticMcpServers()).toEqual({});
  });
});

describe("ClaudeConversationRuntime — error result classification", () => {
  it("classifies the typed structured-output retry exhaustion when errors are empty", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const runtime = await createRuntimeWithFakeDeps({
      conversationId: "conv-structured-output-exhausted",
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
      type: "result",
      subtype: "error_max_structured_output_retries",
      session_id: "session-structured-output",
      uuid: "u-structured-output",
      total_cost_usd: 0,
      duration_ms: 1,
      num_turns: 5,
      is_error: true,
      errors: [],
    } as unknown as SDKMessage);

    const result = await turnPromise;

    expect(result.failure?.message).toBe(
      "Agent exceeded structured output retry limit",
    );
    expect(result.failure?.kind).toBe("structured_output_exhausted");
    expect(result.continuationDisposition).toBe("retain");

    runtime.close();
  });

  it("clears a persisted ref when the provider reports that session as stale", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const runtime = await createRuntimeWithFakeDeps({
      conversationId: "conv-stale-resume",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: { backend: "claude", ref: "session-gone" },
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
      type: "result",
      subtype: "error_during_execution",
      session_id: "session-gone",
      uuid: "u-stale",
      total_cost_usd: 0,
      duration_ms: 1,
      num_turns: 0,
      is_error: true,
      errors: ["Session session-gone does not exist"],
    } as unknown as SDKMessage);

    const result = await turnPromise;

    expect(result.failure?.kind).toBe("stale_resume_ref");
    expect(result.continuationDisposition).toBe("clear");
    expect(result.backendRef).toBeNull();

    runtime.close();
  });

  it("returns an explicit clear result when a stale-resume pump rejection is tagged as QuerySession death", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const runtime = await createRuntimeWithFakeDeps({
      conversationId: "conv-stale-pump",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: { backend: "claude", ref: "session-gone" },
      sessionInstructions: [],
      tooling: {},
    });

    const turnPromise = runtime.sendTurn({
      promptText: "continue",
      imageRefs: [],
      sessionInstructions: [],
      autonomous: false,
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    mock.failPump(new Error("Session session-gone does not exist"));

    const result = await turnPromise;

    expect(result.failure?.kind).toBe("stale_resume_ref");
    expect(result.continuationDisposition).toBe("clear");
    expect(result.backendRef).toBeNull();
    runtime.close();
  });

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

    expect(result.failure?.message).toContain("QuerySession closed");
    expect(result.failure?.kind).toBe("session_died");
    expect(result.continuationDisposition).toBe("retain");
    expect(result.backendRef).toEqual({
      backend: "claude",
      ref: "sess-after-init",
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
    expect(result.failure).toBeNull();
    expect(result.backendRef).toEqual({
      backend: "claude",
      ref: "sess-aborted",
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

    // Kill the pump while the second prompt sits undelivered in the input
    // channel — this is what query-session emits when the SDK pipe is gone
    // before delivery (e.g. EPIPE, ProcessTransport closed).
    const turn2 = runtime.sendTurn({
      promptText: "second",
      imageRefs: [],
      sessionInstructions: [],
      autonomous: false,
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    mock.endPump();

    let caughtError: unknown;
    try {
      await turn2;
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
    expect(result.failure).toBeNull();
  });
});

describe("ClaudeConversationRuntime — prepareForTurnStart", () => {
  it("reports ready without any live MCP rebind — external servers are static", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const runtime = await createRuntimeWithFakeDeps({
      conversationId: "conv-prepare",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {},
    });

    // Even across repeated (reused-turn) calls there is no in-process server to
    // rebind, so the runtime is always ready.
    await expect(runtime.prepareForTurnStart!()).resolves.toEqual({
      status: "ready",
    });
    await expect(runtime.prepareForTurnStart!()).resolves.toEqual({
      status: "ready",
    });

    runtime.close();
  });
});

describe("ClaudeConversationRuntime — background-task wait barrier (sendTurn)", () => {
  function pushTaskStarted(
    mock: ReturnType<typeof createControllableMockQuery>,
    taskId: string,
  ) {
    mock.pushMessage({
      type: "system",
      subtype: "task_started",
      task_id: taskId,
      tool_use_id: `tool-${taskId}`,
      description: "running a build",
      session_id: "sess-1",
      uuid: `u-start-${taskId}`,
    } as unknown as SDKMessage);
  }

  function pushTaskNotification(
    mock: ReturnType<typeof createControllableMockQuery>,
    taskId: string,
    status: "completed" | "failed" | "stopped",
  ) {
    mock.pushMessage({
      type: "system",
      subtype: "task_notification",
      task_id: taskId,
      status,
      output_file: "/tmp/out.txt",
      summary: "done",
      session_id: "sess-1",
      uuid: `u-notify-${taskId}`,
    } as unknown as SDKMessage);
  }

  function pushResult(
    mock: ReturnType<typeof createControllableMockQuery>,
    uuid: string,
  ) {
    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      uuid,
      total_cost_usd: 0,
      duration_ms: 0,
      num_turns: 0,
      result: "",
      is_error: false,
    } as unknown as SDKMessage);
  }

  function pushAssistantToolUse(
    mock: ReturnType<typeof createControllableMockQuery>,
    toolUseId: string,
    toolName: string,
  ) {
    mock.pushMessage({
      type: "assistant",
      session_id: "sess-1",
      uuid: `u-asst-${toolUseId}`,
      message: {
        content: [
          { type: "tool_use", id: toolUseId, name: toolName, input: {} },
        ],
      },
    } as unknown as SDKMessage);
  }

  it("holds the turn open until a waitable task settles, then carries the wait summary (3.1, 3.2, 3.3, 3.4)", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const runtime = await createRuntimeWithFakeDeps({
      conversationId: "conv-wait-hold",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {},
    });

    const turnPromise = runtime.sendTurn({
      promptText: "run the build in the background",
      imageRefs: [],
      sessionInstructions: [],
      autonomous: true,
      waitForBackgroundTasks: true,
      signal: new AbortController().signal,
      onEvent: () => {},
    });

    // Agent starts a waitable background task, then yields its caller turn.
    pushTaskStarted(mock, "task-a");
    pushResult(mock, "u-caller-result");

    // The caller turn yielded, but a waitable task is still in flight — the
    // wait barrier must keep sendTurn pending.
    let settled = false;
    void turnPromise.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);

    // The background task settles (arrives as its own virtual turn).
    pushTaskNotification(mock, "task-a", "completed");

    const result = await turnPromise;
    expect(result.backgroundWait).toBeDefined();
    expect(result.backgroundWait!.waitedTaskIds).toEqual(["task-a"]);
    expect(result.backgroundWait!.settledTaskIds).toEqual(["task-a"]);
    expect(result.backgroundWait!.timedOut).toBe(false);
    expect(result.backgroundWait!.durationMs).toBeGreaterThanOrEqual(0);

    runtime.close();
  });

  it("completes immediately with no summary when no waitable tasks are in flight (6.1)", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const runtime = await createRuntimeWithFakeDeps({
      conversationId: "conv-wait-none",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {},
    });

    const turnPromise = runtime.sendTurn({
      promptText: "do something synchronous",
      imageRefs: [],
      sessionInstructions: [],
      autonomous: true,
      waitForBackgroundTasks: true,
      signal: new AbortController().signal,
      onEvent: () => {},
    });

    // Agent yields with no background task ever started.
    pushResult(mock, "u-caller-result");

    const result = await turnPromise;
    expect(result.backgroundWait).toBeUndefined();

    runtime.close();
  });

  it("completes immediately for a Monitor-originated watch and carries no summary (Req 2.2)", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const runtime = await createRuntimeWithFakeDeps({
      conversationId: "conv-wait-monitor",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {},
    });

    const turnPromise = runtime.sendTurn({
      promptText: "watch the dev server",
      imageRefs: [],
      sessionInstructions: [],
      autonomous: true,
      waitForBackgroundTasks: true,
      signal: new AbortController().signal,
      onEvent: () => {},
    });

    // The agent invokes Monitor (long-lived watch), which starts a task, then
    // yields. A Monitor watch is excluded, so the wait barrier must not hold.
    pushAssistantToolUse(mock, "tool-mon", "Monitor");
    mock.pushMessage({
      type: "system",
      subtype: "task_started",
      task_id: "watch-a",
      tool_use_id: "tool-mon",
      description: "watching the dev server",
      session_id: "sess-1",
      uuid: "u-start-watch-a",
    } as unknown as SDKMessage);
    pushResult(mock, "u-caller-result");

    const result = await turnPromise;
    expect(result.backgroundWait).toBeUndefined();

    runtime.close();
  });

  it("does not wait when the flag is unset even with a waitable task in flight (6.2)", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const runtime = await createRuntimeWithFakeDeps({
      conversationId: "conv-wait-flag-off",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {},
    });

    // No waitForBackgroundTasks flag — interactive/default behavior.
    const turnPromise = runtime.sendTurn({
      promptText: "run the build in the background",
      imageRefs: [],
      sessionInstructions: [],
      autonomous: false,
      signal: new AbortController().signal,
      onEvent: () => {},
    });

    pushTaskStarted(mock, "task-a");
    pushResult(mock, "u-caller-result");

    // Even though a waitable task is in flight, the turn must resolve without
    // awaiting settlement because the opt-in flag is off.
    const result = await turnPromise;
    expect(result.backgroundWait).toBeUndefined();

    runtime.close();
  });

  it("resolves with timedOut: true when a waitable task never settles within the bound (4.1, 4.2)", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const runtime = await createRuntimeWithFakeDeps({
      conversationId: "conv-wait-timeout",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {},
    });

    const turnPromise = runtime.sendTurn({
      promptText: "run the build in the background",
      imageRefs: [],
      sessionInstructions: [],
      autonomous: true,
      waitForBackgroundTasks: true,
      backgroundTaskWaitTimeoutMs: 20,
      signal: new AbortController().signal,
      onEvent: () => {},
    });

    pushTaskStarted(mock, "task-a");
    pushResult(mock, "u-caller-result");

    // Never settle the task — only the short timeout can end this wait.
    const result = await turnPromise;
    expect(result.backgroundWait).toBeDefined();
    expect(result.backgroundWait!.timedOut).toBe(true);
    expect(result.backgroundWait!.waitedTaskIds).toEqual(["task-a"]);
    expect(result.backgroundWait!.settledTaskIds).toEqual([]);

    runtime.close();
  });
});

describe("ClaudeConversationRuntime — compaction pass-through (sendTurn)", () => {
  function pushResult(
    mock: ReturnType<typeof createControllableMockQuery>,
    uuid: string,
  ) {
    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-compact",
      uuid,
      total_cost_usd: 0,
      duration_ms: 0,
      num_turns: 0,
      result: "",
      is_error: false,
    } as unknown as SDKMessage);
  }

  it("carries compacted=true onto the turn result when the SDK auto-compacts mid-turn", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const runtime = await createRuntimeWithFakeDeps({
      conversationId: "conv-compact",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {},
    });

    const turnPromise = runtime.sendTurn({
      promptText: "do a lot of work",
      imageRefs: [],
      sessionInstructions: [],
      autonomous: true,
      signal: new AbortController().signal,
      onEvent: () => {},
    });

    mock.pushMessage({
      type: "system",
      subtype: "compact_boundary",
      session_id: "sess-compact",
      uuid: "u-compact",
      compact_metadata: {
        trigger: "auto",
        pre_tokens: 150_000,
        post_tokens: 40_000,
      },
    } as unknown as SDKMessage);
    pushResult(mock, "u-result");

    const result = await turnPromise;
    expect(result.compacted).toBe(true);

    runtime.close();
  });

  it("reports compacted=false on the turn result when no compaction occurred", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const runtime = await createRuntimeWithFakeDeps({
      conversationId: "conv-no-compact",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {},
    });

    const turnPromise = runtime.sendTurn({
      promptText: "do a small amount of work",
      imageRefs: [],
      sessionInstructions: [],
      autonomous: true,
      signal: new AbortController().signal,
      onEvent: () => {},
    });

    pushResult(mock, "u-result");

    const result = await turnPromise;
    expect(result.compacted).toBe(false);

    runtime.close();
  });
});

describe("ClaudeConversationRuntime — sendTurn input acceptance", () => {
  it("emits input_accepted on the first raw message, before the first transcript entry and any content", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const runtime = await createRuntimeWithFakeDeps({
      conversationId: "conv-accept-order",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {},
    });

    const eventTypes: ConversationBackendEvent["type"][] = [];

    const turnPromise = runtime.sendTurn({
      promptText: "hello",
      imageRefs: [],
      sessionInstructions: [],
      autonomous: false,
      signal: new AbortController().signal,
      onEvent: (event: ConversationBackendEvent) => {
        eventTypes.push(event.type);
      },
    });

    mock.pushMessage({
      type: "assistant",
      session_id: "sess-1",
      uuid: "u-asst",
      message: { content: [{ type: "text", text: "answer" }] },
    } as unknown as SDKMessage);

    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      uuid: "u-result",
      total_cost_usd: 0,
      duration_ms: 0,
      num_turns: 1,
      result: "answer",
      is_error: false,
    } as unknown as SDKMessage);

    await turnPromise;

    const acceptedIdx = eventTypes.indexOf("input_accepted");
    const firstTranscriptIdx = eventTypes.indexOf("transcript_entry");
    const firstContentIdx = eventTypes.indexOf("content");

    expect(acceptedIdx).toBeGreaterThanOrEqual(0);
    expect(firstTranscriptIdx).toBeGreaterThanOrEqual(0);
    expect(acceptedIdx).toBeLessThan(firstTranscriptIdx);
    expect(firstContentIdx).toBeGreaterThan(acceptedIdx);

    runtime.close();
  });

  it("emits input_accepted exactly once even when many raw messages arrive", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const runtime = await createRuntimeWithFakeDeps({
      conversationId: "conv-accept-once",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {},
    });

    const acceptedEvents: ConversationBackendEvent[] = [];

    const turnPromise = runtime.sendTurn({
      promptText: "hello",
      imageRefs: [],
      sessionInstructions: [],
      autonomous: false,
      signal: new AbortController().signal,
      onEvent: (event: ConversationBackendEvent) => {
        if (event.type === "input_accepted") acceptedEvents.push(event);
      },
    });

    mock.pushMessage({
      type: "system",
      subtype: "init",
      session_id: "sess-1",
      uuid: "u-init",
      tools: [],
      mcp_servers: [],
      model: "claude",
    } as unknown as SDKMessage);
    mock.pushMessage({
      type: "assistant",
      session_id: "sess-1",
      uuid: "u-asst-1",
      message: { content: [{ type: "text", text: "first" }] },
    } as unknown as SDKMessage);
    mock.pushMessage({
      type: "assistant",
      session_id: "sess-1",
      uuid: "u-asst-2",
      message: { content: [{ type: "text", text: "second" }] },
    } as unknown as SDKMessage);
    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      uuid: "u-result",
      total_cost_usd: 0,
      duration_ms: 0,
      num_turns: 1,
      result: "second",
      is_error: false,
    } as unknown as SDKMessage);

    await turnPromise;

    expect(acceptedEvents).toHaveLength(1);

    runtime.close();
  });

  it("does not emit input_accepted when dispatch fails before any raw message", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const runtime = await createRuntimeWithFakeDeps({
      conversationId: "conv-accept-dispatch-fail",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {},
    });

    // Complete a first turn so the session moves past first-prompt state.
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

    // The second turn's prompt dies undelivered in the input channel: the
    // pump ends before any raw message arrives.
    const acceptedEvents: ConversationBackendEvent[] = [];

    const turn2 = runtime.sendTurn({
      promptText: "second",
      imageRefs: [],
      sessionInstructions: [],
      autonomous: false,
      signal: new AbortController().signal,
      onEvent: (event: ConversationBackendEvent) => {
        if (event.type === "input_accepted") acceptedEvents.push(event);
      },
    });
    mock.endPump();

    try {
      await turn2;
    } catch {
      // The retryable dispatch error is re-thrown; acceptance must not fire.
    }

    expect(acceptedEvents).toHaveLength(0);

    runtime.close();
  });
});

describe("ClaudeConversationRuntime — sendTurn awaits event handler drain", () => {
  it("resolves sendTurn only after slow transcript-append handlers settle, in emission order", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const runtime = await createRuntimeWithFakeDeps({
      conversationId: "conv-drain",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {},
    });

    const handled: ConversationBackendEvent["type"][] = [];
    let releaseAppends!: () => void;
    const appendGate = new Promise<void>((r) => {
      releaseAppends = r;
    });

    const turnPromise = runtime.sendTurn({
      promptText: "hello",
      imageRefs: [],
      sessionInstructions: [],
      autonomous: false,
      signal: new AbortController().signal,
      onEvent: async (event: ConversationBackendEvent) => {
        if (event.type === "transcript_entry") {
          await appendGate;
        }
        handled.push(event.type);
      },
    });
    let turnResolved = false;
    void turnPromise.then(() => {
      turnResolved = true;
    });

    mock.pushMessage({
      type: "assistant",
      session_id: "sess-1",
      uuid: "u-asst",
      message: { content: [{ type: "text", text: "answer" }] },
    } as unknown as SDKMessage);
    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      uuid: "u-result",
      total_cost_usd: 0,
      duration_ms: 0,
      num_turns: 1,
      result: "answer",
      is_error: false,
    } as unknown as SDKMessage);

    await new Promise((r) => setTimeout(r, 10));
    expect(turnResolved).toBe(false);

    releaseAppends();
    const result = await turnPromise;

    expect(result.aborted).toBe(false);
    // Queued-user acceptance settles before the first assistant frame handler.
    expect(handled.indexOf("input_accepted")).toBeGreaterThanOrEqual(0);
    expect(handled.indexOf("input_accepted")).toBeLessThan(
      handled.indexOf("transcript_entry"),
    );
    // Post-turn events flow through the same ordered chain and are drained
    // before sendTurn resolves.
    expect(handled).toContain("backend_init");

    runtime.close();
  });
});

describe("ClaudeConversationRuntime — queueUserInput live acceptance", () => {
  const textBlock = { type: "text" as const, text: "queued follow-up" };

  it("resolves queueUserInput only after the SDK consumes the input (the observable)", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const runtime = await createRuntimeWithFakeDeps({
      conversationId: "conv-queue-pending",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {},
    });

    // The persistent input channel handed to the SDK at session creation —
    // the test plays the SDK's role of consuming it.
    const channel: AsyncGenerator<SDKUserMessage> =
      queryMock.mock.calls[0]![0].prompt;

    let resolved = false;
    const queuePromise = runtime.queueUserInput!({ content: [textBlock] }).then(
      () => {
        resolved = true;
      },
    );

    // Give the microtask queue a chance to settle: queueUserInput must still
    // be pending because the input has not been consumed from the channel.
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);

    // Acceptance: the message is consumed and the consumer requests the next
    // one (the stdin write completed), so queueUserInput must now resolve.
    const delivered = await channel.next();
    expect(delivered.value!.message.content).toEqual([textBlock]);
    const pending = channel.next();
    await queuePromise;
    expect(resolved).toBe(true);

    void pending;
    runtime.close();
  });

  it("rejects without delivering into the channel when the runtime is dead", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const runtime = await createRuntimeWithFakeDeps({
      conversationId: "conv-queue-dead",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {},
    });

    runtime.close();
    expect(runtime.status).toBe("dead");

    await expect(
      runtime.queueUserInput!({ content: [textBlock] }),
    ).rejects.toThrow();
  });

  it("propagates a tagged rejection when the session dies before consuming the input", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const runtime = await createRuntimeWithFakeDeps({
      conversationId: "conv-queue-reject",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {},
    });

    // The input is accepted into the channel but the subprocess dies before
    // consuming it — the caller must see a tagged rejection so it can leave
    // the queue row pending.
    const queuePromise = runtime.queueUserInput!({ content: [textBlock] });
    mock.endPump();

    let caught: unknown;
    try {
      await queuePromise;
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(isUndeliveredQuerySessionError(caught)).toBe(true);

    runtime.close();
  });
});
