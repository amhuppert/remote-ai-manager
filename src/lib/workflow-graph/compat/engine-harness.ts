import { createSessionGitLock } from "@/lib/shared/lock-retry";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { materializeGlobalConfig } from "@/lib/config/loader";
import { rawGlobalConfigSchema } from "@/lib/config/schemas";
import type { GlobalConfig } from "@/lib/config/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import type { StateStore } from "@/lib/state-store/store";
import type { MergeOutput } from "@/lib/workflows/merge/types";
import { createLaneService } from "@/lib/workflows/primitives/lane-service";
import { createWorkflowCharterService } from "@/lib/workflow-graph/charter/service";
import { createGraphWorkflowExecutionEventPublisher } from "@/lib/workflow-graph/execution-events";
import { createGraphWorkflowValidationService } from "@/lib/workflow-graph/execution-validation";
import {
  _resetActiveLoopsForTesting,
  createGraphWorkflowExecutionLoop,
  type GraphWorkflowExecutionLoopDeps,
  type GraphWorkflowExecutionLoopWorkflowManager,
} from "@/lib/workflow-graph/execution-loop";
import { createGraphWorkflowExecutionRepository } from "@/lib/workflow-graph/execution-repository";
import { createExecutionTargetResolver } from "@/lib/workflow-graph/execution-target-resolver";
import { createGraphLaneStore } from "@/lib/workflow-graph/graph-lane-store";
import type { GraphMergeRunner } from "@/lib/workflow-graph/graph-merge-runner";
import { createGraphWorkflowSignalHaltHandler } from "@/lib/workflow-graph/graph-workflow-signal-halt";
import {
  createGraphWorkflowIterationOrchestrator,
  type GraphWorkflowIterationInput,
  type GraphWorkflowIterationResult,
  type GraphWorkflowIterationToolServerInput,
} from "@/lib/workflow-graph/iteration-orchestrator";
import { createGraphLaneContinuity } from "@/lib/workflow-graph/lane-continuity";
import {
  createJoinRunner,
  type JoinRunner,
} from "@/lib/workflow-graph/join-runner";
import type {
  DisposeResult,
  ParallelWorktrees,
  ProvisionInput,
  ProvisionLaneInput,
  ProvisionResult,
} from "@/lib/workflow-graph/parallel-worktrees";
import { createPerSessionMergeMutex } from "@/lib/workflow-graph/per-session-merge-mutex";
import type { ValidatorRunResult } from "@/lib/workflow-graph/validator-runner";
import { getEligibleContextIds } from "@/lib/workflow-graph/validation";
import { createGraphWorkflowManager } from "@/lib/workflow-graph/workflow-manager";
import type { WorkflowSemanticDefinition } from "@/lib/workflow-graph/definition-schemas";
import type { GraphWorkflowSSEEvent } from "@/lib/workflow-graph/event-schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { stubValidationRoundService } from "@/lib/workflow-graph/test-fixtures";
import {
  diffContextStatuses,
  normalizeRecording,
  projectTypedEvent,
  type CompatibilityRecording,
  type ContextStatusTransition,
  type SchedulingDecision,
  type TypedEventRecord,
} from "./projections";

/**
 * The observational-equivalence harness (decision D14): run a pre-D4 fixture
 * definition through the REAL engine and record the three projections R14
 * names.
 *
 * Every engine layer D4 will touch is the production one — the execution loop,
 * the workflow manager and its scheduler, the iteration orchestrator (seeding,
 * conversation resolution, task binding and completion, context validation,
 * finalization), lane continuity, the validation service, the execution
 * repository over a real SQLite database, the typed-event publisher, and the
 * join runner.
 *
 * Only three things are faked, and each is deliberately outside the engine:
 * the implementer agent turn, the context-validator agent turn, and the
 * git/worktree side effects. They are the sources of nondeterminism a
 * compatibility check must not depend on; everything that decides routing,
 * scheduling, status, or events comes from production code, so a D4 change
 * that alters one shows up in the recording.
 *
 * Test-support only; not imported by production code.
 */

