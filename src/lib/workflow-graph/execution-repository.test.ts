import path from "node:path";
import { describe, expect, it } from "vitest";
import type { GlobalConfig } from "@/lib/config/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
import { computeCharterHash } from "./charter/render";
import { createWorkflowCharterService } from "./charter/service";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
import {
  GraphWorkflowValidationError,
  createGraphWorkflowExecutionRepository,
} from "./execution-repository";
import { LegacyWorkflowSchemaError } from "./schema-cutover-guard";
import { createWorkflowDefinition } from "./test-fixtures";
import type {
  GraphWorkflowExecutionEvent,
  GraphWorkflowSSEEvent,
  WorkflowSemanticDefinition,
} from "@/lib/workflows/schemas";

const WORKTREE_PATH = "/repo/.worktrees/session-1";

function makeSession(): SessionState {
  return {
    worktreePath: WORKTREE_PATH,
    graphWorkflowExecution: null,
  } as unknown as SessionState;
}

interface CapturedWrite {
  absolutePath: string;
  contents: string;
}

function createInMemoryRepo(config: GlobalConfig = {} as GlobalConfig) {
  const sessions = new Map<string, SessionState>();
  const broadcasts: GraphWorkflowSSEEvent[] = [];
  const writes: CapturedWrite[] = [];

  // Real event publisher with a capturing broadcast, and a real charter
  // service with an injected capturing fs — so create() exercises the real
  // seed-propagation path (snapshot + kind:"charter" doc + charter-registered
  // event) without touching the disk.
  const eventPublisher = createGraphWorkflowExecutionEventPublisher({
    broadcast(event) {
      broadcasts.push(event);
    },
  });
  const charterService = createWorkflowCharterService({
    writeFile: async (absolutePath, contents) => {
      writes.push({ absolutePath, contents: String(contents) });
    },
    ensureDir: async () => {},
    publishCharterRegistered: eventPublisher.publishCharterRegistered,
  });

  const appendedEvents: GraphWorkflowExecutionEvent[] = [];
  const mutateCalls: string[] = [];

  function getOrCreateSession(projectPath: string, sessionName: string) {
    const key = `${projectPath}:${sessionName}`;
    let session = sessions.get(key);
    if (!session) {
      session = makeSession();
      sessions.set(key, session);
    }
    return session;
  }

  const repo = createGraphWorkflowExecutionRepository({
    async getSession(projectPath, sessionName) {
      return getOrCreateSession(projectPath, sessionName);
    },
    async getActiveGraphWorkflowExecution(projectPath, sessionName) {
      return getOrCreateSession(projectPath, sessionName)
        .graphWorkflowExecution;
    },
    async mutateActiveGraphWorkflowExecution(
      projectPath,
      sessionName,
      label,
      mutate,
    ) {
      mutateCalls.push(label);
      const session = getOrCreateSession(projectPath, sessionName);
      const { execution, events } = await mutate(
        session.graphWorkflowExecution,
      );
      session.graphWorkflowExecution = execution;
      appendedEvents.push(...events);
      return execution;
    },
    async archiveActiveGraphWorkflowExecution(projectPath, sessionName) {
      const session = getOrCreateSession(projectPath, sessionName);
      session.graphWorkflowExecution = null;
    },
    async markGraphWorkflowContextEventsPreReset() {
      return 0;
    },
    eventPublisher,
    charterService,
    readConfig: async () => config,
  });

  return { repo, sessions, broadcasts, writes, appendedEvents, mutateCalls };
}

