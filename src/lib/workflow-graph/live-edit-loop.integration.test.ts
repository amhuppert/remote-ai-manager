import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import type { PersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import type { GraphWorkflowSSEEvent } from "@/lib/workflow-graph/event-schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
import { createGraphWorkflowExecutionRepository } from "./execution-repository";
import {
  createWorkflowExecution,
  makeProfileSnapshot,
  stubAssignmentSnapshotPreparation,
} from "./test-fixtures";
import type { LiveEditDeps } from "./runtime-edits";
import {
  createGraphWorkflowRuntimeEditRouteHandlers,
  type GraphWorkflowRuntimeEditRouteDeps,
} from "./runtime-edit-route-handlers";
import { createGraphWorkflowLiveOutlineRouteHandlers } from "./live-outline-route-handlers";

/**
 * The doc-06 canonical loop, end-to-end at the route level (AC #2). A live check
 * is impractical from here — the CLI would resolve to the verifier's OWN running
 * execution and pausing it would pause this very run, and launching a throwaway
 * workflow needs real agent turns + worktrees. So this drives the identical
 * `get → pause → edit(config + task batch) → resume → get` sequence through the
 * REAL live-outline (GET) and runtime-edit (POST) route handlers over the real
 * persistence fixture (repos over a fresh :memory: DB), asserting on the RELOADED
 * execution each step. Pause/resume have no server changes (doc 06 §Pause/resume)
 * — they only gain CLI exposure — so their state transitions are represented via
 * the fixture (pause → status `paused`, running context demoted to `ready`; the
 * pause/resume machine itself is covered by workflow-manager tests).
 */

const PROJECT_PATH = "/repo";
const SESSION_NAME = "session-1";
const TS = "2026-03-27T12:00:00.000Z";

const TEST_LIVE_EDIT_DEPS: LiveEditDeps = {
  createTaskId: () => "task-minted-loop",
  resolvedGlobalDefaults: () => ({
    implementer: {
      id: "implementer",
      profile: { tier: "builtin", id: "general-implementer" },
      profileSnapshot: makeProfileSnapshot(),
      agent: {
        backend: "claude",
        model: "opus",
        reasoningEffort: "medium",
      },
    },
    contextValidator: { enabled: false, assignments: [] },
    scriptValidator: { commands: [] },
    humanApprovalGate: { enabled: false },
    askUserQuestions: { enabled: false },
    mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: false },
    circuitBreaker: { consecutiveFailureThreshold: 3 },
    iterationPolicy: { maxIterations: 20, continuity: { enabled: true } },
    planRepair: { enabled: true, maxAttemptsPerContext: 2 },
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
    agentValidation: {
      implementer: { value: { mode: "all", except: [] }, source: "global" },
      contextValidator: {
        value: { mode: "only", commands: [] },
        source: "global",
      },
    },
  }),
  validationCommandPreflight: () => ({
    commandCosts: {},
    concurrencyLimit: 8,
  }),
  snapshotFor: (assignment) => makeProfileSnapshot({ ...assignment.profile }),
  now: () => "2026-07-29T10:00:00.000Z",
};

/**
 * A running execution: plan completed (frozen), implement running (started —
 * "pause-to-edit"), verify pending (unstarted — editable). liveRevision starts at
 * 1 so an accepted edit is observably the first bump.
 */
function runningExecution(): GraphWorkflowExecution {
  const base = createWorkflowExecution();
  return {
    ...base,
    status: "running",
    activeContextIds: ["context-implement"],
    contextStates: {
      ...base.contextStates,
      "context-plan": {
        ...base.contextStates["context-plan"]!,
        status: "completed",
        completedTaskCount: 1,
        iterationCount: 1,
      },
      "context-implement": {
        ...base.contextStates["context-implement"]!,
        status: "running",
        iterationCount: 1,
      },
    },
    taskStates: {
      ...base.taskStates,
      "task-plan-1": {
        ...base.taskStates["task-plan-1"]!,
        status: "completed",
        summary: "planned",
        startedAt: TS,
        completedAt: TS,
      },
      "task-implement-1": {
        ...base.taskStates["task-implement-1"]!,
        status: "running",
        startedAt: TS,
      },
    },
  };
}

/** Pause: quiesce and demote the running context to `ready` (interrupting its task). */
function pause(execution: GraphWorkflowExecution): GraphWorkflowExecution {
  return {
    ...execution,
    status: "paused",
    activeContextIds: [],
    contextStates: {
      ...execution.contextStates,
      "context-implement": {
        ...execution.contextStates["context-implement"]!,
        status: "ready",
      },
    },
    taskStates: {
      ...execution.taskStates,
      "task-implement-1": {
        ...execution.taskStates["task-implement-1"]!,
        status: "interrupted",
      },
    },
  };
}

