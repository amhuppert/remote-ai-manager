import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import type { GlobalConfig } from "@/lib/config/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
  GraphWorkflowValidationRound,
  GraphWorkflowValidationSpecialist,
} from "@/lib/workflow-graph/schemas";
import type {
  GraphWorkflowExecutionContextDefinition,
  ResolvedWorkflowSemanticDefinition,
  WorkflowDefinitionRecord,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import { resolvedWorkflowSemanticDefinitionSchema } from "@/lib/workflow-graph/definition-schemas";
import { migrateRawDefinitionPlacement } from "@/lib/workflow-graph/placement-migration";
import {
  createResolvedWorkflowDefinition,
  createWorkflowDefinition,
  createWorkflowDefinitionRecord,
  createWorkflowExecution,
  createWorkflowLayout,
  makeProfileSnapshot,
  makeSeededValidatorAssignment,
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
  SESSION_LANE_ID,
  SESSION_LANE_NAME,
} from "@/lib/workflow-graph/lane-identity";
import {
  createGraphWorkflowManager,
  interruptedDefinitionDecision,
  WorkflowDefinitionNotFoundError,
  WorkflowPrerequisitesUnmetError,
  WorkflowStartGuardError,
  WorkflowStartInputError,
  type ScheduleEligibleContextsResult,
} from "./workflow-manager";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { AgentFailureClassification } from "@/lib/agent-backends/errors";
import type { TemplateTier } from "./template-library-service";
import {
  createGraphWorkflowExecutionRepository,
  type GraphWorkflowExecutionSeed,
} from "./execution-repository";
import { buildExecutionProvenance } from "./execution-origin";
import { SEEDED_WORKFLOW_DEFAULTS } from "./resolve-config";
import { holdsExecutionLease } from "./lifecycle-classifier";
import { createWorkflowStorageService } from "./storage";
import { scopeForTier } from "./template-library-service";
import {
  assertLoopFence,
  runWithLoopFence,
  StaleLoopFenceError,
} from "./loop-fence";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
import { createWorkflowCharterService } from "./charter/service";
import { createWorkflowSeededDocumentService } from "./shared-documents";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { captureStoreInventory } from "@/lib/shared/testing/store-inventory";
import { applyDefinitionEdits } from "./definition-edits";
import {
  GraphExecutionContractViolationError,
  type GraphExecutionContract,
} from "./execution-contract-port";
import type { GraphWorkflowArchiveOutcome } from "@/lib/state-store/setters";

interface InMemoryExecutionRepository {
  getActive(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null>;
  create(
    projectPath: string,
    sessionName: string,
    seed: GraphWorkflowExecutionSeed,
    fence?: () => void,
  ): Promise<GraphWorkflowExecution>;
  archiveActive(
    projectPath: string,
    sessionName: string,
    audit?: { reason: string; actor: string | null },
    guard?: (execution: GraphWorkflowExecution) => boolean,
  ): Promise<GraphWorkflowArchiveOutcome>;
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
      | { execution: GraphWorkflowExecution; events: unknown[] },
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
  ownerConversationId: string | null;
  liveSessionReadOnlyPinned: boolean;
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

  // Serialized read-modify-write backing the sync `mutateActive`. It awaits
  // `fn` so a synchronous reducer is applied and its result handled exactly as
  // the production seam does, and enforces the loop fence like the real repo.
  const mutateActiveImpl = async (
    _projectPath: string,
    _sessionName: string,
    fn: (
      execution: GraphWorkflowExecution,
    ) =>
      | GraphWorkflowExecution
      | { execution: GraphWorkflowExecution; events: unknown[] }
      | Promise<
          | GraphWorkflowExecution
          | { execution: GraphWorkflowExecution; events: unknown[] }
        >,
  ): Promise<GraphWorkflowExecution> => {
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
      // Mirror the production repository: reject a superseded loop generation's
      // write against the currently-persisted execution before the reducer runs.
      assertLoopFence(_projectPath, _sessionName, activeExecution);
      const result = await fn(structuredClone(activeExecution));
      activeExecution =
        "execution" in result && "events" in result
          ? result.execution
          : (result as GraphWorkflowExecution);
      return activeExecution;
    } finally {
      release();
    }
  };

  return {
    async getActive() {
      return activeExecution;
    },
    async create(_projectPath, _sessionName, seed, fence) {
      // Where the real repository evaluates it: inside the reserving critical
      // section, before anything is installed. A fenced launch therefore leaves
      // no create call behind here either.
      fence?.();
      // The fake mirrors the real repository's provenance derivation rather
      // than inventing one, so a test that reads back `seedDefinitionId` is
      // reading the same rule production applies.
      const provenance = buildExecutionProvenance(
        seed.source,
        seed.executionId,
      );
      createCalls.push({
        definitionId: provenance.seedDefinitionId,
        definitionRevision: provenance.seedDefinitionRevision,
        executionId: seed.executionId,
        startedAt: seed.startedAt,
        inputs: seed.inputs,
        launchedTier: provenance.launchedTier,
        ownerConversationId: seed.ownerConversationId,
        liveSessionReadOnlyPinned: seed.liveSessionReadOnlyPinned ?? false,
      });
      activeExecution = createWorkflowExecution({
        id: seed.executionId,
        liveSessionReadOnlyPinned: seed.liveSessionReadOnlyPinned ?? false,
        origin: provenance.origin,
        launchDocument: seed.launchDocument,
        seedDefinitionId: provenance.seedDefinitionId,
        seedDefinitionRevision: provenance.seedDefinitionRevision,
        boundInputs: seed.inputs,
        launchedTier: provenance.launchedTier,
        ownerConversationId: seed.ownerConversationId,
        definitionApproval:
          seed.definition.approvalRequired === true
            ? { requestedAt: seed.startedAt, approvedAt: null }
            : null,
        workingDefinition:
          seed.definition as unknown as ResolvedWorkflowSemanticDefinition,
        startedAt: seed.startedAt,
      });
      return activeExecution;
    },
    async archiveActive(): Promise<GraphWorkflowArchiveOutcome> {
      archiveCalls += 1;
      const archived = activeExecution;
      activeExecution = null;
      return archived === null
        ? { archived: false, reason: "no_active" }
        : { archived: true, execution: archived };
    },
    async update(_projectPath, _sessionName, execution) {
      activeExecution = execution;
    },
    mutateActive: mutateActiveImpl,
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

/**
 * The default three-context chain re-authored onto ONE lane — a lane GROUP.
 * Sequential reuse is declared by that shared lane name: the first member to
 * run provisions the worktree, and the members after it inherit it.
 */
function sharedLaneDefinition(): ResolvedWorkflowSemanticDefinition {
  const base = createResolvedWorkflowDefinition();
  return {
    ...base,
    executionContexts: base.executionContexts.map((context) => ({
      ...context,
      placement: { lane: "delivery", mode: "full" as const },
    })),
  };
}

/**
 * Place the named contexts onto one lane, leaving every other context as
 * authored. Lane REUSE is what a shared placement buys, so a test that expects a
 * downstream to land in an upstream's worktree has to say so in the definition.
 */
function withContextsOnLane(
  definition: ResolvedWorkflowSemanticDefinition,
  lane: string,
  contextIds: readonly string[],
): ResolvedWorkflowSemanticDefinition {
  return {
    ...definition,
    executionContexts: definition.executionContexts.map((context) =>
      contextIds.includes(context.id)
        ? { ...context, placement: { lane, mode: "full" as const } }
        : context,
    ),
  };
}

/**
 * A pre-placement definition as its stored-load boundary hands it to the parse:
 * the field stripped the way a legacy document has it, repaired by the same
 * transformer every real load runs, then strictly parsed. The lane name under
 * test is therefore chosen by production, not written by the test.
 */
function inflatePrePlacement(
  definition: ResolvedWorkflowSemanticDefinition,
): ResolvedWorkflowSemanticDefinition {
  const raw = structuredClone(definition) as {
    executionContexts: Array<Record<string, unknown>>;
  };
  for (const context of raw.executionContexts) {
    delete context.placement;
  }
  migrateRawDefinitionPlacement(raw);
  return resolvedWorkflowSemanticDefinitionSchema.parse(raw);
}

/** Rename a context everywhere a definition addresses it. */
function renameContext(
  definition: ResolvedWorkflowSemanticDefinition,
  from: string,
  to: string,
): ResolvedWorkflowSemanticDefinition {
  return {
    ...definition,
    executionContexts: definition.executionContexts.map((context) =>
      context.id === from ? { ...context, id: to } : context,
    ),
    tasks: definition.tasks.map((task) =>
      task.contextId === from ? { ...task, contextId: to } : task,
    ),
    edges: definition.edges.map((edge) => ({
      ...edge,
      ...(edge.sourceContextId === from ? { sourceContextId: to } : {}),
      ...(edge.targetContextId === from ? { targetContextId: to } : {}),
    })),
  };
}

function renameContextState(
  contextStates: GraphWorkflowExecution["contextStates"],
  from: string,
  to: string,
): GraphWorkflowExecution["contextStates"] {
  const { [from]: renamed, ...rest } = contextStates;
  if (renamed === undefined) return contextStates;
  return { ...rest, [to]: { ...renamed, contextId: to } };
}

function regroupedDefinition(approvalRequired = false) {
  const record = createWorkflowDefinitionRecord({
    definition: createWorkflowDefinition({ approvalRequired }),
  });
  const edited = applyDefinitionEdits(record, [
    {
      type: "move-task",
      taskId: "task-implement-1",
      contextId: "context-plan",
      position: { at: "start" },
    },
  ]);
  if (!edited.ok) throw new Error(JSON.stringify(edited.issues));
  return edited.record;
}

/**
 * A registered contract that refuses every definition. The manager must honour
 * a refusal whatever its reason: what is under test is that the seam is
 * consulted before a seed and before an approval, not any one contract's rule.
 */
function refusingContract(): GraphExecutionContract {
  return {
    validateDefinition: () => ({
      ok: false,
      code: "contract_refused",
      issues: [{ code: "contract-refused", message: "The contract refused." }],
      instruction: "Repair the definition at its source.",
    }),
    loadLiveEdit: () => ({
      validateOperation: () => ({ ok: true }),
      accountabilityCoverageGroups: [],
    }),
    validateTaskCompletion: () => ({ ok: true }),
    deriveContextAcceptanceCriteria: () => ({
      ok: true,
      acceptanceCriteriaByContextId: {},
    }),
  };
}

describe("graph workflow manager", () => {
  it("refuses to seed an execution the registered contract rejects", async () => {
    const definition = regroupedDefinition();
    const repository = createRepository();
    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return definition;
      },
      executionContract: refusingContract(),
    });

    await expect(
      manager.start({
        projectPath: "/repo",
        sessionName: "session-1",
        definitionId: definition.id,
      }),
    ).rejects.toMatchObject({
      code: "contract_refused",
    } satisfies Partial<GraphExecutionContractViolationError>);
    expect(repository.createCalls).toHaveLength(0);
  });

  it("revalidates against the registered contract before recording definition approval", async () => {
    const definition = regroupedDefinition(true);
    const pending = createWorkflowExecution({
      status: "pending",
      definitionApproval: {
        requestedAt: "2026-07-18T10:00:00.000Z",
        approvedAt: null,
      },
      workingDefinition: definition.definition as never,
    });
    const repository = createRepository(pending);
    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return definition;
      },
      executionContract: refusingContract(),
    });

    await expect(
      manager.recordDefinitionApproval({
        projectPath: "/repo",
        sessionName: "session-1",
        claimId: "claim-unused",
      }),
    ).rejects.toMatchObject({
      code: "contract_refused",
    } satisfies Partial<GraphExecutionContractViolationError>);
    expect(repository.read()).toMatchObject({
      status: "pending",
      definitionApproval: { approvedAt: null },
    });
  });

  it("atomically refuses definition approval when the active execution changes to another run of the same definition", async () => {
    const expectedPending = createWorkflowExecution({
      id: "execution-expected",
      status: "pending",
      seedDefinitionId: "workflow-def-shared",
      definitionApproval: {
        requestedAt: "2026-07-18T10:00:00.000Z",
        approvedAt: null,
      },
    });
    const replacementPending = createWorkflowExecution({
      id: "execution-replacement",
      status: "pending",
      seedDefinitionId: "workflow-def-shared",
      definitionApproval: {
        requestedAt: "2026-07-18T10:01:00.000Z",
        approvedAt: null,
      },
    });
    const repository = createRepository(replacementPending);
    const manager = createGraphWorkflowManager({
      executionRepository: {
        ...repository,
        async getActive() {
          return expectedPending;
        },
      },
      async loadDefinition() {
        return null;
      },
      now() {
        return "2026-07-18T10:02:00.000Z";
      },
    });

    const result = await manager.recordDefinitionApproval({
      projectPath: "/repo",
      sessionName: "session-1",
      expectedExecutionId: "execution-expected",
      claimId: "claim-unused",
    });

    expect(result).toEqual({ ok: false, reason: "execution_mismatch" });
    expect(repository.read()).toMatchObject({
      id: "execution-replacement",
      status: "pending",
      definitionApproval: { approvedAt: null },
    });
  });

  it("refuses an approval-required definition until the first atomic approval starts its pending execution", async () => {
    const definition = createWorkflowDefinitionRecord({
      definition: createWorkflowDefinition({ approvalRequired: true }),
    });
    const repository = createRepository();
    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return definition;
      },
      now() {
        return "2026-07-18T10:00:00.000Z";
      },
      createExecutionId() {
        return "execution-awaiting-definition-approval";
      },
    });

    // A park is an ACCEPTED launch (D7 R14): the outcome reports it, and the
    // pending execution is durable rather than an error the caller has to
    // decode.
    const parked = await manager.start({
      projectPath: "/repo",
      sessionName: "session-1",
      definitionId: definition.id,
    });
    expect(parked.awaitingDefinitionApproval).toBe(true);
    expect(parked.execution).toMatchObject({
      id: "execution-awaiting-definition-approval",
      status: "pending",
    });

    expect(repository.read()).toMatchObject({
      id: "execution-awaiting-definition-approval",
      status: "pending",
      definitionApproval: {
        requestedAt: "2026-07-18T10:00:00.000Z",
        approvedAt: null,
      },
      machineSnapshot: null,
    });

    // Two humans approve at once. The RESERVATION is where that race is
    // settled — before either act can talk to the admission consumer — so
    // exactly one of them owns the decision from here on.
    const [first, second] = await Promise.all([
      manager.claimDefinitionApproval({
        projectPath: "/repo",
        sessionName: "session-1",
      }),
      manager.claimDefinitionApproval({
        projectPath: "/repo",
        sessionName: "session-1",
      }),
    ]);

    expect([first, second].filter((result) => result.ok)).toHaveLength(1);
    expect([first, second].filter((result) => !result.ok)).toEqual([
      { ok: false, reason: "decision_in_flight" },
    ]);

    const winner = [first, second].find((result) => result.ok);
    if (winner === undefined || !winner.ok) {
      throw new Error("neither approval reserved the decision");
    }
    await manager.recordDefinitionApproval({
      projectPath: "/repo",
      sessionName: "session-1",
      claimId: winner.claimId,
    });

    expect(repository.read()).toMatchObject({
      status: "running",
      definitionApproval: {
        requestedAt: "2026-07-18T10:00:00.000Z",
        approvedAt: "2026-07-18T10:00:00.000Z",
      },
      machineSnapshot: {
        lifecycleStatus: "running",
      },
    });
  });

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

    const { execution } = await manager.start({
      projectPath: "/repo",
      sessionName: "session-1",
      definitionId: definition.id,
    });

    expect(execution.id).toBe("execution-started");
    expect(execution.status).toBe("running");
    expect(execution.seedDefinitionId).toBe(definition.id);
    expect(execution.seedDefinitionRevision).toBe(3);
    expect(execution.definitionApproval).toBeNull();
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

      const { execution } = await manager.start({
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

      const { execution } = await manager.start({
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

    it("threads the start input's ownerConversationId onto the persisted execution", async () => {
      const loadCalls: Array<{ definitionId: string; tier: TemplateTier }> = [];
      const manager = buildManager({
        tierDefinitions: {
          project: createWorkflowDefinitionRecord({ id: "project-def" }),
          global: createWorkflowDefinitionRecord({ id: "global-def" }),
        },
        loadCalls,
      });

      const { execution } = await manager.start({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        definitionId: "project-def",
        ownerConversationId: "conv-owner",
      });

      expect(execution.ownerConversationId).toBe("conv-owner");

      const reloaded = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      );
      expect(reloaded?.ownerConversationId).toBe("conv-owner");
    });

    it("persists a null owner when the start seam captured no conversation", async () => {
      const loadCalls: Array<{ definitionId: string; tier: TemplateTier }> = [];
      const manager = buildManager({
        tierDefinitions: {
          project: createWorkflowDefinitionRecord({ id: "project-def" }),
          global: createWorkflowDefinitionRecord({ id: "global-def" }),
        },
        loadCalls,
      });

      await manager.start({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        definitionId: "project-def",
      });

      const reloaded = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      );
      expect(reloaded?.ownerConversationId).toBeNull();
    });
  });

  /**
   * The launch/finalization race (R13), over the REAL repository and the REAL
   * reserving transaction.
   *
   * The advisory guard reads the job registry and then rides a long async
   * gauntlet — dirty probe, source resolution, prerequisite preflight, input
   * validation — before the lease is reserved. A merge that registers anywhere
   * in that window reads no lease under its own project lock, so BOTH would be
   * admitted and the session would end up finished with a Current run in it.
   *
   * The fence closes it: the same reader is consulted again INSIDE the
   * reserving transaction, which is the same synchronous section that installs
   * the lease. Registration is synchronous too, so on one event loop the two
   * orders are exhaustive — either the lease is committed before the merge
   * registers (and the merge's in-lock read sees it), or the merge is
   * registered before the fence runs (and the launch refuses here).
   */
  describe("launch fences against a merge that registers mid-gauntlet", () => {
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

    function buildManager(input: {
      readSessionFinalizingMerge(): {
        jobId: string;
        branchName: string;
      } | null;
      /** Runs mid-gauntlet: after the advisory check, before the reservation. */
      onDefinitionLoad?(): void;
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
        charterService,
        readConfig: async () => ({}) as GlobalConfig,
      });
      return createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          input.onDefinitionLoad?.();
          return createWorkflowDefinitionRecord({ id: "project-def" });
        },
        async readSessionWorktreeDirtyPaths() {
          return [];
        },
        readSessionFinalizingMerge: input.readSessionFinalizingMerge,
        now: () => "2026-08-14T09:00:00.000Z",
        createExecutionId: () => "execution-raced",
      });
    }

    function startInput() {
      return {
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        definitionId: "project-def",
      };
    }

    it("refuses and commits nothing when the merge registers after the advisory check", async () => {
      let finalizing: { jobId: string; branchName: string } | null = null;
      const manager = buildManager({
        // The merge registers while the launch is still resolving its source:
        // the advisory read already returned null.
        onDefinitionLoad() {
          finalizing = { jobId: "job-late", branchName: "csm/session-1" };
        },
        readSessionFinalizingMerge: () => finalizing,
      });

      await expect(manager.start(startInput())).rejects.toMatchObject({
        guard: "session_finalizing",
      });

      // Reloaded from the store: a fenced launch is a race loser, and a race
      // loser writes nothing at all.
      expect(
        await fixture.store.getActiveGraphWorkflowExecution(
          PROJECT_PATH,
          SESSION_NAME,
        ),
      ).toBeNull();
      expect(
        await fixture.store.listArchivedGraphWorkflowExecutions(
          PROJECT_PATH,
          SESSION_NAME,
        ),
      ).toHaveLength(0);
    });

    it("leaves a lease-free incumbent unnormalized when the fence refuses", async () => {
      const incumbent = createWorkflowExecution({
        id: "wf-completed",
        status: "completed",
      });
      fixture.db
        .prepare(
          `INSERT INTO graph_workflow_executions (
             project_path, session_name, execution_id, seed_definition_id,
             seed_definition_revision, started_at, status, completed_at,
             definition_json, runtime_json, updated_at, lease_held
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          PROJECT_PATH,
          SESSION_NAME,
          incumbent.id,
          incumbent.seedDefinitionId,
          incumbent.seedDefinitionRevision,
          incumbent.startedAt,
          incumbent.status,
          incumbent.completedAt,
          "{}",
          JSON.stringify(incumbent),
          "2026-08-14T08:00:00.000Z",
          0,
        );

      let finalizing: { jobId: string; branchName: string } | null = null;
      const manager = buildManager({
        onDefinitionLoad() {
          finalizing = { jobId: "job-late", branchName: "csm/session-1" };
        },
        readSessionFinalizingMerge: () => finalizing,
      });

      await expect(manager.start(startInput())).rejects.toMatchObject({
        guard: "session_finalizing",
      });

      // Normalization is the winner's act. A fenced launch relocates nothing,
      // so History stays empty and the incumbent keeps its position.
      const reloaded = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      );
      expect(reloaded?.id).toBe("wf-completed");
      expect(
        await fixture.store.listArchivedGraphWorkflowExecutions(
          PROJECT_PATH,
          SESSION_NAME,
        ),
      ).toHaveLength(0);
    });

    it("admits the launch when no merge registers during the gauntlet", async () => {
      const manager = buildManager({
        readSessionFinalizingMerge: () => null,
      });

      const { execution } = await manager.start(startInput());

      expect(execution.id).toBe("execution-raced");
      expect(
        (
          await fixture.store.getActiveGraphWorkflowExecution(
            PROJECT_PATH,
            SESSION_NAME,
          )
        )?.id,
      ).toBe("execution-raced");
    });
  });

  /**
   * One gauntlet, two origins (D7 R1.1, R2.2, decision D1).
   *
   * These launch the SAME authored content twice — once from a saved template
   * and once inline — over the REAL repository, the REAL store, and the REAL
   * file-backed definition storage under a temp config dir. Comparing the two
   * resulting records is what makes validation and cascade parity a fact rather
   * than a claim about code structure: if the inline path ever grew its own
   * resolution, seeding, or approval handling, the two snapshots would diverge.
   *
   * The definition store is byte-compared around the inline launch for the same
   * reason: "writes no template" has to be checked against the store the
   * template arm demonstrably reads from, not against a stub nobody uses.
   */
  describe("template and inline launches share one gauntlet", () => {
    const PROJECT_PATH = "/repo";
    const TEMPLATE_SESSION = "session-template";
    const INLINE_SESSION = "session-inline";

    let fixture: PersistenceFixture;
    let configDir: string;

    beforeEach(async () => {
      fixture = createPersistenceFixture();
      fixture.seedProject(PROJECT_PATH);
      fixture.seedSession(PROJECT_PATH, TEMPLATE_SESSION);
      fixture.seedSession(PROJECT_PATH, INLINE_SESSION);
      configDir = await mkdtemp(nodePath.join(tmpdir(), "launch-parity-"));
    });

    afterEach(async () => {
      fixture.close();
      await rm(configDir, { recursive: true, force: true });
    });

    function authoredPlan() {
      return {
        name: "Shared authored content",
        description: "Launched once as a template and once inline",
        definition: createWorkflowDefinition(),
        layout: createWorkflowLayout(),
      };
    }

    /**
     * The manager over production wiring: the real execution repository on the
     * fixture's store, and `loadDefinition` resolved through the REAL
     * file-backed storage service scoped to a temp config dir.
     */
    function buildParityManager(
      loadCalls: string[],
      /** A dirty session worktree, for the R8 exemption's parity case. */
      dirtyPaths: DirtyPath[] = [],
      /**
       * What the REPOSITORY reads when it builds the definition it persists —
       * separate from the manager's own read on purpose, because in production
       * they are two reads of live config that can disagree.
       */
      repositoryGlobalConfig: GlobalConfig = {} as GlobalConfig,
    ) {
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
        charterService,
        readConfig: async () => repositoryGlobalConfig,
      });
      return createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition(projectPath, definitionId, tier) {
          loadCalls.push(definitionId);
          return definitionStorage().get(
            scopeForTier(tier, projectPath),
            definitionId,
          );
        },
        now: () => "2026-08-13T00:00:00.000Z",
        createExecutionId: () => `execution-${loadCalls.length}`,
        getSession: fixture.store.getSession,
        readSessionWorktreeDirtyPaths: async () => dirtyPaths,
        readGlobalConfig: async () => ({}) as GlobalConfig,
        preflightService: {
          async evaluate() {
            return { status: "ok" };
          },
        },
      });
    }

    function definitionStorage() {
      return createWorkflowStorageService({
        resolveConfigDir: () => configDir,
        listActiveExecutions: async () => new Map(),
      });
    }

    /** Every file under the definition store, path → bytes. */
    async function snapshotDefinitionStore(): Promise<Record<string, string>> {
      const snapshot: Record<string, string> = {};
      async function walk(dir: string, prefix: string): Promise<void> {
        const entries = await readdir(dir, { withFileTypes: true }).catch(
          () => [],
        );
        for (const entry of entries) {
          const child = nodePath.join(dir, entry.name);
          const key = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
          if (entry.isDirectory()) {
            await walk(child, key);
          } else {
            snapshot[key] = await readFile(child, "utf-8");
          }
        }
      }
      await walk(configDir, "");
      return snapshot;
    }

    it("resolves an identical working definition from a template and from the same content inline (R2.2)", async () => {
      const loadCalls: string[] = [];
      const manager = buildParityManager(loadCalls);
      const plan = authoredPlan();
      const record = await definitionStorage().create(
        scopeForTier("project", PROJECT_PATH),
        plan,
      );

      const fromTemplate = await manager.start({
        projectPath: PROJECT_PATH,
        sessionName: TEMPLATE_SESSION,
        definitionId: record.id,
      });
      const fromInline = await manager.run({
        projectPath: PROJECT_PATH,
        sessionName: INLINE_SESSION,
        plan,
      });

      // The cascade, assignment snapshots, and selector freeze all landed on
      // the same bytes — the one thing R2.2 asks about.
      expect(fromInline.execution.workingDefinition).toEqual(
        fromTemplate.execution.workingDefinition,
      );
      expect(fromInline.execution.charter).toEqual(
        fromTemplate.execution.charter,
      );
      expect(fromInline.execution.contextStates).toEqual(
        fromTemplate.execution.contextStates,
      );
      expect(fromInline.execution.taskStates).toEqual(
        fromTemplate.execution.taskStates,
      );
      // Provenance is the ONLY difference the two records may carry.
      expect(fromTemplate.execution.origin).toEqual({
        kind: "template",
        definitionId: record.id,
        definitionRevision: record.revision,
        tier: "project",
      });
      expect(fromInline.execution.origin).toEqual({
        kind: "one_off",
        planName: plan.name,
      });
    });

    it("admits both origins over a dirty worktree when the resolved run is wholly live-session read-only, and durably pins each (R8.2)", async () => {
      const loadCalls: string[] = [];
      const manager = buildParityManager(loadCalls, [
        { path: "src/edited.ts", statusCode: " M", tracked: true },
      ]);
      const readOnlyContexts: GraphWorkflowExecutionContextDefinition[] = [
        {
          id: "inspect",
          title: "Inspect",
          acceptanceCriteria: "The worktree is described",
          placement: { lane: SESSION_LANE_NAME, mode: "readOnly" },
          outputSchema: {
            type: "object",
            properties: { summary: { type: "string" } },
            required: ["summary"],
            additionalProperties: false,
          },
        },
      ];
      const plan = {
        ...authoredPlan(),
        definition: createWorkflowDefinition({
          executionContexts: readOnlyContexts,
          tasks: [
            {
              id: "task-inspect-1",
              contextId: "inspect",
              order: 1,
              title: "Read the worktree",
              instructions: "Read the uncommitted changes and report.",
              source: "user" as const,
            },
          ],
          edges: [],
        }),
      };
      const record = await definitionStorage().create(
        scopeForTier("project", PROJECT_PATH),
        plan,
      );

      await manager.start({
        projectPath: PROJECT_PATH,
        sessionName: TEMPLATE_SESSION,
        definitionId: record.id,
      });
      await manager.run({
        projectPath: PROJECT_PATH,
        sessionName: INLINE_SESSION,
        plan,
      });

      // Reloaded through the repository: the pin is what every later structural
      // mutation is judged against, so it has to survive the write.
      const templateRow = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        TEMPLATE_SESSION,
      );
      const inlineRow = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        INLINE_SESSION,
      );
      expect(templateRow?.liveSessionReadOnlyPinned).toBe(true);
      expect(inlineRow?.liveSessionReadOnlyPinned).toBe(true);
    });

    it("refuses a dirty launch whose global defaults turned write-capable between the guard's read and the seed's, pinning nothing (R8.1)", async () => {
      // The two config reads are the production reality: the guard proves
      // eligibility against one, the repository builds the definition it
      // persists from another. Here they disagree — the guard sees a clean
      // cascade and admits, and the seed-time cascade enables collaboration on
      // every context. A pin may not outlive the property it asserts.
      const loadCalls: string[] = [];
      const manager = buildParityManager(
        loadCalls,
        [{ path: "src/edited.ts", statusCode: " M", tracked: true }],
        {
          workflowDefaults: {
            ...SEEDED_WORKFLOW_DEFAULTS,
            collaboration: {
              ...SEEDED_WORKFLOW_DEFAULTS.collaboration,
              enabled: true,
            },
          },
        } as GlobalConfig,
      );
      const readOnlyContexts: GraphWorkflowExecutionContextDefinition[] = [
        {
          id: "inspect",
          title: "Inspect",
          acceptanceCriteria: "The worktree is described",
          placement: { lane: SESSION_LANE_NAME, mode: "readOnly" },
          outputSchema: {
            type: "object",
            properties: { summary: { type: "string" } },
            required: ["summary"],
            additionalProperties: false,
          },
        },
      ];
      const plan = {
        ...authoredPlan(),
        definition: createWorkflowDefinition({
          executionContexts: readOnlyContexts,
          tasks: [
            {
              id: "task-inspect-1",
              contextId: "inspect",
              order: 1,
              title: "Read the worktree",
              instructions: "Read the uncommitted changes and report.",
              source: "user" as const,
            },
          ],
          edges: [],
        }),
      };
      const record = await definitionStorage().create(
        scopeForTier("project", PROJECT_PATH),
        plan,
      );

      await expect(
        manager.start({
          projectPath: PROJECT_PATH,
          sessionName: TEMPLATE_SESSION,
          definitionId: record.id,
        }),
      ).rejects.toMatchObject({
        name: "GraphWorkflowValidationError",
        errors: [
          expect.objectContaining({
            code: "live-session-read-only-collaboration",
            contextId: "inspect",
          }),
        ],
      });

      expect(
        await fixture.store.getActiveGraphWorkflowExecution(
          PROJECT_PATH,
          TEMPLATE_SESSION,
        ),
      ).toBeNull();
    });

    it("snapshots the authored launch document on both origins (D13)", async () => {
      const loadCalls: string[] = [];
      const manager = buildParityManager(loadCalls);
      const plan = authoredPlan();
      const record = await definitionStorage().create(
        scopeForTier("project", PROJECT_PATH),
        plan,
      );

      await manager.start({
        projectPath: PROJECT_PATH,
        sessionName: TEMPLATE_SESSION,
        definitionId: record.id,
      });
      await manager.run({
        projectPath: PROJECT_PATH,
        sessionName: INLINE_SESSION,
        plan,
      });

      // Reloaded through the repository: History renders from what is DURABLE,
      // not from what the launch call happened to return.
      const templateRow = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        TEMPLATE_SESSION,
      );
      const inlineRow = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        INLINE_SESSION,
      );
      // The template arm snapshots the RECORD's four fields, which is why the
      // layout carries the stored workflow id rather than the authored one.
      expect(templateRow?.launchDocument).toEqual({
        name: record.name,
        description: record.description,
        definition: record.definition,
        layout: record.layout,
      });
      expect(inlineRow?.launchDocument).toEqual({
        name: plan.name,
        description: plan.description,
        definition: plan.definition,
        layout: plan.layout,
      });
    });

    it("creates exactly one one-off execution and writes no definition anywhere (R1.1)", async () => {
      const loadCalls: string[] = [];
      const manager = buildParityManager(loadCalls);
      const plan = authoredPlan();
      // A real stored template first, so the byte-compare below runs against a
      // store this manager demonstrably reads and writes.
      await definitionStorage().create(scopeForTier("project", PROJECT_PATH), {
        ...plan,
        name: "An unrelated saved template",
      });
      const before = await snapshotDefinitionStore();
      const projectDefinitionsBefore = await definitionStorage().list(
        scopeForTier("project", PROJECT_PATH),
      );
      const globalDefinitionsBefore = await definitionStorage().list(
        scopeForTier("global", PROJECT_PATH),
      );

      const launched = await manager.run({
        projectPath: PROJECT_PATH,
        sessionName: INLINE_SESSION,
        plan,
      });

      expect(await snapshotDefinitionStore()).toEqual(before);
      expect(
        await definitionStorage().list(scopeForTier("project", PROJECT_PATH)),
      ).toEqual(projectDefinitionsBefore);
      expect(
        await definitionStorage().list(scopeForTier("global", PROJECT_PATH)),
      ).toEqual(globalDefinitionsBefore);
      // Saved-definition lookup belongs to the template branch alone.
      expect(loadCalls).toEqual([]);

      const row = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        INLINE_SESSION,
      );
      expect(row?.id).toBe(launched.execution.id);
      expect(row?.origin).toEqual({ kind: "one_off", planName: plan.name });
      // The legacy-shaped filler names no stored definition, which is what lets
      // an older reader parse the row without resolving anything.
      expect(row?.seedDefinitionId).toBe(`one-off:${launched.execution.id}`);
      expect(
        projectDefinitionsBefore.some(
          (summary) => summary.id === row?.seedDefinitionId,
        ),
      ).toBe(false);
    });

    it("creates a spec-delivery execution carrying spec provenance, filler, and the authored launch document", async () => {
      const loadCalls: string[] = [];
      const manager = buildParityManager(loadCalls);
      const plan = authoredPlan();
      const before = await snapshotDefinitionStore();

      const launched = await manager.launchSpecDelivery({
        projectPath: PROJECT_PATH,
        sessionName: INLINE_SESSION,
        plan,
        specSlug: "conversation-compaction",
        candidateId: "cand-42",
      });

      // A spec delivery persists no template and resolves none (R1.1 parity).
      expect(await snapshotDefinitionStore()).toEqual(before);
      expect(loadCalls).toEqual([]);

      const row = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        INLINE_SESSION,
      );
      expect(row?.id).toBe(launched.execution.id);
      expect(row?.origin).toEqual({
        kind: "spec_delivery",
        specSlug: "conversation-compaction",
        candidateId: "cand-42",
      });
      expect(row?.seedDefinitionId).toBe(
        `spec-delivery:${launched.execution.id}`,
      );
      expect(row?.launchDocument).toEqual({
        name: plan.name,
        description: plan.description,
        definition: plan.definition,
        layout: plan.layout,
      });
    });

    /**
     * Inline parameter binding (D7 R1.3).
     *
     * The plan document and the inputs document are separate channels, and the
     * binding rules are the template rules — supplied, defaulted, missing, and
     * undeclared all behave the same on both verbs. Refusals are checked against
     * the WHOLE store rather than against the execution table alone: a located
     * input error has to be produced before the lease is reserved, so nothing at
     * all may exist afterwards.
     */
    describe("inline inputs bind exactly as template inputs do", () => {
      function parameterizedPlan() {
        return {
          ...authoredPlan(),
          definition: createWorkflowDefinition({
            parameters: [
              {
                type: "string" as const,
                name: "ticket",
                label: "Ticket",
                required: true,
              },
              {
                type: "string" as const,
                name: "severity",
                label: "Severity",
                required: false,
                default: "low",
              },
            ],
          }),
        };
      }

      it("binds a supplied required value and a declared default, and persists both", async () => {
        const manager = buildParityManager([]);
        const plan = parameterizedPlan();

        const launched = await manager.run({
          projectPath: PROJECT_PATH,
          sessionName: INLINE_SESSION,
          plan,
          inputs: { ticket: "CC-42" },
        });

        expect(launched.execution.boundInputs).toEqual({
          ticket: "CC-42",
          severity: "low",
        });
        const row = await fixture.store.getActiveGraphWorkflowExecution(
          PROJECT_PATH,
          INLINE_SESSION,
        );
        expect(row?.boundInputs).toEqual({
          ticket: "CC-42",
          severity: "low",
        });
      });

      it.each([
        {
          label: "a missing required input",
          inputs: {},
          expected: { kind: "missing_required", name: "ticket" },
        },
        {
          label: "an undeclared input name",
          inputs: { ticket: "CC-42", nope: "x" },
          expected: { kind: "unknown_parameter", name: "nope" },
        },
      ])(
        "refuses $label and reserves nothing",
        async ({ inputs, expected }) => {
          const manager = buildParityManager([]);
          const before = captureStoreInventory(fixture.db);

          let caught: unknown;
          try {
            await manager.run({
              projectPath: PROJECT_PATH,
              sessionName: INLINE_SESSION,
              plan: parameterizedPlan(),
              inputs,
            });
          } catch (error) {
            caught = error;
          }

          expect(caught).toBeInstanceOf(WorkflowStartInputError);
          expect((caught as WorkflowStartInputError).inputError).toMatchObject(
            expected,
          );
          expect(captureStoreInventory(fixture.db)).toEqual(before);
        },
      );

      it("binds identical values whether the same content launches as a template or inline", async () => {
        const manager = buildParityManager([]);
        const plan = parameterizedPlan();
        const record = await definitionStorage().create(
          scopeForTier("project", PROJECT_PATH),
          plan,
        );

        const fromTemplate = await manager.start({
          projectPath: PROJECT_PATH,
          sessionName: TEMPLATE_SESSION,
          definitionId: record.id,
          parameters: { ticket: "CC-42" },
        });
        const fromInline = await manager.run({
          projectPath: PROJECT_PATH,
          sessionName: INLINE_SESSION,
          plan,
          inputs: { ticket: "CC-42" },
        });

        expect(fromInline.execution.boundInputs).toEqual(
          fromTemplate.execution.boundInputs,
        );
        // Substitution happened before resolution on both paths, so the
        // bound values are visible in the same places in the working graph.
        expect(fromInline.execution.workingDefinition).toEqual(
          fromTemplate.execution.workingDefinition,
        );
      });
    });

    /**
     * Approval parity (D7 R14.1). One-off origin adds no approval and removes
     * none: the authored `approvalRequired` decides, and the park it produces
     * is an accepted launch holding the session's lease on both verbs.
     */
    describe("approvalRequired parks identically on both origins", () => {
      it("parks a launch that authored approvalRequired, holding the lease", async () => {
        const manager = buildParityManager([]);
        const plan = {
          ...authoredPlan(),
          definition: createWorkflowDefinition({ approvalRequired: true }),
        };
        const record = await definitionStorage().create(
          scopeForTier("project", PROJECT_PATH),
          plan,
        );

        const fromTemplate = await manager.start({
          projectPath: PROJECT_PATH,
          sessionName: TEMPLATE_SESSION,
          definitionId: record.id,
        });
        const fromInline = await manager.run({
          projectPath: PROJECT_PATH,
          sessionName: INLINE_SESSION,
          plan,
        });

        for (const outcome of [fromTemplate, fromInline]) {
          expect(outcome.awaitingDefinitionApproval).toBe(true);
          expect(outcome.execution.status).toBe("pending");
          expect(outcome.execution.definitionApproval).toMatchObject({
            approvedAt: null,
          });
          // A park is Current, not History: it holds the session's one lease
          // until a human decides (R3, R14.1).
          expect(
            holdsExecutionLease(
              outcome.execution.status,
              outcome.execution.haltReason,
              outcome.execution.abandonment,
            ),
          ).toBe(true);
        }

        // Durable, not merely returned.
        const inlineRow = await fixture.store.getActiveGraphWorkflowExecution(
          PROJECT_PATH,
          INLINE_SESSION,
        );
        expect(inlineRow?.status).toBe("pending");
        expect(inlineRow?.definitionApproval).toMatchObject({
          approvedAt: null,
        });
      });

      it("starts the same plan with no park when approvalRequired is absent", async () => {
        const manager = buildParityManager([]);
        const plan = authoredPlan();
        const record = await definitionStorage().create(
          scopeForTier("project", PROJECT_PATH),
          plan,
        );

        const fromTemplate = await manager.start({
          projectPath: PROJECT_PATH,
          sessionName: TEMPLATE_SESSION,
          definitionId: record.id,
        });
        const fromInline = await manager.run({
          projectPath: PROJECT_PATH,
          sessionName: INLINE_SESSION,
          plan,
        });

        for (const outcome of [fromTemplate, fromInline]) {
          expect(outcome.awaitingDefinitionApproval).toBe(false);
          expect(outcome.execution.status).toBe("running");
          expect(outcome.execution.definitionApproval).toBeNull();
        }
      });
    });

    it("refuses an unmet prerequisite identically on both origins", async () => {
      const plan = authoredPlan();
      const eventPublisher = createGraphWorkflowExecutionEventPublisher({
        broadcast: () => {},
        dispatchPush: () => {},
      });
      const repository = createGraphWorkflowExecutionRepository({
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
        charterService: createWorkflowCharterService({
          writeFile: async () => {},
          ensureDir: async () => {},
          publishCharterRegistered: eventPublisher.publishCharterRegistered,
        }),
        readConfig: async () => ({}) as GlobalConfig,
      });
      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return createWorkflowDefinitionRecord({
            id: "prereq-def",
            definition: plan.definition,
          });
        },
        getSession: fixture.store.getSession,
        readSessionWorktreeDirtyPaths: async () => [],
        readGlobalConfig: async () => ({}) as GlobalConfig,
        preflightService: {
          async evaluate() {
            return {
              status: "prerequisites_unmet",
              missing: [
                { kind: "path", path: ".kiro", label: null, reason: "absent" },
              ],
            };
          },
        },
        now: () => "2026-08-13T00:00:00.000Z",
        createExecutionId: () => "execution-prereq",
      });

      await expect(
        manager.start({
          projectPath: PROJECT_PATH,
          sessionName: TEMPLATE_SESSION,
          definitionId: "prereq-def",
        }),
      ).rejects.toBeInstanceOf(WorkflowPrerequisitesUnmetError);
      await expect(
        manager.run({
          projectPath: PROJECT_PATH,
          sessionName: INLINE_SESSION,
          plan,
        }),
      ).rejects.toBeInstanceOf(WorkflowPrerequisitesUnmetError);

      // Neither refusal seeded anything.
      expect(
        await fixture.store.getActiveGraphWorkflowExecution(
          PROJECT_PATH,
          INLINE_SESSION,
        ),
      ).toBeNull();
    });
  });

  /**
   * Crash-time artifact repair (D7 R3.4). The lease CAS deliberately commits
   * before any `.cc` write, so a run can be durable while its charter and
   * seeded documents are not. These wire the manager over the REAL repository
   * and the REAL store, fail the first materialization, and then assert that a
   * kickoff path repairs the worktree from what outlived the failure — a
   * JS-object fake could not prove the contents survived at all.
   */
  describe("kickoff repairs a launch whose artifacts never reached disk", () => {
    const PROJECT_PATH = "/repo";
    const SESSION_NAME = "session-1";
    const SEEDED_PATH = ".cc/graph-workflow-docs/spec.md";

    let fixture: PersistenceFixture;

    beforeEach(() => {
      fixture = createPersistenceFixture();
      fixture.seedProject(PROJECT_PATH);
      fixture.seedSession(PROJECT_PATH, SESSION_NAME, {
        worktreePath: "/repo/.worktrees/session-1",
      });
    });

    afterEach(() => {
      fixture.close();
    });

    function buildManager(input: { failWrites: { value: boolean } }) {
      const writes: string[] = [];
      const eventPublisher = createGraphWorkflowExecutionEventPublisher({
        broadcast: () => {},
        dispatchPush: () => {},
      });
      const writeFile = async (absolutePath: string) => {
        if (input.failWrites.value) {
          throw new Error("materialization failed: disk is full");
        }
        writes.push(absolutePath);
      };
      const charterService = createWorkflowCharterService({
        writeFile,
        ensureDir: async () => {},
        publishCharterRegistered: eventPublisher.publishCharterRegistered,
      });
      const seededDocumentService = createWorkflowSeededDocumentService({
        writeFile,
        ensureDir: async () => {},
        store: {
          async captureFromWorktree() {},
          async read() {
            return null;
          },
        },
      });
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
        getGraphWorkflowPendingArtifacts:
          fixture.store.getGraphWorkflowPendingArtifacts,
        clearGraphWorkflowPendingArtifacts:
          fixture.store.clearGraphWorkflowPendingArtifacts,
        eventPublisher,
        charterService,
        seededDocumentService,
        readConfig: async () => ({}) as GlobalConfig,
      });
      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return createWorkflowDefinitionRecord({ id: "project-def" });
        },
        now() {
          return "2026-06-21T00:00:00.000Z";
        },
        createExecutionId() {
          return "execution-crashed";
        },
      });
      return { manager, writes };
    }

    async function startWithFailedMaterialization(failWrites: {
      value: boolean;
    }) {
      const built = buildManager({ failWrites });
      await expect(
        built.manager.start({
          projectPath: PROJECT_PATH,
          sessionName: SESSION_NAME,
          definitionId: "project-def",
          seededDocuments: [
            {
              relativePath: SEEDED_PATH,
              contents: "# spec",
              description: "the spec",
              readWhen: "before implementing",
            },
          ],
        }),
      ).rejects.toThrow(/disk is full/);
      failWrites.value = false;
      built.writes.length = 0;
      return built;
    }

    it("rewrites the missing documents when the halted run is resumed", async () => {
      const failWrites = { value: true };
      const { manager, writes } =
        await startWithFailedMaterialization(failWrites);

      await manager.resume(PROJECT_PATH, SESSION_NAME);

      expect(writes.some((file) => file.endsWith(SEEDED_PATH))).toBe(true);
      // Settled, so the next resume does not rewrite files it already repaired.
      expect(
        await fixture.store.getGraphWorkflowPendingArtifacts(
          PROJECT_PATH,
          SESSION_NAME,
          "execution-crashed",
        ),
      ).toBeNull();
    });

    /**
     * Normalization addresses the SESSION's active row, so a caller that means
     * one particular run — plan repair resuming the run it just repaired — has
     * to say so. Without the fence, an abandon-plus-relaunch in that window
     * lets the repair of execution X repair X's artifacts onto, and normalize
     * the running state of, successor Y before the fenced resume refuses.
     */
    it("repairs and normalizes nothing when the fenced run no longer holds the row", async () => {
      const failWrites = { value: true };
      const { manager, writes } =
        await startWithFailedMaterialization(failWrites);
      await fixture.store.mutateActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
        "test.simulate-crashed-running",
        (current) => {
          const execution = { ...current!, status: "running" as const };
          return { execution, events: [] };
        },
      );
      const before = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      );

      const fenced = await manager.normalizeAfterRestart(
        PROJECT_PATH,
        SESSION_NAME,
        { expectedExecutionId: "execution-successor" },
      );

      expect(fenced).toBeNull();
      expect(writes).toEqual([]);
      const after = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      );
      expect(after?.status).toBe("running");
      // Write-free, not merely status-preserving: a reducer that returns the
      // row it was handed still commits and still advances the fence.
      expect(after?.executionStateRevision).toBe(
        before?.executionStateRevision,
      );

      // The same call for the run that DOES hold the row still does its work,
      // so the fence is an identity check rather than a blanket refusal.
      const admitted = await manager.normalizeAfterRestart(
        PROJECT_PATH,
        SESSION_NAME,
        { expectedExecutionId: "execution-crashed" },
      );
      expect(admitted?.id).toBe("execution-crashed");
      expect(writes.some((file) => file.endsWith(SEEDED_PATH))).toBe(true);
    });

    it("rewrites the missing documents when a restart normalizes the run", async () => {
      const failWrites = { value: true };
      const { manager, writes } =
        await startWithFailedMaterialization(failWrites);
      // The crash this models left the row `running`: the process died between
      // the reserving commit and the writes, so nothing ever halted it.
      await fixture.store.mutateActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
        "test.simulate-crashed-running",
        (current) => {
          const execution = { ...current!, status: "running" as const };
          return { execution, events: [] };
        },
      );

      await manager.normalizeAfterRestart(PROJECT_PATH, SESSION_NAME);

      expect(writes.some((file) => file.endsWith(SEEDED_PATH))).toBe(true);
      expect(
        await fixture.store.getGraphWorkflowPendingArtifacts(
          PROJECT_PATH,
          SESSION_NAME,
          "execution-crashed",
        ),
      ).toBeNull();
    });
  });

  /**
   * A definition decision that loses its race writes nothing (D7 R14.2,
   * `reserve-before-side-effects`).
   *
   * Both acts read the row advisorily, then decide inside the serialized
   * mutation — and the row can turn over in between. The loser must come away
   * with no committed write and no filesystem effect: the seam stamps
   * `executionStateRevision` on every reducer return, so a refusal that hands
   * back the row it was given has written to the run it just declined to act
   * on, and an artifact repair taken on the stale snapshot has materialized
   * files for a decision that never happened.
   *
   * Wired over the REAL repository and store so the staging fence is the one
   * production stamps; a JS-object fake stamps nothing and would stay green.
   */
  describe("definition decisions are write-free when they lose", () => {
    const PROJECT_PATH = "/repo";
    const SESSION_NAME = "session-1";
    const SEEDED_PATH = ".cc/graph-workflow-docs/spec.md";

    let fixture: PersistenceFixture;

    beforeEach(() => {
      fixture = createPersistenceFixture();
      fixture.seedProject(PROJECT_PATH);
      fixture.seedSession(PROJECT_PATH, SESSION_NAME, {
        worktreePath: "/repo/.worktrees/session-1",
      });
    });

    afterEach(() => {
      fixture.close();
    });

    /**
     * The harness can arm a racing writer that fires once, after the next
     * repository read hands back its snapshot — the window between an act's
     * advisory read and the serialized write that read authorized. Armed after
     * the park so the launch's own reads are not the ones raced.
     */
    function buildHarness(input: {
      failWrites: { value: boolean };
      /** Movable clock, for the acts whose behavior depends on elapsed time. */
      clock?: { value: string };
    }) {
      const writes: string[] = [];
      const eventPublisher = createGraphWorkflowExecutionEventPublisher({
        broadcast: () => {},
        dispatchPush: () => {},
      });
      const writeFile = async (absolutePath: string) => {
        if (input.failWrites.value) {
          throw new Error("materialization failed: disk is full");
        }
        writes.push(absolutePath);
      };
      const charterService = createWorkflowCharterService({
        writeFile,
        ensureDir: async () => {},
        publishCharterRegistered: eventPublisher.publishCharterRegistered,
      });
      const seededDocumentService = createWorkflowSeededDocumentService({
        writeFile,
        ensureDir: async () => {},
        store: {
          async captureFromWorktree() {},
          async read() {
            return null;
          },
        },
      });
      const repository = createGraphWorkflowExecutionRepository({
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
        getGraphWorkflowPendingArtifacts:
          fixture.store.getGraphWorkflowPendingArtifacts,
        clearGraphWorkflowPendingArtifacts:
          fixture.store.clearGraphWorkflowPendingArtifacts,
        eventPublisher,
        charterService,
        seededDocumentService,
        readConfig: async () => ({}) as GlobalConfig,
      });
      let armed: (() => Promise<void>) | null = null;
      const racing: typeof repository = {
        ...repository,
        async getActive(projectPath, sessionName) {
          const seen = await repository.getActive(projectPath, sessionName);
          const race = armed;
          armed = null;
          if (race) await race();
          return seen;
        },
      };
      const manager = createGraphWorkflowManager({
        executionRepository: racing,
        async loadDefinition() {
          return createWorkflowDefinitionRecord({
            id: "project-def",
            definition: createWorkflowDefinition({ approvalRequired: true }),
          });
        },
        now() {
          return input.clock?.value ?? "2026-06-21T00:00:00.000Z";
        },
        createExecutionId() {
          return "execution-parked";
        },
      });
      return {
        manager,
        writes,
        repository,
        armRace(race: () => Promise<void>) {
          armed = race;
        },
      };
    }

    /**
     * Park an approval-gated launch whose `.cc` writes failed, so the run holds
     * both the lease and an unsettled artifact debt: the repair a losing act
     * must not perform has something to do.
     */
    async function parkWithArtifactDebt(input: {
      failWrites: { value: boolean };
      clock?: { value: string };
    }) {
      const built = buildHarness(input);
      await expect(
        built.manager.start({
          projectPath: PROJECT_PATH,
          sessionName: SESSION_NAME,
          definitionId: "project-def",
          seededDocuments: [
            {
              relativePath: SEEDED_PATH,
              contents: "# spec",
              description: "the spec",
              readWhen: "before implementing",
            },
          ],
        }),
      ).rejects.toThrow(/disk is full/);
      input.failWrites.value = false;
      built.writes.length = 0;
      // The crash this models kills the process between the reserving commit
      // and the `.cc` writes, so nothing gets to halt the run: it is still
      // parked, still awaiting a human, and still owes its artifacts. Restored
      // through the store because a materialization failure inside one process
      // halts, and that is not the state the approval repair exists for.
      await fixture.store.mutateActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
        "test.simulate-crashed-park",
        (current) => ({
          execution: {
            ...current!,
            status: "pending" as const,
            haltReason: null,
            definitionApproval: {
              requestedAt: "2026-06-21T00:00:00.000Z",
              approvedAt: null,
            },
          },
          events: [],
        }),
      );
      return built;
    }

    it("materializes no artifacts and commits no write when a concurrent approval wins first", async () => {
      const failWrites = { value: true };
      const { manager, writes, repository, armRace } =
        await parkWithArtifactDebt({ failWrites });
      const before = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      );
      // The winner lands in the window: it approves the same parked run
      // between the loser's advisory read and the loser's serialized write.
      armRace(async () => {
        await repository.mutateActive(
          PROJECT_PATH,
          SESSION_NAME,
          (execution) => ({
            ...execution,
            status: "running" as const,
            definitionApproval: {
              requestedAt: "2026-06-21T00:00:00.000Z",
              approvedAt: "2026-06-21T00:00:01.000Z",
            },
          }),
        );
      });

      const result = await manager.recordDefinitionApproval({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        expectedExecutionId: "execution-parked",
        claimId: "claim-loser",
      });

      expect(result).toEqual({ ok: false, reason: "already_decided" });
      // The repair belongs to the act that actually hands the run to the loop.
      expect(writes).toEqual([]);
      const after = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      );
      // Exactly one write happened across the race — the winner's.
      expect(after?.executionStateRevision).toBe(
        (before?.executionStateRevision ?? 0) + 1,
      );
    });

    it("commits no write when a rejection names a run that no longer holds the row", async () => {
      const failWrites = { value: true };
      const { manager } = await parkWithArtifactDebt({ failWrites });
      const before = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      );

      const result = await manager.rejectDefinition({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        executionId: "execution-successor",
      });

      expect(result).toEqual({
        ok: false,
        reason: "execution_mismatch",
        activeExecutionId: "execution-parked",
      });
      const after = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      );
      expect(after?.executionStateRevision).toBe(
        before?.executionStateRevision,
      );
      // The parked run is still parked and still holds its lease.
      expect(after?.status).toBe("pending");
      expect(after?.definitionApproval).toMatchObject({ approvedAt: null });
    });

    it("still approves and repairs the run that does hold the row", async () => {
      const failWrites = { value: true };
      const { manager, writes } = await parkWithArtifactDebt({ failWrites });

      const { claimId } = await reserveDecision(manager);
      const result = await manager.recordDefinitionApproval({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        expectedExecutionId: "execution-parked",
        claimId,
      });

      expect(result).toMatchObject({ ok: true });
      expect(writes.some((file) => file.endsWith(SEEDED_PATH))).toBe(true);
      const after = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      );
      expect(after?.status).toBe("running");
      // Finalizing consumes the reservation: the park is decided, so nothing
      // is left in flight to block the next act.
      expect(after?.definitionApprovalClaim).toBeNull();
    });

    /**
     * The approval act is a saga across two authorities — this graph's
     * serialized row and the registered admission consumer's own durable
     * records — so it needs a reservation that is NOT the approval itself.
     * Approving first and admitting second would leave a refused act with an
     * irreversibly approved run; admitting first and approving second would
     * leave a losing act's admission behind. The reservation is the arbiter,
     * and it stays distinguishable from a finalized approval until the gate
     * admits.
     */
    it("reserves an approval decision without approving or starting the run", async () => {
      const failWrites = { value: true };
      const { manager, writes } = await parkWithArtifactDebt({ failWrites });

      const claimed = await manager.claimDefinitionApproval({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        expectedExecutionId: "execution-parked",
      });

      expect(claimed).toMatchObject({ ok: true });
      const after = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      );
      // Still parked, still undecided, still frozen — and, crucially, still
      // NOT approved: the gate has not spoken yet.
      expect(after?.status).toBe("pending");
      expect(after?.definitionApproval).toMatchObject({ approvedAt: null });
      expect(after?.definitionApprovalClaim).toMatchObject({
        claimedAt: expect.any(String),
      });
      // Materialization belongs to the act that hands the run to the loop.
      expect(writes).toEqual([]);
    });

    it("refuses a second reservation while a decision is in flight, write-free", async () => {
      const failWrites = { value: true };
      const { manager } = await parkWithArtifactDebt({ failWrites });
      await manager.claimDefinitionApproval({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        expectedExecutionId: "execution-parked",
      });
      const before = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      );

      const second = await manager.claimDefinitionApproval({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        expectedExecutionId: "execution-parked",
      });

      expect(second).toEqual({ ok: false, reason: "decision_in_flight" });
      const after = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      );
      expect(after?.executionStateRevision).toBe(
        before?.executionStateRevision,
      );
    });

    it("refuses a rejection while an approval decision is in flight, write-free", async () => {
      const failWrites = { value: true };
      const { manager } = await parkWithArtifactDebt({ failWrites });
      await manager.claimDefinitionApproval({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        expectedExecutionId: "execution-parked",
      });
      const before = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      );

      const rejected = await manager.rejectDefinition({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        executionId: "execution-parked",
      });

      // The reservation is what makes the in-flight admission safe: if a
      // rejection could land underneath it, the gate's durable admission would
      // survive an act that lost.
      expect(rejected).toEqual({ ok: false, reason: "decision_in_flight" });
      const after = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      );
      expect(after?.status).toBe("pending");
      expect(after?.executionStateRevision).toBe(
        before?.executionStateRevision,
      );
    });

    it("refuses to finalize an approval that was never reserved", async () => {
      const failWrites = { value: true };
      const { manager, writes } = await parkWithArtifactDebt({ failWrites });
      const before = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      );

      const result = await manager.recordDefinitionApproval({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        expectedExecutionId: "execution-parked",
        claimId: "claim-never-granted",
      });

      // Finalization may only follow a reservation the gate then admitted, or
      // the reservation is not the arbiter it claims to be.
      expect(result).toEqual({ ok: false, reason: "not_reserved" });
      expect(writes).toEqual([]);
      const after = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      );
      expect(after?.status).toBe("pending");
      expect(after?.executionStateRevision).toBe(
        before?.executionStateRevision,
      );
    });

    it("releases a refused reservation so the park can be decided again", async () => {
      const failWrites = { value: true };
      const { manager } = await parkWithArtifactDebt({ failWrites });
      const { claimId } = await reserveDecision(manager);

      const released = await manager.releaseDefinitionApprovalClaim({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        expectedExecutionId: "execution-parked",
        claimId,
      });

      expect(released).toMatchObject({ ok: true });
      const after = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      );
      // The gate's remedy is "fix the condition and approve again", which is
      // only true if the released park is exactly as decidable as before.
      expect(after?.status).toBe("pending");
      expect(after?.definitionApproval).toMatchObject({ approvedAt: null });
      expect(after?.definitionApprovalClaim).toBeNull();
      await expect(
        manager.claimDefinitionApproval({
          projectPath: PROJECT_PATH,
          sessionName: SESSION_NAME,
          expectedExecutionId: "execution-parked",
        }),
      ).resolves.toMatchObject({ ok: true });
    });

    /**
     * A reservation is taken BEFORE the admission consumer is called, so a
     * reservation that outlives its holder may already have that consumer's
     * durable records behind it. Nothing here may free it: an act that later
     * ended the run would strand those records. The debt is reported, and
     * finishing the interrupted saga belongs to whoever holds the admission
     * seam.
     */
    it("keeps a reservation stranded by a crash for its saga to finish", async () => {
      const failWrites = { value: true };
      const clock = { value: "2026-06-21T00:00:00.000Z" };
      const { manager } = await parkWithArtifactDebt({ failWrites, clock });
      const { claimId } = await reserveDecision(manager);

      // The process died between reserving and deciding, and time passed.
      clock.value = "2026-06-21T00:05:00.000Z";
      await manager.normalizeAfterRestart(PROJECT_PATH, SESSION_NAME);

      const after = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      );
      expect(after?.status).toBe("pending");
      expect(after?.definitionApprovalClaim).toMatchObject({ claimId });
      // Reported as interrupted, so the act that owns the admission seam can
      // finish it — and refused to every act that would merely discard it.
      expect(
        interruptedDefinitionDecision(after!, "2026-06-21T00:05:00.000Z"),
      ).toEqual({ claimId });
      await expect(
        manager.rejectDefinition({
          projectPath: PROJECT_PATH,
          sessionName: SESSION_NAME,
          executionId: "execution-parked",
        }),
      ).resolves.toEqual({ ok: false, reason: "decision_in_flight" });
    });

    it("reports nothing interrupted while a reservation is young enough to be live", async () => {
      const failWrites = { value: true };
      const clock = { value: "2026-06-21T00:00:00.000Z" };
      const { manager } = await parkWithArtifactDebt({ failWrites, clock });
      await reserveDecision(manager);

      const after = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      );
      expect(
        interruptedDefinitionDecision(after!, "2026-06-21T00:00:00.500Z"),
      ).toBeNull();
    });

    it("leaves a reservation untouched when a status read sweeps the session", async () => {
      const failWrites = { value: true };
      const clock = { value: "2026-06-21T00:00:00.000Z" };
      const { manager } = await parkWithArtifactDebt({ failWrites, clock });
      await manager.claimDefinitionApproval({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        expectedExecutionId: "execution-parked",
      });
      const before = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      );

      // This sweep is not restart-only despite its name: the status and
      // execution reads run it on every poll. Releasing on sight would free the
      // park underneath an approval that is at its admission gate right now,
      // which is the whole race the reservation exists to close.
      clock.value = "2026-06-21T00:00:00.500Z";
      await manager.normalizeAfterRestart(PROJECT_PATH, SESSION_NAME);

      const after = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      );
      expect(after?.definitionApprovalClaim).toMatchObject({
        claimedAt: "2026-06-21T00:00:00.000Z",
      });
      // A sweep that changes nothing writes nothing.
      expect(after?.executionStateRevision).toBe(
        before?.executionStateRevision,
      );
      await expect(
        manager.rejectDefinition({
          projectPath: PROJECT_PATH,
          sessionName: SESSION_NAME,
          executionId: "execution-parked",
        }),
      ).resolves.toEqual({ ok: false, reason: "decision_in_flight" });
    });

    /**
     * A reservation the sweep reclaimed is not the reservation that replaces
     * it. The superseded holder is still running — it was merely slow, not
     * dead — so both of its remaining moves have to fail against an identity,
     * not against "something is reserved": releasing would free the park under
     * the new holder's live admission, and finalizing would approve a run on
     * the strength of a reservation the new holder is still deciding.
     */
    async function reserveDecision(
      manager: ReturnType<typeof createGraphWorkflowManager>,
    ): Promise<{ claimId: string }> {
      const reserved = await manager.claimDefinitionApproval({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        expectedExecutionId: "execution-parked",
      });
      if (!reserved.ok) {
        throw new Error(`the park refused a reservation: ${reserved.reason}`);
      }
      return { claimId: reserved.claimId };
    }

    /**
     * Put the park's reservation in somebody else's hands. Seeded directly
     * because nothing frees a reservation but its holder: the state under test
     * is a row whose reservation is not the one this caller is holding, however
     * it got there.
     */
    async function reserveForAnotherHolder(claimId: string): Promise<void> {
      await fixture.store.mutateActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
        "test.reserve-for-another-holder",
        (current) => ({
          execution: {
            ...current!,
            definitionApprovalClaim: {
              claimId,
              claimedAt: "2026-06-21T00:00:00.000Z",
            },
          },
          events: [],
        }),
      );
    }

    it("refuses a superseded holder's release of somebody else's reservation", async () => {
      const failWrites = { value: true };
      const { manager } = await parkWithArtifactDebt({ failWrites });
      await reserveForAnotherHolder("claim-held-by-another-act");
      const before = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      );

      const released = await manager.releaseDefinitionApprovalClaim({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        expectedExecutionId: "execution-parked",
        claimId: "claim-this-act-once-held",
      });

      expect(released).toEqual({ ok: false, reason: "claim_superseded" });
      const after = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      );
      expect(after?.definitionApprovalClaim).toMatchObject({
        claimId: "claim-held-by-another-act",
      });
      expect(after?.executionStateRevision).toBe(
        before?.executionStateRevision,
      );
    });

    it("refuses a superseded holder's finalize and leaves the park to its actual holder", async () => {
      const failWrites = { value: true };
      const { manager, writes } = await parkWithArtifactDebt({ failWrites });
      await reserveForAnotherHolder("claim-held-by-another-act");
      const before = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      );

      const stale = await manager.recordDefinitionApproval({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        expectedExecutionId: "execution-parked",
        claimId: "claim-this-act-once-held",
      });

      expect(stale).toEqual({ ok: false, reason: "claim_superseded" });
      expect(writes).toEqual([]);
      const after = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      );
      expect(after?.status).toBe("pending");
      expect(after?.definitionApproval).toMatchObject({ approvedAt: null });
      expect(after?.executionStateRevision).toBe(
        before?.executionStateRevision,
      );
      // The park is decidable by the holder that actually reserved it.
      await expect(
        manager.recordDefinitionApproval({
          projectPath: PROJECT_PATH,
          sessionName: SESSION_NAME,
          expectedExecutionId: "execution-parked",
          claimId: "claim-held-by-another-act",
        }),
      ).resolves.toMatchObject({ ok: true });
    });

    /**
     * An abort ends a park from `pending`, which is exactly the state an
     * in-flight decision holds it in. Aborting underneath a live reservation
     * would strand the admission the holder is at this moment recording, and
     * leave that holder unable to finalize the run it was admitted to start —
     * so the abort waits for the decision instead.
     */
    it("refuses to abort a park whose decision is in flight", async () => {
      const failWrites = { value: true };
      const { manager } = await parkWithArtifactDebt({ failWrites });
      const { claimId } = await reserveDecision(manager);
      const before = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      );

      await expect(
        manager.send(PROJECT_PATH, SESSION_NAME, { type: "abort" }),
      ).rejects.toThrow(/decision/i);

      const after = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      );
      expect(after?.status).toBe("pending");
      expect(after?.executionStateRevision).toBe(
        before?.executionStateRevision,
      );
      // The admitted holder can still finalize the run it was admitted for.
      await expect(
        manager.recordDefinitionApproval({
          projectPath: PROJECT_PATH,
          sessionName: SESSION_NAME,
          expectedExecutionId: "execution-parked",
          claimId,
        }),
      ).resolves.toMatchObject({ ok: true });
    });

    it("refuses to abort a park whose reservation is merely stranded", async () => {
      const failWrites = { value: true };
      const clock = { value: "2026-06-21T00:00:00.000Z" };
      const { manager } = await parkWithArtifactDebt({ failWrites, clock });
      await reserveDecision(manager);

      // Age is not a licence to discard: an interrupted decision may already
      // have written downstream, so the abort waits for that saga to be
      // finished rather than ending the run out from under it.
      clock.value = "2026-06-21T00:05:00.000Z";
      await expect(
        manager.send(PROJECT_PATH, SESSION_NAME, { type: "abort" }),
      ).rejects.toThrow(/decision/i);

      const after = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      );
      expect(after?.status).toBe("pending");
    });
  });

  /**
   * The PRODUCTION launch path over a legacy-shaped incumbent (D7 R3.3, R3.4,
   * R5.2).
   *
   * `start` reads the incumbent through the repository before it reserves, and
   * that advisory read is the launch's first contact with the store. Asserted
   * here — over the real manager, the real repository and the real store —
   * rather than at the reservation seam, because a reservation called directly
   * never performs that read: a whole-store inventory around the setter stays
   * green while an ordinary refused `start` rewrites the incumbent it refused
   * for.
   *
   * A legacy row is the only shape that shows it. Anything seeded through the
   * store is already current, so an upgrading read has nothing to write.
   */
  describe("a legacy-shaped incumbent on the production launch path", () => {
    const PROJECT_PATH = "/repo";
    const SESSION_NAME = "session-1";

    let fixture: PersistenceFixture;

    beforeEach(() => {
      fixture = createPersistenceFixture();
      fixture.seedProject(PROJECT_PATH);
      fixture.seedSession(PROJECT_PATH, SESSION_NAME, {
        worktreePath: "/repo/.worktrees/session-1",
      });
    });

    afterEach(() => {
      fixture.close();
    });

    /**
     * Raw-insert an incumbent carrying the pre-D7 marker `activeContextId`
     * (singular). `lease_held` stays 1 whatever the status: it is a derived
     * projection, and a settled row left in the active position is exactly the
     * case where the column disagrees with the canonical predicate.
     */
    function seedLegacyIncumbent(
      overrides: Partial<GraphWorkflowExecution> & {
        status: GraphWorkflowExecution["status"];
      },
    ): void {
      const status = overrides.status;
      const completedAt = overrides.completedAt ?? null;
      const record = JSON.parse(
        JSON.stringify(
          createWorkflowExecution({
            id: "wf-legacy-incumbent",
            ...overrides,
          }),
        ),
      ) as Record<string, unknown>;
      delete record.activeContextIds;
      record.activeContextId = "context-plan";
      fixture.db
        .prepare(
          `INSERT INTO graph_workflow_executions (
             project_path, session_name, execution_id, seed_definition_id,
             seed_definition_revision, started_at, status, completed_at,
             definition_json, runtime_json, updated_at, lease_held
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          PROJECT_PATH,
          SESSION_NAME,
          "wf-legacy-incumbent",
          "project-def",
          1,
          "2026-01-01T00:00:00Z",
          status,
          completedAt,
          "{}",
          JSON.stringify(record),
          "2026-01-01T00:00:00Z",
          1,
        );
    }

    function buildManager(input?: { onReserve?: () => void }) {
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
        // No git worktree in this harness; the real exclusion would shell out.
        ensureCcArtifactsExcluded: async () => {},
        getSession: fixture.store.getSession,
        getActiveGraphWorkflowExecution:
          fixture.store.getActiveGraphWorkflowExecution,
        mutateActiveGraphWorkflowExecution:
          fixture.store.mutateActiveGraphWorkflowExecution,
        // The production setter, with a probe on the way in: `onReserve` runs
        // at the moment the launch reaches its authoritative admission, so a
        // test can compare the store as it stands THERE against the store as it
        // stood before `start` — the difference is whatever the launch wrote
        // before it held the lease.
        reserveActiveGraphWorkflowExecution: (...args) => {
          input?.onReserve?.();
          return fixture.store.reserveActiveGraphWorkflowExecution(...args);
        },
        archiveActiveGraphWorkflowExecution:
          fixture.store.archiveActiveGraphWorkflowExecution,
        markGraphWorkflowContextEventsPreReset:
          fixture.store.markGraphWorkflowContextEventsPreReset,
        getGraphWorkflowPendingArtifacts:
          fixture.store.getGraphWorkflowPendingArtifacts,
        clearGraphWorkflowPendingArtifacts:
          fixture.store.clearGraphWorkflowPendingArtifacts,
        eventPublisher,
        charterService,
        readConfig: async () => ({}) as GlobalConfig,
      });
      return createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return createWorkflowDefinitionRecord({ id: "project-def" });
        },
        getSession: async () =>
          (await fixture.store.getSession(PROJECT_PATH, SESSION_NAME))!,
        readSessionWorktreeDirtyPaths: async () => [],
        now() {
          return "2026-06-21T00:00:00.000Z";
        },
        createExecutionId() {
          return "execution-new";
        },
      });
    }

    function startInput() {
      return {
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        definitionId: "project-def",
      };
    }

    it.each([
      { label: "running", overrides: { status: "running" as const } },
      { label: "paused", overrides: { status: "paused" as const } },
      {
        label: "resumably halted",
        overrides: {
          status: "halted" as const,
          haltReason: {
            type: "execution_loop_failed" as const,
            contextId: null,
            cause: "unknown" as const,
            message: "halted",
          },
        },
      },
    ])(
      "leaves the ENTIRE store byte-identical when a launch is refused over a legacy $label incumbent",
      async ({ overrides }) => {
        seedLegacyIncumbent(overrides);
        const before = captureStoreInventory(fixture.db);

        await expect(buildManager().start(startInput())).rejects.toMatchObject({
          guard: "active_execution",
          blocker: { executionId: "wf-legacy-incumbent" },
        });

        expect(captureStoreInventory(fixture.db)).toEqual(before);
      },
    );

    /**
     * `non-resumably halted` is here for the same reason `completed` is: the
     * legacy upgrade rewrote any non-settled status to `paused`, which turns a
     * run whose tenure the classifier says is OVER into a lease holder and
     * refuses the launch. Tenure — not a hardcoded pair of terminal statuses —
     * is what decides whether the stored status may be reinterpreted.
     */
    it.each([
      {
        label: "completed",
        status: "completed" as const,
        overrides: {
          status: "completed" as const,
          completedAt: "2026-01-03T00:00:00Z",
        },
      },
      {
        label: "aborted",
        status: "aborted" as const,
        overrides: {
          status: "aborted" as const,
          completedAt: "2026-01-03T00:00:00Z",
        },
      },
      {
        label: "non-resumably halted",
        status: "halted" as const,
        overrides: {
          status: "halted" as const,
          haltReason: {
            type: "recovery_error" as const,
            message: "unrecoverable",
          },
        },
      },
      {
        // `haltReason` is nullable in the schema, so this shape is reachable
        // rather than hypothetical. The pinned spec's rule is `halted holds IFF
        // isResumableHalt(haltReason)` — a null reason is not resumable, so the
        // run is lease-free and must reach readable History like any other
        // settled incumbent, not sit in the active row refusing launches.
        label: "halted with no recorded reason",
        status: "halted" as const,
        overrides: { status: "halted" as const, haltReason: null },
      },
    ])(
      "relocates a legacy $label incumbent to readable History as part of admitting the launch",
      async ({ status, overrides }) => {
        seedLegacyIncumbent(overrides);
        const before = captureStoreInventory(fixture.db);
        let atReservation: ReturnType<typeof captureStoreInventory> | null =
          null;

        const { execution } = await buildManager({
          onReserve: () => {
            atReservation = captureStoreInventory(fixture.db);
          },
        }).start(startInput());

        // Relocation is the RESERVATION's act (R3.3, R3.4): archiving the
        // record and installing the successor are one state change, so nothing
        // may have rewritten the incumbent on the way here. Reading it early is
        // fine; persisting anything is not — an early rewrite is also what lets
        // a second process clobber a winner installed in between.
        expect(atReservation).toEqual(before);
        expect(execution.id).toBe("execution-new");
        expect(
          (
            await fixture.store.getActiveGraphWorkflowExecution(
              PROJECT_PATH,
              SESSION_NAME,
            )
          )?.id,
        ).toBe("execution-new");

        // Relocated whole and with its own settled status: History renders the
        // record by id, and the superseded read-repair would have stamped
        // `paused` on it — fabricating tenure for a run that had ended.
        const archived =
          fixture.graphWorkflowArchivedExecutions.findByExecution(
            PROJECT_PATH,
            SESSION_NAME,
            "wf-legacy-incumbent",
          );
        expect(archived?.status).toBe(status);

        const releases = fixture.graphWorkflowEvents
          .findByExecution(PROJECT_PATH, SESSION_NAME, "wf-legacy-incumbent")
          .filter(
            (record) =>
              record.event.type === "graph-workflow-execution-released",
          );
        expect(releases).toHaveLength(1);
        expect(releases[0]?.event).toMatchObject({
          reason: "normalized_on_admission",
          status,
        });
      },
    );
  });

  it("pauses immediately by interrupting running tasks in the active context", async () => {
    const repository = createRepository(
      createWorkflowExecution({
        status: "running",
        activeContextIds: ["context-plan"],
        contextStates: {
          "context-plan": {
            skipReason: null,
            landingIntent: null,
            pendingApproval: null,
            pendingUserInputs: {},
            contextId: "context-plan",
            status: "running",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 1,
            consecutiveFailureCount: 0,
            consecutiveCandidateMismatchCount: 0,
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
            skipReason: null,
            landingIntent: null,
            pendingApproval: null,
            pendingUserInputs: {},
            contextId: "context-implement",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
            consecutiveCandidateMismatchCount: 0,
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
            skipReason: null,
            landingIntent: null,
            pendingApproval: null,
            pendingUserInputs: {},
            contextId: "context-verify",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
            consecutiveCandidateMismatchCount: 0,
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

  it("rejects pausing an execution that already completed without changing it", async () => {
    const completed = createWorkflowExecution({
      status: "completed",
      completedAt: "2026-03-27T15:04:00.000Z",
      loopEpoch: 4,
    });
    const repository = createRepository(completed);
    const abortConversation = vi.fn();
    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      abortConversation,
    });

    await expect(
      manager.send("/repo", "session-1", { type: "pause" }),
    ).rejects.toThrow("Only running graph workflow executions can be paused");

    expect(repository.read()).toEqual(completed);
    expect(abortConversation).not.toHaveBeenCalled();
  });

  it("retires the active loop generation when pause commits", async () => {
    const repository = createRepository(
      createWorkflowExecution({ status: "running", loopEpoch: 7 }),
    );
    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
    });

    const paused = await manager.send("/repo", "session-1", {
      type: "pause",
    });

    expect(paused.status).toBe("paused");
    expect(paused.loopEpoch).toBe(8);
  });

  it("fences completion from the loop generation that pause retired", async () => {
    const running = createWorkflowExecution({
      status: "running",
      loopEpoch: 3,
    });
    const repository = createRepository(running);
    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
    });
    const fence = {
      projectPath: "/repo",
      sessionName: "session-1",
      executionId: running.id,
      loopEpoch: running.loopEpoch,
    };

    await manager.send("/repo", "session-1", { type: "pause" });

    await expect(
      runWithLoopFence(fence, () =>
        manager.send("/repo", "session-1", { type: "complete" }),
      ),
    ).rejects.toBeInstanceOf(StaleLoopFenceError);
    expect(repository.read()?.status).toBe("paused");
  });

  it("retires the loop generation when completion commits", async () => {
    const repository = createRepository(
      createWorkflowExecution({ status: "running", loopEpoch: 5 }),
    );
    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
    });

    const completed = await manager.send("/repo", "session-1", {
      type: "complete",
    });

    expect(completed.status).toBe("completed");
    expect(completed.loopEpoch).toBe(6);
  });

  it("rejects aborting an execution that already completed", async () => {
    const completed = createWorkflowExecution({
      status: "completed",
      completedAt: "2026-03-27T15:04:00.000Z",
    });
    const repository = createRepository(completed);
    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
    });

    await expect(
      manager.send("/repo", "session-1", { type: "abort" }),
    ).rejects.toThrow(
      "Completed or aborted graph workflow executions cannot be aborted",
    );
    expect(repository.read()).toEqual(completed);
  });

  it("rejects halting an execution that already completed", async () => {
    const completed = createWorkflowExecution({
      status: "completed",
      completedAt: "2026-03-27T15:04:00.000Z",
    });
    const repository = createRepository(completed);
    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
    });

    await expect(
      manager.send("/repo", "session-1", {
        type: "halt",
        reason: { type: "recovery_error", message: "late halt" },
      }),
    ).rejects.toThrow("Only running graph workflow executions can be halted");
    expect(repository.read()).toEqual(completed);
  });

  it("rejects completing a paused execution outside a live loop", async () => {
    const paused = createWorkflowExecution({ status: "paused" });
    const repository = createRepository(paused);
    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
    });

    await expect(
      manager.send("/repo", "session-1", { type: "complete" }),
    ).rejects.toThrow(
      "Only running graph workflow executions can be completed",
    );
    expect(repository.read()).toEqual(paused);
  });

  it("aborts the in-flight conversation for every running task when paused, halted, or aborted", async () => {
    const buildExecutionWithRunningTasks = () =>
      createWorkflowExecution({
        status: "running",
        activeContextIds: ["context-a", "context-b"],
        contextStates: {
          "context-a": {
            skipReason: null,
            landingIntent: null,
            pendingApproval: null,
            pendingUserInputs: {},
            contextId: "context-a",
            status: "running",
            totalTaskCount: 2,
            completedTaskCount: 0,
            iterationCount: 1,
            consecutiveFailureCount: 0,
            consecutiveCandidateMismatchCount: 0,
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
            skipReason: null,
            landingIntent: null,
            pendingApproval: null,
            pendingUserInputs: {},
            contextId: "context-b",
            status: "running",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 1,
            consecutiveFailureCount: 0,
            consecutiveCandidateMismatchCount: 0,
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
            skipReason: null,
            landingIntent: null,
            pendingApproval: null,
            pendingUserInputs: {},
            contextId: "context-c",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
            consecutiveCandidateMismatchCount: 0,
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
          summary: null,
        },
      },
    ]) {
      const repository = createRepository(buildExecutionWithRunningTasks());
      const abortConversation = vi.fn();
      const abortExecutionLoop = vi.fn();

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
        now() {
          return "2026-03-27T15:05:00.000Z";
        },
        abortConversation,
        abortExecutionLoop,
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
          expect(abortExecutionLoop).toHaveBeenCalledOnce();
          expect(abortExecutionLoop).toHaveBeenCalledWith("/repo", "session-1");
        },
      });
    }

    for (const { send } of transitions) {
      await send();
    }
  });

  it("aborts lane conversations (implementer + validator) alongside running-task conversations", async () => {
    // Validator runs live on lane conversations tracked in laneStates, not in
    // taskStates — without collecting them, an abort mid-validation lets a
    // long codex validator run burn to completion.
    const buildExecution = () =>
      createWorkflowExecution({
        status: "running",
        activeContextIds: ["context-plan"],
        taskStates: {
          "task-plan-1": {
            taskId: "task-plan-1",
            contextId: "context-plan",
            order: 1,
            status: "running",
            summary: null,
            startedAt: "2026-03-27T15:00:00.000Z",
            completedAt: null,
            lastConversationId: "conv-impl",
            failureMessage: null,
            failureHistory: [],
          },
        },
        laneStates: {
          "context-plan": {
            implementer: {
              lane: "implementer",
              contextId: "context-plan",
              backend: "claude",
              refKind: "conversation",
              workflowConversationId: "conv-impl",
              sessionRef: { backend: "claude", ref: "conv-impl" },
              metrics: { rotateBeforeNextTurn: false },
              limitEvaluation: "supported",
              lastUsedAt: "2026-03-27T15:00:00.000Z",
            },
            // A cohort of two: lane state is keyed per assignment, so an abort
            // that only swept the bare `context_validator` key would leave one
            // specialist's turn burning to completion (R8.1).
            "context_validator:reviewer-a": {
              lane: "context_validator",
              contextId: "context-plan",
              assignmentId: "reviewer-a",
              backend: "codex",
              refKind: "backend",
              // Production shape: the validator runner persists the synthetic
              // dispatch id
              // (__validator__:{executionId}:{contextId}:{lane}:{assignmentId}:{backend})
              // onto the lane state before dispatching the turn.
              workflowConversationId:
                "__validator__:execution-1:context-plan:context_validator:reviewer-a:codex",
              metrics: {
                lastTurnUsage: null,
                rotateBeforeNextTurn: false,
              },
              limitEvaluation: "unsupported",
              lastUsedAt: "2026-03-27T15:01:00.000Z",
            },
            "context_validator:reviewer-b": {
              lane: "context_validator",
              contextId: "context-plan",
              assignmentId: "reviewer-b",
              backend: "codex",
              refKind: "backend",
              workflowConversationId:
                "__validator__:execution-1:context-plan:context_validator:reviewer-b:codex",
              metrics: {
                lastTurnUsage: null,
                rotateBeforeNextTurn: false,
              },
              limitEvaluation: "unsupported",
              lastUsedAt: "2026-03-27T15:01:00.000Z",
            },
          },
        },
      });

    const repository = createRepository(buildExecution());
    const abortConversation = vi.fn();
    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      abortConversation,
    });

    await manager.send("/repo", "session-1", { type: "abort" });

    const conversationIds = abortConversation.mock.calls
      .map(([input]) => (input as { conversationId: string }).conversationId)
      .sort((a, b) => a.localeCompare(b));
    // conv-impl appears in both taskStates and the implementer lane — deduped.
    expect(conversationIds).toEqual([
      "__validator__:execution-1:context-plan:context_validator:reviewer-a:codex",
      "__validator__:execution-1:context-plan:context_validator:reviewer-b:codex",
      "conv-impl",
    ]);
  });

  it("resume aborts in-flight turns on lane conversations before the new loop generation starts", async () => {
    // A zombie loop's in-flight turn is write-fenced but can still hold a
    // lane conversation; aborting on resume frees the lane for the new
    // generation. Safe: no legitimate turn can be running while halted.
    const repository = createRepository(
      createWorkflowExecution({
        status: "halted",
        // A RESUMABLE halt: resume is admitted only for a run that still holds
        // the lease, so a non-resumable reason here would refuse before the
        // lane-abort behavior under test could run.
        haltReason: {
          type: "execution_loop_failed",
          contextId: null,
          cause: "unknown",
          message: "halted for the test",
        },
        laneStates: {
          "context-plan": {
            implementer: {
              lane: "implementer",
              contextId: "context-plan",
              backend: "claude",
              refKind: "conversation",
              workflowConversationId: "conv-impl",
              sessionRef: { backend: "claude", ref: "conv-impl" },
              metrics: { rotateBeforeNextTurn: false },
              limitEvaluation: "supported",
              lastUsedAt: "2026-03-27T15:00:00.000Z",
            },
          },
        },
      }),
    );
    const abortConversation = vi.fn();
    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      abortConversation,
    });

    const resumed = await manager.resume("/repo", "session-1");

    expect(resumed.status).toBe("running");
    expect(
      abortConversation.mock.calls.map(
        ([input]) => (input as { conversationId: string }).conversationId,
      ),
    ).toEqual(["conv-impl"]);
  });

  it("refuses a resume fenced on an execution that no longer holds the lease", async () => {
    // The abandon-plus-relaunch window (D7 decision D5): plan repair decided to
    // resume the run it examined, and by the time the trio runs a successor
    // holds the session's slot. Resume is session-addressed, so without the
    // fence the successor is what gets resumed.
    const repository = createRepository(
      createWorkflowExecution({
        id: "execution-successor",
        status: "halted",
        haltReason: {
          type: "execution_loop_failed",
          contextId: null,
          cause: "unknown",
          message: "halted for the test",
        },
      }),
    );
    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
    });

    await expect(
      manager.resume("/repo", "session-1", {
        expectedExecutionId: "execution-abandoned",
      }),
    ).rejects.toThrow(/execution-abandoned no longer holds/);

    // The refusal is write-free: the successor is still halted, untouched.
    expect(repository.read()?.status).toBe("halted");
    expect(repository.read()?.id).toBe("execution-successor");
  });

  it("fences resume's post-commit artifact repair on the run it resumed", async () => {
    // The other half of the abandon-plus-relaunch window (D7 decision D5): the
    // fence above stops resume from transitioning a successor, but the repair
    // behind it is a FILESYSTEM effect addressed to the session's active row.
    // If the turnover lands after the resume commits, an unfenced repair writes
    // the resumed run's charter and seeded documents into the worktree of the
    // successor that replaced it.
    const repository = createRepository(
      createWorkflowExecution({
        id: "execution-resumed",
        status: "halted",
        haltReason: {
          type: "execution_loop_failed",
          contextId: null,
          cause: "unknown",
          message: "halted for the test",
        },
      }),
    );
    const successor = createWorkflowExecution({
      id: "execution-successor",
      status: "pending",
    });
    const repairRequests: string[] = [];
    let turnedOver = false;
    const manager = createGraphWorkflowManager({
      executionRepository: {
        ...repository,
        async getActive(projectPath, sessionName) {
          return turnedOver
            ? successor
            : repository.getActive(projectPath, sessionName);
        },
        async mutateActive(projectPath, sessionName, fn) {
          const committed = await repository.mutateActive(
            projectPath,
            sessionName,
            fn,
          );
          // Abandon-plus-relaunch lands between the commit and the repair.
          turnedOver = true;
          return committed;
        },
        async ensureArtifactsMaterialized({ executionId }) {
          repairRequests.push(executionId);
          return null;
        },
      },
      async loadDefinition() {
        return null;
      },
    });

    const resumed = await manager.resume("/repo", "session-1");

    expect(resumed.id).toBe("execution-resumed");
    expect(repairRequests).toEqual([]);
  });

  it("does not abort the conversation holding a parked user question on pause or halt", async () => {
    // A parked lane has no in-flight turn — its machine sits in
    // waitingForInput, which accepts ABORT_TURN and would persist a cleared
    // question. The execution keeps the parked record, so answers would 410
    // forever and the context could never be re-dispatched.
    const buildParkedExecution = () => {
      const execution = createWorkflowExecution({
        status: "running",
        activeContextIds: ["context-implement"],
        laneStates: {
          "context-plan": {
            implementer: {
              lane: "implementer",
              contextId: "context-plan",
              backend: "claude",
              refKind: "conversation",
              workflowConversationId: "conv-parked",
              sessionRef: { backend: "claude", ref: "conv-parked" },
              metrics: { rotateBeforeNextTurn: false },
              limitEvaluation: "supported",
              lastUsedAt: "2026-03-27T15:00:00.000Z",
            },
          },
          "context-implement": {
            implementer: {
              lane: "implementer",
              contextId: "context-implement",
              backend: "claude",
              refKind: "conversation",
              workflowConversationId: "conv-live",
              sessionRef: { backend: "claude", ref: "conv-live" },
              metrics: { rotateBeforeNextTurn: false },
              limitEvaluation: "supported",
              lastUsedAt: "2026-03-27T15:01:00.000Z",
            },
          },
        },
      });
      const parkedContext = execution.contextStates["context-plan"];
      if (!parkedContext) throw new Error("fixture missing context-plan");
      parkedContext.status = "awaiting_user_input";
      parkedContext.pendingUserInputs = {
        implementer: {
          conversationId: "conv-parked",
          lane: "implementer",
          questionBatchId: "batch-1",
          questions: [],
          requestedAt: "2026-03-27T15:00:00.000Z",
          roundSeq: null,
          answers: null,
        },
      };
      return execution;
    };

    for (const event of [
      { type: "pause" as const },
      {
        type: "halt" as const,
        reason: {
          type: "max_iterations" as const,
          contextId: "context-implement",
          iterationCount: 1,
          summary: null,
        },
      },
    ]) {
      const repository = createRepository(buildParkedExecution());
      const abortConversation = vi.fn();
      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
        abortConversation,
      });

      await manager.send("/repo", "session-1", event);

      const conversationIds = abortConversation.mock.calls.map(
        ([input]) => (input as { conversationId: string }).conversationId,
      );
      expect(conversationIds, `transition=${event.type}`).toEqual([
        "conv-live",
      ]);
      expect(
        repository.read()?.contextStates["context-plan"]?.pendingUserInputs[
          "implementer"
        ],
      ).toBeDefined();
    }
  });

  it("withdraws every parked question when an execution is aborted", async () => {
    // Req 7.4: an abort ends the execution, so a park it orphans must stop
    // being answerable. Pause and halt keep theirs (asserted above) because the
    // wait re-engages on resume. Aborting from `paused` — no loop is running —
    // is the case that proves the withdrawal rides the transition rather than
    // depending on a live loop to notice.
    for (const startingStatus of ["running", "paused"] as const) {
      const execution = createWorkflowExecution({ status: startingStatus });
      const parkedContext = execution.contextStates["context-plan"];
      if (!parkedContext) throw new Error("fixture missing context-plan");
      parkedContext.status = "awaiting_user_input";
      parkedContext.pendingUserInputs = {
        implementer: {
          conversationId: "conv-parked",
          lane: "implementer",
          questionBatchId: "batch-1",
          questions: [],
          requestedAt: "2026-03-27T15:00:00.000Z",
          roundSeq: null,
          answers: null,
        },
      };
      const repository = createRepository(execution);
      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
      });

      const aborted = await manager.send("/repo", "session-1", {
        type: "abort",
      });

      expect(aborted.status, `from=${startingStatus}`).toBe("aborted");
      expect(
        aborted.contextStates["context-plan"]?.pendingUserInputs,
        `from=${startingStatus}`,
      ).toEqual({});
      expect(
        repository.read()?.contextStates["context-plan"]?.pendingUserInputs,
        `from=${startingStatus}`,
      ).toEqual({});
    }
  });

  it("resume does not abort the conversation holding a parked user question", async () => {
    const execution = createWorkflowExecution({
      status: "paused",
      laneStates: {
        "context-plan": {
          implementer: {
            lane: "implementer",
            contextId: "context-plan",
            backend: "claude",
            refKind: "conversation",
            workflowConversationId: "conv-parked",
            sessionRef: { backend: "claude", ref: "conv-parked" },
            metrics: { rotateBeforeNextTurn: false },
            limitEvaluation: "supported",
            lastUsedAt: "2026-03-27T15:00:00.000Z",
          },
        },
      },
    });
    const parkedContext = execution.contextStates["context-plan"];
    if (!parkedContext) throw new Error("fixture missing context-plan");
    parkedContext.status = "awaiting_user_input";
    parkedContext.pendingUserInputs = {
      implementer: {
        conversationId: "conv-parked",
        lane: "implementer",
        questionBatchId: "batch-1",
        questions: [],
        requestedAt: "2026-03-27T15:00:00.000Z",
        roundSeq: null,
        answers: null,
      },
    };

    const repository = createRepository(execution);
    const abortConversation = vi.fn();
    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      abortConversation,
    });

    const resumed = await manager.resume("/repo", "session-1");

    expect(resumed.status).toBe("running");
    expect(abortConversation).not.toHaveBeenCalled();
    expect(
      repository.read()?.contextStates["context-plan"]?.pendingUserInputs[
        "implementer"
      ],
    ).toBeDefined();
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
          summary: null,
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
            skipReason: null,
            landingIntent: null,
            pendingApproval: null,
            pendingUserInputs: {},
            contextId: "context-plan",
            status: "running",
            totalTaskCount: 1,
            completedTaskCount: 1,
            iterationCount: 2,
            consecutiveFailureCount: 0,
            consecutiveCandidateMismatchCount: 0,
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
            skipReason: null,
            landingIntent: null,
            pendingApproval: null,
            pendingUserInputs: {},
            contextId: "context-implement",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
            consecutiveCandidateMismatchCount: 0,
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
            skipReason: null,
            landingIntent: null,
            pendingApproval: null,
            pendingUserInputs: {},
            contextId: "context-verify",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
            consecutiveCandidateMismatchCount: 0,
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
        summary: null,
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
            skipReason: null,
            landingIntent: null,
            pendingApproval: null,
            pendingUserInputs: {},
            contextId: "context-plan",
            status: "running",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 1,
            consecutiveFailureCount: 0,
            consecutiveCandidateMismatchCount: 0,
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
            skipReason: null,
            landingIntent: null,
            pendingApproval: null,
            pendingUserInputs: {},
            contextId: "context-implement",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
            consecutiveCandidateMismatchCount: 0,
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
            skipReason: null,
            landingIntent: null,
            pendingApproval: null,
            pendingUserInputs: {},
            contextId: "context-verify",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
            consecutiveCandidateMismatchCount: 0,
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
              backend: "claude",
              refKind: "conversation",
              lane: "implementer",
              contextId: "context-plan",
              workflowConversationId: "conv-1",
              sessionRef: { backend: "claude", ref: "conv-1" },
              metrics: {
                contextTokens: 10_000,
                contextWindowMax: 200_000,
                rotateBeforeNextTurn: false,
              },
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
        metrics: { rotateBeforeNextTurn: true },
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
            skipReason: null,
            landingIntent: null,
            pendingApproval: null,
            pendingUserInputs: {},
            contextId: "context-plan",
            status: "running",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 1,
            consecutiveFailureCount: 0,
            consecutiveCandidateMismatchCount: 0,
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
            skipReason: null,
            landingIntent: null,
            pendingApproval: null,
            pendingUserInputs: {},
            contextId: "context-implement",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
            consecutiveCandidateMismatchCount: 0,
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
            skipReason: null,
            landingIntent: null,
            pendingApproval: null,
            pendingUserInputs: {},
            contextId: "context-verify",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
            consecutiveCandidateMismatchCount: 0,
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

  /**
   * Restart is the ONLY kickoff an ordinary launch ever gets.
   *
   * A launch commits its row as `pending` and writes its `.cc` artifacts after
   * the transaction, so a crash in between strands a run whose charter and
   * seeded documents do not exist. Nothing else comes back for it: `resume`
   * refuses a pending run, and approval-gated repair only covers launches that
   * stop for a definition approval. If restart normalization settles the debt
   * only for `running`, the artifacts are owed forever.
   *
   * Every status that can hold the row is checked, because the debt belongs to
   * whoever holds it — not to a particular lifecycle state.
   */
  it.each(["pending", "running", "paused", "halted"] as const)(
    "settles the artifact debt of a %s execution at restart",
    async (status) => {
      const repository = createRepository(
        createWorkflowExecution({
          id: "execution-owing",
          status,
          ...(status === "halted"
            ? { haltReason: { type: "recovery_error", message: "crashed" } }
            : {}),
        }),
      );
      const repairRequests: string[] = [];
      const manager = createGraphWorkflowManager({
        executionRepository: {
          ...repository,
          async ensureArtifactsMaterialized({ executionId }) {
            repairRequests.push(executionId);
            return null;
          },
        },
        async loadDefinition() {
          return null;
        },
      });

      await manager.normalizeAfterRestart("/repo", "session-1");

      expect(repairRequests).toEqual(["execution-owing"]);
    },
  );

  it("skips normalization when the execution loop is actively running", async () => {
    const repository = createRepository(
      createWorkflowExecution({
        status: "running",
        activeContextIds: ["context-plan"],
        contextStates: {
          "context-plan": {
            skipReason: null,
            landingIntent: null,
            pendingApproval: null,
            pendingUserInputs: {},
            contextId: "context-plan",
            status: "running",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 1,
            consecutiveFailureCount: 0,
            consecutiveCandidateMismatchCount: 0,
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
            skipReason: null,
            landingIntent: null,
            pendingApproval: null,
            pendingUserInputs: {},
            contextId: "context-plan",
            status: "ready",
            totalTaskCount: 1,
            completedTaskCount: 1,
            iterationCount: 1,
            consecutiveFailureCount: 0,
            consecutiveCandidateMismatchCount: 0,
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
      skipReason: null,
      landingIntent: null,
      pendingApproval: {
        conversationId: "conversation-1",
        requestedAt: "2026-03-27T15:01:00.000Z",
        approvalScope: { kind: "whole_tree" as const },
        decision: {
          type: "rejected" as const,
          message: "needs more tests",
          decidedAt: "2026-03-27T15:02:00.000Z",
        },
      },
      pendingUserInputs: {},
      contextId: "context-plan",
      status: "awaiting_approval" as const,
      totalTaskCount: 1,
      completedTaskCount: 1,
      iterationCount: 1,
      consecutiveFailureCount: 0,
      consecutiveCandidateMismatchCount: 0,
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

  describe("landing-intent reconciliation at restart (D4 decision D8)", () => {
    const CRASHED_LANE_CONTEXT = {
      skipReason: null,
      pendingApproval: null,
      pendingUserInputs: {},
      contextId: "context-plan",
      status: "completed" as const,
      totalTaskCount: 1,
      completedTaskCount: 1,
      iterationCount: 1,
      consecutiveFailureCount: 0,
      consecutiveCandidateMismatchCount: 0,
      worktreePath: "/repo/.worktrees/lane-a",
      branchName: "csm/lane-a",
      isolation: "worktree" as const,
      batchId: null,
      laneId: "lane-a",
      joinId: null,
      mergeStatus: "merged-success" as const,
      cleanupStatus: "not-applicable" as const,
      lastMergeError: null,
      landingIntent: {
        mode: "lane_commit" as const,
        attempt: 1,
        token: "cc-landing:execution-1:context-plan:1",
        laneId: "lane-a",
        worktreePath: "/repo/.worktrees/lane-a",
        baselineSha: "aaa",
        headSha: null,
        joinId: null,
        state: "pending" as const,
        evidence: null,
        recordedAt: "2026-03-27T15:00:00.000Z",
        settledAt: null,
      },
    };

    function crashedLaneRepository() {
      return createRepository(
        createWorkflowExecution({
          status: "running",
          activeContextIds: [],
          executionLanes: {
            "lane-a": {
              laneId: "lane-a",
              kind: "worktree",
              status: "active",
              branchName: "csm/lane-a",
              worktreePath: "/repo/.worktrees/lane-a",
              includedContextIds: ["context-plan"],
              lastCommittingContextId: "context-plan",
              commitSnapshots: [],
              createdAt: "2026-03-27T15:00:00.000Z",
              updatedAt: "2026-03-27T15:00:00.000Z",
            },
          },
          contextStates: {
            "context-plan": structuredClone(CRASHED_LANE_CONTEXT),
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
        }),
      );
    }

    it("settles a crashed lane commit against the branch evidence the committer left", async () => {
      const probed: string[] = [];
      const manager = createGraphWorkflowManager({
        executionRepository: crashedLaneRepository(),
        async loadDefinition() {
          return null;
        },
        isExecutionLoopActive() {
          return false;
        },
        landingEvidenceProber: {
          async probe(targets) {
            probed.push(...targets.map((target) => target.contextId));
            return new Map(
              targets.map((target) => [
                target.contextId,
                {
                  headSha: "ccc",
                  tokenCommitSha: "ccc",
                  baselineReachable: true,
                },
              ]),
            );
          },
        },
      });

      const recovered = await manager.normalizeAfterRestart(
        "/repo",
        "session-1",
      );

      expect(probed).toEqual(["context-plan"]);
      expect(
        recovered?.contextStates["context-plan"]?.landingIntent,
      ).toMatchObject({ state: "landed", evidence: "commit", headSha: "ccc" });
    });

    it("leaves the intent pending when the branch carries no landing evidence", async () => {
      const manager = createGraphWorkflowManager({
        executionRepository: crashedLaneRepository(),
        async loadDefinition() {
          return null;
        },
        isExecutionLoopActive() {
          return false;
        },
        landingEvidenceProber: {
          async probe() {
            return new Map();
          },
        },
      });

      const recovered = await manager.normalizeAfterRestart(
        "/repo",
        "session-1",
      );

      // The lane's includedContextIds says the commit phase ran, not that it
      // produced a landing: without the replay this stays unsettled.
      expect(
        recovered?.contextStates["context-plan"]?.landingIntent?.state,
      ).toBe("pending");
    });
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
            skipReason: null,
            landingIntent: null,
            pendingApproval: null,
            pendingUserInputs: {},
            contextId: "context-plan",
            status: "running",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 1,
            consecutiveFailureCount: 0,
            consecutiveCandidateMismatchCount: 0,
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
            validationDebtSourceLaneIds: [],
            status: "running",
            errorMessage: null,
            conflicts: null,
            conflictGuidance: null,
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
            validationDebtSourceLaneIds: [],
            status: "succeeded",
            errorMessage: null,
            conflicts: null,
            conflictGuidance: null,
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
            validationDebtSourceLaneIds: [],
            status: "failed",
            errorMessage: "merge tool exited 1",
            conflicts: null,
            conflictGuidance: null,
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
            validationDebtSourceLaneIds: [],
            status: "running",
            errorMessage: null,
            conflicts: null,
            conflictGuidance: null,
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
            consecutiveCandidateMismatchCount: 0,
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
      consecutiveCandidateMismatchCount: 0,
    });
    expect(execution.machineSnapshot).toEqual({
      schemaVersion: 1,
      lifecycleStatus: "running",
      activeContextId: "context-plan",
      recoveryMode: "none",
      hasLiveIteration: false,
    });
  });

  it("bumps loopEpoch on every resume so a prior loop generation is fenced out", async () => {
    const repository = createRepository(
      createWorkflowExecution({
        status: "halted",
        haltReason: {
          type: "execution_loop_failed",
          contextId: null,
          cause: "unknown",
          message: "halted for the test",
        },
      }),
    );

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
    });

    const resumed = await manager.resume("/repo", "session-1");
    expect(resumed.loopEpoch).toBe(1);

    // The bump must be persisted, not just returned: a zombie loop checks the
    // stored execution, so the fence only works if the epoch survives a read.
    const persisted = await repository.getActive("/repo", "session-1");
    expect(persisted?.loopEpoch).toBe(1);

    await manager.send("/repo", "session-1", { type: "pause" });
    const resumedAgain = await manager.resume("/repo", "session-1");
    expect(resumedAgain.loopEpoch).toBe(3);
  });

  it("resume clears a stale pendingHaltReason so the new generation does not immediately drain-halt", async () => {
    // A turn cancelled by pause/halt can settle into recordPendingHaltReason
    // while the execution is suspended. Resume is a manual retry decision:
    // any not-yet-drained pending reason belongs to the superseded
    // generation, and preserving it would halt the replacement loop on its
    // first pass.
    const repository = createRepository(
      createWorkflowExecution({
        status: "paused",
        pendingHaltReason: {
          type: "recovery_error",
          message: "stale reason from a cancelled turn",
        },
      }),
    );
    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
    });

    const resumed = await manager.resume("/repo", "session-1");

    expect(resumed.status).toBe("running");
    expect(resumed.pendingHaltReason).toBeNull();
    expect(repository.read()?.pendingHaltReason).toBeNull();
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
            consecutiveCandidateMismatchCount: 0,
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
      consecutiveCandidateMismatchCount: 0,
    });
  });

  /**
   * An open cohort round mid-flight: `general` has rendered a verdict,
   * `perf-reviewer` has not. Its infrastructure history is the caller's, because
   * that is the only thing the two resume paths below disagree about.
   */
  function openCohortRound(
    perfReviewer: Partial<GraphWorkflowValidationSpecialist>,
  ): GraphWorkflowValidationRound {
    return {
      seq: 2,
      candidate: {
        identityScope: "wholeTree",
        headSha: "head-1",
        candidateTreeHash: "tree-a",
        taskStateHash: "hash-1",
      },
      roster: [
        {
          assignmentId: "general",
          profileRef: { tier: "builtin", id: "general-reviewer" },
          revision: 1,
          resolvedInstructionHash: `sha256:${"b".repeat(64)}`,
          strategy: "conversation",
        },
        {
          assignmentId: "perf-reviewer",
          profileRef: { tier: "builtin", id: "general-reviewer" },
          revision: 1,
          resolvedInstructionHash: `sha256:${"b".repeat(64)}`,
          strategy: "conversation",
        },
      ],
      specialists: {
        general: {
          state: "verdict_pass",
          attempts: 1,
          summary: "general is satisfied.",
          issues: [],
          advisories: [],
          questionToken: null,
          sessionRef: null,
          reviewArtifact: null,
          lastInfraFailure: null,
        },
        "perf-reviewer": {
          state: "infra_failed",
          attempts: 3,
          summary: null,
          issues: [],
          advisories: [],
          questionToken: null,
          sessionRef: null,
          reviewArtifact: null,
          lastInfraFailure: {
            reason: "exception",
            message: "provider unavailable",
            engine: "claude",
          },
          ...perfReviewer,
        },
      },
      phase: "specialists",
      outcome: null,
      startedAt: "2026-03-27T15:00:00.000Z",
    };
  }

  it("resume gives an open validation round's specialists their attempt budget back", async () => {
    // An infrastructure halt is resumable precisely because the operator can do
    // something about the provider. If the round's spent-attempt counters
    // survived the resume, every resumed lane would arrive already exhausted and
    // the halt would be permanent in everything but name (R6.1, D5).
    const baseExecution = createWorkflowExecution();
    const contextState = baseExecution.contextStates["context-plan"]!;
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "halted",
        activeContextIds: [],
        haltReason: {
          type: "validator_infra_error",
          contextId: "context-plan",
          engine: "claude",
          infraReason: "exception",
          message: "provider unavailable",
          summary: null,
          assignmentId: "perf-reviewer",
          attempts: 3,
          roundSeq: 2,
        },
        contextStates: {
          ...baseExecution.contextStates,
          "context-plan": {
            ...contextState,
            status: "ready",
            validationRound: openCohortRound({}),
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

    const round = execution.contextStates["context-plan"]?.validationRound;
    expect(round?.seq).toBe(2);
    expect(round?.specialists["perf-reviewer"]).toMatchObject({
      state: "pending",
      attempts: 0,
      lastInfraFailure: null,
    });
    // A verdict the round already collected is not an attempt to give back: it
    // stands, and the resume must not send its reviewer back to work.
    expect(round?.specialists["general"]).toMatchObject({
      state: "verdict_pass",
      summary: "general is satisfied.",
    });
  });

  it("a restart-driven resume leaves the round's spent attempts where the round left them", async () => {
    // The production restart path is normalizeAfterRestart -> paused ->
    // operator resume, and it carries NO halt reason: nobody looked at the
    // provider, the server simply bounced. Handing that resume the same budget
    // reset as an infrastructure halt would let a crash loop buy three fresh
    // dispatches on every restart, so the fixed three-per-specialist-per-round
    // bound would bound nothing (R6.1, D5).
    const baseExecution = createWorkflowExecution();
    const contextState = baseExecution.contextStates["context-plan"]!;
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "running",
        activeContextIds: ["context-plan"],
        haltReason: null,
        contextStates: {
          ...baseExecution.contextStates,
          "context-plan": {
            ...contextState,
            status: "running",
            validationRound: openCohortRound({
              state: "running",
              attempts: 2,
            }),
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

    const normalized = await manager.normalizeAfterRestart(
      "/repo",
      "session-1",
    );
    expect(normalized?.status).toBe("paused");
    expect(normalized?.haltReason).toBeNull();

    const execution = await manager.resume("/repo", "session-1");

    // Two of three already spent before the crash; the restart owes the lane its
    // one remaining attempt, not a new set of three.
    expect(
      execution.contextStates["context-plan"]?.validationRound,
    ).toMatchObject({
      seq: 2,
      specialists: {
        "perf-reviewer": {
          attempts: 2,
          lastInfraFailure: {
            reason: "exception",
            message: "provider unavailable",
          },
        },
      },
    });
  });

  it("resume resets attempts only for the context its infrastructure halt names", async () => {
    // Halt reasons are per-context. A sibling context holding its own open round
    // was not what the operator looked at, so its budget is not theirs to give
    // back (R6.1).
    const baseExecution = createWorkflowExecution();
    const planState = baseExecution.contextStates["context-plan"]!;
    const siblingState = baseExecution.contextStates["context-implement"]!;
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "halted",
        activeContextIds: [],
        haltReason: {
          type: "validator_infra_error",
          contextId: "context-plan",
          engine: "claude",
          infraReason: "exception",
          message: "provider unavailable",
          summary: null,
          assignmentId: "perf-reviewer",
          attempts: 3,
          roundSeq: 2,
        },
        contextStates: {
          ...baseExecution.contextStates,
          "context-plan": {
            ...planState,
            status: "ready",
            validationRound: openCohortRound({}),
          },
          "context-implement": {
            ...siblingState,
            status: "ready",
            validationRound: openCohortRound({
              state: "running",
              attempts: 2,
            }),
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

    expect(
      execution.contextStates["context-plan"]?.validationRound?.specialists[
        "perf-reviewer"
      ],
    ).toMatchObject({ attempts: 0, lastInfraFailure: null });
    expect(
      execution.contextStates["context-implement"]?.validationRound
        ?.specialists["perf-reviewer"],
    ).toMatchObject({ attempts: 2 });
  });

  it("resume honours an infrastructure halt recorded as a secondary reason", async () => {
    // Parallel contexts halt independently, so the infrastructure halt is often
    // not the one that got to be primary. Reading only `haltReason` would leave
    // the exhausted lane at the bound and re-halt on the first pass (R6.1, D5).
    const baseExecution = createWorkflowExecution();
    const planState = baseExecution.contextStates["context-plan"]!;
    const siblingState = baseExecution.contextStates["context-implement"]!;
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "halted",
        activeContextIds: [],
        haltReason: {
          type: "circuit_breaker",
          contextId: "context-implement",
          condition: "retry_exhaustion",
          summary: "tests failed",
          failureCount: 3,
        },
        secondaryHaltReasons: [
          {
            type: "validator_infra_error",
            contextId: "context-plan",
            engine: "claude",
            infraReason: "exception",
            message: "provider unavailable",
            summary: null,
            assignmentId: "perf-reviewer",
            attempts: 3,
            roundSeq: 2,
          },
        ],
        contextStates: {
          ...baseExecution.contextStates,
          "context-plan": {
            ...planState,
            status: "ready",
            validationRound: openCohortRound({}),
          },
          "context-implement": {
            ...siblingState,
            status: "ready",
            validationRound: openCohortRound({
              state: "running",
              attempts: 2,
            }),
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

    expect(
      execution.contextStates["context-plan"]?.validationRound?.specialists[
        "perf-reviewer"
      ],
    ).toMatchObject({ attempts: 0, lastInfraFailure: null });
    // The breaker halt says nothing about infrastructure, so the context it
    // names keeps the attempts its round spent.
    expect(
      execution.contextStates["context-implement"]?.validationRound
        ?.specialists["perf-reviewer"],
    ).toMatchObject({ attempts: 2 });
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
            consecutiveCandidateMismatchCount: 0,
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
      consecutiveCandidateMismatchCount: 0,
    });
  });

  it("resume resets an in-progress merge to pending and schedules a retry", async () => {
    // A merge whose success write was fenced out (resume landed mid-git-op)
    // strands mergeStatus at in-progress: the context is completed so it is
    // never rescheduled, and downstream eligibility requires merged-success.
    // Resume treats it like merged-failed — retry and let the merge runner
    // reconcile against what actually landed on the branch.
    const baseExecution = createWorkflowExecution();
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "halted",
        activeContextIds: [],
        completedAt: "2026-03-27T15:30:00.000Z",
        haltReason: {
          type: "execution_loop_failed",
          contextId: null,
          cause: "unknown",
          message: "Refusing to complete with incomplete contexts",
        },
        contextStates: {
          ...baseExecution.contextStates,
          "context-plan": {
            ...baseExecution.contextStates["context-plan"]!,
            status: "completed",
            isolation: "worktree",
            worktreePath: "/repo/.worktrees/session-1.context-plan",
            branchName: "csm/session-1-context-plan",
            mergeStatus: "in-progress",
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
    expect(execution.pendingMergeRetry).toEqual(["context-plan"]);
    expect(execution.contextStates["context-plan"]).toMatchObject({
      status: "completed",
      mergeStatus: "pending",
      lastMergeError: null,
    });
  });

  it("resume resets a failed join to pending, attaching operator conflict guidance", async () => {
    const baseExecution = createWorkflowExecution();
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "halted",
        // The reason a failed join actually halts with. Resume is a lease act,
        // and the lease predicate reads the REASON — an omitted one is not
        // resumable — so a fixture halting reasonlessly would be exercising a
        // shape this scenario never produces.
        haltReason: {
          type: "join_failure",
          joinId: "join-1",
          joinKind: "final_publish",
          contextId: null,
          sourceLaneIds: ["lane-a", "lane-b"],
          targetLaneId: "session-lane",
          message: "resolution failed",
          conflictFiles: ["src/foo.ts"],
        },
        activeContextIds: [],
        completedAt: "2026-03-27T15:30:00.000Z",
        joins: {
          "join-1": {
            joinId: "join-1",
            kind: "final_publish",
            contextId: null,
            targetLaneId: "session-lane",
            sourceLaneIds: ["lane-a", "lane-b"],
            mergedSourceLaneIds: ["lane-a"],
            validationDebtSourceLaneIds: [],
            status: "conflicts",
            errorMessage: "resolution failed",
            conflicts: {
              files: ["src/foo.ts"],
              message: "resolution failed",
              analysis: null,
            },
            conflictGuidance: null,
            createdAt: "2026-03-27T15:00:00.000Z",
            updatedAt: "2026-03-27T15:20:00.000Z",
            completedAt: "2026-03-27T15:20:00.000Z",
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

    const guidance = [
      {
        file: "src/foo.ts",
        decision: "rejected" as const,
        feedback: "keep both hunks",
      },
    ];
    const execution = await manager.resume("/repo", "session-1", {
      conflictGuidance: guidance,
    });

    expect(execution.status).toBe("running");
    expect(execution.joins["join-1"]).toMatchObject({
      status: "pending",
      errorMessage: null,
      conflicts: null,
      completedAt: null,
      conflictGuidance: guidance,
      // Per-lane progress survives the reset so already-merged lanes are skipped.
      mergedSourceLaneIds: ["lane-a"],
    });
  });

  describe("resume against a resolver-infrastructure join halt", () => {
    function createInfraHaltRepository(
      failure: AgentFailureClassification,
    ): ReturnType<typeof createRepository> {
      const baseExecution = createWorkflowExecution();
      return createRepository(
        createWorkflowExecution({
          ...baseExecution,
          status: "halted",
          haltReason: {
            type: "join_failure",
            joinId: "join-1",
            joinKind: "context_merge",
            contextId: null,
            sourceLaneIds: ["lane-a", "lane-b"],
            targetLaneId: "lane-a",
            message: `Conflict resolution failed before reaching the conflict: ${failure.kind} — ${failure.message}`,
            conflictFiles: ["src/binding.ts"],
            resolutionFailure: failure,
          },
          activeContextIds: [],
          completedAt: "2026-03-27T15:30:00.000Z",
          joins: {
            "join-1": {
              joinId: "join-1",
              kind: "context_merge",
              contextId: null,
              targetLaneId: "lane-a",
              sourceLaneIds: ["lane-a", "lane-b"],
              mergedSourceLaneIds: [],
              validationDebtSourceLaneIds: [],
              status: "failed",
              errorMessage: "resolver failed",
              conflicts: null,
              conflictGuidance: null,
              createdAt: "2026-03-27T15:00:00.000Z",
              updatedAt: "2026-03-27T15:20:00.000Z",
              completedAt: "2026-03-27T15:20:00.000Z",
            },
          },
        }),
      );
    }

    it("refuses a system-initiated resume when the resolver failure is not retryable, and still lets the operator retry", async () => {
      // Incident 3edd5fd7: rescheduling the join nine seconds after a quota
      // wall that resets in three days buys nothing and burns the attempt.
      const repository = createInfraHaltRepository({
        kind: "quota_exhausted",
        message: "You've hit your usage limit.",
        retryable: false,
        retryAfterHint: "Aug 19th, 2026 11:29 PM",
      });
      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
      });

      await expect(
        manager.resume("/repo", "session-1", { initiator: "system" }),
      ).rejects.toThrow(/quota_exhausted/);
      expect(repository.read()?.status).toBe("halted");
      expect(repository.read()?.joins["join-1"]?.status).toBe("failed");

      // The operator may have restored capacity, so their resume proceeds.
      const resumed = await manager.resume("/repo", "session-1");
      expect(resumed.status).toBe("running");
      expect(resumed.joins["join-1"]?.status).toBe("pending");
    });

    it("lets a system-initiated resume proceed when the resolver failure is retryable", async () => {
      const repository = createInfraHaltRepository({
        kind: "schema_validation",
        message: "no schema-valid resolution survived",
        retryable: true,
      });
      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
      });

      const resumed = await manager.resume("/repo", "session-1", {
        initiator: "system",
      });

      expect(resumed.status).toBe("running");
      expect(resumed.joins["join-1"]?.status).toBe("pending");
    });
  });

  it("resume without guidance still resets failed joins and leaves succeeded joins untouched", async () => {
    const baseExecution = createWorkflowExecution();
    const succeededJoin = {
      joinId: "join-ok",
      kind: "context_merge" as const,
      contextId: null,
      targetLaneId: "lane-a",
      sourceLaneIds: ["lane-a", "lane-c"],
      mergedSourceLaneIds: ["lane-c"],
      validationDebtSourceLaneIds: [],
      status: "succeeded" as const,
      errorMessage: null,
      conflicts: null,
      conflictGuidance: null,
      createdAt: "2026-03-27T14:00:00.000Z",
      updatedAt: "2026-03-27T14:10:00.000Z",
      completedAt: "2026-03-27T14:10:00.000Z",
    };
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "halted",
        // The failing join's own reason, for the same cause as the case above:
        // resume is admitted on the lease, and the lease reads the halt reason.
        haltReason: {
          type: "join_failure",
          joinId: "join-bad",
          joinKind: "context_merge",
          contextId: null,
          sourceLaneIds: ["lane-a", "lane-c"],
          targetLaneId: "lane-a",
          message: "merge failed",
          conflictFiles: [],
        },
        activeContextIds: [],
        joins: {
          "join-ok": succeededJoin,
          "join-bad": {
            ...succeededJoin,
            joinId: "join-bad",
            status: "failed",
            errorMessage: "merge failed",
            mergedSourceLaneIds: [],
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

    expect(execution.joins["join-ok"]).toEqual(succeededJoin);
    expect(execution.joins["join-bad"]).toMatchObject({
      status: "pending",
      errorMessage: null,
      conflictGuidance: null,
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

    const firstReason: import("@/lib/workflow-graph/schemas").GraphWorkflowHaltReason =
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

  it("does not record a loop failure on a replacement active execution", async () => {
    const replacement = createWorkflowExecution({
      id: "execution-replacement",
      status: "running",
    });
    const repository = createRepository(replacement);
    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
    });

    const result = await manager.recordPendingHaltReason({
      projectPath: "/repo",
      sessionName: "session-1",
      expectedExecutionId: "execution-failed",
      reason: { type: "recovery_error", message: "failed loop" },
    });

    expect(result.accepted).toBe(false);
    expect(repository.read()).toMatchObject({
      id: "execution-replacement",
      status: "running",
      pendingHaltReason: null,
    });
  });

  it("rejects resuming an aborted execution", async () => {
    const repository = createRepository(
      createWorkflowExecution({
        status: "aborted",
        activeContextIds: ["context-plan"],
        completedAt: "2026-03-27T15:30:00.000Z",
        haltReason: { type: "aborted", cause: null, summary: null },
        contextStates: {
          "context-plan": {
            skipReason: null,
            landingIntent: null,
            pendingApproval: null,
            pendingUserInputs: {},
            contextId: "context-plan",
            status: "ready",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 1,
            consecutiveFailureCount: 0,
            consecutiveCandidateMismatchCount: 0,
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
            backend: "claude",
            refKind: "conversation",
            lane: "implementer",
            contextId: "context-implement",
            workflowConversationId: "conv-old",
            sessionRef: { backend: "claude", ref: "conv-old" },
            metrics: {
              contextTokens: 50_000,
              contextWindowMax: 200_000,
              rotateBeforeNextTurn: false,
            },
            limitEvaluation: "disabled",
            lastUsedAt: "2026-03-27T15:00:00.000Z",
          },
        },
      },
      contextStates: {
        "context-plan": {
          skipReason: null,
          landingIntent: null,
          pendingApproval: null,
          pendingUserInputs: {},
          contextId: "context-plan",
          status: "completed",
          totalTaskCount: 1,
          completedTaskCount: 1,
          iterationCount: 1,
          consecutiveFailureCount: 0,
          consecutiveCandidateMismatchCount: 0,
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
          skipReason: null,
          landingIntent: null,
          pendingApproval: null,
          pendingUserInputs: {},
          contextId: "context-implement",
          status: "pending",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
          consecutiveCandidateMismatchCount: 0,
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
          skipReason: null,
          landingIntent: null,
          pendingApproval: null,
          pendingUserInputs: {},
          contextId: "context-verify",
          status: "pending",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
          consecutiveCandidateMismatchCount: 0,
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
            skipReason: null,
            landingIntent: null,
            pendingApproval: null,
            pendingUserInputs: {},
            contextId: "context-plan",
            status: "completed",
            totalTaskCount: 1,
            completedTaskCount: 1,
            iterationCount: 2,
            consecutiveFailureCount: 0,
            consecutiveCandidateMismatchCount: 0,
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
            skipReason: null,
            landingIntent: null,
            pendingApproval: null,
            pendingUserInputs: {},
            contextId: "context-implement",
            status: "ready",
            totalTaskCount: 1,
            completedTaskCount: 1,
            iterationCount: 3,
            consecutiveFailureCount: 2,
            consecutiveCandidateMismatchCount: 0,
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
            skipReason: null,
            landingIntent: null,
            pendingApproval: null,
            pendingUserInputs: {},
            contextId: "context-verify",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
            consecutiveCandidateMismatchCount: 0,
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
              backend: "claude",
              refKind: "conversation",
              lane: "implementer",
              contextId: "context-implement",
              workflowConversationId: "conv-impl",
              sessionRef: { backend: "claude", ref: "conv-impl" },
              metrics: {
                contextTokens: 10,
                contextWindowMax: 100,
                rotateBeforeNextTurn: false,
              },
              limitEvaluation: "disabled",
              lastUsedAt: "2026-03-27T15:10:00.000Z",
            },
          },
          "context-plan": {
            context_validator: {
              backend: "claude",
              refKind: "conversation",
              lane: "context_validator",
              contextId: "context-plan",
              workflowConversationId: "conv-val",
              sessionRef: { backend: "claude", ref: "conv-val" },
              metrics: { rotateBeforeNextTurn: false },
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

    it("persists the selected context reset through the repository", async () => {
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

      expect(execution.contextStates["context-implement"]).toMatchObject({
        status: "pending",
        completedTaskCount: 0,
        iterationCount: 0,
      });
      expect(execution.taskStates["task-implement-1"]).toMatchObject({
        status: "pending",
        summary: null,
        failureMessage: null,
      });
      expect(execution.laneStates["context-implement"]).toBeUndefined();
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
          summary: null,
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
            summary: null,
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

  describe("resetContextAssignment", () => {
    function createHaltedExecutionWithCohort(): GraphWorkflowExecution {
      const execution = createWorkflowExecution({
        ...createWorkflowExecution({ status: "halted" }),
      });
      const context = execution.workingDefinition.executionContexts.find(
        (entry) => entry.id === "context-implement",
      )!;
      context.contextValidator = {
        enabled: true,
        assignments: [
          makeSeededValidatorAssignment({ id: "alpha" }),
          makeSeededValidatorAssignment({ id: "beta" }),
        ],
      };
      const lane = (conversationId: string, assignmentId: string) => ({
        backend: "claude" as const,
        refKind: "conversation" as const,
        lane: "context_validator" as const,
        contextId: "context-implement",
        assignmentId,
        workflowConversationId: conversationId,
        sessionRef: { backend: "claude" as const, ref: conversationId },
        metrics: { rotateBeforeNextTurn: false },
        limitEvaluation: "disabled" as const,
        lastUsedAt: "2026-03-27T15:11:00.000Z",
      });
      execution.laneStates = {
        "context-implement": {
          "context_validator:alpha": lane("conv-alpha", "alpha"),
          "context_validator:beta": lane("conv-beta", "beta"),
        },
      };
      return execution;
    }

    it("retires only the reset assignment's lane conversation and leaves siblings alone", async () => {
      const repository = createRepository(createHaltedExecutionWithCohort());
      const retireLaneConversation = vi.fn();

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
        retireLaneConversation,
      });

      const execution = await manager.resetContextAssignment(
        "/repo",
        "session-1",
        "context-implement",
        "alpha",
      );

      expect(retireLaneConversation).toHaveBeenCalledTimes(1);
      expect(retireLaneConversation).toHaveBeenCalledWith({
        projectPath: "/repo",
        sessionName: "session-1",
        conversationId: "conv-alpha",
      });
      const lanes = execution.laneStates["context-implement"]!;
      expect(lanes["context_validator:alpha"]).toBeUndefined();
      expect(lanes["context_validator:beta"]?.workflowConversationId).toBe(
        "conv-beta",
      );
      // The execution stays halted — a per-assignment reset is not a resume.
      expect(execution.status).toBe("halted");
    });

    it("rejects a reset while the execution is running", async () => {
      const running = createHaltedExecutionWithCohort();
      running.status = "running";
      const repository = createRepository(running);

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
      });

      await expect(
        manager.resetContextAssignment(
          "/repo",
          "session-1",
          "context-implement",
          "alpha",
        ),
      ).rejects.toThrow(/paused or halted/i);
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
      // Branch names whose `disposeLane` rejects — used to prove best-effort
      // disposal (every lane is still attempted) and that reservation release
      // still runs after a disposal failure.
      failDisposeBranchNames?: readonly string[];
      // Runs after each provision is recorded — used to simulate a concurrent
      // supersession (e.g. a resume bumping loopEpoch) while the slow worktree
      // work is in flight, out of the write lock.
      onProvision?: (input: ProvisionInput) => void | Promise<void>;
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
        if (options?.onProvision) {
          await options.onProvision(input);
        }
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
        // Record the attempt BEFORE any rejection so `disposeCalls` proves the
        // lane was attempted even when disposal fails.
        disposeCalls.push(input);
        if (options?.failDisposeBranchNames?.includes(input.branchName)) {
          throw new Error(`dispose failed for ${input.branchName}`);
        }
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
              skipReason: null,
              landingIntent: null,
              pendingApproval: null,
              pendingUserInputs: {},
              contextId: "context-plan",
              status: "completed",
              totalTaskCount: 1,
              completedTaskCount: 1,
              iterationCount: 1,
              consecutiveFailureCount: 0,
              consecutiveCandidateMismatchCount: 0,
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
              skipReason: null,
              landingIntent: null,
              pendingApproval: null,
              pendingUserInputs: {},
              contextId: "context-implement",
              status: "completed",
              totalTaskCount: 1,
              completedTaskCount: 1,
              iterationCount: 1,
              consecutiveFailureCount: 0,
              consecutiveCandidateMismatchCount: 0,
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
              skipReason: null,
              landingIntent: null,
              pendingApproval: null,
              pendingUserInputs: {},
              contextId: "context-verify",
              status: "completed",
              totalTaskCount: 1,
              completedTaskCount: 1,
              iterationCount: 1,
              consecutiveFailureCount: 0,
              consecutiveCandidateMismatchCount: 0,
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

    it("schedules a context authored onto the session lane inside the session worktree without a sub-worktree", async () => {
      // The session lane IS the session worktree: it is never provisioned and
      // never lands through a join, which is why only a read-only context may
      // be authored onto it. A group lane, by contrast, always costs a worktree.
      const sessionLaneDefinition = createResolvedWorkflowDefinition();
      const baseExecution = createWorkflowExecution({
        workingDefinition: {
          ...sessionLaneDefinition,
          executionContexts: sessionLaneDefinition.executionContexts.map(
            (context) =>
              context.id === "context-plan"
                ? {
                    ...context,
                    placement: { lane: SESSION_LANE_NAME, mode: "readOnly" },
                    outputSchema: {
                      type: "object" as const,
                      properties: { plan: { type: "string" as const } },
                    },
                  }
                : context,
          ),
        },
      });
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
      expect(planState?.laneId).toBeNull();
      expect(planState?.landingIntent).toBeNull();
      expect(result.execution.executionLanes[SESSION_LANE_ID]).toBeUndefined();
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
        "/repo/.worktrees/feature-abc.verify",
      );
      expect(verifyState?.branchName).toBe("csm/feature-abc-verify");
      expect(verifyState?.batchId).toBe(result.scheduled.batchId);

      expect(parallelWorktrees.provisionCalls.map((c) => c.contextId)).toEqual([
        "verify",
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
        "/repo/.worktrees/feature-abc.verify",
      );

      expect(parallelWorktrees.provisionCalls.map((c) => c.contextId)).toEqual([
        "verify",
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
        "/repo/.worktrees/feature-abc.verify",
      );

      expect(parallelWorktrees.provisionCalls.map((c) => c.contextId)).toEqual([
        "verify",
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

    it("does not double-provision reserved contexts when a concurrent same-epoch scheduler runs during provisioning", async () => {
      // Owner-discriminated reservation (Design 3.1): the reserve mutation stamps
      // each claimed context before provisioning worktrees out of the lock. A
      // second scheduler running in that window must see the stamped contexts as
      // ineligible, so it schedules and provisions nothing — the batch is
      // provisioned exactly once.
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

      // Boxed so the value assigned inside the `onProvision` callback keeps its
      // declared union type when read after the await (closure-assignment CFA):
      // a bare `let` would be narrowed to its `null` initializer at the read
      // site, collapsing the post-null-guard type to `never`.
      const concurrentResult: { value: ScheduleEligibleContextsResult | null } =
        {
          value: null,
        };
      let ranConcurrent = false;
      // Indirection so the stub can reach the manager without referencing it
      // before its declaration; wired after the manager is built.
      let onFirstProvision: (() => Promise<void>) | null = null;
      const parallelWorktrees = createParallelWorktreesStub({
        // Fire ONE concurrent scheduler while the first pass is provisioning out
        // of the lock (both reservations are already committed by then).
        async onProvision() {
          if (ranConcurrent) return;
          ranConcurrent = true;
          if (onFirstProvision) await onFirstProvision();
        },
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

      onFirstProvision = async () => {
        concurrentResult.value = await manager.scheduleEligibleContexts({
          projectPath: "/repo",
          sessionName: "session-1",
        });
      };

      const result = await manager.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName: "session-1",
      });

      // The first pass provisioned each eligible context exactly once.
      expect(result.scheduled.kind).toBe("parallel");
      expect(
        parallelWorktrees.provisionCalls.map((c) => c.contextId).sort(),
      ).toEqual(["implement", "verify"]);

      // The concurrent scheduler saw both contexts as reserved → nothing to
      // schedule, and it provisioned nothing (no double-provision).
      expect(ranConcurrent).toBe(true);
      const captured = concurrentResult.value;
      if (captured === null) {
        throw new Error("concurrent scheduler did not run");
      }
      expect(captured.scheduled).toEqual({ kind: "none" });

      // Reservation stamps are cleared once the finalize commits.
      expect(
        result.execution.contextStates["context-implement"]
          ?.reservedByBatchId ?? null,
      ).toBeNull();
      expect(
        result.execution.contextStates["context-verify"]?.reservedByBatchId ??
          null,
      ).toBeNull();
    });

    it("releases the reserve's stamps (contexts stay eligible) when getSession fails after the reserve commits", async () => {
      // Reservation-stranding guard (Design 3.1): the reserve mutation stamps
      // `reservedByBatchId` and commits BEFORE resolving the session out of the
      // lock. If that lookup then rejects, every post-reserve failure path must
      // release the stamps — otherwise the contexts are ineligible for a
      // same-epoch retry forever. This drives a `getSession` rejection after the
      // reserve and asserts the stamps are cleared AND a retry schedules them.
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

      // getSession rejects on the FIRST scheduling pass (after the reserve
      // commits), then succeeds on the retry.
      let sessionCalls = 0;
      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
        parallelWorktrees,
        async getSession() {
          sessionCalls += 1;
          if (sessionCalls === 1) {
            throw new Error("session lookup failed");
          }
          return createSession({
            worktreePath: "/repo/.worktrees/feature-abc",
            branchName: "csm/feature-abc",
          });
        },
      });

      // First pass: reserve commits, then getSession rejects → the call rejects.
      await expect(
        manager.scheduleEligibleContexts({
          projectPath: "/repo",
          sessionName: "session-1",
        }),
      ).rejects.toThrow("session lookup failed");

      // Nothing was provisioned, and the reserve's stamps were released — the
      // contexts are not stranded ineligible.
      expect(parallelWorktrees.provisionCalls).toEqual([]);
      const afterFailure = repository.read();
      expect(
        afterFailure?.contextStates["context-implement"]?.reservedByBatchId ??
          null,
      ).toBeNull();
      expect(
        afterFailure?.contextStates["context-verify"]?.reservedByBatchId ??
          null,
      ).toBeNull();

      // A same-epoch retry now schedules both contexts, proving they stayed
      // eligible after the release.
      const retry = await manager.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName: "session-1",
      });
      expect(retry.scheduled.kind).toBe("parallel");
      expect(
        parallelWorktrees.provisionCalls.map((c) => c.contextId).sort(),
      ).toEqual(["implement", "verify"]);
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
        "/repo/.worktrees/feature-abc.implement",
      );
      expect(implState?.branchName).toBe("csm/feature-abc-implement");
      expect(implState?.batchId).toBe(result.scheduled.batchId);

      const verifyState = result.execution.contextStates["context-verify"];
      expect(verifyState?.status).toBe("running");
      expect(verifyState?.isolation).toBe("worktree");
      expect(verifyState?.worktreePath).toBe(
        "/repo/.worktrees/feature-abc.verify",
      );
      expect(verifyState?.branchName).toBe("csm/feature-abc-verify");
      expect(verifyState?.batchId).toBe(result.scheduled.batchId);

      // Every provisioned worktree is a lane — terminal contexts included —
      // so their work publishes through the gated final_publish join instead
      // of the legacy laneId-null fan-in that bypasses the delivery gate.
      expect(implState?.laneId).toBe("implement");
      expect(verifyState?.laneId).toBe("verify");
      expect(result.execution.executionLanes["implement"]?.kind).toBe(
        "worktree",
      );
      expect(result.execution.executionLanes["verify"]?.kind).toBe("worktree");

      expect(
        parallelWorktrees.provisionCalls.map((c) => c.contextId).sort(),
      ).toEqual(["implement", "verify"]);
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
        failOnContextId: "verify",
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
        "csm/feature-abc-implement",
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

    it("owner-checks the reserve release and surfaces the provision error even when compensating disposal rejects", async () => {
      // Compensation reliability (Design 3.1 finalize-or-compensate). When
      // provisioning fails, the catch disposes the already-provisioned lanes
      // AND releases the reserve's stamps. Here the compensating `disposeLane`
      // REJECTS — the release must still run (else the contexts strand
      // ineligible), the ORIGINAL provision error (not the disposal error) must
      // surface, and the release is OWNER-CHECKED so a stamp a concurrent
      // same-epoch batch re-owns is left intact.
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

      // context-implement provisions first (success); while it is in flight,
      // simulate a concurrent same-epoch batch re-reserving context-verify by
      // stamping it with a DIFFERENT batchId. context-verify's own provision
      // then fails, triggering compensation. The loop generation is NOT bumped,
      // so the release commits (it is not fenced out).
      const parallelWorktrees = createParallelWorktreesStub({
        failOnContextId: "verify",
        failureMessage: "disk full",
        failDisposeBranchNames: ["csm/feature-abc-implement"],
        async onProvision(input) {
          if (input.contextId !== "implement") return;
          const persisted = repository.read();
          if (!persisted) return;
          const ownBatchId =
            persisted.contextStates["context-implement"]?.reservedByBatchId ??
            "batch";
          await repository.update("/repo", "session-1", {
            ...persisted,
            contextStates: {
              ...persisted.contextStates,
              "context-verify": {
                ...persisted.contextStates["context-verify"]!,
                reservedByBatchId: `${ownBatchId}-foreign`,
              },
            },
          });
        },
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

      // The ORIGINAL provision error surfaces — not the disposal rejection.
      await expect(
        manager.scheduleEligibleContexts({
          projectPath: "/repo",
          sessionName: "session-1",
        }),
      ).rejects.toThrow(/disk full/);

      // The failing disposal was still ATTEMPTED (best-effort).
      expect(parallelWorktrees.disposeCalls.map((c) => c.branchName)).toEqual([
        "csm/feature-abc-implement",
      ]);

      const persisted = repository.read();
      // Owner-checked release ran despite the disposal rejection: this batch's
      // own stamp (context-implement) is cleared so it re-schedules...
      expect(
        persisted?.contextStates["context-implement"]?.reservedByBatchId ??
          null,
      ).toBeNull();
      // ...but the foreign batch's stamp on context-verify is left intact.
      expect(
        persisted?.contextStates["context-verify"]?.reservedByBatchId,
      ).toMatch(/-foreign$/);
    });

    it("refuses the fenced finalize and disposes provisioned worktrees when the loop generation is superseded mid-provision", async () => {
      // Two eligible contexts route through the staged protocol: reserve marks
      // them ready, provisioning runs out of the lock, then a fenced finalize
      // commits the batch. This test supersedes the loop generation while the
      // slow provisioning is in flight and asserts the finalize refuses to
      // commit and disposes the orphaned worktrees.
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
      const executionId = initialExecution.id;

      // The first provision simulates a concurrent resume superseding this
      // generation: it bumps the persisted loopEpoch out from under the
      // in-flight schedule, out of the write lock.
      const parallelWorktrees = createParallelWorktreesStub({
        async onProvision() {
          const persisted = repository.read();
          if (persisted && persisted.loopEpoch === 0) {
            await repository.update("/repo", "session-1", {
              ...persisted,
              loopEpoch: 1,
            });
          }
        },
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
        runWithLoopFence(
          {
            projectPath: "/repo",
            sessionName: "session-1",
            executionId,
            loopEpoch: 0,
          },
          () =>
            manager.scheduleEligibleContexts({
              projectPath: "/repo",
              sessionName: "session-1",
            }),
        ),
      ).rejects.toBeInstanceOf(StaleLoopFenceError);

      // Both worktrees were provisioned out of the lock, then the fenced
      // finalize refused to commit and disposed them as compensation.
      expect(
        parallelWorktrees.provisionCalls.map((c) => c.contextId).sort(),
      ).toEqual(["implement", "verify"]);
      expect(
        parallelWorktrees.disposeCalls.map((c) => c.branchName).sort(),
      ).toEqual(["csm/feature-abc-implement", "csm/feature-abc-verify"]);

      // The superseded generation committed no running/lane state for the batch.
      const persisted = repository.read();
      expect(persisted?.loopEpoch).toBe(1);
      expect(persisted?.contextStates["context-implement"]?.status).not.toBe(
        "running",
      );
      expect(persisted?.contextStates["context-verify"]?.status).not.toBe(
        "running",
      );
    });

    it("attempts every lane's disposal (best-effort) and surfaces the fence error when a compensating disposal rejects", async () => {
      // Best-effort disposal (Design 3.1). Two lanes provision out of the lock,
      // then a concurrent resume supersedes the generation so the fenced
      // finalize refuses and disposes both lanes as compensation. Disposing the
      // FIRST lane rejects — the second lane must still be attempted, and the
      // original StaleLoopFenceError (not the disposal error) must surface.
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
      const executionId = initialExecution.id;

      const parallelWorktrees = createParallelWorktreesStub({
        // BOTH lanes' disposal rejects; the first rejection must not abort the
        // second attempt.
        failDisposeBranchNames: [
          "csm/feature-abc-implement",
          "csm/feature-abc-verify",
        ],
        async onProvision() {
          const persisted = repository.read();
          if (persisted && persisted.loopEpoch === 0) {
            await repository.update("/repo", "session-1", {
              ...persisted,
              loopEpoch: 1,
            });
          }
        },
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

      // The fenced finalize's StaleLoopFenceError surfaces — not the disposal
      // rejection that happened during compensation.
      await expect(
        runWithLoopFence(
          {
            projectPath: "/repo",
            sessionName: "session-1",
            executionId,
            loopEpoch: 0,
          },
          () =>
            manager.scheduleEligibleContexts({
              projectPath: "/repo",
              sessionName: "session-1",
            }),
        ),
      ).rejects.toBeInstanceOf(StaleLoopFenceError);

      // Both lanes were attempted for disposal even though the first rejected —
      // disposal is best-effort across every lane.
      expect(
        parallelWorktrees.disposeCalls.map((c) => c.branchName).sort(),
      ).toEqual(["csm/feature-abc-implement", "csm/feature-abc-verify"]);
    });

    it("rejects scheduling before any worktree is created when a contextId is unsafe", async () => {
      const unsafeDefinition = createResolvedWorkflowDefinition({
        executionContexts: [
          {
            placement: { lane: "context-plan", mode: "full" as const },
            id: "context-plan",
            title: "Plan",
            acceptanceCriteria: "Plan complete",
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
            mutability: {
              allowAgentTaskAdd: false,
              allowAgentContextAdd: false,
            },
            circuitBreaker: {},
            iterationPolicy: {
              maxIterations: 4,
              continuity: { enabled: true },
            },
            planRepair: { enabled: true, maxAttemptsPerContext: 2 },
          },
          {
            placement: { lane: "..escape", mode: "full" as const },
            id: "..escape",
            title: "Bad",
            acceptanceCriteria: "n/a",
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
            mutability: {
              allowAgentTaskAdd: false,
              allowAgentContextAdd: false,
            },
            circuitBreaker: {},
            iterationPolicy: {
              maxIterations: 4,
              continuity: { enabled: true },
            },
            planRepair: { enabled: true, maxAttemptsPerContext: 2 },
          },
          {
            placement: { lane: "context-other", mode: "full" as const },
            id: "context-other",
            title: "Other",
            acceptanceCriteria: "n/a",
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
            mutability: {
              allowAgentTaskAdd: false,
              allowAgentContextAdd: false,
            },
            circuitBreaker: {},
            iterationPolicy: {
              maxIterations: 4,
              continuity: { enabled: true },
            },
            planRepair: { enabled: true, maxAttemptsPerContext: 2 },
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
              skipReason: null,
              landingIntent: null,
              pendingApproval: null,
              pendingUserInputs: {},
              contextId: "context-plan",
              status: "completed",
              totalTaskCount: 1,
              completedTaskCount: 1,
              iterationCount: 1,
              consecutiveFailureCount: 0,
              consecutiveCandidateMismatchCount: 0,
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
              skipReason: null,
              landingIntent: null,
              pendingApproval: null,
              pendingUserInputs: {},
              contextId: "..escape",
              status: "pending",
              totalTaskCount: 1,
              completedTaskCount: 0,
              iterationCount: 0,
              consecutiveFailureCount: 0,
              consecutiveCandidateMismatchCount: 0,
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
              skipReason: null,
              landingIntent: null,
              pendingApproval: null,
              pendingUserInputs: {},
              contextId: "context-other",
              status: "pending",
              totalTaskCount: 1,
              completedTaskCount: 0,
              iterationCount: 0,
              consecutiveFailureCount: 0,
              consecutiveCandidateMismatchCount: 0,
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
      ).rejects.toThrow(/laneId/i);

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

    it("reuses the upstream's lane (no provisioning) when its output is lane-committed and downstream is placed on that lane", async () => {
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
        workingDefinition: withContextsOnLane(
          createResolvedWorkflowDefinition(),
          "lane-plan",
          ["context-plan", "context-implement"],
        ),
      });
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

    it("forks the authored lane from the post-join common target once two upstreams are joined into it", async () => {
      // Authored placement is the only lane authority: the converged lane is
      // the fork BASE that carries both upstreams' work, never the destination.
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
              validationDebtSourceLaneIds: [],
              status: "succeeded",
              errorMessage: null,
              conflicts: null,
              conflictGuidance: null,
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
      expect(verifyState?.laneId).toBe("verify");
      expect(verifyState?.isolation).toBe("worktree");

      // One worktree, branched off the converged lane so both upstreams are in
      // its history — and the fork inherits their context ids for visibility.
      expect(
        parallelWorktrees.provisionCalls.map((call) => ({
          contextId: call.contextId,
          sessionBranch: call.sessionBranch,
        })),
      ).toEqual([
        { contextId: "verify", sessionBranch: laneTarget.branchName },
      ]);
      expect(
        result.execution.executionLanes.verify?.includedContextIds.sort(),
      ).toEqual(["context-implement", "context-plan"]);
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
      // The forked worktree is a lane like every provisioned worktree, so its
      // output publishes through the gated final_publish join.
      expect(implState?.laneId).toBe("implement");
      expect(implState?.worktreePath).toBe(
        "/repo/.worktrees/feature-abc.implement",
      );

      expect(result.execution.executionLanes["implement"]?.kind).toBe(
        "worktree",
      );

      expect(parallelWorktrees.provisionCalls.map((c) => c.contextId)).toEqual([
        "implement",
      ]);
    });

    it("schedules both fan-out children in one pass: each forks its own worktree lane from the parent's branch because neither is placed on the parent lane", async () => {
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
      // Each child is placed on its own lane, so neither takes the parent's:
      // both fork from its committed head into a worktree of their own.
      expect(result.scheduled.contextIds.slice().sort()).toEqual([
        "context-implement",
        "context-verify",
      ]);

      const inheritState = result.execution.contextStates["context-implement"];
      expect(inheritState?.status).toBe("running");
      expect(inheritState?.laneId).toBe("implement");
      expect(inheritState?.isolation).toBe("worktree");
      expect(inheritState?.worktreePath).toBe(
        "/repo/.worktrees/feature-abc.implement",
      );
      expect(inheritState?.branchName).toBe("csm/feature-abc-implement");

      const forkState = result.execution.contextStates["context-verify"];
      expect(forkState?.status).toBe("running");
      expect(forkState?.laneId).toBe("verify");
      expect(forkState?.isolation).toBe("worktree");
      expect(forkState?.worktreePath).toBe(
        "/repo/.worktrees/feature-abc.verify",
      );
      expect(forkState?.branchName).toBe("csm/feature-abc-verify");

      const forkedLane = result.execution.executionLanes["verify"];
      expect(forkedLane).toBeDefined();
      expect(forkedLane?.kind).toBe("worktree");
      expect(forkedLane?.status).toBe("active");
      expect(forkedLane?.worktreePath).toBe(
        "/repo/.worktrees/feature-abc.verify",
      );
      expect(forkedLane?.branchName).toBe("csm/feature-abc-verify");
      expect(forkedLane?.includedContextIds).toEqual(["context-plan"]);
      expect(forkedLane?.lastCommittingContextId).toBe("context-plan");
      expect(forkedLane?.commitSnapshots).toEqual([]);

      // Parent lane retained as-is; each fork is a separate entry.
      expect(result.execution.executionLanes["lane-plan"]).toEqual(lane);
      expect(
        result.execution.executionLanes["implement"]?.includedContextIds,
      ).toEqual(["context-plan"]);

      // One worktree per child, each based on the parent lane's branch — that's
      // the fork-from-committed-head semantics.
      expect(parallelWorktrees.provisionCalls).toHaveLength(2);
      expect(
        parallelWorktrees.provisionCalls.map((c) => c.contextId).sort(),
      ).toEqual(["implement", "verify"]);
      for (const call of parallelWorktrees.provisionCalls) {
        expect(call.sessionBranch).toBe(lane.branchName);
      }
      const forkCall = parallelWorktrees.provisionCalls.find(
        (c) => c.contextId === "verify",
      )!;
      expect(forkCall.contextId).toBe("verify");
      expect(forkCall.sessionBranch).toBe(lane.branchName);
      expect(forkCall.sessionDir).toBe("feature-abc");
    });

    // Two siblings PLACED on the same lane contend for its one worktree. The
    // first in definition order takes it; the other waits for a later pass
    // rather than forking, because a fork would mint a second lane under the
    // name their shared placement already owns.
    it("gives the contested lane to the first sibling in definition order at fan-out, holding the other back", async () => {
      const fanOutDefinition = withContextsOnLane(
        createResolvedWorkflowDefinition({
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
        }),
        "lane-plan",
        ["context-implement", "context-verify"],
      );
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
      // Only the winner is scheduled this pass.
      expect(result.scheduled.contextIds).toEqual(["context-implement"]);

      const winnerState = result.execution.contextStates["context-implement"];
      expect(winnerState?.laneId).toBe("lane-plan");
      expect(winnerState?.status).toBe("running");

      const heldBackState = result.execution.contextStates["context-verify"];
      expect(heldBackState?.status).not.toBe("running");
      expect(heldBackState?.laneId).toBeNull();

      // The shared lane already exists, so nothing is provisioned and no second
      // lane appears under its name.
      expect(parallelWorktrees.provisionCalls).toEqual([]);
      expect(Object.keys(result.execution.executionLanes)).toEqual([
        "lane-plan",
      ]);
    });

    it("deterministically restarts a fan-out: the same two forked lanes on a fresh scheduling pass", async () => {
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
      const seedRun = (extra: {
        sessionName: string;
      }): GraphWorkflowExecution =>
        createWorkflowExecution({
          ...baseExecution,
          id: `execution-${extra.sessionName}`,
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

        const implementState =
          result.execution.contextStates["context-implement"];
        expect(implementState?.laneId).toBe("implement");
        expect(implementState?.isolation).toBe("worktree");

        const verifyState = result.execution.contextStates["context-verify"];
        expect(verifyState?.laneId).toBe("verify");
        expect(verifyState?.isolation).toBe("worktree");

        for (const laneId of ["implement", "verify"]) {
          expect(result.execution.executionLanes[laneId]).toBeDefined();
          expect(
            result.execution.executionLanes[laneId]?.includedContextIds,
          ).toEqual(["context-plan"]);
        }

        expect(parallelWorktrees.provisionCalls).toHaveLength(2);
        expect(
          parallelWorktrees.provisionCalls.map((c) => c.contextId).sort(),
        ).toEqual(["implement", "verify"]);
        for (const call of parallelWorktrees.provisionCalls) {
          expect(call.sessionBranch).toBe(lane.branchName);
        }
      }
    });

    it("gives each fan-out sibling its own authored lane, both forked from the session-kind parent's branch", async () => {
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
      expect([...result.scheduled.contextIds].sort()).toEqual([
        "context-implement",
        "context-verify",
      ]);

      // Authored placement, not a continuation contest: neither sibling
      // inherits the parent lane, and each gets the lane it declared.
      expect(result.execution.contextStates["context-implement"]?.laneId).toBe(
        "implement",
      );
      expect(result.execution.contextStates["context-verify"]?.laneId).toBe(
        "verify",
      );
      expect(
        parallelWorktrees.provisionCalls.map((c) => c.contextId).sort(),
      ).toEqual(["implement", "verify"]);
      for (const call of parallelWorktrees.provisionCalls) {
        expect(call.sessionBranch).toBe(sessionLane.branchName);
      }
    });

    it("routes a context authored onto the session lane with isolation=session and no worktree provisioning", async () => {
      const sessionLane = {
        laneId: SESSION_LANE_ID,
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
      const sessionPlacedDefinition = createResolvedWorkflowDefinition();
      const definition = {
        ...sessionPlacedDefinition,
        executionContexts: sessionPlacedDefinition.executionContexts.map(
          (context) =>
            context.id === "context-implement"
              ? {
                  ...context,
                  placement: {
                    lane: SESSION_LANE_NAME,
                    mode: "readOnly" as const,
                  },
                  outputSchema: {
                    type: "object" as const,
                    properties: { review: { type: "string" as const } },
                  },
                }
              : context,
        ),
      };
      const baseExecution = createWorkflowExecution({
        workingDefinition: definition,
      });
      const repository = createRepository(
        createWorkflowExecution({
          ...baseExecution,
          status: "running",
          workingDefinition: definition,
          executionLanes: { [SESSION_LANE_ID]: sessionLane },
          contextStates: {
            ...baseExecution.contextStates,
            "context-plan": {
              ...baseExecution.contextStates["context-plan"]!,
              status: "completed",
              isolation: "session",
              laneId: SESSION_LANE_ID,
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

      expect(result.scheduled).toEqual({
        kind: "solo",
        contextId: "context-implement",
      });

      const implState = result.execution.contextStates["context-implement"];
      expect(implState?.status).toBe("running");
      expect(implState?.laneId).toBeNull();
      expect(implState?.isolation).toBe("session");
      expect(implState?.worktreePath).toBeNull();
      expect(implState?.branchName).toBeNull();
      expect(implState?.landingIntent).toBeNull();

      expect(parallelWorktrees.provisionCalls).toEqual([]);
    });

    /**
     * R11.1's charset clause, at the production path rather than on the migrated
     * data alone. A legacy context id may be any non-empty string, and this one
     * is not spliceable into a git branch name or a worktree path — so the lane
     * the migration minted for it is the only legal name available. Provisioning
     * that keyed off the context id instead would make the sanitization dead
     * code and refuse the migrated definition outright, which is the opposite of
     * "existing templates remain startable".
     */
    it("provisions a migrated pre-placement context whose id is outside the lane-id charset under its sanitized lane name", async () => {
      const legacyId = "build api";
      const definition = inflatePrePlacement(
        renameContext(
          createResolvedWorkflowDefinition(),
          "context-plan",
          legacyId,
        ),
      );
      // The transformer chose this, not the test.
      expect(
        definition.executionContexts.find((ctx) => ctx.id === legacyId)
          ?.placement.lane,
      ).toBe("build_api");

      const base = createWorkflowExecution({ workingDefinition: definition });
      const repository = createRepository({
        ...base,
        status: "running",
        contextStates: renameContextState(
          base.contextStates,
          "context-plan",
          legacyId,
        ),
      });
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

      const scheduled = await manager.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName: "session-1",
      });

      expect(scheduled.scheduled.kind).toBe("parallel");
      if (scheduled.scheduled.kind !== "parallel") return;
      expect(scheduled.scheduled.contextIds).toEqual([legacyId]);

      expect(parallelWorktrees.provisionCalls).toHaveLength(1);
      expect(parallelWorktrees.provisionCalls[0]?.contextId).toBe("build_api");

      const state = scheduled.execution.contextStates[legacyId];
      expect(state?.laneId).toBe("build_api");
      expect(state?.isolation).toBe("worktree");
      expect(state?.worktreePath).toBe(
        "/repo/.worktrees/feature-abc.build_api",
      );
      expect(state?.branchName).toBe("csm/feature-abc-build_api");
      expect(scheduled.execution.executionLanes["build_api"]?.kind).toBe(
        "worktree",
      );
    });

    /**
     * R11.1's execution clause: a pre-placement definition migrates to one
     * single-member lane per context, and that is what the run must cost — one
     * worktree per context, exactly as the definition behaved before placement
     * existed.
     *
     * The downstream is the case that matters. Its upstream landed on a worktree
     * lane, so the classifier offers that lane; admitting the downstream onto it
     * would silently merge two single-member lanes into one and hand the
     * downstream a worktree its placement never claimed. It forks onto its own
     * lane from the upstream's committed head instead, which is how it still
     * sees the upstream's work.
     */
    it("provisions one worktree per context across a migrated pre-placement chain: each downstream forks onto its own single-member lane", async () => {
      const definition = inflatePrePlacement(
        createResolvedWorkflowDefinition(),
      );
      // Migration names each lane after its context, so no two contexts share one.
      expect(
        definition.executionContexts.map((ctx) => ctx.placement.lane),
      ).toEqual(["context-plan", "context-implement", "context-verify"]);

      const base = createWorkflowExecution({ workingDefinition: definition });
      const repository = createRepository({ ...base, status: "running" });
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

      const first = await manager.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName: "session-1",
      });
      expect(first.scheduled.kind).toBe("parallel");
      if (first.scheduled.kind !== "parallel") return;
      expect(first.scheduled.contextIds).toEqual(["context-plan"]);
      const planState = first.execution.contextStates["context-plan"];
      expect(planState?.laneId).toBe("context-plan");
      expect(parallelWorktrees.provisionCalls).toHaveLength(1);

      // context-plan commits on its lane and completes.
      const afterPlan = first.execution;
      const planLane = afterPlan.executionLanes["context-plan"]!;
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
            landingIntent: {
              ...afterPlan.contextStates["context-plan"]!.landingIntent!,
              state: "landed",
              evidence: "commit",
              headSha: "plan-head",
              settledAt: "2026-01-01T00:00:00.000Z",
            },
          },
        },
        executionLanes: {
          ...afterPlan.executionLanes,
          "context-plan": {
            ...planLane,
            includedContextIds: ["context-plan"],
            lastCommittingContextId: "context-plan",
          },
        },
        activeContextIds: afterPlan.activeContextIds.filter(
          (id) => id !== "context-plan",
        ),
      });

      const second = await manager.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName: "session-1",
      });
      expect(second.scheduled.kind).toBe("parallel");
      if (second.scheduled.kind !== "parallel") return;
      expect(second.scheduled.contextIds).toEqual(["context-implement"]);

      const implState = second.execution.contextStates["context-implement"];
      expect(implState?.laneId).toBe("context-implement");
      expect(implState?.isolation).toBe("worktree");
      expect(implState?.worktreePath).toBe(
        "/repo/.worktrees/feature-abc.context-implement",
      );

      // A second worktree, forked from the upstream lane's branch so the
      // upstream's committed work is visible in it.
      expect(parallelWorktrees.provisionCalls).toHaveLength(2);
      expect(parallelWorktrees.provisionCalls[1]?.contextId).toBe(
        "context-implement",
      );
      expect(parallelWorktrees.provisionCalls[1]?.sessionBranch).toBe(
        planLane.branchName,
      );

      const forkedLane = second.execution.executionLanes["context-implement"];
      expect(forkedLane?.kind).toBe("worktree");
      expect(forkedLane?.includedContextIds).toEqual(["context-plan"]);
      expect(forkedLane?.lastCommittingContextId).toBe("context-plan");
    });

    it("reuses a single worktree lane across a linear context chain (sequential lane reuse) so only the root provisions a lane", async () => {
      // Topology: context-plan -> context-implement -> context-verify (default
      // fixture), all three authored onto ONE lane. The root should be minted
      // into a worktree lane up front; each downstream then reuses it without
      // provisioning a new worktree or going through a session merge.
      const baseExecution = createWorkflowExecution({
        workingDefinition: sharedLaneDefinition(),
      });
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
          return createSession({
            worktreePath: "/repo/.worktrees/feature-abc",
            branchName: "csm/feature-abc",
          });
        },
      });

      // Pass 1: only context-plan is eligible. It should be provisioned into
      // a fresh worktree lane named by the group's authored placement.
      const first = await manager.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName: "session-1",
      });
      expect(first.scheduled.kind).toBe("parallel");
      if (first.scheduled.kind !== "parallel") return;
      expect(first.scheduled.contextIds).toEqual(["context-plan"]);

      const planState = first.execution.contextStates["context-plan"];
      expect(planState?.laneId).toBe("delivery");
      expect(planState?.isolation).toBe("worktree");
      const mintedLane = first.execution.executionLanes["delivery"];
      expect(mintedLane).toBeDefined();
      expect(mintedLane?.kind).toBe("worktree");
      expect(mintedLane?.status).toBe("active");
      expect(mintedLane?.includedContextIds).toEqual([]);
      expect(mintedLane?.lastCommittingContextId).toBeNull();
      expect(mintedLane?.worktreePath).toBe(
        "/repo/.worktrees/feature-abc.delivery",
      );
      expect(mintedLane?.branchName).toBe("csm/feature-abc-delivery");
      expect(parallelWorktrees.provisionCalls).toHaveLength(1);

      // Simulate runLaneCommit: context-plan finishes, lane records its
      // committed contribution. No session merge happens — the lane retains
      // the work for the next consumer. The landing intent settles in the SAME
      // mutation as the merge status (decision D8), because the lane's
      // `includedContextIds` records that the commit phase was entered, not
      // that it produced a landing.
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
            landingIntent: {
              ...afterPlan.contextStates["context-plan"]!.landingIntent!,
              state: "landed",
              evidence: "commit",
              headSha: "plan-head",
              settledAt: "2026-01-01T00:00:00.000Z",
            },
          },
        },
        executionLanes: {
          ...afterPlan.executionLanes,
          delivery: {
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
      // worktree lane "delivery"; classifier returns targetLaneId =
      // "delivery" → scheduler reuses without minting. No new provision.
      const second = await manager.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName: "session-1",
      });
      expect(second.scheduled.kind).toBe("parallel");
      if (second.scheduled.kind !== "parallel") return;
      expect(second.scheduled.contextIds).toEqual(["context-implement"]);

      const implState = second.execution.contextStates["context-implement"];
      expect(implState?.laneId).toBe("delivery");
      expect(implState?.isolation).toBe("worktree");
      expect(implState?.worktreePath).toBe(
        "/repo/.worktrees/feature-abc.delivery",
      );
      expect(implState?.branchName).toBe("csm/feature-abc-delivery");
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
            landingIntent: {
              ...afterImpl.contextStates["context-implement"]!.landingIntent!,
              state: "landed",
              evidence: "commit",
              headSha: "implement-head",
              settledAt: "2026-01-01T00:00:00.000Z",
            },
          },
        },
        executionLanes: {
          ...afterImpl.executionLanes,
          delivery: {
            ...afterImpl.executionLanes["delivery"]!,
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
      expect(verifyState?.laneId).toBe("delivery");
      expect(verifyState?.isolation).toBe("worktree");
      expect(verifyState?.worktreePath).toBe(
        "/repo/.worktrees/feature-abc.delivery",
      );

      // No additional provisioning across the whole linear chain.
      expect(parallelWorktrees.provisionCalls).toHaveLength(1);
      expect(parallelWorktrees.provisionCalls[0]!.contextId).toBe("delivery");
      // No fresh worktree lanes were minted for downstream consumers.
      expect(Object.keys(third.execution.executionLanes).sort()).toEqual([
        "delivery",
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
        const baseExecution = createWorkflowExecution({
          workingDefinition: sharedLaneDefinition(),
        });
        const repository = createRepository(
          createWorkflowExecution({
            ...baseExecution,
            id: "exec-obs-lane-created",
            status: "running",
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
          laneId: "delivery",
          contextId: "context-plan",
          branchName: "csm/feature-abc-delivery",
          worktreePath: "/repo/.worktrees/feature-abc.delivery",
          kind: "worktree",
        });
        unregisterExecutionLogger("exec-obs-lane-created");
      });

      it("emits a lane.reused lifecycle event when a downstream context inherits an upstream worktree lane so operators can audit lane handoff", async () => {
        _resetRegistryForTesting();
        // Handoff happens between contexts SHARING a lane, so the definition
        // places both on the one the fixture below provisions.
        const baseExecution = createWorkflowExecution({
          workingDefinition: withContextsOnLane(
            createResolvedWorkflowDefinition(),
            "context-plan",
            ["context-plan", "context-implement"],
          ),
        });
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
                  backend: "claude",
                  refKind: "conversation",
                  lane: "implementer",
                  contextId: "context-plan",
                  workflowConversationId: "conv-prev",
                  sessionRef: { backend: "claude", ref: "conv-prev" },
                  metrics: {
                    contextTokens: 10_000,
                    contextWindowMax: 200_000,
                    rotateBeforeNextTurn: false,
                  },
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
          summary: null,
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

    it("refuses to record onto a non-running execution and skips the additional mutation", async () => {
      // A pause/halt/abort transition already parked the execution; a turn
      // that settles afterwards (its cancellation classified as a failure)
      // must not poison the suspended state with a pending halt reason or
      // flip contexts to halted — same id and epoch, so the loop fence alone
      // does not reject the write.
      for (const status of ["paused", "halted", "aborted"] as const) {
        const repository = createRepository(
          createWorkflowExecution({
            status,
            activeContextIds: [],
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
          reason: { type: "recovery_error", message: "late settle" },
          applyAdditionalMutation(next) {
            const cs = next.contextStates["context-plan"];
            if (cs) cs.status = "halted";
          },
        });

        expect(result.accepted, `status=${status}`).toBe(false);
        expect(repository.read()?.pendingHaltReason).toBeNull();
        expect(repository.read()?.secondaryHaltReasons).toEqual([]);
        expect(repository.read()?.contextStates["context-plan"]?.status).toBe(
          "pending",
        );
      }
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
          reason: { type: "aborted", cause: null, summary: null },
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

    it("does not drain a replacement active execution", async () => {
      const repository = createRepository(
        createWorkflowExecution({
          id: "execution-replacement",
          status: "running",
          pendingHaltReason: { type: "recovery_error", message: "replacement" },
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
          expectedExecutionId: "execution-failed",
        }),
      ).rejects.toThrow(/execution-failed/);
      expect(repository.read()).toMatchObject({
        id: "execution-replacement",
        status: "running",
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

    it("forwards applied parameter defaults when seeding an execution", async () => {
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

      const { execution } = await manager.start(
        startInput({ ticket: "CC-42" }),
      );
      const boundInputs = { ticket: "CC-42", severity: "low" };

      expect(repository.createCalls[0]?.inputs).toEqual(boundInputs);
      expect(execution.boundInputs).toEqual(boundInputs);
    });

    it("refuses a changed definition revision before seeding an execution", async () => {
      const definition = createWorkflowDefinitionRecord({ revision: 3 });
      const repository = createRepository();
      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return definition;
        },
        getSession: async () => makeStartSession(),
        readSessionWorktreeDirtyPaths: async () => [],
      });

      await expect(
        manager.start({
          ...startInput(),
          expectedDefinitionRevision: 2,
        }),
      ).rejects.toMatchObject({
        code: "definition_revision_mismatch",
        expectedRevision: 2,
        actualRevision: 3,
      });
      expect(repository.createCalls).toHaveLength(0);
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

    it("admits over a lease-free incumbent and archives nothing itself", async () => {
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

      const { execution } = await manager.start(startInput());

      // The manager's guard is ADVISORY: it refuses or it proceeds, and never
      // mutates. Normalizing the lease-free incumbent into History belongs to
      // the reservation, which is the only place that can do it atomically with
      // installing the winner.
      expect(repository.archiveCalls).toBe(0);
      expect(repository.createCalls).toHaveLength(1);
      expect(execution.id).toBe("execution-new");
      expect(execution.status).toBe("running");
    });

    /**
     * The manager's advisory guard and the serialized reservation read the SAME
     * `evaluateLeaseAdmission`, so this table and the durable CAS table in
     * `focused-workflow-setters.durability.test.ts` are two views of one rule —
     * which is exactly why they can never disagree about a winner.
     *
     * Both `halted` shapes appear on purpose: identical status, opposite tenure.
     * A status-only slot rule (the one D7 replaced) called every halted run
     * slot-owning and could not see resumability or abandonment at all.
     */
    const RESUMABLE_HALT = {
      type: "execution_loop_failed",
      contextId: null,
      cause: "unknown",
      message: "halted",
    } as const;

    it.each([
      { label: "completed", overrides: { status: "completed" as const } },
      { label: "aborted", overrides: { status: "aborted" as const } },
      {
        label: "non-resumably halted",
        overrides: {
          status: "halted" as const,
          haltReason: {
            type: "recovery_error" as const,
            message: "unrecoverable",
          },
        },
      },
      {
        label: "abandoned resumable halt",
        overrides: {
          status: "halted" as const,
          haltReason: RESUMABLE_HALT,
          abandonment: {
            abandonedAt: "2026-03-27T14:00:00.000Z",
            actor: { kind: "human" as const },
            reason: "superseded by a newer plan",
          },
        },
      },
    ])(
      "admits a launch over a lease-free $label incumbent and archives nothing itself",
      async ({ overrides }) => {
        const repository = createRepository(
          createWorkflowExecution({ id: "old-incumbent", ...overrides }),
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

        const { execution } = await manager.start(startInput());

        expect(execution.id).toBe("execution-new");
        expect(repository.createCalls).toHaveLength(1);
        // No archive, no release, no rewrite from the manager: relocating the
        // lease-free record is the reservation's job, because only there is it
        // atomic with installing the winner (R3.4).
        expect(repository.archiveCalls).toBe(0);
      },
    );

    it.each([
      {
        label: "pending",
        overrides: { status: "pending" as const },
        remedy: "inspect_or_pause",
      },
      {
        label: "running",
        overrides: { status: "running" as const },
        remedy: "inspect_or_pause",
      },
      {
        label: "paused",
        overrides: { status: "paused" as const },
        remedy: "inspect_or_pause",
      },
      {
        label: "resumably halted",
        overrides: {
          status: "halted" as const,
          haltReason: RESUMABLE_HALT,
        },
        remedy: "resume_or_abandon",
      },
    ])(
      "refuses a launch over a lease-held $label incumbent, leaving it byte-identical",
      async ({ overrides, remedy }) => {
        const repository = createRepository(
          createWorkflowExecution({ id: "incumbent-1", ...overrides }),
        );
        const before = structuredClone(repository.read());
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
          blocker: { executionId: "incumbent-1", remedy },
        });

        // A refusal never ends, hides, or rewrites live work.
        expect(repository.read()).toEqual(before);
        expect(repository.createCalls).toHaveLength(0);
        expect(repository.archiveCalls).toBe(0);
      },
    );

    it("refuses a lease-held launch with a blocker naming the incumbent and its remedy", async () => {
      const repository = createRepository(
        createWorkflowExecution({
          id: "incumbent-1",
          status: "running",
          ownerConversationId: "conv-origin",
        }),
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
        blocker: {
          executionId: "incumbent-1",
          status: "running",
          originConversationId: "conv-origin",
          remedy: "inspect_or_pause",
          deepLink: "/projects/repo/session-1/workflow?execution=incumbent-1",
        },
      });
    });

    /**
     * The symmetric half of the delivery gate (R13). The merge refuses while a
     * run holds the lease; a launch must refuse while the session is being
     * finalized, or the two admit each other in the window between the merge
     * route's advisory check and the publish under the project lock — leaving a
     * fresh run seeded into a session that is about to be marked finished.
     *
     * Only a SESSION-FINALIZING merge makes the session exclusively busy. A
     * graph lane merge is the workflow's own work, so refusing launches during
     * one would have the engine block itself.
     */
    it("refuses a launch while a session-finalizing merge is in flight", async () => {
      const repository = createRepository();
      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return createWorkflowDefinitionRecord();
        },
        getSession: async () => makeStartSession(),
        readSessionWorktreeDirtyPaths: async () => [],
        readSessionFinalizingMerge: () => ({
          jobId: "job-finalizing",
          branchName: "csm/session-1",
        }),
      });

      await expect(manager.start(startInput())).rejects.toMatchObject({
        guard: "session_finalizing",
      });
      expect(repository.createCalls).toHaveLength(0);
    });

    it("admits a launch when no finalizing merge is in flight for this session", async () => {
      const repository = createRepository();
      const asked: Array<[string, string]> = [];
      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return createWorkflowDefinitionRecord();
        },
        getSession: async () => makeStartSession(),
        readSessionWorktreeDirtyPaths: async () => [],
        createExecutionId: () => "execution-new",
        readSessionFinalizingMerge: (projectPath, sessionName) => {
          asked.push([projectPath, sessionName]);
          return null;
        },
      });

      const { execution } = await manager.start(startInput());

      expect(execution.id).toBe("execution-new");
      expect(repository.createCalls).toHaveLength(1);
      // Asked about THIS session, not globally: another session's merge is not
      // this session's business. Asked TWICE: once advisorily, once inside the
      // reserving transaction, because the answer can change in between.
      expect(asked).toEqual([
        ["/repo", "session-1"],
        ["/repo", "session-1"],
      ]);
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

    it("keeps the dirty refusal over a missing definition: the exemption probe cannot resolve the plan, so it fails closed", async () => {
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

      // The load happens only because a dirty worktree asks whether the plan
      // qualifies for the exemption; a plan that cannot be resolved keeps the
      // dirty refusal rather than reporting the 404 behind it (R8, D10).
      await expect(manager.start(startInput())).rejects.toMatchObject({
        guard: "uncommitted_changes",
      });
      expect(loadDefinitionCalled).toBe(true);
      expect(repository.createCalls).toHaveLength(0);
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

      const { execution } = await manager.start(startInput());
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

    /**
     * The dirty-worktree exemption (R8, decision D10). Eligibility is decided
     * by the RESOLVED run's mechanics, so these launch the same authored
     * content from both origins and assert the same verdict: origin plays no
     * part, and only an admitted dirty launch carries the lifetime pin.
     */
    describe("dirty-worktree exemption", () => {
      const DIRTY: DirtyPath[] = [
        { path: "src/edited.ts", statusCode: " M", tracked: true },
      ];

      function readOnlyContext(
        id: string,
      ): GraphWorkflowExecutionContextDefinition {
        return {
          id,
          title: id,
          acceptanceCriteria: `${id} reports what it read`,
          placement: { lane: SESSION_LANE_NAME, mode: "readOnly" },
          outputSchema: {
            type: "object",
            properties: { summary: { type: "string" } },
            required: ["summary"],
            additionalProperties: false,
          },
        };
      }

      function planDefinition(
        extraContexts: GraphWorkflowExecutionContextDefinition[] = [],
      ): WorkflowSemanticDefinition {
        const contexts = [
          readOnlyContext("read-a"),
          readOnlyContext("read-b"),
          ...extraContexts,
        ];
        return createWorkflowDefinition({
          executionContexts: contexts,
          tasks: contexts.map((context) => ({
            id: `task-${context.id}`,
            contextId: context.id,
            order: 1,
            title: "Inspect the worktree",
            instructions: "Read the relevant files and report.",
            source: "user" as const,
          })),
          edges: [],
        });
      }

      /** The same content one context away from being mechanically read-only. */
      function writeCapablePlanDefinition(): WorkflowSemanticDefinition {
        return planDefinition([
          {
            id: "write-c",
            title: "write-c",
            acceptanceCriteria: "write-c lands its change",
            placement: { lane: "build", mode: "full" },
          },
        ]);
      }

      function inlinePlan(definition: WorkflowSemanticDefinition) {
        return {
          name: "Live worktree analysis",
          description: "Reads the session worktree and reports",
          definition,
          layout: createWorkflowLayout(),
        };
      }

      interface ExemptionHarness {
        repository: ReturnType<typeof createRepository>;
        manager: ReturnType<typeof createGraphWorkflowManager>;
        /** How often the launch consulted global config. */
        globalConfigReads(): number;
        loadDefinitionCalls(): number;
      }

      function harness(options: {
        definition: WorkflowSemanticDefinition;
        dirtyPaths?: DirtyPath[];
        readGlobalConfig?: () => Promise<GlobalConfig>;
      }): ExemptionHarness {
        const repository = createRepository();
        let globalConfigReads = 0;
        let loadDefinitionCalls = 0;
        const manager = createGraphWorkflowManager({
          executionRepository: repository,
          async loadDefinition() {
            loadDefinitionCalls += 1;
            return createWorkflowDefinitionRecord({
              definition: options.definition,
            });
          },
          getSession: async () => makeStartSession(),
          readSessionWorktreeDirtyPaths: async () => options.dirtyPaths ?? [],
          readGlobalConfig: async () => {
            globalConfigReads += 1;
            if (options.readGlobalConfig) return options.readGlobalConfig();
            return {} as GlobalConfig;
          },
          preflightService: {
            async evaluate() {
              return { status: "ok" };
            },
          },
        });
        return {
          repository,
          manager,
          globalConfigReads: () => globalConfigReads,
          loadDefinitionCalls: () => loadDefinitionCalls,
        };
      }

      it("admits a dirty template start whose resolved run is wholly live-session read-only and pins it (R8.1)", async () => {
        const { manager, repository, loadDefinitionCalls } = harness({
          definition: planDefinition(),
          dirtyPaths: DIRTY,
        });

        const { execution } = await manager.start(startInput());

        expect(execution.status).toBe("running");
        expect(repository.createCalls).toHaveLength(1);
        expect(repository.createCalls[0]?.liveSessionReadOnlyPinned).toBe(true);
        expect(execution.liveSessionReadOnlyPinned).toBe(true);
        // The exemption probe's resolution is the launch's resolution — an
        // admitted plan is not loaded twice.
        expect(loadDefinitionCalls()).toBe(1);
      });

      it("admits the identical plan launched inline on the same dirty worktree and pins it (R8.2)", async () => {
        const { manager, repository } = harness({
          definition: planDefinition(),
          dirtyPaths: DIRTY,
        });

        const { execution } = await manager.run({
          projectPath: "/repo",
          sessionName: "session-1",
          plan: inlinePlan(planDefinition()),
        });

        expect(execution.origin.kind).toBe("one_off");
        expect(repository.createCalls[0]?.liveSessionReadOnlyPinned).toBe(true);
        expect(execution.liveSessionReadOnlyPinned).toBe(true);
      });

      it("refuses a dirty template start once one context is write-capable (R8.1)", async () => {
        const { manager, repository } = harness({
          definition: writeCapablePlanDefinition(),
          dirtyPaths: DIRTY,
        });

        await expect(manager.start(startInput())).rejects.toMatchObject({
          guard: "uncommitted_changes",
          dirtyPaths: DIRTY,
        });
        expect(repository.createCalls).toHaveLength(0);
      });

      it("refuses the same write-capable plan launched inline, so origin plays no part (R8.2)", async () => {
        const { manager, repository } = harness({
          definition: planDefinition(),
          dirtyPaths: DIRTY,
        });

        await expect(
          manager.run({
            projectPath: "/repo",
            sessionName: "session-1",
            plan: inlinePlan(writeCapablePlanDefinition()),
          }),
        ).rejects.toMatchObject({
          guard: "uncommitted_changes",
          dirtyPaths: DIRTY,
        });
        expect(repository.createCalls).toHaveLength(0);
      });

      it("refuses a dirty launch whose resolved script-validator selection is non-empty", async () => {
        const definition = planDefinition();
        const { manager, repository } = harness({
          definition: {
            ...definition,
            workflowConfig: {
              ...definition.workflowConfig,
              scriptValidator: { commands: ["test"] },
            },
          },
          dirtyPaths: DIRTY,
        });

        await expect(manager.start(startInput())).rejects.toMatchObject({
          guard: "uncommitted_changes",
        });
        expect(repository.createCalls).toHaveLength(0);
      });

      it("refuses a dirty launch whose cascade resolves collaboration enabled", async () => {
        const definition = planDefinition();
        const { manager, repository } = harness({
          definition: {
            ...definition,
            workflowConfig: {
              ...definition.workflowConfig,
              collaboration: { enabled: true },
            },
          },
          dirtyPaths: DIRTY,
        });

        await expect(manager.start(startInput())).rejects.toMatchObject({
          guard: "uncommitted_changes",
        });
        expect(repository.createCalls).toHaveLength(0);
      });

      it("fails the exemption closed when the probe itself throws", async () => {
        const { manager, repository } = harness({
          definition: planDefinition(),
          dirtyPaths: DIRTY,
          readGlobalConfig: async () => {
            throw new Error("config read failed");
          },
        });

        await expect(manager.start(startInput())).rejects.toMatchObject({
          guard: "uncommitted_changes",
        });
        expect(repository.createCalls).toHaveLength(0);
      });

      it("launches a clean worktree without probing the exemption and pins nothing", async () => {
        const { manager, repository, globalConfigReads } = harness({
          definition: planDefinition(),
        });

        const { execution } = await manager.start(startInput());

        expect(execution.status).toBe("running");
        expect(repository.createCalls[0]?.liveSessionReadOnlyPinned).toBe(
          false,
        );
        expect(execution.liveSessionReadOnlyPinned).toBe(false);
        // The prerequisite gate is the only consumer of global config on a
        // clean launch: an eligibility cascade never runs when nothing is
        // uncommitted.
        expect(globalConfigReads()).toBe(1);
      });

      it("pins nothing on a clean launch of a write-capable plan, which stays legal", async () => {
        const { manager, repository } = harness({
          definition: writeCapablePlanDefinition(),
        });

        const { execution } = await manager.start(startInput());

        expect(execution.status).toBe("running");
        expect(repository.createCalls[0]?.liveSessionReadOnlyPinned).toBe(
          false,
        );
      });

      it("consults global config for the eligibility cascade only when the worktree is dirty", async () => {
        const { manager, globalConfigReads } = harness({
          definition: planDefinition(),
          dirtyPaths: DIRTY,
        });

        await manager.start(startInput());

        // Once for the exemption cascade, once for the prerequisite gate.
        expect(globalConfigReads()).toBe(2);
      });
    });

    describe("prerequisite gate", () => {
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
                placement: { lane: "ctx-1", mode: "full" },
                implementer: {
                  id: "implementer",
                  profile: { tier: "builtin", id: "general-implementer" },
                  agent: {
                    backend: "claude",
                    model: "opus",
                    reasoningEffort: "medium",
                  },
                },
                mutability: {
                  allowAgentTaskAdd: false,
                  allowAgentContextAdd: false,
                },
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
                placement: { lane: "ctx-2", mode: "full" },
                implementer: {
                  id: "implementer",
                  profile: { tier: "builtin", id: "general-implementer" },
                  agent: {
                    backend: "claude",
                    model: "opus",
                    reasoningEffort: "medium",
                  },
                },
                contextValidator: {
                  enabled: true,
                  assignments: [
                    {
                      id: "general",
                      profile: { tier: "builtin", id: "general-reviewer" },
                      strategy: "task",
                      authority: "blocking",
                      agent: {
                        backend: "codex",
                        model: "gpt-5.4",
                        reasoningEffort: "medium",
                      },
                      continuity: { enabled: true },
                    },
                  ],
                },
                mutability: {
                  allowAgentTaskAdd: false,
                  allowAgentContextAdd: false,
                },
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
        const { execution } = await managerFor(definition, afterRepo).start({
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
        const { execution } = await managerFor(
          otherDefinition,
          afterRepo,
        ).start({
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

// -- halt/resume lifecycle attribution (audit telemetry) ------------------------

describe("halt/resume lifecycle attribution", () => {
  it("stamps actor on the halt event and echoes the resolved halt on resume", async () => {
    _resetRegistryForTesting();
    const executionId = "exec-halt-resume-audit";
    const repository = createRepository(
      createWorkflowExecution({ id: executionId, status: "running" }),
    );

    const lifecycleCalls: Array<{
      event: string;
      data: Record<string, unknown> | undefined;
    }> = [];
    const capturingLogger: ExecutionLogger = {
      executionId,
      logDir: "/tmp/test-halt-resume",
      writeManifest() {},
      lifecycle(event, data) {
        lifecycleCalls.push({ event, data });
      },
      iteration() {},
      task() {},
      validation() {},
      writePrompt() {},
      writeValidatorResponse() {},
      writeValidatorTranscript() {},
      decision() {},
    };
    registerExecutionLogger(capturingLogger);

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
    });

    await manager.send("/repo", "session-1", {
      type: "halt",
      reason: {
        type: "circuit_breaker",
        contextId: "context-plan",
        condition: "retry_exhaustion",
        summary: null,
      },
    });

    const halted = lifecycleCalls.find((c) => c.event === "execution.halted");
    expect(halted).toBeDefined();
    expect(halted?.data).toMatchObject({ actor: "system" });

    await manager.resume("/repo", "session-1");

    // Resume registers its own disk-backed logger; assert on the durable
    // artifact the audit extractor actually reads.
    const configDir = process.env["CC_CONFIG_DIR"]!;
    const lifecyclePath = nodePath.join(
      configDir,
      "workflow-logs",
      executionId,
      "lifecycle.jsonl",
    );
    const lines = readFileSync(lifecyclePath, "utf-8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const resumed = lines.find((line) => line.event === "execution.resumed");
    expect(resumed).toBeDefined();
    expect(resumed).toMatchObject({
      actor: "operator",
      resolvedHaltType: "circuit_breaker",
      resolvedHaltContextId: "context-plan",
      previousStatus: "halted",
    });
  });

  it("stamps the operator actor on pause", async () => {
    _resetRegistryForTesting();
    const executionId = "exec-pause-audit";
    const repository = createRepository(
      createWorkflowExecution({ id: executionId, status: "running" }),
    );
    const lifecycleCalls: Array<{
      event: string;
      data: Record<string, unknown> | undefined;
    }> = [];
    const capturingLogger: ExecutionLogger = {
      executionId,
      logDir: "/tmp/test-pause",
      writeManifest() {},
      lifecycle(event, data) {
        lifecycleCalls.push({ event, data });
      },
      iteration() {},
      task() {},
      validation() {},
      writePrompt() {},
      writeValidatorResponse() {},
      writeValidatorTranscript() {},
      decision() {},
    };
    registerExecutionLogger(capturingLogger);

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
    });

    await manager.send("/repo", "session-1", { type: "pause" });

    const paused = lifecycleCalls.find((c) => c.event === "execution.paused");
    expect(paused).toBeDefined();
    expect(paused?.data).toMatchObject({ actor: "operator" });
    unregisterExecutionLogger(executionId);
  });
});

describe("abandon — the explicit, audited end of a resumable halt's tenure", () => {
  const PROJECT_PATH = "/repo";
  const SESSION_NAME = "session-1";

  let fixture: PersistenceFixture;

  beforeEach(() => {
    fixture = createPersistenceFixture();
    fixture.seedProject(PROJECT_PATH);
    fixture.seedSession(PROJECT_PATH, SESSION_NAME, {
      worktreePath: "/repo/.worktrees/session-1",
    });
  });

  afterEach(() => {
    fixture.close();
  });

  /**
   * Raw-insert an incumbent in the active position. `lease_held` is seeded 1
   * unconditionally so the derived column can never be what a test is really
   * asserting — every verdict below has to come from the canonical predicate.
   */
  function seedIncumbent(
    overrides: Partial<GraphWorkflowExecution> & {
      id: string;
      status: GraphWorkflowExecution["status"];
    },
  ): GraphWorkflowExecution {
    const execution = createWorkflowExecution(overrides);
    fixture.db
      .prepare(
        `INSERT INTO graph_workflow_executions (
           project_path, session_name, execution_id, seed_definition_id,
           seed_definition_revision, started_at, status, completed_at,
           definition_json, runtime_json, updated_at, lease_held
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        PROJECT_PATH,
        SESSION_NAME,
        execution.id,
        execution.seedDefinitionId,
        execution.seedDefinitionRevision,
        execution.startedAt,
        execution.status,
        execution.completedAt,
        "{}",
        JSON.stringify(execution),
        "2026-01-01T00:00:00Z",
        1,
      );
    return execution;
  }

  const RESUMABLE_HALT: GraphWorkflowHaltReason = {
    type: "execution_loop_failed",
    contextId: "context-plan",
    message: "the loop threw",
    cause: "unknown",
  };

  function buildManager() {
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
      charterService,
      readConfig: async () => ({}) as GlobalConfig,
    });
    return createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return createWorkflowDefinitionRecord({ id: "project-def" });
      },
      now: () => "2026-08-13T09:00:00.000Z",
      createExecutionId: () => "execution-successor",
    });
  }

  it("commits the audit, the released boundary row and the History relocation together", async () => {
    const incumbent = seedIncumbent({
      id: "wf-halted",
      status: "halted",
      haltReason: RESUMABLE_HALT,
    });
    const manager = buildManager();

    const result = await manager.abandon({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      executionId: incumbent.id,
      reason: "Superseded by a new plan",
      actor: { kind: "conversation", conversationId: "conv-origin" },
    });

    expect(result.ok).toBe(true);
    // Reloaded from the store: the audit and the relocation both have to be
    // durable, and the act leaves no state in which one landed without the
    // other.
    expect(
      await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      ),
    ).toBeNull();
    const archived = await fixture.store.listArchivedGraphWorkflowExecutions(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(archived).toHaveLength(1);
    // The run's final engine state is a fact the abandonment does not rewrite.
    expect(archived[0]!.status).toBe("halted");
    expect(archived[0]!.haltReason).toEqual(RESUMABLE_HALT);
    expect(archived[0]!.abandonment).toEqual({
      abandonedAt: "2026-08-13T09:00:00.000Z",
      actor: { kind: "conversation", conversationId: "conv-origin" },
      reason: "Superseded by a new plan",
    });
    const released = (
      await fixture.store.getGraphWorkflowEventsTail(
        PROJECT_PATH,
        SESSION_NAME,
        "wf-halted",
        50,
      )
    ).filter(
      (entry) => entry.event.type === "graph-workflow-execution-released",
    );
    expect(released).toHaveLength(1);
    expect(released[0]!.event).toMatchObject({
      reason: "abandoned",
      actor: "conversation:conv-origin",
      status: "halted",
    });
  });

  it("releases the lease so the same launch is admitted afterwards", async () => {
    const incumbent = seedIncumbent({
      id: "wf-halted",
      status: "halted",
      haltReason: RESUMABLE_HALT,
    });
    const manager = buildManager();

    await expect(
      manager.start({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        definitionId: "project-def",
      }),
    ).rejects.toBeInstanceOf(WorkflowStartGuardError);

    const abandoned = await manager.abandon({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      executionId: incumbent.id,
      reason: "Superseded by a new plan",
      actor: { kind: "human" },
    });
    if (!abandoned.ok) throw new Error("abandon refused the lease holder");
    expect(
      holdsExecutionLease(
        abandoned.execution.status,
        abandoned.execution.haltReason,
        abandoned.execution.abandonment,
      ),
    ).toBe(false);

    const { execution } = await manager.start({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      definitionId: "project-def",
    });
    expect(execution.id).toBe("execution-successor");
  });

  it("refuses a stale execution id rather than abandoning whatever holds the lease", async () => {
    seedIncumbent({
      id: "wf-halted",
      status: "halted",
      haltReason: RESUMABLE_HALT,
    });
    const manager = buildManager();

    const result = await manager.abandon({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      executionId: "wf-somebody-else",
      reason: "Superseded",
      actor: { kind: "human" },
    });

    expect(result).toEqual({
      ok: false,
      reason: "execution_mismatch",
      activeExecutionId: "wf-halted",
    });
    const reloaded = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(reloaded?.abandonment).toBeNull();
  });

  it("refuses a non-resumable halt, which already belongs to History and holds nothing", async () => {
    const incumbent = seedIncumbent({
      id: "wf-recovery-error",
      status: "halted",
      haltReason: {
        type: "recovery_error",
        message: "unrecoverable",
      },
    });
    const manager = buildManager();

    const result = await manager.abandon({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      executionId: incumbent.id,
      reason: "Superseded",
      actor: { kind: "human" },
    });

    expect(result).toEqual({
      ok: false,
      reason: "not_lease_holding_halt",
      status: "halted",
      abandoned: false,
    });
  });

  it("refuses a run that has not halted at all", async () => {
    const incumbent = seedIncumbent({ id: "wf-running", status: "running" });
    const manager = buildManager();

    const result = await manager.abandon({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      executionId: incumbent.id,
      reason: "Superseded",
      actor: { kind: "human" },
    });

    expect(result).toEqual({
      ok: false,
      reason: "not_lease_holding_halt",
      status: "running",
      abandoned: false,
    });
  });

  it("refuses a repeated abandon rather than overwriting the first audit", async () => {
    const incumbent = seedIncumbent({
      id: "wf-halted",
      status: "halted",
      haltReason: RESUMABLE_HALT,
    });
    const manager = buildManager();

    await manager.abandon({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      executionId: incumbent.id,
      reason: "First reason",
      actor: { kind: "human" },
    });
    const result = await manager.abandon({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      executionId: incumbent.id,
      reason: "Second reason",
      actor: { kind: "human" },
    });

    // The first act already relocated the run, so the session owns nothing to
    // abandon — the refusal is about the lease, not about a second audit being
    // declined on the way past.
    expect(result).toEqual({ ok: false, reason: "no_active_execution" });
    const archived = await fixture.store.listArchivedGraphWorkflowExecutions(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(archived).toHaveLength(1);
    expect(archived[0]!.abandonment?.reason).toBe("First reason");
  });

  it("refuses when the session owns no execution at all", async () => {
    const manager = buildManager();

    const result = await manager.abandon({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      executionId: "wf-gone",
      reason: "Superseded",
      actor: { kind: "human" },
    });

    expect(result).toEqual({ ok: false, reason: "no_active_execution" });
  });
});
