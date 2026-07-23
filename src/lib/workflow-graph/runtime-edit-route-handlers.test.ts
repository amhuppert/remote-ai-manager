import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import type { PersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import type { GraphWorkflowSSEEvent } from "@/lib/workflow-graph/event-schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
import { createGraphWorkflowExecutionRepository } from "./execution-repository";
import { createWorkflowExecution } from "./test-fixtures";
import type { LiveEditDeps } from "./runtime-edits";
import {
  createGraphWorkflowRuntimeEditRouteHandlers,
  type GraphWorkflowRuntimeEditRouteDeps,
} from "./runtime-edit-route-handlers";
import { createSpecExecutionContract } from "@/lib/specs/execution-contract";

const PROJECT_PATH = "/repo";
const SESSION_NAME = "session-1";

const TEST_LIVE_EDIT_DEPS: LiveEditDeps = {
  createTaskId: () => "task-minted-1",
  resolvedGlobalDefaults: () => ({
    implementer: {
      backend: "claude",
      model: "opus",
      reasoningEffort: "medium",
    },
    contextValidator: null,
    scriptValidator: { enabled: false },
    humanApprovalGate: { enabled: false },
    askUserQuestions: { enabled: false },
    mutability: { allowAgentTaskAdd: false },
    circuitBreaker: { consecutiveFailureThreshold: 3 },
    iterationPolicy: { maxIterations: 20, continuity: { enabled: true } },
    collaboration: {
      enabled: { value: true, source: "global" },
      secondAgent: {
        value: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
        source: "global",
      },
      negotiationRounds: { value: 3, source: "global" },
      autonomousResolutionThreshold: { value: "minor", source: "global" },
    },
  }),
  hasPreMergeCommand: () => true,
};

function makeRequest(method: string, body?: unknown): NextRequest {
  return new NextRequest(
    "http://localhost/api/projects/repo/sessions/session-1/graph-workflow/runtime-edits",
    {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers:
        body === undefined ? undefined : { "content-type": "application/json" },
    },
  );
}

function makeContext(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

const routeParams = makeContext({ name: "repo", session: "session-1" });

describe("graph workflow runtime edit route handlers (live edits)", () => {
  let fixture: PersistenceFixture;
  let broadcast: ReturnType<typeof vi.fn>;
  let handlers: ReturnType<typeof createGraphWorkflowRuntimeEditRouteHandlers>;
  let buildLiveEditDeps: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fixture = createPersistenceFixture();
    fixture.seedProject(PROJECT_PATH);
    fixture.seedSession(PROJECT_PATH, SESSION_NAME);

    broadcast = vi.fn<(_event: GraphWorkflowSSEEvent) => void>();
    const publisher = createGraphWorkflowExecutionEventPublisher({ broadcast });
    const repository = createGraphWorkflowExecutionRepository({
      getSession: fixture.store.getSession,
      getActiveGraphWorkflowExecution:
        fixture.store.getActiveGraphWorkflowExecution,
      mutateActiveGraphWorkflowExecution:
        fixture.store.mutateActiveGraphWorkflowExecution,
      archiveActiveGraphWorkflowExecution:
        fixture.store.archiveActiveGraphWorkflowExecution,
      markGraphWorkflowContextEventsPreReset:
        fixture.store.markGraphWorkflowContextEventsPreReset,
      eventPublisher: publisher,
    });

    buildLiveEditDeps = vi.fn(async () => TEST_LIVE_EDIT_DEPS);

    const deps: GraphWorkflowRuntimeEditRouteDeps = {
      resolveProjectPath: async (name) =>
        name === "repo" ? PROJECT_PATH : null,
      getSession: fixture.store.getSession,
      getActiveExecution: fixture.store.getActiveGraphWorkflowExecution,
      mutateActive: repository.mutateActive,
      buildLiveEditDeps,
      publishLiveEditApplied: publisher.publishLiveEditApplied,
    };
    handlers = createGraphWorkflowRuntimeEditRouteHandlers(deps);
  });

  afterEach(() => {
    fixture.close();
  });

  async function seedExecution(
    execution: GraphWorkflowExecution,
  ): Promise<void> {
    await fixture.store.mutateActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "seed-execution",
      () => ({ execution, events: [] }),
    );
  }

  async function reload(): Promise<GraphWorkflowExecution | null> {
    return fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
  }

  function liveEditEventRows() {
    return fixture.graphWorkflowEvents
      .findByExecution("execution-1")
      .filter((row) => row.event.type === "graph-workflow-live-edit-applied");
  }

  function updateContext(overrides: Record<string, unknown> = {}) {
    return {
      executionId: "execution-1",
      baseLiveRevision: 1,
      source: "cli" as const,
      operations: [
        {
          type: "update-context",
          contextId: "context-implement",
          title: "Implement carefully",
        },
      ],
      ...overrides,
    };
  }

  it("rejects a malformed body with a codeless 400 and issues", async () => {
    await seedExecution(createWorkflowExecution({ status: "paused" }));

    const response = await handlers.POST(
      makeRequest("POST", { source: "cli", operations: [] }),
      routeParams,
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).not.toHaveProperty("code");
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it("rejects invalid JSON with a codeless 400", async () => {
    await seedExecution(createWorkflowExecution({ status: "paused" }));

    const request = new NextRequest(
      "http://localhost/api/projects/repo/sessions/session-1/graph-workflow/runtime-edits",
      {
        method: "POST",
        body: "{not json",
        headers: { "content-type": "application/json" },
      },
    );

    const response = await handlers.POST(request, routeParams);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).not.toHaveProperty("code");
  });

  it("returns 404 when the project cannot be resolved", async () => {
    const response = await handlers.POST(
      makeRequest("POST", updateContext()),
      makeContext({ name: "unknown", session: "session-1" }),
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 when the session is unknown", async () => {
    const response = await handlers.POST(
      makeRequest("POST", updateContext()),
      makeContext({ name: "repo", session: "ghost" }),
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 when there is no active execution", async () => {
    const response = await handlers.POST(
      makeRequest("POST", updateContext()),
      routeParams,
    );
    expect(response.status).toBe(404);
  });

  it("returns 409 execution_mismatch when executionId is not the active one", async () => {
    await seedExecution(createWorkflowExecution({ status: "paused" }));

    const response = await handlers.POST(
      makeRequest("POST", updateContext({ executionId: "execution-other" })),
      routeParams,
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe("execution_mismatch");
  });

  it("returns 409 revision_conflict with currentLiveRevision", async () => {
    await seedExecution(
      createWorkflowExecution({ status: "paused", liveRevision: 4 }),
    );

    const response = await handlers.POST(
      makeRequest("POST", updateContext({ baseLiveRevision: 2 })),
      routeParams,
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe("revision_conflict");
    expect(body.currentLiveRevision).toBe(4);
  });

  it("returns 409 not_editable for a completed execution", async () => {
    await seedExecution(
      createWorkflowExecution({
        status: "completed",
        completedAt: "2026-03-27T13:00:00.000Z",
      }),
    );

    const response = await handlers.POST(
      makeRequest("POST", updateContext()),
      routeParams,
    );

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("not_editable");
  });

  it("returns 409 not_editable for an aborted execution", async () => {
    await seedExecution(createWorkflowExecution({ status: "aborted" }));

    const response = await handlers.POST(
      makeRequest("POST", updateContext()),
      routeParams,
    );

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("not_editable");
  });

  it("returns 409 not_editable for a non-resumable halt", async () => {
    await seedExecution(
      createWorkflowExecution({
        status: "halted",
        haltReason: { type: "recovery_error", message: "boom" },
      }),
    );

    const response = await handlers.POST(
      makeRequest("POST", updateContext()),
      routeParams,
    );

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("not_editable");
  });

  it("returns 400 requires_pause for a started context on a running execution", async () => {
    const base = createWorkflowExecution({ status: "running" });
    await seedExecution({
      ...base,
      activeContextIds: ["context-plan"],
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "running",
          iterationCount: 1,
        },
      },
    });

    const response = await handlers.POST(
      makeRequest(
        "POST",
        updateContext({
          operations: [
            {
              type: "update-context",
              contextId: "context-plan",
              title: "Cannot edit while running",
            },
          ],
        }),
      ),
      routeParams,
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("requires_pause");
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it("returns a machine-readable 409 when a launched spec execution is regrouped", async () => {
    const base = createWorkflowExecution({ status: "paused" });
    await seedExecution({
      ...base,
      workingDefinition: {
        ...base.workingDefinition,
        origin: {
          sourceUri:
            "spec-execution://spec-native-sdd/revisions/revision-1?scope=scope-1",
        },
      },
    });
    buildLiveEditDeps.mockResolvedValue({
      ...TEST_LIVE_EDIT_DEPS,
      executionContract: createSpecExecutionContract(),
    });

    const response = await handlers.POST(
      makeRequest("POST", {
        executionId: "execution-1",
        baseLiveRevision: 1,
        source: "cli",
        operations: [
          {
            type: "move-task",
            taskId: "task-implement-1",
            targetContextId: "context-verify",
          },
        ],
      }),
      routeParams,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "spec_grouping_frozen",
      issues: [
        {
          path: "operations[0]",
          message: expect.stringContaining("spec-grouping-frozen"),
        },
      ],
      instruction:
        "Start a new spec execution to use a different task grouping.",
    });
    expect((await reload())?.liveRevision).toBe(1);
  });

  it("returns 400 frozen when editing a completed context", async () => {
    const base = createWorkflowExecution({ status: "paused" });
    await seedExecution({
      ...base,
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "completed",
          completedTaskCount: 1,
        },
      },
      taskStates: {
        ...base.taskStates,
        "task-plan-1": {
          ...base.taskStates["task-plan-1"]!,
          status: "completed",
        },
      },
    });

    const response = await handlers.POST(
      makeRequest(
        "POST",
        updateContext({
          operations: [
            {
              type: "update-context",
              contextId: "context-plan",
              title: "Cannot edit completed",
            },
          ],
        }),
      ),
      routeParams,
    );

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("frozen");
  });

  it("returns a machine-readable 409 with amend-at-source guidance for a locked region", async () => {
    const base = createWorkflowExecution({ status: "paused" });
    await seedExecution({
      ...base,
      workingDefinition: {
        ...base.workingDefinition,
        lockedRegions: [
          {
            paths: ["/executionContexts/context-implement/acceptanceCriteria"],
            sourceUri: "contract://criteria/R17.4",
            reason: "Acceptance criteria are contract-derived",
          },
        ],
      },
    });

    const response = await handlers.POST(
      makeRequest(
        "POST",
        updateContext({
          operations: [
            {
              type: "update-context",
              contextId: "context-implement",
              acceptanceCriteria: "Weakened criteria",
            },
          ],
        }),
      ),
      routeParams,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "region_locked",
      instruction:
        "Amend at source contract://criteria/R17.4 and recompile the workflow definition.",
    });
    expect(
      (await reload())?.workingDefinition.executionContexts.find(
        (context) => context.id === "context-implement",
      )?.acceptanceCriteria,
    ).toBe("Feature implemented");
  });

  it("returns 400 invalid_edit for an unknown context", async () => {
    await seedExecution(createWorkflowExecution({ status: "paused" }));

    const response = await handlers.POST(
      makeRequest(
        "POST",
        updateContext({
          operations: [
            {
              type: "update-context",
              contextId: "no-such-context",
              title: "x",
            },
          ],
        }),
      ),
      routeParams,
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("invalid_edit");
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it("dry-run never persists, bumps, or emits events", async () => {
    await seedExecution(createWorkflowExecution({ status: "paused" }));

    const response = await handlers.POST(
      makeRequest("POST", updateContext({ dryRun: true })),
      routeParams,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      applied: 1,
      liveRevision: 1,
      affectedContextIds: ["context-implement"],
      dryRun: true,
    });

    const reloaded = await reload();
    expect(reloaded?.liveRevision).toBe(1);
    const context = reloaded?.workingDefinition.executionContexts.find(
      (entry) => entry.id === "context-implement",
    );
    expect(context?.title).toBe("Implement");
    expect(liveEditEventRows()).toHaveLength(0);
    expect(
      broadcast.mock.calls.some(
        ([event]) => event.type === "graph-workflow-live-edit-applied",
      ),
    ).toBe(false);
  });

  it("applies an accepted batch: bumps liveRevision, emits + persists the event", async () => {
    await seedExecution(createWorkflowExecution({ status: "paused" }));

    const response = await handlers.POST(
      makeRequest("POST", updateContext()),
      routeParams,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      applied: 1,
      liveRevision: 2,
      affectedContextIds: ["context-implement"],
      dryRun: false,
    });
    expect(body).not.toHaveProperty("execution");

    const reloaded = await reload();
    expect(reloaded?.liveRevision).toBe(2);
    const context = reloaded?.workingDefinition.executionContexts.find(
      (entry) => entry.id === "context-implement",
    );
    expect(context?.title).toBe("Implement carefully");

    const rows = liveEditEventRows();
    expect(rows).toHaveLength(1);
    const event = rows[0]?.event;
    expect(event).toMatchObject({
      type: "graph-workflow-live-edit-applied",
      executionId: "execution-1",
      liveRevision: 2,
      operationCount: 1,
      affectedContextIds: ["context-implement"],
      source: "cli",
    });

    const broadcastEvents = broadcast.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "graph-workflow-live-edit-applied");
    expect(broadcastEvents).toHaveLength(1);
    expect(broadcastEvents[0]).toMatchObject({
      source: "cli",
      liveRevision: 2,
    });
  });

  it("attributes the source from the request (ui)", async () => {
    await seedExecution(createWorkflowExecution({ status: "paused" }));

    const response = await handlers.POST(
      makeRequest("POST", updateContext({ source: "ui" })),
      routeParams,
    );

    expect(response.status).toBe(200);
    const rows = liveEditEventRows();
    expect(rows[0]?.event).toMatchObject({ source: "ui" });
  });

  it("attributes the source from the request (ui)", async () => {
    await seedExecution(createWorkflowExecution({ status: "paused" }));

    const response = await handlers.POST(
      makeRequest("POST", updateContext({ source: "ui" })),
      routeParams,
    );

    expect(response.status).toBe(200);
    const rows = liveEditEventRows();
    expect(rows[0]?.event).toMatchObject({ source: "ui" });
  });
});
