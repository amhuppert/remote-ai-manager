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
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import { createStubFailureClassifier } from "@/lib/agent-backends/errors";
import {
  STRUCTURED_OUTPUT_REPAIR_MAX_ISSUE_PATHS,
  STRUCTURED_OUTPUT_REPAIR_MAX_ISSUE_PATH_CHARS,
} from "@/lib/agent-backends/structured-output-repair";
import {
  buildStructuredOutputRepairRequest,
  executeAgentCall,
  resolveSchedulingHint,
  type AgentCallFacadeDeps,
} from "./agent-call-facade";
import { runStructuredOutputGate } from "./structured-output-gate";
import {
  agentCallRequestSchema,
  type ArtifactRef,
  type BackendCapabilityView,
} from "./agent-call-vocabulary";

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
  structuredOutputEnforcement: "post_validation",
  mcpApplicationBoundary: "per_request",
  contextMetricsAvailable: false,
  nativeMidTurnAskUser: false,
};

const CLAUDE_SELECTION: BackendModelSelection = {
  modelId: "sonnet",
  parameters: { effort: "high" },
};

const CODEX_SELECTION: BackendModelSelection = {
  modelId: "gpt-5.2",
  parameters: {
    reasoning: "high",
    fast: "false",
  },
};

const CURSOR_SELECTION: BackendModelSelection = {
  modelId: "composer-2.5",
  parameters: {},
};

function selectionForBackend(
  backend: BackendCapabilityView["backend"],
): BackendModelSelection {
  if (backend === "codex") return CODEX_SELECTION;
  if (backend === "cursor") return CURSOR_SELECTION;
  return CLAUDE_SELECTION;
}

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
    modelSelection: selectionForBackend(backend),
    outputFormat: undefined,

    async sendTurn(input) {
      if (opts.capture) opts.capture.value = input;
      return { ...baseResult, ...(opts.result ?? {}) };
    },
    async close() {},
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
      {
        executionClass: "ordinary-conversation" as const,
        kind: "conversation_turn",
        prompt: "hi",
      },
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
        executionClass: "ordinary-conversation" as const,
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
      {
        executionClass: "nongoverned-task" as const,
        kind: "task_run",
        backend: "codex",
        prompt: "hi",
      },
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
        modelSelection: CODEX_SELECTION,
      }),
      resolveTaskRunner: () => {
        throw new Error("should not run task runner");
      },
    };
    const result = await executeAgentCall(
      {
        executionClass: "ordinary-conversation" as const,
        kind: "conversation_turn",
        prompt: "go",
      },
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

  it("rejects a misplaced model parameter before default-backend dispatch", async () => {
    const capture = { value: null as ConversationBackendTurnInput | null };
    const runtime = makeConversationRuntime("claude", { capture });

    await expect(
      executeAgentCall(
        {
          kind: "conversation_turn",
          prompt: "hi",
          model: "opus",
        } as unknown as Parameters<typeof executeAgentCall>[0],
        buildDepsForConversation({ runtime, view: CLAUDE_VIEW }),
      ),
    ).rejects.toThrow();
    expect(capture.value).toBeNull();
  });
});