/** Resume: re-enter the loop, re-promoting the edited context to running. */
function resume(execution: GraphWorkflowExecution): GraphWorkflowExecution {
  return {
    ...execution,
    status: "running",
    activeContextIds: ["context-implement"],
    contextStates: {
      ...execution.contextStates,
      "context-implement": {
        ...execution.contextStates["context-implement"]!,
        status: "running",
      },
    },
  };
}

describe("graph-workflow live editing — canonical pause/edit/resume loop (doc 06)", () => {
  let fixture: PersistenceFixture;
  let broadcast: ReturnType<typeof vi.fn>;
  let editHandlers: ReturnType<
    typeof createGraphWorkflowRuntimeEditRouteHandlers
  >;
  let outlineHandlers: ReturnType<
    typeof createGraphWorkflowLiveOutlineRouteHandlers
  >;

  beforeEach(() => {
    fixture = createPersistenceFixture();
    fixture.seedProject(PROJECT_PATH);
    fixture.seedSession(PROJECT_PATH, SESSION_NAME);

    broadcast = vi.fn<(_event: GraphWorkflowSSEEvent) => void>();
    const publisher = createGraphWorkflowExecutionEventPublisher({ broadcast });
    const repository = createGraphWorkflowExecutionRepository({
      // No git worktree in this harness; the real exclusion would shell out.
      ensureCcArtifactsExcluded: async () => {},
      getSession: fixture.store.getSession,
      getActiveGraphWorkflowExecution:
        fixture.store.getActiveGraphWorkflowExecution,
      mutateActiveGraphWorkflowExecution:
        fixture.store.mutateActiveGraphWorkflowExecution,
      reserveActiveGraphWorkflowExecution:
        fixture.store.reserveActiveGraphWorkflowExecution,
      archiveActiveGraphWorkflowExecution:
        fixture.store.archiveActiveGraphWorkflowExecution,
      markGraphWorkflowContextEventsPreReset:
        fixture.store.markGraphWorkflowContextEventsPreReset,
      eventPublisher: publisher,
    });

    const resolveProjectPath = async (name: string) =>
      name === "repo" ? PROJECT_PATH : null;

    const editDeps: GraphWorkflowRuntimeEditRouteDeps = {
      resolveProjectPath,
      getSession: fixture.store.getSession,
      getActiveExecution: fixture.store.getActiveGraphWorkflowExecution,
      mutateActive: repository.mutateActive,
      buildLiveEditDeps: async () => TEST_LIVE_EDIT_DEPS,
      prepareAssignmentSnapshots: stubAssignmentSnapshotPreparation(),
      publishLiveEditApplied: publisher.publishLiveEditApplied,
      publishCharterUpdated: publisher.publishCharterUpdated,
      writeCharterDocument: async () => {},
    };
    editHandlers = createGraphWorkflowRuntimeEditRouteHandlers(editDeps);
    outlineHandlers = createGraphWorkflowLiveOutlineRouteHandlers({
      resolveProjectPath,
      getSession: fixture.store.getSession,
      getActiveExecution: fixture.store.getActiveGraphWorkflowExecution,
    });
  });

  afterEach(() => {
    fixture.close();
  });

  const routeParams = {
    params: Promise.resolve({ name: "repo", session: SESSION_NAME }),
  };

  async function seed(execution: GraphWorkflowExecution): Promise<void> {
    await fixture.store.mutateActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "seed",
      () => ({ execution, events: [] }),
    );
  }

  async function reload(): Promise<GraphWorkflowExecution> {
    const execution = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    if (!execution) throw new Error("no active execution");
    return execution;
  }

  async function getOutline() {
    const request = new NextRequest(
      "http://localhost/api/projects/repo/sessions/session-1/graph-workflow/live-outline",
    );
    const response = await outlineHandlers.GET(request, routeParams);
    expect(response.status).toBe(200);
    return response.json();
  }

  function editRequest(body: unknown): NextRequest {
    return new NextRequest(
      "http://localhost/api/projects/repo/sessions/session-1/graph-workflow/runtime-edits",
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      },
    );
  }

  function liveEditRows() {
    return fixture.graphWorkflowEvents
      .findByExecution(PROJECT_PATH, SESSION_NAME, "execution-1")
      .filter((row) => row.event.type === "graph-workflow-live-edit-applied");
  }

  it("get shows pause-to-edit; a running edit is blocked; pause unlocks a config+task batch; resume reflects it", async () => {
    await seed(runningExecution());

    // 1. `live get` — the outline reports the running context as pause-to-edit,
    //    the completed context frozen, the downstream context editable, liveRev=1.
    const outline1 = await getOutline();
    expect(outline1.section).toBe("outline");
    expect(outline1.outline.header).toMatchObject({
      executionId: "execution-1",
      liveRevision: 1,
      status: "running",
      editable: true,
    });
    const tier = (id: string) =>
      outline1.outline.contexts.find((c: { id: string }) => c.id === id)
        ?.editability;
    expect(tier("context-plan")).toBe("frozen");
    expect(tier("context-implement")).toBe("pause-to-edit");
    expect(tier("context-verify")).toBe("editable");

    // 2. Editing the started context while running is rejected — this IS the
    //    "pause to edit" contract (400 requires_pause), nothing persists.
    const blocked = await editHandlers.POST(
      editRequest({
        executionId: "execution-1",
        baseLiveRevision: 1,
        source: "cli",
        operations: [
          {
            type: "update-context",
            contextId: "context-implement",
            implementer: {
              id: "implementer",
              profile: { tier: "builtin", id: "general-implementer" },
              agent: {
                backend: "claude",
                model: "opus",
                reasoningEffort: "high",
              },
            },
          },
        ],
      }),
      routeParams,
    );
    expect(blocked.status).toBe(400);
    expect((await blocked.json()).code).toBe("requires_pause");
    expect((await reload()).liveRevision).toBe(1);

    // 3. `live pause` — quiesce the execution (server change is none; represented
    //    via the fixture per doc 06 §Pause/resume).
    await seed(pause(await reload()));

    // 4. `live edit` — the SAME config change plus a new task, now accepted as an
    //    atomic batch. liveRevision bumps exactly once (1 → 2); the mandatory SSE
    //    event is broadcast AND persisted with the request-supplied source (D16/D15).
    const accepted = await editHandlers.POST(
      editRequest({
        executionId: "execution-1",
        baseLiveRevision: 1,
        source: "cli",
        operations: [
          {
            type: "update-context",
            contextId: "context-implement",
            implementer: {
              id: "implementer",
              profile: { tier: "builtin", id: "general-implementer" },
              agent: {
                backend: "claude",
                model: "opus",
                reasoningEffort: "high",
              },
            },
          },
          {
            type: "add-task",
            id: "task-implement-2",
            contextId: "context-implement",
            title: "Add regression test",
            instructions: "Cover the newly wired path.",
          },
        ],
      }),
      routeParams,
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({
      applied: 2,
      liveRevision: 2,
      affectedContextIds: ["context-implement"],
      dryRun: false,
    });

    const afterEdit = await reload();
    expect(afterEdit.liveRevision).toBe(2);
    const implement = afterEdit.workingDefinition.executionContexts.find(
      (c) => c.id === "context-implement",
    );
    expect(implement?.implementer).toEqual({
      id: "implementer",
      profile: { tier: "builtin", id: "general-implementer" },
      profileSnapshot: makeProfileSnapshot(),
      agent: { backend: "claude", model: "opus", reasoningEffort: "high" },
    });
    expect(
      afterEdit.workingDefinition.tasks.some(
        (t) => t.id === "task-implement-2",
      ),
    ).toBe(true);
    expect(afterEdit.taskStates["task-implement-2"]?.status).toBe("pending");
    expect(afterEdit.contextStates["context-implement"]?.totalTaskCount).toBe(
      2,
    );
    // The frozen past is untouched: the completed plan task survives the round-trip.
    expect(afterEdit.taskStates["task-plan-1"]?.status).toBe("completed");

    // Broadcast + persisted, both carrying source "cli" and liveRevision 2 (D16).
    const rows = liveEditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event).toMatchObject({
      type: "graph-workflow-live-edit-applied",
      liveRevision: 2,
      operationCount: 2,
      source: "cli",
    });
    const broadcasts = broadcast.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "graph-workflow-live-edit-applied");
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({ source: "cli", liveRevision: 2 });

    // 5. `live resume` — re-enter the loop.
    await seed(resume(afterEdit));

    // 6. `live get` again — the outline now reflects the edit: liveRev=2, the new
    //    task is present, and the config change survived; the context is once more
    //    pause-to-edit on the running execution.
    const outline2 = await getOutline();
    expect(outline2.outline.header).toMatchObject({
      liveRevision: 2,
      status: "running",
    });
    expect(
      outline2.outline.contexts.find(
        (c: { id: string }) => c.id === "context-implement",
      ),
    ).toMatchObject({ editability: "pause-to-edit", totalTaskCount: 2 });
    expect(
      outline2.outline.tasks.some(
        (t: { id: string }) => t.id === "task-implement-2",
      ),
    ).toBe(true);
    const implementConfig = outline2.outline.config.find(
      (c: { contextId: string }) => c.contextId === "context-implement",
    );
    expect(implementConfig?.implementer).toMatchObject({ model: "opus" });
  });
});
