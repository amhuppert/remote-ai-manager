/**
 * End-to-end behavior tests for the AgentCall primitive across both backends.
 *
 * Verifies the shared semantic contract from section 1:
 *  - Backend selection routes the right kind to the right port.
 *  - Structured-output validation flows through a shared gate even when the
 *    backend offers native enforcement.
 *  - Timeout, capability-unavailable, and schema-validation failures
 *    normalize identically across backends.
 *  - Write-capability scheduling hints fall back to write_capable by default.
 */

import { describe, it, expect, vi } from "vitest";
import type {
  ConversationBackendRuntime,
  ConversationBackendTurnInput,
  ConversationBackendTurnResult,
} from "@/lib/agent-backends/conversation";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import type {
  AgentTaskRunner,
  AgentTaskRequest,
  AgentTaskResult,
} from "@/lib/agent-backends/task";
import {
  executeAgentCall,
  resolveSchedulingHint,
  type AgentCallFacadeDeps,
} from "./agent-call-facade";
import { runStructuredOutputGate } from "./structured-output-gate";
import type { BackendCapabilityView } from "./agent-call-vocabulary";

const CLAUDE_VIEW: BackendCapabilityView = {
  backend: "claude",
  continuationStrength: "precise_session",
  structuredOutputEnforcement: "post_validation",
  mcpApplicationBoundary: "between_turns",
  contextMetricsAvailable: true,
  nativeMidTurnAskUser: true,
};

const CODEX_VIEW: BackendCapabilityView = {
  backend: "codex",
  continuationStrength: "synthetic_thread",
  structuredOutputEnforcement: "backend_native",
  mcpApplicationBoundary: "per_request",
  contextMetricsAvailable: false,
  nativeMidTurnAskUser: false,
};

interface ConversationStubOpts {
  result?: Partial<ConversationBackendTurnResult>;
  capture?: { value: ConversationBackendTurnInput | null };
}

function makeConversationRuntime(
  backend: BackendCapabilityView["backend"],
  opts: ConversationStubOpts = {},
): ConversationBackendRuntime {
  const baseResult: ConversationBackendTurnResult = {
    backendRef:
      backend === "claude"
        ? ({ backend: "claude", ref: "sess-1" } as AgentSessionRef)
        : ({ backend: "codex", ref: "th-1" } as AgentSessionRef),
    costUsd: null,
    durationMs: 100,
    numTurns: 1,
    contextTokens: 5,
    contextWindowMax: 200_000,
    contentBlocks: [{ type: "text", text: "hi" }],
    structuredOutput: undefined,
    aborted: false,
    compacted: false,
    failure: null,
    continuationDisposition: "retain",
  };

  return {
    backend,
    status: "alive",
    modelId: undefined,
    reasoningEffort: undefined,
    outputFormat: undefined,
    alignmentVersion: null,
    async sendTurn(input) {
      if (opts.capture) opts.capture.value = input;
      return { ...baseResult, ...(opts.result ?? {}) };
    },
    close() {},
  };
}

interface TaskStubOpts {
  result?: Partial<AgentTaskResult>;
  capture?: { value: AgentTaskRequest | null };
}

function makeTaskRunner(
  backend: BackendCapabilityView["backend"],
  opts: TaskStubOpts = {},
): AgentTaskRunner {
  const base: AgentTaskResult = {
    backendRef:
      backend === "codex"
        ? { backend: "codex", ref: "th-1" }
        : { backend: "claude", ref: "sess-1" },
    text: "ok",
    structuredOutput: undefined,
    usage: { inputTokens: 10, outputTokens: 20, cachedInputTokens: 0 },
    error: null,
    timedOut: false,
    failure: null,
    continuationDisposition: "retain",
  };
  return {
    backend,
    async run(input) {
      if (opts.capture) opts.capture.value = input;
      return { ...base, ...(opts.result ?? {}) };
    },
  };
}

