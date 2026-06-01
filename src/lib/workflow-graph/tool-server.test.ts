import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRequestCollaborationHandler,
  registerGraphWorkflowExecutionTools,
  requestCollaborationSchema,
  type RequestCollaborationHandlerContext,
  type RequestCollaborationHandlerDeps,
} from "./tool-server";
import { IterationHaltedError } from "./iteration-orchestrator";
import type {
  GraphWorkflowHaltReason,
  ResolvedCollaborationConfig,
  WorkflowCollaborationResult,
} from "@/lib/workflows/schemas";
import type { ExecutionLogger } from "./execution-logger";

type ToolHandler = (args: unknown) => Promise<unknown>;

const TOOLS_KEY = "__test_graph_workflow_tools";

function getCapturedTools(): Map<
  string,
  { name: string; handler: ToolHandler }
> {
  const globalState = globalThis as Record<string, unknown>;
  if (!globalState[TOOLS_KEY]) {
    globalState[TOOLS_KEY] = new Map();
  }

  return globalState[TOOLS_KEY] as Map<
    string,
    { name: string; handler: ToolHandler }
  >;
}

function createCapturingServer() {
  return {
    registerTool(name: string, _config: unknown, handler: ToolHandler): void {
      getCapturedTools().set(name, { name, handler });
    },
  };
}

function getHandler(name: string): ToolHandler {
  const tool = getCapturedTools().get(name);
  if (!tool) {
    throw new Error(`Tool ${name} not found`);
  }

  return tool.handler;
}

