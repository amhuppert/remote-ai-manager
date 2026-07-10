import { describe, it, expect, vi } from "vitest";
import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";
import type {
  AgentTaskRunner,
  AgentTaskRequest,
  AgentTaskResult,
} from "@/lib/agent-backends/task";
import { dispatchTaskRun } from "./agent-call-task";
import type { BackendCapabilityView } from "./agent-call-vocabulary";

const CODEX_VIEW: BackendCapabilityView = {
  backend: "codex",
  continuationStrength: "synthetic_thread",
  structuredOutputEnforcement: "backend_native",
  mcpApplicationBoundary: "per_request",
  contextMetricsAvailable: false,
  nativeMidTurnAskUser: false,
};

const CLAUDE_TASK_VIEW: BackendCapabilityView = {
  backend: "claude",
  continuationStrength: "precise_session",
  structuredOutputEnforcement: "post_validation",
  mcpApplicationBoundary: "between_turns",
  contextMetricsAvailable: true,
  nativeMidTurnAskUser: true,
};

interface StubTaskRunnerOpts {
  result?: Partial<AgentTaskResult>;
  onRun?(input: AgentTaskRequest): Promise<void> | void;
  throws?: Error;
}

function makeStubRunner(
  backend: BackendCapabilityView["backend"],
  opts: StubTaskRunnerOpts = {},
): {
  runner: AgentTaskRunner;
  capturedInput: { value: AgentTaskRequest | null };
  callCount: { value: number };
} {
  const captured = { value: null as AgentTaskRequest | null };
  const callCount = { value: 0 };
  const baseResult: AgentTaskResult = {
    backendRef:
      backend === "claude"
        ? { backend: "claude", sessionId: "task-1" }
        : { backend: "codex", threadId: "thread-1" },
    text: "task done",
    structuredOutput: undefined,
    usage: { inputTokens: 100, outputTokens: 200, cachedInputTokens: 0 },
    error: null,
    timedOut: false,
  };

  return {
    runner: {
      backend,
      async run(input) {
        callCount.value += 1;
        captured.value = input;
        if (opts.onRun) await opts.onRun(input);
        if (opts.throws) throw opts.throws;
        return { ...baseResult, ...(opts.result ?? {}) };
      },
    },
    capturedInput: captured,
    callCount,
  };
}