describe("executeAgentCall — backend selection", () => {
  it("routes a conversation_turn to the conversation backend", async () => {
    const capture = { value: null as ConversationBackendTurnInput | null };
    const runtime = makeConversationRuntime("claude", { capture });

    const result = await executeAgentCall(
      { kind: "conversation_turn", prompt: "hi" },
      buildDepsForConversation({ runtime, view: CLAUDE_VIEW }),
    );

    expect(capture.value?.promptText).toBe("hi");
    expect(result.backend).toBe("claude");
    expect(result.outcome.kind).toBe("completed");
  });

  it("forwards request image refs to the conversation runtime", async () => {
    const capture = { value: null as ConversationBackendTurnInput | null };
    const runtime = makeConversationRuntime("claude", { capture });

    await executeAgentCall(
      {
        kind: "conversation_turn",
        prompt: "inspect this image",
        imageRefs: [
          {
            index: 1,
            mediaType: "image/png",
            path: "/images/first.png",
            base64Data: "first",
          },
        ],
      },
      buildDepsForConversation({ runtime, view: CLAUDE_VIEW }),
    );

    expect(capture.value?.imageRefs).toEqual([
      {
        index: 1,
        mediaType: "image/png",
        path: "/images/first.png",
        base64Data: "first",
      },
    ]);
  });

  it("routes a task_run to the task runner for the requested backend", async () => {
    const capture = { value: null as AgentTaskRequest | null };
    const runner = makeTaskRunner("codex", { capture });
    const result = await executeAgentCall(
      { kind: "task_run", backend: "codex", prompt: "hi" },
      buildDepsForTask({ runner, view: CODEX_VIEW }),
    );
    expect(capture.value?.prompt).toBe("hi");
    expect(result.backend).toBe("codex");
    expect(result.outcome.kind).toBe("completed");
  });

  it("uses the deps.defaultConversationBackend when conversation_turn omits the backend", async () => {
    const capture = { value: null as ConversationBackendTurnInput | null };
    const runtime = makeConversationRuntime("codex", { capture });
    const deps: AgentCallFacadeDeps = {
      defaultConversationBackend: "codex",
      resolveConversationRuntime: () => ({
        runtime,
        capabilityView: CODEX_VIEW,
        signal: new AbortController().signal,
      }),
      resolveTaskRunner: () => {
        throw new Error("should not run task runner");
      },
    };
    const result = await executeAgentCall(
      { kind: "conversation_turn", prompt: "go" },
      deps,
    );
    expect(result.backend).toBe("codex");
    expect(capture.value).not.toBeNull();
  });

  it("rejects an unsupported request shape early", async () => {
    const deps = buildDepsForConversation({
      runtime: makeConversationRuntime("claude"),
      view: CLAUDE_VIEW,
    });
    await expect(
      executeAgentCall(
        // @ts-expect-error — runtime check that a malformed kind is rejected
        { kind: "unknown_kind", prompt: "x" },
        deps,
      ),
    ).rejects.toThrow();
  });
});