describe("createGraphWorkflowExecutionRepository.create", () => {
  it("rejects a seed definition that contains contextSoftLimitTokens", async () => {
    const { repo } = createInMemoryRepo();
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
        inputs: {},
        launchedTier: "project",
      }),
    ).rejects.toThrow(LegacyWorkflowSchemaError);
  });

  it("rejects a seed definition that contains contextHardLimitTokens", async () => {
    const { repo } = createInMemoryRepo();
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
        inputs: {},
        launchedTier: "project",
      }),
    ).rejects.toThrow(LegacyWorkflowSchemaError);
  });

  it("creates an execution successfully for a valid definition", async () => {
    const { repo } = createInMemoryRepo();
    const execution = await repo.create("/repo", "session-1", {
      definition: createWorkflowDefinition(),
      definitionId: "wf-1",
      definitionRevision: 1,
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: {},
      launchedTier: "project",
    });

    expect(execution.id).toBe("exec-1");
    expect(execution.status).toBe("pending");
  });

  it("seeds the lane plan from the resolved working definition at creation time", async () => {
    const { repo } = createInMemoryRepo();
    const execution = await repo.create("/repo", "session-1", {
      definition: createWorkflowDefinition(),
      definitionId: "wf-1",
      definitionRevision: 1,
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: {},
      launchedTier: "project",
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
    const { repo } = createInMemoryRepo();
    const execution = await repo.create("/repo", "session-1", {
      definition: createWorkflowDefinition(),
      definitionId: "wf-1",
      definitionRevision: 1,
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: {},
      launchedTier: "project",
    });

    expect(execution.activeContextIds).toEqual([]);
    expect(execution.haltReason).toBeNull();
    expect(execution.completedAt).toBeNull();
    // The charter document is seeded at create, so the only shared document is
    // the reserved kind:"charter" entry.
    expect(execution.sharedDocuments).toHaveLength(1);
    expect(execution.sharedDocuments[0]?.kind).toBe("charter");
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
        pendingUserInput: null,
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
    const { repo } = createInMemoryRepo();
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
      inputs: {},
      launchedTier: "project",
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
    const { repo } = createInMemoryRepo();
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
      inputs: {},
      launchedTier: "project",
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
    const { repo } = createInMemoryRepo();
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
        inputs: {},
        launchedTier: "project",
      }),
    ).rejects.toBeInstanceOf(GraphWorkflowValidationError);
  });
});