describe("dispatchTaskRun", () => {
  it("rejects non-task_run requests", async () => {
    const { runner } = makeStubRunner("codex");
    await expect(() =>
      dispatchTaskRun(
        { kind: "conversation_turn", prompt: "hi" },
        {
          runner,
          capabilityView: CODEX_VIEW,
          workingDirectory: "/tmp/wt",
        },
      ),
    ).rejects.toThrow(/task_run/i);
  });

  it("dispatches the request through runner.run and normalizes a completed result", async () => {
    const { runner, capturedInput } = makeStubRunner("codex", {
      result: {
        text: "ok",
        structuredOutput: { ok: true },
      },
    });

    const result = await dispatchTaskRun(
      {
        kind: "task_run",
        backend: "codex",
        prompt: "do it",
        systemInstructions: "be terse",
        timeoutMs: 30_000,
      },
      {
        runner,
        capabilityView: CODEX_VIEW,
        workingDirectory: "/tmp/wt",
        autonomous: true,
      },
    );

    expect(capturedInput.value?.workingDirectory).toBe("/tmp/wt");
    expect(capturedInput.value?.prompt).toBe("do it");
    expect(capturedInput.value?.systemInstructions).toEqual(["be terse"]);
    expect(capturedInput.value?.timeoutMs).toBe(30_000);
    expect(capturedInput.value?.autonomous).toBe(true);

    expect(result.backend).toBe("codex");
    expect(result.outcome.kind).toBe("completed");
    if (result.outcome.kind === "completed") {
      expect(result.outcome.text).toBe("ok");
      expect(result.outcome.structuredOutput).toEqual({ ok: true });
    }
    expect(result.capabilities).toEqual(CODEX_VIEW);
  });

  it("uses a default timeout when the request omits it", async () => {
    const { runner, capturedInput } = makeStubRunner("codex");
    await dispatchTaskRun(
      { kind: "task_run", backend: "codex", prompt: "go" },
      {
        runner,
        capabilityView: CODEX_VIEW,
        workingDirectory: "/tmp/wt",
        defaultTimeoutMs: 90_000,
      },
    );
    expect(capturedInput.value?.timeoutMs).toBe(90_000);
  });

  it("uses no timeout when request and caller defaults omit it", async () => {
    const { runner, capturedInput } = makeStubRunner("codex");
    await dispatchTaskRun(
      { kind: "task_run", backend: "codex", prompt: "go" },
      {
        runner,
        capabilityView: CODEX_VIEW,
        workingDirectory: "/tmp/wt",
      },
    );
    expect(capturedInput.value?.timeoutMs).toBe(0);
  });

  it("applies workflow tooling onto the task request as portable MCP tooling", async () => {
    const tooling: PortableMcpConfig = {
      servers: [{ id: "s1", transport: "stdio", command: "echo" }],
    };
    const { runner, capturedInput } = makeStubRunner("codex");
    await dispatchTaskRun(
      {
        kind: "task_run",
        backend: "codex",
        prompt: "go",
        tooling,
      },
      {
        runner,
        capabilityView: CODEX_VIEW,
        workingDirectory: "/tmp/wt",
      },
    );
    expect(capturedInput.value?.tooling).toEqual({ portableMcp: tooling });
  });

  it("forwards the structured output schema to the runner", async () => {
    const { runner, capturedInput } = makeStubRunner("codex", {
      result: { structuredOutput: { ok: true } },
    });
    const schema = { type: "object", properties: { ok: { type: "boolean" } } };
    const result = await dispatchTaskRun(
      {
        kind: "task_run",
        backend: "codex",
        prompt: "go",
        outputSchema: schema,
      },
      {
        runner,
        capabilityView: CODEX_VIEW,
        workingDirectory: "/tmp/wt",
      },
    );
    expect(capturedInput.value?.outputSchema).toEqual(schema);
    if (result.outcome.kind === "completed") {
      expect(result.outcome.structuredOutput).toEqual({ ok: true });
    } else {
      throw new Error("expected completed");
    }
  });

  it("normalizes a timeout result to the timeout failure kind", async () => {
    const { runner } = makeStubRunner("codex", {
      result: { error: null, timedOut: true, text: null },
    });
    const result = await dispatchTaskRun(
      { kind: "task_run", backend: "codex", prompt: "go", timeoutMs: 5 },
      { runner, capabilityView: CODEX_VIEW, workingDirectory: "/tmp/wt" },
    );
    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind === "failed") {
      expect(result.outcome.error.failureKind).toBe("timeout");
      expect(result.outcome.error.backend).toBe("codex");
    }
  });

  it("normalizes a runner-reported error preserving backend identity", async () => {
    const { runner } = makeStubRunner("codex", {
      result: { error: "runner exploded", text: null },
    });
    const result = await dispatchTaskRun(
      { kind: "task_run", backend: "codex", prompt: "go" },
      { runner, capabilityView: CODEX_VIEW, workingDirectory: "/tmp/wt" },
    );
    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind === "failed") {
      expect(result.outcome.error.failureKind).toBe("backend_error");
      expect(result.outcome.error.backend).toBe("codex");
      expect(result.outcome.error.message).toContain("runner exploded");
    }
  });

  it("preserves a captured transcript on runner-reported errors", async () => {
    const transcript = [
      {
        seq: 0,
        backend: "claude" as const,
        type: "assistant",
        raw: { type: "assistant", text: "partial analysis" },
      },
    ];
    const { runner } = makeStubRunner("claude", {
      result: { error: "runner exploded", text: null, transcript },
    });
    const result = await dispatchTaskRun(
      { kind: "task_run", backend: "claude", prompt: "go" },
      {
        runner,
        capabilityView: CLAUDE_TASK_VIEW,
        workingDirectory: "/tmp/wt",
      },
    );
    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind === "failed") {
      expect(result.outcome.transcript).toEqual(transcript);
    }
  });

  it("normalizes a thrown runner exception", async () => {
    const { runner } = makeStubRunner("codex", {
      throws: new Error("connection reset"),
    });
    const result = await dispatchTaskRun(
      { kind: "task_run", backend: "codex", prompt: "go" },
      { runner, capabilityView: CODEX_VIEW, workingDirectory: "/tmp/wt" },
    );
    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind === "failed") {
      expect(result.outcome.error.failureKind).toBe("backend_error");
      expect(result.outcome.error.backend).toBe("codex");
      expect(result.outcome.error.message).toContain("connection reset");
    }
  });

  it("rejects a task_run when the runner backend does not match the request backend", async () => {
    const { runner } = makeStubRunner("claude");
    await expect(() =>
      dispatchTaskRun(
        { kind: "task_run", backend: "codex", prompt: "go" },
        {
          runner,
          capabilityView: CODEX_VIEW,
          workingDirectory: "/tmp/wt",
        },
      ),
    ).rejects.toThrow(/backend/i);
  });

  it("preserves usage metrics from the runner result", async () => {
    const { runner } = makeStubRunner("claude", {
      result: {
        usage: {
          inputTokens: 50,
          outputTokens: 75,
          cachedInputTokens: 10,
        },
      },
    });
    const result = await dispatchTaskRun(
      { kind: "task_run", backend: "claude", prompt: "go" },
      {
        runner,
        capabilityView: CLAUDE_TASK_VIEW,
        workingDirectory: "/tmp/wt",
      },
    );
    expect(result.usage).toMatchObject({
      inputTokens: 50,
      outputTokens: 75,
      cachedInputTokens: 10,
    });
  });

  it("returns the same outcome shape as the conversation path on a completed run", async () => {
    const { runner } = makeStubRunner("codex");
    const result = await dispatchTaskRun(
      { kind: "task_run", backend: "codex", prompt: "go" },
      { runner, capabilityView: CODEX_VIEW, workingDirectory: "/tmp/wt" },
    );
    expect(Object.keys(result).sort()).toEqual(
      [
        "artifacts",
        "backend",
        "backendRef",
        "capabilities",
        "outcome",
        "usage",
      ].sort(),
    );
    expect(result.outcome.kind).toBe("completed");
  });

  it("emits the shared structured log field set including artifactKinds and outcome", async () => {
    const debug = vi.fn();
    const stubLogger = {
      debug,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const { runner } = makeStubRunner("codex");
    await dispatchTaskRun(
      {
        kind: "task_run",
        backend: "codex",
        prompt: "go",
        laneRef: { workflowId: "wf-1", laneId: "lane-A" },
      },
      {
        runner,
        capabilityView: CODEX_VIEW,
        workingDirectory: "/tmp/wt",
        artifacts: [
          { kind: "design_doc", relativePath: "memory-bank/design.md" },
          { kind: "transcript", relativePath: "memory-bank/transcript.md" },
        ],
        logger: stubLogger,
      },
    );

    expect(debug).toHaveBeenCalledWith(
      "agent_call.task.dispatch_start",
      expect.objectContaining({
        requestKind: "task_run",
        backend: "codex",
        workflowId: "wf-1",
        laneId: "lane-A",
        artifactKinds: ["design_doc", "transcript"],
      }),
    );
    expect(debug).toHaveBeenCalledWith(
      "agent_call.task.dispatch_complete",
      expect.objectContaining({
        outcome: "completed",
        artifactKinds: ["design_doc", "transcript"],
      }),
    );
  });

  it("emits the shared structured log field set on timeout failures", async () => {
    const warn = vi.fn();
    const stubLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
    };
    const { runner } = makeStubRunner("codex", {
      result: { error: null, timedOut: true, text: null },
    });
    await dispatchTaskRun(
      {
        kind: "task_run",
        backend: "codex",
        prompt: "go",
        laneRef: { workflowId: "wf-1", laneId: "lane-B" },
        timeoutMs: 5,
      },
      {
        runner,
        capabilityView: CODEX_VIEW,
        workingDirectory: "/tmp/wt",
        artifacts: [{ kind: "design_doc", relativePath: "memory-bank/x.md" }],
        logger: stubLogger,
      },
    );
    expect(warn).toHaveBeenCalledWith(
      "agent_call.task.timed_out",
      expect.objectContaining({
        requestKind: "task_run",
        backend: "codex",
        workflowId: "wf-1",
        laneId: "lane-B",
        outcome: "failed",
        artifactKinds: ["design_doc"],
      }),
    );
  });

  it("forwards write-capability and worktree settings to the runner sandbox flags", async () => {
    const { runner, capturedInput } = makeStubRunner("codex");
    await dispatchTaskRun(
      {
        kind: "task_run",
        backend: "codex",
        prompt: "go",
        writeCapability: "read_only",
      },
      {
        runner,
        capabilityView: CODEX_VIEW,
        workingDirectory: "/tmp/wt",
        sandboxMode: "read-only",
        approvalPolicy: "never",
        skipGitRepoCheck: true,
        networkAccessEnabled: false,
      },
    );
    expect(capturedInput.value?.sandboxMode).toBe("read-only");
    expect(capturedInput.value?.approvalPolicy).toBe("never");
    expect(capturedInput.value?.skipGitRepoCheck).toBe(true);
    expect(capturedInput.value?.networkAccessEnabled).toBe(false);
  });

  it("threads the external cancellation signal through to the runner", async () => {
    const { runner, capturedInput } = makeStubRunner("codex");
    const controller = new AbortController();

    await dispatchTaskRun(
      {
        kind: "task_run",
        backend: "codex",
        prompt: "go",
        writeCapability: "read_only",
      },
      {
        runner,
        capabilityView: CODEX_VIEW,
        workingDirectory: "/tmp/wt",
        signal: controller.signal,
      },
    );

    expect(capturedInput.value?.signal).toBe(controller.signal);
  });
});
