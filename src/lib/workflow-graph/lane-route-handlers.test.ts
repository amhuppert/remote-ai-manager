import { createCcRuntimeFixture } from "@/cli/testing/framework";
import type {
  ExecutionMutationDecision as FixtureDecision,
  ExecutionMutationOutcome as FixtureOutcome,
} from "@/lib/workflow-graph/execution-mutation";
import { applyFixtureMutation } from "@/lib/workflow-graph/testing/execution-mutation-fixture";
import { createTestGraphExecutionContract } from "@/lib/workflow-graph/testing/execution-contract";
import { describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { withTracing } from "@/lib/logging";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import type {
  GraphWorkflowAgentSessionState,
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
} from "@/lib/workflow-graph/schemas";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";

import { createGraphWorkflowExecutionToolContext } from "./execution-tool-context";
import { createGraphWorkflowRuntimeEditService } from "./runtime-edits";
import { createGraphWorkflowSharedDocumentRegistryService } from "./shared-documents";
import { createWorkflowExecution } from "./test-fixtures";
import {
  createLaneRouteHandlers,
  type LaneRouteDeps,
} from "./lane-route-handlers";
import type { ExpansionRefusalNotice } from "./expansion-service";
import type {
  GraphWorkflowCollaborationContextBlock,
  GraphWorkflowToolServerContext,
} from "./lane-tool-service";
import type { PendingToolBlock } from "./tool-dispatcher";
import type { ExecutionTarget } from "./execution-target-resolver";
import type { LoadLaneToolContextResult } from "./lane-tool-context-loader";
import type { LaneIdentityReading } from "@/lib/agent-gateway/lane-identity";
import { GraphExecutionContractViolationError } from "./execution-contract-port";

/**
 * Route-handler unit tests for the lane tool endpoints. The tool context is the
 * REAL `createGraphWorkflowExecutionToolContext` over a serialized fake
 * `mutateActive` (mirroring the store's write queue) so completeTask, the
 * idempotent double-complete guard all exercise
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

function createFakeMutateActive(
  store: FakeStore,
  // The publisher the fake seam delivers through post-commit, mirroring the real
  // `createGraphWorkflowExecutionRepository`: the reducer returns inert
  // `{ events, pushes }` DATA and the broadcast fires only after the (fake)
  // commit — never from a callable the reducer returned (`post-commit-delivery`).
  eventPublisher: ReturnType<typeof createGraphWorkflowExecutionEventPublisher>,
) {
  return async function mutateActive<Value, Refusal>(
    _projectPath: string,
    _sessionName: string,
    fn: (execution: GraphWorkflowExecution) => FixtureDecision<Value, Refusal>,
  ): Promise<FixtureOutcome<Value, Refusal>> {
    const next = store.serializedQueue.then(() => {
      return applyFixtureMutation(store.current, fn, (next, delivery) => {
        store.mutateCount += 1;
        store.current = structuredClone(next);
        // Delivery follows the fake commit.
        eventPublisher.deliver(delivery);
      });
    });
    store.serializedQueue = next.catch(() => undefined);
    return next;
  };
}

function buildRunningExecution(
  options: {
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
    executionContract: createTestGraphExecutionContract(),
    executionRepository: {
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
    async readLaneIdentity() {
      return { kind: "absent" as const };
    },
    async expandGraph() {
      throw new Error("expandGraph is not wired in this fixture");
    },
    publishExpansionRefusal() {},
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
    const state = store.current.contextStates["context-plan"];
    expect(body.remainingTaskCount).toBe(
      (state?.totalTaskCount ?? 0) - (state?.completedTaskCount ?? 0),
    );
    expect(store.current.taskStates["task-plan-1"]?.status).toBe("completed");
  });

  /**
   * R1.2: the lane endpoints resolve the project themselves rather than going
   * through the session resolution seam, so the sentinel used to be carried into
   * the lane tool context loader as if it named a real session. Run through
   * `withTracing` because that is what puts the request path on the trace context
   * the refusal names its replacement from.
   */
  it("refuses the internal project sentinel in the public session position", async () => {
    const { context } = buildContext();
    let loadedLaneContext = false;
    const handlers = createLaneRouteHandlers({
      ...makeDeps(context),
      async loadLaneToolContext() {
        loadedLaneContext = true;
        throw new Error("lane context must not load for a refused request");
      },
    });
    const traced = withTracing(handlers.completeTask);

    const response = await traced(
      new Request(
        `http://cc.local/api/projects/cc/sessions/${PROJECT_CONVERSATION_SESSION_SENTINEL}/graph-workflow/contexts/context-plan/tasks/task-plan-1/complete`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            executionId: "execution-1",
            summary: "Wrote the plan.",
          }),
        },
      ),
      params({
        ...BASE_PARAMS,
        session: PROJECT_CONVERSATION_SESSION_SENTINEL,
        taskId: "task-plan-1",
      }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    // Graph workflow execution is session-only by spec non-goal, so the refusal
    // says so rather than naming a project route that would 404.
    expect(body.error).toContain("graph-workflow");
    expect(body.error).toContain("session-only");
    expect(body.error).not.toContain(PROJECT_CONVERSATION_SESSION_SENTINEL);
    expect(loadedLaneContext).toBe(false);
  });

  /**
   * The lane endpoints hand the session param to the loader exactly as received,
   * so the refusal cannot assume a decoded value — otherwise the sentinel gets
   * back in by being spelled differently.
   */
  it("refuses a percent-encoded sentinel in the session position", async () => {
    const { context } = buildContext();
    const handlers = createLaneRouteHandlers(makeDeps(context));

    const response = await handlers.completeTask(
      req({ executionId: "execution-1", summary: "Wrote the plan." }),
      params({
        ...BASE_PARAMS,
        session: "%5F%5Fproject%5F%5F",
        taskId: "task-plan-1",
      }),
    );

    expect(response.status).toBe(400);
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

  it("delivers post-completion reminders through the native CLI with the acknowledged task receipt", async () => {
    const { context } = buildContext({
      execution: buildRunningExecution({ iterationCount: 2 }),
    });
    const handlers = createLaneRouteHandlers(makeDeps(context));
    const fixture = createCcRuntimeFixture({
      env: {
        CC_WORKFLOW_EXECUTION_ID: "execution-1",
        CC_WORKFLOW_CONTEXT_ID: BASE_PARAMS.contextId,
      },
      respond: ({ init }) =>
        handlers.completeTask(
          new Request("http://cc.test/complete", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: init.body,
          }),
          params({ ...BASE_PARAMS, taskId: "task-plan-1" }),
        ),
    });
    const result = await fixture.run([
      "workflow",
      "task",
      "complete",
      "task-plan-1",
      "--summary",
      "done",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.effect).toBe("applied");
    expect(envelope.reminders).toHaveLength(2);
    expect(envelope.reminders[0]).toContain("used 2 of 3 iterations");
    expect(envelope.reminders[1]).toContain("acceptance criterion");
    expect(envelope.recovery.references).toContainEqual({
      kind: "workflow-task",
      id: "task-plan-1",
    });
  });

  it("returns the post-completion lane state used to evaluate reminders", async () => {
    const { context } = buildContext({
      execution: buildRunningExecution({ iterationCount: 2 }),
      allowAgentCollaboration: true,
    });
    const handlers = createLaneRouteHandlers(makeDeps(context));

    const response = await handlers.completeTask(
      req({ executionId: "execution-1", summary: "done" }),
      params({ ...BASE_PARAMS, taskId: "task-plan-1" }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.laneReminderState).toEqual({
      verb: "task-complete",
      iterationCount: 2,
      circuitBreakerThreshold: 3,
      remainingTaskCount: 0,
      halted: null,
      allowAgentCollaboration: true,
    });
  });

  it("reports no remaining tasks in reminder state when the last task completes", async () => {
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
    expect(body.laneReminderState).toMatchObject({
      remainingTaskCount: 0,
      halted: null,
    });
  });

  it("returns lane state even when no reminder rule fires", async () => {
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
    expect(body.laneReminderState).toEqual({
      verb: "task-complete",
      iterationCount: 0,
      circuitBreakerThreshold: 3,
      remainingTaskCount: 1,
      halted: null,
      allowAgentCollaboration: false,
    });
  });

  it("returns the loader's lane state and halt reason without completing the task", async () => {
    const { store, context } = buildContext({
      pendingHaltReason: HALT_REASON,
      allowAgentCollaboration: true,
    });
    const handlers = createLaneRouteHandlers(
      makeDeps(context, {
        ok: true,
        context,
        reminderState: {
          iterationCount: 2,
          circuitBreakerThreshold: 7,
          remainingTaskCount: 3,
        },
      }),
    );

    const response = await handlers.completeTask(
      req({ executionId: "execution-1", summary: "done" }),
      params({ ...BASE_PARAMS, taskId: "task-plan-1" }),
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.halt).toBe(true);
    expect(body.laneReminderState).toEqual({
      verb: "task-complete",
      iterationCount: 2,
      circuitBreakerThreshold: 7,
      remainingTaskCount: 3,
      halted: "iteration halted: circuit_breaker",
      allowAgentCollaboration: true,
    });
    expect(store.mutateCount).toBe(0);
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
            modelSelection: {
              modelId: "gpt-5.4",
              parameters: { reasoning: "medium", fast: "false" },
            },
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
        async readLaneIdentity() {
          return { kind: "absent" as const };
        },
        async expandGraph() {
          throw new Error("expandGraph is not wired in this fixture");
        },
        publishExpansionRefusal() {},
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

describe("lane route handlers — graph expansion capability chain", () => {
  const VALID_SCOPE = {
    laneKind: "implementer" as const,
    executionId: "execution-1",
    contextId: "context-plan",
    conversationId: "conversation-7",
  };

  const REQUEST = {
    requestId: "req-1",
    rationale: "Fan out one candidate per approach.",
    contexts: [
      {
        handle: "candidate-a",
        title: "Candidate A",
        acceptanceCriteria: "A works",
      },
    ],
    tasks: [
      {
        contextHandle: "candidate-a",
        title: "Build A",
        instructions: "Build approach A.",
      },
    ],
    edges: [{ from: "context-plan", to: "candidate-a" }],
  };

  function expansionDeps(
    context: GraphWorkflowToolServerContext,
    overrides: {
      capability?: LaneIdentityReading;
      expandGraph?: LaneRouteDeps["expandGraph"];
      refusals?: ExpansionRefusalNotice[];
    } = {},
  ): LaneRouteDeps {
    return {
      ...makeDeps(context),
      async readLaneIdentity() {
        return (
          overrides.capability ?? {
            kind: "valid" as const,
            scope: VALID_SCOPE,
          }
        );
      },
      publishExpansionRefusal(notice) {
        overrides.refusals?.push(notice);
      },
      expandGraph:
        overrides.expandGraph ??
        (async () => ({
          ok: true as const,
          replayed: false,
          liveRevision: 4,
          createdContextIds: ["context-plan-xdeadbeef-candidate-a"],
          createdTaskIds: ["context-plan-xdeadbeef-candidate-a-t1"],
          rejoinContextIds: [],
        })),
    };
  }

  it("passes the capability's conversation to the service and reports what was added", async () => {
    const { context } = buildContext();
    const seen: unknown[] = [];
    const handlers = createLaneRouteHandlers(
      expansionDeps(context, {
        async expandGraph(input) {
          seen.push(input);
          return {
            ok: true,
            replayed: false,
            liveRevision: 4,
            createdContextIds: ["context-plan-xdeadbeef-candidate-a"],
            createdTaskIds: ["context-plan-xdeadbeef-candidate-a-t1"],
            rejoinContextIds: ["context-verify"],
          };
        },
      }),
    );

    const response = await handlers.expandGraph(
      req({ executionId: "execution-1", request: REQUEST }),
      params({ ...BASE_PARAMS }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      replayed: false,
      liveRevision: 4,
      rejoinContextIds: ["context-verify"],
    });
    // The conversation the service re-checks comes from the SIGNED scope, never
    // from the request body — a lane cannot name someone else's conversation.
    expect(seen[0]).toMatchObject({
      contextId: "context-plan",
      conversationId: "conversation-7",
      executionId: "execution-1",
    });
  });

  it("distinguishes a replayed acceptance from a fresh one in its 200", async () => {
    // Both are successes carrying the same ids; only `replayed` tells the lane
    // whether it just changed the graph or was answered from a receipt (R6.3).
    const { context } = buildContext();
    const handlers = createLaneRouteHandlers(
      expansionDeps(context, {
        async expandGraph() {
          return {
            ok: true,
            replayed: true,
            liveRevision: 4,
            createdContextIds: ["context-plan-xdeadbeef-candidate-a"],
            createdTaskIds: ["context-plan-xdeadbeef-candidate-a-t1"],
            rejoinContextIds: [],
          };
        },
      }),
    );

    const response = await handlers.expandGraph(
      req({ executionId: "execution-1", request: REQUEST }),
      params({ ...BASE_PARAMS }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, replayed: true });
  });

  it("refuses with 403 when the request carries no capability", async () => {
    const { context } = buildContext();
    const expandGraph = vi.fn();
    const handlers = createLaneRouteHandlers(
      expansionDeps(context, {
        capability: { kind: "absent" },
        expandGraph: expandGraph as unknown as LaneRouteDeps["expandGraph"],
      }),
    );

    const response = await handlers.expandGraph(
      req({ executionId: "execution-1", request: REQUEST }),
      params({ ...BASE_PARAMS }),
    );

    expect(response.status).toBe(403);
    expect(expandGraph).not.toHaveBeenCalled();
  });

  it("refuses with 403 when the capability signature does not verify", async () => {
    const { context } = buildContext();
    const expandGraph = vi.fn();
    const handlers = createLaneRouteHandlers(
      expansionDeps(context, {
        capability: { kind: "invalid", reason: "malformed" },
        expandGraph: expandGraph as unknown as LaneRouteDeps["expandGraph"],
      }),
    );

    const response = await handlers.expandGraph(
      req({ executionId: "execution-1", request: REQUEST }),
      params({ ...BASE_PARAMS }),
    );

    expect(response.status).toBe(403);
    expect(expandGraph).not.toHaveBeenCalled();
  });

  it("refuses with 403 when the capability claims a non-implementer lane", async () => {
    const { context } = buildContext();
    const expandGraph = vi.fn();
    const refusals: ExpansionRefusalNotice[] = [];
    const handlers = createLaneRouteHandlers(
      expansionDeps(context, {
        // Only an implementer lane may expand (R7). The verifier refuses any
        // other kind BEFORE the scope is read as a claim, so an unsupported
        // kind never reaches the service at all.
        capability: { kind: "invalid", reason: "malformed" },
        expandGraph: expandGraph as unknown as LaneRouteDeps["expandGraph"],
        refusals,
      }),
    );

    const response = await handlers.expandGraph(
      req({ executionId: "execution-1", request: REQUEST }),
      params({ ...BASE_PARAMS }),
    );

    expect(response.status).toBe(403);
    expect(expandGraph).not.toHaveBeenCalled();
    expect(refusals.at(-1)).toMatchObject({
      refusalCode: "expansion-capability-invalid",
      requestId: "req-1",
    });
  });

  it("refuses with 403 when a valid capability is scoped to another context", async () => {
    const { context } = buildContext();
    const expandGraph = vi.fn();
    const handlers = createLaneRouteHandlers(
      expansionDeps(context, {
        capability: {
          kind: "valid",
          scope: { ...VALID_SCOPE, contextId: "context-implement" },
        },
        expandGraph: expandGraph as unknown as LaneRouteDeps["expandGraph"],
      }),
    );

    const response = await handlers.expandGraph(
      req({ executionId: "execution-1", request: REQUEST }),
      params({ ...BASE_PARAMS }),
    );

    expect(response.status).toBe(403);
    expect(expandGraph).not.toHaveBeenCalled();
  });

  it("refuses with 403 when a valid capability is scoped to another execution", async () => {
    const { context } = buildContext();
    const expandGraph = vi.fn();
    const handlers = createLaneRouteHandlers(
      expansionDeps(context, {
        capability: {
          kind: "valid",
          scope: { ...VALID_SCOPE, executionId: "execution-other" },
        },
        expandGraph: expandGraph as unknown as LaneRouteDeps["expandGraph"],
      }),
    );

    const response = await handlers.expandGraph(
      req({ executionId: "execution-1", request: REQUEST }),
      params({ ...BASE_PARAMS }),
    );

    expect(response.status).toBe(403);
    expect(expandGraph).not.toHaveBeenCalled();
  });

  it("rejects a malformed expansion payload with 400 before reaching the service", async () => {
    const { context } = buildContext();
    const expandGraph = vi.fn();
    const handlers = createLaneRouteHandlers(
      expansionDeps(context, {
        expandGraph: expandGraph as unknown as LaneRouteDeps["expandGraph"],
      }),
    );

    const response = await handlers.expandGraph(
      req({
        executionId: "execution-1",
        request: { ...REQUEST, contexts: [] },
      }),
      params({ ...BASE_PARAMS }),
    );

    expect(response.status).toBe(400);
    expect(expandGraph).not.toHaveBeenCalled();
  });

  /**
   * R6.2 names the unauthorized lane and the smuggled remove/update/move/reorder
   * op as envelope violations that owe a TYPED refusal event. Both are refused at
   * the route, before the service is reached — so the route, not the service,
   * owes their event. Without these the two loudest refusals are the only ones
   * invisible to the inspector and the audit stream.
   */
  describe("typed refusal events for route-level envelope violations (R6.2)", () => {
    const CAPABILITY_CASES: readonly {
      label: string;
      capability: LaneIdentityReading;
      refusalCode: string;
    }[] = [
      {
        label: "no capability at all",
        capability: { kind: "absent" },
        refusalCode: "expansion-capability-absent",
      },
      {
        label: "a signature that does not verify",
        capability: { kind: "invalid", reason: "malformed" },
        refusalCode: "expansion-capability-invalid",
      },
      {
        label: "a capability scoped to another context",
        capability: {
          kind: "valid",
          scope: { ...VALID_SCOPE, contextId: "context-implement" },
        },
        refusalCode: "expansion-capability-out-of-scope",
      },
      {
        label: "a capability scoped to another execution",
        capability: {
          kind: "valid",
          scope: { ...VALID_SCOPE, executionId: "execution-other" },
        },
        refusalCode: "expansion-capability-out-of-scope",
      },
    ];

    for (const testCase of CAPABILITY_CASES) {
      it(`publishes a refusal event for ${testCase.label}`, async () => {
        const { context } = buildContext();
        const refusals: ExpansionRefusalNotice[] = [];
        const handlers = createLaneRouteHandlers(
          expansionDeps(context, {
            capability: testCase.capability,
            refusals,
            expandGraph: vi.fn() as unknown as LaneRouteDeps["expandGraph"],
          }),
        );

        const response = await handlers.expandGraph(
          req({ executionId: "execution-1", request: REQUEST }),
          params({ ...BASE_PARAMS }),
        );

        expect(response.status).toBe(403);
        expect(refusals).toEqual([
          {
            projectPath: "/projects/test",
            sessionName: "session-1",
            executionId: "execution-1",
            invokerContextId: "context-plan",
            requestId: "req-1",
            refusalCode: testCase.refusalCode,
          },
        ]);
      });
    }

    it("publishes a non-additive-operation refusal for a smuggled remove op", async () => {
      const { context } = buildContext();
      const refusals: ExpansionRefusalNotice[] = [];
      const handlers = createLaneRouteHandlers(
        expansionDeps(context, {
          refusals,
          expandGraph: vi.fn() as unknown as LaneRouteDeps["expandGraph"],
        }),
      );

      const response = await handlers.expandGraph(
        req({
          executionId: "execution-1",
          request: {
            ...REQUEST,
            operations: [
              { type: "remove-context", contextId: "context-verify" },
            ],
          },
        }),
        params({ ...BASE_PARAMS }),
      );

      expect(response.status).toBe(400);
      expect(refusals).toEqual([
        {
          projectPath: "/projects/test",
          sessionName: "session-1",
          executionId: "execution-1",
          invokerContextId: "context-plan",
          requestId: "req-1",
          refusalCode: "expansion-non-additive-operation",
        },
      ]);
    });

    it("publishes a payload-invalid refusal for an otherwise-malformed payload", async () => {
      const { context } = buildContext();
      const refusals: ExpansionRefusalNotice[] = [];
      const handlers = createLaneRouteHandlers(
        expansionDeps(context, {
          refusals,
          expandGraph: vi.fn() as unknown as LaneRouteDeps["expandGraph"],
        }),
      );

      const response = await handlers.expandGraph(
        req({
          executionId: "execution-1",
          request: { ...REQUEST, contexts: [] },
        }),
        params({ ...BASE_PARAMS }),
      );

      expect(response.status).toBe(400);
      expect(refusals.map((notice) => notice.refusalCode)).toEqual([
        "expansion-payload-invalid",
      ]);
    });

    /**
     * A body so broken it names no request cannot be attributed to one — the
     * event still fires (the attempt is what the audit stream is for), with the
     * identity fields it could recover left empty rather than invented.
     */
    it("publishes a refusal with empty identity when the body names no request", async () => {
      const { context } = buildContext();
      const refusals: ExpansionRefusalNotice[] = [];
      const handlers = createLaneRouteHandlers(
        expansionDeps(context, {
          refusals,
          expandGraph: vi.fn() as unknown as LaneRouteDeps["expandGraph"],
        }),
      );

      const response = await handlers.expandGraph(
        req({ nonsense: true }),
        params({ ...BASE_PARAMS }),
      );

      expect(response.status).toBe(400);
      expect(refusals).toEqual([
        {
          projectPath: "/projects/test",
          sessionName: "session-1",
          executionId: "",
          invokerContextId: "context-plan",
          requestId: "",
          refusalCode: "expansion-payload-invalid",
        },
      ]);
    });

    /**
     * The service owns the refusal event for everything it decides; a route that
     * also fired one would double-count every envelope refusal in the audit
     * stream.
     */
    it("leaves service-decided refusals to the service", async () => {
      const { context } = buildContext();
      const refusals: ExpansionRefusalNotice[] = [];
      const handlers = createLaneRouteHandlers(
        expansionDeps(context, {
          refusals,
          async expandGraph() {
            return {
              ok: false,
              kind: "refused",
              issues: [
                { code: "expansion-context-unreachable", message: "refused" },
              ],
            };
          },
        }),
      );

      const response = await handlers.expandGraph(
        req({ executionId: "execution-1", request: REQUEST }),
        params({ ...BASE_PARAMS }),
      );

      expect(response.status).toBe(409);
      expect(refusals).toEqual([]);
    });
  });

  it("maps an unauthorized-lane refusal to 403 and an envelope refusal to 409", async () => {
    const { context } = buildContext();
    for (const [kind, status] of [
      ["forbidden", 403],
      ["refused", 409],
      ["conflict", 409],
    ] as const) {
      const handlers = createLaneRouteHandlers(
        expansionDeps(context, {
          async expandGraph() {
            return {
              ok: false,
              kind,
              issues: [{ code: `expansion-${kind}`, message: "refused" }],
            };
          },
        }),
      );

      const response = await handlers.expandGraph(
        req({ executionId: "execution-1", request: REQUEST }),
        params({ ...BASE_PARAMS }),
      );

      expect(response.status, kind).toBe(status);
      expect(await response.json()).toMatchObject({
        code: `expansion-${kind}`,
      });
    }
  });

  it("refuses to expand through a halted execution", async () => {
    const { context } = buildContext();
    const expandGraph = vi.fn();
    const handlers = createLaneRouteHandlers({
      ...expansionDeps(context, {
        expandGraph: expandGraph as unknown as LaneRouteDeps["expandGraph"],
      }),
      async loadLaneToolContext() {
        return {
          ok: true,
          context: {
            ...context,
            getPendingHaltReason: async () => HALT_REASON,
          },
          reminderState: { ...DEFAULT_REMINDER_STATE },
        };
      },
    });

    const response = await handlers.expandGraph(
      req({ executionId: "execution-1", request: REQUEST }),
      params({ ...BASE_PARAMS }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ halt: true });
    expect(expandGraph).not.toHaveBeenCalled();
  });
});
