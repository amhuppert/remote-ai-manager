import { createNonParticipatingGraphExecutionContract } from "@/lib/workflow-graph/execution-contract-port";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";

import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
import { createGraphWorkflowExecutionRepository } from "./execution-repository";
import { createWorkflowExecution } from "./test-fixtures";

import { createGraphWorkflowManager } from "./workflow-manager";
import { WorkflowStartGuardError } from "./start-guards";

import {
  createGraphWorkflowLifecycleService,
  type GraphWorkflowLifecycleDeps,
} from "./lifecycle-service";
/**
 * The launch outcome a manager returns for a run that BEGAN. Both launch verbs
 * answer with this shape, so a route test says which disposition it is
 * exercising rather than implying "started" by returning a bare execution.
 */
function acceptedLaunch(execution: GraphWorkflowExecution) {
  return { execution, awaitingDefinitionApproval: false };
}

function launchGraphWorkflowExecution(
  input: Parameters<
    ReturnType<typeof createGraphWorkflowLifecycleService>["launchSavedRunning"]
  >[0],
  deps: GraphWorkflowLifecycleDeps,
) {
  return createGraphWorkflowLifecycleService(deps).launchSavedRunning(input);
}
describe("launchGraphWorkflowExecution (lifecycle running launch bridge)", () => {
  const PROJECT_PATH = "/repo";
  const PROJECT_NAME = "repo";
  const SESSION_NAME = "session-1";

  function makeSeamDeps(
    overrides: Partial<GraphWorkflowLifecycleDeps> = {},
  ): GraphWorkflowLifecycleDeps {
    const unused = (name: string) => {
      return async (): Promise<never> => {
        throw new Error(
          `${name} should not be called by the start+kickoff seam`,
        );
      };
    };
    return {
      executionContract: createNonParticipatingGraphExecutionContract(),

      normalizeExecutionAfterRestart: unused("normalizeExecutionAfterRestart"),
      startExecution: unused("startExecution"),
      runExecution: unused("runExecution"),
      launchSpecDeliveryExecution: unused("launchSpecDeliveryExecution"),
      pauseExecution: unused("pauseExecution"),
      resumeExecution: unused("resumeExecution"),
      abortExecution: unused("abortExecution"),
      resetExecutionContext: unused("resetExecutionContext"),
      resetExecutionContextAssignment: unused(
        "resetExecutionContextAssignment",
      ),
      archiveExecution: unused("archiveExecution"),
      kickOffExecutionLoop: unused("kickOffExecutionLoop"),
      getActiveExecution: unused("getActiveExecution"),
      recordPendingHaltReason: unused("recordPendingHaltReason"),
      drainAndHalt: unused("drainAndHalt"),
      ...overrides,
    };
  }

  it("calls startExecution with the supplied parameters, kicks off the loop, and returns the started execution", async () => {
    const started = createWorkflowExecution({
      id: "execution-seam",
      status: "running",
    });
    const startExecution = vi.fn(async () => acceptedLaunch(started));
    const kickOffExecutionLoop = vi.fn(async () => {});

    const result = await launchGraphWorkflowExecution(
      {
        projectPath: PROJECT_PATH,
        projectName: PROJECT_NAME,
        sessionName: SESSION_NAME,
        definitionId: "wf-1",
        parameters: { ticket: "CC-42" },
      },
      makeSeamDeps({
        executionContract: createNonParticipatingGraphExecutionContract(),
        startExecution,
        kickOffExecutionLoop,
      }),
    );

    expect(result).toBe(started);
    expect(startExecution).toHaveBeenCalledWith({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      definitionId: "wf-1",
      parameters: { ticket: "CC-42" },
    });
    // Kickoff is fire-and-forget; flush microtasks so the queued call lands.
    await Promise.resolve();
    expect(kickOffExecutionLoop).toHaveBeenCalledWith({
      projectPath: PROJECT_PATH,
      projectName: PROJECT_NAME,
      sessionName: SESSION_NAME,
      execution: started,
    });
  });

  it("threads the caller-supplied owner conversation into the shared start path", async () => {
    const started = createWorkflowExecution({
      id: "execution-owned-seam",
      status: "running",
    });
    const startExecution = vi.fn(async () => acceptedLaunch(started));
    const kickOffExecutionLoop = vi.fn(async () => {});

    await launchGraphWorkflowExecution(
      {
        projectPath: PROJECT_PATH,
        projectName: PROJECT_NAME,
        sessionName: SESSION_NAME,
        definitionId: "wf-1",
        ownerConversationId: "conv-planner",
      },
      makeSeamDeps({
        executionContract: createNonParticipatingGraphExecutionContract(),
        startExecution,
        kickOffExecutionLoop,
      }),
    );

    expect(startExecution).toHaveBeenCalledWith({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      definitionId: "wf-1",
      ownerConversationId: "conv-planner",
    });
  });

  it("omits the owner entirely when the calling seam has no conversation identity", async () => {
    const started = createWorkflowExecution({
      id: "execution-unowned-seam",
      status: "running",
    });
    const startExecution = vi.fn(async () => acceptedLaunch(started));
    const kickOffExecutionLoop = vi.fn(async () => {});

    await launchGraphWorkflowExecution(
      {
        projectPath: PROJECT_PATH,
        projectName: PROJECT_NAME,
        sessionName: SESSION_NAME,
        definitionId: "wf-1",
        ownerConversationId: null,
      },
      makeSeamDeps({
        executionContract: createNonParticipatingGraphExecutionContract(),
        startExecution,
        kickOffExecutionLoop,
      }),
    );

    expect(startExecution).toHaveBeenCalledWith({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      definitionId: "wf-1",
    });
  });

  it("marks a linked spec execution running before kicking off the workflow loop", async () => {
    const started = createWorkflowExecution({
      id: "execution-lifecycle",
      status: "running",
    });
    const calls: string[] = [];
    const startExecution = vi.fn(async () => {
      calls.push("start");
      return acceptedLaunch(started);
    });
    const markRunning = vi.fn(async () => {
      calls.push("mark-running");
    });
    const kickOffExecutionLoop = vi.fn(async () => {
      calls.push("kickoff");
    });

    await launchGraphWorkflowExecution(
      {
        projectPath: PROJECT_PATH,
        projectName: PROJECT_NAME,
        sessionName: SESSION_NAME,
        definitionId: "wf-1",
      },
      makeSeamDeps({
        executionContract: createNonParticipatingGraphExecutionContract(),
        startExecution,
        markRunning,
        kickOffExecutionLoop,
      }),
    );

    // The recorded origin rides along so the lifecycle consumer can correlate
    // the run with work it prepared — by definition revision for a template
    // launch, and by nothing it has to invent for a one-off.
    expect(markRunning).toHaveBeenCalledWith(
      { projectPath: "/repo", sessionName: "session-1" },
      "execution-lifecycle",
      started.origin,
    );
    expect(calls).toEqual(["start", "mark-running", "kickoff"]);
  });

  it("starts a zero-input launch without forwarding a parameters key", async () => {
    const started = createWorkflowExecution({
      id: "execution-zero",
      status: "running",
    });
    const startExecution = vi.fn(async () => acceptedLaunch(started));
    const kickOffExecutionLoop = vi.fn(async () => {});

    await launchGraphWorkflowExecution(
      {
        projectPath: PROJECT_PATH,
        projectName: PROJECT_NAME,
        sessionName: SESSION_NAME,
        definitionId: "wf-static",
      },
      makeSeamDeps({
        executionContract: createNonParticipatingGraphExecutionContract(),
        startExecution,
        kickOffExecutionLoop,
      }),
    );

    expect(startExecution).toHaveBeenCalledWith({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      definitionId: "wf-static",
    });
  });

  it("propagates a guard error without kicking off the loop", async () => {
    const startExecution = vi.fn(async () => {
      throw new WorkflowStartGuardError(
        "active_execution",
        'Session "session-1" already has an active graph workflow execution',
      );
    });
    const kickOffExecutionLoop = vi.fn(async () => {});

    await expect(
      launchGraphWorkflowExecution(
        {
          projectPath: PROJECT_PATH,
          projectName: PROJECT_NAME,
          sessionName: SESSION_NAME,
          definitionId: "wf-1",
        },
        makeSeamDeps({
          executionContract: createNonParticipatingGraphExecutionContract(),
          startExecution,
          kickOffExecutionLoop,
        }),
      ),
    ).rejects.toBeInstanceOf(WorkflowStartGuardError);

    expect(kickOffExecutionLoop).not.toHaveBeenCalled();
  });
});

