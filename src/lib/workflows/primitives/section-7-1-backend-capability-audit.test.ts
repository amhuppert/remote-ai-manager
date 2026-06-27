/**
 * Section 7.1 — Backend capability preservation audit.
 *
 * The composable workflow primitives layer is meant to surface real backend
 * differences (continuation strength, structured-output enforcement source,
 * MCP application boundary, context metric availability, native mid-turn
 * ask-user) instead of hiding them behind a parity facade. This file is the
 * regression net for that contract: every seam in the primitive layer where
 * a workflow could branch on the capability view is exercised here, with
 * coverage for the unsupported-capability cases so the shared primitives
 * never silently emulate behavior a backend does not actually support.
 *
 * Each describe block targets one capability dimension and walks the seams
 * the dimension is observable at:
 *
 *  1. Capability view consistency  — `capabilityViewForBackend()` returns the
 *     canonical, single-source-of-truth view shared by every adapter.
 *  2. Continuation strength        — lane state's discriminated union enforces
 *     backend-specific continuity references (Claude conversationId vs Codex
 *     threadId) and rejects cross-mixing.
 *  3. Structured-output enforcement — both backends still flow through the
 *     shared structured-output gate even when the backend natively enforces
 *     the schema (no skip on `backend_native`).
 *  4. MCP application boundary      — runtimes that lack
 *     `applyPortableMcpConfig` produce a `capability_unavailable` failure
 *     instead of silently dropping tooling; the failure message carries the
 *     boundary so the caller can branch on it.
 *  5. Context metrics availability  — the context-limit gate returns
 *     `evaluation: "unsupported"` for backends with
 *     `contextMetricsAvailable: false`; the lane-metrics schema rejects
 *     context-window fields on those backends.
 *  6. Native mid-turn ask-user      — `askUserGateFromPause` projects only
 *     `mid_turn` paused outcomes into ask-user gate pauses; post-turn pauses
 *     and non-pause outcomes return `null` so workflows cannot accidentally
 *     treat an approval pause as an ask-user pause.
 */

import { describe, expect, it, vi } from "vitest";
import type {
  ConversationBackendRuntime,
  ConversationBackendTurnResult,
} from "@/lib/agent-backends/conversation";
import type { AgentSessionRef } from "@/lib/agent-backends/schemas";
import type {
  AgentTaskRunner,
  AgentTaskRequest,
  AgentTaskResult,
} from "@/lib/agent-backends/task";
import {
  CLAUDE_CAPABILITY_VIEW,
  CODEX_CAPABILITY_VIEW,
  capabilityViewForBackend,
} from "./backend-capabilities";
import { backendCapabilityViewSchema } from "./agent-call-vocabulary";
import { dispatchConversationTurn } from "./agent-call-conversation";
import { dispatchTaskRun } from "./agent-call-task";
import {
  executeAgentCall,
  type AgentCallFacadeDeps,
} from "./agent-call-facade";
import { runContextLimitGate } from "./context-limit-gate";
import { askUserGateFromPause } from "./ask-user-gate";
import { laneMetricsSchema, laneStateSchema } from "./lane-vocabulary";
import { runStructuredOutputGate } from "./structured-output-gate";

