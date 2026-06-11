import { describe, expect, it } from "vitest";
import type { GlobalConfig } from "@/lib/config/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import {
  GraphWorkflowValidationError,
  createGraphWorkflowExecutionRepository,
} from "./execution-repository";
import { LegacyWorkflowSchemaError } from "./schema-cutover-guard";
import { createWorkflowDefinition } from "./test-fixtures";

function makeSession(): SessionState {
  return {
    graphWorkflowExecution: null,
    graphWorkflowExecutionHistory: [],
  } as unknown as SessionState;
}

function createInMemoryRepo(config: GlobalConfig = {} as GlobalConfig) {
  const sessions = new Map<string, SessionState>();

  return createGraphWorkflowExecutionRepository({
    async getSession(projectPath, sessionName) {
      return sessions.get(`${projectPath}:${sessionName}`) ?? null;
    },
    async mutateSession(projectPath, sessionName, _label, mutate) {
      let session = sessions.get(`${projectPath}:${sessionName}`);
      if (!session) {
        session = makeSession();
        sessions.set(`${projectPath}:${sessionName}`, session);
      }
      return mutate(session);
    },
    readConfig: async () => config,
  });
}

describe("createGraphWorkflowExecutionRepository.create", () => {
  it("rejects a seed definition that contains contextSoftLimitTokens", async () => {
    const repo = createInMemoryRepo();
    const legacyDefinition = {
      ...createWorkflowDefinition(),
      executionContexts: [
        {
          id: "ctx-1",
          title: "Plan",
          acceptanceCriteria: "Plan is documented",
          agent: { backend: "claude", model: "opus", reasoningEffort: "high" },
          mutability: { allowAgentTaskAdd: false },
          circuitBreaker: {},
          iterationPolicy: {
            maxIterations: 5,
            contextSoftLimitTokens: 100000,
          },
        },
      ],
    };

    await expect(
      repo.create("/repo", "session-1", {
        definition: legacyDefinition as never,
        definitionId: "wf-1",
        definitionRevision: 1,
        executionId: "exec-1",
        startedAt: "2026-04-04T00:00:00.000Z",
      }),
    ).rejects.toThrow(LegacyWorkflowSchemaError);
  });

  it("rejects a seed definition that contains contextHardLimitTokens", async () => {
    const repo = createInMemoryRepo();
    const legacyDefinition = {
      ...createWorkflowDefinition(),
      executionContexts: [
        {
          id: "ctx-1",
          title: "Plan",
          acceptanceCriteria: "Plan is documented",
          agent: { backend: "claude", model: "opus", reasoningEffort: "high" },
          mutability: { allowAgentTaskAdd: false },
          circuitBreaker: {},
          iterationPolicy: {
            maxIterations: 5,
            contextHardLimitTokens: 150000,
          },
        },
      ],
    };

    await expect(
      repo.create("/repo", "session-1", {
        definition: legacyDefinition as never,
        definitionId: "wf-1",
        definitionRevision: 1,
        executionId: "exec-1",
        startedAt: "2026-04-04T00:00:00.000Z",
      }),
    ).rejects.toThrow(LegacyWorkflowSchemaError);
  });

  it("creates an execution successfully for a valid definition", async () => {
    const repo = createInMemoryRepo();
    const execution = await repo.create("/repo", "session-1", {
      definition: createWorkflowDefinition(),
      definitionId: "wf-1",
      definitionRevision: 1,
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
    });

    expect(execution.id).toBe("exec-1");
    expect(execution.status).toBe("pending");
  });

  it("seeds the lane plan from the resolved working definition at creation time", async () => {
    const repo = createInMemoryRepo();
    const execution = await repo.create("/repo", "session-1", {
      definition: createWorkflowDefinition(),
      definitionId: "wf-1",
      definitionRevision: 1,
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
    });

    expect(execution.lanePlan.continuationMap).toEqual({
      "context-plan": "context-implement",
      "context-implement": "context-verify",
    });
    expect(execution.lanePlan.longestDownstreamPath).toEqual({
      "context-plan": 2,
      "context-implement": 1,
      "context-verify": 0,
    });
  });

  it("initializes context and task state to execution-start defaults", async () => {
    const repo = createInMemoryRepo();
    const execution = await repo.create("/repo", "session-1", {
      definition: createWorkflowDefinition(),
      definitionId: "wf-1",
      definitionRevision: 1,
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
    });

    expect(execution.activeContextIds).toEqual([]);
    expect(execution.haltReason).toBeNull();
    expect(execution.completedAt).toBeNull();
    expect(execution.sharedDocuments).toEqual([]);
    expect(execution.laneStates).toEqual({});
    expect(execution.machineSnapshot).toBeNull();

    for (const context of execution.workingDefinition.executionContexts) {
      const state = execution.contextStates[context.id];
      expect(state).toEqual({
        contextId: context.id,
        status: "pending",
        totalTaskCount: execution.workingDefinition.tasks.filter(
          (task) => task.contextId === context.id,
        ).length,
        completedTaskCount: 0,
        iterationCount: 0,
        consecutiveFailureCount: 0,
        worktreePath: null,
        branchName: null,
        batchId: null,
        isolation: "session",
        laneId: null,
        joinId: null,
        mergeStatus: "not-applicable",
        cleanupStatus: "not-applicable",
        lastMergeError: null,
        pendingApproval: null,
      });
    }

    for (const task of execution.workingDefinition.tasks) {
      expect(execution.taskStates[task.id]).toEqual({
        taskId: task.id,
        contextId: task.contextId,
        order: task.order,
        status: "pending",
        summary: null,
        startedAt: null,
        completedAt: null,
        lastConversationId: null,
        failureMessage: null,
        failureHistory: [],
      });
    }
  });

  it("stores a resolved workingDefinition with implementer populated even when the input omits it", async () => {
    const repo = createInMemoryRepo();
    const baseline = createWorkflowDefinition();
    const definition = {
      ...baseline,
      executionContexts: baseline.executionContexts.map((context) => {
        const { implementer: _implementer, ...rest } = context;
        return rest;
      }),
    };

    const execution = await repo.create("/repo", "session-1", {
      definition,
      definitionId: "wf-1",
      definitionRevision: 1,
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
    });

    for (const context of execution.workingDefinition.executionContexts) {
      expect(context.implementer).toEqual({
        backend: "claude",
        model: "opus",
        reasoningEffort: "medium",
      });
    }
  });

  it("populates contextValidator from seeded defaults and leaves disabled overrides as null", async () => {
    const repo = createInMemoryRepo();
    const baseline = createWorkflowDefinition();
    const definition = {
      ...baseline,
      executionContexts: [
        baseline.executionContexts[0]!,
        {
          ...baseline.executionContexts[1]!,
          contextValidator: { kind: "disabled" as const },
        },
        baseline.executionContexts[2]!,
      ],
    };

    const execution = await repo.create("/repo", "session-1", {
      definition,
      definitionId: "wf-1",
      definitionRevision: 1,
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
    });

    const byId = Object.fromEntries(
      execution.workingDefinition.executionContexts.map((context) => [
        context.id,
        context,
      ]),
    );

    expect(byId["context-plan"]?.contextValidator).not.toBeNull();
    expect(byId["context-verify"]?.contextValidator).not.toBeNull();
    expect(byId["context-implement"]?.contextValidator).toBeNull();
  });

  it("throws GraphWorkflowValidationError when resolved implementer uses an unsupported reasoning effort", async () => {
    const repo = createInMemoryRepo();
    const baseline = createWorkflowDefinition();
    const definition = {
      ...baseline,
      executionContexts: [
        {
          ...baseline.executionContexts[0]!,
          implementer: {
            backend: "codex" as const,
            model: "gpt-5.4" as const,
            reasoningEffort: "minimal" as const,
          },
        },
        ...baseline.executionContexts.slice(1),
      ],
    };

    await expect(
      repo.create("/repo", "session-1", {
        definition,
        definitionId: "wf-1",
        definitionRevision: 1,
        executionId: "exec-1",
        startedAt: "2026-04-04T00:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(GraphWorkflowValidationError);
  });
});
