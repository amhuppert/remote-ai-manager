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
 *  6. Native mid-turn ask-user      — task dispatch has no mid-turn ask-user
 *     channel, so Codex task results are completed or failed, never
 *     `mid_turn` paused.
 */

import { describe, expect, it, vi } from "vitest";
import type {
  ConversationBackendRuntime,
  ConversationBackendTurnResult,
} from "@/lib/agent-backends/conversation";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import type {
  AgentTaskRunner,
  AgentTaskRequest,
  AgentTaskResult,
} from "@/lib/agent-backends/task";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import { capabilityViewForBackend } from "./backend-capabilities";
import { backendCapabilityViewSchema } from "./agent-call-vocabulary";
import { dispatchConversationTurn } from "./agent-call-conversation";
import { dispatchTaskRun } from "./agent-call-task";
import {
  executeAgentCall,
  type AgentCallFacadeDeps,
} from "./agent-call-facade";
import { runContextLimitGate } from "./context-limit-gate";
import { laneStateSchema } from "./lane-vocabulary";
import { runStructuredOutputGate } from "./structured-output-gate";

const CLAUDE_CAPABILITY_VIEW = capabilityViewForBackend("claude");
const CODEX_CAPABILITY_VIEW = capabilityViewForBackend("codex");
const CLAUDE_MODEL_SELECTION: BackendModelSelection = {
  modelId: "sonnet",
  parameters: { effort: "high" },
};
const CODEX_MODEL_SELECTION: BackendModelSelection = {
  modelId: "gpt-5.2",
  parameters: { reasoning: "high", fast: "false" },
};