const PROJECT_PATH = "/compat-repo";
const PROJECT_NAME = "compat-repo";
const SESSION_NAME = "session-1";
const DEFINITION_ID = "compat-definition";
const EXECUTION_ID = "compat-execution";

const POST_D4_OBSERVABILITY_EVENT_TYPES = new Set<
  GraphWorkflowSSEEvent["type"]
>([
  "graph-workflow-lane-created",
  "graph-workflow-lane-concurrent-admission",
  "graph-workflow-lane-landed",
  "graph-workflow-lane-drift-halted",
]);

/** What the fixture implementer does on one agent turn. */
export type CompatibilityAgentTurn = "complete-next-task" | "no-task-progress";

/** What the fixture context validator returns for one validation attempt. */
export type CompatibilityValidatorTurn =
  | { verdict: "pass" }
  | { verdict: "fail"; reopenTaskIds: readonly string[] };

export interface CompatibilityScenario {
  name: string;
  definition: WorkflowSemanticDefinition;
  /**
   * Whether solo contexts may run on the session worktree. `false` (the engine
   * default) routes every context onto its own worktree lane, so the recording
   * covers lane provisioning, context joins, and the final publish.
   */
  sessionLaneEnabled: boolean;
  /**
   * One implementer turn. `turn` counts this context's agent turns across the
   * whole run — the orchestrator sends up to three per iteration (a seed plus
   * two follow-ups), so a script keyed on the iteration could not distinguish
   * them.
   */
  agent(input: { contextId: string; turn: number }): CompatibilityAgentTurn;
  /**
   * One context-validator verdict; `attempt` counts this context's validation
   * turns. Absent, every context validates on its first attempt.
   */
  validator?(input: {
    contextId: string;
    attempt: number;
  }): CompatibilityValidatorTurn;
  /**
   * The structured output a context banks once its last task completes, or null
   * for a context that declares no contract.
   *
   * Stands in for the D2 capture gate, which is the one production path this
   * harness cannot drive without a real agent — the payload it produces is
   * already proven elsewhere. What matters here is that the ROUTING then runs on
   * a real capture through the real scheduler, which is what a guarded scenario
   * needs and a pre-D4 one never asks for.
   */
  capture?(input: { contextId: string }): Record<string, unknown> | null;
  /**
   * What the scripted implementer DOES on one turn, beyond completing its next
   * task — run before the task completion so an edit lands while the context is
   * still running.
   *
   * The seam a lane verb driven over HTTP needs. The engine only ever hands an
   * implementer a turn, so runtime graph expansion — which a real agent reaches
   * through `cctl workflow graph expand`, not through a tool-server method —
   * has nowhere else to run from. The hook receives the run's own repository
   * and event publisher so a lane route wired against them commits into the
   * same execution the loop is scheduling.
   *
   * It also carries the rendered prompt, which is the only place an assertion
   * can observe what the engine actually handed the agent (the upstream-inputs
   * section in particular).
   */
  onAgentTurn?(input: CompatibilityAgentTurnContext): Promise<void>;
}

/** What {@link CompatibilityScenario.onAgentTurn} is handed for one turn. */
export interface CompatibilityAgentTurnContext {
  contextId: string;
  /** This context's agent turns across the whole run, 1-based. */
  turn: number;
  executionId: string;
  conversationId: string;
  projectPath: string;
  sessionName: string;
  /** The prompt the engine rendered for this turn. */
  prompt: string;
  /** The production repository this run commits through. */
  manager: ReturnType<typeof createGraphWorkflowManager>;
  /** The production typed-event publisher this run broadcasts through. */
  eventPublisher: ReturnType<typeof createGraphWorkflowExecutionEventPublisher>;
}

