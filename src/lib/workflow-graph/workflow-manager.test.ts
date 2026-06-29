import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import type { GlobalConfig } from "@/lib/config/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
  ResolvedWorkflowSemanticDefinition,
  WorkflowDefinitionRecord,
} from "@/lib/workflows/schemas";
import {
  createResolvedWorkflowDefinition,
  createWorkflowDefinition,
  createWorkflowDefinitionRecord,
  createWorkflowExecution,
} from "@/lib/workflow-graph/test-fixtures";
import {
  _resetRegistryForTesting,
  getExecutionLogger,
  registerExecutionLogger,
  unregisterExecutionLogger,
  type ExecutionLogger,
} from "@/lib/workflow-graph/execution-logger";
import type {
  DisposeInput,
  DisposeResult,
  ParallelWorktrees,
  ProvisionInput,
  ProvisionLaneInput,
  ProvisionResult,
} from "@/lib/workflow-graph/parallel-worktrees";
import type { DirtyPath } from "@/lib/workflow-graph/errors";
import {
  createGraphWorkflowManager,
  WorkflowDefinitionNotFoundError,
  WorkflowPrerequisitesUnmetError,
  WorkflowStartGuardError,
  WorkflowStartInputError,
} from "./workflow-manager";
import type { PreflightPrerequisiteService } from "./preflight-prerequisite-service";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { TemplateTier } from "./template-library-service";
import { createGraphWorkflowExecutionRepository } from "./execution-repository";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
import { createWorkflowCharterService } from "./charter/service";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import type { WorkflowSemanticDefinition } from "@/lib/workflows/schemas";

interface InMemoryExecutionRepository {
  getActive(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null>;
  create(
    projectPath: string,
    sessionName: string,
    seed: {
      definition: WorkflowDefinitionRecord["definition"];
      definitionId: string;
      definitionRevision: number;
      executionId: string;
      startedAt: string;
      inputs: Record<string, string>;
      launchedTier: TemplateTier;
    },
  ): Promise<GraphWorkflowExecution>;
  archiveActive(projectPath: string, sessionName: string): Promise<void>;
  update(
    projectPath: string,
    sessionName: string,
    execution: GraphWorkflowExecution,
  ): Promise<void>;
  mutateActive(
    projectPath: string,
    sessionName: string,
    fn: (
      execution: GraphWorkflowExecution,
    ) =>
      | GraphWorkflowExecution
      | { execution: GraphWorkflowExecution; events: unknown[] }
      | Promise<
          | GraphWorkflowExecution
          | { execution: GraphWorkflowExecution; events: unknown[] }
        >,
  ): Promise<GraphWorkflowExecution>;
  markContextEventsPreReset(
    projectPath: string,
    sessionName: string,
    executionId: string,
    contextId: string,
  ): Promise<number>;
}

type CreateSeedCapture = {
  definitionId: string;
  definitionRevision: number;
  executionId: string;
  startedAt: string;
  inputs: Record<string, string>;
  launchedTier: TemplateTier;
};

function createRepository(
  initialExecution: GraphWorkflowExecution | null = null,
): InMemoryExecutionRepository & {
  read(): GraphWorkflowExecution | null;
  preResetCalls: Array<{ executionId: string; contextId: string }>;
  createCalls: CreateSeedCapture[];
  archiveCalls: number;
} {
  let activeExecution = initialExecution;
  let lock: Promise<void> = Promise.resolve();
  const preResetCalls: Array<{ executionId: string; contextId: string }> = [];
  const createCalls: CreateSeedCapture[] = [];
  let archiveCalls = 0;

  return {
    async getActive() {
      return activeExecution;
    },
    async create(_projectPath, _sessionName, seed) {
      createCalls.push({
        definitionId: seed.definitionId,
        definitionRevision: seed.definitionRevision,
        executionId: seed.executionId,
        startedAt: seed.startedAt,
        inputs: seed.inputs,
        launchedTier: seed.launchedTier,
      });
      activeExecution = createWorkflowExecution({
        id: seed.executionId,
        seedDefinitionId: seed.definitionId,
        seedDefinitionRevision: seed.definitionRevision,
        boundInputs: seed.inputs,
        launchedTier: seed.launchedTier,
        workingDefinition:
          seed.definition as unknown as ResolvedWorkflowSemanticDefinition,
        startedAt: seed.startedAt,
      });
      return activeExecution;
    },
    async archiveActive() {
      archiveCalls += 1;
      activeExecution = null;
    },
    async update(_projectPath, _sessionName, execution) {
      activeExecution = execution;
    },
    async mutateActive(_projectPath, _sessionName, fn) {
      const previous = lock;
      let release!: () => void;
      lock = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        await previous;
        if (!activeExecution) {
          throw new Error(
            "Session does not have an active graph workflow execution",
          );
        }
        const result = await fn(structuredClone(activeExecution));
        activeExecution =
          "execution" in result && "events" in result
            ? result.execution
            : (result as GraphWorkflowExecution);
        return activeExecution;
      } finally {
        release();
      }
    },
    async markContextEventsPreReset(
      _projectPath,
      _sessionName,
      executionId,
      contextId,
    ) {
      preResetCalls.push({ executionId, contextId });
      return 0;
    },
    read() {
      return activeExecution;
    },
    preResetCalls,
    createCalls,
    get archiveCalls() {
      return archiveCalls;
    },
  };
}

