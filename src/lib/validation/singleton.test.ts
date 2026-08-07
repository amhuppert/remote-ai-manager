import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type { SessionState } from "@/lib/sessions/schemas";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createValidationRunsRepo } from "@/lib/state-store/validation-runs-repo";
import type { SpawnValidationParams } from "@/lib/validation/process-runner";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import type {
  GraphWorkflowAgentSessionState,
  GraphWorkflowExecution,
} from "@/lib/workflow-graph/schemas";
import type { ValidationProcessIdentity } from "./recovery";
import { createValidationScheduler } from "./scheduler";
import { repoValidationConfigSchema } from "./schemas";
import { createValidationService, type ValidationService } from "./service";
import {
  _resetValidationServiceForTesting,
  _validationSingletonHostForTesting,
  createProductionValidationCallerResolver,
  initializeValidationServiceAtStartup,
  installValidationShutdownHooks,
  type ProductionValidationResolverDeps,
} from "./singleton";

const T = "2026-08-05T10:00:00.000Z";

function session(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionName: "session-1",
    worktreePath: "/repo/.worktrees/session-1",
    branchName: "csm/session-1",
    createdAt: T,
    lastActivityAt: T,
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

function implementerLaneState(
  conversationId: string,
): GraphWorkflowAgentSessionState {
  return {
    lane: "implementer",
    contextId: "context-implement",
    backend: "claude",
    refKind: "conversation",
    workflowConversationId: conversationId,
    metrics: { rotateBeforeNextTurn: false },
    limitEvaluation: "supported",
    lastUsedAt: T,
  };
}

/**
 * An execution whose implementer lane runs in a lane worktree that has NOT
 * committed any context yet — includedContextIds is empty, which is the
 * normal state while a lane is actively working.
 */
function activeLaneExecution(
  overrides: Partial<GraphWorkflowExecution> = {},
): GraphWorkflowExecution {
  const base = createWorkflowExecution();
  return {
    ...base,
    contextStates: {
      ...base.contextStates,
      "context-implement": {
        ...base.contextStates["context-implement"]!,
        laneId: "lane-1",
      },
    },
    executionLanes: {
      "lane-1": {
        laneId: "lane-1",
        kind: "worktree",
        status: "active",
        worktreePath: "/repo/.worktrees/session-1.lane-1",
        branchName: "csm/session-1-lane-1",
        includedContextIds: [],
        lastCommittingContextId: null,
        commitSnapshots: [],
        createdAt: T,
        updatedAt: T,
      },
    },
    laneStates: {
      "context-implement": { implementer: implementerLaneState("conv-lane") },
    },
    ...overrides,
  };
}

function resolverDeps(opts: {
  session?: SessionState | null;
  execution?: GraphWorkflowExecution | null;
}): ProductionValidationResolverDeps {
  return {
    getSession: async () => opts.session ?? null,
    getActiveGraphWorkflowExecution: async () => opts.execution ?? null,
    readRepoValidation: async () =>
      repoValidationConfigSchema.parse({
        commands: {
          typecheck: { command: "scripts/validate/typecheck.sh", cost: 2 },
          test: { command: "scripts/validate/test.sh", cost: 8 },
        },
      }),
  };
}

afterEach(() => {
  _resetValidationServiceForTesting();
});

describe("createProductionValidationCallerResolver", () => {
  it("resolves a lane conversation to its lane worktree before any context has committed", async () => {
    const resolver = createProductionValidationCallerResolver(
      resolverDeps({ session: session(), execution: activeLaneExecution() }),
    );

    const resolved = await resolver.resolveCaller({
      projectPath: "/repo",
      sessionName: "session-1",
      conversationId: "conv-lane",
    });

    expect(resolved).toMatchObject({
      kind: "graph_lane",
      worktreePath: "/repo/.worktrees/session-1.lane-1",
      branchName: "csm/session-1-lane-1",
      targetBranch: "csm/session-1",
      executionId: "execution-1",
      contextId: "context-implement",
      role: "implementer",
    });
    if (resolved.kind !== "graph_lane") return;
    expect(resolved.allowedCommands).toEqual([]);
  });

  it("authorizes from the frozen command snapshot instead of the current registry", async () => {
    const base = activeLaneExecution();
    const execution: GraphWorkflowExecution = {
      ...base,
      workingDefinition: {
        ...base.workingDefinition,
        executionContexts: base.workingDefinition.executionContexts.map(
          (context) =>
            context.id === "context-implement" && context.agentValidation
              ? {
                  ...context,
                  agentValidation: {
                    ...context.agentValidation,
                    implementer: {
                      ...context.agentValidation.implementer,
                      value: { mode: "all", except: [] },
                      commands: ["typecheck"],
                    },
                  },
                }
              : context,
        ),
      },
    };
    const resolver = createProductionValidationCallerResolver(
      resolverDeps({ session: session(), execution }),
    );

    const resolved = await resolver.resolveCaller({
      projectPath: "/repo",
      sessionName: "session-1",
      conversationId: "conv-lane",
    });

    expect(resolved.kind).toBe("graph_lane");
    if (resolved.kind !== "graph_lane") return;
    expect(resolved.allowedCommands).toEqual(["typecheck"]);
  });

  it("fails closed when the context's lane assignment is inconsistent with execution state", async () => {
    const broken = activeLaneExecution();
    const execution: GraphWorkflowExecution = {
      ...broken,
      contextStates: {
        ...broken.contextStates,
        "context-implement": {
          ...broken.contextStates["context-implement"]!,
          laneId: "lane-ghost",
        },
      },
    };
    const resolver = createProductionValidationCallerResolver(
      resolverDeps({ session: session(), execution }),
    );

    const resolved = await resolver.resolveCaller({
      projectPath: "/repo",
      sessionName: "session-1",
      conversationId: "conv-lane",
    });

    expect(resolved.kind).toBe("ambiguous");
  });

  it("resolves a session-kind lane to the session worktree", async () => {
    const base = activeLaneExecution();
    const execution: GraphWorkflowExecution = {
      ...base,
      executionLanes: {
        "lane-1": {
          ...base.executionLanes["lane-1"]!,
          kind: "session",
          worktreePath: null,
        },
      },
    };
    const resolver = createProductionValidationCallerResolver(
      resolverDeps({ session: session(), execution }),
    );

    const resolved = await resolver.resolveCaller({
      projectPath: "/repo",
      sessionName: "session-1",
      conversationId: "conv-lane",
    });

    expect(resolved).toMatchObject({
      kind: "graph_lane",
      worktreePath: "/repo/.worktrees/session-1",
      branchName: "csm/session-1",
      // The lane IS the session branch here; the diff base must be what the
      // session merges into, never the branch itself (an empty diff).
      targetBranch: "main",
    });
  });

  it("fails closed on stale claimed workflow identity", async () => {
    const resolver = createProductionValidationCallerResolver(
      resolverDeps({ session: session(), execution: activeLaneExecution() }),
    );

    const resolved = await resolver.resolveCaller({
      projectPath: "/repo",
      sessionName: "session-1",
      conversationId: "conv-lane",
      claimedWorkflow: {
        executionId: "execution-stale",
        contextId: "context-implement",
        role: "implementer",
      },
    });

    expect(resolved.kind).toBe("ambiguous");
  });

  it("fails closed on a stale claim even when no role is claimed", async () => {
    // The CLI claims only what its env carries (CC_WORKFLOW_EXECUTION_ID /
    // CC_WORKFLOW_CONTEXT_ID — there is no role var), so a role-less claim
    // must still be cross-checked: a stale lane env would otherwise resolve
    // as a plain session caller with unrestricted command access.
    const resolver = createProductionValidationCallerResolver(
      resolverDeps({ session: session(), execution: null }),
    );

    const resolved = await resolver.resolveCaller({
      projectPath: "/repo",
      sessionName: "session-1",
      conversationId: "conv-lane",
      claimedWorkflow: {
        executionId: "execution-aborted",
        contextId: "context-implement",
      },
    });

    expect(resolved.kind).toBe("ambiguous");
  });

  it("resolves a role-less claim that matches execution state", async () => {
    const resolver = createProductionValidationCallerResolver(
      resolverDeps({ session: session(), execution: activeLaneExecution() }),
    );

    const resolved = await resolver.resolveCaller({
      projectPath: "/repo",
      sessionName: "session-1",
      conversationId: "conv-lane",
      claimedWorkflow: {
        executionId: "execution-1",
        contextId: "context-implement",
      },
    });

    expect(resolved).toMatchObject({
      kind: "graph_lane",
      executionId: "execution-1",
      contextId: "context-implement",
    });
  });

  it("fails closed on an unmapped conversation while an execution is active", async () => {
    const resolver = createProductionValidationCallerResolver(
      resolverDeps({ session: session(), execution: activeLaneExecution() }),
    );

    const resolved = await resolver.resolveCaller({
      projectPath: "/repo",
      sessionName: "session-1",
      conversationId: "conv-stale",
    });

    expect(resolved).toMatchObject({
      kind: "ambiguous",
      reason: expect.stringContaining("active execution"),
    });
  });

  it("fails closed when one conversation maps to multiple execution lanes", async () => {
    const execution = activeLaneExecution();
    execution.laneStates["context-plan"] = {
      implementer: {
        ...implementerLaneState("conv-lane"),
        contextId: "context-plan",
      },
    };
    const resolver = createProductionValidationCallerResolver(
      resolverDeps({ session: session(), execution }),
    );

    const resolved = await resolver.resolveCaller({
      projectPath: "/repo",
      sessionName: "session-1",
      conversationId: "conv-lane",
    });

    expect(resolved).toMatchObject({
      kind: "ambiguous",
      reason: expect.stringContaining("multiple execution lanes"),
    });
  });

  it("resolves plain session and project conversations to their worktrees", async () => {
    const resolver = createProductionValidationCallerResolver(
      resolverDeps({ session: session(), execution: null }),
    );

    await expect(
      resolver.resolveCaller({
        projectPath: "/repo",
        sessionName: "session-1",
        conversationId: "conv-plain",
      }),
    ).resolves.toMatchObject({
      kind: "session",
      worktreePath: "/repo/.worktrees/session-1",
      targetBranch: "main",
    });

    await expect(
      resolver.resolveCaller({ projectPath: "/repo" }),
    ).resolves.toMatchObject({ kind: "project", worktreePath: "/repo" });
  });
});

const POLICY_PROJECT_PATH = "/projects/policy";
const GRAPH_SESSION = "graph-session";
const PLAIN_SESSION = "plain-session";

function policyExecution(): GraphWorkflowExecution {
  const execution = activeLaneExecution();
  const contexts = execution.workingDefinition.executionContexts.map(
    (context) =>
      context.id === "context-implement"
        ? {
            ...context,
            scriptValidator: { commands: ["test"] },
            agentValidation: {
              implementer: {
                value: { mode: "only" as const, commands: ["typecheck"] },
                source: "per-node" as const,
              },
              contextValidator: {
                value: { mode: "only" as const, commands: [] },
                source: "per-node" as const,
              },
            },
          }
        : context,
  );
  return {
    ...execution,
    status: "running",
    workingDefinition: {
      ...execution.workingDefinition,
      executionContexts: contexts,
    },
    executionLanes: {
      "lane-1": {
        ...execution.executionLanes["lane-1"]!,
        worktreePath: `${POLICY_PROJECT_PATH}/.worktrees/${GRAPH_SESSION}.lane-1`,
        branchName: `csm/${GRAPH_SESSION}-lane-1`,
      },
    },
    laneStates: {
      "context-implement": {
        implementer: implementerLaneState("conv-implementer"),
        context_validator: {
          ...implementerLaneState("conv-validator"),
          lane: "context_validator",
        },
      },
    },
  };
}

function createPersistedPolicyService(
  fixture: PersistenceFixture,
  spawns: SpawnValidationParams[],
): ValidationService {
  const reloadedStore = fixture.recreateStore();
  const repo = createValidationRunsRepo(fixture.db);
  const transact = <T>(_label: string, fn: () => T): T =>
    fixture.db.transaction(fn)();
  const identity: ValidationProcessIdentity = {
    classifyGroup: async () => "not_ours",
    killGroup: async () => {},
  };
  let id = 0;
  return createValidationService({
    repo,
    transact,
    scheduler: createValidationScheduler({ repo, transact }),
    runner: {
      async spawn(params) {
        spawns.push(params);
        return { kind: "spawn_error", message: "test process boundary" };
      },
    },
    resolver: createProductionValidationCallerResolver({
      getSession: (projectPath, sessionName) =>
        reloadedStore.getSession(projectPath, sessionName),
      getActiveGraphWorkflowExecution: (projectPath, sessionName) =>
        reloadedStore.getActiveGraphWorkflowExecution(projectPath, sessionName),
      readRepoValidation: async () =>
        repoValidationConfigSchema.parse({
          commands: {
            typecheck: {
              command: "scripts/validate/typecheck.sh",
              cost: 2,
            },
            test: { command: "scripts/validate/test.sh", cost: 3 },
          },
          preMerge: ["typecheck", "test"],
        }),
    }),
    config: {
      readRepoValidation: async () =>
        repoValidationConfigSchema.parse({
          commands: {
            typecheck: {
              command: "scripts/validate/typecheck.sh",
              cost: 2,
            },
            test: { command: "scripts/validate/test.sh", cost: 3 },
          },
          preMerge: ["typecheck", "test"],
        }),
      readGlobal: async () => ({
        concurrencyLimit: 8,
        defaultTimeoutMs: 600_000,
      }),
    },
    identity,
    publish: () => ({ delivered: true }),
    ids: {
      runId: () => `policy-run-${++id}`,
      nonce: () => `policy-nonce-${id}`,
    },
  });
}

describe("persisted graph policy through ValidationService", () => {
  it("enforces lane snapshots, leaves non-graph sessions unrestricted, and rejects stale conversations", async () => {
    const fixture = createPersistenceFixture();
    try {
      fixture.seedProject(POLICY_PROJECT_PATH);
      fixture.seedSession(POLICY_PROJECT_PATH, GRAPH_SESSION, {
        targetBranch: "main",
      });
      fixture.seedSession(POLICY_PROJECT_PATH, PLAIN_SESSION, {
        targetBranch: "main",
      });
      fixture.graphWorkflowExecutions.setActive(
        POLICY_PROJECT_PATH,
        GRAPH_SESSION,
        policyExecution(),
        T,
      );
      const persistedExecution = await fixture
        .recreateStore()
        .getActiveGraphWorkflowExecution(POLICY_PROJECT_PATH, GRAPH_SESSION);
      expect(
        persistedExecution?.workingDefinition.executionContexts.find(
          ({ id }) => id === "context-implement",
        )?.agentValidation?.implementer.value,
      ).toEqual({ mode: "only", commands: ["typecheck"] });
      const spawns: SpawnValidationParams[] = [];
      const service = createPersistedPolicyService(fixture, spawns);

      const allowed = await service.submit({
        source: "agent_cli",
        commandName: "typecheck",
        caller: {
          projectPath: POLICY_PROJECT_PATH,
          sessionName: GRAPH_SESSION,
          conversationId: "conv-implementer",
        },
      });
      expect(allowed.kind).toBe("accepted");
      expect(spawns[0]).toMatchObject({
        commandName: "typecheck",
        worktreePath: `${POLICY_PROJECT_PATH}/.worktrees/${GRAPH_SESSION}.lane-1`,
        contextId: "context-implement",
      });
      expect(
        createValidationRunsRepo(fixture.db).findById("policy-run-1"),
      ).toMatchObject({
        workflowExecutionId: "execution-1",
        workflowContextId: "context-implement",
        workflowRole: "implementer",
      });

      const disabled = await service.submit({
        source: "agent_cli",
        commandName: "test",
        caller: {
          projectPath: POLICY_PROJECT_PATH,
          sessionName: GRAPH_SESSION,
          conversationId: "conv-implementer",
        },
      });
      expect(disabled).toMatchObject({
        kind: "not_started",
        result: {
          kind: "skipped_by_policy",
          message: expect.stringContaining("handled by the script validator"),
        },
      });
      expect(spawns).toHaveLength(1);

      const validatorDisabled = await service.submit({
        source: "agent_cli",
        commandName: "typecheck",
        caller: {
          projectPath: POLICY_PROJECT_PATH,
          sessionName: GRAPH_SESSION,
          conversationId: "conv-validator",
        },
      });
      expect(validatorDisabled).toMatchObject({
        kind: "not_started",
        result: {
          kind: "skipped_by_policy",
          message: expect.stringContaining("context validator"),
        },
      });
      expect(spawns).toHaveLength(1);

      const plain = await service.submit({
        source: "agent_cli",
        commandName: "test",
        caller: {
          projectPath: POLICY_PROJECT_PATH,
          sessionName: PLAIN_SESSION,
          conversationId: "conv-plain",
        },
      });
      expect(plain.kind).toBe("accepted");
      expect(spawns[1]).toMatchObject({
        commandName: "test",
        worktreePath: `${POLICY_PROJECT_PATH}/.worktrees/${PLAIN_SESSION}`,
      });

      const stale = await service.submit({
        source: "agent_cli",
        commandName: "typecheck",
        caller: {
          projectPath: POLICY_PROJECT_PATH,
          sessionName: GRAPH_SESSION,
          conversationId: "conv-stale",
        },
      });
      expect(stale).toMatchObject({
        kind: "invalid",
        reason: "identity_unresolved",
        message: expect.stringContaining("fails closed"),
      });
      expect(spawns).toHaveLength(2);
    } finally {
      fixture.close();
    }
  });
});

describe("globalThis composition state", () => {
  it("survives module re-evaluation so HMR cannot construct a second service", async () => {
    vi.resetModules();
    const first = await import("./singleton");
    const firstHost = first._validationSingletonHostForTesting();

    vi.resetModules();
    const second = await import("./singleton");
    const secondHost = second._validationSingletonHostForTesting();

    expect(second).not.toBe(first);
    expect(secondHost).toBe(firstHost);
    expect(secondHost).toBe(_validationSingletonHostForTesting());
  });
});

function fakeProc() {
  const listeners = new Map<string, Array<() => void>>();
  const kills: Array<{ pid: number; signal: string }> = [];
  return {
    pid: 4321,
    kills,
    once(event: "SIGTERM" | "SIGINT", listener: () => void): unknown {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return this;
    },
    kill(pid: number, signal: NodeJS.Signals): unknown {
      kills.push({ pid, signal });
      return true;
    },
    listenerCount(event: string): number {
      return listeners.get(event)?.length ?? 0;
    },
    emit(event: string): void {
      const list = listeners.get(event) ?? [];
      listeners.set(event, []);
      for (const listener of list) listener();
    },
  };
}

function fakeService(overrides: Partial<ValidationService>): ValidationService {
  return {
    whenReady: async () => {},
    isAvailable: () => true,
    submit: async () => ({
      kind: "invalid",
      reason: "service_unavailable",
      message: "fake",
    }),
    list: async () => ({
      kind: "invalid",
      reason: "service_unavailable",
      message: "fake",
    }),
    submitSystem: async () => ({
      kind: "invalid",
      reason: "service_unavailable",
      message: "fake",
    }),
    waitForCompletion: async (runId) => ({ kind: "cancelled", runId }),
    poll: () => ({ status: null, position: null, result: null }),
    cancel: async () => ({ authorization: "not_found" }),
    cancelSystemOwned: async () => false,
    sweepExpiredLeases: async () => 0,
    shutdown: async () => {},
    ...overrides,
  };
}

describe("initializeValidationServiceAtStartup", () => {
  it("starts the sweep and installs shutdown hooks only after a successful recovery", async () => {
    const proc = fakeProc();
    await initializeValidationServiceAtStartup({
      service: fakeService({}),
      proc,
    });

    const host = _validationSingletonHostForTesting() as {
      sweepTimer: unknown;
      shutdownHooksInstalled: boolean;
    };
    expect(host.sweepTimer).not.toBeNull();
    expect(host.shutdownHooksInstalled).toBe(true);
    expect(proc.listenerCount("SIGTERM")).toBe(1);
  });

  it("starts no sweep and installs no hooks when recovery failed", async () => {
    const proc = fakeProc();
    await initializeValidationServiceAtStartup({
      service: fakeService({ isAvailable: () => false }),
      proc,
    });

    const host = _validationSingletonHostForTesting() as {
      sweepTimer: unknown;
      shutdownHooksInstalled: boolean;
    };
    // Retained rows belong to unverifiable groups; a sweep or shutdown pass
    // over them would terminalize rows without group death.
    expect(host.sweepTimer).toBeNull();
    expect(host.shutdownHooksInstalled).toBe(false);
    expect(proc.listenerCount("SIGTERM")).toBe(0);
    expect(proc.listenerCount("SIGINT")).toBe(0);
  });
});

describe("installValidationShutdownHooks", () => {
  it("shuts the service down before re-raising the signal, and installs only once", async () => {
    const proc = fakeProc();
    let resolveShutdown!: () => void;
    const shutdownCalls: string[] = [];
    const service = fakeService({
      shutdown: () => {
        shutdownCalls.push("shutdown");
        return new Promise<void>((resolve) => {
          resolveShutdown = resolve;
        });
      },
    });

    expect(installValidationShutdownHooks(service, proc)).toBe(true);
    // Module re-evaluation calls install again; it must not double-hook.
    expect(installValidationShutdownHooks(service, proc)).toBe(false);
    expect(proc.listenerCount("SIGTERM")).toBe(1);
    expect(proc.listenerCount("SIGINT")).toBe(1);

    proc.emit("SIGTERM");
    expect(shutdownCalls).toEqual(["shutdown"]);
    // The signal is not re-raised until graceful shutdown settles.
    expect(proc.kills).toEqual([]);

    resolveShutdown();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(proc.kills).toEqual([{ pid: 4321, signal: "SIGTERM" }]);
  });

  it("re-raises even when shutdown rejects", async () => {
    const proc = fakeProc();
    const service = fakeService({
      shutdown: async () => {
        throw new Error("boom");
      },
    });

    installValidationShutdownHooks(service, proc);
    proc.emit("SIGINT");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(proc.kills).toEqual([{ pid: 4321, signal: "SIGINT" }]);
  });
});
