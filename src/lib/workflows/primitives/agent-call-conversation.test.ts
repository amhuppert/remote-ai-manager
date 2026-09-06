import { describe, it, expect, vi } from "vitest";
import type {
  ConversationBackendRuntime,
  ConversationBackendTurnInput,
  ConversationBackendTurnResult,
} from "@/lib/agent-backends/conversation";
import type {
  PortableMcpConfig,
  McpApplyResult,
} from "@/lib/agent-backends/portable-mcp";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import {
  dispatchConversationTurn as dispatchConversationTurnPrimitive,
  type DispatchConversationTurnDeps,
} from "./agent-call-conversation";
import type {
  AgentCallRequest,
  BackendCapabilityView,
} from "./agent-call-vocabulary";

const CAPABILITY_VIEW: BackendCapabilityView = {
  backend: "claude",
  continuationStrength: "precise_session",
  structuredOutputEnforcement: "post_validation",
  mcpApplicationBoundary: "between_turns",
  contextMetricsAvailable: true,
  nativeMidTurnAskUser: true,
};

const CLAUDE_SELECTION: BackendModelSelection = {
  modelId: "sonnet",
  parameters: { effort: "high" },
};

type TestDispatchConversationTurnDeps = Omit<
  DispatchConversationTurnDeps,
  "modelSelection"
> & {
  modelSelection?: BackendModelSelection;
};

function dispatchConversationTurn(
  request: AgentCallRequest,
  deps: TestDispatchConversationTurnDeps,
) {
  return dispatchConversationTurnPrimitive(request, {
    ...deps,
    modelSelection: deps.modelSelection ?? CLAUDE_SELECTION,
  });
}

