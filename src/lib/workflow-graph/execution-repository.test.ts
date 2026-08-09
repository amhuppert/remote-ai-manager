import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { GlobalConfig, PerRepoConfig } from "@/lib/config/schemas";
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
import { SEEDED_WORKFLOW_DEFAULTS } from "./resolve-config";
import { StaleLoopFenceError, runWithLoopFence } from "./loop-fence";
import {
  createWorkflowDefinition,
  createWorkflowExecution,
} from "./test-fixtures";
import type {
  GraphWorkflowExecutionEvent,
  GraphWorkflowSSEEvent,
} from "@/lib/workflow-graph/event-schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { WorkflowSemanticDefinition } from "@/lib/workflow-graph/definition-schemas";
import { computeContentHash } from "@/lib/agent-profiles/hashing";

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

function createInMemoryRepo(
  config: GlobalConfig = {} as GlobalConfig,
  repoConfig: PerRepoConfig | null = null,
) {
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
      const { execution, events, pushes } = await mutate(
        session.graphWorkflowExecution,
      );
      session.graphWorkflowExecution = execution;
      appendedEvents.push(...events);
      // Mirror the production seam: commit the rows and hand the committed
      // delivery back; the repository performs delivery post-commit.
      return { execution, delivery: { events, pushes: pushes ?? [] } };
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
    readRepoConfig: async () => repoConfig,
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

  it("rejects a start whose selectors name commands the project registry lacks", async () => {
    const { repo, sessions } = createInMemoryRepo({} as GlobalConfig, {
      validation: {
        commands: {
          typecheck: {
            command: { full: "scripts/validate/typecheck.sh" },
            cost: 2,
            pathArgs: "forbid",
          },
        },
        preMerge: ["typecheck"],
      },
    });
    const definition = createWorkflowDefinition({
      workflowConfig: {
        scriptValidator: { commands: ["typecheck", "ghost"] },
      },
    });

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
    ).rejects.toMatchObject({
      name: "GraphWorkflowValidationError",
      errors: [
        expect.objectContaining({
          code: "unknown-validation-command",
          field: "workflowConfig.scriptValidator.commands.1",
        }),
      ],
    });
    // Fails before any execution state is written.
    expect(
      sessions.get("/repo:session-1")?.graphWorkflowExecution ?? null,
    ).toBeNull();
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

  it("rejects create when a non-terminal execution is already active, leaving it untouched", async () => {
    // Concurrent-start race: start()'s active-execution guard runs a long
    // async gauntlet before create, so two starts can both pass it. The
    // second create must fail inside the write-queue critical section
    // instead of silently overwriting the first execution (which would put
    // two loop drivers on one execution under matching fences).
    const { repo, sessions } = createInMemoryRepo();
    const seed = {
      definition: createWorkflowDefinition(),
      definitionId: "wf-1",
      definitionRevision: 1,
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: {},
      launchedTier: "project" as const,
    };
    const first = await repo.create("/repo", "session-1", seed);

    await expect(
      repo.create("/repo", "session-1", {
        ...seed,
        executionId: "exec-2",
      }),
    ).rejects.toMatchObject({
      name: "WorkflowStartGuardError",
      guard: "active_execution",
    });

    const active = sessions.get("/repo:session-1")?.graphWorkflowExecution;
    expect(active?.id).toBe(first.id);
  });

  it("allows create to replace a terminal active execution", async () => {
    // Mirrors start()'s guard semantics: completed/halted/aborted actives
    // are replaceable (start archives them first, but create must not be
    // stricter than the guard it backs).
    for (const status of ["completed", "halted", "aborted"] as const) {
      const { repo, sessions } = createInMemoryRepo();
      const session = (() => {
        sessions.set("/repo:session-1", {
          worktreePath: WORKTREE_PATH,
          graphWorkflowExecution: createWorkflowExecution({
            id: "exec-old",
            status,
            ...(status === "halted"
              ? {
                  haltReason: {
                    type: "recovery_error",
                    message: "old halt",
                  },
                }
              : {}),
          }),
        } as unknown as SessionState);
        return sessions.get("/repo:session-1")!;
      })();

      const created = await repo.create("/repo", "session-1", {
        definition: createWorkflowDefinition(),
        definitionId: "wf-1",
        definitionRevision: 1,
        executionId: "exec-new",
        startedAt: "2026-04-04T00:00:00.000Z",
        inputs: {},
        launchedTier: "project",
      });

      expect(created.id, `status=${status}`).toBe("exec-new");
      expect(
        (session as unknown as { graphWorkflowExecution: { id: string } })
          .graphWorkflowExecution.id,
      ).toBe("exec-new");
    }
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
        pendingUserInputs: {},
        skipReason: null,
        landingIntent: null,
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
      expect(context.implementer).toMatchObject(
        SEEDED_WORKFLOW_DEFAULTS.implementer,
      );

      // Seeded, not merely referenced: the working definition carries the bytes
      // the run will deliver, resolved once here and never looked up again (R4).
      const snapshot = context.implementer.profileSnapshot;
      expect(snapshot.tier).toBe("builtin");
      expect(snapshot.id).toBe("general-implementer");
      expect(snapshot.renderedInstructionBlock).toContain(
        snapshot.instructions,
      );
      expect(snapshot.resolvedInstructionHash).toBe(
        computeContentHash(snapshot.renderedInstructionBlock),
      );
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
          contextValidator: { enabled: false, assignments: [] },
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

    // Seeding resolves each tier's whole cohort: the two contexts that declare
    // none inherit the enabled global default, and the one that pins a disabled
    // cohort keeps it disabled rather than losing the block.
    expect(byId["context-plan"]?.contextValidator.enabled).toBe(true);
    expect(byId["context-verify"]?.contextValidator.enabled).toBe(true);
    expect(byId["context-implement"]?.contextValidator).toEqual({
      enabled: false,
      assignments: [],
    });
  });

  it("expands and freezes agent selectors to explicit names at seed time", async () => {
    const { repo } = createInMemoryRepo({} as GlobalConfig, {
      validation: {
        commands: {
          typecheck: {
            command: { full: "scripts/validate/typecheck.sh" },
            cost: 2,
            pathArgs: "forbid",
          },
          test: {
            command: {
              full: "scripts/validate/test-full-suite.sh",
              changed: "scripts/validate/test.sh",
            },
            cost: 8,
            pathArgs: "paths",
          },
          format: {
            command: { full: "scripts/validate/format.sh" },
            cost: 1,
            pathArgs: "forbid",
          },
        },
        preMerge: ["typecheck", "test"],
      },
    });
    const definition = createWorkflowDefinition({
      workflowConfig: {
        agentValidation: {
          implementer: { mode: "all", except: ["format"] },
        },
      },
    });

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
    // `mode:"all"` expands against the registry AT SEED so later registry
    // additions never broaden a running execution (design §6). context-plan
    // inherits the workflow tier's `all except format`; context-implement's
    // own `all except []` override expands to the full registry.
    expect(byId["context-plan"]?.agentValidation?.implementer.commands).toEqual(
      ["typecheck", "test"],
    );
    expect(
      byId["context-implement"]?.agentValidation?.implementer.commands,
    ).toEqual(["typecheck", "test", "format"]);
    for (const context of execution.workingDefinition.executionContexts) {
      // The seeded context-validator default is `{mode:"only", commands:[]}`.
      expect(context.agentValidation?.contextValidator.commands).toEqual([]);
    }
  });

  it("freezes agent selectors on loop templates for later pass materialization", async () => {
    const { repo } = createInMemoryRepo({} as GlobalConfig, {
      validation: {
        commands: {
          typecheck: {
            command: { full: "scripts/validate/typecheck.sh" },
            cost: 2,
            pathArgs: "forbid",
          },
          test: {
            command: {
              full: "scripts/validate/test-full-suite.sh",
              changed: "scripts/validate/test.sh",
            },
            cost: 8,
            pathArgs: "paths",
          },
          format: {
            command: { full: "scripts/validate/format.sh" },
            cost: 1,
            pathArgs: "forbid",
          },
        },
        preMerge: ["typecheck", "test"],
      },
    });
    const baseline = createWorkflowDefinition({
      workflowConfig: {
        agentValidation: {
          implementer: { mode: "all", except: ["format"] },
        },
      },
    });
    const definition = createWorkflowDefinition({
      ...baseline,
      executionContexts: baseline.executionContexts.map((context) =>
        context.id === "context-verify"
          ? {
              ...context,
              outputSchema: {
                type: "object",
                properties: { approved: { type: "boolean" } },
                required: ["approved"],
                additionalProperties: false,
              },
            }
          : context,
      ),
      loopGroups: [
        {
          id: "refine",
          bodyContextIds: ["context-implement", "context-verify"],
          entryContextId: "context-implement",
          exitContextId: "context-verify",
          until: {
            schema: {
              type: "object",
              properties: { approved: { const: true } },
              required: ["approved"],
            },
          },
          maxPasses: 3,
        },
      ],
    });

    const execution = await repo.create("/repo", "session-1", {
      definition,
      definitionId: "wf-loop",
      definitionRevision: 1,
      executionId: "exec-loop",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: {},
      launchedTier: "project",
    });

    const templateContexts = Object.fromEntries(
      execution.workingDefinition.loopGroups?.[0]?.template.contexts.map(
        (context) => [context.id, context],
      ) ?? [],
    );
    expect(
      templateContexts["context-implement"]?.agentValidation?.implementer
        .commands,
    ).toEqual(["typecheck", "test", "format"]);
    expect(
      templateContexts["context-verify"]?.agentValidation?.implementer.commands,
    ).toEqual(["typecheck", "test"]);
    for (const context of Object.values(templateContexts)) {
      expect(context.agentValidation?.contextValidator.commands).toEqual([]);
    }
  });

  it("rejects a start whose INHERITED global selector names an unknown command", async () => {
    const { repo, sessions } = createInMemoryRepo(
      {
        workflowDefaults: {
          agentValidation: {
            implementer: { mode: "all", except: ["ghost"] },
            contextValidator: { mode: "only", commands: [] },
          },
        },
      } as unknown as GlobalConfig,
      {
        validation: {
          commands: {
            typecheck: {
              command: { full: "scripts/validate/typecheck.sh" },
              cost: 2,
              pathArgs: "forbid",
            },
          },
          preMerge: ["typecheck"],
        },
      },
    );

    // The definition itself writes no selector: the unknown name arrives
    // purely through the global-defaults tier, so only the resolved-tier
    // preflight can catch it. `workflowConfig: {}` clears the fixture's own
    // workflow-tier blocks so the global tier is what resolves.
    const baseline = createWorkflowDefinition({ workflowConfig: {} });
    const definition = {
      ...baseline,
      executionContexts: baseline.executionContexts.map((context) => {
        const { agentValidation: _agentValidation, ...rest } = context;
        return rest;
      }),
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
    ).rejects.toMatchObject({
      name: "GraphWorkflowValidationError",
      errors: expect.arrayContaining([
        expect.objectContaining({
          code: "unknown-validation-command",
          field: expect.stringContaining("agentValidation.implementer"),
        }),
      ]),
    });
    expect(
      sessions.get("/repo:session-1")?.graphWorkflowExecution ?? null,
    ).toBeNull();
  });

  it("rejects an inherited oversized selection at start before writing execution state", async () => {
    const { repo, sessions } = createInMemoryRepo(
      {
        validation: { concurrencyLimit: 4, defaultTimeoutMs: 600_000 },
        workflowDefaults: {
          agentValidation: {
            implementer: { mode: "only", commands: ["test"] },
            contextValidator: { mode: "only", commands: [] },
          },
        },
      } as unknown as GlobalConfig,
      {
        validation: {
          commands: {
            test: {
              command: {
                full: "scripts/validate/test-full-suite.sh",
                changed: "scripts/validate/test.sh",
              },
              cost: 5,
              pathArgs: "paths",
            },
          },
          preMerge: ["test"],
        },
      },
    );
    const baseline = createWorkflowDefinition({ workflowConfig: {} });
    const definition = {
      ...baseline,
      executionContexts: baseline.executionContexts.map((context) => {
        const { agentValidation: _agentValidation, ...rest } = context;
        return rest;
      }),
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
    ).rejects.toMatchObject({
      name: "GraphWorkflowValidationError",
      errors: expect.arrayContaining([
        expect.objectContaining({
          code: "validation_cost_exceeds_limit",
          field: expect.stringContaining(
            "agentValidation.implementer.value.commands.0",
          ),
          message: expect.stringMatching(/cost 5.*limit 4.*lower-worker/),
        }),
      ]),
    });
    expect(
      sessions.get("/repo:session-1")?.graphWorkflowExecution ?? null,
    ).toBeNull();
  });

  it("snapshots the resolved laneMergeValidation onto the working definition", async () => {
    const { repo } = createInMemoryRepo({} as GlobalConfig, {
      validation: {
        commands: {
          typecheck: {
            command: { full: "scripts/validate/typecheck.sh" },
            cost: 2,
            pathArgs: "forbid",
          },
        },
        preMerge: ["typecheck"],
      },
    });
    const definition = createWorkflowDefinition({
      workflowConfig: {
        laneMergeValidation: {
          strategy: "every-merge",
          commands: { mode: "only", commands: ["typecheck"] },
        },
      },
    });

    const execution = await repo.create("/repo", "session-1", {
      definition,
      definitionId: "wf-1",
      definitionRevision: 1,
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: {},
      launchedTier: "project",
    });

    expect(execution.workingDefinition.laneMergeValidation).toEqual({
      strategy: "every-merge",
      commands: { mode: "only", commands: ["typecheck"] },
    });
  });

  it("snapshots the seeded laneMergeValidation defaults when no tier overrides", async () => {
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

    expect(execution.workingDefinition.laneMergeValidation).toEqual({
      strategy: "final-only",
      commands: { mode: "project" },
    });
  });

  it("rejects a start whose inherited laneMergeValidation names an unknown command", async () => {
    const { repo } = createInMemoryRepo(
      {
        workflowDefaults: {
          laneMergeValidation: {
            strategy: "final-only",
            commands: { mode: "only", commands: ["ghost"] },
          },
        },
      } as unknown as GlobalConfig,
      {
        validation: {
          commands: {
            typecheck: {
              command: { full: "scripts/validate/typecheck.sh" },
              cost: 2,
              pathArgs: "forbid",
            },
          },
          preMerge: ["typecheck"],
        },
      },
    );

    // `workflowConfig: {}` clears the fixture's workflow-tier lane-merge
    // block so the global default (naming "ghost") is what resolves.
    await expect(
      repo.create("/repo", "session-1", {
        definition: createWorkflowDefinition({ workflowConfig: {} }),
        definitionId: "wf-1",
        definitionRevision: 1,
        executionId: "exec-1",
        startedAt: "2026-04-04T00:00:00.000Z",
        inputs: {},
        launchedTier: "project",
      }),
    ).rejects.toMatchObject({
      name: "GraphWorkflowValidationError",
      errors: expect.arrayContaining([
        expect.objectContaining({
          code: "unknown-validation-command",
          field: "laneMergeValidation.commands.commands.0",
        }),
      ]),
    });
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
            id: "implementer",
            profile: { tier: "builtin" as const, id: "general-implementer" },
            agent: {
              backend: "codex" as const,
              model: "gpt-5.4" as const,
              reasoningEffort: "minimal" as const,
            },
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

describe("createGraphWorkflowExecutionRepository loop-fence enforcement", () => {
  function seedActiveExecution(
    harness: ReturnType<typeof createInMemoryRepo>,
    overrides: Partial<GraphWorkflowExecution> = {},
  ): GraphWorkflowExecution {
    const execution = createWorkflowExecution({
      id: "execution-1",
      ...overrides,
    });
    const key = "/repo:session-1";
    const session = makeSession();
    session.graphWorkflowExecution = execution;
    harness.sessions.set(key, session);
    return execution;
  }

  it("applies a mutation whose ambient fence matches the persisted generation", async () => {
    const harness = createInMemoryRepo();
    seedActiveExecution(harness);

    const next = await runWithLoopFence(
      {
        projectPath: "/repo",
        sessionName: "session-1",
        executionId: "execution-1",
        loopEpoch: 0,
      },
      () =>
        harness.repo.mutateActive("/repo", "session-1", (execution) => ({
          ...execution,
          activeContextIds: ["context-updated"],
        })),
    );

    expect(next.activeContextIds).toEqual(["context-updated"]);
    expect(
      harness.sessions.get("/repo:session-1")?.graphWorkflowExecution
        ?.activeContextIds,
    ).toEqual(["context-updated"]);
  });

  it("rejects a mutation from a stale loop generation without persisting anything", async () => {
    const harness = createInMemoryRepo();
    // Persisted execution has been resumed since the loop captured its fence.
    seedActiveExecution(harness, { loopEpoch: 1 });

    const mutator = vi.fn((execution: GraphWorkflowExecution) => ({
      ...execution,
      activeContextIds: ["context-stale-write"],
    }));

    await expect(
      runWithLoopFence(
        {
          projectPath: "/repo",
          sessionName: "session-1",
          executionId: "execution-1",
          loopEpoch: 0,
        },
        () => harness.repo.mutateActive("/repo", "session-1", mutator),
      ),
    ).rejects.toThrow(StaleLoopFenceError);

    expect(mutator).not.toHaveBeenCalled();
    expect(
      harness.sessions.get("/repo:session-1")?.graphWorkflowExecution
        ?.activeContextIds,
    ).toEqual([]);
    expect(harness.appendedEvents).toEqual([]);
  });

  it("rejects a mutation from a loop whose execution was replaced by a successor", async () => {
    const harness = createInMemoryRepo();
    seedActiveExecution(harness, { id: "execution-2" });

    await expect(
      runWithLoopFence(
        {
          projectPath: "/repo",
          sessionName: "session-1",
          executionId: "execution-1",
          loopEpoch: 0,
        },
        () =>
          harness.repo.mutateActive("/repo", "session-1", (execution) => ({
            ...execution,
            activeContextIds: ["context-stale-write"],
          })),
      ),
    ).rejects.toThrow(StaleLoopFenceError);

    expect(
      harness.sessions.get("/repo:session-1")?.graphWorkflowExecution
        ?.activeContextIds,
    ).toEqual([]);
  });

  it("rejects a fenced mutation when the execution was archived (no active row)", async () => {
    const harness = createInMemoryRepo();

    await expect(
      runWithLoopFence(
        {
          projectPath: "/repo",
          sessionName: "session-1",
          executionId: "execution-1",
          loopEpoch: 0,
        },
        () =>
          harness.repo.mutateActive(
            "/repo",
            "session-1",
            (execution) => execution,
          ),
      ),
    ).rejects.toThrow(StaleLoopFenceError);
  });

  it("keeps unfenced mutations (user/agent routes) unaffected", async () => {
    const harness = createInMemoryRepo();
    seedActiveExecution(harness, { loopEpoch: 7 });

    const next = await harness.repo.mutateActive(
      "/repo",
      "session-1",
      (execution) => ({
        ...execution,
        activeContextIds: ["context-route-write"],
      }),
    );

    expect(next.activeContextIds).toEqual(["context-route-write"]);
  });
});

describe("createGraphWorkflowExecutionRepository executionStateRevision fence", () => {
  function seedActiveExecution(
    harness: ReturnType<typeof createInMemoryRepo>,
    overrides: Partial<GraphWorkflowExecution> = {},
  ): GraphWorkflowExecution {
    const execution = createWorkflowExecution({
      id: "execution-1",
      ...overrides,
    });
    const session = makeSession();
    session.graphWorkflowExecution = execution;
    harness.sessions.set("/repo:session-1", session);
    return execution;
  }

  it("bumps executionStateRevision on every committed mutation, scheduler writes included", async () => {
    const harness = createInMemoryRepo();
    const seeded = seedActiveExecution(harness, { executionStateRevision: 4 });
    expect(seeded.executionStateRevision).toBe(4);

    const first = await harness.repo.mutateActive(
      "/repo",
      "session-1",
      (execution) => ({ ...execution, activeContextIds: ["context-plan"] }),
    );
    expect(first.executionStateRevision).toBe(5);

    // A scheduler-shaped write that touches no live-edit field still moves the
    // fence — `liveRevision` alone would miss it, which is the whole point.
    const second = await harness.repo.mutateActive(
      "/repo",
      "session-1",
      (execution) => ({
        ...execution,
        laneStates: {},
      }),
    );
    expect(second.executionStateRevision).toBe(6);
    expect(second.liveRevision).toBe(seeded.liveRevision);
    expect(
      harness.sessions.get("/repo:session-1")?.graphWorkflowExecution
        ?.executionStateRevision,
    ).toBe(6);
  });

  it("owns the counter: a reducer cannot set, freeze, or rewind it", async () => {
    const harness = createInMemoryRepo();
    seedActiveExecution(harness, { executionStateRevision: 9 });

    const next = await harness.repo.mutateActive(
      "/repo",
      "session-1",
      (execution) => ({ ...execution, executionStateRevision: 2 }),
    );

    expect(next.executionStateRevision).toBe(10);
  });

  it("leaves the counter untouched when the mutation is rejected", async () => {
    const harness = createInMemoryRepo();
    seedActiveExecution(harness, { executionStateRevision: 3, loopEpoch: 1 });

    await expect(
      runWithLoopFence(
        {
          projectPath: "/repo",
          sessionName: "session-1",
          executionId: "execution-1",
          loopEpoch: 0,
        },
        () =>
          harness.repo.mutateActive("/repo", "session-1", (execution) => ({
            ...execution,
            activeContextIds: ["context-stale-write"],
          })),
      ),
    ).rejects.toThrow(StaleLoopFenceError);

    expect(
      harness.sessions.get("/repo:session-1")?.graphWorkflowExecution
        ?.executionStateRevision,
    ).toBe(3);
  });
});

describe("createGraphWorkflowExecutionRepository structuralRevision fence", () => {
  function seedActiveExecution(
    harness: ReturnType<typeof createInMemoryRepo>,
    overrides: Partial<GraphWorkflowExecution> = {},
  ): GraphWorkflowExecution {
    const execution = createWorkflowExecution({
      id: "execution-1",
      ...overrides,
    });
    const session = makeSession();
    session.graphWorkflowExecution = execution;
    harness.sessions.set("/repo:session-1", session);
    return execution;
  }

  it("bumps on a definition write from a reducer that moves no live-edit field", async () => {
    // `iteration-orchestrator` appends script-validator remediation tasks to the
    // working definition inside `mutateActive`, and bumps no `liveRevision`
    // because a failing pre-merge script is not a live edit. The fence has to
    // catch it anyway — a staged batch that installs its definition wholesale
    // would otherwise delete this task and keep its task state.
    const harness = createInMemoryRepo();
    const seeded = seedActiveExecution(harness, { structuralRevision: 5 });

    const next = await harness.repo.mutateActive(
      "/repo",
      "session-1",
      (execution) => {
        execution.workingDefinition.tasks.push({
          id: "task-remediation-1",
          contextId: "context-implement",
          order: 2,
          title: "Fix pre-merge validation errors",
          instructions: "Re-run the pre-merge script and fix what it reports.",
          source: "user",
        });
        return execution;
      },
    );

    expect(next.structuralRevision).toBe(6);
    expect(next.liveRevision).toBe(seeded.liveRevision);
  });

  it("holds still for a scheduler write that leaves the structural keys alone", async () => {
    // The counterpart property: if every commit bumped it, every interleaved
    // scheduler tick would force a needless reprepare.
    const harness = createInMemoryRepo();
    seedActiveExecution(harness, { structuralRevision: 5 });

    const next = await harness.repo.mutateActive(
      "/repo",
      "session-1",
      (execution) => ({
        ...execution,
        activeContextIds: ["context-plan"],
        contextStates: {
          ...execution.contextStates,
          "context-plan": {
            ...execution.contextStates["context-plan"]!,
            status: "running",
          },
        },
      }),
    );

    expect(next.structuralRevision).toBe(5);
    expect(next.executionStateRevision).toBe(1);
  });

  it("owns the counter: a reducer cannot set, freeze, or rewind it", async () => {
    const harness = createInMemoryRepo();
    seedActiveExecution(harness, { structuralRevision: 9 });

    // Claims a bump it did not earn...
    const unearned = await harness.repo.mutateActive(
      "/repo",
      "session-1",
      (execution) => ({ ...execution, structuralRevision: 42 }),
    );
    expect(unearned.structuralRevision).toBe(9);

    // ...and hides one it did.
    const hidden = await harness.repo.mutateActive(
      "/repo",
      "session-1",
      (execution) => ({
        ...execution,
        structuralRevision: 9,
        charterAmendments: [
          {
            seq: 1,
            amendedAt: "2026-08-04T00:00:00.000Z",
            source: "cli",
            rationale: "Scope moved after the API review",
            fieldsChanged: ["mission"],
            charterHash: "hash-1",
          },
        ],
      }),
    );
    expect(hidden.structuralRevision).toBe(10);
  });
});
