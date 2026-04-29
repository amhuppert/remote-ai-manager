import { describe, it, expect, vi } from "vitest";
import type {
  ConversationBackendRuntime,
  ConversationBackendTurnInput,
  ConversationBackendTurnResult,
  AgentSessionRef,
  PortableMcpConfig,
  McpApplyResult,
} from "@/types";
import type { AskQuestionItem } from "@/lib/schemas";
import { dispatchConversationTurn } from "./agent-call-conversation";
import type { BackendCapabilityView } from "./agent-call-vocabulary";

const CAPABILITY_VIEW: BackendCapabilityView = {
  backend: "claude",
  continuationStrength: "precise_session",
  structuredOutputEnforcement: "post_validation",
  mcpApplicationBoundary: "between_turns",
  contextMetricsAvailable: true,
  nativeMidTurnAskUser: true,
};

interface StubRuntimeOptions {
  result?: Partial<ConversationBackendTurnResult>;
  onSendTurn?(input: ConversationBackendTurnInput): Promise<void> | void;
  applyMcpResult?: McpApplyResult;
}

function makeStubRuntime(opts: StubRuntimeOptions = {}): {
  runtime: ConversationBackendRuntime;
  capturedSendTurnInput: { value: ConversationBackendTurnInput | null };
  capturedMcp: { value: PortableMcpConfig | null };
  sendTurnCalls: { value: number };
} {
  const captured = { value: null as ConversationBackendTurnInput | null };
  const mcp = { value: null as PortableMcpConfig | null };
  const sendTurnCalls = { value: 0 };

  const baseResult: ConversationBackendTurnResult = {
    backendRef: { backend: "claude", sessionId: "sess-1" } as AgentSessionRef,
    costUsd: 0.01,
    durationMs: 1234,
    numTurns: 1,
    contextTokens: 5000,
    contextWindowMax: 200_000,
    contentBlocks: [],
    structuredOutput: undefined,
    aborted: false,
    error: null,
  };

  const runtime: ConversationBackendRuntime = {
    backend: "claude",
    status: "alive",
    capabilities: {
      queueWhileRunning: true,
      askUserQuestion: true,
      preciseFork: true,
      portableMcpAtStart: true,
      portableMcpBetweenTurns: true,
      contextWindowMetrics: true,
    },
    modelId: undefined,
    reasoningEffort: undefined,
    outputFormat: undefined,
    async sendTurn(input) {
      sendTurnCalls.value += 1;
      captured.value = input;
      if (opts.onSendTurn) await opts.onSendTurn(input);
      return { ...baseResult, ...(opts.result ?? {}) };
    },
    async applyPortableMcpConfig(config) {
      mcp.value = config;
      return (
        opts.applyMcpResult ?? {
          disposition: "applied_now",
          droppedServerIds: [],
          droppedFields: [],
          errors: {},
        }
      );
    },
    close() {},
  };

  return {
    runtime,
    capturedSendTurnInput: captured,
    capturedMcp: mcp,
    sendTurnCalls,
  };
}