interface StubRuntimeOptions {
  result?: Partial<ConversationBackendTurnResult>;
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
    backendRef: { backend: "claude", ref: "sess-1" } as AgentSessionRef,
    costUsd: 0.01,
    durationMs: 1234,
    numTurns: 1,
    contextTokens: 5000,
    contextWindowMax: 200_000,
    contentBlocks: [],
    structuredOutput: undefined,
    aborted: false,
    compacted: false,
    failure: null,
    continuationDisposition: "retain",
  };

  const runtime: ConversationBackendRuntime = {
    backend: "claude",
    status: "alive",
    modelSelection: CLAUDE_SELECTION,
    outputFormat: undefined,
    alignmentVersion: null,
    async sendTurn(input) {
      sendTurnCalls.value += 1;
      captured.value = input;
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
    async close() {},
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
          executionClass: "nongoverned-task" as const,
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
        executionClass: "ordinary-conversation" as const,
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
      ref: "sess-1",
    });
    expect(result.outcome.kind).toBe("completed");
    expect(result.usage.contextTokens).toBe(5000);
    expect(result.usage.contextWindowMax).toBe(200_000);
    expect(result.capabilities).toEqual(CAPABILITY_VIEW);
  });

  it("forwards one complete atomic model selection to the runtime", async () => {
    const { runtime, capturedSendTurnInput } = makeStubRuntime();
    const selection: BackendModelSelection = {
      modelId: "sonnet",
      parameters: { effort: "medium", context: "long" },
    };

    await dispatchConversationTurn(
      {
        executionClass: "ordinary-conversation" as const,
        kind: "conversation_turn",
        prompt: "hello",
      },
      {
        runtime,
        capabilityView: CAPABILITY_VIEW,
        signal: new AbortController().signal,
        modelSelection: selection,
      },
    );

    expect(capturedSendTurnInput.value?.modelSelection).toEqual(selection);
  });

  it("forwards the request output schema as the runtime outputFormat", async () => {
    const { runtime, capturedSendTurnInput } = makeStubRuntime({
      result: { structuredOutput: { ok: true } },
    });

    const result = await dispatchConversationTurn(
      {
        executionClass: "ordinary-conversation" as const,
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
        executionClass: "ordinary-conversation" as const,
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
        executionClass: "ordinary-conversation" as const,
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

  it("normalizes a backend error result while preserving backend identity", async () => {
    const { runtime } = makeStubRuntime({
      result: {
        failure: {
          kind: "backend_error",
          message: "stream closed",
          retryable: false,
        },
        aborted: false,
        backendRef: null,
      },
    });

    const result = await dispatchConversationTurn(
      {
        executionClass: "ordinary-conversation" as const,
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
      result: { failure: null, aborted: true, backendRef: null },
    });

    const result = await dispatchConversationTurn(
      {
        executionClass: "ordinary-conversation" as const,
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
      modelSelection: CLAUDE_SELECTION,
      outputFormat: undefined,
      alignmentVersion: null,
      async sendTurn() {
        throw new Error("network down");
      },
      async close() {},
    };

    const result = await dispatchConversationTurn(
      {
        executionClass: "ordinary-conversation" as const,
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
        executionClass: "ordinary-conversation" as const,
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
      result: { failure: null, aborted: true, backendRef: null },
    });

    await dispatchConversationTurn(
      {
        executionClass: "ordinary-conversation" as const,
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
      result: {
        failure: {
          kind: "backend_error",
          message: "stream closed",
          retryable: false,
        },
        aborted: false,
        backendRef: null,
      },
    });

    await dispatchConversationTurn(
      {
        executionClass: "ordinary-conversation" as const,
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
        executionClass: "ordinary-conversation" as const,
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

describe("dispatchConversationTurn — widened result mapping", () => {
  it("uses the backend's canonical final text instead of intermediate content blocks", async () => {
    const finalText = '{"summary":"done"}';
    const { runtime } = makeStubRuntime({
      result: {
        finalText,
        contentBlocks: [
          { type: "text", text: "Intermediate analysis" },
          { type: "tool_use", id: "tool-1", name: "Read", input: {} },
          { type: "text", text: finalText },
        ],
      },
    });

    const result = await dispatchConversationTurn(
      {
        executionClass: "ordinary-conversation" as const,
        kind: "conversation_turn",
        prompt: "format",
        outputSchema: { type: "object" },
      },
      {
        runtime,
        capabilityView: CAPABILITY_VIEW,
        signal: new AbortController().signal,
      },
    );

    expect(result.outcome.kind).toBe("completed");
    if (result.outcome.kind === "completed") {
      expect(result.outcome.text).toBe(finalText);
    }
  });

  it("carries numTurns, contentBlocks, compacted, backgroundWait, and the adapter disposition on a completed turn", async () => {
    const { runtime } = makeStubRuntime({
      result: {
        numTurns: 3,
        contentBlocks: [{ type: "text", text: "answer" }],
        compacted: true,
        backgroundWait: {
          waitedTaskIds: ["t1"],
          settledTaskIds: ["t1"],
          timedOut: false,
          durationMs: 42,
        },
      },
    });
    const result = await dispatchConversationTurn(
      {
        executionClass: "ordinary-conversation" as const,
        kind: "conversation_turn",
        prompt: "hi",
      },
      {
        runtime,
        capabilityView: CAPABILITY_VIEW,
        signal: new AbortController().signal,
      },
    );
    expect(result.outcome.kind).toBe("completed");
    if (result.outcome.kind === "completed") {
      expect(result.outcome.numTurns).toBe(3);
      expect(result.outcome.contentBlocks).toEqual([
        { type: "text", text: "answer" },
      ]);
    }
    expect(result.compacted).toBe(true);
    expect(result.backgroundWait).toEqual({
      waitedTaskIds: ["t1"],
      settledTaskIds: ["t1"],
      timedOut: false,
      durationMs: 42,
    });
    expect(result.continuationDisposition).toBe("retain");
  });

  it("passes the adapter's failure kind and turn facts through on a reported failure", async () => {
    const { runtime } = makeStubRuntime({
      result: {
        failure: {
          kind: "stale_resume_ref",
          message: "session gone",
          retryable: true,
        },
        contentBlocks: [{ type: "text", text: "partial" }],
        continuationDisposition: "clear",
        backendRef: null,
      },
    });
    const result = await dispatchConversationTurn(
      {
        executionClass: "ordinary-conversation" as const,
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
      expect(result.outcome.error.failureKind).toBe("stale_resume_ref");
      expect(result.outcome.error.message).toBe("session gone");
      expect(result.outcome.contentBlocks).toEqual([
        { type: "text", text: "partial" },
      ]);
    }
    expect(result.continuationDisposition).toBe("clear");
    expect(result.usage).toMatchObject({ durationMs: 1234 });
  });

  it("normalizes a thrown sendTurn error through the injected classifier", async () => {
    const { runtime } = makeStubRuntime();
    runtime.sendTurn = async () => {
      throw new Error("QuerySession ended before the turn completed");
    };
    const result = await dispatchConversationTurn(
      {
        executionClass: "ordinary-conversation" as const,
        kind: "conversation_turn",
        prompt: "hi",
      },
      {
        runtime,
        capabilityView: CAPABILITY_VIEW,
        signal: new AbortController().signal,
        classifyFailure: (error) => ({
          failure: {
            kind: "session_died",
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          },
          continuationDisposition: "retain",
        }),
      },
    );
    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind === "failed") {
      expect(result.outcome.error.failureKind).toBe("session_died");
      // No adapter turn result: partial content is absent, not empty.
      expect(result.outcome.contentBlocks).toBeUndefined();
    }
    // precise_session strength retains the ref on a thrown failure.
    expect(result.continuationDisposition).toBe("retain");
  });

  it("keeps aborted turns' partial facts on the failed outcome", async () => {
    const { runtime } = makeStubRuntime({
      result: {
        aborted: true,
        contentBlocks: [{ type: "text", text: "cut short" }],
      },
    });
    const result = await dispatchConversationTurn(
      {
        executionClass: "ordinary-conversation" as const,
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
      expect(result.outcome.contentBlocks).toEqual([
        { type: "text", text: "cut short" },
      ]);
    }
  });
});