/**
 * "No config anywhere", materialized through the production loader so the
 * cascade resolves from SEEDED_WORKFLOW_DEFAULTS — the same defaults a fresh
 * install runs under, never a hand-written stand-in that could drift from them.
 */
function createHarnessConfig(): GlobalConfig {
  return {
    ...materializeGlobalConfig(rawGlobalConfigSchema.parse({})),
    baseDir: PROJECT_PATH,
  };
}

function createDeterministicClock(): () => string {
  let tick = 0;
  return () => {
    tick += 1;
    return new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + tick * 1000).toISOString();
  };
}

function createCounter(prefix: string): () => string {
  let count = 0;
  return () => {
    count += 1;
    return `${prefix}-${count}`;
  };
}

function createOccurrenceCounter(): (key: string) => number {
  const counts = new Map<string, number>();
  return (key) => {
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    return next;
  };
}

function createSuccessMergeOutput(): MergeOutput {
  return {
    status: "completed",
    mergeHash: "compat-merge-hash",
    commitHash: "compat-commit-hash",
    error: null,
    conflictFiles: [],
    conflictAnalysis: null,
    preparedSha: null,
    expectedTargetSha: null,
    parkedRef: null,
    refreshWarning: null,
    candidateValidation: null,
    haltReason: null,
    phase: null,
  };
}

function createWorktreeStub(): ParallelWorktrees {
  const provision = async (
    input: ProvisionInput,
  ): Promise<ProvisionResult> => ({
    worktreePath: `${input.projectPath}/.worktrees/${input.sessionDir}.${input.contextId}`,
    branchName: `csm/${input.sessionDir}-${input.contextId}`,
    ignoredBaseline: [],
  });
  const provisionLane = (input: ProvisionLaneInput): Promise<ProvisionResult> =>
    provision({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      sessionDir: input.sessionDir,
      sessionBranch: input.sessionBranch,
      contextId: input.laneId,
    });
  const dispose = async (): Promise<DisposeResult> => ({ status: "removed" });

  return {
    provision,
    async provisionBatch(inputs) {
      const results: ProvisionResult[] = [];
      for (const input of inputs) results.push(await provision(input));
      return results;
    },
    dispose,
    provisionLane,
    async provisionLaneBatch(inputs) {
      const results: ProvisionResult[] = [];
      for (const input of inputs) results.push(await provisionLane(input));
      return results;
    },
    disposeLane: dispose,
    cleanupLane: dispose,
  };
}

/**
 * The next task the fixture implementer would pick up: the lowest-ordered
 * incomplete task in its context, exactly what the iteration prompt lists
 * first.
 */
function findNextIncompleteTaskId(
  execution: GraphWorkflowExecution,
  contextId: string,
): string | null {
  const next = Object.values(execution.taskStates)
    .filter(
      (taskState) =>
        taskState.contextId === contextId && taskState.status !== "completed",
    )
    .sort((left, right) => left.order - right.order)[0];
  return next?.taskId ?? null;
}

export interface EngineScenarioRun {
  /** The execution the loop returned. */
  settled: GraphWorkflowExecution;
  /** The three normalized R14 projections. */
  recording: CompatibilityRecording;
  /** Every typed event the run published, in order. */
  events: TypedEventRecord[];
  /** The production manager, still bound to the open persistence fixture. */
  manager: ReturnType<typeof createGraphWorkflowManager>;
  /**
   * The production typed-event publisher this run broadcasts through. A caller
   * that mutates the settled execution (an operator repair, say) wires it here
   * so its events land in {@link EngineScenarioRun.events} rather than in a
   * stub nobody reads.
   */
  eventPublisher: ReturnType<typeof createGraphWorkflowExecutionEventPublisher>;
  projectPath: string;
  sessionName: string;
  /**
   * Resume a halted (or paused) execution the way the RESUME route does:
   * normalize after restart, resume through the manager (which clears the halt
   * and bumps the loop epoch), then run a FRESH execution loop over the same
   * production deps.
   *
   * The seam a resumable-halt terminal needs. A halt is only half of that
   * contract — what makes it resumable is that a repaired execution runs on
   * from durable state, and there is no other way to observe that without a
   * second loop over the same database. Events and scheduling keep accumulating
   * into the same recording arrays, so an assertion can read the resumed run's
   * decisions off {@link EngineScenarioRun.events}.
   */
  resume(): Promise<GraphWorkflowExecution>;
  /**
   * A brand-new state store over the SAME SQLite database — what a restarted
   * server comes up with, and the only reader that can tell a durable record
   * from a remembered one.
   *
   * {@link EngineScenarioRun.manager} answers from the repository that wrote the
   * run, and that repository keeps a parsed-row cache; a reload through it would
   * happily return state the writing process still holds. This reader shares
   * nothing with it but the database file, so anything it reports — the
   * execution blob AND the appended `graph_workflow_events` log — genuinely
   * survived persistence.
   */
  restartedStore(): StateStore;
}