describe("section 7.1 — capability view canonical identity", () => {
  it("CLAUDE_CAPABILITY_VIEW reflects every supported Claude capability dimension", () => {
    expect(() =>
      backendCapabilityViewSchema.parse(CLAUDE_CAPABILITY_VIEW),
    ).not.toThrow();
    expect(CLAUDE_CAPABILITY_VIEW).toEqual({
      backend: "claude",
      continuationStrength: "precise_session",
      structuredOutputEnforcement: "backend_native",
      mcpApplicationBoundary: "between_turns",
      contextMetricsAvailable: true,
      nativeMidTurnAskUser: true,
    });
  });

  it("CODEX_CAPABILITY_VIEW reflects Codex's actual unsupported-capability surface", () => {
    expect(() =>
      backendCapabilityViewSchema.parse(CODEX_CAPABILITY_VIEW),
    ).not.toThrow();
    expect(CODEX_CAPABILITY_VIEW).toEqual({
      backend: "codex",
      continuationStrength: "synthetic_thread",
      structuredOutputEnforcement: "backend_native",
      mcpApplicationBoundary: "per_request",
      contextMetricsAvailable: false,
      nativeMidTurnAskUser: false,
    });
  });

  it("capabilityViewForBackend returns the canonical view object for every backend", () => {
    expect(capabilityViewForBackend("claude")).toBe(CLAUDE_CAPABILITY_VIEW);
    expect(capabilityViewForBackend("codex")).toBe(CODEX_CAPABILITY_VIEW);
  });

  it("Claude and Codex views differ on every meaningful dimension so workflows can branch", () => {
    expect(CLAUDE_CAPABILITY_VIEW.backend).not.toBe(
      CODEX_CAPABILITY_VIEW.backend,
    );
    expect(CLAUDE_CAPABILITY_VIEW.continuationStrength).not.toBe(
      CODEX_CAPABILITY_VIEW.continuationStrength,
    );
    expect(CLAUDE_CAPABILITY_VIEW.mcpApplicationBoundary).not.toBe(
      CODEX_CAPABILITY_VIEW.mcpApplicationBoundary,
    );
    expect(CLAUDE_CAPABILITY_VIEW.contextMetricsAvailable).not.toBe(
      CODEX_CAPABILITY_VIEW.contextMetricsAvailable,
    );
    expect(CLAUDE_CAPABILITY_VIEW.nativeMidTurnAskUser).not.toBe(
      CODEX_CAPABILITY_VIEW.nativeMidTurnAskUser,
    );
  });
});