describe("createGraphWorkflowExecutionRepository.create charter seed propagation", () => {
  it("stores an execution whose charter snapshot is set and whose shared documents include a kind:'charter' entry", async () => {
    const { repo, sessions } = createInMemoryRepo();
    const definition = createWorkflowDefinition({ charter: makeTestCharter() });

    await repo.create("/repo", "session-1", {
      definition,
      definitionId: "wf-1",
      definitionRevision: 1,
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: {},
      launchedTier: "project",
    });

    const stored = sessions.get("/repo:session-1")?.graphWorkflowExecution;
    expect(stored).not.toBeNull();
    expect(stored?.charter).toEqual(definition.charter);

    const charterEntries =
      stored?.sharedDocuments.filter((entry) => entry.kind === "charter") ?? [];
    expect(charterEntries).toHaveLength(1);
    expect(charterEntries[0]?.relativePath).toBe(
      ".cc/graph-workflow-docs/charter.md",
    );
  });

  it("writes charter.md inside the session worktree only", async () => {
    const { repo, writes } = createInMemoryRepo();

    await repo.create("/repo", "session-1", {
      definition: createWorkflowDefinition(),
      definitionId: "wf-1",
      definitionRevision: 1,
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: {},
      launchedTier: "project",
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.absolutePath).toBe(
      path.join(WORKTREE_PATH, ".cc", "graph-workflow-docs", "charter.md"),
    );
  });

  it("records and broadcasts a charter-registered event carrying the charter hash", async () => {
    const charter = makeTestCharter();
    const { repo, broadcasts, appendedEvents } = createInMemoryRepo();

    await repo.create("/repo", "session-1", {
      definition: createWorkflowDefinition({ charter }),
      definitionId: "wf-1",
      definitionRevision: 2,
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: {},
      launchedTier: "project",
    });

    const charterBroadcast = broadcasts.find(
      (event) => event.type === "graph-workflow-charter-registered",
    );
    expect(charterBroadcast).toBeDefined();
    expect(charterBroadcast).toMatchObject({
      executionId: "exec-1",
      definitionId: "wf-1",
      definitionRevision: 2,
      charterHash: computeCharterHash(charter),
    });

    const registeredEvent = appendedEvents.find(
      (entry) => entry.event.type === "graph-workflow-charter-registered",
    );
    expect(registeredEvent).toBeDefined();
  });

  it("throws when the session has no worktree path", async () => {
    const { repo, sessions } = createInMemoryRepo();
    sessions.set("/repo:session-1", {
      worktreePath: "",
      graphWorkflowExecution: null,
    } as unknown as SessionState);

    await expect(
      repo.create("/repo", "session-1", {
        definition: createWorkflowDefinition(),
        definitionId: "wf-1",
        definitionRevision: 1,
        executionId: "exec-1",
        startedAt: "2026-04-04T00:00:00.000Z",
        inputs: {},
        launchedTier: "project",
      }),
    ).rejects.toThrow(/worktree/);
  });
});

describe("createGraphWorkflowExecutionRepository.create parameter substitution", () => {
  it("substitutes bound inputs into content + charter and persists boundInputs (R4.7, R6.1)", async () => {
    const { repo, sessions } = createInMemoryRepo();
    const baseline = createWorkflowDefinition();
    const definition: WorkflowSemanticDefinition = {
      ...baseline,
      parameters: [
        {
          name: "feature",
          label: "Feature",
          type: "string",
          required: true,
        },
        {
          name: "ac",
          label: "Acceptance criteria",
          type: "text",
          required: true,
        },
      ],
      charter: makeTestCharter({ mission: "Deliver {{inputs.feature}}" }),
      executionContexts: [
        {
          ...baseline.executionContexts[0]!,
          acceptanceCriteria: "{{inputs.ac}}",
        },
        ...baseline.executionContexts.slice(1),
      ],
    };

    const inputs = {
      feature: "the payments flow",
      ac: "All payment paths covered",
    };

    const execution = await repo.create("/repo", "session-1", {
      definition,
      definitionId: "wf-1",
      definitionRevision: 1,
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs,
      launchedTier: "project",
    });

    expect(execution.charter.mission).toBe("Deliver the payments flow");
    expect(execution.charter.mission).not.toContain("{{inputs.");

    const planContext = execution.workingDefinition.executionContexts.find(
      (context) => context.id === "context-plan",
    );
    expect(planContext?.acceptanceCriteria).toBe("All payment paths covered");

    const serialized = JSON.stringify(execution.workingDefinition);
    expect(serialized).not.toContain("{{inputs.");

    expect(execution.boundInputs).toEqual(inputs);

    const stored = sessions.get("/repo:session-1")?.graphWorkflowExecution;
    expect(stored?.boundInputs).toEqual(inputs);
  });

  it("seeds nothing when substitution empties required content (R5.2, R5.3)", async () => {
    const { repo, mutateCalls } = createInMemoryRepo();
    const baseline = createWorkflowDefinition();
    const definition: WorkflowSemanticDefinition = {
      ...baseline,
      parameters: [
        {
          name: "ac",
          label: "Acceptance criteria",
          type: "text",
          required: false,
        },
      ],
      executionContexts: [
        {
          ...baseline.executionContexts[0]!,
          acceptanceCriteria: "{{inputs.ac}}",
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
        inputs: { ac: "   " },
        launchedTier: "project",
      }),
    ).rejects.toBeInstanceOf(GraphWorkflowValidationError);

    expect(mutateCalls.length).toBe(0);
  });

  it("seeds successfully when a bound value contains a literal {{...}} (R5.5)", async () => {
    const { repo } = createInMemoryRepo();
    const baseline = createWorkflowDefinition();
    const definition: WorkflowSemanticDefinition = {
      ...baseline,
      parameters: [
        {
          name: "ci",
          label: "CI matrix expression",
          type: "string",
          required: true,
        },
      ],
      executionContexts: [
        {
          ...baseline.executionContexts[0]!,
          acceptanceCriteria: "Runs on {{inputs.ci}}",
        },
        ...baseline.executionContexts.slice(1),
      ],
    };

    const literal = "${{ matrix.os }} and a brief mentioning {{inputs.y}}";

    const execution = await repo.create("/repo", "session-1", {
      definition,
      definitionId: "wf-1",
      definitionRevision: 1,
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: { ci: literal },
      launchedTier: "project",
    });

    const planContext = execution.workingDefinition.executionContexts.find(
      (context) => context.id === "context-plan",
    );
    expect(planContext?.acceptanceCriteria).toBe(`Runs on ${literal}`);
    expect(planContext?.acceptanceCriteria).toContain("${{ matrix.os }}");
    expect(planContext?.acceptanceCriteria).toContain("{{inputs.y}}");
  });

  it("seeds a static definition with empty boundInputs (R6.5)", async () => {
    const { repo } = createInMemoryRepo();

    const execution = await repo.create("/repo", "session-1", {
      definition: createWorkflowDefinition(),
      definitionId: "wf-1",
      definitionRevision: 1,
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: {},
      launchedTier: "project",
    });

    expect(execution.boundInputs).toEqual({});
    expect(execution.status).toBe("pending");
  });

  it("snapshots the seed's launchedTier onto the execution, parallel to boundInputs (R3.3)", async () => {
    const { repo, sessions } = createInMemoryRepo();

    const execution = await repo.create("/repo", "session-1", {
      definition: createWorkflowDefinition(),
      definitionId: "wf-1",
      definitionRevision: 1,
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: {},
      launchedTier: "global",
    });

    expect(execution.launchedTier).toBe("global");

    const stored = sessions.get("/repo:session-1")?.graphWorkflowExecution;
    expect(stored?.launchedTier).toBe("global");
  });
});