/**
 * Run a scenario through the real engine and hand the result to `inspect` BEFORE
 * the persistence fixture closes, so a caller can reload from the same SQLite
 * database (a restart) or drive the manager again.
 */
export async function runEngineScenario<T>(
  scenario: CompatibilityScenario,
  inspect: (run: EngineScenarioRun) => Promise<T>,
): Promise<T> {
  _resetActiveLoopsForTesting();

  const fixture = createPersistenceFixture();
  try {
    fixture.seedProject(PROJECT_PATH);
    fixture.seedSession(PROJECT_PATH, SESSION_NAME);

    const scheduling: SchedulingDecision[] = [];
    const statusTransitions: ContextStatusTransition[] = [];
    const events: TypedEventRecord[] = [];

    const now = createDeterministicClock();
    const config = createHarnessConfig();

    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast: (event) => {
        const projected = projectTypedEvent(event);
        // This corpus compares its pre-D4 event vocabulary. Lane decision
        // records have independent durable event contracts and are excluded
        // from this historical baseline.
        if (POST_D4_OBSERVABILITY_EVENT_TYPES.has(event.type)) return;
        events.push(projected);
      },
      now,
      dispatchPush: () => {},
    });

    let lastCommitted: GraphWorkflowExecution | null = null;
    let lastEligible: string | null = null;

    const repository = createGraphWorkflowExecutionRepository({
      getSession: fixture.store.getSession,
      getActiveGraphWorkflowExecution:
        fixture.store.getActiveGraphWorkflowExecution,
      // Every persisted write passes through here, so this is the one place an
      // observer of the execution can see: status moves are diffed against the
      // previous COMMITTED snapshot, and the eligibility set is recomputed with
      // the production predicate on each commit — inside the same critical
      // section the scheduler classifies in, so no concurrent write can race
      // the observation.
      async mutateActiveGraphWorkflowExecution(
        projectPath,
        sessionName,
        label,
        mutate,
      ) {
        const result = await fixture.store.mutateActiveGraphWorkflowExecution(
          projectPath,
          sessionName,
          label,
          (current) => {
            const mutated = mutate(current);
            statusTransitions.push(
              ...diffContextStatuses(lastCommitted, mutated.execution),
            );
            lastCommitted = mutated.execution;
            const eligible = getEligibleContextIds(
              mutated.execution.workingDefinition,
              mutated.execution,
            );
            const key = eligible.join(",");
            if (key !== lastEligible) {
              lastEligible = key;
              scheduling.push({ decision: "eligible", contextIds: eligible });
            }
            return mutated;
          },
        );
        return result;
      },
      archiveActiveGraphWorkflowExecution:
        fixture.store.archiveActiveGraphWorkflowExecution,
      markGraphWorkflowContextEventsPreReset:
        fixture.store.markGraphWorkflowContextEventsPreReset,
      eventPublisher: publisher,
      charterService: createWorkflowCharterService({
        writeFile: async () => {},
        ensureDir: async () => {},
        publishCharterRegistered: publisher.publishCharterRegistered,
      }),
      readConfig: async () => config,
    });

    const worktrees = createWorktreeStub();
    const getSession = async (
      projectPath: string,
      sessionName: string,
    ): Promise<SessionState | null> =>
      fixture.store.getSession(projectPath, sessionName);

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      loadDefinition: async () => null,
      parallelWorktrees: worktrees,
      getSession,
      eventPublisher: publisher,
      now,
      createExecutionId: () => EXECUTION_ID,
      createBatchId: createCounter("batch"),
      readGlobalConfig: async () => config,
      stopExecutionLaneDevServers: async () => {},
    });

    await repository.create(PROJECT_PATH, SESSION_NAME, {
      definition: scenario.definition,
      definitionId: DEFINITION_ID,
      definitionRevision: 1,
      executionId: EXECUTION_ID,
      startedAt: now(),
      inputs: {},
      launchedTier: "project",
    });

    const running = await repository.mutateActive(
      PROJECT_PATH,
      SESSION_NAME,
      (execution) => ({ ...execution, status: "running" }),
    );

    // ---------------------------------------------------------------------
    // The scripted agents. These are the only fakes standing between the
    // fixture and the production iteration path: the implementer reaches the
    // engine exclusively through the lane tool server's `completeTask` (the
    // same seam the real `cctl workflow task complete` verb drives), and the
    // validator returns a verdict through the production validation service.
    // ---------------------------------------------------------------------
    const nextConversationId = createCounter("conversation");
    const knownConversationIds = new Set<string>();
    const laneToolServers = new Map<
      string,
      Pick<GraphWorkflowIterationToolServerInput, "contextId" | "completeTask">
    >();
    const nextAgentTurn = createOccurrenceCounter();
    const nextValidationAttempt = createOccurrenceCounter();

    const laneService = createLaneService({
      store: createGraphLaneStore({
        listActiveExecutions: () =>
          fixture.store.listActiveGraphWorkflowExecutions(),
        mutateActiveExecution: (projectPath, sessionName, mutate) =>
          manager.mutateActive(projectPath, sessionName, mutate),
      }),
      now,
    });

    const createConversation = async (): Promise<{ id: string }> => {
      const id = nextConversationId();
      knownConversationIds.add(id);
      return { id };
    };

    const continuityService = createGraphLaneContinuity({
      laneService,
      executionRepository: manager,
      createConversation,
      async getConversation(_projectPath, _sessionName, conversationId) {
        return knownConversationIds.has(conversationId)
          ? { id: conversationId }
          : null;
      },
      now,
    });

    const validationService = createGraphWorkflowValidationService({
      async runContextValidator(input): Promise<ValidatorRunResult> {
        const attempt = nextValidationAttempt(input.context.id);
        const scripted = scenario.validator?.({
          contextId: input.context.id,
          attempt,
        }) ?? { verdict: "pass" };
        const metadata = {
          sessionRef: null,
          reviewArtifact: null,
          limitEvaluation: "disabled",
          rotateBeforeNextTurn: false,
        } as const;

        if (scripted.verdict === "pass") {
          return {
            result: {
              kind: "pass",
              summary: `Context "${input.context.id}" satisfied its acceptance criteria`,
              issues: [],
              advisories: [],
              reopenTaskIds: [],
            },
            metadata,
            roundToken: input.roundToken ?? null,
          };
        }

        return {
          result: {
            kind: "fail",
            summary: `Context "${input.context.id}" did not satisfy its acceptance criteria`,
            issues: scripted.reopenTaskIds.map((taskId) => ({
              taskId,
              title: "Acceptance criteria not evidenced",
              description: "Record the verification evidence for this task.",
            })),
            advisories: [],
            reopenTaskIds: [...scripted.reopenTaskIds],
          },
          metadata,
          roundToken: input.roundToken ?? null,
        };
      },
    });

    const iterationOrchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: manager,
      findLatestContextValidationEvent: (executionId, contextId) =>
        fixture.store.findLatestGraphWorkflowContextEvent(
          executionId,
          contextId,
          "graph-workflow-validation-result",
        ),
      createConversation,
      continuityService,
      validationService,
      validationRoundService: stubValidationRoundService(),
      eventPublisher: publisher,
      signalHalt: createGraphWorkflowSignalHaltHandler(manager),
      // Lane worktrees are stubs here, so there is nothing to copy into them.
      materializeWorkflowDocuments: async () => {},
      createToolServer(input) {
        laneToolServers.set(input.conversationId, {
          contextId: input.contextId,
          completeTask: input.completeTask,
        });
        return {
          server: { servers: [] },
          close: () => {
            laneToolServers.delete(input.conversationId);
          },
        };
      },
      async runAgentIteration(input) {
        const toolServer = laneToolServers.get(input.conversationId);
        if (!toolServer) {
          throw new Error(
            `Fixture agent ran without a lane tool server for conversation "${input.conversationId}"`,
          );
        }
        if (toolServer.contextId !== input.contextId) {
          // A lane's conversation and its tool server must describe the same
          // context; otherwise the fixture agent would complete a sibling
          // context's task and the recording would pin a fiction.
          throw new Error(
            `Lane tool server for conversation "${input.conversationId}" belongs to context "${toolServer.contextId}", not "${input.contextId}"`,
          );
        }

        const turn = nextAgentTurn(input.contextId);
        await scenario.onAgentTurn?.({
          contextId: input.contextId,
          turn,
          executionId: input.executionId,
          conversationId: input.conversationId,
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          prompt: input.prompt,
          manager,
          eventPublisher: publisher,
        });
        if (
          scenario.agent({ contextId: input.contextId, turn }) ===
          "complete-next-task"
        ) {
          const execution = await manager.getActive(
            input.projectPath,
            input.sessionName,
          );
          const taskId = execution
            ? findNextIncompleteTaskId(execution, input.contextId)
            : null;
          if (taskId) {
            await toolServer.completeTask(taskId, `Completed ${taskId}`);
            await bankScenarioCapture(input.contextId);
          }
        }

        return {
          conversationId: input.conversationId,
          contextTokens: null,
          contextWindowMax: null,
          compacted: false,
          sessionRef: null,
        };
      },
      // Every fixture context leaves `askUserQuestions` disabled, so no lane
      // conversation can end on a pending question batch.
      readLaneConversation: async () => null,
      createTaskId: createCounter("task"),
      now,
    });

    /**
     * Bank the scenario's declared output for a context whose tasks are now all
     * complete — the guard the routing evaluates has to read a real capture off
     * the real execution. Written once: a re-run of the same context must not
     * silently re-decide its routes under a new capture iteration.
     */
    async function bankScenarioCapture(contextId: string): Promise<void> {
      const value = scenario.capture?.({ contextId });
      if (!value) return;
      await manager.mutateActive(PROJECT_PATH, SESSION_NAME, (current) => {
        if (current.contextOutputs[contextId]) return current;
        const remaining = Object.values(current.taskStates).filter(
          (task) => task.contextId === contextId && task.status !== "completed",
        );
        if (remaining.length > 0) return current;
        return {
          ...current,
          contextOutputs: {
            ...current.contextOutputs,
            [contextId]: {
              value,
              capturedAt: now(),
              iteration: 1,
              parse: { source: "native" as const },
            },
          },
        };
      });
    }

    const nextDispatch = createOccurrenceCounter();
    const recordingIterationOrchestrator = {
      async runIteration(
        input: GraphWorkflowIterationInput,
      ): Promise<GraphWorkflowIterationResult> {
        scheduling.push({
          decision: "dispatched",
          contextId: input.contextId,
          iteration: nextDispatch(input.contextId),
        });
        return iterationOrchestrator.runIteration(input);
      },
    };

    const mergeRunner: GraphMergeRunner = {
      async run() {
        return createSuccessMergeOutput();
      },
    };
    const mergeMutex = createPerSessionMergeMutex();
    const sessionGitLock = createSessionGitLock({
      acquireSessionLock: () => () => {},
    });
    const joinRunner = createJoinRunner({
      mergeRunner,
      sessionGitLock,
      mergeMutex,
      createJobId: createCounter("job"),
      now,
      abortInProgressMerge: async () => false,
    });

    const recordingJoinRunner: JoinRunner = {
      async run(input) {
        const active = await repository.getActive(PROJECT_PATH, SESSION_NAME);
        const join = active?.joins[input.joinId];
        if (join) {
          scheduling.push({
            decision: "join",
            joinKind: join.kind,
            contextId: join.contextId,
            sourceLaneIds: [...join.sourceLaneIds].sort(),
            targetLaneId: join.targetLaneId,
          });
        }
        return joinRunner.run(input);
      },
    };

    const recordingManager: GraphWorkflowExecutionLoopWorkflowManager = {
      ...manager,
      async scheduleEligibleContexts(input) {
        const result = await manager.scheduleEligibleContexts(input);
        scheduling.push({
          decision: "scheduled",
          outcome: result.scheduled.kind,
          contextIds:
            result.scheduled.kind === "solo"
              ? [result.scheduled.contextId]
              : result.scheduled.kind === "parallel"
                ? result.scheduled.contextIds
                : [],
        });
        return result;
      },
    };

    const deps: GraphWorkflowExecutionLoopDeps = {
      workflowManager: recordingManager,
      iterationOrchestrator: recordingIterationOrchestrator,
      parallelWorktrees: worktrees,
      mergeMutex,
      sessionGitLock,
      mergeRunner,
      joinRunner: recordingJoinRunner,
      soloContextCommitter: { commit: async () => ({ status: "skipped" }) },
      laneCommitter: {
        commit: async () => ({ status: "skipped" }),
        resolveHead: async () => null,
      },
      // Compatibility scenarios use synthetic worktree paths; production's
      // full-access index preparation is covered by execution-loop tests.
      resyncSharedIndex: async () => {},
      executionTargetResolver: createExecutionTargetResolver(),
      getSession,
      eventPublisher: publisher,
      createJobId: createCounter("loop-job"),
      getMaxConcurrentQueries: async () => 4,
      getSessionWorktreeDirtyPaths: async () => [],
    };

    const runExecutionLoop = (
      execution: GraphWorkflowExecution,
    ): Promise<GraphWorkflowExecution> =>
      createGraphWorkflowExecutionLoop(deps).run({
        projectPath: PROJECT_PATH,
        projectName: PROJECT_NAME,
        sessionName: SESSION_NAME,
        execution,
        sessionLaneEnabled: scenario.sessionLaneEnabled,
      });

    const settled = await runExecutionLoop(running);

    return await inspect({
      settled,
      async resume() {
        await manager.normalizeAfterRestart(PROJECT_PATH, SESSION_NAME);
        return runExecutionLoop(
          await manager.resume(PROJECT_PATH, SESSION_NAME),
        );
      },
      recording: normalizeRecording({
        scenario: scenario.name,
        terminalStatus: settled.status,
        haltReason: settled.haltReason?.type ?? null,
        scheduling,
        statusTransitions,
        events,
      }),
      events,
      manager,
      eventPublisher: publisher,
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      restartedStore: () => fixture.recreateStore(),
    });
  } finally {
    _resetActiveLoopsForTesting();
    fixture.close();
  }
}

/**
 * Record the three R14 projections of a scenario. The compatibility check's
 * entry point; every other consumer wants {@link runEngineScenario}, which keeps
 * the fixture open long enough to assert against the settled execution.
 */
export async function recordCompatibilityScenario(
  scenario: CompatibilityScenario,
): Promise<CompatibilityRecording> {
  return runEngineScenario(scenario, async (run) => run.recording);
}