describe("section 7.1 — continuation strength remains observable and branchable", () => {
  it("Claude lane state requires Claude-shape continuity reference (conversationId, never threadId)", () => {
    const claudeOk = laneStateSchema.safeParse({
      workflowId: "wf-1",
      laneId: "claude-lane",
      backend: "claude",
      writeCapability: "write_capable",
      policy: { continuityEnabled: true },
      backendState: { backend: "claude", conversationId: "conv-1" },
      metrics: { backend: "claude", rotateBeforeNextTurn: false },
      lastUsedAt: "2026-04-28T10:00:00.000Z",
    });
    expect(claudeOk.success).toBe(true);

    const claudeWithThreadId = laneStateSchema.safeParse({
      workflowId: "wf-1",
      laneId: "claude-lane",
      backend: "claude",
      writeCapability: "write_capable",
      policy: { continuityEnabled: true },
      backendState: { backend: "claude", threadId: "thr-1" },
      metrics: { backend: "claude", rotateBeforeNextTurn: false },
      lastUsedAt: "2026-04-28T10:00:00.000Z",
    });
    expect(claudeWithThreadId.success).toBe(false);
  });

  it("Codex lane state requires Codex-shape continuity reference (threadId, never conversationId)", () => {
    const codexOk = laneStateSchema.safeParse({
      workflowId: "wf-1",
      laneId: "codex-lane",
      backend: "codex",
      writeCapability: "read_only",
      policy: { continuityEnabled: false },
      backendState: { backend: "codex", threadId: "thr-1" },
      metrics: {
        backend: "codex",
        lastTurnUsage: null,
        rotateBeforeNextTurn: false,
      },
      lastUsedAt: "2026-04-28T10:00:00.000Z",
    });
    expect(codexOk.success).toBe(true);

    const codexWithConversationId = laneStateSchema.safeParse({
      workflowId: "wf-1",
      laneId: "codex-lane",
      backend: "codex",
      writeCapability: "read_only",
      policy: { continuityEnabled: false },
      backendState: { backend: "codex", conversationId: "conv-1" },
      metrics: {
        backend: "codex",
        lastTurnUsage: null,
        rotateBeforeNextTurn: false,
      },
      lastUsedAt: "2026-04-28T10:00:00.000Z",
    });
    expect(codexWithConversationId.success).toBe(false);
  });

  it("lane state cross-tag mismatch (claude wrapper, codex backendState) is rejected by superRefine", () => {
    const result = laneStateSchema.safeParse({
      workflowId: "wf-1",
      laneId: "lane-x",
      backend: "claude",
      writeCapability: "write_capable",
      policy: { continuityEnabled: true },
      backendState: { backend: "codex", threadId: "thr-1" },
      metrics: { backend: "claude", rotateBeforeNextTurn: false },
      lastUsedAt: "2026-04-28T10:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});

describe("section 7.1 — structured-output enforcement always flows through the shared gate", () => {
  it("Codex's backend_native enforcement does not skip the shared structured-output gate on schema violations", async () => {
    const runner: AgentTaskRunner = {
      backend: "codex",
      async run(): Promise<AgentTaskResult> {
        return {
          backendRef: { backend: "codex", threadId: "th-1" } as AgentSessionRef,
          text: "shaped",
          structuredOutput: { wrong: "shape" },
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
          error: null,
          timedOut: false,
        };
      },
    };
    const validate = vi.fn(() => ({
      valid: false,
      errors: ["missing required field: summary"],
    }));
    const deps: AgentCallFacadeDeps = {
      resolveTaskRunner: () => ({
        runner,
        capabilityView: CODEX_CAPABILITY_VIEW,
        workingDirectory: "/tmp",
      }),
      validateStructuredOutput: validate,
    };
    const result = await executeAgentCall(
      {
        kind: "task_run",
        backend: "codex",
        prompt: "anything",
        outputSchema: { type: "object", required: ["summary"] },
      },
      deps,
    );

    expect(validate).toHaveBeenCalledTimes(1);
    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind === "failed") {
      expect(result.outcome.error.failureKind).toBe("schema_validation");
      expect(result.outcome.error.backend).toBe("codex");
    }
  });

  it("Claude's backend_native enforcement also flows through the shared gate", async () => {
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
      alignmentVersion: null,
      async sendTurn(): Promise<ConversationBackendTurnResult> {
        return {
          backendRef: {
            backend: "claude",
            sessionId: "sess-1",
          } as AgentSessionRef,
          costUsd: null,
          durationMs: 50,
          numTurns: 1,
          contextTokens: 5,
          contextWindowMax: 200_000,
          contentBlocks: [{ type: "text", text: "ok" }],
          structuredOutput: { wrong: "shape" },
          aborted: false,
          error: null,
        };
      },
      close() {},
    };
    const validate = vi.fn(() => ({
      valid: false,
      errors: ["schema mismatch"],
    }));
    const deps: AgentCallFacadeDeps = {
      resolveConversationRuntime: () => ({
        runtime,
        capabilityView: CLAUDE_CAPABILITY_VIEW,
        signal: new AbortController().signal,
      }),
      validateStructuredOutput: validate,
    };
    const result = await executeAgentCall(
      {
        kind: "conversation_turn",
        backend: "claude",
        prompt: "hi",
        outputSchema: { type: "object" },
      },
      deps,
    );
    expect(validate).toHaveBeenCalledTimes(1);
    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind === "failed") {
      expect(result.outcome.error.failureKind).toBe("schema_validation");
    }
  });

  it("structured-output gate is bypassed when no outputSchema is supplied (no fake-validation regression)", async () => {
    const validate = vi.fn();
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
      alignmentVersion: null,
      async sendTurn(): Promise<ConversationBackendTurnResult> {
        return {
          backendRef: {
            backend: "claude",
            sessionId: "sess-1",
          } as AgentSessionRef,
          costUsd: null,
          durationMs: 50,
          numTurns: 1,
          contextTokens: 5,
          contextWindowMax: 200_000,
          contentBlocks: [{ type: "text", text: "ok" }],
          structuredOutput: undefined,
          aborted: false,
          error: null,
        };
      },
      close() {},
    };
    const deps: AgentCallFacadeDeps = {
      resolveConversationRuntime: () => ({
        runtime,
        capabilityView: CLAUDE_CAPABILITY_VIEW,
        signal: new AbortController().signal,
      }),
      validateStructuredOutput: validate,
    };
    const result = await executeAgentCall(
      { kind: "conversation_turn", backend: "claude", prompt: "hi" },
      deps,
    );
    expect(validate).not.toHaveBeenCalled();
    expect(result.outcome.kind).toBe("completed");
  });

  it("runStructuredOutputGate exposes a normalized fail when validator rejects, regardless of backend native enforcement claim", () => {
    const validator = () => ({
      valid: false,
      errors: ["shape diverged"],
    });
    const gate = runStructuredOutputGate(
      { type: "object" },
      { value: 1 },
      validator,
    );
    expect(gate.status).toBe("fail");
    if (gate.status === "fail") {
      expect(gate.reason).toContain("shape diverged");
    }
  });
});

describe("section 7.1 — MCP application boundary preserves runtime support", () => {
  it("conversation runtime without applyPortableMcpConfig produces capability_unavailable for Codex per_request boundary", async () => {
    const runtime: ConversationBackendRuntime = {
      backend: "codex",
      status: "alive",
      capabilities: {
        queueWhileRunning: false,
        askUserQuestion: false,
        preciseFork: false,
        portableMcpAtStart: false,
        portableMcpBetweenTurns: false,
        contextWindowMetrics: false,
      },
      modelId: undefined,
      reasoningEffort: undefined,
      outputFormat: undefined,
      alignmentVersion: null,
      async sendTurn(): Promise<ConversationBackendTurnResult> {
        return {
          backendRef: {
            backend: "codex",
            threadId: "th-1",
          } as AgentSessionRef,
          costUsd: null,
          durationMs: 50,
          numTurns: 1,
          contextTokens: null,
          contextWindowMax: null,
          contentBlocks: [{ type: "text", text: "ok" }],
          structuredOutput: undefined,
          aborted: false,
          error: null,
        };
      },
      close() {},
    };
    const result = await dispatchConversationTurn(
      {
        kind: "conversation_turn",
        backend: "codex",
        prompt: "hi",
        tooling: { servers: [] },
      },
      {
        runtime,
        capabilityView: CODEX_CAPABILITY_VIEW,
        signal: new AbortController().signal,
      },
    );
    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind === "failed") {
      expect(result.outcome.error.failureKind).toBe("capability_unavailable");
      expect(result.outcome.error.message).toContain("per_request");
      expect(result.outcome.error.backend).toBe("codex");
    }
  });

  it("conversation runtime without applyPortableMcpConfig produces capability_unavailable for Claude between_turns boundary", async () => {
    const runtime: ConversationBackendRuntime = {
      backend: "claude",
      status: "alive",
      capabilities: {
        queueWhileRunning: true,
        askUserQuestion: true,
        preciseFork: true,
        portableMcpAtStart: false,
        portableMcpBetweenTurns: false,
        contextWindowMetrics: true,
      },
      modelId: undefined,
      reasoningEffort: undefined,
      outputFormat: undefined,
      alignmentVersion: null,
      async sendTurn(): Promise<ConversationBackendTurnResult> {
        return {
          backendRef: {
            backend: "claude",
            sessionId: "sess-1",
          } as AgentSessionRef,
          costUsd: null,
          durationMs: 50,
          numTurns: 1,
          contextTokens: 5,
          contextWindowMax: 200_000,
          contentBlocks: [{ type: "text", text: "ok" }],
          structuredOutput: undefined,
          aborted: false,
          error: null,
        };
      },
      close() {},
    };
    const result = await dispatchConversationTurn(
      {
        kind: "conversation_turn",
        backend: "claude",
        prompt: "hi",
        tooling: { servers: [] },
      },
      {
        runtime,
        capabilityView: CLAUDE_CAPABILITY_VIEW,
        signal: new AbortController().signal,
      },
    );
    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind === "failed") {
      expect(result.outcome.error.failureKind).toBe("capability_unavailable");
      expect(result.outcome.error.message).toContain("between_turns");
    }
  });

  it("task runner forwards portable MCP tooling on the request itself (per_request boundary), not via a runtime call", async () => {
    let captured: AgentTaskRequest | null = null;
    const runner: AgentTaskRunner = {
      backend: "codex",
      async run(input): Promise<AgentTaskResult> {
        captured = input;
        return {
          backendRef: { backend: "codex", threadId: "th-1" } as AgentSessionRef,
          text: "ok",
          structuredOutput: undefined,
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
          error: null,
          timedOut: false,
        };
      },
    };
    const result = await dispatchTaskRun(
      {
        kind: "task_run",
        backend: "codex",
        prompt: "do",
        tooling: { servers: [] },
      },
      {
        runner,
        capabilityView: CODEX_CAPABILITY_VIEW,
        workingDirectory: "/tmp",
      },
    );
    expect(result.outcome.kind).toBe("completed");
    expect(captured).not.toBeNull();
    expect(captured!.tooling?.portableMcp).toEqual({ servers: [] });
  });
});

