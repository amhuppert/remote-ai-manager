import { describe, expect, it } from "vitest";
import type { SessionState } from "@/types";
import { createGraphWorkflowExecutionRepository } from "./execution-repository";
import { LegacyWorkflowSchemaError } from "./schema-cutover-guard";
import { createWorkflowDefinition } from "./test-fixtures";

function makeSession(): SessionState {
  return {
    graphWorkflowExecution: null,
    graphWorkflowExecutionHistory: [],
  } as unknown as SessionState;
}

function createInMemoryRepo() {
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
          agent: { model: "opus", reasoningEffort: "high" },
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
          agent: { model: "opus", reasoningEffort: "high" },
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
});