describe("lifecycle contract: production slot auto-release", () => {
  const PROJECT_PATH = "/repo";
  const PROJECT_NAME = "repo";
  const SESSION_NAME = "session-1";
  const NOW = "2026-06-10T10:00:00.000Z";

  let fixture: PersistenceFixture;

  beforeEach(() => {
    fixture = createPersistenceFixture();
    fixture.seedProject(PROJECT_PATH);
    fixture.seedSession(PROJECT_PATH, SESSION_NAME);
  });

  afterEach(() => {
    fixture.close();
  });

  function unusedDep(name: string) {
    return async (): Promise<never> => {
      throw new Error(`${name} should not be called by this flow`);
    };
  }

  /**
   * Real repository + real manager over the real (in-memory SQLite) store, with
   * the lifecycle service on top. The slot is the persisted
   * `graph_workflow_executions` active row, so "the slot is free" can only be
   * proven by reading the store back — a JS fake would prove nothing about
   * durability.
   */
  function buildStack(overrides: Partial<GraphWorkflowLifecycleDeps> = {}) {
    const eventPublisher = createGraphWorkflowExecutionEventPublisher({
      broadcast: () => {},
      dispatchPush: () => {},
      now: () => NOW,
    });
    const repository = createGraphWorkflowExecutionRepository({
      getGraphWorkflowPendingArtifacts: async () => null,
      clearGraphWorkflowPendingArtifacts: async () => false,

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
      eventPublisher,
    });
    // Two distinct spies on purpose. The manager already stops lane dev servers
    // inside its abort/halt transitions, so a shared spy could not tell the
    // release's own cleanup apart from the manager's — and completion, the one
    // transition with no manager-side cleanup, is exactly where the gap is.
    const managerStopLaneDevServers = vi.fn(async () => {});
    const releaseStopLaneDevServers = vi.fn(async () => {});
    const manager = createGraphWorkflowManager({
      abortConversation: () => {},
      abortExecutionLoop: () => {},
      retireLaneConversation: () => {},
      getSession: async () => null,

      executionContract: createNonParticipatingGraphExecutionContract(),

      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      now: () => NOW,
      stopExecutionLaneDevServers: managerStopLaneDevServers,
    });
    const handlers = createGraphWorkflowLifecycleService({
      executionContract: createNonParticipatingGraphExecutionContract(),

      normalizeExecutionAfterRestart: unusedDep(
        "normalizeExecutionAfterRestart",
      ),
      startExecution: unusedDep("startExecution"),
      runExecution: unusedDep("runExecution"),
      launchSpecDeliveryExecution: unusedDep("launchSpecDeliveryExecution"),
      pauseExecution: unusedDep("pauseExecution"),
      resumeExecution: unusedDep("resumeExecution"),
      abortExecution: (projectPath, sessionName) =>
        manager.send(projectPath, sessionName, { type: "abort" }),
      resetExecutionContext: unusedDep("resetExecutionContext"),
      resetExecutionContextAssignment: unusedDep(
        "resetExecutionContextAssignment",
      ),
      archiveExecution: repository.archiveActive,
      kickOffExecutionLoop: unusedDep("kickOffExecutionLoop"),
      getActiveExecution: repository.getActive,
      recordPendingHaltReason: unusedDep("recordPendingHaltReason"),
      drainAndHalt: unusedDep("drainAndHalt"),
      executionAborted: async () => {},
      stopExecutionLaneDevServers: releaseStopLaneDevServers,
      ...overrides,
    });
    return {
      handlers,
      manager,
      repository,
      managerStopLaneDevServers,
      releaseStopLaneDevServers,
    };
  }

  async function seedActive(execution: GraphWorkflowExecution): Promise<void> {
    await fixture.store.mutateActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.seedActive",
      () => ({
        kind: "commit",
        value: undefined,
        ...{ execution, events: [] },
      }),
    );
  }

  function readActive(): Promise<GraphWorkflowExecution | null> {
    return fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
  }

  /**
   * The kickoff is fire-and-forget on every launch surface, so the completion
   * auto-release lands after the route has already answered. Poll the store
   * rather than the handler's response.
   */
  async function waitForFreeSlot(): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await readActive()) === null) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("slot was still held after the execution settled");
  }

  function runningExecution(
    overrides: Partial<GraphWorkflowExecution> = {},
  ): GraphWorkflowExecution {
    return createWorkflowExecution({
      id: "execution-live",
      status: "running",
      activeContextIds: ["context-plan"],
      ...overrides,
    });
  }

  it("frees the slot after the operator abort, archiving the run", async () => {
    const { handlers } = buildStack();
    await seedActive(runningExecution());

    const result = await handlers.abort({
      projectPath: PROJECT_PATH,
      projectName: PROJECT_NAME,
      sessionName: SESSION_NAME,
    });

    expect(result).toMatchObject({
      kind: "accepted",
      value: { id: "execution-live", status: "aborted" },
    });
    // The whole point of auto-release: no separate clear act is needed.
    expect(await readActive()).toBeNull();
    const archived = await fixture.store.listArchivedGraphWorkflowExecutions(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(archived.map((entry) => entry.id)).toEqual(["execution-live"]);
  });

  it("preserves a successor admitted while the aborted run's cleanup is pending", async () => {
    const successor = runningExecution({ id: "execution-successor" });
    const stack = buildStack({
      stopExecutionLaneDevServers: async () => {
        await stack.repository.archiveActive(PROJECT_PATH, SESSION_NAME);
        await seedActive(successor);
      },
    });
    await seedActive(runningExecution());

    const result = await stack.handlers.abort({
      projectPath: PROJECT_PATH,
      projectName: PROJECT_NAME,
      sessionName: SESSION_NAME,
    });

    expect(result).toMatchObject({
      kind: "accepted",
      value: { id: "execution-live", status: "aborted" },
    });
    expect(await readActive()).toEqual(successor);
    expect(
      await fixture.store.listArchivedGraphWorkflowExecutions(
        PROJECT_PATH,
        SESSION_NAME,
      ),
    ).toMatchObject([{ id: "execution-live", status: "aborted" }]);
  });

  it("delivery cleanup awaits notification and leaves the aborted row for its owner", async () => {
    const { handlers } = buildStack({
      executionAborted: async () => {
        throw new Error("Delivery notification unavailable");
      },
    });
    await seedActive(runningExecution());
    await expect(
      handlers.abortDeliveryExecution({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        workflowExecutionId: "execution-live",
      }),
    ).rejects.toThrow("Delivery notification unavailable");
    expect(await readActive()).toMatchObject({
      id: "execution-live",
      status: "aborted",
    });
    expect(
      await fixture.store.listArchivedGraphWorkflowExecutions(
        PROJECT_PATH,
        SESSION_NAME,
      ),
    ).toEqual([]);
  });

  it("delivery cleanup of a retired execution leaves its successor untouched", async () => {
    const { handlers } = buildStack();
    const successor = runningExecution({
      id: "execution-successor",
      executionStateRevision: 12,
    });
    await seedActive(successor);
    const before = await readActive();
    await expect(
      handlers.abortDeliveryExecution({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        workflowExecutionId: "execution-retired",
      }),
    ).resolves.toBeNull();
    expect(await readActive()).toEqual(before);
  });

  it("operator abort releases the row despite a notification failure", async () => {
    const { handlers } = buildStack({
      executionAborted: async () => {
        throw new Error("Delivery notification unavailable");
      },
    });
    await seedActive(runningExecution());
    await expect(
      handlers.abort({
        projectPath: PROJECT_PATH,
        projectName: PROJECT_NAME,
        sessionName: SESSION_NAME,
      }),
    ).resolves.toMatchObject({
      kind: "accepted",
      value: { status: "aborted" },
    });
    expect(await readActive()).toBeNull();
    expect(
      await fixture.store.listArchivedGraphWorkflowExecutions(
        PROJECT_PATH,
        SESSION_NAME,
      ),
    ).toMatchObject([{ id: "execution-live", status: "aborted" }]);
  });

  it("frees the slot identically when a run reaches completed", async () => {
    const seeded = runningExecution({ id: "execution-finishing" });
    const stack = buildStack({
      executionContract: createNonParticipatingGraphExecutionContract(),

      startExecution: async () => acceptedLaunch(seeded),
      // Stands in for the execution loop: the graph runs out of work and the
      // manager records the terminal `completed` transition.
      kickOffExecutionLoop: async () => {
        await stack.manager.send(PROJECT_PATH, SESSION_NAME, {
          type: "complete",
        });
      },
    });
    await seedActive(seeded);

    const response = await stack.handlers.launch({
      source: "saved",
      projectName: PROJECT_NAME,
      command: {
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        definitionId: "workflow-1",
      },
    });

    expect(response.kind).toBe("accepted");
    await waitForFreeSlot();
    const archived = await fixture.store.listArchivedGraphWorkflowExecutions(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(archived.map((entry) => entry.status)).toEqual(["completed"]);
  });

  it("leaves a halted run holding the slot for resume", async () => {
    const stack = buildStack({
      executionContract: createNonParticipatingGraphExecutionContract(),

      startExecution: async () =>
        acceptedLaunch(runningExecution({ id: "execution-halting" })),
      kickOffExecutionLoop: async () => {
        await stack.manager.send(PROJECT_PATH, SESSION_NAME, {
          type: "halt",
          reason: {
            type: "max_iterations",
            contextId: "context-plan",
            iterationCount: 1,
            summary: null,
          },
        });
      },
    });
    await seedActive(runningExecution({ id: "execution-halting" }));

    const response = await stack.handlers.launch({
      source: "saved",
      projectName: PROJECT_NAME,
      command: {
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        definitionId: "workflow-1",
      },
    });
    expect(response.kind).toBe("accepted");

    // `halted` retains ownership: it is resumable, so releasing the slot would
    // admit unrelated work and race the resume.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const active = await readActive();
      if (active?.status === "halted") break;
    }
    const active = await readActive();
    expect(active?.status).toBe("halted");
    expect(active?.id).toBe("execution-halting");
  });

  it("stops lane dev servers when a completed run releases the slot", async () => {
    const laneExecution = runningExecution({ id: "execution-laned" });
    const planState = laneExecution.contextStates["context-plan"];
    if (!planState) throw new Error("fixture missing context-plan");
    planState.isolation = "worktree";
    planState.worktreePath = "/repo/.worktrees/session-1--lane-plan";

    const stack = buildStack({
      executionContract: createNonParticipatingGraphExecutionContract(),

      startExecution: async () => acceptedLaunch(laneExecution),
      kickOffExecutionLoop: async () => {
        await stack.manager.send(PROJECT_PATH, SESSION_NAME, {
          type: "complete",
        });
      },
    });
    await seedActive(laneExecution);

    await stack.handlers.launch({
      source: "saved",
      projectName: PROJECT_NAME,
      command: {
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        definitionId: "workflow-1",
      },
    });
    await waitForFreeSlot();

    // Completion is the one terminal transition the manager runs no dev-server
    // cleanup for — CLEAR was the backstop that caught it. Auto-release takes
    // CLEAR out of the operator's hands, so the release has to carry the
    // backstop or a finished run leaks its lane servers.
    expect(stack.managerStopLaneDevServers).not.toHaveBeenCalled();
    expect(stack.releaseStopLaneDevServers).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: PROJECT_PATH,
        execution: expect.objectContaining({ id: "execution-laned" }),
      }),
    );
  });
});
