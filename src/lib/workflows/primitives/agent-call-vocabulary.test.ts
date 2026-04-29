import { describe, it, expect } from "vitest";
import {
  agentCallRequestSchema,
  agentCallResultSchema,
  backendCapabilityViewSchema,
  laneRefSchema,
  laneWriteCapabilitySchema,
  normalizedAgentCallErrorSchema,
  buildAgentCallLogFields,
  type AgentCallRequest,
  type AgentCallResult,
  type BackendCapabilityView,
} from "./agent-call-vocabulary";

const MIN_CAPABILITY_VIEW: BackendCapabilityView = {
  backend: "claude",
  continuationStrength: "precise_session",
  structuredOutputEnforcement: "post_validation",
  mcpApplicationBoundary: "between_turns",
  contextMetricsAvailable: true,
  nativeMidTurnAskUser: true,
};

describe("agentCallRequestSchema", () => {
  it("accepts a minimal conversation_turn request", () => {
    const parsed = agentCallRequestSchema.parse({
      kind: "conversation_turn",
      prompt: "hello",
    });
    expect(parsed.kind).toBe("conversation_turn");
  });

  it("accepts a conversation_turn with lane reuse, tooling, and structured output", () => {
    const req: AgentCallRequest = agentCallRequestSchema.parse({
      kind: "conversation_turn",
      prompt: "hello",
      backend: "claude",
      laneRef: { workflowId: "wf-1", laneId: "primary" },
      tooling: { servers: [] },
      outputSchema: { type: "object", properties: {}, required: [] },
      writeCapability: "read_only",
      timeoutMs: 30_000,
    });
    expect(req.kind).toBe("conversation_turn");
    if (req.kind === "conversation_turn") {
      expect(req.laneRef?.laneId).toBe("primary");
      expect(req.writeCapability).toBe("read_only");
      expect(req.outputSchema).toBeDefined();
    }
  });

  it("accepts a task_run request and requires an explicit backend", () => {
    const parsed = agentCallRequestSchema.parse({
      kind: "task_run",
      backend: "codex",
      prompt: "do the thing",
      systemInstructions: "be terse",
      tooling: { servers: [] },
      outputSchema: { type: "object" },
      writeCapability: "write_capable",
      timeoutMs: 60_000,
    });
    expect(parsed.kind).toBe("task_run");
    if (parsed.kind === "task_run") {
      expect(parsed.backend).toBe("codex");
    }
  });

  it("rejects a task_run that omits the backend", () => {
    const result = agentCallRequestSchema.safeParse({
      kind: "task_run",
      prompt: "do the thing",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown request kind", () => {
    const result = agentCallRequestSchema.safeParse({
      kind: "speculative_kind",
      prompt: "anything",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty prompt", () => {
    const result = agentCallRequestSchema.safeParse({
      kind: "conversation_turn",
      prompt: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("laneRefSchema and laneWriteCapabilitySchema", () => {
  it("requires both workflowId and laneId on a LaneRef", () => {
    expect(
      laneRefSchema.safeParse({ workflowId: "wf", laneId: "" }).success,
    ).toBe(false);
    expect(
      laneRefSchema.safeParse({ workflowId: "", laneId: "x" }).success,
    ).toBe(false);
    expect(
      laneRefSchema.parse({ workflowId: "wf", laneId: "primary" }).laneId,
    ).toBe("primary");
  });

  it("only accepts the two write-capability values", () => {
    expect(laneWriteCapabilitySchema.parse("read_only")).toBe("read_only");
    expect(laneWriteCapabilitySchema.parse("write_capable")).toBe(
      "write_capable",
    );
    expect(laneWriteCapabilitySchema.safeParse("maybe").success).toBe(false);
  });
});

describe("backendCapabilityViewSchema", () => {
  it("preserves backend-specific capability differences without flattening them", () => {
    const claudeView = backendCapabilityViewSchema.parse({
      backend: "claude",
      continuationStrength: "precise_session",
      structuredOutputEnforcement: "post_validation",
      mcpApplicationBoundary: "between_turns",
      contextMetricsAvailable: true,
      nativeMidTurnAskUser: true,
    });
    const codexView = backendCapabilityViewSchema.parse({
      backend: "codex",
      continuationStrength: "synthetic_thread",
      structuredOutputEnforcement: "backend_native",
      mcpApplicationBoundary: "per_request",
      contextMetricsAvailable: false,
      nativeMidTurnAskUser: false,
    });
    expect(claudeView.continuationStrength).toBe("precise_session");
    expect(codexView.continuationStrength).toBe("synthetic_thread");
    expect(claudeView.structuredOutputEnforcement).not.toBe(
      codexView.structuredOutputEnforcement,
    );
    expect(codexView.contextMetricsAvailable).toBe(false);
    expect(codexView.nativeMidTurnAskUser).toBe(false);
  });

  it("rejects unknown enforcement, continuity, or boundary values", () => {
    expect(
      backendCapabilityViewSchema.safeParse({
        backend: "claude",
        continuationStrength: "fuzzy",
        structuredOutputEnforcement: "post_validation",
        mcpApplicationBoundary: "between_turns",
        contextMetricsAvailable: true,
        nativeMidTurnAskUser: true,
      }).success,
    ).toBe(false);
  });
});

describe("normalizedAgentCallErrorSchema", () => {
  it("preserves backend identity and backend-specific failure detail", () => {
    const err = normalizedAgentCallErrorSchema.parse({
      failureKind: "backend_error",
      backend: "claude",
      message: "stream closed unexpectedly",
      backendDetails: { code: "ESTREAMEND", attempt: 2 },
    });
    expect(err.backend).toBe("claude");
    expect(err.backendDetails).toMatchObject({ code: "ESTREAMEND" });
  });

  it("normalizes timeouts and capability-unavailable cases", () => {
    expect(
      normalizedAgentCallErrorSchema.parse({
        failureKind: "timeout",
        backend: "codex",
        message: "task exceeded 60s",
      }).failureKind,
    ).toBe("timeout");
    expect(
      normalizedAgentCallErrorSchema.parse({
        failureKind: "capability_unavailable",
        backend: "codex",
        message: "context metrics not exposed",
      }).failureKind,
    ).toBe("capability_unavailable");
  });
});

describe("agentCallResultSchema", () => {
  it("returns backend identity, optional metrics, artifacts, and a completed outcome", () => {
    const ok: AgentCallResult = agentCallResultSchema.parse({
      backend: "claude",
      backendRef: { backend: "claude", sessionId: "sess-1" },
      capabilities: MIN_CAPABILITY_VIEW,
      usage: {
        inputTokens: 100,
        outputTokens: 200,
        contextTokens: 1234,
        contextWindowMax: 200_000,
      },
      artifacts: [
        {
          kind: "reference_document",
          relativePath: "memory-bank/foo.md",
        },
      ],
      outcome: {
        kind: "completed",
        text: "done",
        structuredOutput: { ok: true },
      },
    });
    expect(ok.backend).toBe("claude");
    expect(ok.outcome.kind).toBe("completed");
    expect(ok.usage.contextTokens).toBe(1234);
    expect(ok.artifacts).toHaveLength(1);
  });

  it("allows usage metrics to be empty when the backend cannot report them", () => {
    const result = agentCallResultSchema.parse({
      backend: "codex",
      backendRef: null,
      capabilities: { ...MIN_CAPABILITY_VIEW, backend: "codex" },
      usage: {},
      artifacts: [],
      outcome: { kind: "completed", text: "ok" },
    });
    expect(result.usage.contextTokens).toBeUndefined();
    expect(result.backendRef).toBeNull();
  });

  it("represents a paused outcome with a resumeToken and pauseKind", () => {
    const paused = agentCallResultSchema.parse({
      backend: "claude",
      backendRef: { backend: "claude", sessionId: "sess-1" },
      capabilities: MIN_CAPABILITY_VIEW,
      usage: {},
      artifacts: [],
      outcome: {
        kind: "paused",
        pauseKind: "mid_turn",
        resumeToken: "resume-123",
        details: { question: "Should we continue?" },
      },
    });
    expect(paused.outcome.kind).toBe("paused");
    if (paused.outcome.kind === "paused") {
      expect(paused.outcome.pauseKind).toBe("mid_turn");
      expect(paused.outcome.resumeToken).toBe("resume-123");
    }
  });

  it("represents a failed outcome with a normalized error that preserves backend identity", () => {
    const failed = agentCallResultSchema.parse({
      backend: "codex",
      backendRef: null,
      capabilities: { ...MIN_CAPABILITY_VIEW, backend: "codex" },
      usage: {},
      artifacts: [],
      outcome: {
        kind: "failed",
        error: {
          failureKind: "timeout",
          backend: "codex",
          message: "timed out at 60s",
        },
      },
    });
    expect(failed.outcome.kind).toBe("failed");
    if (failed.outcome.kind === "failed") {
      expect(failed.outcome.error.backend).toBe("codex");
    }
  });

  it("rejects results that omit the backend identity", () => {
    expect(
      agentCallResultSchema.safeParse({
        backendRef: null,
        capabilities: MIN_CAPABILITY_VIEW,
        usage: {},
        artifacts: [],
        outcome: { kind: "completed", text: "x" },
      }).success,
    ).toBe(false);
  });
});

describe("buildAgentCallLogFields", () => {
  it("emits the structured logging fields every primitive must include", () => {
    const fields = buildAgentCallLogFields({
      requestKind: "conversation_turn",
      backend: "claude",
      workflowId: "wf-1",
      laneId: "primary",
      outcome: "completed",
      artifactKinds: ["reference_document"],
    });
    expect(fields).toMatchObject({
      requestKind: "conversation_turn",
      backend: "claude",
      workflowId: "wf-1",
      laneId: "primary",
      outcome: "completed",
      artifactKinds: ["reference_document"],
    });
  });

  it("omits absent optional fields rather than emitting null", () => {
    const fields = buildAgentCallLogFields({
      requestKind: "task_run",
      backend: "codex",
    });
    expect(fields["requestKind"]).toBe("task_run");
    expect(fields["backend"]).toBe("codex");
    expect(fields).not.toHaveProperty("workflowId");
    expect(fields).not.toHaveProperty("laneId");
    expect(fields).not.toHaveProperty("outcome");
    expect(fields).not.toHaveProperty("artifactKinds");
  });
});