describe("executeAgentCall — structured-output gate", () => {
  it("returns completed when validation passes for a conversation turn", async () => {
    const runtime = makeConversationRuntime("claude", {
      result: { structuredOutput: { ok: true } },
    });
    const result = await executeAgentCall(
      {
        kind: "conversation_turn",
        prompt: "go",
        outputSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
        },
      },
      buildDepsForConversation({
        runtime,
        view: CLAUDE_VIEW,
        validate: (_schema, value) =>
          typeof value === "object" &&
          value !== null &&
          (value as { ok?: unknown }).ok === true
            ? { valid: true }
            : { valid: false, errors: ["ok must be true"] },
      }),
    );
    expect(result.outcome.kind).toBe("completed");
  });

  it("returns a schema_validation failure when validation fails for a conversation turn", async () => {
    const runtime = makeConversationRuntime("claude", {
      result: { structuredOutput: { ok: false } },
    });
    const result = await executeAgentCall(
      {
        kind: "conversation_turn",
        prompt: "go",
        outputSchema: { type: "object", required: ["ok"] },
      },
      buildDepsForConversation({
        runtime,
        view: CLAUDE_VIEW,
        validate: (_schema, value) =>
          (value as { ok?: unknown }).ok === true
            ? { valid: true }
            : { valid: false, errors: ["ok must be true"] },
      }),
    );
    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind === "failed") {
      expect(result.outcome.error.failureKind).toBe("schema_validation");
      expect(result.outcome.error.backend).toBe("claude");
      expect(result.outcome.error.message).toContain("ok must be true");
    }
  });

  it("still runs the shared gate even when the backend natively enforces the schema (codex)", async () => {
    let validatorCalls = 0;
    const runner = makeTaskRunner("codex", {
      result: { structuredOutput: { ok: true } },
    });
    await executeAgentCall(
      {
        kind: "task_run",
        backend: "codex",
        prompt: "go",
        outputSchema: { type: "object" },
      },
      buildDepsForTask({
        runner,
        view: CODEX_VIEW,
        validate: () => {
          validatorCalls += 1;
          return { valid: true };
        },
      }),
    );
    expect(validatorCalls).toBe(1);
  });

  it("treats a missing structured output as a schema_validation failure when an outputSchema was requested", async () => {
    const runtime = makeConversationRuntime("claude", {
      result: { structuredOutput: undefined },
    });
    const result = await executeAgentCall(
      {
        kind: "conversation_turn",
        prompt: "go",
        outputSchema: { type: "object" },
      },
      buildDepsForConversation({
        runtime,
        view: CLAUDE_VIEW,
        validate: (_schema, value) =>
          value === undefined
            ? { valid: false, errors: ["missing structured output"] }
            : { valid: true },
      }),
    );
    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind === "failed") {
      expect(result.outcome.error.failureKind).toBe("schema_validation");
    }
  });

  it("does not run the gate when no outputSchema is set", async () => {
    let calls = 0;
    const runtime = makeConversationRuntime("claude");
    await executeAgentCall(
      { kind: "conversation_turn", prompt: "go" },
      buildDepsForConversation({
        runtime,
        view: CLAUDE_VIEW,
        validate: () => {
          calls += 1;
          return { valid: true };
        },
      }),
    );
    expect(calls).toBe(0);
  });

  it("falls back to parsing raw JSON text when structuredOutput is missing", async () => {
    const capturedValues: unknown[] = [];
    const runtime = makeConversationRuntime("claude", {
      result: {
        structuredOutput: undefined,
        contentBlocks: [{ type: "text", text: '{"ok":true}' }],
      },
    });
    const result = await executeAgentCall(
      {
        kind: "conversation_turn",
        prompt: "go",
        outputSchema: { type: "object", required: ["ok"] },
      },
      buildDepsForConversation({
        runtime,
        view: CLAUDE_VIEW,
        validate: (_schema, value) => {
          capturedValues.push(value);
          return typeof value === "object" &&
            value !== null &&
            (value as { ok?: unknown }).ok === true
            ? { valid: true }
            : { valid: false, errors: ["ok must be true"] };
        },
      }),
    );
    expect(capturedValues).toEqual([{ ok: true }]);
    expect(result.outcome.kind).toBe("completed");
    if (result.outcome.kind === "completed") {
      expect(result.outcome.structuredOutput).toEqual({ ok: true });
    }
  });

  it("falls back to extracting JSON from a fenced ```json block when structuredOutput is missing", async () => {
    const capturedValues: unknown[] = [];
    const runtime = makeConversationRuntime("claude", {
      result: {
        structuredOutput: undefined,
        contentBlocks: [
          {
            type: "text",
            text:
              "Here is the result you asked for:\n\n" +
              "```json\n" +
              '{"ok":true,"note":"fenced"}\n' +
              "```\n\n" +
              "Let me know if you want anything else.",
          },
        ],
      },
    });
    const result = await executeAgentCall(
      {
        kind: "conversation_turn",
        prompt: "go",
        outputSchema: { type: "object", required: ["ok"] },
      },
      buildDepsForConversation({
        runtime,
        view: CLAUDE_VIEW,
        validate: (_schema, value) => {
          capturedValues.push(value);
          return typeof value === "object" &&
            value !== null &&
            (value as { ok?: unknown }).ok === true
            ? { valid: true }
            : { valid: false, errors: ["ok must be true"] };
        },
      }),
    );
    expect(capturedValues).toEqual([{ ok: true, note: "fenced" }]);
    expect(result.outcome.kind).toBe("completed");
    if (result.outcome.kind === "completed") {
      expect(result.outcome.structuredOutput).toEqual({
        ok: true,
        note: "fenced",
      });
    }
  });

  it("fails cleanly when structuredOutput is missing AND the text is not parseable as JSON", async () => {
    const capturedValues: unknown[] = [];
    const runtime = makeConversationRuntime("claude", {
      result: {
        structuredOutput: undefined,
        contentBlocks: [
          {
            type: "text",
            text: "Sorry, I could not produce a structured response this time.",
          },
        ],
      },
    });
    const result = await executeAgentCall(
      {
        kind: "conversation_turn",
        prompt: "go",
        outputSchema: { type: "object", required: ["ok"] },
      },
      buildDepsForConversation({
        runtime,
        view: CLAUDE_VIEW,
        validate: (_schema, value) => {
          capturedValues.push(value);
          return value === undefined
            ? { valid: false, errors: ["missing structured output"] }
            : { valid: true };
        },
      }),
    );
    expect(capturedValues).toEqual([undefined]);
    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind === "failed") {
      expect(result.outcome.error.failureKind).toBe("schema_validation");
      expect(result.outcome.error.message).toContain(
        "missing structured output",
      );
    }
  });

  it("falls back to parsing raw JSON text on the task_run path when structuredOutput is missing", async () => {
    const capturedValues: unknown[] = [];
    const runner = makeTaskRunner("codex", {
      result: { structuredOutput: undefined, text: '{"ok":true}' },
    });
    const result = await executeAgentCall(
      {
        kind: "task_run",
        backend: "codex",
        prompt: "go",
        outputSchema: { type: "object", required: ["ok"] },
      },
      buildDepsForTask({
        runner,
        view: CODEX_VIEW,
        validate: (_schema, value) => {
          capturedValues.push(value);
          return typeof value === "object" &&
            value !== null &&
            (value as { ok?: unknown }).ok === true
            ? { valid: true }
            : { valid: false, errors: ["ok must be true"] };
        },
      }),
    );
    expect(capturedValues).toEqual([{ ok: true }]);
    expect(result.outcome.kind).toBe("completed");
    if (result.outcome.kind === "completed") {
      expect(result.outcome.structuredOutput).toEqual({ ok: true });
    }
  });

  it("does not run the gate when the dispatch already failed", async () => {
    let calls = 0;
    const runtime = makeConversationRuntime("claude", {
      result: {
        failure: { kind: "backend_error", message: "boom", retryable: false },
        aborted: false,
      },
    });
    const result = await executeAgentCall(
      {
        kind: "conversation_turn",
        prompt: "go",
        outputSchema: { type: "object" },
      },
      buildDepsForConversation({
        runtime,
        view: CLAUDE_VIEW,
        validate: () => {
          calls += 1;
          return { valid: true };
        },
      }),
    );
    expect(calls).toBe(0);
    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind === "failed") {
      expect(result.outcome.error.failureKind).toBe("backend_error");
    }
  });
});