describe("executeAgentCall — structured-output gate", () => {
  it("returns completed when validation passes for a conversation turn", async () => {
    const runtime = makeConversationRuntime("claude", {
      result: { structuredOutput: { ok: true } },
    });
    const result = await executeAgentCall(
      {
        executionClass: "ordinary-conversation" as const,
        kind: "conversation_turn",
        backend: "claude",
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
        executionClass: "ordinary-conversation" as const,
        kind: "conversation_turn",
        backend: "claude",
        prompt: "go",
        outputSchema: { type: "object", required: ["ok"] },
        structuredOutputRepair: { maxAttempts: 0 },
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

  it("validates Codex raw JSON through the shared gate", async () => {
    let validatorCalls = 0;
    const runner = makeTaskRunner("codex", {
      result: { text: JSON.stringify({ ok: true }) },
    });
    await executeAgentCall(
      {
        executionClass: "nongoverned-task" as const,
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
        executionClass: "ordinary-conversation" as const,
        kind: "conversation_turn",
        backend: "claude",
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
      {
        executionClass: "ordinary-conversation" as const,
        kind: "conversation_turn",
        prompt: "go",
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
        executionClass: "ordinary-conversation" as const,
        kind: "conversation_turn",
        backend: "claude",
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
        executionClass: "ordinary-conversation" as const,
        kind: "conversation_turn",
        backend: "claude",
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
        executionClass: "ordinary-conversation" as const,
        kind: "conversation_turn",
        backend: "claude",
        prompt: "go",
        outputSchema: { type: "object", required: ["ok"] },
        structuredOutputRepair: { maxAttempts: 0 },
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
        executionClass: "ordinary-conversation" as const,
        kind: "conversation_turn",
        backend: "claude",
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
        executionClass: "ordinary-conversation" as const,
        kind: "conversation_turn",
        backend: "claude",
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
        executionClass: "ordinary-conversation" as const,
        kind: "conversation_turn",
        backend: "claude",
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
        executionClass: "ordinary-conversation" as const,
        kind: "conversation_turn",
        backend: "claude",
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
        executionClass: "ordinary-conversation" as const,
        kind: "conversation_turn",
        backend: "claude",
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
          modelSelection: CLAUDE_SELECTION,
        }),
      },
    );
    expect(result.outcome.kind).toBe("completed");
    if (result.outcome.kind === "completed") {
      expect(result.outcome.structuredOutput).toEqual({ ok: true });
    }
  });
});

describe("executeAgentCall — timeout normalization across backends", () => {
  it("normalizes a task_run timeout result to the timeout failure kind", async () => {
    const runner = makeTaskRunner("codex", {
      result: { timedOut: true, text: null },
    });
    const result = await executeAgentCall(
      {
        executionClass: "nongoverned-task" as const,
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
        executionClass: "ordinary-conversation" as const,
        kind: "conversation_turn",
        backend: "claude",
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
      executionClass: "ordinary-conversation" as const,
      kind: "conversation_turn",
      prompt: "go",
    });
    expect(hint.writeCapability).toBe("write_capable");
    expect(hint.allowParallel).toBe(false);
  });

  it("honors an explicit artifact_only request and allows parallel scheduling", () => {
    const hint = resolveSchedulingHint({
      executionClass: "nongoverned-task" as const,
      kind: "task_run",
      backend: "codex",
      prompt: "go",
      writeCapability: "artifact_only",
    });
    expect(hint.writeCapability).toBe("artifact_only");
    expect(hint.allowParallel).toBe(true);
  });
});

// =====================================================================
// Helpers
// =====================================================================

interface ConversationDepsHelperInput {
  runtime: ConversationBackendRuntime;
  view: BackendCapabilityView;
  artifacts?: readonly ArtifactRef[];
  validate?: (
    schema: Record<string, unknown>,
    value: unknown,
  ) => { valid: boolean; errors?: string[] };
}

function buildDepsForConversation(
  input: ConversationDepsHelperInput,
): AgentCallFacadeDeps {
  return {
    defaultConversationBackend: input.runtime.backend,
    resolveConversationRuntime: () => ({
      runtime: input.runtime,
      capabilityView: input.view,
      signal: new AbortController().signal,
      modelSelection: selectionForBackend(input.view.backend),
      ...(input.artifacts !== undefined ? { artifacts: input.artifacts } : {}),
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
  artifacts?: readonly ArtifactRef[];
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
      modelSelection: selectionForBackend(input.view.backend),
      ...(input.artifacts !== undefined ? { artifacts: input.artifacts } : {}),
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
        executionClass: "nongoverned-task" as const,
        kind: "task_run",
        backend: "codex",
        prompt: "go",
        modelSelection: CODEX_SELECTION,
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
    expect(capture.value?.modelSelection).toEqual(CODEX_SELECTION);
  });

  it("fails loudly when a task_run has neither taskExecution nor resolveTaskRunner", async () => {
    await expect(
      executeAgentCall(
        {
          executionClass: "nongoverned-task" as const,
          kind: "task_run",
          backend: "codex",
          prompt: "x",
        },
        {},
      ),
    ).rejects.toThrow(/taskExecution.*or deps\.resolveTaskRunner/);
  });

  it("refuses semantic task dispatch without one complete model selection", async () => {
    const getTaskRunner = vi.fn(() => makeTaskRunner("codex"));

    await expect(
      executeAgentCall(
        {
          executionClass: "nongoverned-task" as const,
          kind: "task_run",
          backend: "codex",
          prompt: "x",
        },
        {
          taskExecution: { workingDirectory: "/tmp/wt" },
          getTaskRunner,
        },
      ),
    ).rejects.toThrow(/requires request\.modelSelection/);
    expect(getTaskRunner).not.toHaveBeenCalled();
  });

  it("grants no CC session scope from the intent path — every graph-workflow and generic task run stays neutralized", async () => {
    const capture = { value: null as AgentTaskRequest | null };
    const runner = makeTaskRunner("codex", { capture });

    // Every graph-workflow task run (validator, planner, implementer) and every
    // generic conversation task run dispatches through this intent path, which
    // has no way to name a session; only a resolver-callback caller that owns
    // the originating session can grant identity.
    await executeAgentCall(
      {
        executionClass: "nongoverned-task" as const,
        kind: "task_run",
        backend: "codex",
        prompt: "go",
        modelSelection: CODEX_SELECTION,
      },
      {
        taskExecution: {
          workingDirectory: "/tmp/wt-graph",
          autonomous: true,
          sandboxMode: "danger-full-access",
          approvalPolicy: "never",
          skipGitRepoCheck: true,
          networkAccessEnabled: true,
        },
        getTaskRunner: () => runner,
      },
    );

    expect(capture.value?.ccSessionScope).toBeUndefined();
  });

  it("carries a request-borne write policy through task resolution onto the runner request", async () => {
    const capture = { value: null as AgentTaskRequest | null };
    const runner = makeTaskRunner("codex", { capture });

    await executeAgentCall(
      {
        executionClass: "governed-execution" as const,
        kind: "task_run",
        backend: "codex",
        prompt: "review",
        modelSelection: CODEX_SELECTION,
        writeCapability: "read_only",
        fsWritePolicy: {
          mode: "allowlist",
          allowWrite: ["/private/tmp/lane", "/private/tmp/lane/tmp"],
          denyWrite: ["/private/repo/worktree"],
        },
      },
      {
        taskExecution: {
          workingDirectory: "/private/tmp/lane",
          autonomous: true,
        },
        getTaskRunner: () => runner,
      },
    );

    expect(capture.value?.fsWritePolicy).toEqual({
      mode: "allowlist",
      allowWrite: ["/private/tmp/lane", "/private/tmp/lane/tmp"],
      denyWrite: ["/private/repo/worktree"],
    });
  });

  it("keeps the request's write policy when a resolver-callback resolution omits one", async () => {
    const capture = { value: null as AgentTaskRequest | null };
    const runner = makeTaskRunner("codex", { capture });

    // The policy is server-derived at the dispatch site; a resolver seam that
    // knows nothing about it must not be able to drop the lane's restriction.
    await executeAgentCall(
      {
        executionClass: "governed-execution" as const,
        kind: "task_run",
        backend: "codex",
        prompt: "review",
        fsWritePolicy: {
          mode: "allowlist",
          allowWrite: ["/private/tmp/lane"],
          denyWrite: ["/private/repo/worktree"],
        },
      },
      {
        resolveTaskRunner: () => ({
          runner,
          capabilityView: CODEX_VIEW,
          workingDirectory: "/private/tmp/lane",
          modelSelection: CODEX_SELECTION,
        }),
      },
    );

    expect(capture.value?.fsWritePolicy).toEqual({
      mode: "allowlist",
      allowWrite: ["/private/tmp/lane"],
      denyWrite: ["/private/repo/worktree"],
    });
  });

  it("forwards a resolver-supplied CC session scope verbatim to the runner", async () => {
    const capture = { value: null as AgentTaskRequest | null };
    const runner = makeTaskRunner("codex", { capture });

    await executeAgentCall(
      {
        executionClass: "nongoverned-task" as const,
        kind: "task_run",
        backend: "codex",
        prompt: "go",
      },
      {
        resolveTaskRunner: () => ({
          runner,
          capabilityView: CODEX_VIEW,
          workingDirectory: "/tmp/wt-collab",
          modelSelection: CODEX_SELECTION,
          ccSessionScope: {
            project: "example",
            session: "sess-1",
            conversationId: "conv-originating",
          },
        }),
      },
    );

    expect(capture.value?.ccSessionScope).toEqual({
      project: "example",
      session: "sess-1",
      conversationId: "conv-originating",
    });
  });

  it("forwards a resolver-supplied atomic selection to the runner", async () => {
    const capture = { value: null as AgentTaskRequest | null };
    const runner = makeTaskRunner("codex", { capture });

    await executeAgentCall(
      {
        executionClass: "nongoverned-task" as const,
        kind: "task_run",
        backend: "codex",
        prompt: "go",
      },
      {
        resolveTaskRunner: () => ({
          runner,
          capabilityView: CODEX_VIEW,
          workingDirectory: "/tmp/wt-collab",
          modelSelection: CODEX_SELECTION,
        }),
      },
    );

    expect(capture.value?.modelSelection).toEqual(CODEX_SELECTION);
  });
});

describe("executeAgentCall — pre-turn MCP apply hook", () => {
  it("fails the call with capability_unavailable before dispatch when applyMcp rejects", async () => {
    const sendTurn = vi.fn();
    const runtime = makeConversationRuntime("claude");
    runtime.sendTurn = sendTurn;

    const result = await executeAgentCall(
      {
        executionClass: "ordinary-conversation" as const,
        kind: "conversation_turn",
        backend: "claude",
        prompt: "hi",
      },
      {
        resolveConversationRuntime: () => ({
          runtime,
          capabilityView: CLAUDE_VIEW,
          signal: new AbortController().signal,
          modelSelection: CLAUDE_SELECTION,
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
});

describe("executeAgentCall — continuity recording", () => {
  it("reports backendRef and continuationDisposition after a completed call", async () => {
    const recorded: unknown[] = [];
    const result = await executeAgentCall(
      {
        executionClass: "ordinary-conversation" as const,
        kind: "conversation_turn",
        backend: "claude",
        prompt: "hi",
      },
      {
        resolveConversationRuntime: () => ({
          runtime: makeConversationRuntime("claude"),
          capabilityView: CLAUDE_VIEW,
          signal: new AbortController().signal,
          modelSelection: CLAUDE_SELECTION,
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
      {
        executionClass: "ordinary-conversation" as const,
        kind: "conversation_turn",
        backend: "claude",
        prompt: "hi",
      },
      {
        resolveConversationRuntime: () => ({
          runtime: makeConversationRuntime("claude"),
          capabilityView: CLAUDE_VIEW,
          signal: new AbortController().signal,
          modelSelection: CLAUDE_SELECTION,
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
      {
        executionClass: "ordinary-conversation" as const,
        kind: "conversation_turn",
        backend: "claude",
        prompt: "hi",
      },
      {
        resolveConversationRuntime: () => ({
          runtime,
          capabilityView: CLAUDE_VIEW,
          signal: new AbortController().signal,
          modelSelection: CLAUDE_SELECTION,
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
      {
        executionClass: "nongoverned-task" as const,
        kind: "task_run",
        backend: "codex",
        prompt: "go",
        modelSelection: CODEX_SELECTION,
      },
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
        executionClass: "ordinary-conversation" as const,
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

  it("keeps partial content and the adapter verdict on a gate downgrade", async () => {
    const runtime = makeConversationRuntime("codex", {
      result: {
        contentBlocks: [{ type: "text", text: "not json" }],
        structuredOutput: undefined,
      },
    });
    const result = await executeAgentCall(
      {
        executionClass: "ordinary-conversation" as const,
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

describe("executeAgentCall — structured-output repair", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      artifacts: { type: "array" },
      summary: { type: "string" },
    },
    required: ["summary", "artifacts"],
  };

  it("repairs a task_run in one fresh isolated call while preserving the original continuation", async () => {
    const requests: AgentTaskRequest[] = [];
    const resolveTaskRunner = vi.fn();
    const recordContinuity = vi.fn();
    const info = vi.fn();
    const initialTranscript = [
      {
        seq: 0,
        backend: "codex" as const,
        type: "agent_message",
        raw: { type: "agent_message", text: "malformed manifest" },
      },
    ];
    const repairedTranscript = [
      {
        seq: 0,
        backend: "codex" as const,
        type: "agent_message",
        raw: { type: "agent_message", text: "repaired manifest" },
      },
    ];
    const validOutput = { summary: "repaired", artifacts: [] };
    const repairClock = [1_000, 39_600];
    const runner: AgentTaskRunner = {
      backend: "codex",
      async run(input) {
        requests.push(input);
        if (requests.length === 1) {
          return {
            backendRef: { backend: "codex", ref: "thread-original" },
            text: JSON.stringify({
              summary: "all artifact content was trapped in this single field",
            }),
            usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.1 },
            error: null,
            timedOut: false,
            failure: null,
            continuationDisposition: "retain",
            transcript: initialTranscript,
          };
        }
        return {
          backendRef: null,
          text: JSON.stringify(validOutput),
          usage: { inputTokens: 3, outputTokens: 2, costUsd: 0.2 },
          error: null,
          timedOut: false,
          failure: null,
          continuationDisposition: "retain",
          transcript: repairedTranscript,
        };
      },
    };
    resolveTaskRunner.mockReturnValue({
      runner,
      capabilityView: CODEX_VIEW,
      workingDirectory: "/tmp/wt",
      modelSelection: CODEX_SELECTION,
      autonomous: true,
      resumeRef: { backend: "codex", ref: "thread-before-call" },
      artifacts: [
        { kind: "design_doc", relativePath: "memory-bank/already-written.md" },
      ],
      ccSessionScope: {
        project: "example",
        session: "sess-1",
        conversationId: "conv-originating",
      },
      conversationTarget: {
        scope: "session",
        projectName: "example",
        sessionName: "sess-1",
        conversationId: "conv-originating",
      },
    });

    const result = await executeAgentCall(
      {
        executionClass: "nongoverned-task" as const,
        kind: "task_run",
        backend: "codex",
        prompt: "produce a manifest",
        systemInstructions: "use the project tools",
        tooling: { servers: [] },
        imageRefs: [
          {
            index: 1,
            mediaType: "image/png",
            path: "/tmp/reference.png",
            base64Data: "image-data",
          },
        ],
        outputSchema: schema,
      },
      {
        resolveTaskRunner,
        recordContinuity,
        // Advances only across the repair dispatch, so the reported duration is
        // the repair's own cost and not the whole call's.
        now: () => repairClock.shift() ?? 0,
        logger: {
          debug: vi.fn(),
          info,
          warn: vi.fn(),
          error: vi.fn(),
        },
      },
    );

    expect(repairClock).toHaveLength(0);
    expect(resolveTaskRunner).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.modelSelection).toEqual(CODEX_SELECTION);
    expect(requests[1]?.modelSelection).toEqual(CODEX_SELECTION);
    expect(requests[1]).toMatchObject({
      executionProfile: "isolated-one-shot",
      resumeRef: null,
      outputSchema: schema,
    });
    // The repair is an isolated one-shot, but it must still run under the
    // instructions that governed the original call.
    expect(requests[1]?.systemInstructions).toEqual(["use the project tools"]);
    expect(requests[1]?.tooling).toBeUndefined();
    expect(requests[1]?.imagePaths).toBeUndefined();
    // The governed call may act as its originating conversation; its repair is
    // a hermetic one-shot and must not (spec memory R10).
    expect(requests[0]?.ccSessionScope).toEqual({
      project: "example",
      session: "sess-1",
      conversationId: "conv-originating",
    });
    expect(requests[1]?.ccSessionScope).toBeUndefined();
    expect(requests[0]?.conversationTarget?.conversationId).toBe(
      "conv-originating",
    );
    expect(requests[1]?.conversationTarget).toBeUndefined();
    expect(result.backendRef).toEqual({
      backend: "codex",
      ref: "thread-original",
    });
    expect(result.usage.costUsd).toBeCloseTo(0.3);
    expect(result.outcome.kind).toBe("completed");
    if (result.outcome.kind === "completed") {
      expect(result.outcome.text).toBe(JSON.stringify(validOutput));
      expect(result.outcome.structuredOutput).toEqual(validOutput);
      expect(result.outcome.transcript).toEqual(repairedTranscript);
      expect(result.outcome.parse).toEqual({
        source: "raw_json",
        repaired: true,
        repairAttempts: 1,
      });
    }
    expect(recordContinuity).toHaveBeenCalledTimes(1);
    expect(recordContinuity).toHaveBeenCalledWith({
      backend: "codex",
      backendRef: { backend: "codex", ref: "thread-original" },
      continuationDisposition: "retain",
    });
    expect(info).toHaveBeenCalledWith(
      "agent_call.facade.structured_output_repair_attempted",
      expect.objectContaining({
        backend: "codex",
        requestKind: "task_run",
        attempt: 1,
        issuePaths: ["$.artifacts"],
        // The cost being repeated is what makes a repair worth bounding, so the
        // attempt line carries the baseline it is about to spend against.
        initialCostUsd: 0.1,
        initialInputTokens: 10,
        initialOutputTokens: 5,
      }),
    );
    // A repair that costs a fraction of the original is a different decision
    // from one that doubles it. No backend reports a task run's elapsed time,
    // so the facade measures the repair itself and reports it beside the
    // baseline tokens — the ratio needs no join across events.
    expect(info).toHaveBeenCalledWith(
      "agent_call.facade.structured_output_repair_succeeded",
      expect.objectContaining({
        backend: "codex",
        requestKind: "task_run",
        attempt: 1,
        repairDurationMs: 38_600,
        repairCostUsd: 0.2,
        repairInputTokens: 3,
        repairOutputTokens: 2,
        initialCostUsd: 0.1,
      }),
    );
  });

  it("repairs a conversation_turn on the same runtime and returns the accepted turn content", async () => {
    const turnInputs: ConversationBackendTurnInput[] = [];
    const resolveConversationRuntime = vi.fn();
    const applyMcp = vi.fn(() => ({ ok: true as const }));
    const recordContinuity = vi.fn();
    const validOutput = { summary: "repaired", artifacts: [] };
    const backgroundWait = {
      waitedTaskIds: ["task-1"],
      settledTaskIds: ["task-1"],
      timedOut: false,
      durationMs: 20,
    };
    const runtime: ConversationBackendRuntime = {
      backend: "claude",
      status: "alive",
      modelSelection: CLAUDE_SELECTION,
      outputFormat: undefined,

      async sendTurn(input) {
        turnInputs.push(input);
        const text =
          turnInputs.length === 1
            ? JSON.stringify({
                summary:
                  "all artifact content was trapped in this single field",
              })
            : JSON.stringify(validOutput);
        return {
          backendRef: {
            backend: "claude",
            ref: turnInputs.length === 1 ? "session-initial" : "session-repair",
          },
          costUsd: null,
          durationMs: 10,
          numTurns: turnInputs.length === 1 ? 2 : 3,
          contextTokens: 100,
          contextWindowMax: 200_000,
          contentBlocks: [{ type: "text", text }],
          structuredOutput: undefined,
          aborted: false,
          compacted: turnInputs.length === 1,
          failure: null,
          continuationDisposition: "retain",
          ...(turnInputs.length === 1 ? { backgroundWait } : {}),
        };
      },
      async close() {},
    };
    resolveConversationRuntime.mockReturnValue({
      runtime,
      capabilityView: CLAUDE_VIEW,
      signal: new AbortController().signal,
      modelSelection: CLAUDE_SELECTION,
      imageRefs: [
        {
          index: 1,
          mediaType: "image/png",
          path: "/tmp/reference.png",
          base64Data: "image-data",
        },
      ],
    });

    const result = await executeAgentCall(
      {
        executionClass: "ordinary-conversation" as const,
        kind: "conversation_turn",
        backend: "claude",
        prompt: "produce a manifest",
        outputSchema: schema,
      },
      {
        resolveConversationRuntime,
        applyMcp,
        recordContinuity,
      },
    );

    expect(resolveConversationRuntime).toHaveBeenCalledTimes(1);
    expect(applyMcp).toHaveBeenCalledTimes(1);
    expect(turnInputs).toHaveLength(2);
    expect(turnInputs[0]?.modelSelection).toEqual(CLAUDE_SELECTION);
    expect(turnInputs[1]?.modelSelection).toEqual(CLAUDE_SELECTION);
    expect(turnInputs[1]?.imageRefs).toEqual([]);
    expect(turnInputs[1]?.promptText).toContain("$.artifacts is required");
    expect(turnInputs[1]?.promptText).toContain(
      'Decoded top-level keys were ["summary"]',
    );
    expect(turnInputs[1]?.outputFormat).toEqual({
      type: "json_schema",
      schema,
    });
    expect(result.backendRef).toEqual({
      backend: "claude",
      ref: "session-repair",
    });
    expect(result.outcome.kind).toBe("completed");
    if (result.outcome.kind === "completed") {
      expect(result.outcome.text).toBe(JSON.stringify(validOutput));
      expect(result.outcome.contentBlocks).toEqual([
        { type: "text", text: JSON.stringify(validOutput) },
      ]);
      expect(result.outcome.structuredOutput).toEqual(validOutput);
      expect(result.outcome.parse).toEqual({
        source: "raw_json",
        repaired: true,
        repairAttempts: 1,
      });
      expect(result.outcome.numTurns).toBe(5);
    }
    expect(result.compacted).toBe(true);
    expect(result.backgroundWait).toEqual(backgroundWait);
    expect(recordContinuity).toHaveBeenCalledTimes(1);
    expect(recordContinuity).toHaveBeenCalledWith({
      backend: "claude",
      backendRef: { backend: "claude", ref: "session-repair" },
      continuationDisposition: "retain",
    });
  });

  it("bounds the count and length of logged validation issue paths", async () => {
    const info = vi.fn();
    let calls = 0;
    const runner: AgentTaskRunner = {
      backend: "codex",
      async run() {
        calls += 1;
        return {
          backendRef: { backend: "codex", ref: "thread-original" },
          text: JSON.stringify({ ok: calls > 1 }),
          usage: null,
          error: null,
          timedOut: false,
          failure: null,
          continuationDisposition: "retain",
        };
      },
    };
    const issues = Array.from(
      { length: STRUCTURED_OUTPUT_REPAIR_MAX_ISSUE_PATHS + 1 },
      (_, index) =>
        `$.key${index}${"x".repeat(
          STRUCTURED_OUTPUT_REPAIR_MAX_ISSUE_PATH_CHARS,
        )} is invalid`,
    );

    await executeAgentCall(
      {
        executionClass: "nongoverned-task" as const,
        kind: "task_run",
        backend: "codex",
        prompt: "produce a manifest",
        outputSchema: { type: "object" },
      },
      {
        ...buildDepsForTask({ runner, view: CODEX_VIEW }),
        validateStructuredOutput: (_schema, value) =>
          (value as { ok?: unknown }).ok === true
            ? { valid: true }
            : { valid: false, errors: issues },
        logger: {
          debug: vi.fn(),
          info,
          warn: vi.fn(),
          error: vi.fn(),
        },
      },
    );

    const attempted = info.mock.calls.find(
      ([event]) =>
        event === "agent_call.facade.structured_output_repair_attempted",
    );
    const issuePaths = (attempted?.[1] as { issuePaths?: string[] })
      ?.issuePaths;
    expect(issuePaths?.length).toBeLessThanOrEqual(
      STRUCTURED_OUTPUT_REPAIR_MAX_ISSUE_PATHS,
    );
    expect(
      issuePaths?.every(
        (path) => path.length <= STRUCTURED_OUTPUT_REPAIR_MAX_ISSUE_PATH_CHARS,
      ),
    ).toBe(true);
  });

  it("returns enriched schema_validation details while preserving original task evidence after repair fails", async () => {
    const requests: AgentTaskRequest[] = [];
    const warn = vi.fn();
    const initialTranscript = [
      {
        seq: 0,
        backend: "codex" as const,
        type: "agent_message",
        raw: { type: "agent_message", text: "original evidence" },
      },
    ];
    const runner: AgentTaskRunner = {
      backend: "codex",
      async run(input) {
        requests.push(input);
        return {
          backendRef:
            requests.length === 1
              ? { backend: "codex", ref: "thread-original" }
              : null,
          text: JSON.stringify({ summary: `invalid-${requests.length}` }),
          usage: null,
          error: null,
          timedOut: false,
          failure: null,
          continuationDisposition: "retain",
          transcript:
            requests.length === 1
              ? initialTranscript
              : [
                  {
                    seq: 0,
                    backend: "codex" as const,
                    type: "agent_message",
                    raw: { type: "agent_message", text: "repair evidence" },
                  },
                ],
        };
      },
    };

    const result = await executeAgentCall(
      {
        executionClass: "nongoverned-task" as const,
        kind: "task_run",
        backend: "codex",
        prompt: "produce a manifest",
        outputSchema: schema,
      },
      {
        resolveTaskRunner: () => ({
          runner,
          capabilityView: CODEX_VIEW,
          workingDirectory: "/tmp/wt",
          modelSelection: CODEX_SELECTION,
          artifacts: [
            {
              kind: "design_doc",
              relativePath: "memory-bank/already-written.md",
            },
          ],
        }),
        logger: {
          debug: vi.fn(),
          info: vi.fn(),
          warn,
          error: vi.fn(),
        },
      },
    );

    expect(requests).toHaveLength(2);
    expect(result.backendRef).toEqual({
      backend: "codex",
      ref: "thread-original",
    });
    expect(result.artifacts).toEqual([
      {
        kind: "design_doc",
        relativePath: "memory-bank/already-written.md",
      },
    ]);
    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind === "failed") {
      expect(result.outcome.error.failureKind).toBe("schema_validation");
      expect(result.outcome.transcript).toEqual(initialTranscript);
      expect(result.outcome.error.backendDetails).toMatchObject({
        errors: ["$.artifacts is required"],
        candidateSources: ["raw_json"],
        candidateTopLevelKeys: ["summary"],
        repairAttempts: 1,
      });
    }
    expect(warn).toHaveBeenCalledWith(
      "agent_call.facade.structured_output_repair_failed",
      expect.objectContaining({
        backend: "codex",
        requestKind: "task_run",
        attempt: 1,
      }),
    );
    expect(warn).toHaveBeenCalledWith(
      "agent_call.facade.structured_output_failed",
      expect.objectContaining({
        candidateSources: ["raw_json"],
        candidateTopLevelKeys: ["summary"],
        repairAttempts: 1,
      }),
    );
  });

  it("preserves original conversation content blocks after a failed repair", async () => {
    let turns = 0;
    const originalBlocks = [
      { type: "text" as const, text: JSON.stringify({ summary: "original" }) },
    ];
    const backgroundWait = {
      waitedTaskIds: ["task-1"],
      settledTaskIds: ["task-1"],
      timedOut: false,
      durationMs: 20,
    };
    const runtime = makeConversationRuntime("claude");
    runtime.sendTurn = async () => {
      turns += 1;
      return {
        backendRef: {
          backend: "claude",
          ref: turns === 1 ? "session-initial" : "session-repair",
        },
        costUsd: null,
        durationMs: 10,
        numTurns: turns === 1 ? 2 : 3,
        contextTokens: 100,
        contextWindowMax: 200_000,
        contentBlocks:
          turns === 1
            ? originalBlocks
            : [{ type: "text", text: JSON.stringify({ summary: "repair" }) }],
        structuredOutput: undefined,
        aborted: false,
        compacted: turns === 1,
        failure: null,
        continuationDisposition: "retain",
        ...(turns === 1 ? { backgroundWait } : {}),
      };
    };

    const result = await executeAgentCall(
      {
        executionClass: "ordinary-conversation" as const,
        kind: "conversation_turn",
        backend: "claude",
        prompt: "produce a manifest",
        outputSchema: schema,
      },
      buildDepsForConversation({ runtime, view: CLAUDE_VIEW }),
    );

    expect(turns).toBe(2);
    expect(result.backendRef).toEqual({
      backend: "claude",
      ref: "session-repair",
    });
    expect(result.continuationDisposition).toBe("retain");
    expect(result.compacted).toBe(true);
    expect(result.backgroundWait).toEqual(backgroundWait);
    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind === "failed") {
      expect(result.outcome.contentBlocks).toEqual(originalBlocks);
      expect(result.outcome.numTurns).toBe(5);
    }
  });

  it("propagates an aborted conversation repair with latest continuity and original evidence", async () => {
    let turns = 0;
    const originalBlocks = [
      { type: "text" as const, text: JSON.stringify({ summary: "original" }) },
    ];
    const artifacts = [
      { kind: "design_doc", relativePath: "memory-bank/already-written.md" },
    ];
    const runtime = makeConversationRuntime("claude");
    runtime.sendTurn = async () => {
      turns += 1;
      if (turns === 1) {
        return {
          backendRef: { backend: "claude", ref: "session-initial" },
          costUsd: 0.01,
          durationMs: 10,
          numTurns: 2,
          contextTokens: 100,
          contextWindowMax: 200_000,
          contentBlocks: originalBlocks,
          structuredOutput: undefined,
          aborted: false,
          compacted: true,
          failure: null,
          continuationDisposition: "retain",
        };
      }
      return {
        backendRef: { backend: "claude", ref: "session-repair" },
        costUsd: 0.02,
        durationMs: 20,
        numTurns: 1,
        contextTokens: 200,
        contextWindowMax: 200_000,
        contentBlocks: [{ type: "text", text: "repair cancelled" }],
        structuredOutput: undefined,
        aborted: true,
        compacted: false,
        failure: null,
        continuationDisposition: "clear",
      };
    };

    const result = await executeAgentCall(
      {
        executionClass: "ordinary-conversation" as const,
        kind: "conversation_turn",
        backend: "claude",
        prompt: "produce a manifest",
        outputSchema: schema,
      },
      buildDepsForConversation({
        runtime,
        view: CLAUDE_VIEW,
        artifacts,
      }),
    );

    expect(turns).toBe(2);
    expect(result.backendRef).toBeNull();
    expect(result.continuationDisposition).toBe("clear");
    expect(result.artifacts).toEqual(artifacts);
    expect(result.usage).toMatchObject({
      contextTokens: 200,
      costUsd: 0.03,
      durationMs: 30,
    });
    expect(result.compacted).toBe(true);
    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind === "failed") {
      expect(result.outcome.error.failureKind).toBe("aborted");
      expect(result.outcome.contentBlocks).toEqual(originalBlocks);
      expect(result.outcome.numTurns).toBe(3);
    }
  });

  it("keeps the known conversation ref when a turnless repair failure retains continuity", async () => {
    let turns = 0;
    const originalBlocks = [
      { type: "text" as const, text: JSON.stringify({ summary: "original" }) },
    ];
    const runtime = makeConversationRuntime("claude");
    runtime.sendTurn = async () => {
      turns += 1;
      if (turns > 1) throw new Error("repair transport failed");
      return {
        backendRef: { backend: "claude", ref: "session-initial" },
        costUsd: null,
        durationMs: 10,
        numTurns: 1,
        contextTokens: 100,
        contextWindowMax: 200_000,
        contentBlocks: originalBlocks,
        structuredOutput: undefined,
        aborted: false,
        compacted: false,
        failure: null,
        continuationDisposition: "retain",
      };
    };

    const result = await executeAgentCall(
      {
        executionClass: "ordinary-conversation" as const,
        kind: "conversation_turn",
        backend: "claude",
        prompt: "produce a manifest",
        outputSchema: schema,
      },
      {
        ...buildDepsForConversation({ runtime, view: CLAUDE_VIEW }),
        getFailureClassifier: () => createStubFailureClassifier(),
      },
    );

    expect(result.backendRef).toEqual({
      backend: "claude",
      ref: "session-initial",
    });
    expect(result.continuationDisposition).toBe("retain");
    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind === "failed") {
      expect(result.outcome.error.failureKind).toBe("backend_error");
      expect(result.outcome.contentBlocks).toEqual(originalBlocks);
    }
  });

  it("propagates a timed-out task repair while retaining the original continuation and transcript", async () => {
    const requests: AgentTaskRequest[] = [];
    const initialTranscript = [
      {
        seq: 0,
        backend: "codex" as const,
        type: "agent_message",
        raw: { type: "agent_message", text: "original evidence" },
      },
    ];
    const artifacts = [
      { kind: "design_doc", relativePath: "memory-bank/already-written.md" },
    ];
    const runner: AgentTaskRunner = {
      backend: "codex",
      async run(input) {
        requests.push(input);
        if (requests.length === 1) {
          return {
            backendRef: { backend: "codex", ref: "thread-original" },
            text: JSON.stringify({ summary: "invalid" }),
            usage: { inputTokens: 2 },
            error: null,
            timedOut: false,
            failure: null,
            continuationDisposition: "retain",
            transcript: initialTranscript,
          };
        }
        return {
          backendRef: null,
          text: null,
          usage: { inputTokens: 3 },
          error: null,
          timedOut: true,
          failure: { kind: "timeout", message: "timed out", retryable: false },
          continuationDisposition: "clear",
        };
      },
    };

    const result = await executeAgentCall(
      {
        executionClass: "nongoverned-task" as const,
        kind: "task_run",
        backend: "codex",
        prompt: "produce a manifest",
        outputSchema: schema,
      },
      buildDepsForTask({ runner, view: CODEX_VIEW, artifacts }),
    );

    expect(requests).toHaveLength(2);
    expect(result.backendRef).toEqual({
      backend: "codex",
      ref: "thread-original",
    });
    expect(result.continuationDisposition).toBe("retain");
    expect(result.artifacts).toEqual(artifacts);
    expect(result.usage.inputTokens).toBe(5);
    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind === "failed") {
      expect(result.outcome.error.failureKind).toBe("timeout");
      expect(result.outcome.transcript).toEqual(initialTranscript);
    }
  });

  it("does not dispatch a repair when maxAttempts is zero", async () => {
    let calls = 0;
    const runner: AgentTaskRunner = {
      backend: "codex",
      async run() {
        calls += 1;
        return {
          backendRef: { backend: "codex", ref: "thread-1" },
          text: JSON.stringify({ summary: "invalid" }),
          usage: null,
          error: null,
          timedOut: false,
          failure: null,
          continuationDisposition: "retain",
        };
      },
    };

    const result = await executeAgentCall(
      {
        executionClass: "nongoverned-task" as const,
        kind: "task_run",
        backend: "codex",
        prompt: "produce a manifest",
        outputSchema: schema,
        structuredOutputRepair: { maxAttempts: 0 },
      },
      buildDepsForTask({ runner, view: CODEX_VIEW }),
    );

    expect(calls).toBe(1);
    expect(result.outcome.kind).toBe("failed");
  });
});

describe("buildStructuredOutputRepairRequest", () => {
  const schema = { type: "object", required: ["summary"] };
  const governingFields = {
    executionClass: "governed-execution" as const,
    requiresPrivilegedInstructions: true,
    fsWritePolicy: {
      mode: "allowlist" as const,
      allowWrite: [],
      denyWrite: [],
    },
    systemInstructions: "the governing charter",
    laneRef: { workflowId: "wf-1", laneId: "primary" },
    writeCapability: "read_only" as const,
    timeoutMs: 30_000,
    modelSelection: CODEX_SELECTION,
  };
  const perTurnPayload = {
    tooling: { servers: [] },
    imageRefs: [
      {
        index: 1,
        mediaType: "image/png",
        path: "/tmp/reference.png",
        base64Data: "image-data",
      },
    ],
  };

  it("carries the governing fields of a conversation_turn into the repair turn", () => {
    const repair = buildStructuredOutputRepairRequest({
      request: {
        kind: "conversation_turn",
        prompt: "produce a manifest",
        outputSchema: schema,
        ...governingFields,
        ...perTurnPayload,
      },
      prompt: "your prior output failed validation",
      backend: "claude",
    });

    expect(repair).toEqual({
      kind: "conversation_turn",
      backend: "claude",
      prompt: "your prior output failed validation",
      outputSchema: schema,
      ...governingFields,
    });
    expect(agentCallRequestSchema.parse(repair)).toEqual(repair);
  });

  it("carries the governing fields of a task_run into the repair run", () => {
    const repair = buildStructuredOutputRepairRequest({
      request: {
        kind: "task_run",
        backend: "codex",
        prompt: "produce a manifest",
        outputSchema: schema,
        ...governingFields,
        ...perTurnPayload,
      },
      prompt: "your prior output failed validation",
      backend: "codex",
    });

    expect(repair).toEqual({
      executionProfile: "isolated-one-shot",
      kind: "task_run",
      backend: "codex",
      prompt: "your prior output failed validation",
      outputSchema: schema,
      ...governingFields,
    });
    expect(agentCallRequestSchema.parse(repair)).toEqual(repair);
  });

  it("omits governing fields the original request never set", () => {
    const repair = buildStructuredOutputRepairRequest({
      request: {
        executionClass: "ordinary-conversation" as const,
        kind: "conversation_turn",
        prompt: "produce a manifest",
        outputSchema: schema,
      },
      prompt: "your prior output failed validation",
      backend: "claude",
    });

    expect(repair).toEqual({
      executionClass: "ordinary-conversation",
      kind: "conversation_turn",
      backend: "claude",
      prompt: "your prior output failed validation",
      outputSchema: schema,
    });
  });
});
