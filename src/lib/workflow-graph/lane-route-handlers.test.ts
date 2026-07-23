import { describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import type { LiveOccupancySnapshot } from "@/lib/conversations/live-occupancy";
import type {
  GraphWorkflowAgentSessionState,
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
} from "@/lib/workflow-graph/schemas";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
import type { MutateActiveResult } from "./execution-repository";
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
import { GraphExecutionContractViolationError } from "./execution-contract-port";

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

function isMutateActiveResult(
  value: MutateActiveResult | GraphWorkflowExecution,
): value is MutateActiveResult {
  return (
    "execution" in value &&
    "events" in value &&
    Array.isArray((value as MutateActiveResult).events)
  );
}

function createFakeMutateActive(
  store: FakeStore,
  // The publisher the fake seam delivers through post-commit, mirroring the real
  // `createGraphWorkflowExecutionRepository`: the reducer returns inert
  // `{ events, pushes }` DATA and the broadcast fires only after the (fake)
  // commit — never from a callable the reducer returned (`post-commit-delivery`).
  eventPublisher: ReturnType<typeof createGraphWorkflowExecutionEventPublisher>,
) {
  return async function mutateActive(
    _projectPath: string,
    _sessionName: string,
    fn: (
      execution: GraphWorkflowExecution,
    ) => MutateActiveResult | GraphWorkflowExecution,
  ): Promise<GraphWorkflowExecution> {
    const next = store.serializedQueue.then(() => {
      store.mutateCount += 1;
      const draft = structuredClone(store.current);
      const result = fn(draft);
      const execution = isMutateActiveResult(result)
        ? result.execution
        : result;
      store.current = structuredClone(execution);
      // Mirror the production seam: broadcast the derived events only after the
      // (fake) commit.
      if (isMutateActiveResult(result)) {
        eventPublisher.deliver({
          events: result.events,
          pushes: result.pushes ?? [],
        });
      }
      return store.current;
    });
    store.serializedQueue = next.catch(() => undefined);
    return next;
  };
}

function makeClaudeLane(
  overrides: Partial<GraphWorkflowAgentSessionState> = {},
): GraphWorkflowAgentSessionState {
  const metrics = {
    rotateBeforeNextTurn: false,
    ...overrides.metrics,
  };
  return {
    backend: "claude",
    refKind: "conversation",
    lane: "implementer",
    contextId: "context-plan",
    workflowConversationId: "conv-bound",
    sessionRef: { backend: "claude", ref: "conv-bound" },
    limitEvaluation: "disabled",
    lastUsedAt: "2026-03-27T11:00:00.000Z",
    ...overrides,
    metrics,
  };
}

function buildRunningExecution(
  options: {
    limit?: number;
    lane?: GraphWorkflowAgentSessionState;
    iterationCount?: number;
    /**
     * Adds a second pending task to context-plan so completing task-plan-1
     * leaves work remaining (the base fixture has a single task, making every
     * completion a final-task completion).
     */
    secondPlanTask?: boolean;
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
        iterationCount: options.iterationCount ?? planState.iterationCount,
        worktreePath: null,
        branchName: null,
        isolation: "session",
        totalTaskCount: options.secondPlanTask ? 2 : planState.totalTaskCount,
      },
    },
  };

  if (options.secondPlanTask) {
    running.workingDefinition = {
      ...running.workingDefinition,
      tasks: [
        ...running.workingDefinition.tasks,
        {
          id: "task-plan-2",
          contextId: "context-plan",
          order: 2,
          title: "Write plan",
          instructions: "Document the implementation plan.",
          source: "user",
        },
      ],
    };
    running.taskStates = {
      ...running.taskStates,
      "task-plan-2": {
        taskId: "task-plan-2",
        contextId: "context-plan",
        order: 2,
        status: "pending",
        summary: null,
        startedAt: null,
        completedAt: null,
        lastConversationId: null,
        failureMessage: null,
        failureHistory: [],
      },
    };
  }

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
  broadcast: ReturnType<typeof vi.fn>;
} {
  const store = createFakeStore(options.execution ?? buildRunningExecution());
  const broadcast = vi.fn();
  const eventPublisher = createGraphWorkflowExecutionEventPublisher({
    broadcast,
    now: () => "2026-03-27T12:00:00.000Z",
  });
  const factory = createGraphWorkflowExecutionToolContext({
    workflowManager: {
      mutateActive: createFakeMutateActive(store, eventPublisher),
    },
    runtimeEditService: createGraphWorkflowRuntimeEditService({
      createTaskId: () => "task-agent-generated",
      now: () => "2026-03-27T12:00:00.000Z",
    }),
    sharedDocumentRegistry: createGraphWorkflowSharedDocumentRegistryService({
      now: () => "2026-03-27T12:00:00.000Z",
      createDocumentId: () => "doc-1",
    }),
    publishLiveEditApplied: eventPublisher.publishLiveEditApplied,
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
  return { store, context, broadcast };
}

const DEFAULT_REMINDER_STATE = {
  iterationCount: 0,
  circuitBreakerThreshold: 3,
  remainingTaskCount: 1,
} as const;

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
      return (
        loadResult ?? {
          ok: true,
          context,
          reminderState: { ...DEFAULT_REMINDER_STATE },
        }
      );
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

  it("returns the execution-contract completion refusal as a machine-readable 409", async () => {
    const { context } = buildContext();
    const refusingContext: GraphWorkflowToolServerContext = {
      ...context,
      async completeTask() {
        throw new GraphExecutionContractViolationError({
          ok: false,
          code: "spec_predecessor_incomplete",
          issues: [
            {
              code: "spec-predecessor-incomplete",
              message: "Complete T1 before T2.",
            },
          ],
          instruction: "Complete T1 before retrying T2.",
        });
      },
    };
    const handlers = createLaneRouteHandlers(makeDeps(refusingContext));

    const response = await handlers.completeTask(
      req({ executionId: "execution-1", summary: "out of order" }),
      params({ ...BASE_PARAMS, taskId: "task-plan-1" }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "spec_predecessor_incomplete",
      issues: [{ code: "spec-predecessor-incomplete" }],
      instruction: "Complete T1 before retrying T2.",
    });
  });

  it("attaches lane reminders to the success body when the iteration budget is near the threshold", async () => {
    // iterationCount 2, default threshold 3 → iteration-budget fires (3−2=1≤2),
    // and completing the fixture's only task makes this a final completion, so
    // final-task-self-check fires too; lane-autonomy (2≥2) is capped out.
    const { context } = buildContext({
      execution: buildRunningExecution({ iterationCount: 2 }),
    });
    const handlers = createLaneRouteHandlers(makeDeps(context));

    const response = await handlers.completeTask(
      req({ executionId: "execution-1", summary: "done" }),
      params({ ...BASE_PARAMS, taskId: "task-plan-1" }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.reminders).toHaveLength(2);
    expect(body.reminders[0]).toContain("used 2 of 3 iterations");
    expect(body.reminders[0]).toContain(
      "script validators run before agent validators",
    );
    expect(body.reminders[1]).toContain("acceptance criterion");
  });

  it("attaches the final-task self-check reminder when the last task completes", async () => {
    // Default fixture: single task, iterationCount 0 → the self-check is the
    // only rule firing on the final completion.
    const { context } = buildContext();
    const handlers = createLaneRouteHandlers(makeDeps(context));

    const response = await handlers.completeTask(
      req({ executionId: "execution-1", summary: "done" }),
      params({ ...BASE_PARAMS, taskId: "task-plan-1" }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.remainingTaskCount).toBe(0);
    expect(body.reminders).toHaveLength(1);
    expect(body.reminders[0]).toContain("acceptance criterion");
    expect(body.reminders[0]).toContain("charter invariant");
  });

  it("omits the reminders field entirely when no rule fires", async () => {
    // Second pending task keeps the completion non-final; iterationCount 0,
    // threshold 3 → no rule fires.
    const { context } = buildContext({
      execution: buildRunningExecution({ secondPlanTask: true }),
    });
    const handlers = createLaneRouteHandlers(makeDeps(context));

    const response = await handlers.completeTask(
      req({ executionId: "execution-1", summary: "done" }),
      params({ ...BASE_PARAMS, taskId: "task-plan-1" }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.remainingTaskCount).toBe(1);
    expect(body.reminders).toBeUndefined();
    expect("reminders" in body).toBe(false);
  });

  it("suppresses the final-task self-check when the rotation gate stops the turn", async () => {
    // Over-limit occupancy issues the stopInstruction on the final completion;
    // the self-check must not compete with the immediate-handoff order.
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
    expect(body.stopInstruction).toContain("CONTEXT LIMIT REACHED");
    expect(body.reminders).toBeUndefined();
  });

  it("attaches the halted-stop reminder to the 409 halt body", async () => {
    const { context } = buildContext({ pendingHaltReason: HALT_REASON });
    const handlers = createLaneRouteHandlers(makeDeps(context));

    const response = await handlers.completeTask(
      req({ executionId: "execution-1", summary: "done" }),
      params({ ...BASE_PARAMS, taskId: "task-plan-1" }),
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.halt).toBe(true);
    expect(body.reminders).toHaveLength(1);
    expect(body.reminders[0]).toContain("iteration halted: circuit_breaker");
    expect(body.reminders[0]).toContain("end your turn");
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
    const { store, context, broadcast } = buildContext({
      allowAgentTaskAdd: true,
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

    expect(response.status).toBe(200);
    const planTaskIds = store.current.workingDefinition.tasks
      .filter((t) => t.contextId === "context-plan")
      .map((t) => t.id);
    expect(planTaskIds).toContain("task-agent-generated");

    // The lane-agent add_task is a live edit: the mandatory event reaches the
    // wire with the server-derived source (doc 06 D12/D16).
    const liveEdit = broadcast.mock.calls
      .map((call) => call[0])
      .find((event) => event.type === "graph-workflow-live-edit-applied");
    expect(liveEdit).toMatchObject({
      type: "graph-workflow-live-edit-applied",
      source: "lane-agent",
      operationCount: 1,
      affectedContextIds: ["context-plan"],
    });
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
        enabled: { value: true, source: "global" },
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
          reminderState: { ...DEFAULT_REMINDER_STATE },
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
