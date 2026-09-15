import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { globalConfigSchema } from "@/lib/config/schemas";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createGraphWorkflowExecutionsRepo } from "@/lib/state-store/graph-workflow-executions-repo";
import { createNonParticipatingGraphExecutionContract } from "./execution-contract-port";
import { createGraphWorkflowExecutionRepository } from "./execution-repository";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
import { createWorkflowCharterService } from "./charter/service";
import {
  createGraphWorkflowManager,
  type GraphWorkflowManagerDeps,
} from "./workflow-manager";
import {
  createWorkflowDefinitionRecord,
  createWorkflowExecution,
  TEST_AGENT_BACKENDS_CONFIG,
} from "./test-fixtures";
import type { GraphWorkflowExecution } from "./schemas";

const PROJECT = "/repo";
const SESSION = "session-1";
const CONTEXT = "context-implement";
const NOW = "2026-09-15T12:00:00.000Z";
const CONFIG = globalConfigSchema.parse({
  baseDir: PROJECT,
  ignorePatterns: [],
  agentBackends: TEST_AGENT_BACKENDS_CONFIG,
});

describe("lifecycle ownership across asynchronous work", () => {
  let fixture: PersistenceFixture;
  beforeEach(() => {
    fixture = createPersistenceFixture();
    fixture.seedProject(PROJECT);
    fixture.seedSession(PROJECT, SESSION);
  });
  afterEach(() => fixture.close());

  function build(overrides: Partial<GraphWorkflowManagerDeps> = {}) {
    const events = createGraphWorkflowExecutionEventPublisher({
      broadcast() {},
      dispatchPush() {},
    });
    const repository = createGraphWorkflowExecutionRepository({
      getSession: fixture.store.getSession,
      getActiveGraphWorkflowExecution:
        fixture.store.getActiveGraphWorkflowExecution,
      mutateActiveGraphWorkflowExecution:
        fixture.store.mutateActiveGraphWorkflowExecution,
      reserveActiveGraphWorkflowExecution:
        fixture.store.reserveActiveGraphWorkflowExecution,
      archiveActiveGraphWorkflowExecution:
        fixture.store.archiveActiveGraphWorkflowExecution,

      getGraphWorkflowPendingArtifacts:
        fixture.store.getGraphWorkflowPendingArtifacts,
      clearGraphWorkflowPendingArtifacts:
        fixture.store.clearGraphWorkflowPendingArtifacts,
      eventPublisher: events,
      charterService: createWorkflowCharterService({
        writeFile: async () => {},
        ensureDir: async () => {},
        publishCharterRegistered: events.publishCharterRegistered,
      }),
      ensureCcArtifactsExcluded: async () => {},
      readConfig: async () => CONFIG,
    });
    const stops: GraphWorkflowExecution[] = [];
    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      executionContract: createNonParticipatingGraphExecutionContract(),
      getSession: fixture.store.getSession,
      loadDefinition: async () => createWorkflowDefinitionRecord(),
      readSessionWorktreeDirtyPaths: async () => [],
      assertSessionBranchReady: async () => {},
      readSessionFinalizingMerge: () => null,
      readGlobalConfig: async () => CONFIG,
      preflightService: {
        async evaluate() {
          return { status: "ok" };
        },
      },
      lintCommittedSourceLocators: async () => [],
      abortConversation() {},
      abortExecutionLoop() {},
      retireLaneConversation() {},
      async stopExecutionLaneDevServers(input) {
        stops.push(input.execution);
      },
      captureExecutionLaneDevServerCleanup: (input) => async () => {
        if (overrides.stopExecutionLaneDevServers)
          await overrides.stopExecutionLaneDevServers(input);
        else stops.push(input.execution);
      },
      createExecutionId: () => "reserved-launch",
      now: () => NOW,
      ...overrides,
    });
    return { manager, stops };
  }

  function read() {
    return createGraphWorkflowExecutionsRepo(fixture.db).getActive(
      PROJECT,
      SESSION,
    );
  }

  function seed(execution: GraphWorkflowExecution) {
    fixture.graphWorkflowExecutions.setActive(PROJECT, SESSION, execution, NOW);
    fixture.graphWorkflowEvents.append(PROJECT, SESSION, execution.id, NOW, {
      occurredAt: NOW,
      preReset: false,
      event: {
        type: "graph-workflow-context-status",
        projectName: "repo",
        sessionName: SESSION,
        executionId: execution.id,
        contextId: CONTEXT,
        status: "running",
        remainingTaskCount: 1,
        iterationCount: 1,
      },
    });
  }

  it("a refused reset leaves persisted history and resources untouched", async () => {
    const execution = createWorkflowExecution({ status: "running" });
    seed(execution);
    const before = read();
    const { manager, stops } = build();
    await expect(
      manager.resetContext(PROJECT, SESSION, CONTEXT),
    ).rejects.toThrow(/paused or halted/);
    expect(read()).toEqual(before);
    expect(
      fixture.graphWorkflowEvents
        .findByExecution(PROJECT, SESSION, execution.id)
        .map((e) => e.preReset),
    ).toEqual([false]);
    expect(stops).toEqual([]);
  });

  it("an admitted reset commits history before its new events and cleans up afterward", async () => {
    const execution = createWorkflowExecution({ status: "paused" });
    const context = execution.contextStates[CONTEXT];
    if (!context) throw new Error("missing fixture context");
    context.status = "running";
    context.iterationCount = 2;
    seed(execution);
    let statusAtCleanup: string | undefined;
    const { manager } = build({
      async stopExecutionLaneDevServers() {
        statusAtCleanup = read()?.contextStates[CONTEXT]?.status;
      },
    });
    await manager.resetContext(PROJECT, SESSION, CONTEXT);
    expect(statusAtCleanup).toBe("pending");
    const history = fixture.graphWorkflowEvents.findByExecution(
      PROJECT,
      SESSION,
      execution.id,
    );
    expect(history[0]?.preReset).toBe(true);
    const resetEvent = history.find(
      (e) =>
        e.event.type === "graph-workflow-context-status" &&
        e.event.status === "pending",
    );
    expect(resetEvent?.preReset).toBe(false);
  });

  it("reserves an ordinary launch as admitted before asynchronous source lint", async () => {
    let statusAtLint: string | undefined;
    const { manager } = build({
      async lintCommittedSourceLocators() {
        statusAtLint = read()?.status;
        return [];
      },
    });
    await manager.start({
      projectPath: PROJECT,
      sessionName: SESSION,
      definitionId: "wf-1",
    });
    expect(statusAtLint).toBe("running");
  });

  it("stale launch completion cannot promote an approval-parked successor", async () => {
    let release = () => {};
    let entered = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { manager } = build({
      async lintCommittedSourceLocators() {
        entered();
        await blocked;
        return [];
      },
    });
    const launch = manager.start({
      projectPath: PROJECT,
      sessionName: SESSION,
      definitionId: "wf-1",
    });
    const outcome = launch.then(
      () => "accepted",
      () => "refused",
    );
    await started;
    const successor = createWorkflowExecution({
      id: "approval-successor",
      status: "pending",
      definitionApproval: { requestedAt: NOW, approvedAt: null },
    });
    await fixture.store.mutateActiveGraphWorkflowExecution(
      PROJECT,
      SESSION,
      "test.replace",
      () => ({
        kind: "commit",
        execution: successor,
        events: [],
        pushes: [],
        value: undefined,
      }),
    );
    release();
    await outcome;
    expect(read()?.id).toBe(successor.id);
    expect(read()?.status).toBe("pending");
    expect(read()?.definitionApproval?.approvedAt).toBeNull();
    expect(await outcome).toBe("refused");
  });

  it("discards recovery evidence when the generation changes during its branch probe", async () => {
    const execution = createWorkflowExecution({
      status: "running",
      loopEpoch: 2,
    });
    const context = execution.contextStates[CONTEXT];
    if (!context) throw new Error("missing fixture context");
    context.status = "completed";
    context.landingIntent = {
      mode: "solo_commit",
      attempt: 1,
      token: "recovery-probe-token",
      laneId: null,
      worktreePath: "/repo/.worktrees/session-1",
      baselineSha: "before",
      headSha: null,
      joinId: null,
      state: "pending",
      evidence: null,
      recordedAt: NOW,
      settledAt: null,
    };
    seed(execution);
    let entered = () => {};
    let release = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { manager } = build({
      landingEvidenceProber: {
        async probe() {
          entered();
          await blocked;
          return new Map([
            [
              CONTEXT,
              {
                headSha: "landed",
                tokenCommitSha: "landed",
                baselineReachable: true,
              },
            ],
          ]);
        },
      },
    });
    const recovery = manager.normalizeAfterRestart(PROJECT, SESSION);
    await started;
    const successor = structuredClone(execution);
    successor.loopEpoch = 3;
    await fixture.store.mutateActiveGraphWorkflowExecution(
      PROJECT,
      SESSION,
      "test.resume",
      () => ({
        kind: "commit",
        execution: successor,
        events: [],
        pushes: [],
        value: undefined,
      }),
    );
    const before = read();
    release();
    expect(await recovery).toEqual(before);
    expect(read()).toEqual(before);
    expect(read()?.status).toBe("running");
    expect(read()?.contextStates[CONTEXT]?.landingIntent?.state).toBe(
      "pending",
    );
  });

  it("recovers an ordinary orphaned pending launch to paused", async () => {
    seed(
      createWorkflowExecution({ status: "pending", definitionApproval: null }),
    );
    const { manager } = build();
    await manager.normalizeAfterRestart(PROJECT, SESSION);
    expect(read()?.status).toBe("paused");
  });
});