describe("dispatchConversationTurn", () => {
  it("rejects non-conversation_turn requests", async () => {
    const { runtime } = makeStubRuntime();
    await expect(() =>
      dispatchConversationTurn(
        {
          kind: "task_run",
          backend: "claude",
          prompt: "hi",
        },
        {
          runtime,
          capabilityView: CAPABILITY_VIEW,
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow(/conversation_turn/i);
  });

  it("dispatches the prompt through runtime.sendTurn and returns a normalized completed result", async () => {
    const { runtime, capturedSendTurnInput } = makeStubRuntime({
      result: { contentBlocks: [{ type: "text", text: "hello back" }] },
    });

    const result = await dispatchConversationTurn(
      {
        kind: "conversation_turn",
        prompt: "hello",
      },
      {
        runtime,
        capabilityView: CAPABILITY_VIEW,
        signal: new AbortController().signal,
      },
    );

    expect(capturedSendTurnInput.value?.promptText).toBe("hello");
    expect(result.backend).toBe("claude");
    expect(result.backendRef).toEqual({
      backend: "claude",
      sessionId: "sess-1",
    });
    expect(result.outcome.kind).toBe("completed");
    expect(result.usage.contextTokens).toBe(5000);
    expect(result.usage.contextWindowMax).toBe(200_000);
    expect(result.capabilities).toEqual(CAPABILITY_VIEW);
  });

  it("forwards the request output schema as the runtime outputFormat", async () => {
    const { runtime, capturedSendTurnInput } = makeStubRuntime({
      result: { structuredOutput: { ok: true } },
    });

    const result = await dispatchConversationTurn(
      {
        kind: "conversation_turn",
        prompt: "hi",
        outputSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
        },
      },
      {
        runtime,
        capabilityView: CAPABILITY_VIEW,
        signal: new AbortController().signal,
      },
    );

    expect(capturedSendTurnInput.value?.outputFormat).toEqual({
      type: "json_schema",
      schema: { type: "object", properties: { ok: { type: "boolean" } } },
    });
    if (result.outcome.kind === "completed") {
      expect(result.outcome.structuredOutput).toEqual({ ok: true });
    } else {
      throw new Error("Expected completed outcome");
    }
  });

  it("applies workflow tooling before sending the turn when the runtime supports it", async () => {
    const { runtime, capturedMcp, sendTurnCalls } = makeStubRuntime();
    const callOrder: string[] = [];

    const wrapped: ConversationBackendRuntime = {
      ...runtime,
      async applyPortableMcpConfig(config) {
        callOrder.push("apply");
        return (
          (await runtime.applyPortableMcpConfig?.(config)) ?? {
            disposition: "applied_now",
            droppedServerIds: [],
            droppedFields: [],
            errors: {},
          }
        );
      },
      async sendTurn(input) {
        callOrder.push("send");
        return runtime.sendTurn(input);
      },
    };

    const tooling: PortableMcpConfig = {
      servers: [{ id: "s1", transport: "stdio", command: "echo" }],
    };

    await dispatchConversationTurn(
      {
        kind: "conversation_turn",
        prompt: "hi",
        tooling,
      },
      {
        runtime: wrapped,
        capabilityView: CAPABILITY_VIEW,
        signal: new AbortController().signal,
      },
    );

    expect(callOrder).toEqual(["apply", "send"]);
    expect(capturedMcp.value).toEqual(tooling);
    expect(sendTurnCalls.value).toBe(1);
  });

  it("returns capability_unavailable when tooling is requested but the runtime cannot apply MCP", async () => {
    const { runtime } = makeStubRuntime();
    const noMcpRuntime: ConversationBackendRuntime = {
      ...runtime,
      applyPortableMcpConfig: undefined,
    };

    const result = await dispatchConversationTurn(
      {
        kind: "conversation_turn",
        prompt: "hi",
        tooling: { servers: [] },
      },
      {
        runtime: noMcpRuntime,
        capabilityView: {
          ...CAPABILITY_VIEW,
          mcpApplicationBoundary: "unsupported",
        },
        signal: new AbortController().signal,
      },
    );

    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind === "failed") {
      expect(result.outcome.error.failureKind).toBe("capability_unavailable");
      expect(result.outcome.error.backend).toBe("claude");
    }
  });

  it("surfaces a mid_turn paused result when the backend asks the user a question and no answerer is provided", async () => {
    const captured: AskQuestionItem[] = [
      {
        question: "Approve?",
        options: [{ label: "Yes" }],
        multiSelect: false,
      },
    ];

    const { runtime } = makeStubRuntime({
      onSendTurn: async (input) => {
        if (input.onAskQuestion) {
          await input.onAskQuestion(captured);
        }
      },
    });

    const result = await dispatchConversationTurn(
      {
        kind: "conversation_turn",
        prompt: "should we?",
      },
      {
        runtime,
        capabilityView: CAPABILITY_VIEW,
        signal: new AbortController().signal,
      },
    );

    expect(result.outcome.kind).toBe("paused");
    if (result.outcome.kind === "paused") {
      expect(result.outcome.pauseKind).toBe("mid_turn");
      expect(result.outcome.resumeToken).toMatch(/.+/);
      expect(result.outcome.details).toMatchObject({
        questions: captured,
      });
    }
    expect(result.backend).toBe("claude");
  });

  it("forwards inline ask-user answers to the runtime when an answerer is supplied", async () => {
    const captured: AskQuestionItem[] = [
      {
        question: "Pick one",
        options: [{ label: "A" }, { label: "B" }],
        multiSelect: false,
      },
    ];

    let runtimeAnswers: Record<string, string> | null = null;
    const { runtime } = makeStubRuntime({
      onSendTurn: async (input) => {
        if (input.onAskQuestion) {
          runtimeAnswers = await input.onAskQuestion(captured);
        }
      },
    });

    const answerSpy = vi.fn(async () => ({ "Pick one": "a" }));

    const result = await dispatchConversationTurn(
      {
        kind: "conversation_turn",
        prompt: "go",
      },
      {
        runtime,
        capabilityView: CAPABILITY_VIEW,
        signal: new AbortController().signal,
        answerAskUser: answerSpy,
      },
    );

    expect(answerSpy).toHaveBeenCalledOnce();
    expect(runtimeAnswers).toEqual({ "Pick one": "a" });
    expect(result.outcome.kind).toBe("completed");
  });

  it("normalizes a backend error result while preserving backend identity", async () => {
    const { runtime } = makeStubRuntime({
      result: { error: "stream closed", aborted: false, backendRef: null },
    });

    const result = await dispatchConversationTurn(
      {
        kind: "conversation_turn",
        prompt: "hi",
      },
      {
        runtime,
        capabilityView: CAPABILITY_VIEW,
        signal: new AbortController().signal,
      },
    );

    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind === "failed") {
      expect(result.outcome.error.failureKind).toBe("backend_error");
      expect(result.outcome.error.backend).toBe("claude");
      expect(result.outcome.error.message).toContain("stream closed");
    }
  });

  it("normalizes an aborted result as the aborted failure kind", async () => {
    const { runtime } = makeStubRuntime({
      result: { error: null, aborted: true, backendRef: null },
    });

    const result = await dispatchConversationTurn(
      {
        kind: "conversation_turn",
        prompt: "hi",
      },
      {
        runtime,
        capabilityView: CAPABILITY_VIEW,
        signal: new AbortController().signal,
      },
    );

    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind === "failed") {
      expect(result.outcome.error.failureKind).toBe("aborted");
      expect(result.outcome.error.backend).toBe("claude");
    }
  });

  it("normalizes thrown sendTurn errors and preserves backend identity", async () => {
    const runtime: ConversationBackendRuntime = {
      backend: "claude",
      status: "alive",
      capabilities: {
        queueWhileRunning: true,
        askUserQuestion: true,
        preciseFork: true,
        portableMcpAtStart: true,
        portableMcpBetweenTurns: true,
        contextWindowMetrics: true,
      },
      modelId: undefined,
      reasoningEffort: undefined,
      outputFormat: undefined,
      async sendTurn() {
        throw new Error("network down");
      },
      close() {},
    };

    const result = await dispatchConversationTurn(
      {
        kind: "conversation_turn",
        prompt: "hi",
      },
      {
        runtime,
        capabilityView: CAPABILITY_VIEW,
        signal: new AbortController().signal,
      },
    );

    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind === "failed") {
      expect(result.outcome.error.failureKind).toBe("backend_error");
      expect(result.outcome.error.backend).toBe("claude");
      expect(result.outcome.error.message).toContain("network down");
    }
  });

  it("emits the shared structured log field set including artifactKinds and outcome", async () => {
    const debug = vi.fn();
    const stubLogger = {
      debug,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const { runtime } = makeStubRuntime({
      result: { contentBlocks: [{ type: "text", text: "ok" }] },
    });

    await dispatchConversationTurn(
      {
        kind: "conversation_turn",
        prompt: "hi",
        laneRef: { workflowId: "wf-1", laneId: "lane-A" },
      },
      {
        runtime,
        capabilityView: CAPABILITY_VIEW,
        signal: new AbortController().signal,
        artifacts: [
          { kind: "design_doc", relativePath: "memory-bank/design.md" },
          { kind: "transcript", relativePath: "memory-bank/transcript.md" },
        ],
        logger: stubLogger,
      },
    );

    expect(debug).toHaveBeenCalledWith(
      "agent_call.conversation.dispatch_start",
      expect.objectContaining({
        requestKind: "conversation_turn",
        backend: "claude",
        workflowId: "wf-1",
        laneId: "lane-A",
        artifactKinds: ["design_doc", "transcript"],
      }),
    );
    expect(debug).toHaveBeenCalledWith(
      "agent_call.conversation.dispatch_complete",
      expect.objectContaining({
        outcome: "completed",
        artifactKinds: ["design_doc", "transcript"],
      }),
    );
  });

  it("emits a normalized outcome log when the runtime returns an aborted result", async () => {
    const warn = vi.fn();
    const stubLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
    };
    const { runtime } = makeStubRuntime({
      result: { error: null, aborted: true, backendRef: null },
    });

    await dispatchConversationTurn(
      {
        kind: "conversation_turn",
        prompt: "hi",
        laneRef: { workflowId: "wf-1", laneId: "lane-X" },
      },
      {
        runtime,
        capabilityView: CAPABILITY_VIEW,
        signal: new AbortController().signal,
        artifacts: [{ kind: "design_doc", relativePath: "memory-bank/x.md" }],
        logger: stubLogger,
      },
    );

    expect(warn).toHaveBeenCalledWith(
      "agent_call.conversation.aborted",
      expect.objectContaining({
        requestKind: "conversation_turn",
        backend: "claude",
        workflowId: "wf-1",
        laneId: "lane-X",
        outcome: "failed",
        artifactKinds: ["design_doc"],
      }),
    );
  });

  it("emits a normalized outcome log when the runtime returns a backend error result", async () => {
    const warn = vi.fn();
    const stubLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
    };
    const { runtime } = makeStubRuntime({
      result: { error: "stream closed", aborted: false, backendRef: null },
    });

    await dispatchConversationTurn(
      {
        kind: "conversation_turn",
        prompt: "hi",
        laneRef: { workflowId: "wf-1", laneId: "lane-Y" },
      },
      {
        runtime,
        capabilityView: CAPABILITY_VIEW,
        signal: new AbortController().signal,
        artifacts: [{ kind: "transcript", relativePath: "memory-bank/y.md" }],
        logger: stubLogger,
      },
    );

    expect(warn).toHaveBeenCalledWith(
      "agent_call.conversation.runtime_error",
      expect.objectContaining({
        requestKind: "conversation_turn",
        backend: "claude",
        workflowId: "wf-1",
        laneId: "lane-Y",
        outcome: "failed",
        artifactKinds: ["transcript"],
      }),
    );
  });

  it("emits the shared structured log field set on tooling-unavailable failures", async () => {
    const warn = vi.fn();
    const stubLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
    };
    const { runtime } = makeStubRuntime();
    const noMcpRuntime: ConversationBackendRuntime = {
      ...runtime,
      applyPortableMcpConfig: undefined,
    };

    await dispatchConversationTurn(
      {
        kind: "conversation_turn",
        prompt: "hi",
        laneRef: { workflowId: "wf-1", laneId: "lane-B" },
        tooling: { servers: [] },
      },
      {
        runtime: noMcpRuntime,
        capabilityView: {
          ...CAPABILITY_VIEW,
          mcpApplicationBoundary: "unsupported",
        },
        signal: new AbortController().signal,
        artifacts: [{ kind: "design_doc", relativePath: "memory-bank/x.md" }],
        logger: stubLogger,
      },
    );

    expect(warn).toHaveBeenCalledWith(
      "agent_call.conversation.tooling_unavailable",
      expect.objectContaining({
        requestKind: "conversation_turn",
        backend: "claude",
        workflowId: "wf-1",
        laneId: "lane-B",
        outcome: "failed",
        artifactKinds: ["design_doc"],
      }),
    );
  });
});