describe("graph workflow manager", () => {
  it("starts a run from a saved workflow definition and persists lifecycle metadata", async () => {
    const definition = createWorkflowDefinitionRecord({
      revision: 3,
    });
    const repository = createRepository();

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return definition;
      },
      now() {
        return "2026-03-27T15:00:00.000Z";
      },
      createExecutionId() {
        return "execution-started";
      },
    });

    const execution = await manager.start({
      projectPath: "/repo",
      sessionName: "session-1",
      definitionId: definition.id,
    });

    expect(execution.id).toBe("execution-started");
    expect(execution.status).toBe("running");
    expect(execution.seedDefinitionId).toBe(definition.id);
    expect(execution.seedDefinitionRevision).toBe(3);
    expect(execution.workingDefinition).toEqual(definition.definition);
    expect(execution.machineSnapshot).toEqual({
      schemaVersion: 1,
      lifecycleStatus: "running",
      activeContextId: null,
      recoveryMode: "none",
      hasLiveIteration: false,
    });
  });

  describe("start threads the launch tier through resolution and the seed", () => {
    const PROJECT_PATH = "/repo";
    const SESSION_NAME = "session-1";

    let fixture: PersistenceFixture;

    beforeEach(() => {
      fixture = createPersistenceFixture();
      fixture.seedProject(PROJECT_PATH);
      fixture.seedSession(PROJECT_PATH, SESSION_NAME);
    });

    afterEach(() => {
      fixture.close();
    });

    /**
     * Wire the manager over the REAL execution repository (backed by the
     * fixture's real `:memory:` store + `graph_workflow_executions` table) so a
     * persisted `launchedTier` is proven by reloading through the store, not by
     * a JS-object fake. `loadDefinition` is tier-aware and returns a DISTINCT
     * definition id per tier, so resolving the wrong tier would surface a wrong
     * `seedDefinitionId` — the assertion exercises the manager's tier plumbing,
     * not a mock echo.
     */
    function buildManager(input: {
      tierDefinitions: Record<TemplateTier, WorkflowDefinitionRecord>;
      loadCalls: Array<{ definitionId: string; tier: TemplateTier }>;
    }) {
      const eventPublisher = createGraphWorkflowExecutionEventPublisher({
        broadcast: () => {},
        dispatchPush: () => {},
      });
      const charterService = createWorkflowCharterService({
        writeFile: async () => {},
        ensureDir: async () => {},
        publishCharterRegistered: eventPublisher.publishCharterRegistered,
      });
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
        eventPublisher,
        charterService,
        readConfig: async () => ({}) as GlobalConfig,
      });
      return createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition(_projectPath, definitionId, tier) {
          input.loadCalls.push({ definitionId, tier });
          return input.tierDefinitions[tier];
        },
        now() {
          return "2026-06-21T00:00:00.000Z";
        },
        createExecutionId() {
          return "execution-started";
        },
      });
    }

    it("loads the GLOBAL definition and persists launchedTier='global' (R3.1, R3.2, R3.3)", async () => {
      const loadCalls: Array<{ definitionId: string; tier: TemplateTier }> = [];
      const manager = buildManager({
        tierDefinitions: {
          project: createWorkflowDefinitionRecord({ id: "project-def" }),
          global: createWorkflowDefinitionRecord({ id: "global-def" }),
        },
        loadCalls,
      });

      const execution = await manager.start({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        definitionId: "global-def",
        tier: "global",
      });

      expect(loadCalls).toEqual([
        { definitionId: "global-def", tier: "global" },
      ]);
      expect(execution.seedDefinitionId).toBe("global-def");
      expect(execution.launchedTier).toBe("global");

      const reloaded = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      );
      expect(reloaded?.seedDefinitionId).toBe("global-def");
      expect(reloaded?.launchedTier).toBe("global");
    });

    it("defaults an omitted tier to project, loading the per-project definition and persisting launchedTier='project' (R3.3)", async () => {
      const loadCalls: Array<{ definitionId: string; tier: TemplateTier }> = [];
      const manager = buildManager({
        tierDefinitions: {
          project: createWorkflowDefinitionRecord({ id: "project-def" }),
          global: createWorkflowDefinitionRecord({ id: "global-def" }),
        },
        loadCalls,
      });

      const execution = await manager.start({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        definitionId: "project-def",
      });

      expect(loadCalls).toEqual([
        { definitionId: "project-def", tier: "project" },
      ]);
      expect(execution.seedDefinitionId).toBe("project-def");
      expect(execution.launchedTier).toBe("project");

      const reloaded = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      );
      expect(reloaded?.seedDefinitionId).toBe("project-def");
      expect(reloaded?.launchedTier).toBe("project");
    });

    it("records boundInputs unchanged alongside the additive launchedTier on a parameterized launch (R3.3)", async () => {
      const baseline = createWorkflowDefinition();
      const parameterized: WorkflowSemanticDefinition = {
        ...baseline,
        parameters: [
          {
            name: "feature",
            label: "Feature",
            type: "string",
            required: true,
          },
        ],
        executionContexts: [
          {
            ...baseline.executionContexts[0]!,
            acceptanceCriteria: "Deliver {{inputs.feature}}",
          },
          ...baseline.executionContexts.slice(1),
        ],
      };
      const loadCalls: Array<{ definitionId: string; tier: TemplateTier }> = [];
      const manager = buildManager({
        tierDefinitions: {
          project: createWorkflowDefinitionRecord({ id: "project-def" }),
          global: createWorkflowDefinitionRecord({
            id: "global-def",
            definition: parameterized,
          }),
        },
        loadCalls,
      });

      const execution = await manager.start({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        definitionId: "global-def",
        tier: "global",
        parameters: { feature: "payments" },
      });

      expect(execution.boundInputs).toEqual({ feature: "payments" });
      expect(execution.launchedTier).toBe("global");

      const reloaded = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      );
      expect(reloaded?.boundInputs).toEqual({ feature: "payments" });
      expect(reloaded?.launchedTier).toBe("global");
    });
  });

  it("pauses immediately by interrupting running tasks in the active context", async () => {
    const repository = createRepository(
      createWorkflowExecution({
        status: "running",
        activeContextIds: ["context-plan"],
        contextStates: {
          "context-plan": {
            pendingApproval: null,
            contextId: "context-plan",
            status: "running",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 1,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            laneId: null,
            joinId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
          "context-implement": {
            pendingApproval: null,
            contextId: "context-implement",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            laneId: null,
            joinId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
          "context-verify": {
            pendingApproval: null,
            contextId: "context-verify",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            laneId: null,
            joinId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
        },
        taskStates: {
          "task-plan-1": {
            taskId: "task-plan-1",
            contextId: "context-plan",
            order: 1,
            status: "running",
            summary: null,
            startedAt: "2026-03-27T15:00:00.000Z",
            completedAt: null,
            lastConversationId: "conversation-1",
            failureMessage: null,
            failureHistory: [],
          },
          "task-implement-1": {
            taskId: "task-implement-1",
            contextId: "context-implement",
            order: 1,
            status: "pending",
            summary: null,
            startedAt: null,
            completedAt: null,
            lastConversationId: null,
            failureMessage: null,
            failureHistory: [],
          },
          "task-verify-1": {
            taskId: "task-verify-1",
            contextId: "context-verify",
            order: 1,
            status: "pending",
            summary: null,
            startedAt: null,
            completedAt: null,
            lastConversationId: null,
            failureMessage: null,
            failureHistory: [],
          },
        },
        machineSnapshot: {
          schemaVersion: 1,
          lifecycleStatus: "running",
          activeContextId: "context-plan",
          recoveryMode: "none",
          hasLiveIteration: true,
        },
      }),
    );

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      now() {
        return "2026-03-27T15:05:00.000Z";
      },
    });

    const execution = await manager.send("/repo", "session-1", {
      type: "pause",
    });

    expect(execution.status).toBe("paused");
    expect(execution.taskStates["task-plan-1"]?.status).toBe("interrupted");
    expect(execution.contextStates["context-plan"]?.status).toBe("ready");
    expect(execution.machineSnapshot).toEqual({
      schemaVersion: 1,
      lifecycleStatus: "paused",
      activeContextId: "context-plan",
      recoveryMode: "interrupted_task",
      hasLiveIteration: false,
    });
  });

  it("aborts the in-flight conversation for every running task when paused, halted, or aborted", async () => {
    const buildExecutionWithRunningTasks = () =>
      createWorkflowExecution({
        status: "running",
        activeContextIds: ["context-a", "context-b"],
        contextStates: {
          "context-a": {
            pendingApproval: null,
            contextId: "context-a",
            status: "running",
            totalTaskCount: 2,
            completedTaskCount: 0,
            iterationCount: 1,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            laneId: null,
            joinId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
          "context-b": {
            pendingApproval: null,
            contextId: "context-b",
            status: "running",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 1,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            laneId: null,
            joinId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
          "context-c": {
            pendingApproval: null,
            contextId: "context-c",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            laneId: null,
            joinId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
        },
        taskStates: {
          "task-a-1": {
            taskId: "task-a-1",
            contextId: "context-a",
            order: 1,
            status: "running",
            summary: null,
            startedAt: "2026-03-27T15:00:00.000Z",
            completedAt: null,
            lastConversationId: "conv-a",
            failureMessage: null,
            failureHistory: [],
          },
          "task-a-2": {
            taskId: "task-a-2",
            contextId: "context-a",
            order: 2,
            status: "running",
            summary: null,
            startedAt: "2026-03-27T15:00:00.000Z",
            completedAt: null,
            lastConversationId: "conv-a",
            failureMessage: null,
            failureHistory: [],
          },
          "task-b-1": {
            taskId: "task-b-1",
            contextId: "context-b",
            order: 1,
            status: "running",
            summary: null,
            startedAt: "2026-03-27T15:00:00.000Z",
            completedAt: null,
            lastConversationId: "conv-b",
            failureMessage: null,
            failureHistory: [],
          },
          "task-c-1": {
            taskId: "task-c-1",
            contextId: "context-c",
            order: 1,
            status: "pending",
            summary: null,
            startedAt: null,
            completedAt: null,
            lastConversationId: "conv-stale",
            failureMessage: null,
            failureHistory: [],
          },
        },
        machineSnapshot: {
          schemaVersion: 1,
          lifecycleStatus: "running",
          activeContextId: "context-a",
          recoveryMode: "none",
          hasLiveIteration: true,
        },
      });

    const transitions: Array<{
      transition: "pause" | "abort" | "halt";
      send: () => Promise<unknown>;
    }> = [];

    for (const event of [
      { type: "pause" as const },
      { type: "abort" as const },
      {
        type: "halt" as const,
        reason: {
          type: "max_iterations" as const,
          contextId: "context-a",
          iterationCount: 1,
        },
      },
    ]) {
      const repository = createRepository(buildExecutionWithRunningTasks());
      const abortConversation = vi.fn();

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
        now() {
          return "2026-03-27T15:05:00.000Z";
        },
        abortConversation,
      });

      transitions.push({
        transition: event.type,
        send: async () => {
          await manager.send("/repo", "session-1", event);
          const calls = abortConversation.mock.calls.map(
            ([input]) => input as { conversationId: string },
          );
          const conversationIds = calls
            .map((c) => c.conversationId)
            .sort((a, b) => a.localeCompare(b));
          expect(conversationIds).toEqual(["conv-a", "conv-b"]);
          for (const call of calls) {
            expect(call).toMatchObject({
              projectPath: "/repo",
              sessionName: "session-1",
            });
          }
        },
      });
    }

    for (const { send } of transitions) {
      await send();
    }
  });

  describe("lane dev-server cleanup on terminal transitions", () => {
    function runningExecution(): GraphWorkflowExecution {
      return createWorkflowExecution({
        status: "running",
        activeContextIds: ["context-plan"],
        machineSnapshot: {
          schemaVersion: 1,
          lifecycleStatus: "running",
          activeContextId: "context-plan",
          recoveryMode: "none",
          hasLiveIteration: false,
        },
      });
    }

    function managerWithSpy(execution: GraphWorkflowExecution) {
      const stopExecutionLaneDevServers = vi.fn(async () => {});
      const manager = createGraphWorkflowManager({
        executionRepository: createRepository(execution),
        async loadDefinition() {
          return null;
        },
        stopExecutionLaneDevServers,
      });
      return { manager, stopExecutionLaneDevServers };
    }

    it("stops lane dev servers on abort", async () => {
      const { manager, stopExecutionLaneDevServers } =
        managerWithSpy(runningExecution());
      await manager.send("/repo", "session-1", { type: "abort" });
      expect(stopExecutionLaneDevServers).toHaveBeenCalledWith(
        expect.objectContaining({ projectPath: "/repo" }),
      );
    });

    it("stops lane dev servers on halt", async () => {
      const { manager, stopExecutionLaneDevServers } =
        managerWithSpy(runningExecution());
      await manager.send("/repo", "session-1", {
        type: "halt",
        reason: {
          type: "max_iterations",
          contextId: "context-plan",
          iterationCount: 1,
        },
      });
      expect(stopExecutionLaneDevServers).toHaveBeenCalledWith(
        expect.objectContaining({ projectPath: "/repo" }),
      );
    });
  });

  it("does not invoke abortConversation when no tasks are running", async () => {
    const repository = createRepository(
      createWorkflowExecution({
        status: "running",
        activeContextIds: ["context-plan"],
        taskStates: {
          "task-plan-1": {
            taskId: "task-plan-1",
            contextId: "context-plan",
            order: 1,
            status: "completed",
            summary: "done",
            startedAt: "2026-03-27T15:00:00.000Z",
            completedAt: "2026-03-27T15:01:00.000Z",
            lastConversationId: "conv-finished",
            failureMessage: null,
            failureHistory: [],
          },
        },
        machineSnapshot: {
          schemaVersion: 1,
          lifecycleStatus: "running",
          activeContextId: "context-plan",
          recoveryMode: "none",
          hasLiveIteration: false,
        },
      }),
    );
    const abortConversation = vi.fn();
    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      now() {
        return "2026-03-27T15:05:00.000Z";
      },
      abortConversation,
    });

    await manager.send("/repo", "session-1", { type: "pause" });

    expect(abortConversation).not.toHaveBeenCalled();
  });

  it("transitions a running context to ready when halted", async () => {
    const repository = createRepository(
      createWorkflowExecution({
        status: "running",
        activeContextIds: ["context-plan"],
        contextStates: {
          "context-plan": {
            pendingApproval: null,
            contextId: "context-plan",
            status: "running",
            totalTaskCount: 1,
            completedTaskCount: 1,
            iterationCount: 2,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            laneId: null,
            joinId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
          "context-implement": {
            pendingApproval: null,
            contextId: "context-implement",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            laneId: null,
            joinId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
          "context-verify": {
            pendingApproval: null,
            contextId: "context-verify",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            laneId: null,
            joinId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
        },
        taskStates: {
          "task-plan-1": {
            taskId: "task-plan-1",
            contextId: "context-plan",
            order: 1,
            status: "completed",
            summary: "done",
            startedAt: "2026-03-27T15:00:00.000Z",
            completedAt: "2026-03-27T15:01:00.000Z",
            lastConversationId: "conversation-1",
            failureMessage: null,
            failureHistory: [],
          },
          "task-implement-1": {
            taskId: "task-implement-1",
            contextId: "context-implement",
            order: 1,
            status: "pending",
            summary: null,
            startedAt: null,
            completedAt: null,
            lastConversationId: null,
            failureMessage: null,
            failureHistory: [],
          },
          "task-verify-1": {
            taskId: "task-verify-1",
            contextId: "context-verify",
            order: 1,
            status: "pending",
            summary: null,
            startedAt: null,
            completedAt: null,
            lastConversationId: null,
            failureMessage: null,
            failureHistory: [],
          },
        },
        machineSnapshot: {
          schemaVersion: 1,
          lifecycleStatus: "running",
          activeContextId: "context-plan",
          recoveryMode: "none",
          hasLiveIteration: false,
        },
      }),
    );

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      now() {
        return "2026-03-27T15:05:00.000Z";
      },
    });

    const execution = await manager.send("/repo", "session-1", {
      type: "halt",
      reason: {
        type: "max_iterations",
        contextId: "context-plan",
        iterationCount: 2,
      },
    });

    expect(execution.status).toBe("halted");
    expect(execution.contextStates["context-plan"]?.status).toBe("ready");
    expect(execution.machineSnapshot).toEqual({
      schemaVersion: 1,
      lifecycleStatus: "halted",
      activeContextId: "context-plan",
      recoveryMode: "none",
      hasLiveIteration: false,
    });
  });

  it("resumes a paused execution preserving the active context", async () => {
    const repository = createRepository(
      createWorkflowExecution({
        status: "paused",
        activeContextIds: ["context-plan"],
        taskStates: {
          "task-plan-1": {
            taskId: "task-plan-1",
            contextId: "context-plan",
            order: 1,
            status: "interrupted",
            summary: null,
            startedAt: "2026-03-27T15:00:00.000Z",
            completedAt: null,
            lastConversationId: "conversation-1",
            failureMessage: null,
            failureHistory: [],
          },
          "task-implement-1": {
            taskId: "task-implement-1",
            contextId: "context-implement",
            order: 1,
            status: "pending",
            summary: null,
            startedAt: null,
            completedAt: null,
            lastConversationId: null,
            failureMessage: null,
            failureHistory: [],
          },
          "task-verify-1": {
            taskId: "task-verify-1",
            contextId: "context-verify",
            order: 1,
            status: "pending",
            summary: null,
            startedAt: null,
            completedAt: null,
            lastConversationId: null,
            failureMessage: null,
            failureHistory: [],
          },
        },
        machineSnapshot: {
          schemaVersion: 1,
          lifecycleStatus: "paused",
          activeContextId: "context-plan",
          recoveryMode: "interrupted_task",
          hasLiveIteration: false,
        },
      }),
    );

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      now() {
        return "2026-03-27T15:06:00.000Z";
      },
    });

    const execution = await manager.resume("/repo", "session-1");

    expect(execution.status).toBe("running");
    expect(execution.taskStates["task-plan-1"]?.status).toBe("interrupted");
    expect(execution.machineSnapshot).toEqual({
      schemaVersion: 1,
      lifecycleStatus: "running",
      activeContextId: "context-plan",
      recoveryMode: "interrupted_task",
      hasLiveIteration: false,
    });
  });

  it("schedules implementer rotation when recovering a retryable iteration error", async () => {
    const repository = createRepository(
      createWorkflowExecution({
        status: "running",
        activeContextIds: ["context-plan"],
        contextStates: {
          "context-plan": {
            pendingApproval: null,
            contextId: "context-plan",
            status: "running",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 1,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            laneId: null,
            joinId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
          "context-implement": {
            pendingApproval: null,
            contextId: "context-implement",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            laneId: null,
            joinId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
          "context-verify": {
            pendingApproval: null,
            contextId: "context-verify",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            laneId: null,
            joinId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
        },
        laneStates: {
          "context-plan": {
            implementer: {
              engine: "claude",
              lane: "implementer",
              contextId: "context-plan",
              sessionRef: {
                engine: "claude",
                lane: "implementer",
                conversationId: "conv-1",
              },
              lastContextTokens: 10_000,
              lastContextWindowMax: 200_000,
              rotateBeforeNextTurn: false,
              limitEvaluation: "disabled",
              lastUsedAt: "2026-03-27T15:00:00.000Z",
            },
          },
        },
        machineSnapshot: {
          schemaVersion: 1,
          lifecycleStatus: "running",
          activeContextId: "context-plan",
          recoveryMode: "none",
          hasLiveIteration: true,
        },
      }),
    );

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      now() {
        return "2026-03-27T15:07:00.000Z";
      },
    });

    const execution = await manager.recoverRetryableIterationError(
      "/repo",
      "session-1",
      {
        contextId: "context-plan",
        errorMessage: "SDK error: MCP error -32000: Stream closed",
      },
    );

    expect(execution.status).toBe("running");
    expect(execution.contextStates["context-plan"]?.status).toBe("ready");
    expect(execution.laneStates["context-plan"]?.["implementer"]).toMatchObject(
      {
        rotateBeforeNextTurn: true,
        lastUsedAt: "2026-03-27T15:07:00.000Z",
      },
    );
    expect(execution.machineSnapshot).toEqual({
      schemaVersion: 1,
      lifecycleStatus: "running",
      activeContextId: "context-plan",
      recoveryMode: "none",
      hasLiveIteration: false,
    });
  });

  it("normalizes an in-flight iteration after restart so resume starts a fresh iteration", async () => {
    const repository = createRepository(
      createWorkflowExecution({
        status: "running",
        activeContextIds: ["context-plan"],
        contextStates: {
          "context-plan": {
            pendingApproval: null,
            contextId: "context-plan",
            status: "running",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 1,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            laneId: null,
            joinId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
          "context-implement": {
            pendingApproval: null,
            contextId: "context-implement",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            laneId: null,
            joinId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
          "context-verify": {
            pendingApproval: null,
            contextId: "context-verify",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            laneId: null,
            joinId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
        },
        taskStates: {
          "task-plan-1": {
            taskId: "task-plan-1",
            contextId: "context-plan",
            order: 1,
            status: "running",
            summary: null,
            startedAt: "2026-03-27T15:00:00.000Z",
            completedAt: null,
            lastConversationId: "conversation-1",
            failureMessage: null,
            failureHistory: [],
          },
          "task-implement-1": {
            taskId: "task-implement-1",
            contextId: "context-implement",
            order: 1,
            status: "pending",
            summary: null,
            startedAt: null,
            completedAt: null,
            lastConversationId: null,
            failureMessage: null,
            failureHistory: [],
          },
          "task-verify-1": {
            taskId: "task-verify-1",
            contextId: "context-verify",
            order: 1,
            status: "pending",
            summary: null,
            startedAt: null,
            completedAt: null,
            lastConversationId: null,
            failureMessage: null,
            failureHistory: [],
          },
        },
        machineSnapshot: {
          schemaVersion: 1,
          lifecycleStatus: "running",
          activeContextId: "context-plan",
          recoveryMode: "none",
          hasLiveIteration: true,
        },
      }),
    );

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      now() {
        return "2026-03-27T15:10:00.000Z";
      },
    });

    const recovered = await manager.normalizeAfterRestart("/repo", "session-1");

    expect(recovered).not.toBeNull();
    expect(recovered?.status).toBe("paused");
    expect(recovered?.taskStates["task-plan-1"]?.status).toBe("interrupted");
    expect(recovered?.machineSnapshot).toEqual({
      schemaVersion: 1,
      lifecycleStatus: "paused",
      activeContextId: "context-plan",
      recoveryMode: "restart_normalized",
      hasLiveIteration: false,
    });
  });

  it("skips normalization when the execution loop is actively running", async () => {
    const repository = createRepository(
      createWorkflowExecution({
        status: "running",
        activeContextIds: ["context-plan"],
        contextStates: {
          "context-plan": {
            pendingApproval: null,
            contextId: "context-plan",
            status: "running",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 1,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            laneId: null,
            joinId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
        },
        taskStates: {
          "task-plan-1": {
            taskId: "task-plan-1",
            contextId: "context-plan",
            order: 1,
            status: "running",
            summary: null,
            startedAt: "2026-03-27T15:00:00.000Z",
            completedAt: null,
            lastConversationId: "conversation-1",
            failureMessage: null,
            failureHistory: [],
          },
        },
        machineSnapshot: {
          schemaVersion: 1,
          lifecycleStatus: "running",
          activeContextId: "context-plan",
          recoveryMode: "none",
          hasLiveIteration: true,
        },
      }),
    );

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      isExecutionLoopActive() {
        return true;
      },
    });

    const result = await manager.normalizeAfterRestart("/repo", "session-1");

    // Should return the execution unchanged — not paused
    expect(result).not.toBeNull();
    expect(result?.status).toBe("running");
    expect(result?.taskStates["task-plan-1"]?.status).toBe("running");
    expect(result?.machineSnapshot).toEqual({
      schemaVersion: 1,
      lifecycleStatus: "running",
      activeContextId: "context-plan",
      recoveryMode: "none",
      hasLiveIteration: true,
    });
  });

  it("normalizes a running execution to paused when hasLiveIteration is false and no loop is active", async () => {
    const repository = createRepository(
      createWorkflowExecution({
        status: "running",
        activeContextIds: ["context-plan"],
        contextStates: {
          "context-plan": {
            pendingApproval: null,
            contextId: "context-plan",
            status: "ready",
            totalTaskCount: 1,
            completedTaskCount: 1,
            iterationCount: 1,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            laneId: null,
            joinId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
        },
        taskStates: {
          "task-plan-1": {
            taskId: "task-plan-1",
            contextId: "context-plan",
            order: 1,
            status: "completed",
            summary: "Done",
            startedAt: "2026-03-27T15:00:00.000Z",
            completedAt: "2026-03-27T15:05:00.000Z",
            lastConversationId: "conversation-1",
            failureMessage: null,
            failureHistory: [],
          },
        },
        machineSnapshot: {
          schemaVersion: 1,
          lifecycleStatus: "running",
          activeContextId: "context-plan",
          recoveryMode: "none",
          hasLiveIteration: false,
        },
      }),
    );

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      isExecutionLoopActive() {
        return false;
      },
    });

    const recovered = await manager.normalizeAfterRestart("/repo", "session-1");

    expect(recovered).not.toBeNull();
    expect(recovered?.status).toBe("paused");
    expect(recovered?.machineSnapshot).toEqual({
      schemaVersion: 1,
      lifecycleStatus: "paused",
      activeContextId: "context-plan",
      recoveryMode: "restart_normalized",
      hasLiveIteration: false,
    });
  });

  it("leaves awaiting_approval contexts and their pending record untouched when normalizing after restart", async () => {
    const parkedContextState = {
      pendingApproval: {
        conversationId: "conversation-1",
        requestedAt: "2026-03-27T15:01:00.000Z",
        decision: {
          type: "rejected" as const,
          message: "needs more tests",
          decidedAt: "2026-03-27T15:02:00.000Z",
        },
      },
      contextId: "context-plan",
      status: "awaiting_approval" as const,
      totalTaskCount: 1,
      completedTaskCount: 1,
      iterationCount: 1,
      consecutiveFailureCount: 0,
      worktreePath: "/repo/.worktrees/session-1.context-plan",
      branchName: "csm/session-1-context-plan",
      isolation: "worktree" as const,
      batchId: "batch-1",
      laneId: null,
      joinId: null,
      mergeStatus: "pending" as const,
      cleanupStatus: "pending" as const,
      lastMergeError: null,
    };

    const repository = createRepository(
      createWorkflowExecution({
        status: "running",
        activeContextIds: [],
        contextStates: {
          "context-plan": structuredClone(parkedContextState),
        },
        taskStates: {
          "task-plan-1": {
            taskId: "task-plan-1",
            contextId: "context-plan",
            order: 1,
            status: "completed",
            summary: "Done",
            startedAt: "2026-03-27T15:00:00.000Z",
            completedAt: "2026-03-27T15:00:30.000Z",
            lastConversationId: "conversation-1",
            failureMessage: null,
            failureHistory: [],
          },
        },
        machineSnapshot: {
          schemaVersion: 1,
          lifecycleStatus: "running",
          activeContextId: null,
          recoveryMode: "none",
          hasLiveIteration: false,
        },
      }),
    );

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      isExecutionLoopActive() {
        return false;
      },
    });

    const recovered = await manager.normalizeAfterRestart("/repo", "session-1");

    expect(recovered).not.toBeNull();
    expect(recovered?.status).toBe("paused");
    expect(recovered?.contextStates["context-plan"]).toEqual(
      parkedContextState,
    );
  });

  it("transitions a running execution with pendingHaltReason directly to halted (drain resumed after crash)", async () => {
    const haltReason: GraphWorkflowHaltReason = {
      type: "circuit_breaker",
      contextId: "context-plan",
      condition: "retry_exhaustion",
      summary: "consecutive failures exhausted",
    };

    const repository = createRepository(
      createWorkflowExecution({
        status: "running",
        activeContextIds: ["context-plan"],
        pendingHaltReason: haltReason,
        contextStates: {
          "context-plan": {
            pendingApproval: null,
            contextId: "context-plan",
            status: "running",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 1,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            laneId: null,
            joinId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
        },
        taskStates: {
          "task-plan-1": {
            taskId: "task-plan-1",
            contextId: "context-plan",
            order: 1,
            status: "running",
            summary: null,
            startedAt: "2026-03-27T15:00:00.000Z",
            completedAt: null,
            lastConversationId: "conversation-1",
            failureMessage: null,
            failureHistory: [],
          },
        },
        machineSnapshot: {
          schemaVersion: 1,
          lifecycleStatus: "running",
          activeContextId: "context-plan",
          recoveryMode: "none",
          hasLiveIteration: false,
        },
      }),
    );

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      isExecutionLoopActive() {
        return false;
      },
      now() {
        return "2026-04-02T08:08:08.000Z";
      },
    });

    const recovered = await manager.normalizeAfterRestart("/repo", "session-1");

    expect(recovered?.status).toBe("halted");
    expect(recovered?.haltReason).toEqual(haltReason);
    expect(recovered?.pendingHaltReason).toBeNull();
    expect(recovered?.completedAt).toBe("2026-04-02T08:08:08.000Z");
    expect(recovered?.machineSnapshot).toEqual({
      schemaVersion: 1,
      lifecycleStatus: "halted",
      activeContextId: "context-plan",
      recoveryMode: "restart_drain_resumed",
      hasLiveIteration: false,
    });
    expect(repository.read()?.status).toBe("halted");
    expect(repository.read()?.haltReason).toEqual(haltReason);
    expect(repository.read()?.pendingHaltReason).toBeNull();
  });

  it("normalizes an in-progress (running) join back to pending on restart while preserving merged source progress", async () => {
    const baseExecution = createWorkflowExecution();
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "running",
        activeContextIds: [],
        executionLanes: {
          "lane-a": {
            laneId: "lane-a",
            kind: "worktree",
            status: "active",
            worktreePath: "/repo/.worktrees/feature.lane-a",
            branchName: "csm/feature-lane-a",
            includedContextIds: ["context-plan"],
            lastCommittingContextId: "context-plan",
            commitSnapshots: [],
            createdAt: "2026-03-27T15:00:00.000Z",
            updatedAt: "2026-03-27T15:00:00.000Z",
          },
          "lane-b": {
            laneId: "lane-b",
            kind: "worktree",
            status: "active",
            worktreePath: "/repo/.worktrees/feature.lane-b",
            branchName: "csm/feature-lane-b",
            includedContextIds: ["context-implement"],
            lastCommittingContextId: "context-implement",
            commitSnapshots: [],
            createdAt: "2026-03-27T15:00:00.000Z",
            updatedAt: "2026-03-27T15:00:00.000Z",
          },
          "lane-target": {
            laneId: "lane-target",
            kind: "worktree",
            status: "active",
            worktreePath: "/repo/.worktrees/feature.lane-target",
            branchName: "csm/feature-lane-target",
            includedContextIds: [],
            lastCommittingContextId: null,
            commitSnapshots: [],
            createdAt: "2026-03-27T15:00:00.000Z",
            updatedAt: "2026-03-27T15:00:00.000Z",
          },
        },
        joins: {
          "join-in-flight": {
            joinId: "join-in-flight",
            kind: "context_merge",
            contextId: null,
            targetLaneId: "lane-target",
            sourceLaneIds: ["lane-a", "lane-b"],
            mergedSourceLaneIds: ["lane-a"],
            status: "running",
            errorMessage: null,
            conflicts: null,
            createdAt: "2026-03-27T15:00:00.000Z",
            updatedAt: "2026-03-27T15:00:30.000Z",
            completedAt: null,
          },
        },
        machineSnapshot: {
          schemaVersion: 1,
          lifecycleStatus: "running",
          activeContextId: null,
          recoveryMode: "none",
          hasLiveIteration: true,
        },
      }),
    );

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      now() {
        return "2026-03-27T15:10:00.000Z";
      },
    });

    const recovered = await manager.normalizeAfterRestart("/repo", "session-1");

    expect(recovered).not.toBeNull();
    expect(recovered?.status).toBe("paused");
    const join = recovered?.joins["join-in-flight"];
    expect(join?.status).toBe("pending");
    expect(join?.mergedSourceLaneIds).toEqual(["lane-a"]);
    expect(join?.updatedAt).toBe("2026-03-27T15:10:00.000Z");
    expect(join?.completedAt).toBeNull();
    expect(join?.errorMessage).toBeNull();
    expect(join?.conflicts).toBeNull();
  });

  it("leaves succeeded and failed joins untouched on restart normalization", async () => {
    const baseExecution = createWorkflowExecution();
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "running",
        joins: {
          "join-done": {
            joinId: "join-done",
            kind: "context_merge",
            contextId: null,
            targetLaneId: "lane-target",
            sourceLaneIds: ["lane-a", "lane-b"],
            mergedSourceLaneIds: ["lane-a", "lane-b"],
            status: "succeeded",
            errorMessage: null,
            conflicts: null,
            createdAt: "2026-03-27T15:00:00.000Z",
            updatedAt: "2026-03-27T15:01:00.000Z",
            completedAt: "2026-03-27T15:01:00.000Z",
          },
          "join-failed": {
            joinId: "join-failed",
            kind: "context_merge",
            contextId: null,
            targetLaneId: "lane-other",
            sourceLaneIds: ["lane-c", "lane-d"],
            mergedSourceLaneIds: ["lane-c"],
            status: "failed",
            errorMessage: "merge tool exited 1",
            conflicts: null,
            createdAt: "2026-03-27T15:00:00.000Z",
            updatedAt: "2026-03-27T15:02:00.000Z",
            completedAt: "2026-03-27T15:02:00.000Z",
          },
        },
        machineSnapshot: {
          schemaVersion: 1,
          lifecycleStatus: "running",
          activeContextId: null,
          recoveryMode: "none",
          hasLiveIteration: true,
        },
      }),
    );

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      now() {
        return "2026-03-27T15:10:00.000Z";
      },
    });

    const recovered = await manager.normalizeAfterRestart("/repo", "session-1");

    expect(recovered?.joins["join-done"]?.status).toBe("succeeded");
    expect(recovered?.joins["join-done"]?.updatedAt).toBe(
      "2026-03-27T15:01:00.000Z",
    );
    expect(recovered?.joins["join-failed"]?.status).toBe("failed");
    expect(recovered?.joins["join-failed"]?.errorMessage).toBe(
      "merge tool exited 1",
    );
    expect(recovered?.joins["join-failed"]?.updatedAt).toBe(
      "2026-03-27T15:02:00.000Z",
    );
  });

  it("preserves lane assignments on running contexts so no duplicate lane is forked after restart", async () => {
    const baseExecution = createWorkflowExecution();
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "running",
        activeContextIds: ["context-plan"],
        executionLanes: {
          "lane-plan": {
            laneId: "lane-plan",
            kind: "worktree",
            status: "active",
            worktreePath: "/repo/.worktrees/feature.lane-plan",
            branchName: "csm/feature-lane-plan",
            includedContextIds: [],
            lastCommittingContextId: null,
            commitSnapshots: [],
            createdAt: "2026-03-27T15:00:00.000Z",
            updatedAt: "2026-03-27T15:00:00.000Z",
          },
        },
        contextStates: {
          ...baseExecution.contextStates,
          "context-plan": {
            ...baseExecution.contextStates["context-plan"]!,
            status: "running",
            laneId: "lane-plan",
            isolation: "worktree",
            worktreePath: "/repo/.worktrees/feature.lane-plan",
            branchName: "csm/feature-lane-plan",
          },
        },
        machineSnapshot: {
          schemaVersion: 1,
          lifecycleStatus: "running",
          activeContextId: "context-plan",
          recoveryMode: "none",
          hasLiveIteration: true,
        },
      }),
    );

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      now() {
        return "2026-03-27T15:10:00.000Z";
      },
    });

    const recovered = await manager.normalizeAfterRestart("/repo", "session-1");

    expect(recovered?.status).toBe("paused");
    const plan = recovered?.contextStates["context-plan"];
    expect(plan?.status).toBe("ready");
    expect(plan?.laneId).toBe("lane-plan");
    expect(plan?.worktreePath).toBe("/repo/.worktrees/feature.lane-plan");
    expect(plan?.branchName).toBe("csm/feature-lane-plan");
    expect(recovered?.executionLanes["lane-plan"]?.status).toBe("active");
  });

  it("preserves running joins and lane assignments when draining to halted via pendingHaltReason", async () => {
    const haltReason: GraphWorkflowHaltReason = {
      type: "circuit_breaker",
      contextId: "context-plan",
      condition: "retry_exhaustion",
      summary: "consecutive failures exhausted",
    };
    const baseExecution = createWorkflowExecution();
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "running",
        activeContextIds: ["context-plan"],
        pendingHaltReason: haltReason,
        executionLanes: {
          "lane-plan": {
            laneId: "lane-plan",
            kind: "worktree",
            status: "active",
            worktreePath: "/repo/.worktrees/feature.lane-plan",
            branchName: "csm/feature-lane-plan",
            includedContextIds: [],
            lastCommittingContextId: null,
            commitSnapshots: [],
            createdAt: "2026-03-27T15:00:00.000Z",
            updatedAt: "2026-03-27T15:00:00.000Z",
          },
        },
        joins: {
          "join-in-flight": {
            joinId: "join-in-flight",
            kind: "final_publish",
            contextId: null,
            targetLaneId: "__session__",
            sourceLaneIds: ["lane-plan"],
            mergedSourceLaneIds: [],
            status: "running",
            errorMessage: null,
            conflicts: null,
            createdAt: "2026-03-27T15:00:00.000Z",
            updatedAt: "2026-03-27T15:00:30.000Z",
            completedAt: null,
          },
        },
        contextStates: {
          ...baseExecution.contextStates,
          "context-plan": {
            ...baseExecution.contextStates["context-plan"]!,
            status: "running",
            laneId: "lane-plan",
            isolation: "worktree",
            worktreePath: "/repo/.worktrees/feature.lane-plan",
            branchName: "csm/feature-lane-plan",
          },
        },
        machineSnapshot: {
          schemaVersion: 1,
          lifecycleStatus: "running",
          activeContextId: "context-plan",
          recoveryMode: "none",
          hasLiveIteration: true,
        },
      }),
    );

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      now() {
        return "2026-04-02T08:08:08.000Z";
      },
    });

    const recovered = await manager.normalizeAfterRestart("/repo", "session-1");

    expect(recovered?.status).toBe("halted");
    expect(recovered?.haltReason).toEqual(haltReason);
    expect(recovered?.pendingHaltReason).toBeNull();
    expect(recovered?.contextStates["context-plan"]?.laneId).toBe("lane-plan");
    expect(recovered?.executionLanes["lane-plan"]?.status).toBe("active");
    const join = recovered?.joins["join-in-flight"];
    expect(join?.status).toBe("pending");
    expect(join?.mergedSourceLaneIds).toEqual([]);
    expect(join?.updatedAt).toBe("2026-04-02T08:08:08.000Z");
  });

  it("schedules the first runnable context and keeps other eligible contexts ready", async () => {
    const branchedDefinition = createResolvedWorkflowDefinition({
      edges: [
        {
          id: "edge-plan-implement",
          sourceContextId: "context-plan",
          targetContextId: "context-implement",
        },
        {
          id: "edge-plan-verify",
          sourceContextId: "context-plan",
          targetContextId: "context-verify",
        },
      ],
    });

    const baseExecution = createWorkflowExecution({
      workingDefinition: branchedDefinition,
    });
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "running",
        workingDefinition: branchedDefinition,
        contextStates: {
          ...baseExecution.contextStates,
          "context-plan": {
            ...baseExecution.contextStates["context-plan"]!,
            status: "completed",
            completedTaskCount: 1,
            iterationCount: 1,
          },
        },
      }),
    );

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
    });

    const execution = await manager.scheduleNextContext("/repo", "session-1");

    expect(execution.activeContextIds).toEqual(["context-implement"]);
    expect(execution.contextStates["context-implement"]?.status).toBe(
      "running",
    );
    expect(execution.contextStates["context-verify"]?.status).toBe("ready");
    expect(execution.machineSnapshot).toEqual({
      schemaVersion: 1,
      lifecycleStatus: "running",
      activeContextId: "context-implement",
      recoveryMode: "none",
      hasLiveIteration: false,
    });
  });

  it("resumes a halted execution, resetting halted context state and failure counters", async () => {
    const baseExecution = createWorkflowExecution();
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "halted",
        activeContextIds: ["context-plan"],
        completedAt: "2026-03-27T15:30:00.000Z",
        haltReason: {
          type: "circuit_breaker",
          contextId: "context-plan",
          condition: "retry_exhaustion",
          summary: "tests failed",
          failureCount: 2,
        },
        contextStates: {
          ...baseExecution.contextStates,
          "context-plan": {
            ...baseExecution.contextStates["context-plan"]!,
            status: "halted",
            iterationCount: 2,
            consecutiveFailureCount: 2,
          },
        },
        taskStates: {
          ...baseExecution.taskStates,
          "task-plan-1": {
            ...baseExecution.taskStates["task-plan-1"]!,
            status: "completed",
            startedAt: "2026-03-27T15:00:00.000Z",
            completedAt: "2026-03-27T15:10:00.000Z",
            lastConversationId: "conversation-1",
          },
        },
        machineSnapshot: {
          schemaVersion: 1,
          lifecycleStatus: "halted",
          activeContextId: "context-plan",
          recoveryMode: "none",
          hasLiveIteration: false,
        },
      }),
    );

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
    });

    const execution = await manager.resume("/repo", "session-1");

    expect(execution.status).toBe("running");
    expect(execution.completedAt).toBeNull();
    expect(execution.haltReason).toBeNull();
    expect(execution.activeContextIds).toEqual(["context-plan"]);
    expect(execution.contextStates["context-plan"]).toMatchObject({
      status: "ready",
      consecutiveFailureCount: 0,
    });
    expect(execution.machineSnapshot).toEqual({
      schemaVersion: 1,
      lifecycleStatus: "running",
      activeContextId: "context-plan",
      recoveryMode: "none",
      hasLiveIteration: false,
    });
  });

  it("resumes a halted execution, resetting the failure counter of the context the breaker bumped to ready", async () => {
    // The context that trips the circuit breaker is active+running at halt, so
    // the halt transition (markActiveContextReady) bumps it to `ready`, not
    // `halted`. Resume must still clear its consecutiveFailureCount, otherwise
    // the breaker re-trips almost immediately and resume makes no progress.
    const baseExecution = createWorkflowExecution();
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "halted",
        activeContextIds: ["context-plan"],
        completedAt: "2026-03-27T15:30:00.000Z",
        haltReason: {
          type: "circuit_breaker",
          contextId: "context-plan",
          condition: "retry_exhaustion",
          summary: "tests failed",
          failureCount: 3,
        },
        contextStates: {
          ...baseExecution.contextStates,
          "context-plan": {
            ...baseExecution.contextStates["context-plan"]!,
            status: "ready",
            iterationCount: 3,
            consecutiveFailureCount: 3,
          },
        },
      }),
    );

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
    });

    const execution = await manager.resume("/repo", "session-1");

    expect(execution.status).toBe("running");
    expect(execution.haltReason).toBeNull();
    expect(execution.contextStates["context-plan"]).toMatchObject({
      status: "ready",
      consecutiveFailureCount: 0,
    });
  });

  it("resume preserves merged-failed contexts and populates pendingMergeRetry", async () => {
    const baseExecution = createWorkflowExecution();
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "halted",
        activeContextIds: [],
        completedAt: "2026-03-27T15:30:00.000Z",
        haltReason: {
          type: "merge_precondition_failed",
          contextId: "context-plan",
          targetBranch: "csm/session-1",
          dirtyPaths: [],
          totalDirtyCount: 1,
          message: "Target branch dirty",
        },
        secondaryHaltReasons: [
          {
            type: "merge_precondition_failed",
            contextId: "context-implement",
            targetBranch: "csm/session-1",
            dirtyPaths: [],
            totalDirtyCount: 1,
            message: "Target branch dirty",
          },
        ],
        contextStates: {
          ...baseExecution.contextStates,
          "context-plan": {
            ...baseExecution.contextStates["context-plan"]!,
            status: "completed",
            isolation: "worktree",
            worktreePath: "/repo/.worktrees/session-1.context-plan",
            branchName: "csm/session-1-context-plan",
            mergeStatus: "merged-failed",
            cleanupStatus: "pending",
            lastMergeError: "Target branch dirty",
          },
          "context-implement": {
            ...baseExecution.contextStates["context-implement"]!,
            status: "halted",
            consecutiveFailureCount: 2,
          },
        },
      }),
    );

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
    });

    const execution = await manager.resume("/repo", "session-1");

    expect(execution.status).toBe("running");
    expect(execution.haltReason).toBeNull();
    expect(execution.secondaryHaltReasons).toEqual([]);
    expect(execution.pendingMergeRetry).toEqual(["context-plan"]);
    expect(execution.contextStates["context-plan"]).toMatchObject({
      status: "completed",
      mergeStatus: "pending",
      lastMergeError: null,
    });
    expect(execution.contextStates["context-implement"]).toMatchObject({
      status: "ready",
      consecutiveFailureCount: 0,
    });
  });

  it("recordPendingHaltReason appends to secondaryHaltReasons after the first failure (cap 10)", async () => {
    const baseExecution = createWorkflowExecution();
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "running",
        activeContextIds: ["context-plan"],
      }),
    );

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
    });

    const firstReason: import("@/lib/workflows/schemas").GraphWorkflowHaltReason =
      {
        type: "recovery_error",
        message: "first",
      };
    const firstResult = await manager.recordPendingHaltReason({
      projectPath: "/repo",
      sessionName: "session-1",
      reason: firstReason,
    });
    expect(firstResult.accepted).toBe(true);
    expect(firstResult.execution.pendingHaltReason).toEqual(firstReason);
    expect(firstResult.execution.secondaryHaltReasons).toEqual([]);

    for (let i = 0; i < 12; i++) {
      await manager.recordPendingHaltReason({
        projectPath: "/repo",
        sessionName: "session-1",
        reason: { type: "recovery_error", message: `secondary-${i}` },
      });
    }

    const finalState = repository.read();
    expect(finalState?.pendingHaltReason).toEqual(firstReason);
    expect(finalState?.secondaryHaltReasons).toHaveLength(10);
    expect(finalState?.secondaryHaltReasons[0]).toEqual({
      type: "recovery_error",
      message: "secondary-0",
    });
    expect(finalState?.secondaryHaltReasons[9]).toEqual({
      type: "recovery_error",
      message: "secondary-9",
    });
  });

  it("rejects resuming an aborted execution", async () => {
    const repository = createRepository(
      createWorkflowExecution({
        status: "aborted",
        activeContextIds: ["context-plan"],
        completedAt: "2026-03-27T15:30:00.000Z",
        haltReason: { type: "aborted" },
        contextStates: {
          "context-plan": {
            pendingApproval: null,
            contextId: "context-plan",
            status: "ready",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 1,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            laneId: null,
            joinId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
        },
        taskStates: {
          "task-plan-1": {
            taskId: "task-plan-1",
            contextId: "context-plan",
            order: 1,
            status: "interrupted",
            summary: null,
            startedAt: "2026-03-27T15:00:00.000Z",
            completedAt: null,
            lastConversationId: "conversation-1",
            failureMessage: null,
            failureHistory: [],
          },
        },
        machineSnapshot: {
          schemaVersion: 1,
          lifecycleStatus: "aborted",
          activeContextId: "context-plan",
          recoveryMode: "interrupted_task",
          hasLiveIteration: false,
        },
      }),
    );

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
    });

    await expect(manager.resume("/repo", "session-1")).rejects.toThrow(
      "Only paused or halted graph workflow executions can be resumed",
    );
  });

  it("rejects resuming a completed execution", async () => {
    const repository = createRepository(
      createWorkflowExecution({
        status: "completed",
        completedAt: "2026-03-27T15:30:00.000Z",
      }),
    );

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
    });

    await expect(manager.resume("/repo", "session-1")).rejects.toThrow(
      "can be resumed",
    );
  });

  it("rejects starting a second active execution in the same session", async () => {
    const repository = createRepository(createWorkflowExecution());
    const loadDefinition = vi.fn(async () => createWorkflowDefinitionRecord());

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      loadDefinition,
    });

    await expect(
      manager.start({
        projectPath: "/repo",
        sessionName: "session-1",
        definitionId: "workflow-1",
      }),
    ).rejects.toThrow("already has an active graph workflow execution");
    expect(loadDefinition).not.toHaveBeenCalled();
  });

  it("clears lane states when scheduling a new execution context", async () => {
    const baseExecution = createWorkflowExecution({
      status: "running",
      activeContextIds: [],
      laneStates: {
        "context-implement": {
          implementer: {
            engine: "claude",
            lane: "implementer",
            contextId: "context-implement",
            sessionRef: {
              engine: "claude",
              lane: "implementer",
              conversationId: "conv-old",
            },
            lastContextTokens: 50_000,
            lastContextWindowMax: 200_000,
            rotateBeforeNextTurn: false,
            limitEvaluation: "disabled",
            lastUsedAt: "2026-03-27T15:00:00.000Z",
          },
        },
      },
      contextStates: {
        "context-plan": {
          pendingApproval: null,
          contextId: "context-plan",
          status: "completed",
          totalTaskCount: 1,
          completedTaskCount: 1,
          iterationCount: 1,
          consecutiveFailureCount: 0,
          worktreePath: null,
          branchName: null,
          isolation: "session",
          batchId: null,
          laneId: null,
          joinId: null,
          mergeStatus: "not-applicable",
          cleanupStatus: "not-applicable",
          lastMergeError: null,
        },
        "context-implement": {
          pendingApproval: null,
          contextId: "context-implement",
          status: "pending",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
          worktreePath: null,
          branchName: null,
          isolation: "session",
          batchId: null,
          laneId: null,
          joinId: null,
          mergeStatus: "not-applicable",
          cleanupStatus: "not-applicable",
          lastMergeError: null,
        },
        "context-verify": {
          pendingApproval: null,
          contextId: "context-verify",
          status: "pending",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
          worktreePath: null,
          branchName: null,
          isolation: "session",
          batchId: null,
          laneId: null,
          joinId: null,
          mergeStatus: "not-applicable",
          cleanupStatus: "not-applicable",
          lastMergeError: null,
        },
      },
    });

    const repository = createRepository(baseExecution);
    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
    });

    const execution = await manager.scheduleNextContext("/repo", "session-1");

    expect(execution.laneStates).toEqual({});
  });

  describe("resetContext", () => {
    function createPausedExecutionWithRunState(): GraphWorkflowExecution {
      return createWorkflowExecution({
        status: "paused",
        activeContextIds: ["context-implement"],
        contextStates: {
          "context-plan": {
            pendingApproval: null,
            contextId: "context-plan",
            status: "completed",
            totalTaskCount: 1,
            completedTaskCount: 1,
            iterationCount: 2,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            laneId: null,
            joinId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
          "context-implement": {
            pendingApproval: null,
            contextId: "context-implement",
            status: "ready",
            totalTaskCount: 1,
            completedTaskCount: 1,
            iterationCount: 3,
            consecutiveFailureCount: 2,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            laneId: null,
            joinId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
          "context-verify": {
            pendingApproval: null,
            contextId: "context-verify",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            laneId: null,
            joinId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
        },
        taskStates: {
          "task-plan-1": {
            taskId: "task-plan-1",
            contextId: "context-plan",
            order: 1,
            status: "completed",
            summary: "Planned",
            startedAt: "2026-03-27T15:00:00.000Z",
            completedAt: "2026-03-27T15:01:00.000Z",
            lastConversationId: "conv-plan",
            failureMessage: null,
            failureHistory: [],
          },
          "task-implement-1": {
            taskId: "task-implement-1",
            contextId: "context-implement",
            order: 1,
            status: "completed",
            summary: "Implemented",
            startedAt: "2026-03-27T15:05:00.000Z",
            completedAt: "2026-03-27T15:10:00.000Z",
            lastConversationId: "conv-impl",
            failureMessage: "prior failure",
            failureHistory: [
              { message: "flaky", timestamp: "2026-03-27T15:07:00.000Z" },
            ],
          },
          "task-verify-1": {
            taskId: "task-verify-1",
            contextId: "context-verify",
            order: 1,
            status: "pending",
            summary: null,
            startedAt: null,
            completedAt: null,
            lastConversationId: null,
            failureMessage: null,
            failureHistory: [],
          },
        },
        laneStates: {
          "context-implement": {
            implementer: {
              engine: "claude",
              lane: "implementer",
              contextId: "context-implement",
              sessionRef: {
                engine: "claude",
                lane: "implementer",
                conversationId: "conv-impl",
              },
              lastContextTokens: 10,
              lastContextWindowMax: 100,
              rotateBeforeNextTurn: false,
              limitEvaluation: "disabled",
              lastUsedAt: "2026-03-27T15:10:00.000Z",
            },
          },
          "context-plan": {
            context_validator: {
              engine: "claude",
              lane: "context_validator",
              contextId: "context-plan",
              sessionRef: {
                engine: "claude",
                lane: "context_validator",
                conversationId: "conv-val",
              },
              lastContextTokens: null,
              lastContextWindowMax: null,
              rotateBeforeNextTurn: false,
              limitEvaluation: "disabled",
              lastUsedAt: "2026-03-27T15:11:00.000Z",
            },
          },
        },
        machineSnapshot: {
          schemaVersion: 1,
          lifecycleStatus: "paused",
          activeContextId: "context-implement",
          recoveryMode: "none",
          hasLiveIteration: false,
        },
      });
    }

    it("stops the reset context's lane dev servers, scoped to that context, before resetting", async () => {
      const repository = createRepository(createPausedExecutionWithRunState());
      const stopExecutionLaneDevServers = vi.fn(async () => {});

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
        stopExecutionLaneDevServers,
      });

      await manager.resetContext("/repo", "session-1", "context-implement");

      expect(stopExecutionLaneDevServers).toHaveBeenCalledWith(
        expect.objectContaining({
          projectPath: "/repo",
          contextIds: ["context-implement"],
        }),
      );
    });

    it("resets the selected context to execution-start defaults and persists via the repository", async () => {
      const repository = createRepository(createPausedExecutionWithRunState());

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
      });

      const execution = await manager.resetContext(
        "/repo",
        "session-1",
        "context-implement",
      );

      expect(execution.status).toBe("paused");
      expect(execution.activeContextIds).toEqual([]);
      expect(execution.completedAt).toBeNull();
      expect(execution.haltReason).toBeNull();
      expect(execution.machineSnapshot).toBeNull();
      expect(execution.contextStates["context-implement"]).toEqual({
        contextId: "context-implement",
        status: "pending",
        totalTaskCount: 1,
        completedTaskCount: 0,
        iterationCount: 0,
        consecutiveFailureCount: 0,
        worktreePath: null,
        branchName: null,
        isolation: "session",
        batchId: null,
        laneId: null,
        joinId: null,
        mergeStatus: "not-applicable",
        cleanupStatus: "not-applicable",
        lastMergeError: null,
        pendingApproval: null,
      });
      expect(execution.taskStates["task-implement-1"]).toEqual({
        taskId: "task-implement-1",
        contextId: "context-implement",
        order: 1,
        status: "pending",
        summary: null,
        startedAt: null,
        completedAt: null,
        lastConversationId: null,
        failureMessage: null,
        failureHistory: [],
      });
      expect(execution.laneStates["context-implement"]).toBeUndefined();
      expect(
        execution.laneStates["context-plan"]?.["context_validator"],
      ).toBeDefined();

      // Repository was updated
      expect(repository.read()).toEqual(execution);
    });

    it("registers an execution logger when resetting from halted so the reset lifecycle event is captured", async () => {
      _resetRegistryForTesting();
      const haltedExecution = createWorkflowExecution({
        ...createPausedExecutionWithRunState(),
        status: "halted",
        completedAt: "2026-03-27T15:30:00.000Z",
        haltReason: {
          type: "max_iterations",
          contextId: "context-implement",
          iterationCount: 3,
        },
      });
      const repository = createRepository(haltedExecution);
      // Simulate the state after `send(halt)`: the execution logger is unregistered.
      unregisterExecutionLogger(haltedExecution.id);
      expect(getExecutionLogger(haltedExecution.id)).toBeNull();

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
      });

      const execution = await manager.resetContext(
        "/repo",
        "session-1",
        "context-implement",
      );

      expect(execution.status).toBe("paused");
      expect(getExecutionLogger(haltedExecution.id)).not.toBeNull();
      _resetRegistryForTesting();
    });

    it("accepts reset when the execution is halted and moves it back to paused", async () => {
      const repository = createRepository(
        createWorkflowExecution({
          ...createPausedExecutionWithRunState(),
          status: "halted",
          completedAt: "2026-03-27T15:30:00.000Z",
          haltReason: {
            type: "max_iterations",
            contextId: "context-implement",
            iterationCount: 3,
          },
        }),
      );

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
      });

      const execution = await manager.resetContext(
        "/repo",
        "session-1",
        "context-implement",
      );

      expect(execution.status).toBe("paused");
      expect(execution.completedAt).toBeNull();
      expect(execution.haltReason).toBeNull();
    });

    it("rejects reset when the execution is running", async () => {
      const repository = createRepository(
        createWorkflowExecution({
          ...createPausedExecutionWithRunState(),
          status: "running",
        }),
      );

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
      });

      await expect(
        manager.resetContext("/repo", "session-1", "context-implement"),
      ).rejects.toThrow(/paused|halted/i);
    });

    it("rejects reset when the target context is already completed", async () => {
      const repository = createRepository(createPausedExecutionWithRunState());

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
      });

      await expect(
        manager.resetContext("/repo", "session-1", "context-plan"),
      ).rejects.toThrow(/completed/i);
    });

    it("rejects reset when there is no active execution", async () => {
      const repository = createRepository(null);

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
      });

      await expect(
        manager.resetContext("/repo", "session-1", "context-implement"),
      ).rejects.toThrow(
        "Session does not have an active graph workflow execution",
      );
    });
  });

  describe("mutateActive", () => {
    it("applies fn to the latest persisted execution and returns the persisted shape", async () => {
      const repository = createRepository(
        createWorkflowExecution({
          status: "running",
          activeContextIds: [],
        }),
      );
      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
      });

      const result = await manager.mutateActive(
        "/repo",
        "session-1",
        (execution) => {
          const next = structuredClone(execution);
          next.activeContextIds = ["context-plan"];
          return next;
        },
      );

      expect(result.activeContextIds).toEqual(["context-plan"]);
      expect(repository.read()?.activeContextIds).toEqual(["context-plan"]);
    });

    it("serializes concurrent invocations so the second mutator observes the first's effect", async () => {
      const repository = createRepository(
        createWorkflowExecution({
          status: "running",
          activeContextIds: [],
        }),
      );
      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
      });

      const [first, second] = await Promise.all([
        manager.mutateActive("/repo", "session-1", (execution) => {
          const next = structuredClone(execution);
          next.activeContextIds = [...next.activeContextIds, "context-plan"];
          return next;
        }),
        manager.mutateActive("/repo", "session-1", (execution) => {
          const next = structuredClone(execution);
          next.activeContextIds = [
            ...next.activeContextIds,
            "context-implement",
          ];
          return next;
        }),
      ]);

      expect(first.activeContextIds).toEqual(["context-plan"]);
      expect(second.activeContextIds).toEqual([
        "context-plan",
        "context-implement",
      ]);
      expect(repository.read()?.activeContextIds).toEqual([
        "context-plan",
        "context-implement",
      ]);
    });

    it("releases the lock and does not persist when fn throws", async () => {
      const repository = createRepository(
        createWorkflowExecution({
          status: "running",
          activeContextIds: [],
        }),
      );
      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
      });

      await expect(
        manager.mutateActive("/repo", "session-1", () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      expect(repository.read()?.activeContextIds).toEqual([]);

      const result = await manager.mutateActive(
        "/repo",
        "session-1",
        (execution) => {
          const next = structuredClone(execution);
          next.activeContextIds = ["context-plan"];
          return next;
        },
      );
      expect(result.activeContextIds).toEqual(["context-plan"]);
      expect(repository.read()?.activeContextIds).toEqual(["context-plan"]);
    });

    it("throws when there is no active graph workflow execution", async () => {
      const repository = createRepository(null);
      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
      });

      await expect(
        manager.mutateActive("/repo", "session-1", (execution) => execution),
      ).rejects.toThrow(
        "Session does not have an active graph workflow execution",
      );
    });
  });

  describe("scheduleEligibleContexts", () => {
    function createSession(
      overrides: Partial<SessionState> = {},
    ): SessionState {
      return {
        sessionName: "session-1",
        worktreePath: "/repo/.worktrees/feature-abc",
        branchName: "csm/feature-abc",
        createdAt: "2026-03-27T15:00:00.000Z",
        lastActivityAt: "2026-03-27T15:00:00.000Z",
        archived: false,
        finished: false,
        conversations: [],
        source: "cc",
        creationMode: "normal",
        tddEnabled: true,
        targetBranch: "main",
        parentSessionName: null,
        graphWorkflowExecution: null,
        referenceDocuments: [],
        ...overrides,
      };
    }

    type ProvisionCall = ProvisionInput;

    function createParallelWorktreesStub(options?: {
      failOnContextId?: string;
      failureMessage?: string;
    }): ParallelWorktrees & {
      provisionCalls: ProvisionCall[];
      disposeCalls: DisposeInput[];
    } {
      const provisionCalls: ProvisionCall[] = [];
      const disposeCalls: DisposeInput[] = [];

      async function provision(
        input: ProvisionInput,
      ): Promise<ProvisionResult> {
        provisionCalls.push(input);
        if (
          options?.failOnContextId &&
          input.contextId === options.failOnContextId
        ) {
          throw new Error(options.failureMessage ?? "provision failed");
        }
        return {
          worktreePath: `${input.projectPath}/.worktrees/${input.sessionDir}.${input.contextId}`,
          branchName: `csm/${input.sessionDir}-${input.contextId}`,
        };
      }

      async function provisionBatch(
        inputs: ProvisionInput[],
      ): Promise<ProvisionResult[]> {
        const results: ProvisionResult[] = [];
        const created: ProvisionInput[] = [];
        try {
          for (const input of inputs) {
            const result = await provision(input);
            results.push(result);
            created.push(input);
          }
          return results;
        } catch (err) {
          for (const input of created) {
            await dispose({
              projectPath: input.projectPath,
              worktreePath: `${input.projectPath}/.worktrees/${input.sessionDir}.${input.contextId}`,
              branchName: `csm/${input.sessionDir}-${input.contextId}`,
            });
          }
          throw err;
        }
      }

      async function dispose(input: DisposeInput): Promise<DisposeResult> {
        disposeCalls.push(input);
        return { status: "removed" };
      }

      async function provisionLane(
        input: ProvisionLaneInput,
      ): Promise<ProvisionResult> {
        return provision({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          sessionDir: input.sessionDir,
          sessionBranch: input.sessionBranch,
          contextId: input.laneId,
        });
      }

      async function provisionLaneBatch(
        inputs: ProvisionLaneInput[],
      ): Promise<ProvisionResult[]> {
        return provisionBatch(
          inputs.map((input) => ({
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            sessionDir: input.sessionDir,
            sessionBranch: input.sessionBranch,
            contextId: input.laneId,
          })),
        );
      }

      async function disposeLane(input: DisposeInput): Promise<DisposeResult> {
        return dispose(input);
      }

      async function cleanupLane(): Promise<DisposeResult> {
        return { status: "removed" };
      }

      return {
        provision,
        provisionBatch,
        dispose,
        provisionLane,
        provisionLaneBatch,
        disposeLane,
        cleanupLane,
        provisionCalls,
        disposeCalls,
      };
    }

    it("returns kind 'none' when no contexts are eligible", async () => {
      const repository = createRepository(
        createWorkflowExecution({
          status: "running",
          activeContextIds: [],
          contextStates: {
            "context-plan": {
              pendingApproval: null,
              contextId: "context-plan",
              status: "completed",
              totalTaskCount: 1,
              completedTaskCount: 1,
              iterationCount: 1,
              consecutiveFailureCount: 0,
              worktreePath: null,
              branchName: null,
              isolation: "session",
              batchId: null,
              laneId: null,
              joinId: null,
              mergeStatus: "not-applicable",
              cleanupStatus: "not-applicable",
              lastMergeError: null,
            },
            "context-implement": {
              pendingApproval: null,
              contextId: "context-implement",
              status: "completed",
              totalTaskCount: 1,
              completedTaskCount: 1,
              iterationCount: 1,
              consecutiveFailureCount: 0,
              worktreePath: null,
              branchName: null,
              isolation: "session",
              batchId: null,
              laneId: null,
              joinId: null,
              mergeStatus: "not-applicable",
              cleanupStatus: "not-applicable",
              lastMergeError: null,
            },
            "context-verify": {
              pendingApproval: null,
              contextId: "context-verify",
              status: "completed",
              totalTaskCount: 1,
              completedTaskCount: 1,
              iterationCount: 1,
              consecutiveFailureCount: 0,
              worktreePath: null,
              branchName: null,
              isolation: "session",
              batchId: null,
              laneId: null,
              joinId: null,
              mergeStatus: "not-applicable",
              cleanupStatus: "not-applicable",
              lastMergeError: null,
            },
          },
        }),
      );
      const parallelWorktrees = createParallelWorktreesStub();

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
        parallelWorktrees,
        async getSession() {
          return createSession();
        },
      });

      const result = await manager.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName: "session-1",
      });

      expect(result.scheduled).toEqual({ kind: "none" });
      expect(result.execution.activeContextIds).toEqual([]);
      expect(parallelWorktrees.provisionCalls).toEqual([]);
    });

    it("schedules a single eligible context inside the session worktree without a sub-worktree", async () => {
      const baseExecution = createWorkflowExecution();
      const repository = createRepository(
        createWorkflowExecution({
          ...baseExecution,
          status: "running",
          contextStates: {
            ...baseExecution.contextStates,
            "context-plan": {
              ...baseExecution.contextStates["context-plan"]!,
            },
          },
        }),
      );
      const parallelWorktrees = createParallelWorktreesStub();

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
        parallelWorktrees,
        async getSession() {
          return createSession();
        },
      });

      const result = await manager.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName: "session-1",
        sessionLaneEnabled: true,
      });

      expect(result.scheduled).toEqual({
        kind: "solo",
        contextId: "context-plan",
      });
      expect(result.execution.activeContextIds).toEqual(["context-plan"]);
      const planState = result.execution.contextStates["context-plan"];
      expect(planState?.status).toBe("running");
      expect(planState?.isolation).toBe("session");
      expect(planState?.worktreePath).toBeNull();
      expect(planState?.branchName).toBeNull();
      expect(planState?.batchId).toBeNull();
      expect(parallelWorktrees.provisionCalls).toEqual([]);
    });

    it("forces worktree isolation for a single eligible context when another worktree-isolated context is still running", async () => {
      const noEdgeDefinition = createResolvedWorkflowDefinition({ edges: [] });
      const baseExecution = createWorkflowExecution({
        workingDefinition: noEdgeDefinition,
      });
      const repository = createRepository(
        createWorkflowExecution({
          ...baseExecution,
          status: "running",
          workingDefinition: noEdgeDefinition,
          activeContextIds: ["context-implement"],
          contextStates: {
            ...baseExecution.contextStates,
            "context-plan": {
              ...baseExecution.contextStates["context-plan"]!,
              status: "completed",
              completedTaskCount: 1,
              iterationCount: 1,
            },
            "context-implement": {
              ...baseExecution.contextStates["context-implement"]!,
              status: "running",
              isolation: "worktree",
              worktreePath: "/repo/.worktrees/feature-abc.context-implement",
              branchName: "csm/feature-abc-context-implement",
              batchId: "batch-prior",
              iterationCount: 1,
            },
          },
        }),
      );
      const parallelWorktrees = createParallelWorktreesStub();

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
        parallelWorktrees,
        async getSession() {
          return createSession({
            worktreePath: "/repo/.worktrees/feature-abc",
            branchName: "csm/feature-abc",
          });
        },
      });

      const result = await manager.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName: "session-1",
      });

      expect(result.scheduled.kind).toBe("parallel");
      if (result.scheduled.kind !== "parallel") return;
      expect(result.scheduled.contextIds).toEqual(["context-verify"]);

      const verifyState = result.execution.contextStates["context-verify"];
      expect(verifyState?.status).toBe("running");
      expect(verifyState?.isolation).toBe("worktree");
      expect(verifyState?.worktreePath).toBe(
        "/repo/.worktrees/feature-abc.context-verify",
      );
      expect(verifyState?.branchName).toBe("csm/feature-abc-context-verify");
      expect(verifyState?.batchId).toBe(result.scheduled.batchId);

      expect(parallelWorktrees.provisionCalls.map((c) => c.contextId)).toEqual([
        "context-verify",
      ]);

      const implState = result.execution.contextStates["context-implement"];
      expect(implState?.isolation).toBe("worktree");
      expect(implState?.status).toBe("running");
    });

    it("forces worktree isolation for a single eligible context while a worktree-isolated sibling still has an unpublished merge in progress", async () => {
      const noEdgeDefinition = createResolvedWorkflowDefinition({ edges: [] });
      const baseExecution = createWorkflowExecution({
        workingDefinition: noEdgeDefinition,
      });
      const repository = createRepository(
        createWorkflowExecution({
          ...baseExecution,
          status: "running",
          workingDefinition: noEdgeDefinition,
          activeContextIds: ["context-implement"],
          contextStates: {
            ...baseExecution.contextStates,
            "context-plan": {
              ...baseExecution.contextStates["context-plan"]!,
              status: "completed",
              completedTaskCount: 1,
              iterationCount: 1,
            },
            "context-implement": {
              ...baseExecution.contextStates["context-implement"]!,
              status: "completed",
              isolation: "worktree",
              worktreePath: "/repo/.worktrees/feature-abc.context-implement",
              branchName: "csm/feature-abc-context-implement",
              batchId: "batch-prior",
              mergeStatus: "in-progress",
              completedTaskCount: 1,
              iterationCount: 1,
            },
          },
        }),
      );
      const parallelWorktrees = createParallelWorktreesStub();

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
        parallelWorktrees,
        async getSession() {
          return createSession({
            worktreePath: "/repo/.worktrees/feature-abc",
            branchName: "csm/feature-abc",
          });
        },
      });

      const result = await manager.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName: "session-1",
      });

      expect(result.scheduled.kind).toBe("parallel");
      if (result.scheduled.kind !== "parallel") return;
      expect(result.scheduled.contextIds).toEqual(["context-verify"]);

      const verifyState = result.execution.contextStates["context-verify"];
      expect(verifyState?.status).toBe("running");
      expect(verifyState?.isolation).toBe("worktree");
      expect(verifyState?.worktreePath).toBe(
        "/repo/.worktrees/feature-abc.context-verify",
      );

      expect(parallelWorktrees.provisionCalls.map((c) => c.contextId)).toEqual([
        "context-verify",
      ]);
    });

    it("forces worktree isolation for a single eligible context while a worktree-isolated sibling has completed iteration but its merge is still queued behind the mutex", async () => {
      const noEdgeDefinition = createResolvedWorkflowDefinition({ edges: [] });
      const baseExecution = createWorkflowExecution({
        workingDefinition: noEdgeDefinition,
      });
      const repository = createRepository(
        createWorkflowExecution({
          ...baseExecution,
          status: "running",
          workingDefinition: noEdgeDefinition,
          activeContextIds: ["context-implement"],
          contextStates: {
            ...baseExecution.contextStates,
            "context-plan": {
              ...baseExecution.contextStates["context-plan"]!,
              status: "completed",
              completedTaskCount: 1,
              iterationCount: 1,
            },
            "context-implement": {
              ...baseExecution.contextStates["context-implement"]!,
              status: "completed",
              isolation: "worktree",
              worktreePath: "/repo/.worktrees/feature-abc.context-implement",
              branchName: "csm/feature-abc-context-implement",
              batchId: "batch-prior",
              mergeStatus: "not-applicable",
              completedTaskCount: 1,
              iterationCount: 1,
            },
          },
        }),
      );
      const parallelWorktrees = createParallelWorktreesStub();

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
        parallelWorktrees,
        async getSession() {
          return createSession({
            worktreePath: "/repo/.worktrees/feature-abc",
            branchName: "csm/feature-abc",
          });
        },
      });

      const result = await manager.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName: "session-1",
      });

      expect(result.scheduled.kind).toBe("parallel");
      if (result.scheduled.kind !== "parallel") return;
      expect(result.scheduled.contextIds).toEqual(["context-verify"]);

      const verifyState = result.execution.contextStates["context-verify"];
      expect(verifyState?.status).toBe("running");
      expect(verifyState?.isolation).toBe("worktree");
      expect(verifyState?.worktreePath).toBe(
        "/repo/.worktrees/feature-abc.context-verify",
      );

      expect(parallelWorktrees.provisionCalls.map((c) => c.contextId)).toEqual([
        "context-verify",
      ]);
    });

    it("returns 'none' and does not mark any context running when the persisted execution already has pendingHaltReason", async () => {
      const haltReason: GraphWorkflowHaltReason = {
        type: "merge_failure",
        contextId: "context-implement",
        message: "concurrent sibling failed",
        conflictFiles: [],
      };
      const baseExecution = createWorkflowExecution();
      const repository = createRepository(
        createWorkflowExecution({
          ...baseExecution,
          status: "running",
          pendingHaltReason: haltReason,
          activeContextIds: ["context-implement"],
          contextStates: {
            ...baseExecution.contextStates,
            "context-implement": {
              ...baseExecution.contextStates["context-implement"]!,
              status: "running",
              isolation: "worktree",
              worktreePath: "/repo/.worktrees/feature-abc.context-implement",
              branchName: "csm/feature-abc-context-implement",
              batchId: "batch-prior",
            },
          },
        }),
      );
      const parallelWorktrees = createParallelWorktreesStub();

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
        parallelWorktrees,
        async getSession() {
          return createSession({
            worktreePath: "/repo/.worktrees/feature-abc",
            branchName: "csm/feature-abc",
          });
        },
      });

      const result = await manager.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName: "session-1",
      });

      expect(result.scheduled).toEqual({ kind: "none" });
      expect(result.execution.pendingHaltReason).toEqual(haltReason);

      const planState = result.execution.contextStates["context-plan"];
      expect(planState?.status).toBe("pending");
      expect(planState?.isolation).toBe("session");
      expect(planState?.worktreePath).toBeNull();
      expect(planState?.branchName).toBeNull();
      expect(planState?.batchId).toBeNull();

      const verifyState = result.execution.contextStates["context-verify"];
      expect(verifyState?.status).toBe("pending");
      expect(verifyState?.isolation).toBe("session");

      expect(result.execution.activeContextIds).toEqual(["context-implement"]);
      expect(parallelWorktrees.provisionCalls).toEqual([]);
    });

    it("provisions a worktree per eligible context and assigns a shared batchId when ≥2 are eligible", async () => {
      const branchedDefinition = createResolvedWorkflowDefinition({
        edges: [
          {
            id: "edge-plan-implement",
            sourceContextId: "context-plan",
            targetContextId: "context-implement",
          },
          {
            id: "edge-plan-verify",
            sourceContextId: "context-plan",
            targetContextId: "context-verify",
          },
        ],
      });
      const baseExecution = createWorkflowExecution({
        workingDefinition: branchedDefinition,
      });
      const repository = createRepository(
        createWorkflowExecution({
          ...baseExecution,
          status: "running",
          workingDefinition: branchedDefinition,
          contextStates: {
            ...baseExecution.contextStates,
            "context-plan": {
              ...baseExecution.contextStates["context-plan"]!,
              status: "completed",
              completedTaskCount: 1,
              iterationCount: 1,
            },
          },
        }),
      );
      const parallelWorktrees = createParallelWorktreesStub();

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
        createExecutionId() {
          return "batch-1";
        },
        parallelWorktrees,
        async getSession() {
          return createSession({
            worktreePath: "/repo/.worktrees/feature-abc",
            branchName: "csm/feature-abc",
          });
        },
      });

      const result = await manager.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName: "session-1",
      });

      expect(result.scheduled.kind).toBe("parallel");
      if (result.scheduled.kind !== "parallel") return;
      expect(result.scheduled.contextIds.sort()).toEqual([
        "context-implement",
        "context-verify",
      ]);
      expect(typeof result.scheduled.batchId).toBe("string");
      expect(result.scheduled.batchId.length).toBeGreaterThan(0);
      expect(result.execution.activeContextIds.sort()).toEqual([
        "context-implement",
        "context-verify",
      ]);

      const implState = result.execution.contextStates["context-implement"];
      expect(implState?.status).toBe("running");
      expect(implState?.isolation).toBe("worktree");
      expect(implState?.worktreePath).toBe(
        "/repo/.worktrees/feature-abc.context-implement",
      );
      expect(implState?.branchName).toBe("csm/feature-abc-context-implement");
      expect(implState?.batchId).toBe(result.scheduled.batchId);

      const verifyState = result.execution.contextStates["context-verify"];
      expect(verifyState?.status).toBe("running");
      expect(verifyState?.isolation).toBe("worktree");
      expect(verifyState?.worktreePath).toBe(
        "/repo/.worktrees/feature-abc.context-verify",
      );
      expect(verifyState?.branchName).toBe("csm/feature-abc-context-verify");
      expect(verifyState?.batchId).toBe(result.scheduled.batchId);

      expect(
        parallelWorktrees.provisionCalls.map((c) => c.contextId).sort(),
      ).toEqual(["context-implement", "context-verify"]);
      expect(parallelWorktrees.disposeCalls).toEqual([]);
    });

    it("rolls back already-provisioned worktrees when a later worktree fails to provision", async () => {
      const branchedDefinition = createResolvedWorkflowDefinition({
        edges: [
          {
            id: "edge-plan-implement",
            sourceContextId: "context-plan",
            targetContextId: "context-implement",
          },
          {
            id: "edge-plan-verify",
            sourceContextId: "context-plan",
            targetContextId: "context-verify",
          },
        ],
      });
      const baseExecution = createWorkflowExecution({
        workingDefinition: branchedDefinition,
      });
      const initialExecution = createWorkflowExecution({
        ...baseExecution,
        status: "running",
        workingDefinition: branchedDefinition,
        contextStates: {
          ...baseExecution.contextStates,
          "context-plan": {
            ...baseExecution.contextStates["context-plan"]!,
            status: "completed",
            completedTaskCount: 1,
            iterationCount: 1,
          },
        },
      });
      const repository = createRepository(initialExecution);
      const parallelWorktrees = createParallelWorktreesStub({
        failOnContextId: "context-verify",
        failureMessage: "disk full",
      });

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
        parallelWorktrees,
        async getSession() {
          return createSession({
            worktreePath: "/repo/.worktrees/feature-abc",
            branchName: "csm/feature-abc",
          });
        },
      });

      await expect(
        manager.scheduleEligibleContexts({
          projectPath: "/repo",
          sessionName: "session-1",
        }),
      ).rejects.toThrow(/disk full/);

      expect(parallelWorktrees.disposeCalls.map((c) => c.branchName)).toEqual([
        "csm/feature-abc-context-implement",
      ]);

      const persisted = repository.read();
      expect(persisted?.activeContextIds).toEqual([]);
      expect(persisted?.contextStates["context-implement"]?.status).not.toBe(
        "running",
      );
      expect(persisted?.contextStates["context-verify"]?.status).not.toBe(
        "running",
      );
    });

    it("rejects scheduling before any worktree is created when a contextId is unsafe", async () => {
      const unsafeDefinition = createResolvedWorkflowDefinition({
        executionContexts: [
          {
            id: "context-plan",
            title: "Plan",
            acceptanceCriteria: "Plan complete",
            implementer: {
              backend: "claude",
              model: "opus",
              reasoningEffort: "medium",
            },
            contextValidator: null,
            scriptValidator: { enabled: false },
            humanApprovalGate: { enabled: false },
            mutability: { allowAgentTaskAdd: false },
            circuitBreaker: {},
            iterationPolicy: {
              maxIterations: 4,
              continuity: { enabled: true },
            },
          },
          {
            id: "..escape",
            title: "Bad",
            acceptanceCriteria: "n/a",
            implementer: {
              backend: "claude",
              model: "opus",
              reasoningEffort: "medium",
            },
            contextValidator: null,
            scriptValidator: { enabled: false },
            humanApprovalGate: { enabled: false },
            mutability: { allowAgentTaskAdd: false },
            circuitBreaker: {},
            iterationPolicy: {
              maxIterations: 4,
              continuity: { enabled: true },
            },
          },
          {
            id: "context-other",
            title: "Other",
            acceptanceCriteria: "n/a",
            implementer: {
              backend: "claude",
              model: "opus",
              reasoningEffort: "medium",
            },
            contextValidator: null,
            scriptValidator: { enabled: false },
            humanApprovalGate: { enabled: false },
            mutability: { allowAgentTaskAdd: false },
            circuitBreaker: {},
            iterationPolicy: {
              maxIterations: 4,
              continuity: { enabled: true },
            },
          },
        ],
        tasks: [
          {
            id: "task-plan-1",
            contextId: "context-plan",
            order: 1,
            title: "Plan",
            instructions: "Plan",
            source: "user",
          },
          {
            id: "task-bad-1",
            contextId: "..escape",
            order: 1,
            title: "Bad",
            instructions: "Bad",
            source: "user",
          },
          {
            id: "task-other-1",
            contextId: "context-other",
            order: 1,
            title: "Other",
            instructions: "Other",
            source: "user",
          },
        ],
        edges: [
          {
            id: "edge-plan-bad",
            sourceContextId: "context-plan",
            targetContextId: "..escape",
          },
          {
            id: "edge-plan-other",
            sourceContextId: "context-plan",
            targetContextId: "context-other",
          },
        ],
      });
      const repository = createRepository(
        createWorkflowExecution({
          workingDefinition: unsafeDefinition,
          status: "running",
          activeContextIds: [],
          contextStates: {
            "context-plan": {
              pendingApproval: null,
              contextId: "context-plan",
              status: "completed",
              totalTaskCount: 1,
              completedTaskCount: 1,
              iterationCount: 1,
              consecutiveFailureCount: 0,
              worktreePath: null,
              branchName: null,
              isolation: "session",
              batchId: null,
              laneId: null,
              joinId: null,
              mergeStatus: "not-applicable",
              cleanupStatus: "not-applicable",
              lastMergeError: null,
            },
            "..escape": {
              pendingApproval: null,
              contextId: "..escape",
              status: "pending",
              totalTaskCount: 1,
              completedTaskCount: 0,
              iterationCount: 0,
              consecutiveFailureCount: 0,
              worktreePath: null,
              branchName: null,
              isolation: "session",
              batchId: null,
              laneId: null,
              joinId: null,
              mergeStatus: "not-applicable",
              cleanupStatus: "not-applicable",
              lastMergeError: null,
            },
            "context-other": {
              pendingApproval: null,
              contextId: "context-other",
              status: "pending",
              totalTaskCount: 1,
              completedTaskCount: 0,
              iterationCount: 0,
              consecutiveFailureCount: 0,
              worktreePath: null,
              branchName: null,
              isolation: "session",
              batchId: null,
              laneId: null,
              joinId: null,
              mergeStatus: "not-applicable",
              cleanupStatus: "not-applicable",
              lastMergeError: null,
            },
          },
          taskStates: {
            "task-plan-1": {
              taskId: "task-plan-1",
              contextId: "context-plan",
              order: 1,
              status: "completed",
              summary: "ok",
              startedAt: "2026-03-27T15:00:00.000Z",
              completedAt: "2026-03-27T15:01:00.000Z",
              lastConversationId: "c1",
              failureMessage: null,
              failureHistory: [],
            },
            "task-bad-1": {
              taskId: "task-bad-1",
              contextId: "..escape",
              order: 1,
              status: "pending",
              summary: null,
              startedAt: null,
              completedAt: null,
              lastConversationId: null,
              failureMessage: null,
              failureHistory: [],
            },
            "task-other-1": {
              taskId: "task-other-1",
              contextId: "context-other",
              order: 1,
              status: "pending",
              summary: null,
              startedAt: null,
              completedAt: null,
              lastConversationId: null,
              failureMessage: null,
              failureHistory: [],
            },
          },
        }),
      );
      const parallelWorktrees = createParallelWorktreesStub();

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
        parallelWorktrees,
        async getSession() {
          return createSession({
            worktreePath: "/repo/.worktrees/feature-abc",
            branchName: "csm/feature-abc",
          });
        },
      });

      await expect(
        manager.scheduleEligibleContexts({
          projectPath: "/repo",
          sessionName: "session-1",
        }),
      ).rejects.toThrow(/contextId/i);

      expect(parallelWorktrees.provisionCalls).toEqual([]);
      expect(parallelWorktrees.disposeCalls).toEqual([]);
    });

    it("does not schedule contexts whose dependencies are unsatisfied while another context is running", async () => {
      const branchedDefinition = createResolvedWorkflowDefinition({
        edges: [
          {
            id: "edge-plan-implement",
            sourceContextId: "context-plan",
            targetContextId: "context-implement",
          },
          {
            id: "edge-implement-verify",
            sourceContextId: "context-implement",
            targetContextId: "context-verify",
          },
        ],
      });
      const baseExecution = createWorkflowExecution({
        workingDefinition: branchedDefinition,
      });
      const repository = createRepository(
        createWorkflowExecution({
          ...baseExecution,
          status: "running",
          workingDefinition: branchedDefinition,
          activeContextIds: ["context-implement"],
          contextStates: {
            ...baseExecution.contextStates,
            "context-plan": {
              ...baseExecution.contextStates["context-plan"]!,
              status: "completed",
              completedTaskCount: 1,
              iterationCount: 1,
            },
            "context-implement": {
              ...baseExecution.contextStates["context-implement"]!,
              status: "running",
              iterationCount: 1,
            },
          },
        }),
      );
      const parallelWorktrees = createParallelWorktreesStub();

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
        parallelWorktrees,
        async getSession() {
          return createSession();
        },
      });

      const result = await manager.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName: "session-1",
      });

      expect(result.scheduled).toEqual({ kind: "none" });
      expect(parallelWorktrees.provisionCalls).toEqual([]);
      expect(result.execution.contextStates["context-verify"]?.status).toBe(
        "pending",
      );
      expect(result.execution.activeContextIds).toEqual(["context-implement"]);
    });

    it("reuses the upstream's lane (no provisioning) when its output is lane-committed and downstream targets that lane", async () => {
      const lane = {
        laneId: "lane-plan",
        kind: "worktree" as const,
        status: "active" as const,
        worktreePath: "/repo/.worktrees/feature-abc.lane-plan",
        branchName: "csm/feature-abc-lane-plan",
        includedContextIds: ["context-plan"],
        lastCommittingContextId: "context-plan",
        commitSnapshots: [],
        createdAt: "2026-03-27T15:00:00.000Z",
        updatedAt: "2026-03-27T15:00:00.000Z",
      };
      const baseExecution = createWorkflowExecution();
      const repository = createRepository(
        createWorkflowExecution({
          ...baseExecution,
          status: "running",
          executionLanes: { "lane-plan": lane },
          contextStates: {
            ...baseExecution.contextStates,
            "context-plan": {
              ...baseExecution.contextStates["context-plan"]!,
              status: "completed",
              isolation: "worktree",
              laneId: "lane-plan",
              worktreePath: lane.worktreePath,
              branchName: lane.branchName,
              mergeStatus: "merged-success",
              completedTaskCount: 1,
              iterationCount: 1,
            },
          },
        }),
      );
      const parallelWorktrees = createParallelWorktreesStub();

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
        parallelWorktrees,
        async getSession() {
          return createSession({
            worktreePath: "/repo/.worktrees/feature-abc",
            branchName: "csm/feature-abc",
          });
        },
      });

      const result = await manager.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName: "session-1",
      });

      expect(result.scheduled.kind).toBe("parallel");
      if (result.scheduled.kind !== "parallel") return;
      expect(result.scheduled.contextIds).toEqual(["context-implement"]);

      const implState = result.execution.contextStates["context-implement"];
      expect(implState?.status).toBe("running");
      expect(implState?.laneId).toBe("lane-plan");
      expect(implState?.isolation).toBe("worktree");
      expect(implState?.worktreePath).toBe(lane.worktreePath);
      expect(implState?.branchName).toBe(lane.branchName);

      expect(parallelWorktrees.provisionCalls).toEqual([]);
    });

    it("schedules onto the post-join common target lane when two upstreams have been joined into it", async () => {
      const branchedDefinition = createResolvedWorkflowDefinition({
        edges: [
          {
            id: "edge-plan-verify",
            sourceContextId: "context-plan",
            targetContextId: "context-verify",
          },
          {
            id: "edge-implement-verify",
            sourceContextId: "context-implement",
            targetContextId: "context-verify",
          },
        ],
      });
      const laneA = {
        laneId: "lane-a",
        kind: "worktree" as const,
        status: "merged" as const,
        worktreePath: "/repo/.worktrees/feature-abc.lane-a",
        branchName: "csm/feature-abc-lane-a",
        includedContextIds: ["context-plan"],
        lastCommittingContextId: "context-plan",
        commitSnapshots: [],
        createdAt: "2026-03-27T15:00:00.000Z",
        updatedAt: "2026-03-27T15:00:00.000Z",
      };
      const laneB = {
        laneId: "lane-b",
        kind: "worktree" as const,
        status: "merged" as const,
        worktreePath: "/repo/.worktrees/feature-abc.lane-b",
        branchName: "csm/feature-abc-lane-b",
        includedContextIds: ["context-implement"],
        lastCommittingContextId: "context-implement",
        commitSnapshots: [],
        createdAt: "2026-03-27T15:00:00.000Z",
        updatedAt: "2026-03-27T15:00:00.000Z",
      };
      const laneTarget = {
        laneId: "lane-target",
        kind: "worktree" as const,
        status: "active" as const,
        worktreePath: "/repo/.worktrees/feature-abc.lane-target",
        branchName: "csm/feature-abc-lane-target",
        includedContextIds: [],
        lastCommittingContextId: null,
        commitSnapshots: [],
        createdAt: "2026-03-27T15:00:00.000Z",
        updatedAt: "2026-03-27T15:00:00.000Z",
      };
      const baseExecution = createWorkflowExecution({
        workingDefinition: branchedDefinition,
      });
      const repository = createRepository(
        createWorkflowExecution({
          ...baseExecution,
          status: "running",
          workingDefinition: branchedDefinition,
          executionLanes: {
            "lane-a": laneA,
            "lane-b": laneB,
            "lane-target": laneTarget,
          },
          joins: {
            "join-1": {
              joinId: "join-1",
              kind: "context_merge",
              contextId: null,
              targetLaneId: "lane-target",
              sourceLaneIds: ["lane-a", "lane-b"],
              mergedSourceLaneIds: ["lane-a", "lane-b"],
              status: "succeeded",
              errorMessage: null,
              conflicts: null,
              createdAt: "2026-03-27T15:00:00.000Z",
              updatedAt: "2026-03-27T15:00:00.000Z",
              completedAt: "2026-03-27T15:00:00.000Z",
            },
          },
          contextStates: {
            ...baseExecution.contextStates,
            "context-plan": {
              ...baseExecution.contextStates["context-plan"]!,
              status: "completed",
              isolation: "worktree",
              laneId: "lane-a",
              worktreePath: laneA.worktreePath,
              branchName: laneA.branchName,
              mergeStatus: "merged-success",
              completedTaskCount: 1,
              iterationCount: 1,
            },
            "context-implement": {
              ...baseExecution.contextStates["context-implement"]!,
              status: "completed",
              isolation: "worktree",
              laneId: "lane-b",
              worktreePath: laneB.worktreePath,
              branchName: laneB.branchName,
              mergeStatus: "merged-success",
              completedTaskCount: 1,
              iterationCount: 1,
            },
          },
        }),
      );
      const parallelWorktrees = createParallelWorktreesStub();

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
        parallelWorktrees,
        async getSession() {
          return createSession({
            worktreePath: "/repo/.worktrees/feature-abc",
            branchName: "csm/feature-abc",
          });
        },
      });

      const result = await manager.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName: "session-1",
      });

      expect(result.scheduled.kind).toBe("parallel");
      if (result.scheduled.kind !== "parallel") return;
      expect(result.scheduled.contextIds).toEqual(["context-verify"]);

      const verifyState = result.execution.contextStates["context-verify"];
      expect(verifyState?.status).toBe("running");
      expect(verifyState?.laneId).toBe("lane-target");
      expect(verifyState?.isolation).toBe("worktree");
      expect(verifyState?.worktreePath).toBe(laneTarget.worktreePath);
      expect(verifyState?.branchName).toBe(laneTarget.branchName);

      expect(parallelWorktrees.provisionCalls).toEqual([]);
    });

    it("returns kind 'none' when capacityRemaining is 0 even with eligible contexts", async () => {
      const baseExecution = createWorkflowExecution();
      const repository = createRepository(
        createWorkflowExecution({
          ...baseExecution,
          status: "running",
        }),
      );
      const parallelWorktrees = createParallelWorktreesStub();

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
        parallelWorktrees,
        async getSession() {
          return createSession();
        },
      });

      const result = await manager.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName: "session-1",
        capacityRemaining: 0,
      });

      expect(result.scheduled).toEqual({ kind: "none" });
      expect(parallelWorktrees.provisionCalls).toEqual([]);
      expect(result.execution.activeContextIds).toEqual([]);
    });

    it("forks a fresh worktree when sessionLaneEnabled is false and the upstream landed in session", async () => {
      const baseExecution = createWorkflowExecution();
      const repository = createRepository(
        createWorkflowExecution({
          ...baseExecution,
          status: "running",
          contextStates: {
            ...baseExecution.contextStates,
            "context-plan": {
              ...baseExecution.contextStates["context-plan"]!,
              status: "completed",
              isolation: "session",
              mergeStatus: "not-applicable",
              completedTaskCount: 1,
              iterationCount: 1,
            },
          },
        }),
      );
      const parallelWorktrees = createParallelWorktreesStub();

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
        parallelWorktrees,
        async getSession() {
          return createSession({
            worktreePath: "/repo/.worktrees/feature-abc",
            branchName: "csm/feature-abc",
          });
        },
      });

      const result = await manager.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName: "session-1",
        sessionLaneEnabled: false,
      });

      expect(result.scheduled.kind).toBe("parallel");
      if (result.scheduled.kind !== "parallel") return;
      expect(result.scheduled.contextIds).toEqual(["context-implement"]);

      const implState = result.execution.contextStates["context-implement"];
      expect(implState?.status).toBe("running");
      expect(implState?.isolation).toBe("worktree");
      expect(implState?.laneId).toBeNull();
      expect(implState?.worktreePath).toBe(
        "/repo/.worktrees/feature-abc.context-implement",
      );

      expect(
        result.execution.executionLanes["context-implement"],
      ).toBeUndefined();

      expect(parallelWorktrees.provisionCalls.map((c) => c.contextId)).toEqual([
        "context-implement",
      ]);
    });

    it("schedules both fan-out children in one pass: inheritor reuses the parent lane, non-inheritor forks a new worktree lane from the parent's branch", async () => {
      const fanOutDefinition = createResolvedWorkflowDefinition({
        edges: [
          {
            id: "edge-plan-implement",
            sourceContextId: "context-plan",
            targetContextId: "context-implement",
          },
          {
            id: "edge-plan-verify",
            sourceContextId: "context-plan",
            targetContextId: "context-verify",
          },
        ],
      });
      const lane = {
        laneId: "lane-plan",
        kind: "worktree" as const,
        status: "active" as const,
        worktreePath: "/repo/.worktrees/feature-abc.lane-plan",
        branchName: "csm/feature-abc-lane-plan",
        includedContextIds: ["context-plan"],
        lastCommittingContextId: "context-plan",
        commitSnapshots: [],
        createdAt: "2026-03-27T15:00:00.000Z",
        updatedAt: "2026-03-27T15:00:00.000Z",
      };
      const baseExecution = createWorkflowExecution({
        workingDefinition: fanOutDefinition,
      });
      const repository = createRepository(
        createWorkflowExecution({
          ...baseExecution,
          status: "running",
          workingDefinition: fanOutDefinition,
          executionLanes: { "lane-plan": lane },
          contextStates: {
            ...baseExecution.contextStates,
            "context-plan": {
              ...baseExecution.contextStates["context-plan"]!,
              status: "completed",
              isolation: "worktree",
              laneId: "lane-plan",
              worktreePath: lane.worktreePath,
              branchName: lane.branchName,
              mergeStatus: "merged-success",
              completedTaskCount: 1,
              iterationCount: 1,
            },
          },
        }),
      );
      const parallelWorktrees = createParallelWorktreesStub();

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
        parallelWorktrees,
        async getSession() {
          return createSession({
            worktreePath: "/repo/.worktrees/feature-abc",
            branchName: "csm/feature-abc",
          });
        },
      });

      const result = await manager.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName: "session-1",
      });

      expect(result.scheduled.kind).toBe("parallel");
      if (result.scheduled.kind !== "parallel") return;
      // With no continuationMap entry the inheritor defaults to definition
      // order: context-implement reuses lane-plan, context-verify forks.
      expect(result.scheduled.contextIds.slice().sort()).toEqual([
        "context-implement",
        "context-verify",
      ]);

      const inheritState = result.execution.contextStates["context-implement"];
      expect(inheritState?.status).toBe("running");
      expect(inheritState?.laneId).toBe("lane-plan");
      expect(inheritState?.isolation).toBe("worktree");
      expect(inheritState?.worktreePath).toBe(lane.worktreePath);
      expect(inheritState?.branchName).toBe(lane.branchName);

      const forkState = result.execution.contextStates["context-verify"];
      expect(forkState?.status).toBe("running");
      expect(forkState?.laneId).toBe("context-verify");
      expect(forkState?.isolation).toBe("worktree");
      expect(forkState?.worktreePath).toBe(
        "/repo/.worktrees/feature-abc.context-verify",
      );
      expect(forkState?.branchName).toBe("csm/feature-abc-context-verify");

      const forkedLane = result.execution.executionLanes["context-verify"];
      expect(forkedLane).toBeDefined();
      expect(forkedLane?.kind).toBe("worktree");
      expect(forkedLane?.status).toBe("active");
      expect(forkedLane?.worktreePath).toBe(
        "/repo/.worktrees/feature-abc.context-verify",
      );
      expect(forkedLane?.branchName).toBe("csm/feature-abc-context-verify");
      expect(forkedLane?.includedContextIds).toEqual(["context-plan"]);
      expect(forkedLane?.lastCommittingContextId).toBe("context-plan");
      expect(forkedLane?.commitSnapshots).toEqual([]);

      // Parent lane retained as-is; fork is a separate entry.
      expect(result.execution.executionLanes["lane-plan"]).toEqual(lane);

      // One worktree provisioned for the loser, with the parent lane's branch
      // as the base — that's the fork-from-committed-head semantics.
      expect(parallelWorktrees.provisionCalls).toHaveLength(1);
      const forkCall = parallelWorktrees.provisionCalls[0]!;
      expect(forkCall.contextId).toBe("context-verify");
      expect(forkCall.sessionBranch).toBe(lane.branchName);
      expect(forkCall.sessionDir).toBe("feature-abc");
    });

    it("uses lanePlan.continuationMap to pick the inheriting child at fan-out, even when it is later in definition order", async () => {
      const fanOutDefinition = createResolvedWorkflowDefinition({
        edges: [
          {
            id: "edge-plan-implement",
            sourceContextId: "context-plan",
            targetContextId: "context-implement",
          },
          {
            id: "edge-plan-verify",
            sourceContextId: "context-plan",
            targetContextId: "context-verify",
          },
        ],
      });
      const lane = {
        laneId: "lane-plan",
        kind: "worktree" as const,
        status: "active" as const,
        worktreePath: "/repo/.worktrees/feature-abc.lane-plan",
        branchName: "csm/feature-abc-lane-plan",
        includedContextIds: ["context-plan"],
        lastCommittingContextId: "context-plan",
        commitSnapshots: [],
        createdAt: "2026-03-27T15:00:00.000Z",
        updatedAt: "2026-03-27T15:00:00.000Z",
      };
      const baseExecution = createWorkflowExecution({
        workingDefinition: fanOutDefinition,
      });
      const repository = createRepository(
        createWorkflowExecution({
          ...baseExecution,
          status: "running",
          workingDefinition: fanOutDefinition,
          executionLanes: { "lane-plan": lane },
          // Plan elects the later-in-definition-order sibling. If the
          // scheduler honors the plan, context-verify must claim the lane
          // even though context-implement comes first in eligible order.
          lanePlan: {
            continuationMap: { "context-plan": "context-verify" },
            longestDownstreamPath: {
              "context-plan": 1,
              "context-implement": 0,
              "context-verify": 0,
            },
          },
          contextStates: {
            ...baseExecution.contextStates,
            "context-plan": {
              ...baseExecution.contextStates["context-plan"]!,
              status: "completed",
              isolation: "worktree",
              laneId: "lane-plan",
              worktreePath: lane.worktreePath,
              branchName: lane.branchName,
              mergeStatus: "merged-success",
              completedTaskCount: 1,
              iterationCount: 1,
            },
          },
        }),
      );
      const parallelWorktrees = createParallelWorktreesStub();

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
        parallelWorktrees,
        async getSession() {
          return createSession({
            worktreePath: "/repo/.worktrees/feature-abc",
            branchName: "csm/feature-abc",
          });
        },
      });

      const result = await manager.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName: "session-1",
      });

      expect(result.scheduled.kind).toBe("parallel");
      if (result.scheduled.kind !== "parallel") return;
      // Plan elects context-verify as inheritor; context-implement (the
      // non-inheritor sibling) must fork rather than wait.
      expect(result.scheduled.contextIds.slice().sort()).toEqual([
        "context-implement",
        "context-verify",
      ]);

      const verifyState = result.execution.contextStates["context-verify"];
      expect(verifyState?.status).toBe("running");
      expect(verifyState?.laneId).toBe("lane-plan");
      expect(verifyState?.isolation).toBe("worktree");
      expect(verifyState?.worktreePath).toBe(lane.worktreePath);

      const implState = result.execution.contextStates["context-implement"];
      expect(implState?.status).toBe("running");
      expect(implState?.laneId).toBe("context-implement");
      expect(implState?.isolation).toBe("worktree");
      expect(implState?.worktreePath).toBe(
        "/repo/.worktrees/feature-abc.context-implement",
      );
      expect(implState?.branchName).toBe("csm/feature-abc-context-implement");

      const forkedLane = result.execution.executionLanes["context-implement"];
      expect(forkedLane).toBeDefined();
      expect(forkedLane?.kind).toBe("worktree");
      expect(forkedLane?.status).toBe("active");
      expect(forkedLane?.includedContextIds).toEqual(["context-plan"]);
      expect(forkedLane?.lastCommittingContextId).toBe("context-plan");
      expect(forkedLane?.worktreePath).toBe(
        "/repo/.worktrees/feature-abc.context-implement",
      );
      expect(forkedLane?.branchName).toBe("csm/feature-abc-context-implement");

      expect(parallelWorktrees.provisionCalls).toHaveLength(1);
      const forkCall = parallelWorktrees.provisionCalls[0]!;
      expect(forkCall.contextId).toBe("context-implement");
      expect(forkCall.sessionBranch).toBe(lane.branchName);
    });

    it("falls back to definition-order inheritor at fan-out when lanePlan.continuationMap has no entry for the parent, forking the sibling", async () => {
      const fanOutDefinition = createResolvedWorkflowDefinition({
        edges: [
          {
            id: "edge-plan-implement",
            sourceContextId: "context-plan",
            targetContextId: "context-implement",
          },
          {
            id: "edge-plan-verify",
            sourceContextId: "context-plan",
            targetContextId: "context-verify",
          },
        ],
      });
      const lane = {
        laneId: "lane-plan",
        kind: "worktree" as const,
        status: "active" as const,
        worktreePath: "/repo/.worktrees/feature-abc.lane-plan",
        branchName: "csm/feature-abc-lane-plan",
        includedContextIds: ["context-plan"],
        lastCommittingContextId: "context-plan",
        commitSnapshots: [],
        createdAt: "2026-03-27T15:00:00.000Z",
        updatedAt: "2026-03-27T15:00:00.000Z",
      };
      const baseExecution = createWorkflowExecution({
        workingDefinition: fanOutDefinition,
      });
      const repository = createRepository(
        createWorkflowExecution({
          ...baseExecution,
          status: "running",
          workingDefinition: fanOutDefinition,
          executionLanes: { "lane-plan": lane },
          lanePlan: {
            continuationMap: {},
            longestDownstreamPath: {},
          },
          contextStates: {
            ...baseExecution.contextStates,
            "context-plan": {
              ...baseExecution.contextStates["context-plan"]!,
              status: "completed",
              isolation: "worktree",
              laneId: "lane-plan",
              worktreePath: lane.worktreePath,
              branchName: lane.branchName,
              mergeStatus: "merged-success",
              completedTaskCount: 1,
              iterationCount: 1,
            },
          },
        }),
      );
      const parallelWorktrees = createParallelWorktreesStub();

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
        parallelWorktrees,
        async getSession() {
          return createSession({
            worktreePath: "/repo/.worktrees/feature-abc",
            branchName: "csm/feature-abc",
          });
        },
      });

      const result = await manager.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName: "session-1",
      });

      expect(result.scheduled.kind).toBe("parallel");
      if (result.scheduled.kind !== "parallel") return;
      expect(result.scheduled.contextIds.slice().sort()).toEqual([
        "context-implement",
        "context-verify",
      ]);

      const inheritState = result.execution.contextStates["context-implement"];
      expect(inheritState?.laneId).toBe("lane-plan");
      expect(inheritState?.status).toBe("running");

      const forkState = result.execution.contextStates["context-verify"];
      expect(forkState?.status).toBe("running");
      expect(forkState?.laneId).toBe("context-verify");
      expect(forkState?.isolation).toBe("worktree");

      const forkedLane = result.execution.executionLanes["context-verify"];
      expect(forkedLane?.kind).toBe("worktree");
      expect(forkedLane?.includedContextIds).toEqual(["context-plan"]);
      expect(forkedLane?.lastCommittingContextId).toBe("context-plan");

      expect(parallelWorktrees.provisionCalls).toHaveLength(1);
      expect(parallelWorktrees.provisionCalls[0]?.contextId).toBe(
        "context-verify",
      );
      expect(parallelWorktrees.provisionCalls[0]?.sessionBranch).toBe(
        lane.branchName,
      );
    });

    it("deterministically restarts a fan-out with persisted continuationMap: same inheritor + forked sibling on a fresh scheduling pass", async () => {
      const fanOutDefinition = createResolvedWorkflowDefinition({
        edges: [
          {
            id: "edge-plan-implement",
            sourceContextId: "context-plan",
            targetContextId: "context-implement",
          },
          {
            id: "edge-plan-verify",
            sourceContextId: "context-plan",
            targetContextId: "context-verify",
          },
        ],
      });
      const lane = {
        laneId: "lane-plan",
        kind: "worktree" as const,
        status: "active" as const,
        worktreePath: "/repo/.worktrees/feature-abc.lane-plan",
        branchName: "csm/feature-abc-lane-plan",
        includedContextIds: ["context-plan"],
        lastCommittingContextId: "context-plan",
        commitSnapshots: [],
        createdAt: "2026-03-27T15:00:00.000Z",
        updatedAt: "2026-03-27T15:00:00.000Z",
      };
      const persistedPlan = {
        continuationMap: { "context-plan": "context-verify" },
        longestDownstreamPath: {
          "context-plan": 1,
          "context-implement": 0,
          "context-verify": 0,
        },
      };
      const baseExecution = createWorkflowExecution({
        workingDefinition: fanOutDefinition,
      });
      const seedRun = (extra: {
        sessionName: string;
      }): GraphWorkflowExecution =>
        createWorkflowExecution({
          ...baseExecution,
          id: `execution-${extra.sessionName}`,
          status: "running",
          workingDefinition: fanOutDefinition,
          executionLanes: { "lane-plan": lane },
          lanePlan: persistedPlan,
          contextStates: {
            ...baseExecution.contextStates,
            "context-plan": {
              ...baseExecution.contextStates["context-plan"]!,
              status: "completed",
              isolation: "worktree",
              laneId: "lane-plan",
              worktreePath: lane.worktreePath,
              branchName: lane.branchName,
              mergeStatus: "merged-success",
              completedTaskCount: 1,
              iterationCount: 1,
            },
          },
        });

      const runFanout = async (sessionName: string) => {
        const repository = createRepository(seedRun({ sessionName }));
        const parallelWorktrees = createParallelWorktreesStub();
        const manager = createGraphWorkflowManager({
          executionRepository: repository,
          async loadDefinition() {
            return null;
          },
          parallelWorktrees,
          async getSession() {
            return createSession({
              worktreePath: "/repo/.worktrees/feature-abc",
              branchName: "csm/feature-abc",
            });
          },
        });
        const result = await manager.scheduleEligibleContexts({
          projectPath: "/repo",
          sessionName,
        });
        return { result, parallelWorktrees };
      };

      const a = await runFanout("session-a");
      const b = await runFanout("session-b");

      for (const { result, parallelWorktrees } of [a, b]) {
        expect(result.scheduled.kind).toBe("parallel");
        if (result.scheduled.kind !== "parallel") return;
        expect(result.scheduled.contextIds.slice().sort()).toEqual([
          "context-implement",
          "context-verify",
        ]);

        const inheritState = result.execution.contextStates["context-verify"];
        expect(inheritState?.laneId).toBe("lane-plan");

        const forkState = result.execution.contextStates["context-implement"];
        expect(forkState?.laneId).toBe("context-implement");
        expect(forkState?.isolation).toBe("worktree");

        expect(
          result.execution.executionLanes["context-implement"],
        ).toBeDefined();
        expect(
          result.execution.executionLanes["context-implement"]
            ?.includedContextIds,
        ).toEqual(["context-plan"]);

        expect(parallelWorktrees.provisionCalls).toHaveLength(1);
        expect(parallelWorktrees.provisionCalls[0]?.contextId).toBe(
          "context-implement",
        );
        expect(parallelWorktrees.provisionCalls[0]?.sessionBranch).toBe(
          lane.branchName,
        );
      }
    });

    it("skips fork for a non-inheritor sibling whose parent lane is session-kind: only the inheritor is scheduled", async () => {
      const fanOutDefinition = createResolvedWorkflowDefinition({
        edges: [
          {
            id: "edge-plan-implement",
            sourceContextId: "context-plan",
            targetContextId: "context-implement",
          },
          {
            id: "edge-plan-verify",
            sourceContextId: "context-plan",
            targetContextId: "context-verify",
          },
        ],
      });
      const sessionLane = {
        laneId: "lane-session",
        kind: "session" as const,
        status: "active" as const,
        worktreePath: null,
        branchName: "csm/feature-abc",
        includedContextIds: ["context-plan"],
        lastCommittingContextId: "context-plan",
        commitSnapshots: [],
        createdAt: "2026-03-27T15:00:00.000Z",
        updatedAt: "2026-03-27T15:00:00.000Z",
      };
      const baseExecution = createWorkflowExecution({
        workingDefinition: fanOutDefinition,
      });
      const repository = createRepository(
        createWorkflowExecution({
          ...baseExecution,
          status: "running",
          workingDefinition: fanOutDefinition,
          executionLanes: { "lane-session": sessionLane },
          contextStates: {
            ...baseExecution.contextStates,
            "context-plan": {
              ...baseExecution.contextStates["context-plan"]!,
              status: "completed",
              isolation: "session",
              laneId: "lane-session",
              worktreePath: null,
              branchName: null,
              mergeStatus: "not-applicable",
              completedTaskCount: 1,
              iterationCount: 1,
            },
          },
        }),
      );
      const parallelWorktrees = createParallelWorktreesStub();

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
        parallelWorktrees,
        async getSession() {
          return createSession({
            worktreePath: "/repo/.worktrees/feature-abc",
            branchName: "csm/feature-abc",
          });
        },
      });

      const result = await manager.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName: "session-1",
      });

      expect(result.scheduled.kind).toBe("parallel");
      if (result.scheduled.kind !== "parallel") return;
      expect(result.scheduled.contextIds).toEqual(["context-implement"]);

      const inheritState = result.execution.contextStates["context-implement"];
      expect(inheritState?.laneId).toBe("lane-session");
      expect(inheritState?.isolation).toBe("session");

      const sibling = result.execution.contextStates["context-verify"];
      expect(sibling?.status).toBe("ready");
      expect(sibling?.laneId).toBeNull();
      expect(sibling?.worktreePath).toBeNull();

      expect(result.execution.executionLanes["context-verify"]).toBeUndefined();
      expect(parallelWorktrees.provisionCalls).toEqual([]);
    });

    it("routes a session-kind target lane with isolation=session and no worktree provisioning", async () => {
      const sessionLane = {
        laneId: "lane-session",
        kind: "session" as const,
        status: "active" as const,
        worktreePath: null,
        branchName: "csm/feature-abc",
        includedContextIds: ["context-plan"],
        lastCommittingContextId: "context-plan",
        commitSnapshots: [],
        createdAt: "2026-03-27T15:00:00.000Z",
        updatedAt: "2026-03-27T15:00:00.000Z",
      };
      const baseExecution = createWorkflowExecution();
      const repository = createRepository(
        createWorkflowExecution({
          ...baseExecution,
          status: "running",
          executionLanes: { "lane-session": sessionLane },
          contextStates: {
            ...baseExecution.contextStates,
            "context-plan": {
              ...baseExecution.contextStates["context-plan"]!,
              status: "completed",
              isolation: "session",
              laneId: "lane-session",
              worktreePath: null,
              branchName: null,
              mergeStatus: "not-applicable",
              completedTaskCount: 1,
              iterationCount: 1,
            },
          },
        }),
      );
      const parallelWorktrees = createParallelWorktreesStub();

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
        parallelWorktrees,
        async getSession() {
          return createSession({
            worktreePath: "/repo/.worktrees/feature-abc",
            branchName: "csm/feature-abc",
          });
        },
      });

      const result = await manager.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName: "session-1",
      });

      expect(result.scheduled.kind).toBe("parallel");
      if (result.scheduled.kind !== "parallel") return;
      expect(result.scheduled.contextIds).toEqual(["context-implement"]);

      const implState = result.execution.contextStates["context-implement"];
      expect(implState?.status).toBe("running");
      expect(implState?.laneId).toBe("lane-session");
      expect(implState?.isolation).toBe("session");
      expect(implState?.worktreePath).toBeNull();
      expect(implState?.branchName).toBeNull();

      expect(parallelWorktrees.provisionCalls).toEqual([]);
    });

    it("reuses a single worktree lane across a linear context chain (sequential lane reuse) so only the root provisions a lane", async () => {
      // Topology: context-plan -> context-implement -> context-verify (default
      // fixture). With a populated lanePlan.continuationMap, the root should
      // be minted into a worktree lane up front; each downstream then reuses
      // it without provisioning a new worktree or going through a session
      // merge.
      const baseExecution = createWorkflowExecution();
      const linearLanePlan = {
        continuationMap: {
          "context-plan": "context-implement",
          "context-implement": "context-verify",
        },
        longestDownstreamPath: {
          "context-plan": 2,
          "context-implement": 1,
          "context-verify": 0,
        },
      };
      const repository = createRepository(
        createWorkflowExecution({
          ...baseExecution,
          status: "running",
          lanePlan: linearLanePlan,
        }),
      );
      const parallelWorktrees = createParallelWorktreesStub();

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
        parallelWorktrees,
        async getSession() {
          return createSession({
            worktreePath: "/repo/.worktrees/feature-abc",
            branchName: "csm/feature-abc",
          });
        },
      });

      // Pass 1: only context-plan is eligible. It should be provisioned into
      // a fresh worktree lane whose id matches the root's contextId.
      const first = await manager.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName: "session-1",
      });
      expect(first.scheduled.kind).toBe("parallel");
      if (first.scheduled.kind !== "parallel") return;
      expect(first.scheduled.contextIds).toEqual(["context-plan"]);

      const planState = first.execution.contextStates["context-plan"];
      expect(planState?.laneId).toBe("context-plan");
      expect(planState?.isolation).toBe("worktree");
      const mintedLane = first.execution.executionLanes["context-plan"];
      expect(mintedLane).toBeDefined();
      expect(mintedLane?.kind).toBe("worktree");
      expect(mintedLane?.status).toBe("active");
      expect(mintedLane?.includedContextIds).toEqual([]);
      expect(mintedLane?.lastCommittingContextId).toBeNull();
      expect(mintedLane?.worktreePath).toBe(
        "/repo/.worktrees/feature-abc.context-plan",
      );
      expect(mintedLane?.branchName).toBe("csm/feature-abc-context-plan");
      expect(parallelWorktrees.provisionCalls).toHaveLength(1);

      // Simulate runLaneCommit: context-plan finishes, lane records its
      // committed contribution. No session merge happens — the lane retains
      // the work for the next consumer.
      const afterPlan = first.execution;
      await repository.update("/repo", "session-1", {
        ...afterPlan,
        contextStates: {
          ...afterPlan.contextStates,
          "context-plan": {
            ...afterPlan.contextStates["context-plan"]!,
            status: "completed",
            mergeStatus: "merged-success",
            completedTaskCount: 1,
            iterationCount: 1,
          },
        },
        executionLanes: {
          ...afterPlan.executionLanes,
          "context-plan": {
            ...mintedLane!,
            includedContextIds: ["context-plan"],
            lastCommittingContextId: "context-plan",
          },
        },
        activeContextIds: afterPlan.activeContextIds.filter(
          (id) => id !== "context-plan",
        ),
      });

      // Pass 2: context-implement is now eligible. Its upstream landed in the
      // worktree lane "context-plan"; classifier returns targetLaneId =
      // "context-plan" → scheduler reuses without minting. No new provision.
      const second = await manager.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName: "session-1",
      });
      expect(second.scheduled.kind).toBe("parallel");
      if (second.scheduled.kind !== "parallel") return;
      expect(second.scheduled.contextIds).toEqual(["context-implement"]);

      const implState = second.execution.contextStates["context-implement"];
      expect(implState?.laneId).toBe("context-plan");
      expect(implState?.isolation).toBe("worktree");
      expect(implState?.worktreePath).toBe(
        "/repo/.worktrees/feature-abc.context-plan",
      );
      expect(implState?.branchName).toBe("csm/feature-abc-context-plan");
      expect(parallelWorktrees.provisionCalls).toHaveLength(1);

      // Simulate runLaneCommit for context-implement: lane absorbs another
      // committed context, still no session merge.
      const afterImpl = second.execution;
      await repository.update("/repo", "session-1", {
        ...afterImpl,
        contextStates: {
          ...afterImpl.contextStates,
          "context-implement": {
            ...afterImpl.contextStates["context-implement"]!,
            status: "completed",
            mergeStatus: "merged-success",
            completedTaskCount: 1,
            iterationCount: 1,
          },
        },
        executionLanes: {
          ...afterImpl.executionLanes,
          "context-plan": {
            ...afterImpl.executionLanes["context-plan"]!,
            includedContextIds: ["context-plan", "context-implement"],
            lastCommittingContextId: "context-implement",
          },
        },
        activeContextIds: afterImpl.activeContextIds.filter(
          (id) => id !== "context-implement",
        ),
      });

      // Pass 3: context-verify is the final consumer; same lane reused. The
      // chain ran end-to-end on one worktree lane with one provisionLane call.
      const third = await manager.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName: "session-1",
      });
      expect(third.scheduled.kind).toBe("parallel");
      if (third.scheduled.kind !== "parallel") return;
      expect(third.scheduled.contextIds).toEqual(["context-verify"]);

      const verifyState = third.execution.contextStates["context-verify"];
      expect(verifyState?.laneId).toBe("context-plan");
      expect(verifyState?.isolation).toBe("worktree");
      expect(verifyState?.worktreePath).toBe(
        "/repo/.worktrees/feature-abc.context-plan",
      );

      // No additional provisioning across the whole linear chain.
      expect(parallelWorktrees.provisionCalls).toHaveLength(1);
      expect(parallelWorktrees.provisionCalls[0]!.contextId).toBe(
        "context-plan",
      );
      // No fresh worktree lanes were minted for downstream consumers.
      expect(Object.keys(third.execution.executionLanes).sort()).toEqual([
        "context-plan",
      ]);
    });

    describe("structured scheduler/lane observability", () => {
      type LoggerCall = {
        kind: "lifecycle" | "decision";
        event: string;
        data: Record<string, unknown> | undefined;
      };

      function createCapturingLogger(executionId: string): {
        logger: ExecutionLogger;
        calls: LoggerCall[];
      } {
        const calls: LoggerCall[] = [];
        const logger: ExecutionLogger = {
          executionId,
          logDir: "/tmp/test-obs",
          writeManifest() {},
          lifecycle(event, data) {
            calls.push({ kind: "lifecycle", event, data });
          },
          iteration() {},
          task() {},
          validation() {},
          writePrompt() {},
          writeValidatorResponse() {},
          writeValidatorTranscript() {},
          decision(event, data) {
            calls.push({ kind: "decision", event, data });
          },
        };
        return { logger, calls };
      }

      it("emits a scheduler.ready_set lifecycle event with eligible context ids so operators can trace ready-set computation", async () => {
        _resetRegistryForTesting();
        const baseExecution = createWorkflowExecution();
        const repository = createRepository(
          createWorkflowExecution({
            ...baseExecution,
            id: "exec-obs-ready-set",
            status: "running",
          }),
        );
        const { logger, calls } = createCapturingLogger("exec-obs-ready-set");
        registerExecutionLogger(logger);

        const parallelWorktrees = createParallelWorktreesStub();
        const manager = createGraphWorkflowManager({
          executionRepository: repository,
          async loadDefinition() {
            return null;
          },
          parallelWorktrees,
          async getSession() {
            return createSession();
          },
        });

        await manager.scheduleEligibleContexts({
          projectPath: "/repo",
          sessionName: "session-1",
        });

        const readySet = calls.find(
          (c) => c.kind === "lifecycle" && c.event === "scheduler.ready_set",
        );
        expect(readySet).toBeDefined();
        expect(readySet?.data?.eligibleContextIds).toEqual(["context-plan"]);
        unregisterExecutionLogger("exec-obs-ready-set");
      });

      it("emits a lane.created lifecycle event when minting a fresh worktree lane with the laneId, branchName, worktreePath, and originating contextId", async () => {
        _resetRegistryForTesting();
        const baseExecution = createWorkflowExecution();
        const linearLanePlan = {
          continuationMap: { "context-plan": "context-implement" },
          longestDownstreamPath: {
            "context-plan": 1,
            "context-implement": 0,
            "context-verify": 0,
          },
        };
        const repository = createRepository(
          createWorkflowExecution({
            ...baseExecution,
            id: "exec-obs-lane-created",
            status: "running",
            lanePlan: linearLanePlan,
          }),
        );
        const { logger, calls } = createCapturingLogger(
          "exec-obs-lane-created",
        );
        registerExecutionLogger(logger);

        const parallelWorktrees = createParallelWorktreesStub();
        const manager = createGraphWorkflowManager({
          executionRepository: repository,
          async loadDefinition() {
            return null;
          },
          parallelWorktrees,
          async getSession() {
            return createSession({
              worktreePath: "/repo/.worktrees/feature-abc",
              branchName: "csm/feature-abc",
            });
          },
        });

        await manager.scheduleEligibleContexts({
          projectPath: "/repo",
          sessionName: "session-1",
        });

        const laneCreated = calls.find(
          (c) => c.kind === "lifecycle" && c.event === "lane.created",
        );
        expect(laneCreated).toBeDefined();
        expect(laneCreated?.data).toMatchObject({
          laneId: "context-plan",
          contextId: "context-plan",
          branchName: "csm/feature-abc-context-plan",
          worktreePath: "/repo/.worktrees/feature-abc.context-plan",
          kind: "worktree",
        });
        unregisterExecutionLogger("exec-obs-lane-created");
      });

      it("emits a lane.reused lifecycle event when a downstream context inherits an upstream worktree lane so operators can audit lane handoff", async () => {
        _resetRegistryForTesting();
        const baseExecution = createWorkflowExecution();
        const repository = createRepository(
          createWorkflowExecution({
            ...baseExecution,
            id: "exec-obs-lane-reused",
            status: "running",
            executionLanes: {
              "context-plan": {
                laneId: "context-plan",
                kind: "worktree",
                status: "active",
                worktreePath: "/repo/.worktrees/feature-abc.context-plan",
                branchName: "csm/feature-abc-context-plan",
                includedContextIds: ["context-plan"],
                lastCommittingContextId: "context-plan",
                commitSnapshots: [],
                createdAt: "2026-03-27T15:00:00.000Z",
                updatedAt: "2026-03-27T15:00:00.000Z",
              },
            },
            contextStates: {
              ...baseExecution.contextStates,
              "context-plan": {
                ...baseExecution.contextStates["context-plan"]!,
                status: "completed",
                isolation: "worktree",
                laneId: "context-plan",
                worktreePath: "/repo/.worktrees/feature-abc.context-plan",
                branchName: "csm/feature-abc-context-plan",
                mergeStatus: "not-applicable",
                completedTaskCount: 1,
                iterationCount: 1,
              },
            },
          }),
        );
        const { logger, calls } = createCapturingLogger("exec-obs-lane-reused");
        registerExecutionLogger(logger);

        const parallelWorktrees = createParallelWorktreesStub();
        const manager = createGraphWorkflowManager({
          executionRepository: repository,
          async loadDefinition() {
            return null;
          },
          parallelWorktrees,
          async getSession() {
            return createSession({
              worktreePath: "/repo/.worktrees/feature-abc",
              branchName: "csm/feature-abc",
            });
          },
        });

        await manager.scheduleEligibleContexts({
          projectPath: "/repo",
          sessionName: "session-1",
        });

        const laneReused = calls.find(
          (c) => c.kind === "lifecycle" && c.event === "lane.reused",
        );
        expect(laneReused).toBeDefined();
        expect(laneReused?.data).toMatchObject({
          laneId: "context-plan",
          contextId: "context-implement",
          branchName: "csm/feature-abc-context-plan",
          worktreePath: "/repo/.worktrees/feature-abc.context-plan",
        });
        unregisterExecutionLogger("exec-obs-lane-reused");
      });

      it("emits a lane.cleanup lifecycle event listing cleared lane-state context ids after a successful schedule pass", async () => {
        _resetRegistryForTesting();
        const baseExecution = createWorkflowExecution();
        const repository = createRepository(
          createWorkflowExecution({
            ...baseExecution,
            id: "exec-obs-lane-cleanup",
            status: "running",
            laneStates: {
              "context-plan": {
                implementer: {
                  engine: "claude",
                  lane: "implementer",
                  contextId: "context-plan",
                  sessionRef: {
                    engine: "claude",
                    lane: "implementer",
                    conversationId: "conv-prev",
                  },
                  lastContextTokens: 10_000,
                  lastContextWindowMax: 200_000,
                  rotateBeforeNextTurn: false,
                  limitEvaluation: "disabled",
                  lastUsedAt: "2026-03-27T15:00:00.000Z",
                },
              },
            },
          }),
        );
        const { logger, calls } = createCapturingLogger(
          "exec-obs-lane-cleanup",
        );
        registerExecutionLogger(logger);

        const parallelWorktrees = createParallelWorktreesStub();
        const manager = createGraphWorkflowManager({
          executionRepository: repository,
          async loadDefinition() {
            return null;
          },
          parallelWorktrees,
          async getSession() {
            return createSession();
          },
        });

        await manager.scheduleEligibleContexts({
          projectPath: "/repo",
          sessionName: "session-1",
        });

        const cleanup = calls.find(
          (c) => c.kind === "lifecycle" && c.event === "lane.cleanup",
        );
        expect(cleanup).toBeDefined();
        expect(cleanup?.data?.clearedLaneStateContextIds).toEqual([
          "context-plan",
        ]);
        unregisterExecutionLogger("exec-obs-lane-cleanup");
      });
    });
  });

  describe("recordPendingHaltReason", () => {
    it("sets pendingHaltReason on the active execution and reports accepted=true", async () => {
      const repository = createRepository(
        createWorkflowExecution({
          status: "running",
          activeContextIds: ["context-implement"],
        }),
      );
      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
      });

      const result = await manager.recordPendingHaltReason({
        projectPath: "/repo",
        sessionName: "session-1",
        reason: { type: "recovery_error", message: "boom" },
      });

      expect(result.accepted).toBe(true);
      expect(result.execution.pendingHaltReason).toEqual({
        type: "recovery_error",
        message: "boom",
      });
      expect(repository.read()?.pendingHaltReason).toEqual({
        type: "recovery_error",
        message: "boom",
      });
      expect(repository.read()?.status).toBe("running");
    });

    it("preserves the first reason when called twice (first-failure-wins) and reports accepted=false", async () => {
      const repository = createRepository(
        createWorkflowExecution({
          status: "running",
          activeContextIds: ["context-implement"],
        }),
      );
      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
      });

      const first = await manager.recordPendingHaltReason({
        projectPath: "/repo",
        sessionName: "session-1",
        reason: { type: "recovery_error", message: "first" },
      });
      const second = await manager.recordPendingHaltReason({
        projectPath: "/repo",
        sessionName: "session-1",
        reason: {
          type: "max_iterations",
          contextId: "context-implement",
          iterationCount: 5,
        },
      });

      expect(first.accepted).toBe(true);
      expect(second.accepted).toBe(false);
      expect(second.execution.pendingHaltReason).toEqual({
        type: "recovery_error",
        message: "first",
      });
      expect(repository.read()?.pendingHaltReason).toEqual({
        type: "recovery_error",
        message: "first",
      });
    });

    it("throws when there is no active graph workflow execution", async () => {
      const repository = createRepository(null);
      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
      });

      await expect(
        manager.recordPendingHaltReason({
          projectPath: "/repo",
          sessionName: "session-1",
          reason: { type: "aborted" },
        }),
      ).rejects.toThrow(
        "Session does not have an active graph workflow execution",
      );
    });

    it("applies applyAdditionalMutation in the same transaction as the pendingHaltReason write (atomicity)", async () => {
      const seeded = createWorkflowExecution({
        status: "running",
        activeContextIds: ["context-implement"],
      });
      seeded.contextStates["context-implement"]!.mergeStatus = "in-progress";
      const repository = createRepository(seeded);

      const recordedSnapshots: Array<{
        mergeStatus: string;
        pendingHaltReason: unknown;
      }> = [];
      const wrappedRepository = {
        ...repository,
        async mutateActive(
          projectPath: string,
          sessionName: string,
          fn: Parameters<typeof repository.mutateActive>[2],
        ) {
          const result = await repository.mutateActive(
            projectPath,
            sessionName,
            fn,
          );
          recordedSnapshots.push({
            mergeStatus:
              result.contextStates["context-implement"]?.mergeStatus ??
              "missing",
            pendingHaltReason: result.pendingHaltReason,
          });
          return result;
        },
      };

      const manager = createGraphWorkflowManager({
        executionRepository: wrappedRepository,
        async loadDefinition() {
          return null;
        },
      });

      const result = await manager.recordPendingHaltReason({
        projectPath: "/repo",
        sessionName: "session-1",
        reason: {
          type: "merge_failure",
          contextId: "context-implement",
          message: "merge failed",
          conflictFiles: [],
        },
        applyAdditionalMutation(execution) {
          const cs = execution.contextStates["context-implement"];
          if (cs) {
            cs.mergeStatus = "merged-failed";
            cs.lastMergeError = "merge failed";
          }
        },
      });

      expect(result.accepted).toBe(true);
      expect(recordedSnapshots).toHaveLength(1);
      expect(recordedSnapshots[0]).toEqual({
        mergeStatus: "merged-failed",
        pendingHaltReason: {
          type: "merge_failure",
          contextId: "context-implement",
          message: "merge failed",
          conflictFiles: [],
        },
      });
      expect(
        repository.read()?.contextStates["context-implement"]?.mergeStatus,
      ).toBe("merged-failed");
      expect(repository.read()?.pendingHaltReason).toEqual({
        type: "merge_failure",
        contextId: "context-implement",
        message: "merge failed",
        conflictFiles: [],
      });
    });

    it("applies applyAdditionalMutation even when first-failure-wins rejects the new reason (secondary failure path)", async () => {
      const seeded = createWorkflowExecution({
        status: "running",
        activeContextIds: ["context-plan", "context-implement"],
        pendingHaltReason: {
          type: "circuit_breaker",
          contextId: "context-plan",
          condition: "retry_exhaustion",
          summary: null,
        },
      });
      seeded.contextStates["context-plan"]!.mergeStatus = "in-progress";
      seeded.contextStates["context-implement"]!.mergeStatus = "in-progress";
      const repository = createRepository(seeded);
      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
      });

      const result = await manager.recordPendingHaltReason({
        projectPath: "/repo",
        sessionName: "session-1",
        reason: {
          type: "merge_failure",
          contextId: "context-implement",
          message: "second failure",
          conflictFiles: [],
        },
        applyAdditionalMutation(execution) {
          const cs = execution.contextStates["context-implement"];
          if (cs) {
            cs.mergeStatus = "merged-failed";
            cs.lastMergeError = "second failure";
          }
        },
      });

      expect(result.accepted).toBe(false);
      expect(result.execution.pendingHaltReason).toEqual({
        type: "circuit_breaker",
        contextId: "context-plan",
        condition: "retry_exhaustion",
        summary: null,
      });
      expect(
        result.execution.contextStates["context-implement"]?.mergeStatus,
      ).toBe("merged-failed");
      expect(
        result.execution.contextStates["context-implement"]?.lastMergeError,
      ).toBe("second failure");
    });
  });

  describe("drainAndHalt", () => {
    it("transitions the execution to halted using the recorded pendingHaltReason and clears the pending field", async () => {
      const repository = createRepository(
        createWorkflowExecution({
          status: "running",
          activeContextIds: ["context-implement"],
          pendingHaltReason: { type: "recovery_error", message: "drain" },
        }),
      );
      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
        now: () => "2026-04-02T11:11:11.000Z",
      });

      const result = await manager.drainAndHalt({
        projectPath: "/repo",
        sessionName: "session-1",
      });

      expect(result.status).toBe("halted");
      expect(result.haltReason).toEqual({
        type: "recovery_error",
        message: "drain",
      });
      expect(result.pendingHaltReason).toBeNull();
      expect(result.completedAt).toBe("2026-04-02T11:11:11.000Z");
      expect(repository.read()?.status).toBe("halted");
    });

    it("throws when there is no pendingHaltReason recorded", async () => {
      const repository = createRepository(
        createWorkflowExecution({
          status: "running",
          activeContextIds: ["context-implement"],
          pendingHaltReason: null,
        }),
      );
      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
      });

      await expect(
        manager.drainAndHalt({
          projectPath: "/repo",
          sessionName: "session-1",
        }),
      ).rejects.toThrow(/pendingHaltReason/);
      expect(repository.read()?.status).toBe("running");
    });

    it("throws when there is no active graph workflow execution", async () => {
      const repository = createRepository(null);
      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
      });

      await expect(
        manager.drainAndHalt({
          projectPath: "/repo",
          sessionName: "session-1",
        }),
      ).rejects.toThrow(
        "Session does not have an active graph workflow execution",
      );
    });
  });

  describe("start (shared start path)", () => {
    function makeStartSession(
      overrides: Partial<SessionState> = {},
    ): SessionState {
      return {
        sessionName: "session-1",
        worktreePath: "/repo/.worktrees/session-1",
        branchName: "csm/session-1",
        createdAt: "2026-03-27T12:00:00.000Z",
        lastActivityAt: "2026-03-27T12:00:00.000Z",
        archived: false,
        finished: false,
        conversations: [],
        source: "cc",
        creationMode: "normal",
        tddEnabled: true,
        targetBranch: "main",
        parentSessionName: null,
        graphWorkflowExecution: null,
        referenceDocuments: [],
        ...overrides,
      };
    }

    function startInput(parameters?: Record<string, unknown>) {
      return {
        projectPath: "/repo",
        sessionName: "session-1",
        definitionId: "workflow-1",
        ...(parameters !== undefined ? { parameters } : {}),
      };
    }

    it("seeds with empty inputs for a zero-input launch and runs the full guard chain", async () => {
      const definition = createWorkflowDefinitionRecord({ revision: 3 });
      const repository = createRepository();

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return definition;
        },
        getSession: async () => makeStartSession(),
        readSessionWorktreeDirtyPaths: async () => [],
        now: () => "2026-03-27T15:00:00.000Z",
        createExecutionId: () => "execution-started",
      });

      const execution = await manager.start(startInput());

      expect(execution.status).toBe("running");
      expect(repository.createCalls).toHaveLength(1);
      expect(repository.createCalls[0]?.inputs).toEqual({});
      expect(execution.boundInputs).toEqual({});
    });

    it("seeds with applied defaults for a valid parameterized launch", async () => {
      const definition = createWorkflowDefinitionRecord({
        definition: createWorkflowDefinition({
          parameters: [
            {
              type: "string",
              name: "ticket",
              label: "Ticket",
              required: true,
            },
            {
              type: "enum",
              name: "severity",
              label: "Severity",
              required: false,
              options: ["low", "high"],
              default: "low",
            },
          ],
        }),
      });
      const repository = createRepository();

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return definition;
        },
        getSession: async () => makeStartSession(),
        readSessionWorktreeDirtyPaths: async () => [],
      });

      const execution = await manager.start(startInput({ ticket: "CC-42" }));

      expect(repository.createCalls).toHaveLength(1);
      expect(repository.createCalls[0]?.inputs).toEqual({
        ticket: "CC-42",
        severity: "low",
      });
      expect(execution.boundInputs).toEqual({
        ticket: "CC-42",
        severity: "low",
      });
    });

    it("throws a non-terminal active-execution guard error and seeds nothing", async () => {
      const repository = createRepository(
        createWorkflowExecution({ id: "active-1", status: "running" }),
      );

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return createWorkflowDefinitionRecord();
        },
        getSession: async () => makeStartSession(),
        readSessionWorktreeDirtyPaths: async () => [],
      });

      await expect(manager.start(startInput())).rejects.toMatchObject({
        guard: "active_execution",
      });
      await expect(manager.start(startInput())).rejects.toThrow(
        'Session "session-1" already has an active graph workflow execution',
      );
      expect(repository.createCalls).toHaveLength(0);
      expect(repository.archiveCalls).toBe(0);
    });

    it("archives a terminal active execution then proceeds to seed", async () => {
      const repository = createRepository(
        createWorkflowExecution({
          id: "old-terminal",
          status: "completed",
          completedAt: "2026-03-27T13:00:00.000Z",
        }),
      );

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return createWorkflowDefinitionRecord();
        },
        getSession: async () => makeStartSession(),
        readSessionWorktreeDirtyPaths: async () => [],
        createExecutionId: () => "execution-new",
      });

      const execution = await manager.start(startInput());

      expect(repository.archiveCalls).toBe(1);
      expect(repository.createCalls).toHaveLength(1);
      expect(execution.id).toBe("execution-new");
      expect(execution.status).toBe("running");
    });

    it("throws an uncommitted-changes guard error carrying dirty paths and seeds nothing", async () => {
      const dirtyPaths: DirtyPath[] = [
        { path: "src/edited.ts", statusCode: " M", tracked: true },
        {
          path: ".kiro/specs/new/requirements.md",
          statusCode: "??",
          tracked: false,
        },
      ];
      const repository = createRepository();

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return createWorkflowDefinitionRecord();
        },
        getSession: async () => makeStartSession(),
        readSessionWorktreeDirtyPaths: async () => dirtyPaths,
      });

      let caught: unknown;
      try {
        await manager.start(startInput());
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(WorkflowStartGuardError);
      const guardError = caught as WorkflowStartGuardError;
      expect(guardError.guard).toBe("uncommitted_changes");
      expect(guardError.dirtyPaths).toEqual(dirtyPaths);
      expect(repository.createCalls).toHaveLength(0);
    });

    it("runs the dirty guard before loadDefinition so a dirty worktree wins over a missing definition", async () => {
      const dirtyPaths: DirtyPath[] = [
        { path: "src/edited.ts", statusCode: " M", tracked: true },
      ];
      const repository = createRepository();
      let loadDefinitionCalled = false;

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          loadDefinitionCalled = true;
          return null;
        },
        getSession: async () => makeStartSession(),
        readSessionWorktreeDirtyPaths: async () => dirtyPaths,
      });

      await expect(manager.start(startInput())).rejects.toMatchObject({
        guard: "uncommitted_changes",
      });
      expect(loadDefinitionCalled).toBe(false);
    });

    it("treats a thrown dirty-path probe as not-dirty and proceeds", async () => {
      const repository = createRepository();

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return createWorkflowDefinitionRecord();
        },
        getSession: async () => makeStartSession(),
        readSessionWorktreeDirtyPaths: async () => {
          throw new Error("git status failed");
        },
      });

      const execution = await manager.start(startInput());
      expect(execution.status).toBe("running");
      expect(repository.createCalls).toHaveLength(1);
    });

    it("throws the existing not-found error and seeds nothing for a missing definition", async () => {
      const repository = createRepository();

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
        getSession: async () => makeStartSession(),
        readSessionWorktreeDirtyPaths: async () => [],
      });

      await expect(manager.start(startInput())).rejects.toThrow(
        'Workflow definition "workflow-1" was not found',
      );
      expect(repository.createCalls).toHaveLength(0);
    });

    it("throws a WorkflowStartInputError naming the offending parameter and seeds nothing", async () => {
      const definition = createWorkflowDefinitionRecord({
        definition: createWorkflowDefinition({
          parameters: [
            {
              type: "string",
              name: "ticket",
              label: "Ticket",
              required: true,
            },
          ],
        }),
      });
      const repository = createRepository();

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return definition;
        },
        getSession: async () => makeStartSession(),
        readSessionWorktreeDirtyPaths: async () => [],
      });

      let caught: unknown;
      try {
        await manager.start(startInput({}));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(WorkflowStartInputError);
      const inputError = caught as WorkflowStartInputError;
      expect(inputError.inputError).toEqual({
        kind: "missing_required",
        name: "ticket",
      });
      expect(repository.createCalls).toHaveLength(0);
    });

    it("enforces guard order: active-execution before dirty before not-found", async () => {
      const repository = createRepository(
        createWorkflowExecution({ id: "active-1", status: "running" }),
      );
      let dirtyChecked = false;
      let loadDefinitionCalled = false;

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          loadDefinitionCalled = true;
          return null;
        },
        getSession: async () => makeStartSession(),
        readSessionWorktreeDirtyPaths: async () => {
          dirtyChecked = true;
          return [{ path: "src/edited.ts", statusCode: " M", tracked: true }];
        },
      });

      await expect(manager.start(startInput())).rejects.toMatchObject({
        guard: "active_execution",
      });
      expect(dirtyChecked).toBe(false);
      expect(loadDefinitionCalled).toBe(false);
    });

    describe("prerequisite gate", () => {
      function okPreflight(): PreflightPrerequisiteService {
        return { evaluate: async () => ({ status: "ok" }) };
      }

      it("throws a distinct WorkflowPrerequisitesUnmetError carrying the itemized missing items and seeds nothing (R6.2, R6.3)", async () => {
        const definition = createWorkflowDefinitionRecord();
        const repository = createRepository();
        let substitutionReached = false;

        const manager = createGraphWorkflowManager({
          executionRepository: repository,
          async loadDefinition() {
            return definition;
          },
          getSession: async () => makeStartSession(),
          readSessionWorktreeDirtyPaths: async () => [],
          readGlobalConfig: async () => ({}) as GlobalConfig,
          preflightService: {
            async evaluate() {
              return {
                status: "prerequisites_unmet",
                missing: [
                  {
                    kind: "path",
                    path: ".kiro",
                    label: null,
                    reason: "absent",
                  },
                  {
                    kind: "skill",
                    skill: "kiro-spec-init",
                    backend: "claude",
                    label: null,
                    reason: "probe_error",
                  },
                ],
              };
            },
          },
          // A throwing input validator would prove the gate ran before
          // start-input validation/substitution if it were reached.
          createExecutionId: () => {
            substitutionReached = true;
            return "should-not-seed";
          },
        });

        let caught: unknown;
        try {
          await manager.start(startInput());
        } catch (error) {
          caught = error;
        }

        expect(caught).toBeInstanceOf(WorkflowPrerequisitesUnmetError);
        const prereqError = caught as WorkflowPrerequisitesUnmetError;
        expect(prereqError.missing).toHaveLength(2);
        expect(prereqError.missing[0]).toMatchObject({
          kind: "path",
          path: ".kiro",
          reason: "absent",
        });
        expect(prereqError.missing[1]).toMatchObject({
          kind: "skill",
          skill: "kiro-spec-init",
          backend: "claude",
          reason: "probe_error",
        });
        // Nothing seeded; substitution/seed never reached.
        expect(repository.createCalls).toHaveLength(0);
        expect(repository.read()).toBeNull();
        expect(substitutionReached).toBe(false);
      });

      it("is distinguishable from active-execution, uncommitted-changes, not-found, and missing-input rejections (R6.2)", async () => {
        const prereqError = new WorkflowPrerequisitesUnmetError([], "unmet");
        expect(prereqError).toBeInstanceOf(WorkflowPrerequisitesUnmetError);
        expect(prereqError).not.toBeInstanceOf(WorkflowStartGuardError);
        expect(prereqError).not.toBeInstanceOf(WorkflowStartInputError);
        expect(prereqError).not.toBeInstanceOf(WorkflowDefinitionNotFoundError);
        expect(prereqError.name).toBe("WorkflowPrerequisitesUnmetError");
      });

      it("halts a multi-backend workflow whose validator lacks a skill on its OWN backend — checked against the resolved used-backend set, not a single launch backend", async () => {
        // ctx-1: claude implementer. ctx-2: claude implementer + an enabled
        // CODEX validator. The resolved used-backend set is {claude, codex}.
        // The crafted preflight reports unmet ONLY when "codex" is in the set —
        // a single-assumed-launch-backend (claude only) gate would false-pass.
        const definition = createWorkflowDefinitionRecord({
          definition: createWorkflowDefinition({
            executionContexts: [
              {
                id: "ctx-1",
                title: "One",
                acceptanceCriteria: "ok",
                implementer: {
                  backend: "claude",
                  model: "opus",
                  reasoningEffort: "medium",
                },
                mutability: { allowAgentTaskAdd: false },
                circuitBreaker: {},
                iterationPolicy: {
                  maxIterations: 2,
                  continuity: { enabled: true },
                },
              },
              {
                id: "ctx-2",
                title: "Two",
                acceptanceCriteria: "ok",
                implementer: {
                  backend: "claude",
                  model: "opus",
                  reasoningEffort: "medium",
                },
                contextValidator: {
                  kind: "use",
                  value: {
                    type: "codex",
                    enabled: true,
                    continuity: { enabled: true },
                    codex: {},
                  },
                },
                mutability: { allowAgentTaskAdd: false },
                circuitBreaker: {},
                iterationPolicy: {
                  maxIterations: 2,
                  continuity: { enabled: true },
                },
              },
            ],
            tasks: [
              {
                id: "t1",
                contextId: "ctx-1",
                order: 1,
                title: "a",
                instructions: "a",
                source: "user",
              },
              {
                id: "t2",
                contextId: "ctx-2",
                order: 1,
                title: "b",
                instructions: "b",
                source: "user",
              },
            ],
            edges: [
              {
                id: "e1",
                sourceContextId: "ctx-1",
                targetContextId: "ctx-2",
              },
            ],
          }),
        });
        const repository = createRepository();
        let receivedBackends: AgentBackendId[] = [];

        const manager = createGraphWorkflowManager({
          executionRepository: repository,
          async loadDefinition() {
            return definition;
          },
          getSession: async () => makeStartSession(),
          readSessionWorktreeDirtyPaths: async () => [],
          readGlobalConfig: async () => ({}) as GlobalConfig,
          preflightService: {
            async evaluate({ usedBackends }) {
              receivedBackends = [...usedBackends].sort();
              if (usedBackends.has("codex")) {
                return {
                  status: "prerequisites_unmet",
                  missing: [
                    {
                      kind: "skill",
                      skill: "needed-on-codex",
                      backend: null,
                      label: null,
                      reason: "absent",
                    },
                  ],
                };
              }
              return { status: "ok" };
            },
          },
        });

        await expect(manager.start(startInput())).rejects.toBeInstanceOf(
          WorkflowPrerequisitesUnmetError,
        );
        expect(receivedBackends).toEqual(["claude", "codex"]);
        expect(repository.createCalls).toHaveLength(0);
      });

      it("proceeds to seed unchanged when the prerequisite gate returns ok", async () => {
        const definition = createWorkflowDefinitionRecord({ revision: 7 });
        const repository = createRepository();

        const manager = createGraphWorkflowManager({
          executionRepository: repository,
          async loadDefinition() {
            return definition;
          },
          getSession: async () => makeStartSession(),
          readSessionWorktreeDirtyPaths: async () => [],
          readGlobalConfig: async () => ({}) as GlobalConfig,
          preflightService: okPreflight(),
          createExecutionId: () => "execution-ok",
        });

        const execution = await manager.start(startInput());

        expect(execution.status).toBe("running");
        expect(execution.id).toBe("execution-ok");
        expect(repository.createCalls).toHaveLength(1);
      });

      it("reports a dirty worktree BEFORE a missing prerequisite (gate sits after the dirty guard)", async () => {
        const repository = createRepository();
        let preflightCalled = false;

        const manager = createGraphWorkflowManager({
          executionRepository: repository,
          async loadDefinition() {
            return createWorkflowDefinitionRecord();
          },
          getSession: async () => makeStartSession(),
          readSessionWorktreeDirtyPaths: async () => [
            { path: "src/edited.ts", statusCode: " M", tracked: true },
          ],
          readGlobalConfig: async () => ({}) as GlobalConfig,
          preflightService: {
            async evaluate() {
              preflightCalled = true;
              return {
                status: "prerequisites_unmet",
                missing: [
                  {
                    kind: "path",
                    path: ".kiro",
                    label: null,
                    reason: "absent",
                  },
                ],
              };
            },
          },
        });

        await expect(manager.start(startInput())).rejects.toMatchObject({
          guard: "uncommitted_changes",
        });
        expect(preflightCalled).toBe(false);
        expect(repository.createCalls).toHaveLength(0);
      });

      it("does not probe a zero-prerequisite template — the real service short-circuits to ok with no probing (R5.7)", async () => {
        // No injected preflightService → the manager uses the real
        // createPreflightPrerequisiteService(), which short-circuits an empty
        // prerequisites array to { status: "ok" } without invoking any probe.
        const definition = createWorkflowDefinitionRecord();
        expect(definition.definition.prerequisites).toEqual([]);
        const repository = createRepository();

        const manager = createGraphWorkflowManager({
          executionRepository: repository,
          async loadDefinition() {
            return definition;
          },
          getSession: async () => makeStartSession(),
          readSessionWorktreeDirtyPaths: async () => [],
          readGlobalConfig: async () => ({}) as GlobalConfig,
          createExecutionId: () => "execution-zero-prereq",
        });

        const execution = await manager.start(startInput());

        expect(execution.status).toBe("running");
        expect(repository.createCalls).toHaveLength(1);
      });

      it("throws a distinct WorkflowDefinitionNotFoundError naming the tier when the template is absent (R3.4)", async () => {
        const repository = createRepository();

        const manager = createGraphWorkflowManager({
          executionRepository: repository,
          async loadDefinition() {
            return null;
          },
          getSession: async () => makeStartSession(),
          readSessionWorktreeDirtyPaths: async () => [],
        });

        let caught: unknown;
        try {
          await manager.start({ ...startInput(), tier: "global" });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(WorkflowDefinitionNotFoundError);
        const notFound = caught as WorkflowDefinitionNotFoundError;
        expect(notFound.tier).toBe("global");
        expect(notFound.definitionId).toBe("workflow-1");
        expect(notFound.message).toBe(
          'Workflow definition "workflow-1" was not found',
        );
        expect(repository.createCalls).toHaveLength(0);
      });
    });

    // gwt 6.2 — end-to-end cross-tier launch + prerequisite gating exercised
    // through the REAL preflight service (no injected preflightService) against
    // a REAL temporary session worktree, so the whole chain — used-backend
    // resolution, the path/skill probes, the gate, and the seed — runs as it
    // does in production. The example prerequisites (a `.kiro/` path + a
    // missing skill) are fixtures only; gating is asserted to be identical for
    // a differently-identified template, proving no behavior is conditioned on
    // a specific workflow identity (R9.2, R9.4).
    describe("prerequisite gating, end-to-end via the real preflight service (gwt 6.2)", () => {
      let worktreePath: string;

      beforeEach(async () => {
        worktreePath = await mkdtemp(nodePath.join(tmpdir(), "cc-gwt-62-"));
      });

      afterEach(async () => {
        await rm(worktreePath, { recursive: true, force: true });
      });

      function definitionWithPrerequisites(
        prerequisites: WorkflowSemanticDefinition["prerequisites"],
        overrides: Partial<WorkflowDefinitionRecord> = {},
      ): WorkflowDefinitionRecord {
        return createWorkflowDefinitionRecord({
          definition: createWorkflowDefinition({ prerequisites }),
          ...overrides,
        });
      }

      function managerFor(
        definition: WorkflowDefinitionRecord,
        repository: ReturnType<typeof createRepository>,
      ) {
        // No preflightService override → the manager builds the real
        // createPreflightPrerequisiteService(), which runs the real fs path
        // probe and the real skill-discovery probe against `worktreePath`.
        return createGraphWorkflowManager({
          executionRepository: repository,
          async loadDefinition() {
            return definition;
          },
          getSession: async () => makeStartSession({ worktreePath }),
          readSessionWorktreeDirtyPaths: async () => [],
          readGlobalConfig: async () => ({}) as GlobalConfig,
          now: () => "2026-03-27T15:00:00.000Z",
          createExecutionId: () => "execution-62",
        });
      }

      it("halts a launch whose declared .kiro path and skill are both absent in the worktree — itemized, nothing seeded, no tokens spent (R5.5, R6.3)", async () => {
        const definition = definitionWithPrerequisites([
          { kind: "path", path: ".kiro/specs", label: "Kiro specs" },
          {
            kind: "skill",
            skill: "definitely-missing-skill-xyz",
            backend: "claude",
            label: "A required skill",
          },
        ]);
        const repository = createRepository();
        const manager = managerFor(definition, repository);

        let caught: unknown;
        try {
          await manager.start(startInput());
        } catch (error) {
          caught = error;
        }

        expect(caught).toBeInstanceOf(WorkflowPrerequisitesUnmetError);
        const missing = (caught as WorkflowPrerequisitesUnmetError).missing;
        expect(missing).toContainEqual(
          expect.objectContaining({
            kind: "path",
            path: ".kiro/specs",
            reason: "absent",
          }),
        );
        // The skill probe reuses the real runtime discovery; the fixture skill
        // is not discoverable, so it is reported unmet (absent or, if discovery
        // itself errors, the fail-closed probe_error — never satisfied).
        expect(missing).toContainEqual(
          expect.objectContaining({
            kind: "skill",
            skill: "definitely-missing-skill-xyz",
            backend: "claude",
          }),
        );
        // Halted before substitution/seed: no execution, conversation, or agent
        // turn — the gate spends no tokens.
        expect(repository.createCalls).toHaveLength(0);
        expect(repository.read()).toBeNull();
      });

      it("launches the SAME template once the declared path exists — recording the launched tier, through the unchanged engine (satisfy → launch)", async () => {
        const definition = definitionWithPrerequisites([
          { kind: "path", path: ".kiro/specs", label: "Kiro specs" },
        ]);

        // Unmet: the path is absent → the real gate halts and seeds nothing.
        const beforeRepo = createRepository();
        await expect(
          managerFor(definition, beforeRepo).start(startInput()),
        ).rejects.toBeInstanceOf(WorkflowPrerequisitesUnmetError);
        expect(beforeRepo.createCalls).toHaveLength(0);

        // Satisfy the prerequisite by creating the declared worktree-relative
        // path, then launch the same template from the GLOBAL tier.
        await mkdir(nodePath.join(worktreePath, ".kiro", "specs"), {
          recursive: true,
        });
        const afterRepo = createRepository();
        const execution = await managerFor(definition, afterRepo).start({
          ...startInput(),
          tier: "global",
        });

        expect(execution.status).toBe("running");
        expect(execution.launchedTier).toBe("global");
        expect(afterRepo.createCalls).toHaveLength(1);
        expect(afterRepo.createCalls[0]?.launchedTier).toBe("global");
        // launchedTier is recorded on the seeded execution read back from the
        // repository, proving the audit annotation survives the seed.
        expect(afterRepo.read()?.launchedTier).toBe("global");
      });

      it("applies identical gating to a differently-identified template — no behavior conditioned on workflow identity (R9.2, R9.4)", async () => {
        const otherDefinition = definitionWithPrerequisites(
          [{ kind: "path", path: ".kiro/specs", label: "Kiro specs" }],
          { id: "unrelated-flow-9", name: "Totally Different Flow" },
        );

        // Same unmet → halt, nothing seeded — for a template with a distinct
        // id and name.
        const beforeRepo = createRepository();
        await expect(
          managerFor(otherDefinition, beforeRepo).start({
            ...startInput(),
            definitionId: "unrelated-flow-9",
          }),
        ).rejects.toBeInstanceOf(WorkflowPrerequisitesUnmetError);
        expect(beforeRepo.createCalls).toHaveLength(0);

        // Same satisfy → launch transition, identical outcome.
        await mkdir(nodePath.join(worktreePath, ".kiro", "specs"), {
          recursive: true,
        });
        const afterRepo = createRepository();
        const execution = await managerFor(otherDefinition, afterRepo).start({
          ...startInput(),
          definitionId: "unrelated-flow-9",
        });

        expect(execution.status).toBe("running");
        expect(afterRepo.createCalls).toHaveLength(1);
        expect(afterRepo.createCalls[0]?.definitionId).toBe("unrelated-flow-9");
      });
    });
  });
});
