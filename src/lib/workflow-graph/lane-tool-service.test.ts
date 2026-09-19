import { describe, expect, it, vi } from "vitest";
import {
  createRequestCollaborationHandler,
  requestCollaborationSchema,
  type RequestCollaborationHandlerContext,
  type RequestCollaborationHandlerDeps,
} from "./lane-tool-service";
import type { ResolvedCollaborationConfig } from "@/lib/workflow-graph/collaboration-schemas";
import type { ExecutionLogger } from "./execution-logger";

describe("requestCollaborationSchema", () => {
  it("accepts a trimmed non-empty brief", () => {
    const result = requestCollaborationSchema.safeParse({
      brief: "Should we adopt Postgres or stay on MySQL?",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.brief).toBe(
        "Should we adopt Postgres or stay on MySQL?",
      );
    }
  });

  it("trims leading and trailing whitespace from the brief", () => {
    const result = requestCollaborationSchema.safeParse({
      brief: "   pick a queue technology   ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.brief).toBe("pick a queue technology");
    }
  });

  it("rejects an empty brief", () => {
    expect(requestCollaborationSchema.safeParse({ brief: "" }).success).toBe(
      false,
    );
  });

  it("rejects a whitespace-only brief", () => {
    expect(
      requestCollaborationSchema.safeParse({ brief: "   \n  " }).success,
    ).toBe(false);
  });

  it("rejects a missing brief", () => {
    expect(requestCollaborationSchema.safeParse({}).success).toBe(false);
  });

  it("rejects a non-string brief", () => {
    expect(requestCollaborationSchema.safeParse({ brief: 42 }).success).toBe(
      false,
    );
    expect(requestCollaborationSchema.safeParse({ brief: null }).success).toBe(
      false,
    );
    expect(
      requestCollaborationSchema.safeParse({ brief: ["a", "b"] }).success,
    ).toBe(false);
  });

  it("rejects any extra fields", () => {
    const result = requestCollaborationSchema.safeParse({
      brief: "pick a stack",
      hint: "no React",
    });
    expect(result.success).toBe(false);
  });
});

describe("createRequestCollaborationHandler", () => {
  const RESOLVED_CONFIG: ResolvedCollaborationConfig = {
    enabled: { value: true, source: "workflow" },
    secondAgent: {
      value: {
        backend: "codex",
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning: "medium", fast: "false" },
        },
      },
      source: "global",
    },
    negotiationRounds: { value: 3, source: "workflow" },
    autonomousResolutionThreshold: { value: "minor", source: "per-node" },
  };

  function buildContext(overrides?: {
    triggerWorkflowCollaboration?: RequestCollaborationHandlerContext["triggerWorkflowCollaboration"];
    setPendingHaltReason?: RequestCollaborationHandlerContext["setPendingHaltReason"];
    resolveCollaborationConfig?: RequestCollaborationHandlerContext["resolveCollaborationConfig"];
  }): RequestCollaborationHandlerContext {
    return {
      executionContextTitle: "Implement",
      parentImplementerTurnId: "turn-7",
      executionContextId: "context-implement",
      conversationId: "conv-abc",
      executionId: "exec-123",
      iterationIndex: 0,
      resolveCollaborationConfig:
        overrides?.resolveCollaborationConfig ?? (() => RESOLVED_CONFIG),
      triggerWorkflowCollaboration:
        overrides?.triggerWorkflowCollaboration ??
        (async () => ({ workflowId: "collab-123" })),
      setPendingHaltReason:
        overrides?.setPendingHaltReason ?? (async () => undefined),
    };
  }

  function buildExecutionLoggerStub(recorder: string[]): ExecutionLogger {
    return {
      executionId: "exec-123",
      logDir: "/tmp/test-logs",
      writeManifest: vi.fn(),
      lifecycle: vi.fn((event) => {
        recorder.push(`lifecycle:${event}`);
      }),
      iteration: vi.fn((contextId, event) => {
        recorder.push(`iteration:${contextId}:${event}`);
      }),
      task: vi.fn((contextId, event) => {
        recorder.push(`task:${contextId}:${event}`);
      }),
      validation: vi.fn((contextId, event) => {
        recorder.push(`validation:${contextId}:${event}`);
      }),
      writePrompt: vi.fn(),
      writeValidatorResponse: vi.fn(),
      writeValidatorTranscript: vi.fn(),
      decision: vi.fn((event) => {
        recorder.push(`decision:${event}`);
      }),
    };
  }

  function buildDeps(overrides?: {
    getExecutionLogger?: RequestCollaborationHandlerDeps["getExecutionLogger"];
  }): RequestCollaborationHandlerDeps {
    return {
      getExecutionLogger: overrides?.getExecutionLogger ?? (() => null),
    };
  }

  it("returns a validation-error tool result and never triggers collaboration when brief is empty", async () => {
    const triggerWorkflowCollaboration = vi.fn();
    const setPendingHaltReason = vi.fn();
    const resolveCollaborationConfig = vi.fn(() => RESOLVED_CONFIG);
    const handler = createRequestCollaborationHandler(
      buildContext({
        triggerWorkflowCollaboration,
        setPendingHaltReason,
        resolveCollaborationConfig,
      }),
      buildDeps(),
    );

    const result = (await handler({ brief: "" })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Validation error");
    expect(triggerWorkflowCollaboration).not.toHaveBeenCalled();
    expect(setPendingHaltReason).not.toHaveBeenCalled();
    expect(resolveCollaborationConfig).not.toHaveBeenCalled();
  });

  it("returns a validation-error tool result for a whitespace-only brief", async () => {
    const triggerWorkflowCollaboration = vi.fn();
    const handler = createRequestCollaborationHandler(
      buildContext({ triggerWorkflowCollaboration }),
      buildDeps(),
    );

    const result = (await handler({ brief: "   \n  " })) as {
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(triggerWorkflowCollaboration).not.toHaveBeenCalled();
  });

  it("returns a validation-error tool result for missing brief field", async () => {
    const triggerWorkflowCollaboration = vi.fn();
    const handler = createRequestCollaborationHandler(
      buildContext({ triggerWorkflowCollaboration }),
      buildDeps(),
    );

    const result = (await handler({})) as { isError?: boolean };

    expect(result.isError).toBe(true);
    expect(triggerWorkflowCollaboration).not.toHaveBeenCalled();
  });

  it("triggers workflow collaboration with the resolved config and parent context on a valid brief", async () => {
    const triggerWorkflowCollaboration = vi.fn(async () => ({
      workflowId: "collab-456",
    }));
    const handler = createRequestCollaborationHandler(
      buildContext({ triggerWorkflowCollaboration }),
      buildDeps(),
    );

    await handler({ brief: "Should we adopt Postgres?" });

    expect(triggerWorkflowCollaboration).toHaveBeenCalledTimes(1);
    expect(triggerWorkflowCollaboration).toHaveBeenCalledWith({
      brief: "Should we adopt Postgres?",
      resolvedConfig: RESOLVED_CONFIG,
      parentImplementerTurnId: "turn-7",
      executionContextId: "context-implement",
      conversationId: "conv-abc",
      executionId: "exec-123",
      iterationIndex: 0,
    });
  });

  it("does not set pendingHaltReason when collaboration is only started", async () => {
    const setPendingHaltReason = vi.fn();
    const triggerWorkflowCollaboration = vi.fn(async () => ({
      workflowId: "collab-456",
    }));
    const handler = createRequestCollaborationHandler(
      buildContext({ triggerWorkflowCollaboration, setPendingHaltReason }),
      buildDeps(),
    );

    await handler({ brief: "Should we adopt Postgres?" });

    expect(setPendingHaltReason).not.toHaveBeenCalled();
  });

  it("writes the invocation and started log events through the execution logger", async () => {
    const callOrder: string[] = [];
    const executionLoggerStub = buildExecutionLoggerStub(callOrder);
    const triggerWorkflowCollaboration = vi.fn(async () => {
      callOrder.push("triggerWorkflowCollaboration");
      return { workflowId: "collab-456" };
    });
    const handler = createRequestCollaborationHandler(
      buildContext({ triggerWorkflowCollaboration }),
      buildDeps({ getExecutionLogger: () => executionLoggerStub }),
    );

    await handler({ brief: "Should we adopt Postgres?" });

    expect(callOrder).toEqual([
      "task:context-implement:collaboration.request_collaboration.invoked",
      "triggerWorkflowCollaboration",
      "task:context-implement:collaboration.request_collaboration.started",
    ]);
  });

  it("returns a started acknowledgment instead of a final collaboration result", async () => {
    const triggerWorkflowCollaboration = vi.fn(async () => ({
      workflowId: "collab-456",
    }));
    const handler = createRequestCollaborationHandler(
      buildContext({ triggerWorkflowCollaboration }),
      buildDeps(),
    );

    const result = (await handler({
      brief: "Should we adopt Postgres?",
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({
      status: "started",
      workflowId: "collab-456",
    });
  });

  it("does not write a failure_halt decision log when starting collaboration", async () => {
    const callOrder: string[] = [];
    const executionLoggerStub = buildExecutionLoggerStub(callOrder);
    const handler = createRequestCollaborationHandler(
      buildContext(),
      buildDeps({ getExecutionLogger: () => executionLoggerStub }),
    );

    await handler({ brief: "Should we adopt Postgres?" });

    expect(callOrder.includes("decision:collaboration.failure_halt")).toBe(
      false,
    );
  });

  describe("captured execution-log payloads", () => {
    interface CapturedTaskRow {
      contextId: string;
      event: string;
      payload: Record<string, unknown> | undefined;
    }

    function buildPayloadCapturingLogger(): {
      logger: ExecutionLogger;
      tasks: CapturedTaskRow[];
    } {
      const tasks: CapturedTaskRow[] = [];
      const logger: ExecutionLogger = {
        executionId: "exec-123",
        logDir: "/tmp/test-logs",
        writeManifest: vi.fn(),
        lifecycle: vi.fn(),
        iteration: vi.fn(),
        task: vi.fn((contextId: string, event: string, data) => {
          tasks.push({ contextId, event, payload: data });
        }),
        validation: vi.fn(),
        writePrompt: vi.fn(),
        writeValidatorResponse: vi.fn(),
        writeValidatorTranscript: vi.fn(),
        decision: vi.fn(),
      };
      return { logger, tasks };
    }

    it("(happy path) tasks.jsonl `invoked` row carries brief and resolvedConfig with source fields", async () => {
      const { logger, tasks } = buildPayloadCapturingLogger();
      const handler = createRequestCollaborationHandler(
        buildContext({
          triggerWorkflowCollaboration: async () => ({ workflowId: "wf-1" }),
        }),
        buildDeps({ getExecutionLogger: () => logger }),
      );

      await handler({ brief: "Should we adopt Postgres?" });

      const invoked = tasks.find(
        (row) => row.event === "collaboration.request_collaboration.invoked",
      );
      expect(invoked).toBeDefined();
      expect(invoked?.contextId).toBe("context-implement");
      const payload = invoked?.payload ?? {};
      expect(payload.brief).toBe("Should we adopt Postgres?");
      expect(payload.parentImplementerTurnId).toBe("turn-7");
      expect(payload.conversationId).toBe("conv-abc");

      const resolved = payload.resolvedConfig as
        | ResolvedCollaborationConfig
        | undefined;
      expect(resolved).toBeDefined();
      expect(resolved?.secondAgent.source).toBe("global");
      expect(resolved?.negotiationRounds.source).toBe("workflow");
      expect(resolved?.autonomousResolutionThreshold.source).toBe("per-node");
    });

    it("(happy path) tasks.jsonl `started` row carries workflowId and resolvedConfig", async () => {
      const { logger, tasks } = buildPayloadCapturingLogger();
      const handler = createRequestCollaborationHandler(
        buildContext({
          triggerWorkflowCollaboration: async () => ({ workflowId: "wf-2" }),
        }),
        buildDeps({ getExecutionLogger: () => logger }),
      );

      await handler({ brief: "Should we adopt Postgres?" });

      const started = tasks.find(
        (row) => row.event === "collaboration.request_collaboration.started",
      );
      expect(started).toBeDefined();
      const payload = started?.payload ?? {};
      expect(payload.workflowId).toBe("wf-2");
      expect(payload.brief).toBe("Should we adopt Postgres?");
      expect(payload.resolvedConfig).toBeDefined();
      expect(
        (payload.resolvedConfig as ResolvedCollaborationConfig).secondAgent
          .value.backend,
      ).toBe("codex");
    });
  });
});