describe("section 7.1 — context metrics availability gates rotation safely on Codex", () => {
  it('Codex with a configured contextLimitTokens policy returns evaluation: "unsupported" instead of pretending to evaluate', () => {
    const gate = runContextLimitGate({
      metrics: { backend: "codex", rotateBeforeNextTurn: false },
      policy: { contextLimitTokens: 100_000 },
    });
    expect(gate.status).toBe("pass");
    if (gate.status === "pass") {
      expect(gate.details).toMatchObject({ evaluation: "unsupported" });
    }
  });

  it("Codex metrics may not carry contextTokens or contextWindowMax (no fake fields allowed)", () => {
    expect(
      laneMetricsSchema.safeParse({
        backend: "codex",
        contextTokens: 5,
        rotateBeforeNextTurn: false,
      }).success,
    ).toBe(false);
    expect(
      laneMetricsSchema.safeParse({
        backend: "codex",
        contextWindowMax: 200_000,
        rotateBeforeNextTurn: false,
      }).success,
    ).toBe(false);
  });

  it("Claude metrics may carry context-window numbers but the limit gate evaluates them", () => {
    const gate = runContextLimitGate({
      metrics: {
        backend: "claude",
        contextTokens: 200_000,
        contextWindowMax: 200_000,
        rotateBeforeNextTurn: false,
      },
      policy: { contextLimitTokens: 150_000 },
    });
    expect(gate.status).toBe("fail");
    if (gate.status === "fail") {
      expect(gate.details).toMatchObject({ evaluation: "rotation_required" });
    }
  });

  it("rotation flag persists across turns regardless of backend so a previously-flagged Codex lane is still blocked", () => {
    const codexGate = runContextLimitGate({
      metrics: { backend: "codex", rotateBeforeNextTurn: true },
      policy: { contextLimitTokens: 100_000 },
    });
    expect(codexGate.status).toBe("fail");
    if (codexGate.status === "fail") {
      expect(codexGate.details).toMatchObject({
        evaluation: "rotation_required",
      });
    }
  });
});