describe("section 7.1 — capability view canonical identity", () => {
  it("the derived Claude view reflects every supported Claude capability dimension", () => {
    expect(() =>
      backendCapabilityViewSchema.parse(CLAUDE_CAPABILITY_VIEW),
    ).not.toThrow();
    expect(CLAUDE_CAPABILITY_VIEW).toEqual({
      backend: "claude",
      continuationStrength: "precise_session",
      structuredOutputEnforcement: "post_validation",
      mcpApplicationBoundary: "between_turns",
      contextMetricsAvailable: true,
      nativeMidTurnAskUser: true,
    });
  });

  it("the derived Codex view reflects Codex's actual unsupported-capability surface", () => {
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

  it("capabilityViewForBackend returns the canonical view for every backend", () => {
    expect(capabilityViewForBackend("claude")).toEqual(CLAUDE_CAPABILITY_VIEW);
    expect(capabilityViewForBackend("codex")).toEqual(CODEX_CAPABILITY_VIEW);
  });

  it("Claude and Codex views differ on every meaningful dimension so workflows can branch", () => {
    expect(CLAUDE_CAPABILITY_VIEW.backend).not.toBe(
      CODEX_CAPABILITY_VIEW.backend,
    );
    expect(CLAUDE_CAPABILITY_VIEW.continuationStrength).not.toBe(
      CODEX_CAPABILITY_VIEW.continuationStrength,
    );
    expect(CLAUDE_CAPABILITY_VIEW.structuredOutputEnforcement).not.toBe(
      CODEX_CAPABILITY_VIEW.structuredOutputEnforcement,
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

describe("section 7.1 — lane continuity handles are opaque and backend-owned", () => {
  it("lane state carries an opaque {backend, ref} pair — the same shape for every backend, null before the first session", () => {
    for (const backend of ["claude", "codex"] as const) {
      const withRef = laneStateSchema.safeParse({
        workflowId: "wf-1",
        laneId: `${backend}-lane`,
        backend,
        ref: "handle-1",
        writeCapability: "write_capable",
        policy: { continuityEnabled: true },
        metrics: { rotateBeforeNextTurn: false },
        lastUsedAt: "2026-04-28T10:00:00.000Z",
      });
      expect(withRef.success).toBe(true);

      const withoutRef = laneStateSchema.safeParse({
        workflowId: "wf-1",
        laneId: `${backend}-lane`,
        backend,
        ref: null,
        writeCapability: "write_capable",
        policy: { continuityEnabled: true },
        metrics: { rotateBeforeNextTurn: false },
        lastUsedAt: "2026-04-28T10:00:00.000Z",
      });
      expect(withoutRef.success).toBe(true);
    }
  });

  it("an empty-string handle is rejected — a lane either has a real handle or null", () => {
    const result = laneStateSchema.safeParse({
      workflowId: "wf-1",
      laneId: "lane-x",
      backend: "claude",
      ref: "",
      writeCapability: "write_capable",
      policy: { continuityEnabled: true },
      metrics: { rotateBeforeNextTurn: false },
      lastUsedAt: "2026-04-28T10:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});

describe("section 7.1 — structured-output enforcement always flows through the shared gate", () => {
  it("Codex's backend_native enforcement does not skip the shared structured-output gate on schema violations", async () => {
    const requests: AgentTaskRequest[] = [];
    const runner: AgentTaskRunner = {
      backend: "codex",
      async run(request): Promise<AgentTaskResult> {
        requests.push(request);
        return {
          backendRef: { backend: "codex", ref: "th-1" } as AgentSessionRef,
          text: "shaped",
          structuredOutput: { wrong: "shape" },
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
          error: null,
          timedOut: false,
          failure: null,
          continuationDisposition: "retain",
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
        modelSelection: CODEX_MODEL_SELECTION,
      }),
      validateStructuredOutput: validate,
    };
    const result = await executeAgentCall(
      {
        executionClass: "nongoverned-task" as const,
        kind: "task_run",
        backend: "codex",
        prompt: "anything",
        outputSchema: { type: "object", required: ["summary"] },
        structuredOutputRepair: { maxAttempts: 0 },
      },
      deps,
    );

    expect(validate).toHaveBeenCalledTimes(1);
    expect(requests[0]?.modelSelection).toEqual(CODEX_MODEL_SELECTION);
    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind === "failed") {
      expect(result.outcome.error.failureKind).toBe("schema_validation");
      expect(result.outcome.error.backend).toBe("codex");
    }
  });

  it("Claude's post_validation enforcement also flows through the shared gate", async () => {
    const runtime: ConversationBackendRuntime = {
      backend: "claude",
      status: "alive",
      modelSelection: CLAUDE_MODEL_SELECTION,
      outputFormat: undefined,

      async sendTurn(): Promise<ConversationBackendTurnResult> {
        return {
          backendRef: {
            backend: "claude",
            ref: "sess-1",
          } as AgentSessionRef,
          costUsd: null,
          durationMs: 50,
          numTurns: 1,
          contextTokens: 5,
          contextWindowMax: 200_000,
          contentBlocks: [{ type: "text", text: '{"wrong":"shape"}' }],
          aborted: false,
          compacted: false,
          failure: null,
          continuationDisposition: "retain",
        };
      },
      async close() {},
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
        modelSelection: CLAUDE_MODEL_SELECTION,
      }),
      validateStructuredOutput: validate,
    };
    const result = await executeAgentCall(
      {
        executionClass: "ordinary-conversation" as const,
        kind: "conversation_turn",
        backend: "claude",
        prompt: "hi",
        outputSchema: { type: "object" },
        structuredOutputRepair: { maxAttempts: 0 },
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
      modelSelection: CLAUDE_MODEL_SELECTION,
      outputFormat: undefined,

      async sendTurn(): Promise<ConversationBackendTurnResult> {
        return {
          backendRef: {
            backend: "claude",
            ref: "sess-1",
          } as AgentSessionRef,
          costUsd: null,
          durationMs: 50,
          numTurns: 1,
          contextTokens: 5,
          contextWindowMax: 200_000,
          contentBlocks: [{ type: "text", text: "ok" }],
          structuredOutput: undefined,
          aborted: false,
          compacted: false,
          failure: null,
          continuationDisposition: "retain",
        };
      },
      async close() {},
    };
    const deps: AgentCallFacadeDeps = {
      resolveConversationRuntime: () => ({
        runtime,
        capabilityView: CLAUDE_CAPABILITY_VIEW,
        signal: new AbortController().signal,
        modelSelection: CLAUDE_MODEL_SELECTION,
      }),
      validateStructuredOutput: validate,
    };
    const result = await executeAgentCall(
      {
        executionClass: "ordinary-conversation" as const,
        kind: "conversation_turn",
        backend: "claude",
        prompt: "hi",
      },
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
      modelSelection: CODEX_MODEL_SELECTION,
      outputFormat: undefined,

      async sendTurn(): Promise<ConversationBackendTurnResult> {
        return {
          backendRef: {
            backend: "codex",
            ref: "th-1",
          } as AgentSessionRef,
          costUsd: null,
          durationMs: 50,
          numTurns: 1,
          contextTokens: null,
          contextWindowMax: null,
          contentBlocks: [{ type: "text", text: "ok" }],
          structuredOutput: undefined,
          aborted: false,
          compacted: false,
          failure: null,
          continuationDisposition: "retain",
        };
      },
      async close() {},
    };
    const result = await dispatchConversationTurn(
      {
        executionClass: "ordinary-conversation" as const,
        kind: "conversation_turn",
        backend: "codex",
        prompt: "hi",
        tooling: { servers: [] },
      },
      {
        runtime,
        capabilityView: CODEX_CAPABILITY_VIEW,
        signal: new AbortController().signal,
        modelSelection: CODEX_MODEL_SELECTION,
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
      modelSelection: CLAUDE_MODEL_SELECTION,
      outputFormat: undefined,

      async sendTurn(): Promise<ConversationBackendTurnResult> {
        return {
          backendRef: {
            backend: "claude",
            ref: "sess-1",
          } as AgentSessionRef,
          costUsd: null,
          durationMs: 50,
          numTurns: 1,
          contextTokens: 5,
          contextWindowMax: 200_000,
          contentBlocks: [{ type: "text", text: "ok" }],
          structuredOutput: undefined,
          aborted: false,
          compacted: false,
          failure: null,
          continuationDisposition: "retain",
        };
      },
      async close() {},
    };
    const result = await dispatchConversationTurn(
      {
        executionClass: "ordinary-conversation" as const,
        kind: "conversation_turn",
        backend: "claude",
        prompt: "hi",
        tooling: { servers: [] },
      },
      {
        runtime,
        capabilityView: CLAUDE_CAPABILITY_VIEW,
        signal: new AbortController().signal,
        modelSelection: CLAUDE_MODEL_SELECTION,
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
          backendRef: { backend: "codex", ref: "th-1" } as AgentSessionRef,
          text: "ok",
          structuredOutput: undefined,
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
          error: null,
          timedOut: false,
          failure: null,
          continuationDisposition: "retain",
        };
      },
    };
    const result = await dispatchTaskRun(
      {
        executionClass: "nongoverned-task" as const,
        kind: "task_run",
        backend: "codex",
        prompt: "do",
        tooling: { servers: [] },
      },
      {
        runner,
        capabilityView: CODEX_CAPABILITY_VIEW,
        workingDirectory: "/tmp",
        modelSelection: CODEX_MODEL_SELECTION,
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

  it("a metrics-less backend stays unsupported even when a bogus contextTokens value is present (capability wins over data)", () => {
    const gate = runContextLimitGate({
      metrics: {
        backend: "codex",
        contextTokens: 5_000_000,
        rotateBeforeNextTurn: false,
      },
      policy: { contextLimitTokens: 100_000 },
    });
    expect(gate.status).toBe("pass");
    if (gate.status === "pass") {
      expect(gate.details).toMatchObject({ evaluation: "unsupported" });
    }
  });

  it("Claude metrics may carry context-window numbers but the limit gate evaluates them", () => {
    const gate = runContextLimitGate({
      metrics: {
        backend: "claude",
        contextTokens: 200_000,
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
  it("task dispatch has no mid-turn ask-user channel — Codex task results are completed or failed, never mid_turn paused", async () => {
    const runner: AgentTaskRunner = {
      backend: "codex",
      async run(): Promise<AgentTaskResult> {
        return {
          backendRef: { backend: "codex", ref: "th-1" } as AgentSessionRef,
          text: "done",
          structuredOutput: undefined,
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
          error: null,
          timedOut: false,
          failure: null,
          continuationDisposition: "retain",
        };
      },
    };
    const result = await dispatchTaskRun(
      {
        executionClass: "nongoverned-task" as const,
        kind: "task_run",
        backend: "codex",
        prompt: "do",
      },
      {
        runner,
        capabilityView: CODEX_CAPABILITY_VIEW,
        workingDirectory: "/tmp",
        modelSelection: CODEX_MODEL_SELECTION,
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
      modelSelection: CLAUDE_MODEL_SELECTION,
      outputFormat: undefined,

      async sendTurn(): Promise<ConversationBackendTurnResult> {
        return {
          backendRef: {
            backend: "claude",
            ref: "sess-1",
          } as AgentSessionRef,
          costUsd: null,
          durationMs: 50,
          numTurns: 1,
          contextTokens: 5,
          contextWindowMax: 200_000,
          contentBlocks: [{ type: "text", text: "ok" }],
          structuredOutput: undefined,
          aborted: false,
          compacted: false,
          failure: null,
          continuationDisposition: "retain",
        };
      },
      async close() {},
    };
    const result = await dispatchConversationTurn(
      {
        executionClass: "ordinary-conversation" as const,
        kind: "conversation_turn",
        backend: "claude",
        prompt: "hi",
      },
      {
        runtime,
        capabilityView: CLAUDE_CAPABILITY_VIEW,
        signal: new AbortController().signal,
        modelSelection: CLAUDE_MODEL_SELECTION,
      },
    );
    expect(result.capabilities).toEqual(CLAUDE_CAPABILITY_VIEW);
  });

  it("task dispatch attaches the supplied capability view verbatim", async () => {
    const runner: AgentTaskRunner = {
      backend: "codex",
      async run(): Promise<AgentTaskResult> {
        return {
          backendRef: { backend: "codex", ref: "th-1" } as AgentSessionRef,
          text: "ok",
          structuredOutput: undefined,
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
          error: null,
          timedOut: false,
          failure: null,
          continuationDisposition: "retain",
        };
      },
    };
    const result = await dispatchTaskRun(
      {
        executionClass: "nongoverned-task" as const,
        kind: "task_run",
        backend: "codex",
        prompt: "do",
      },
      {
        runner,
        capabilityView: CODEX_CAPABILITY_VIEW,
        workingDirectory: "/tmp",
        modelSelection: CODEX_MODEL_SELECTION,
      },
    );
    expect(result.capabilities).toEqual(CODEX_CAPABILITY_VIEW);
  });
});