describe("executeAgentCall — structured-output gate fall-through", () => {
  it("falls through to a valid fenced JSON object when the native structured output fails the gate", async () => {
    const runtime = makeConversationRuntime("claude", {
      result: {
        structuredOutput: { ok: false },
        contentBlocks: [
          {
            type: "text",
            text:
              "The native payload was wrong, but here is the corrected one:\n\n" +
              "```json\n" +
              '{"ok":true}\n' +
              "```\n",
          },
        ],
      },
    });
    const result = await executeAgentCall(
      {
        kind: "conversation_turn",
        prompt: "go",
        outputSchema: { type: "object", required: ["ok"] },
      },
      buildDepsForConversation({
        runtime,
        view: CLAUDE_VIEW,
        validate: (_schema, value) =>
          typeof value === "object" &&
          value !== null &&
          (value as { ok?: unknown }).ok === true
            ? { valid: true }
            : { valid: false, errors: ["ok must be true"] },
      }),
    );
    expect(result.outcome.kind).toBe("completed");
    if (result.outcome.kind === "completed") {
      expect(result.outcome.structuredOutput).toEqual({ ok: true });
    }
  });

  it("keeps a passing native structured output even when the text carries different JSON", async () => {
    const runtime = makeConversationRuntime("claude", {
      result: {
        structuredOutput: { ok: true, origin: "native" },
        contentBlocks: [{ type: "text", text: '{"ok":true,"origin":"raw"}' }],
      },
    });
    const result = await executeAgentCall(
      {
        kind: "conversation_turn",
        prompt: "go",
        outputSchema: { type: "object", required: ["ok"] },
      },
      buildDepsForConversation({
        runtime,
        view: CLAUDE_VIEW,
        validate: (_schema, value) =>
          typeof value === "object" &&
          value !== null &&
          (value as { ok?: unknown }).ok === true
            ? { valid: true }
            : { valid: false, errors: ["ok must be true"] },
      }),
    );
    expect(result.outcome.kind).toBe("completed");
    if (result.outcome.kind === "completed") {
      expect(result.outcome.structuredOutput).toEqual({
        ok: true,
        origin: "native",
      });
    }
  });

  it("fails with schema_validation reporting the native candidate when no recoverable JSON exists in the text", async () => {
    const runtime = makeConversationRuntime("claude", {
      result: {
        structuredOutput: { ok: false },
        contentBlocks: [
          { type: "text", text: "No JSON of any kind in this reply." },
        ],
      },
    });
    const result = await executeAgentCall(
      {
        kind: "conversation_turn",
        prompt: "go",
        outputSchema: { type: "object", required: ["ok"] },
      },
      buildDepsForConversation({
        runtime,
        view: CLAUDE_VIEW,
        validate: (_schema, value) =>
          typeof value === "object" &&
          value !== null &&
          (value as { ok?: unknown }).ok === true
            ? { valid: true }
            : { valid: false, errors: ["ok must be true"] },
      }),
    );
    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind === "failed") {
      expect(result.outcome.error.failureKind).toBe("schema_validation");
      expect(result.outcome.error.message).toContain("ok must be true");
    }
  });
});