describe("section 7.1 — native mid-turn ask-user is observable only on backends that support it", () => {
  it("askUserGateFromPause projects a mid_turn paused outcome into a gate pause", () => {
    const gate = askUserGateFromPause({
      backend: "claude",
      backendRef: null,
      capabilities: CLAUDE_CAPABILITY_VIEW,
      usage: {},
      artifacts: [],
      outcome: {
        kind: "paused",
        pauseKind: "mid_turn",
        resumeToken: "tok-1",
        details: { questions: [] },
      },
    });
    expect(gate).not.toBeNull();
    expect(gate?.status).toBe("pause");
    if (gate?.status === "pause") {
      expect(gate.pauseKind).toBe("mid_turn");
      expect(gate.kind).toBe("ask_user");
    }
  });

  it("askUserGateFromPause returns null for a post_turn pause so workflows cannot mistake approval for ask-user", () => {
    const gate = askUserGateFromPause({
      backend: "claude",
      backendRef: null,
      capabilities: CLAUDE_CAPABILITY_VIEW,
      usage: {},
      artifacts: [],
      outcome: {
        kind: "paused",
        pauseKind: "post_turn",
        resumeToken: "tok-1",
      },
    });
    expect(gate).toBeNull();
  });

  it("askUserGateFromPause returns null for completed and failed outcomes", () => {
    const completed = askUserGateFromPause({
      backend: "codex",
      backendRef: null,
      capabilities: CODEX_CAPABILITY_VIEW,
      usage: {},
      artifacts: [],
      outcome: { kind: "completed", text: "ok" },
    });
    expect(completed).toBeNull();

    const failed = askUserGateFromPause({
      backend: "codex",
      backendRef: null,
      capabilities: CODEX_CAPABILITY_VIEW,
      usage: {},
      artifacts: [],
      outcome: {
        kind: "failed",
        error: {
          failureKind: "backend_error",
          backend: "codex",
          message: "boom",
        },
      },
    });
    expect(failed).toBeNull();
  });

  it("task dispatch has no mid-turn ask-user channel — Codex task results are completed or failed, never mid_turn paused", async () => {
    const runner: AgentTaskRunner = {
      backend: "codex",
      async run(): Promise<AgentTaskResult> {
        return {
          backendRef: { backend: "codex", threadId: "th-1" } as AgentSessionRef,
          text: "done",
          structuredOutput: undefined,
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
          error: null,
          timedOut: false,
        };
      },
    };
    const result = await dispatchTaskRun(
      { kind: "task_run", backend: "codex", prompt: "do" },
      {
        runner,
        capabilityView: CODEX_CAPABILITY_VIEW,
        workingDirectory: "/tmp",
      },
    );
    expect(result.outcome.kind).toBe("completed");
    expect(result.capabilities.nativeMidTurnAskUser).toBe(false);
  });
});

