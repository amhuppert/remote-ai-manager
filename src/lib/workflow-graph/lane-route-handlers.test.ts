import { describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import type { LiveOccupancySnapshot } from "@/lib/conversations/live-occupancy";
import type {
  GraphWorkflowAgentSessionState,
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
} from "@/lib/workflows/schemas";
import { createGraphWorkflowExecutionToolContext } from "./execution-tool-context";
import { createGraphWorkflowRuntimeEditService } from "./runtime-edits";
import { createGraphWorkflowSharedDocumentRegistryService } from "./shared-documents";
import { createWorkflowExecution } from "./test-fixtures";
import {
  createLaneRouteHandlers,
  type LaneRouteDeps,
} from "./lane-route-handlers";
import type {
  GraphWorkflowCollaborationContextBlock,
  GraphWorkflowToolServerContext,
} from "./lane-tool-service";
import type { PendingToolBlock } from "./tool-dispatcher";
import type { ExecutionTarget } from "./execution-target-resolver";
import type { LoadLaneToolContextResult } from "./lane-tool-context-loader";

/**
 * Route-handler unit tests for the lane tool endpoints. The tool context is the
 * REAL `createGraphWorkflowExecutionToolContext` over a serialized fake
 * `mutateActive` (mirroring the store's write queue) so completeTask, the
 * mid-turn rotation gate, and the idempotent double-complete guard all exercise
 * production logic — only the HTTP transport, the halt/block signals, and the
 * capability flags are controlled per test.
 */

const sessionTarget: ExecutionTarget = {
  worktreePath: "/repo/.worktrees/session-1",
  branchName: "csm/session-1",
  isolation: "session",
  laneId: null,
};

interface FakeStore {
  current: GraphWorkflowExecution;
  serializedQueue: Promise<unknown>;
  mutateCount: number;
}

function createFakeStore(initial: GraphWorkflowExecution): FakeStore {
  return {
    current: structuredClone(initial),
    serializedQueue: Promise.resolve(),
    mutateCount: 0,
  };
}

function createFakeMutateActive(store: FakeStore) {
  return async function mutateActive(
    _projectPath: string,
    _sessionName: string,
    fn: (
      execution: GraphWorkflowExecution,
    ) => GraphWorkflowExecution | Promise<GraphWorkflowExecution>,
  ): Promise<GraphWorkflowExecution> {
    const next = store.serializedQueue.then(async () => {
      store.mutateCount += 1;
      const draft = structuredClone(store.current);
      const result = await fn(draft);
      store.current = structuredClone(result);
      return store.current;
    });
    store.serializedQueue = next.catch(() => undefined);
    return next;
  };
}

function makeClaudeLane(
  overrides: Partial<
    Extract<GraphWorkflowAgentSessionState, { engine: "claude" }>
  > = {},
): GraphWorkflowAgentSessionState {
  return {
    engine: "claude",
    lane: "implementer",
    contextId: "context-plan",
    sessionRef: {
      engine: "claude",
      lane: "implementer",
      conversationId: "conv-bound",
    },
    lastContextTokens: null,
    lastContextWindowMax: null,
    rotateBeforeNextTurn: false,
    limitEvaluation: "disabled",
    lastUsedAt: "2026-03-27T11:00:00.000Z",
    ...overrides,
  };
}

function buildRunningExecution(
  options: {
    limit?: number;
    lane?: GraphWorkflowAgentSessionState;
  } = {},
): GraphWorkflowExecution {
  const base = createWorkflowExecution();
  const planState = base.contextStates["context-plan"];
  if (!planState) throw new Error("fixture missing context-plan");
  const running: GraphWorkflowExecution = {
    ...base,
    status: "running",
    activeContextIds: ["context-plan"],
    contextStates: {
      ...base.contextStates,
      "context-plan": {
        ...planState,
        status: "running",
        worktreePath: null,
        branchName: null,
        isolation: "session",
      },
    },
  };

  if (options.limit !== undefined) {
    running.workingDefinition = {
      ...running.workingDefinition,
      executionContexts: running.workingDefinition.executionContexts.map(
        (ctx) =>
          ctx.id === "context-plan"
            ? {
                ...ctx,
                iterationPolicy: {
                  ...ctx.iterationPolicy,
                  continuity: {
                    ...ctx.iterationPolicy.continuity,
                    contextLimitTokens: options.limit,
                  },
                },
              }
            : ctx,
      ),
    };
  }

  if (options.lane) {
    running.laneStates = {
      ...running.laneStates,
      "context-plan": { implementer: options.lane },
    };
  }

  return running;
}

interface BuildContextOptions {
  execution?: GraphWorkflowExecution;
  readLiveOccupancy?: (conversationId: string) => LiveOccupancySnapshot | null;
  allowAgentTaskAdd?: boolean;
  allowAgentCollaboration?: boolean;
  collaboration?: GraphWorkflowCollaborationContextBlock;
  pendingHaltReason?: GraphWorkflowHaltReason | null;
  pendingToolBlock?: PendingToolBlock | null;
}

function buildContext(options: BuildContextOptions = {}): {
  store: FakeStore;
  context: GraphWorkflowToolServerContext;
} {
  const store = createFakeStore(options.execution ?? buildRunningExecution());
  const factory = createGraphWorkflowExecutionToolContext({
    workflowManager: { mutateActive: createFakeMutateActive(store) },
    runtimeEditService: createGraphWorkflowRuntimeEditService({
      createTaskId: () => "task-agent-generated",
      now: () => "2026-03-27T12:00:00.000Z",
    }),
    sharedDocumentRegistry: createGraphWorkflowSharedDocumentRegistryService({
      now: () => "2026-03-27T12:00:00.000Z",
      createDocumentId: () => "doc-1",
    }),
    readLiveOccupancy: options.readLiveOccupancy ?? (() => null),
    now: () => "2026-03-27T12:00:00.000Z",
  });
  const bound = factory.create({
    projectPath: "/projects/test",
    sessionName: "session-1",
    executionId: "execution-1",
    contextId: "context-plan",
    conversationId: "conv-bound",
    executionTarget: sessionTarget,
    executionContextTitle: "Plan",
    allowAgentTaskAdd: options.allowAgentTaskAdd ?? true,
    allowAgentCollaboration: options.allowAgentCollaboration ?? false,
    ...(options.collaboration ? { collaboration: options.collaboration } : {}),
  });
  const context: GraphWorkflowToolServerContext = {
    ...bound,
    getPendingHaltReason: async () => options.pendingHaltReason ?? null,
    getPendingToolBlock: async () => options.pendingToolBlock ?? null,
  };
  return { store, context };
}

function makeDeps(
  context: GraphWorkflowToolServerContext,
  loadResult?: LoadLaneToolContextResult,
): LaneRouteDeps {
  return {
    auth: {
      async requireToken() {
        return null;
      },
      async validateOptionalToken() {
        return { kind: "valid" as const };
      },
    },
    async resolveProjectPath() {
      return "/projects/test";
    },
    async loadLaneToolContext() {
      return loadResult ?? { ok: true, context };
    },
  };
}

function req(body: unknown): Request {
  return new Request("http://cc.local/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function params(p: Record<string, string>): {
  params: Promise<Record<string, string>>;
} {
  return { params: Promise.resolve(p) };
}

function docParams(p: Record<string, string | string[]>): {
  params: Promise<Record<string, string | string[]>>;
} {
  return { params: Promise.resolve(p) };
}

const BASE_PARAMS = {
  name: "cc",
  session: "session-1",
  contextId: "context-plan",
} as const;

const HALT_REASON: GraphWorkflowHaltReason = {
  type: "circuit_breaker",
  contextId: "context-plan",
  condition: "retry_exhaustion",
  failureCount: 3,
  summary: null,
};

describe("lane route handlers — complete task", () => {
  it("completes a task and reports the remaining-task fact", async () => {
    const { store, context } = buildContext();
    const handlers = createLaneRouteHandlers(makeDeps(context));

    const response = await handlers.completeTask(
      req({ executionId: "execution-1", summary: "Wrote the plan." }),
      params({ ...BASE_PARAMS, taskId: "task-plan-1" }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.stopInstruction).toBeUndefined();
    const state = store.current.contextStates["context-plan"];
    expect(body.remainingTaskCount).toBe(
      (state?.totalTaskCount ?? 0) - (state?.completedTaskCount ?? 0),
    );
    expect(store.current.taskStates["task-plan-1"]?.status).toBe("completed");
  });

  it("attaches the rotation-gate stopInstruction verbatim and omits it otherwise", async () => {
    const { context } = buildContext({
      execution: buildRunningExecution({ limit: 100, lane: makeClaudeLane() }),
      readLiveOccupancy: () => ({
        contextTokens: 200,
        compactedThisTurn: false,
      }),
    });
    const handlers = createLaneRouteHandlers(makeDeps(context));

    const response = await handlers.completeTask(
      req({ executionId: "execution-1", summary: "done" }),
      params({ ...BASE_PARAMS, taskId: "task-plan-1" }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.stopInstruction).toContain("CONTEXT LIMIT REACHED");
    expect(body.stopInstruction).toContain("End your turn now");
  });

  it("runs the halt-check FIRST — a pending halt yields 409 { halt, reason } and no mutation", async () => {
    const { store, context } = buildContext({ pendingHaltReason: HALT_REASON });
    const handlers = createLaneRouteHandlers(makeDeps(context));

    const response = await handlers.completeTask(
      req({ executionId: "execution-1", summary: "done" }),
      params({ ...BASE_PARAMS, taskId: "task-plan-1" }),
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.halt).toBe(true);
    expect(body.reason).toBe("iteration halted: circuit_breaker");
    // The completion must not have run.
    expect(store.mutateCount).toBe(0);
    expect(store.current.taskStates["task-plan-1"]?.status).not.toBe(
      "completed",
    );
  });

  it("surfaces a pending collaboration block as a 409 halt with the block's reason", async () => {
    const { context } = buildContext({
      pendingToolBlock: {
        type: "pending_collaboration",
        workflowId: "wf-7",
        contextId: "context-plan",
      },
    });
    const handlers = createLaneRouteHandlers(makeDeps(context));

    const response = await handlers.completeTask(
      req({ executionId: "execution-1", summary: "done" }),
      params({ ...BASE_PARAMS, taskId: "task-plan-1" }),
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.reason).toBe("collaboration pending: wf-7");
  });

  it("does not double-count under concurrent completions of the same task", async () => {
    const { store, context } = buildContext();
    const handlers = createLaneRouteHandlers(makeDeps(context));

    const [r1, r2] = await Promise.all([
      handlers.completeTask(
        req({ executionId: "execution-1", summary: "first" }),
        params({ ...BASE_PARAMS, taskId: "task-plan-1" }),
      ),
      handlers.completeTask(
        req({ executionId: "execution-1", summary: "second" }),
        params({ ...BASE_PARAMS, taskId: "task-plan-1" }),
      ),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const completed = Object.values(store.current.taskStates).filter(
      (t) => t.contextId === "context-plan" && t.status === "completed",
    );
    const planCompleted = completed.filter((t) => t.taskId === "task-plan-1");
    expect(planCompleted).toHaveLength(1);
    expect(
      store.current.contextStates["context-plan"]?.completedTaskCount,
    ).toBe(completed.length);
  });

  it("returns 400 on an invalid body", async () => {
    const { context } = buildContext();
    const handlers = createLaneRouteHandlers(makeDeps(context));

    const response = await handlers.completeTask(
      req({ executionId: "execution-1" }),
      params({ ...BASE_PARAMS, taskId: "task-plan-1" }),
    );

    expect(response.status).toBe(400);
  });

  it("maps a loader failure to its status", async () => {
    const { context } = buildContext();
    const handlers = createLaneRouteHandlers(
      makeDeps(context, {
        ok: false,
        status: 409,
        error: "Workflow execution context has no active agent conversation",
      }),
    );

    const response = await handlers.completeTask(
      req({ executionId: "execution-1", summary: "done" }),
      params({ ...BASE_PARAMS, taskId: "task-plan-1" }),
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toContain("no active agent conversation");
    expect(body.halt).toBeUndefined();
  });
});

describe("lane route handlers — add task", () => {
  it("appends a task when allowAgentTaskAdd is enabled", async () => {
    const { store, context } = buildContext({ allowAgentTaskAdd: true });
    const handlers = createLaneRouteHandlers(makeDeps(context));

    const response = await handlers.addTask(
      req({
        executionId: "execution-1",
        title: "Discovered task",
        instructions: "Handle the edge case.",
      }),
      params(BASE_PARAMS),
    );

    expect(response.status).toBe(200);
    const planTaskIds = store.current.workingDefinition.tasks
      .filter((t) => t.contextId === "context-plan")
      .map((t) => t.id);
    expect(planTaskIds).toContain("task-agent-generated");
  });

  it("returns 403 with explanatory text when task-add is disabled", async () => {
    const { context } = buildContext({ allowAgentTaskAdd: false });
    const handlers = createLaneRouteHandlers(makeDeps(context));

    const response = await handlers.addTask(
      req({
        executionId: "execution-1",
        title: "Discovered task",
        instructions: "Handle the edge case.",
      }),
      params(BASE_PARAMS),
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain("does not allow agent-added tasks");
  });

  it("runs the halt-check before the capability gate", async () => {
    const { context } = buildContext({
      allowAgentTaskAdd: false,
      pendingHaltReason: HALT_REASON,
    });
    const handlers = createLaneRouteHandlers(makeDeps(context));

    const response = await handlers.addTask(
      req({
        executionId: "execution-1",
        title: "Discovered task",
        instructions: "Handle the edge case.",
      }),
      params(BASE_PARAMS),
    );

    expect(response.status).toBe(409);
  });
});

describe("lane route handlers — shared document upsert", () => {
  it("writes through the registry with the URL-derived relative path", async () => {
    const upsert = vi.fn(async () => buildRunningExecution());
    const base = buildContext();
    const context: GraphWorkflowToolServerContext = {
      ...base.context,
      upsertSharedDocument: upsert,
    };
    const handlers = createLaneRouteHandlers(makeDeps(context));

    const response = await handlers.upsertSharedDocument(
      req({
        executionId: "execution-1",
        contextId: "context-plan",
        description: "API contract",
        readWhen: "before implementing any route",
      }),
      docParams({
        name: "cc",
        session: "session-1",
        docPath: [".cc", "graph-workflow-docs", "api-contract.md"],
      }),
    );

    expect(response.status).toBe(200);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        relativePath: ".cc/graph-workflow-docs/api-contract.md",
        description: "API contract",
        readWhen: "before implementing any route",
      }),
    );
  });
});

describe("lane route handlers — collaboration request", () => {
  function makeCollaboration(
    trigger: () => Promise<{ workflowId: string }>,
  ): GraphWorkflowCollaborationContextBlock {
    return {
      parentImplementerTurnId: "turn-1",
      executionContextId: "context-plan",
      conversationId: "conv-bound",
      executionId: "execution-1",
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
        negotiationRounds: { value: 3, source: "global" },
        autonomousResolutionThreshold: { value: "minor", source: "global" },
      }),
      triggerWorkflowCollaboration: trigger,
      setPendingHaltReason: async () => {},
    };
  }

  it("starts a collaboration and returns the workflowId", async () => {
    const trigger = vi.fn(async () => ({ workflowId: "wf-42" }));
    const { context } = buildContext({
      allowAgentCollaboration: true,
      collaboration: makeCollaboration(trigger),
    });
    const handlers = createLaneRouteHandlers(makeDeps(context));

    const response = await handlers.requestCollaboration(
      req({ executionId: "execution-1", brief: "Which storage layer?" }),
      params(BASE_PARAMS),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.workflowId).toBe("wf-42");
    expect(trigger).toHaveBeenCalledOnce();
  });

  it("returns 403 when collaboration is disabled", async () => {
    const { context } = buildContext({ allowAgentCollaboration: false });
    const handlers = createLaneRouteHandlers(makeDeps(context));

    const response = await handlers.requestCollaboration(
      req({ executionId: "execution-1", brief: "Which storage layer?" }),
      params(BASE_PARAMS),
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain(
      "does not allow agent-initiated collaboration",
    );
  });
});

describe("lane route handlers — token gate", () => {
  const invocations: Array<
    [
      string,
      (
        handlers: ReturnType<typeof createLaneRouteHandlers>,
      ) => Promise<Response>,
    ]
  > = [
    [
      "completeTask",
      (handlers) =>
        handlers.completeTask(
          req({ executionId: "execution-1", summary: "done" }),
          params({ ...BASE_PARAMS, taskId: "task-plan-1" }),
        ),
    ],
    [
      "addTask",
      (handlers) =>
        handlers.addTask(
          req({
            executionId: "execution-1",
            title: "Follow-up",
            instructions: "Do the follow-up.",
          }),
          params(BASE_PARAMS),
        ),
    ],
    [
      "upsertSharedDocument",
      (handlers) =>
        handlers.upsertSharedDocument(
          req({
            executionId: "execution-1",
            contextId: "context-plan",
            description: "API contract",
            readWhen: "before implementing any route",
          }),
          docParams({
            name: "cc",
            session: "session-1",
            docPath: ["doc.md"],
          }),
        ),
    ],
    [
      "requestCollaboration",
      (handlers) =>
        handlers.requestCollaboration(
          req({ executionId: "execution-1", brief: "Which storage layer?" }),
          params(BASE_PARAMS),
        ),
    ],
  ];

  it.each(invocations)(
    "%s rejects a missing/invalid token with 401 before any lane work",
    async (_label, invoke) => {
      const { store, context } = buildContext();
      const loadLaneToolContext = vi.fn(
        async (): Promise<LoadLaneToolContextResult> => ({
          ok: true,
          context,
        }),
      );
      const resolveProjectPath = vi.fn(async () => "/projects/test");
      const handlers = createLaneRouteHandlers({
        auth: {
          async requireToken() {
            return NextResponse.json(
              { error: "Invalid or missing Command Center API token" },
              { status: 401 },
            );
          },
          async validateOptionalToken() {
            return { kind: "invalid" as const };
          },
        },
        resolveProjectPath,
        loadLaneToolContext,
      });

      const response = await invoke(handlers);

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toContain("token");
      expect(resolveProjectPath).not.toHaveBeenCalled();
      expect(loadLaneToolContext).not.toHaveBeenCalled();
      expect(store.mutateCount).toBe(0);
    },
  );
});