describe("runStructuredOutputGate", () => {
  it("returns pass when the validator accepts the value", () => {
    const gate = runStructuredOutputGate(
      { type: "object" },
      { ok: true },
      () => ({ valid: true }),
    );
    expect(gate.status).toBe("pass");
  });

  it("returns fail with normalized validation details when the validator rejects", () => {
    const gate = runStructuredOutputGate(
      { type: "object" },
      { ok: false },
      () => ({ valid: false, errors: ["expected ok=true"] }),
    );
    expect(gate.status).toBe("fail");
    if (gate.status === "fail") {
      expect(gate.kind).toBe("structured_output");
      expect(gate.reason).toContain("expected ok=true");
      expect(gate.details).toMatchObject({ errors: ["expected ok=true"] });
    }
  });

  it("treats a thrown validator error as a fail outcome rather than throwing", () => {
    const gate = runStructuredOutputGate(
      { type: "object" },
      { ok: true },
      () => {
        throw new Error("validator crashed");
      },
    );
    expect(gate.status).toBe("fail");
    if (gate.status === "fail") {
      expect(gate.reason).toContain("validator crashed");
    }
  });
});

describe("executeAgentCall — guaranteed structured-output validation", () => {
  it("uses the default JSON Schema validator when an outputSchema is set and no validator override is wired", async () => {
    const runtime = makeConversationRuntime("claude", {
      result: { structuredOutput: { ok: true } },
    });
    const result = await executeAgentCall(
      {
        kind: "conversation_turn",
        prompt: "go",
        outputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["ok"],
          properties: { ok: { type: "boolean" } },
        },
      },
      {
        resolveConversationRuntime: () => ({
          runtime,
          capabilityView: CLAUDE_VIEW,
          signal: new AbortController().signal,
        }),
      },
    );
    expect(result.outcome.kind).toBe("completed");
    if (result.outcome.kind === "completed") {
      expect(result.outcome.structuredOutput).toEqual({ ok: true });
    }
  });

  it("emits the full shared execution fields on facade-level validation logs", async () => {
    const warn = vi.fn();
    const stubLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
    };
    const runtime = makeConversationRuntime("claude", {
      result: { structuredOutput: { ok: false } },
    });
    await executeAgentCall(
      {
        kind: "conversation_turn",
        prompt: "go",
        laneRef: { workflowId: "wf-1", laneId: "lane-A" },
        outputSchema: { type: "object" },
      },
      {
        resolveConversationRuntime: () => ({
          runtime,
          capabilityView: CLAUDE_VIEW,
          signal: new AbortController().signal,
          artifacts: [
            { kind: "design_doc", relativePath: "memory-bank/d.md" },
            { kind: "transcript", relativePath: "memory-bank/t.md" },
          ],
        }),
        validateStructuredOutput: () => ({
          valid: false,
          errors: ["bad"],
        }),
        logger: stubLogger,
      },
    );
    expect(warn).toHaveBeenCalledWith(
      "agent_call.facade.structured_output_failed",
      expect.objectContaining({
        requestKind: "conversation_turn",
        backend: "claude",
        workflowId: "wf-1",
        laneId: "lane-A",
        outcome: "failed",
        artifactKinds: ["design_doc", "transcript"],
      }),
    );
  });

  it("includes artifactKinds on default-validator failure logs too", async () => {
    const warn = vi.fn();
    const stubLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
    };
    const runtime = makeConversationRuntime("claude", {
      result: { structuredOutput: { ok: true, extra: "nope" } },
    });
    await executeAgentCall(
      {
        kind: "conversation_turn",
        prompt: "go",
        laneRef: { workflowId: "wf-2", laneId: "lane-Z" },
        outputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["ok"],
          properties: { ok: { type: "boolean" } },
        },
      },
      {
        resolveConversationRuntime: () => ({
          runtime,
          capabilityView: CLAUDE_VIEW,
          signal: new AbortController().signal,
          artifacts: [{ kind: "design_doc", relativePath: "memory-bank/d.md" }],
        }),
        logger: stubLogger,
      },
    );
    expect(warn).toHaveBeenCalledWith(
      "agent_call.facade.structured_output_failed",
      expect.objectContaining({
        requestKind: "conversation_turn",
        backend: "claude",
        workflowId: "wf-2",
        laneId: "lane-Z",
        outcome: "failed",
        artifactKinds: ["design_doc"],
      }),
    );
  });
});