describe("section 7.1 — capability view is attached to every dispatched result so workflows can branch", () => {
  it("conversation dispatch attaches the supplied capability view verbatim", async () => {
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
      alignmentVersion: null,
      async sendTurn(): Promise<ConversationBackendTurnResult> {
        return {
          backendRef: {
            backend: "claude",
            sessionId: "sess-1",
          } as AgentSessionRef,
          costUsd: null,
          durationMs: 50,
          numTurns: 1,
          contextTokens: 5,
          contextWindowMax: 200_000,
          contentBlocks: [{ type: "text", text: "ok" }],
          structuredOutput: undefined,
          aborted: false,
          error: null,
        };
      },
      close() {},
    };
    const result = await dispatchConversationTurn(
      { kind: "conversation_turn", backend: "claude", prompt: "hi" },
      {
        runtime,
        capabilityView: CLAUDE_CAPABILITY_VIEW,
        signal: new AbortController().signal,
      },
    );
    expect(result.capabilities).toEqual(CLAUDE_CAPABILITY_VIEW);
  });

  it("task dispatch attaches the supplied capability view verbatim", async () => {
    const runner: AgentTaskRunner = {
      backend: "codex",
      async run(): Promise<AgentTaskResult> {
        return {
          backendRef: { backend: "codex", threadId: "th-1" } as AgentSessionRef,
          text: "ok",
          structuredOutput: undefined,
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
          error: null,
          timedOut: false,
        };
      },
    };
    const result = await dispatchTaskRun(
      { kind: "task_run", backend: "codex", prompt: "do" },
      {
        runner,
        capabilityView: CODEX_CAPABILITY_VIEW,
        workingDirectory: "/tmp",
      },
    );
    expect(result.capabilities).toEqual(CODEX_CAPABILITY_VIEW);
  });
});