describe("graph workflow tool server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCapturedTools().clear();
  });

  it("registers explicit task and shared-document tools", async () => {
    const completeTask = vi.fn(async () => undefined);
    const addTask = vi.fn(async () => undefined);
    const upsertSharedDocument = vi.fn(async () => undefined);

    registerGraphWorkflowExecutionTools(createCapturingServer() as never, {
      executionContextTitle: "Plan",
      allowAgentTaskAdd: true,
      allowAgentCollaboration: false,
      completeTask,
      addTask,
      upsertSharedDocument,
    });

    expect(getCapturedTools().has("begin_task")).toBe(false);
    expect(getCapturedTools().has("complete_task")).toBe(true);
    expect(getCapturedTools().has("add_task")).toBe(true);
    expect(getCapturedTools().has("upsert_shared_document")).toBe(true);

    const completeResult = (await getHandler("complete_task")({
      taskSlug: "setup-auth",
      summary: "Finished the task.",
    })) as { isError?: boolean };
    const addResult = (await getHandler("add_task")({
      slug: "capture-unknowns",
      title: "Capture unknowns",
      instructions: "Record planning gaps.",
    })) as { isError?: boolean };
    const docResult = (await getHandler("upsert_shared_document")({
      relativePath: ".cc/graph-workflow-docs/plan.md",
      description: "Planning notes",
      readWhen: "Read before implementation.",
    })) as { isError?: boolean };

    expect(completeResult.isError).toBeUndefined();
    expect(addResult.isError).toBeUndefined();
    expect(docResult.isError).toBeUndefined();

    expect(completeTask).toHaveBeenCalledWith(
      "setup-auth",
      "Finished the task.",
    );
    expect(addTask).toHaveBeenCalledWith({
      slug: "capture-unknowns",
      title: "Capture unknowns",
      instructions: "Record planning gaps.",
    });
    expect(upsertSharedDocument).toHaveBeenCalledWith({
      relativePath: ".cc/graph-workflow-docs/plan.md",
      description: "Planning notes",
      readWhen: "Read before implementation.",
    });
  });

  it("omits add_task when agent task creation is not allowed", () => {
    registerGraphWorkflowExecutionTools(createCapturingServer() as never, {
      executionContextTitle: "Implement",
      allowAgentTaskAdd: false,
      allowAgentCollaboration: false,
      completeTask: vi.fn(async () => undefined),
      addTask: vi.fn(async () => undefined),
      upsertSharedDocument: vi.fn(async () => undefined),
    });

    expect(getCapturedTools().has("add_task")).toBe(false);
  });

  it("returns a halt-aware tool error result when completeTask raises IterationHaltedError", async () => {
    const haltError = new IterationHaltedError({
      type: "circuit_breaker",
      contextId: "context-plan",
      condition: "retry_exhaustion",
      failureCount: 3,
      summary: null,
    });

    registerGraphWorkflowExecutionTools(createCapturingServer() as never, {
      executionContextTitle: "Plan",
      allowAgentTaskAdd: true,
      allowAgentCollaboration: false,
      completeTask: vi.fn(async () => {
        throw haltError;
      }),
      addTask: vi.fn(async () => undefined),
      upsertSharedDocument: vi.fn(async () => undefined),
    });

    const result = (await getHandler("complete_task")({
      taskSlug: "setup-auth",
      summary: "Finished.",
    })) as { content: Array<{ text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toBe("iteration halted: circuit_breaker");
  });

  it("returns a halt-aware tool error result when upsertSharedDocument raises IterationHaltedError", async () => {
    const haltError = new IterationHaltedError({
      type: "validator_infra_error",
      contextId: "context-plan",
      engine: "codex",
      infraReason: "unparseable",
      message: "Codex returned invalid JSON",
      summary: null,
    });

    registerGraphWorkflowExecutionTools(createCapturingServer() as never, {
      executionContextTitle: "Plan",
      allowAgentTaskAdd: true,
      allowAgentCollaboration: false,
      completeTask: vi.fn(async () => undefined),
      addTask: vi.fn(async () => undefined),
      upsertSharedDocument: vi.fn(async () => {
        throw haltError;
      }),
    });

    const result = (await getHandler("upsert_shared_document")({
      relativePath: ".cc/graph-workflow-docs/plan.md",
      description: "Planning notes",
      readWhen: "Read before implementation.",
    })) as { content: Array<{ text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toBe("iteration halted: validator_infra_error");
  });

  it("returns a halt-aware tool error result when addTask raises IterationHaltedError", async () => {
    const haltError = new IterationHaltedError({
      type: "circuit_breaker",
      contextId: "context-plan",
      condition: "retry_exhaustion",
      failureCount: 3,
      summary: null,
    });

    registerGraphWorkflowExecutionTools(createCapturingServer() as never, {
      executionContextTitle: "Plan",
      allowAgentTaskAdd: true,
      allowAgentCollaboration: false,
      completeTask: vi.fn(async () => undefined),
      addTask: vi.fn(async () => {
        throw haltError;
      }),
      upsertSharedDocument: vi.fn(async () => undefined),
    });

    const result = (await getHandler("add_task")({
      slug: "new-task",
      title: "New task",
      instructions: "Do something.",
    })) as { content: Array<{ text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toBe("iteration halted: circuit_breaker");
  });

  it("omits request_collaboration when allowAgentCollaboration is false", () => {
    registerGraphWorkflowExecutionTools(createCapturingServer() as never, {
      executionContextTitle: "Implement",
      allowAgentTaskAdd: false,
      allowAgentCollaboration: false,
      completeTask: vi.fn(async () => undefined),
      addTask: vi.fn(async () => undefined),
      upsertSharedDocument: vi.fn(async () => undefined),
    });

    expect(getCapturedTools().has("request_collaboration")).toBe(false);
  });

  it("registers request_collaboration when allowAgentCollaboration is true and a collaboration block is provided", () => {
    registerGraphWorkflowExecutionTools(createCapturingServer() as never, {
      executionContextTitle: "Implement",
      allowAgentTaskAdd: false,
      allowAgentCollaboration: true,
      collaboration: {
        parentImplementerTurnId: "turn-7",
        executionContextId: "context-implement",
        conversationId: "conv-abc",
        executionId: "exec-123",
        iterationIndex: 0,
        resolveCollaborationConfig: () => ({
          secondAgent: {
            value: {
              backend: "codex",
              model: "gpt-5.4",
              reasoningEffort: "medium",
            },
            source: "global",
          },
          negotiationRounds: { value: 3, source: "workflow" },
          autonomousResolutionThreshold: {
            value: "minor",
            source: "per-node",
          },
        }),
        startWorkflowCollaboration: async () => ({
          result: {
            status: "converged",
            finalAnswer: "ok",
            openConflicts: [],
          },
          roundsConsumed: 1,
        }),
        setPendingHaltReason: async () => undefined,
      },
      completeTask: vi.fn(async () => undefined),
      addTask: vi.fn(async () => undefined),
      upsertSharedDocument: vi.fn(async () => undefined),
    });

    expect(getCapturedTools().has("request_collaboration")).toBe(true);
  });

  it("fails closed on invalid payloads and callback errors", async () => {
    registerGraphWorkflowExecutionTools(createCapturingServer() as never, {
      executionContextTitle: "Plan",
      allowAgentTaskAdd: true,
      allowAgentCollaboration: false,
      completeTask: vi.fn(async () => undefined),
      addTask: vi.fn(async () => undefined),
      upsertSharedDocument: vi.fn(async () => {
        throw new Error("Path escaped shared-document directory");
      }),
    });

    const failingDocumentResult = (await getHandler("upsert_shared_document")({
      relativePath: ".cc/graph-workflow-docs/plan.md",
      description: "Planning notes",
      readWhen: "Read before implementation.",
    })) as { content: Array<{ text: string }>; isError: boolean };

    expect(failingDocumentResult.isError).toBe(true);
    expect(failingDocumentResult.content[0]?.text).toContain(
      "Path escaped shared-document directory",
    );
  });
});

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
    secondAgent: {
      value: { backend: "codex", model: "gpt-5.4", reasoningEffort: "medium" },
      source: "global",
    },
    negotiationRounds: { value: 3, source: "workflow" },
    autonomousResolutionThreshold: { value: "minor", source: "per-node" },
  };

  const CONVERGED_RESULT: WorkflowCollaborationResult = {
    status: "converged",
    finalAnswer: "Adopt Postgres for the new service tier.",
    openConflicts: [],
  };

  const NON_CONVERGED_RESULT: WorkflowCollaborationResult = {
    status: "objective_disagreement",
    finalAnswer: null,
    openConflicts: [
      {
        rejectingAgent: "agent_one",
        disputedPoint: "Postgres vs MySQL is the wrong dichotomy",
        severity: "blocking",
        category: "objective",
      },
    ],
  };

  function buildContext(overrides?: {
    startWorkflowCollaboration?: RequestCollaborationHandlerContext["startWorkflowCollaboration"];
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
      startWorkflowCollaboration:
        overrides?.startWorkflowCollaboration ??
        (async () => ({ result: CONVERGED_RESULT, roundsConsumed: 1 })),
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

  it("returns a validation-error tool result and never invokes the envelope when brief is empty", async () => {
    const startWorkflowCollaboration = vi.fn();
    const setPendingHaltReason = vi.fn();
    const resolveCollaborationConfig = vi.fn(() => RESOLVED_CONFIG);
    const handler = createRequestCollaborationHandler(
      buildContext({
        startWorkflowCollaboration,
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
    expect(startWorkflowCollaboration).not.toHaveBeenCalled();
    expect(setPendingHaltReason).not.toHaveBeenCalled();
    expect(resolveCollaborationConfig).not.toHaveBeenCalled();
  });

  it("returns a validation-error tool result for a whitespace-only brief", async () => {
    const startWorkflowCollaboration = vi.fn();
    const handler = createRequestCollaborationHandler(
      buildContext({ startWorkflowCollaboration }),
      buildDeps(),
    );

    const result = (await handler({ brief: "   \n  " })) as {
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(startWorkflowCollaboration).not.toHaveBeenCalled();
  });

  it("returns a validation-error tool result for missing brief field", async () => {
    const startWorkflowCollaboration = vi.fn();
    const handler = createRequestCollaborationHandler(
      buildContext({ startWorkflowCollaboration }),
      buildDeps(),
    );

    const result = (await handler({})) as { isError?: boolean };

    expect(result.isError).toBe(true);
    expect(startWorkflowCollaboration).not.toHaveBeenCalled();
  });

  it("invokes the workflow envelope with the resolved config, parentImplementerTurnId, executionContextId, and conversationId on a valid brief", async () => {
    const startWorkflowCollaboration = vi.fn(async () => ({
      result: CONVERGED_RESULT,
      roundsConsumed: 1,
    }));
    const handler = createRequestCollaborationHandler(
      buildContext({ startWorkflowCollaboration }),
      buildDeps(),
    );

    await handler({ brief: "Should we adopt Postgres?" });

    expect(startWorkflowCollaboration).toHaveBeenCalledTimes(1);
    expect(startWorkflowCollaboration).toHaveBeenCalledWith({
      brief: "Should we adopt Postgres?",
      resolvedConfig: RESOLVED_CONFIG,
      parentImplementerTurnId: "turn-7",
      executionContextId: "context-implement",
      conversationId: "conv-abc",
      executionId: "exec-123",
      iterationIndex: 0,
    });
  });

  it("does NOT set pendingHaltReason on a converged outcome", async () => {
    const setPendingHaltReason = vi.fn();
    const startWorkflowCollaboration = vi.fn(async () => ({
      result: CONVERGED_RESULT,
      roundsConsumed: 1,
    }));
    const handler = createRequestCollaborationHandler(
      buildContext({ startWorkflowCollaboration, setPendingHaltReason }),
      buildDeps(),
    );

    await handler({ brief: "Should we adopt Postgres?" });

    expect(setPendingHaltReason).not.toHaveBeenCalled();
  });

  it("sets pendingHaltReason on a non-converged outcome with the four required fields", async () => {
    const haltCalls: GraphWorkflowHaltReason[] = [];
    const setPendingHaltReason = vi.fn(async (reason) => {
      haltCalls.push(reason);
    });
    const startWorkflowCollaboration = vi.fn(async () => ({
      result: NON_CONVERGED_RESULT,
      roundsConsumed: 2,
    }));
    const handler = createRequestCollaborationHandler(
      buildContext({ startWorkflowCollaboration, setPendingHaltReason }),
      buildDeps(),
    );

    await handler({ brief: "Should we adopt Postgres?" });

    expect(haltCalls).toHaveLength(1);
    const reason = haltCalls[0]!;
    expect(reason.type).toBe("collaboration_failure");
    if (reason.type === "collaboration_failure") {
      expect(reason.status).toBe("objective_disagreement");
      expect(reason.brief).toBe("Should we adopt Postgres?");
      expect(reason.executionContextId).toBe("context-implement");
      expect(reason.conversationId).toBe("conv-abc");
      expect(reason.summary.length).toBeGreaterThan(0);
    }
  });

  it("sets pendingHaltReason BEFORE constructing the tool result on the non-converged path", async () => {
    const callOrder: string[] = [];
    const setPendingHaltReason = vi.fn(async () => {
      callOrder.push("setPendingHaltReason");
    });
    const startWorkflowCollaboration = vi.fn(async () => {
      callOrder.push("startWorkflowCollaboration");
      return { result: NON_CONVERGED_RESULT, roundsConsumed: 2 };
    });
    const executionLoggerStub = buildExecutionLoggerStub(callOrder);
    const handler = createRequestCollaborationHandler(
      buildContext({ startWorkflowCollaboration, setPendingHaltReason }),
      buildDeps({ getExecutionLogger: () => executionLoggerStub }),
    );

    await handler({ brief: "Should we adopt Postgres?" });
    callOrder.push("handlerReturned");

    const haltIdx = callOrder.indexOf("setPendingHaltReason");
    const failureLogIdx = callOrder.indexOf(
      "decision:collaboration.failure_halt",
    );
    const completedLogIdx = callOrder.indexOf(
      "task:context-implement:collaboration.request_collaboration.completed",
    );
    const returnedIdx = callOrder.indexOf("handlerReturned");

    expect(haltIdx).toBeGreaterThanOrEqual(0);
    expect(returnedIdx).toBeGreaterThanOrEqual(0);
    expect(haltIdx).toBeLessThan(returnedIdx);
    expect(completedLogIdx).toBeLessThan(haltIdx);
    expect(haltIdx).toBeLessThan(failureLogIdx);
  });

  it("writes the invocation and completion log events through the execution logger on the converged path", async () => {
    const callOrder: string[] = [];
    const executionLoggerStub = buildExecutionLoggerStub(callOrder);
    const startWorkflowCollaboration = vi.fn(async () => {
      callOrder.push("startWorkflowCollaboration");
      return { result: CONVERGED_RESULT, roundsConsumed: 1 };
    });
    const handler = createRequestCollaborationHandler(
      buildContext({ startWorkflowCollaboration }),
      buildDeps({ getExecutionLogger: () => executionLoggerStub }),
    );

    await handler({ brief: "Should we adopt Postgres?" });

    expect(callOrder).toEqual([
      "task:context-implement:collaboration.request_collaboration.invoked",
      "startWorkflowCollaboration",
      "task:context-implement:collaboration.request_collaboration.completed",
    ]);
  });

  it("returns a text tool result containing the serialized WorkflowCollaborationResult on the converged path", async () => {
    const startWorkflowCollaboration = vi.fn(async () => ({
      result: CONVERGED_RESULT,
      roundsConsumed: 1,
    }));
    const handler = createRequestCollaborationHandler(
      buildContext({ startWorkflowCollaboration }),
      buildDeps(),
    );

    const result = (await handler({
      brief: "Should we adopt Postgres?",
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("converged");
    expect(text).toContain("Adopt Postgres for the new service tier.");
  });

  it("returns a tool result on the non-converged path that the agent can still read (no thrown exception)", async () => {
    const startWorkflowCollaboration = vi.fn(async () => ({
      result: NON_CONVERGED_RESULT,
      roundsConsumed: 2,
    }));
    const handler = createRequestCollaborationHandler(
      buildContext({ startWorkflowCollaboration }),
      buildDeps(),
    );

    const result = (await handler({
      brief: "Should we adopt Postgres?",
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.content[0]?.text ?? "").toContain("objective_disagreement");
  });

  it("does not write a failure_halt decision log on the converged path", async () => {
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

  describe("Task 5.1 — captured execution-log payloads", () => {
    interface CapturedTaskRow {
      contextId: string;
      event: string;
      payload: Record<string, unknown> | undefined;
    }

    interface CapturedDecisionRow {
      event: string;
      payload: Record<string, unknown> | undefined;
    }

    function buildPayloadCapturingLogger(): {
      logger: ExecutionLogger;
      tasks: CapturedTaskRow[];
      decisions: CapturedDecisionRow[];
    } {
      const tasks: CapturedTaskRow[] = [];
      const decisions: CapturedDecisionRow[] = [];
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
        decision: vi.fn((event: string, data) => {
          decisions.push({ event, payload: data });
        }),
      };
      return { logger, tasks, decisions };
    }

    it("(happy path) tasks.jsonl `invoked` row carries brief and resolvedConfig with source fields", async () => {
      const { logger, tasks } = buildPayloadCapturingLogger();
      const handler = createRequestCollaborationHandler(
        buildContext({
          startWorkflowCollaboration: async () => ({
            result: CONVERGED_RESULT,
            roundsConsumed: 1,
          }),
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

    it("(happy path) tasks.jsonl `completed` row carries status, roundsConsumed, openConflictsSummary, and resolvedConfig", async () => {
      const { logger, tasks } = buildPayloadCapturingLogger();
      const handler = createRequestCollaborationHandler(
        buildContext({
          startWorkflowCollaboration: async () => ({
            result: CONVERGED_RESULT,
            roundsConsumed: 2,
          }),
        }),
        buildDeps({ getExecutionLogger: () => logger }),
      );

      await handler({ brief: "Should we adopt Postgres?" });

      const completed = tasks.find(
        (row) => row.event === "collaboration.request_collaboration.completed",
      );
      expect(completed).toBeDefined();
      const payload = completed?.payload ?? {};
      expect(payload.status).toBe("converged");
      expect(payload.roundsConsumed).toBe(2);
      expect(Array.isArray(payload.openConflictsSummary)).toBe(true);
      expect(payload.resolvedConfig).toBeDefined();
      expect(
        (payload.resolvedConfig as ResolvedCollaborationConfig).secondAgent
          .value.backend,
      ).toBe("codex");
    });

    it("(failure path) decisions.jsonl `failure_halt` row carries brief, resolvedConfig, and open-conflicts payload", async () => {
      const { logger, decisions } = buildPayloadCapturingLogger();
      const handler = createRequestCollaborationHandler(
        buildContext({
          startWorkflowCollaboration: async () => ({
            result: NON_CONVERGED_RESULT,
            roundsConsumed: 2,
          }),
        }),
        buildDeps({ getExecutionLogger: () => logger }),
      );

      await handler({ brief: "Should we adopt Postgres?" });

      const failureHalt = decisions.find(
        (row) => row.event === "collaboration.failure_halt",
      );
      expect(failureHalt).toBeDefined();
      const payload = failureHalt?.payload ?? {};
      expect(payload.brief).toBe("Should we adopt Postgres?");
      expect(payload.executionContextId).toBe("context-implement");
      expect(payload.conversationId).toBe("conv-abc");
      expect(payload.parentImplementerTurnId).toBe("turn-7");
      expect(payload.status).toBe("objective_disagreement");

      const conflicts = payload.openConflicts as
        | Array<{ rejectingAgent: string; disputedPoint: string }>
        | undefined;
      expect(conflicts?.length).toBeGreaterThan(0);
      expect(conflicts?.[0]?.disputedPoint).toContain("Postgres");

      const resolved = payload.resolvedConfig as
        | ResolvedCollaborationConfig
        | undefined;
      expect(resolved?.secondAgent.source).toBe("global");
    });

    it("(failure path) records pendingHaltReason before the handler returns even when the writer resolves asynchronously", async () => {
      const callOrder: string[] = [];
      const setPendingHaltReason = vi.fn(async () => {
        // Force the writer to yield to the microtask queue before resolving.
        // The handler must await this write before constructing/returning the
        // tool result; if the await is dropped, the ordering assertion fails.
        await new Promise<void>((resolve) => setImmediate(resolve));
        callOrder.push("setPendingHaltReason");
      });
      const startWorkflowCollaboration = vi.fn(async () => ({
        result: NON_CONVERGED_RESULT,
        roundsConsumed: 2,
      }));
      const handler = createRequestCollaborationHandler(
        buildContext({ startWorkflowCollaboration, setPendingHaltReason }),
        buildDeps(),
      );

      await handler({ brief: "Should we adopt Postgres?" });
      callOrder.push("handlerReturned");

      const haltIdx = callOrder.indexOf("setPendingHaltReason");
      const returnedIdx = callOrder.indexOf("handlerReturned");
      expect(haltIdx).toBeGreaterThanOrEqual(0);
      expect(returnedIdx).toBeGreaterThan(haltIdx);
    });
  });
});