describe("executeAgentCall — timeout normalization across backends", () => {
  it("normalizes a task_run timeout result to the timeout failure kind", async () => {
    const runner = makeTaskRunner("codex", {
      result: { timedOut: true, text: null },
    });
    const result = await executeAgentCall(
      {
        kind: "task_run",
        backend: "codex",
        prompt: "go",
        timeoutMs: 50,
      },
      buildDepsForTask({ runner, view: CODEX_VIEW }),
    );
    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind === "failed") {
      expect(result.outcome.error.failureKind).toBe("timeout");
      expect(result.outcome.error.backend).toBe("codex");
    }
  });
});

describe("executeAgentCall — capability_unavailable for tooling", () => {
  it("returns capability_unavailable when conversation runtime cannot apply portable MCP tooling", async () => {
    const runtime = makeConversationRuntime("claude");
    const noMcpRuntime: ConversationBackendRuntime = {
      ...runtime,
      applyPortableMcpConfig: undefined,
    };
    const result = await executeAgentCall(
      {
        kind: "conversation_turn",
        prompt: "go",
        tooling: { servers: [] },
      },
      buildDepsForConversation({
        runtime: noMcpRuntime,
        view: { ...CLAUDE_VIEW, mcpApplicationBoundary: "unsupported" },
      }),
    );
    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind === "failed") {
      expect(result.outcome.error.failureKind).toBe("capability_unavailable");
    }
  });
});

describe("resolveSchedulingHint — write-capable defaults", () => {
  it("treats an unspecified write capability as write_capable so worktree safety is preserved", () => {
    const hint = resolveSchedulingHint({
      kind: "conversation_turn",
      prompt: "go",
    });
    expect(hint.writeCapability).toBe("write_capable");
    expect(hint.allowParallel).toBe(false);
  });

  it("honors an explicit read_only request and allows parallel scheduling", () => {
    const hint = resolveSchedulingHint({
      kind: "task_run",
      backend: "codex",
      prompt: "go",
      writeCapability: "read_only",
    });
    expect(hint.writeCapability).toBe("read_only");
    expect(hint.allowParallel).toBe(true);
  });

  it("honors an explicit artifact_only request and allows parallel scheduling", () => {
    const hint = resolveSchedulingHint({
      kind: "task_run",
      backend: "codex",
      prompt: "go",
      writeCapability: "artifact_only",
    });
    expect(hint.writeCapability).toBe("artifact_only");
    expect(hint.allowParallel).toBe(true);
  });

  it("treats explicit write_capable identically to the default", () => {
    const hint = resolveSchedulingHint({
      kind: "task_run",
      backend: "codex",
      prompt: "go",
      writeCapability: "write_capable",
    });
    expect(hint.writeCapability).toBe("write_capable");
    expect(hint.allowParallel).toBe(false);
  });
});

// =====================================================================
// Helpers
// =====================================================================

interface ConversationDepsHelperInput {
  runtime: ConversationBackendRuntime;
  view: BackendCapabilityView;
  validate?: (
    schema: Record<string, unknown>,
    value: unknown,
  ) => { valid: boolean; errors?: string[] };
}

function buildDepsForConversation(
  input: ConversationDepsHelperInput,
): AgentCallFacadeDeps {
  return {
    resolveConversationRuntime: () => ({
      runtime: input.runtime,
      capabilityView: input.view,
      signal: new AbortController().signal,
    }),
    resolveTaskRunner: () => {
      throw new Error("conversation deps used a task runner");
    },
    ...(input.validate ? { validateStructuredOutput: input.validate } : {}),
  };
}

interface TaskDepsHelperInput {
  runner: AgentTaskRunner;
  view: BackendCapabilityView;
  validate?: (
    schema: Record<string, unknown>,
    value: unknown,
  ) => { valid: boolean; errors?: string[] };
}

function buildDepsForTask(input: TaskDepsHelperInput): AgentCallFacadeDeps {
  return {
    resolveTaskRunner: () => ({
      runner: input.runner,
      capabilityView: input.view,
      workingDirectory: "/tmp/wt",
    }),
    resolveConversationRuntime: () => {
      throw new Error("task deps used a conversation runtime");
    },
    ...(input.validate ? { validateStructuredOutput: input.validate } : {}),
  };
}

// ---------------------------------------------------------------------------
// Absorbed pre-turn pipeline (Phase 3.1): semantic task intent, MCP apply,
// continuity recording, error normalization, widened result fields.
// ---------------------------------------------------------------------------

describe("executeAgentCall — semantic task execution intent", () => {
  it("resolves the runner via the injected registry seam from taskExecution intent", async () => {
    const capture = { value: null as AgentTaskRequest | null };
    const runner = makeTaskRunner("codex", { capture });
    const getTaskRunner = vi.fn(() => runner);

    const result = await executeAgentCall(
      {
        kind: "task_run",
        backend: "codex",
        prompt: "go",
        modelId: "gpt-5.2",
        reasoningEffort: "high",
      },
      {
        taskExecution: {
          workingDirectory: "/tmp/wt-intent",
          autonomous: true,
          resumeRef: { backend: "codex", ref: "th-9" },
        },
        getTaskRunner,
      },
    );

    expect(getTaskRunner).toHaveBeenCalledWith("codex");
    expect(result.outcome.kind).toBe("completed");
    expect(capture.value?.workingDirectory).toBe("/tmp/wt-intent");
    expect(capture.value?.resumeRef).toEqual({ backend: "codex", ref: "th-9" });
    expect(capture.value?.modelId).toBe("gpt-5.2");
    expect(capture.value?.reasoningEffort).toBe("high");
  });

  it("fails loudly when a task_run has neither taskExecution nor resolveTaskRunner", async () => {
    await expect(
      executeAgentCall({ kind: "task_run", backend: "codex", prompt: "x" }, {}),
    ).rejects.toThrow(/taskExecution.*or deps\.resolveTaskRunner/);
  });
});

describe("executeAgentCall — pre-turn MCP apply hook", () => {
  it("fails the call with capability_unavailable before dispatch when applyMcp rejects", async () => {
    const sendTurn = vi.fn();
    const runtime = makeConversationRuntime("claude");
    runtime.sendTurn = sendTurn;

    const result = await executeAgentCall(
      { kind: "conversation_turn", backend: "claude", prompt: "hi" },
      {
        resolveConversationRuntime: () => ({
          runtime,
          capabilityView: CLAUDE_VIEW,
          signal: new AbortController().signal,
        }),
        applyMcp: () => ({ ok: false, message: "MCP config rejected" }),
      },
    );

    expect(sendTurn).not.toHaveBeenCalled();
    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind === "failed") {
      expect(result.outcome.error.failureKind).toBe("capability_unavailable");
      expect(result.outcome.error.message).toBe("MCP config rejected");
      // No adapter turn result exists for a pre-dispatch failure.
      expect(result.outcome.contentBlocks).toBeUndefined();
    }
    expect(result.continuationDisposition).toBe("retain");
  });

  it("dispatches normally when applyMcp succeeds", async () => {
    const applyMcp = vi.fn(async () => ({ ok: true as const }));
    const result = await executeAgentCall(
      { kind: "conversation_turn", backend: "claude", prompt: "hi" },
      {
        resolveConversationRuntime: () => ({
          runtime: makeConversationRuntime("claude"),
          capabilityView: CLAUDE_VIEW,
          signal: new AbortController().signal,
        }),
        applyMcp,
      },
    );
    expect(applyMcp).toHaveBeenCalledTimes(1);
    expect(result.outcome.kind).toBe("completed");
  });
});

describe("executeAgentCall — continuity recording", () => {
  it("reports backendRef and continuationDisposition after a completed call", async () => {
    const recorded: unknown[] = [];
    const result = await executeAgentCall(
      { kind: "conversation_turn", backend: "claude", prompt: "hi" },
      {
        resolveConversationRuntime: () => ({
          runtime: makeConversationRuntime("claude"),
          capabilityView: CLAUDE_VIEW,
          signal: new AbortController().signal,
        }),
        recordContinuity: (record) => {
          recorded.push(record);
        },
      },
    );
    expect(result.outcome.kind).toBe("completed");
    expect(recorded).toEqual([
      {
        backend: "claude",
        backendRef: { backend: "claude", ref: "sess-1" },
        continuationDisposition: "retain",
      },
    ]);
  });

  it("never masks the turn result when recording throws", async () => {
    const result = await executeAgentCall(
      { kind: "conversation_turn", backend: "claude", prompt: "hi" },
      {
        resolveConversationRuntime: () => ({
          runtime: makeConversationRuntime("claude"),
          capabilityView: CLAUDE_VIEW,
          signal: new AbortController().signal,
        }),
        recordContinuity: () => {
          throw new Error("ledger unavailable");
        },
      },
    );
    expect(result.outcome.kind).toBe("completed");
  });
});

describe("executeAgentCall — failure normalization via the descriptor classifier", () => {
  it("normalizes a thrown conversation error into the classifier's failure kind", async () => {
    const runtime = makeConversationRuntime("claude");
    runtime.sendTurn = async () => {
      throw new Error("resume session not found");
    };
    const result = await executeAgentCall(
      { kind: "conversation_turn", backend: "claude", prompt: "hi" },
      {
        resolveConversationRuntime: () => ({
          runtime,
          capabilityView: CLAUDE_VIEW,
          signal: new AbortController().signal,
        }),
        getFailureClassifier: () => {
          const classify = (error: unknown) => ({
            kind: "stale_resume_ref" as const,
            message: error instanceof Error ? error.message : String(error),
            retryable: true,
          });
          return {
            classify,
            classifyWithContinuation: (error: unknown) => ({
              failure: classify(error),
              continuationDisposition: "clear",
            }),
          };
        },
      },
    );
    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind === "failed") {
      expect(result.outcome.error.failureKind).toBe("stale_resume_ref");
      expect(result.outcome.error.message).toBe("resume session not found");
    }
    expect(result.backendRef).toBeNull();
    expect(result.continuationDisposition).toBe("clear");
  });

  it("preserves a task adapter's classified failure and continuation verdict", async () => {
    const runner = makeTaskRunner("codex", {
      result: {
        backendRef: null,
        error: "failed to resume codex thread th-1",
        text: null,
        failure: {
          kind: "stale_resume_ref",
          message: "failed to resume codex thread th-1",
          retryable: true,
        },
        continuationDisposition: "clear",
      },
    });
    const classify = vi.fn((_error?: unknown) => ({
      kind: "stale_resume_ref" as const,
      message: "failed to resume codex thread th-1",
      retryable: true,
    }));
    const result = await executeAgentCall(
      { kind: "task_run", backend: "codex", prompt: "go" },
      {
        taskExecution: { workingDirectory: "/tmp/wt" },
        getTaskRunner: () => runner,
        getFailureClassifier: () => ({
          classify,
          classifyWithContinuation: (error) => ({
            failure: classify(error),
            continuationDisposition: "clear",
          }),
        }),
      },
    );
    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind === "failed") {
      expect(result.outcome.error.failureKind).toBe("stale_resume_ref");
    }
    expect(classify).not.toHaveBeenCalled();
    expect(result.continuationDisposition).toBe("clear");
  });
});

describe("executeAgentCall — widened result fields", () => {
  it("stamps parse metadata when the gate accepts a fenced candidate", async () => {
    const runtime = makeConversationRuntime("claude", {
      result: {
        contentBlocks: [
          { type: "text", text: 'result:\n```json\n{"answer":7}\n```' },
        ],
        structuredOutput: undefined,
      },
    });
    const result = await executeAgentCall(
      {
        kind: "conversation_turn",
        backend: "claude",
        prompt: "hi",
        outputSchema: {
          type: "object",
          properties: { answer: { type: "number" } },
          required: ["answer"],
        },
      },
      buildDepsForConversation({ runtime, view: CLAUDE_VIEW }),
    );
    expect(result.outcome.kind).toBe("completed");
    if (result.outcome.kind === "completed") {
      expect(result.outcome.structuredOutput).toEqual({ answer: 7 });
      expect(result.outcome.parse).toEqual({ source: "fenced" });
    }
  });

  it("carries numTurns and contentBlocks on the completed conversation outcome", async () => {
    const result = await executeAgentCall(
      { kind: "conversation_turn", backend: "claude", prompt: "hi" },
      buildDepsForConversation({
        runtime: makeConversationRuntime("claude"),
        view: CLAUDE_VIEW,
      }),
    );
    expect(result.outcome.kind).toBe("completed");
    if (result.outcome.kind === "completed") {
      expect(result.outcome.numTurns).toBe(1);
      expect(result.outcome.contentBlocks).toEqual([
        { type: "text", text: "hi" },
      ]);
    }
  });

  it("keeps partial content and the adapter verdict on a gate downgrade", async () => {
    const runtime = makeConversationRuntime("codex", {
      result: {
        contentBlocks: [{ type: "text", text: "not json" }],
        structuredOutput: undefined,
      },
    });
    const result = await executeAgentCall(
      {
        kind: "conversation_turn",
        backend: "codex",
        prompt: "hi",
        outputSchema: { type: "object", required: ["answer"] },
      },
      buildDepsForConversation({ runtime, view: CODEX_VIEW }),
    );
    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind === "failed") {
      expect(result.outcome.error.failureKind).toBe("schema_validation");
      expect(result.outcome.contentBlocks).toEqual([
        { type: "text", text: "not json" },
      ]);
    }
    expect(result.continuationDisposition).toBe("retain");
  });
});
