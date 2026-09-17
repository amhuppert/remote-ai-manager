import { createExecutionInfrastructureFixture } from "../testing/execution-loop-fixture";
import { readRepoConfig } from "@/lib/projects/repo-config";
import { createGraphWorkflowExecutionToolContext } from "../execution-tool-context";
import { createGraphWorkflowRuntimeEditService } from "../runtime-edits";
import { createGraphWorkflowSharedDocumentRegistryService } from "../shared-documents";
import { resolveBoundConversationId } from "../lane-binding";
import type { GraphExecutionContract } from "../execution-contract-port";
import { unchanged } from "../execution-mutation";
import { changed } from "@/lib/workflow-graph/execution-mutation";
import type {
  GraphWorkflowAdvisoryResponseInput,
  GraphWorkflowAdvisoryResponseOutcome,
} from "../advisory-response-runner";
import type { DirtyPath } from "../errors";
import { createTestGraphExecutionContract } from "@/lib/workflow-graph/testing/execution-contract";
import { createGraphWorkflowEngine } from "../engine-composition";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createSessionGitLock } from "@/lib/shared/lock-retry";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { materializeGlobalConfig } from "@/lib/config/loader";
import { rawGlobalConfigSchema } from "@/lib/config/schemas";
import type { GlobalConfig } from "@/lib/config/schemas";
import type { ValidatorAuthority } from "@/lib/workflow-graph/config-schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import type { StateStore } from "@/lib/state-store/store";
import type { MergeOutput } from "@/lib/workflows/merge/types";

import { createWorkflowCharterService } from "@/lib/workflow-graph/charter/service";
import { createGraphWorkflowExecutionEventPublisher } from "@/lib/workflow-graph/execution-events";

import { _resetActiveLoopsForTesting } from "@/lib/workflow-graph/execution-loop";

import { createExecutionTargetResolver } from "@/lib/workflow-graph/execution-target-resolver";

import type { GraphMergeRunner } from "@/lib/workflow-graph/graph-merge-runner";

import {
  type GraphWorkflowIterationInput,
  type GraphWorkflowIterationResult,
} from "@/lib/workflow-graph/context-outcome";

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
import { getEligibleContextIds } from "@/lib/workflow-graph/lane-readiness";
import { createGraphWorkflowManager } from "@/lib/workflow-graph/workflow-manager";
import type { WorkflowSemanticDefinition } from "@/lib/workflow-graph/definition-schemas";
import type { GraphWorkflowSSEEvent } from "@/lib/workflow-graph/event-schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import {
  makeLaunchDocument,
  stubValidationRoundService,
} from "@/lib/workflow-graph/test-fixtures";
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
  "graph-workflow-boundary",
  "graph-workflow-result-recorded",
]);

/** What the fixture implementer does on one agent turn. */
export type CompatibilityAgentTurn = "complete-next-task" | "no-task-progress";

/**
 * What the fixture context validator returns for one validation attempt.
 *
 * `advisories` is available on either verdict because an advisory seat has no
 * `issues` field at all — its only channel is the advisory list, so a cohort
 * scenario that could not express one could not distinguish a specialist that
 * observed something from a specialist that had nothing to say.
 */
export type CompatibilityValidatorTurn =
  | { verdict: "pass"; advisories?: readonly CompatibilityAdvisory[] }
  | {
      verdict: "fail";
      reopenTaskIds: readonly string[];
      advisories?: readonly CompatibilityAdvisory[];
    };

/** An advisory as a scenario declares it, before the engine stamps identity. */
export interface CompatibilityAdvisory {
  kind: "implementation" | "plan" | "out_of_scope";
  title: string;
  description: string;
}

/** Which cohort seat a scripted validator turn is answering for. */
export interface CompatibilityValidatorSeat {
  contextId: string;
  /** This context's validation turns for THIS seat, 1-based. */
  attempt: number;
  /** The cohort assignment id — the seat's stable use-site identity. */
  assignmentId: string;
  /** Whether this seat's findings can reopen tasks. */
  authority: ValidatorAuthority;
  /** The production execution target the validator is reviewing. */
  worktreePath?: string;
  /**
   * The live execution as this seat sees it, mid-round.
   *
   * A seat's whole question is "what is in front of me right now", and only a
   * snapshot taken DURING the round can answer it. Reading state after the run
   * settles cannot distinguish a candidate that existed when the panel reviewed
   * it from one that appeared afterwards.
   */
  execution: GraphWorkflowExecution;
}

export interface CompatibilityScenario {
  advisoryResponse?(
    input: GraphWorkflowAdvisoryResponseInput,
  ): Promise<GraphWorkflowAdvisoryResponseOutcome>;
  name: string;
  definition: WorkflowSemanticDefinition;
  /**
   * Whether solo contexts may run on the session worktree. `false` (the engine
   * default) routes every context onto its own worktree lane, so the recording
   * covers lane provisioning, context joins, and the final publish.
   */
  sessionLaneEnabled: boolean;
  /**
   * Optional real filesystem root for provisioned lane targets. Most
   * compatibility scenarios need only lane identity; artifact-boundary proofs
   * opt in so their implementer, validators, and capture gate share real bytes.
   */
  worktreeRoot?: string;
  /**
   * One implementer turn. `turn` counts this context's agent turns across the
   * whole run — the orchestrator sends up to three per iteration (a seed plus
   * two follow-ups), so a script keyed on the iteration could not distinguish
   * them.
   */
  agent(input: { contextId: string; turn: number }): CompatibilityAgentTurn;
  /**
   * One context-validator verdict, for one seat of the context's cohort;
   * `attempt` counts that seat's validation turns. Absent, every seat passes on
   * its first attempt.
   *
   * Keyed by seat rather than by context because a cohort dispatches every
   * assignment against the same candidate: a script that could only answer
   * "the validator" would have to give four specialists one verdict, and the
   * blocking/advisory partition it is asked to prove would be unobservable.
   */
  validator?(input: CompatibilityValidatorSeat): CompatibilityValidatorTurn;
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
   * Drives the PRODUCTION D2 capture gate rather than the in-turn stand-in
   * above, by wiring a real `outputCaptureService` into the orchestrator's deps.
   *
   * Present, the engine decides WHEN a context's output is captured, so the
   * ordering between a cohort round and its context's structured output becomes
   * observable — `capture` is not banked during the agent turn, and this hook
   * runs from `processContextOutputCapture`, exactly where production runs it.
   * The in-turn stand-in banks immediately; this hook stages the payload for
   * review and lets the engine publish it only after validation passes.
   *
   * Returning null refuses the payload, which is how a rejection is scripted.
   */
  outputCapture?(input: {
    contextId: string;
    /** The execution as the capture gate sees it, before semantic review. */
    execution: GraphWorkflowExecution;
    /** The same production execution target the implementer and validators saw. */
    worktreePath?: string;
  }): Record<string, unknown> | null;
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
  /** The production execution target for this context, when it has one. */
  worktreePath?: string;
  /** The prompt the engine rendered for this turn. */
  prompt: string;
  /** The production repository this run commits through. */
  manager: ReturnType<typeof createGraphWorkflowManager>;
  repository: ReturnType<
    typeof createGraphWorkflowEngine
  >["executionRepository"];
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

function createPairOccurrenceCounter(): (
  first: string,
  second: string,
) => number {
  const counts = new Map<string, Map<string, number>>();
  return (first, second) => {
    let bySecond = counts.get(first);
    if (bySecond === undefined) {
      bySecond = new Map<string, number>();
      counts.set(first, bySecond);
    }
    const next = (bySecond.get(second) ?? 0) + 1;
    bySecond.set(second, next);
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

function createWorktreeStub(worktreeRoot?: string): ParallelWorktrees {
  const provision = async (input: ProvisionInput): Promise<ProvisionResult> => {
    const worktreePath =
      worktreeRoot === undefined
        ? `${input.projectPath}/.worktrees/${input.sessionDir}.${input.contextId}`
        : path.join(worktreeRoot, `${input.sessionDir}.${input.contextId}`);
    if (worktreeRoot !== undefined) {
      await mkdir(worktreePath, { recursive: true });
    }
    return {
      worktreePath,
      branchName: `csm/${input.sessionDir}-${input.contextId}`,
    };
  };
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

/** One production capture-gate dispatch, as the gate saw it. */
export interface CompatibilityCaptureCall {
  contextId: string;
  /**
   * Whether this context already had a banked output when the gate ran. Always
   * false in a correct engine — the gate is the only writer, and it declines a
   * context it already captured — so a true here is the signature of an output
   * banked behind the gate's back.
   */
  outputAlreadyBanked: boolean;
}

export interface EngineScenarioRun {
  /** The execution the loop returned. */
  settled: GraphWorkflowExecution;
  /** The three normalized R14 projections. */
  recording: CompatibilityRecording;
  /**
   * Every production capture-gate dispatch, in order. Empty unless the scenario
   * wired {@link CompatibilityScenario.outputCapture}.
   */
  captureCalls: readonly CompatibilityCaptureCall[];
  /** Every typed event the run published, in order. */
  events: TypedEventRecord[];
  /** The production manager, still bound to the open persistence fixture. */
  manager: ReturnType<typeof createGraphWorkflowManager>;
  repository: ReturnType<
    typeof createGraphWorkflowEngine
  >["executionRepository"];
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
   * {@link EngineScenarioRun.repository} answers from the repository that wrote the
   * run, and that repository keeps a parsed-row cache; a reload through it would
   * happily return state the writing process still holds. This reader shares
   * nothing with it but the database file, so anything it reports — the
   * execution blob AND the appended `graph_workflow_events` log — genuinely
   * survived persistence.
   */
  restartedStore(): StateStore;
}

interface EngineScenarioHarnessHooks {
  executionContract?: GraphExecutionContract;
  getSessionWorktreeDirtyPaths?(input: {
    sessionWorktreePath: string;
  }): Promise<DirtyPath[]>;
  /**
   * Validator assignment ids reject NUL at the authored and persisted schemas,
   * so the collision regression maps valid seats at this boundary instead of
   * weakening those schemas solely to exercise the counter.
   */
  validationAttemptIdentity?(input: {
    contextId: string;
    assignmentId: string;
  }): readonly [contextId: string, assignmentId: string];
}

/**
 * Run a scenario through the real engine and hand the result to `inspect` BEFORE
 * the persistence fixture closes, so a caller can reload from the same SQLite
 * database (a restart) or drive the manager again.
 */
export async function runEngineScenario<T>(
  scenario: CompatibilityScenario,
  inspect: (run: EngineScenarioRun) => Promise<T>,
  harnessHooks: EngineScenarioHarnessHooks = {},
): Promise<T> {
  _resetActiveLoopsForTesting();

  const fixture = createPersistenceFixture();
  try {
    fixture.seedProject(PROJECT_PATH);
    fixture.seedSession(PROJECT_PATH, SESSION_NAME);

    const scheduling: SchedulingDecision[] = [];
    const statusTransitions: ContextStatusTransition[] = [];
    const events: TypedEventRecord[] = [];
    const captureCalls: CompatibilityCaptureCall[] = [];

    const now = createDeterministicClock();
    const config = createHarnessConfig();

    let lastCommitted: GraphWorkflowExecution | null = null;
    let lastEligible: string | null = null;

    const worktrees = createWorktreeStub(scenario.worktreeRoot);
    const getSession = async (
      projectPath: string,
      sessionName: string,
    ): Promise<SessionState | null> =>
      fixture.store.getSession(projectPath, sessionName);

    // ---------------------------------------------------------------------
    // The scripted agents. These are the only fakes standing between the
    // fixture and the production iteration path: the implementer reaches the
    // engine through the production task-completion operation, with the same
    // execution/context/conversation binding as the lane command, and the
    // validator returns a verdict through the production validation service.
    // ---------------------------------------------------------------------
    const nextConversationId = createCounter("conversation");
    const knownConversationIds = new Set<string>();
    const nextAgentTurn = createOccurrenceCounter();
    const nextValidationAttempt = createPairOccurrenceCounter();

    const createConversation = async (): Promise<{ id: string }> => {
      const id = nextConversationId();
      knownConversationIds.add(id);
      return { id };
    };

    /**
     * Bank the scenario's declared output for a context whose tasks are now all
     * complete — the guard the routing evaluates has to read a real capture off
     * the real execution. Written once: a re-run of the same context must not
     * silently re-decide its routes under a new capture iteration.
     *
     * Stands down entirely when the scenario wired the production capture gate:
     * banking here would bank BEFORE validation, which is the reverse of the
     * engine's order and would make that order untestable.
     */
    async function bankScenarioCapture(contextId: string): Promise<void> {
      if (scenario.outputCapture !== undefined) return;
      const value = scenario.capture?.({ contextId });
      if (!value) return;
      await repository
        .mutateActive(PROJECT_PATH, SESSION_NAME, (current) => {
          if (current.contextOutputs[contextId]) return unchanged();
          const remaining = Object.values(current.taskStates).filter(
            (task) =>
              task.contextId === contextId && task.status !== "completed",
          );
          if (remaining.length > 0) return unchanged();
          return changed({
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
          });
        })
        .then((mutation) => mutation.execution);
    }

    const nextDispatch = createOccurrenceCounter();

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
    const executionContract =
      harnessHooks.executionContract ?? createTestGraphExecutionContract();
    const {
      executionRepository: repository,
      eventPublisher: publisher,
      workflowManager: manager,
      contextScheduler,
      iterationOrchestrator,
      executionLoop,
    } = createGraphWorkflowEngine({
      clearConversationQuestion: async () => false,
      executionContract,

      repair: () => null,
      scheduler: { createBatchId: createCounter("batch") },
      conversation: {
        listActiveExecutions: () =>
          fixture.store.listActiveGraphWorkflowExecutions(),
        createConversation,
        async getConversation(_projectPath, _sessionName, conversationId) {
          return knownConversationIds.has(conversationId)
            ? { id: conversationId }
            : null;
        },
        now,
      },
      storage: {
        publication: {
          broadcast: (event) => {
            const projected = projectTypedEvent(event);
            // This corpus compares its pre-D4 event vocabulary. Events introduced
            // after that baseline have independent contracts and are excluded.
            if (POST_D4_OBSERVABILITY_EVENT_TYPES.has(event.type)) return;
            events.push(projected);
          },
          now,
          dispatchPush: () => {},
        },
        repository: (publisher) => ({
          getGraphWorkflowPendingArtifacts: async () => null,
          clearGraphWorkflowPendingArtifacts: async () => false,

          // No git worktree in this harness; the real exclusion would shell out.
          ensureCcArtifactsExcluded: async () => {},
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
            const result =
              await fixture.store.mutateActiveGraphWorkflowExecution(
                projectPath,
                sessionName,
                label,
                (current) => {
                  const mutated = mutate(current);
                  if (mutated.kind === "no_commit") return mutated;
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
                    scheduling.push({
                      decision: "eligible",
                      contextIds: eligible,
                    });
                  }
                  return mutated;
                },
              );
            return result;
          },
          reserveActiveGraphWorkflowExecution:
            fixture.store.reserveActiveGraphWorkflowExecution,
          archiveActiveGraphWorkflowExecution:
            fixture.store.archiveActiveGraphWorkflowExecution,

          charterService: createWorkflowCharterService({
            writeFile: async () => {},
            ensureDir: async () => {},
            publishCharterRegistered: publisher.publishCharterRegistered,
          }),
          readConfig: async () => config,
        }),
      },
      lifecycle: {
        abortConversation: () => {},
        abortExecutionLoop: () => {},
        retireLaneConversation: () => {},
        loadDefinition: async () => null,
        now,
        createExecutionId: () => EXECUTION_ID,

        readGlobalConfig: async () => config,
        stopExecutionLaneDevServers: async () => {},
      },
      git: {
        parallelWorktrees: worktrees,
        mergeMutex,
        sessionGitLock,
        joinRunner: recordingJoinRunner,
        soloContextCommitter: { commit: async () => ({ status: "skipped" }) },
        laneCommitter: {
          commit: async () => ({ status: "skipped" }),
          resolveHead: async () => "stub-head",
        },
        executionTargetResolver: createExecutionTargetResolver(),
      },
      execution: {
        ...createExecutionInfrastructureFixture(),
        // Compatibility lane targets are not git worktrees, even when an artifact
        // proof opts into real temporary directories; production's full-access
        // index preparation is covered by execution-loop tests.
        resyncSharedIndex: async () => {},
        getSession,
        createJobId: createCounter("loop-job"),
        getMaxConcurrentQueries: async () => 4,
        getSessionWorktreeDirtyPaths:
          harnessHooks.getSessionWorktreeDirtyPaths ?? (async () => []),
      },
      context({ continuityService }) {
        return {
          storage: {
            findLatestContextValidationEvent: (
              projectPath,
              sessionName,
              executionId,
              contextId,
            ) =>
              fixture.store.findLatestGraphWorkflowContextEvent(
                projectPath,
                sessionName,
                executionId,
                contextId,
                "graph-workflow-validation-result",
              ),
          },
          conversation: {
            outputCaptureService: {
              captureContextOutput: async () => {
                throw new Error("Output capture is outside this fixture");
              },
            },
            advisoryResponseService: {
              runAdvisoryResponse:
                scenario.advisoryResponse ??
                (async () => {
                  throw new Error("Advisory response is outside this fixture");
                }),
            },

            createConversation,
            continuityService,
            async runAgentIteration(input) {
              const current = await repository.getActive(
                input.projectPath,
                input.sessionName,
              );
              if (!current || current.id !== input.executionId)
                throw new Error(
                  "Fixture execution was replaced before the agent turn",
                );
              const boundConversationId = resolveBoundConversationId(
                current,
                input.contextId,
              );
              if (boundConversationId !== input.conversationId)
                throw new Error(
                  `Conversation "${input.conversationId}" does not drive context "${input.contextId}"`,
                );
              const context = current.workingDefinition.executionContexts.find(
                (context) => context.id === input.contextId,
              );
              const session = await getSession(
                input.projectPath,
                input.sessionName,
              );
              if (!context || !session)
                throw new Error("Fixture context or session missing");
              const completion = taskCompletion.create({
                projectPath: input.projectPath,
                sessionName: input.sessionName,
                executionId: input.executionId,
                contextId: input.contextId,
                conversationId: boundConversationId,
                executionTarget: createExecutionTargetResolver().resolve({
                  execution: current,
                  contextId: input.contextId,
                  session,
                }),
                executionContextTitle: context.title,
                allowAgentTaskAdd: context.mutability.allowAgentTaskAdd,
                allowAgentCollaboration:
                  context.collaboration?.enabled.value ?? false,
              });

              const turn = nextAgentTurn(input.contextId);
              await scenario.onAgentTurn?.({
                contextId: input.contextId,
                turn,
                executionId: input.executionId,
                conversationId: input.conversationId,
                projectPath: input.projectPath,
                sessionName: input.sessionName,
                ...(input.executionTarget === undefined
                  ? {}
                  : { worktreePath: input.executionTarget.worktreePath }),
                prompt: input.prompt,
                manager,
                repository,
                eventPublisher: publisher,
              });
              if (
                scenario.agent({ contextId: input.contextId, turn }) ===
                "complete-next-task"
              ) {
                const execution = await repository.getActive(
                  input.projectPath,
                  input.sessionName,
                );
                const taskId = execution
                  ? findNextIncompleteTaskId(execution, input.contextId)
                  : null;
                if (taskId) {
                  await completion.completeTask(taskId, `Completed ${taskId}`);
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
            // Wired only when a scenario opts in, so the engine — not the agent turn —
            // decides when a context's output is captured, and the order between a
            // cohort round and its context's structured output becomes observable.
            ...(scenario.outputCapture === undefined
              ? {}
              : {
                  outputCaptureService: {
                    async captureContextOutput(input) {
                      captureCalls.push({
                        contextId: input.contextId,
                        outputAlreadyBanked:
                          input.execution.contextOutputs[input.contextId] !==
                          undefined,
                      });
                      const value = scenario.outputCapture?.({
                        contextId: input.contextId,
                        execution: input.execution,
                        ...(input.executionTarget === undefined
                          ? {}
                          : {
                              worktreePath: input.executionTarget.worktreePath,
                            }),
                      });
                      if (!value) {
                        return {
                          kind: "rejected",
                          summary: `The scenario refused a payload for "${input.contextId}"`,
                          issues: [],
                          rejectedText: null,
                        };
                      }
                      return {
                        kind: "captured",
                        value,
                        parse: { source: "native" as const },
                      };
                    },
                  },
                }),
          },
          validation: {
            scriptValidatorService: {
              runScriptValidator: async () => {
                throw new Error("Script validation is outside this fixture");
              },
            },
            validationRoundService: stubValidationRoundService(),
            cohort: {
              async runContextValidator(input): Promise<ValidatorRunResult> {
                // Per SEAT, not per context: two specialists reviewing one candidate
                // each get their own attempt sequence, exactly as two real lanes would.
                const attemptIdentity =
                  harnessHooks.validationAttemptIdentity?.({
                    contextId: input.context.id,
                    assignmentId: input.validator.id,
                  }) ?? [input.context.id, input.validator.id];
                const attempt = nextValidationAttempt(
                  attemptIdentity[0],
                  attemptIdentity[1],
                );
                // Loaded per seat, mid-round: a seat's question is what is in front of
                // it RIGHT NOW, and a snapshot taken after the run settles cannot tell a
                // candidate that existed during review from one that appeared later.
                const midRound = await repository.getActive(
                  PROJECT_PATH,
                  SESSION_NAME,
                );
                if (!midRound) {
                  throw new Error(
                    `Fixture validator ran with no active execution for context "${input.context.id}"`,
                  );
                }
                const scripted = scenario.validator?.({
                  contextId: input.context.id,
                  attempt,
                  assignmentId: input.validator.id,
                  authority: input.validator.authority,
                  ...(input.executionTarget === undefined
                    ? {}
                    : { worktreePath: input.executionTarget.worktreePath }),
                  execution: midRound,
                }) ?? { verdict: "pass" };
                const metadata = {
                  sessionRef: null,
                  reviewArtifact: null,
                  limitEvaluation: "disabled",
                  rotateBeforeNextTurn: false,
                } as const;
                const advisories = (scripted.advisories ?? []).map(
                  (advisory) => ({
                    ...advisory,
                  }),
                );

                if (scripted.verdict === "pass") {
                  return {
                    result: {
                      kind: "pass",
                      summary: `${input.validator.id} found "${input.context.id}" satisfied its acceptance criteria`,
                      issues: [],
                      advisories,
                      reopenTaskIds: [],
                    },
                    metadata,
                    roundToken: input.roundToken ?? null,
                  };
                }

                return {
                  result: {
                    kind: "fail",
                    summary: `${input.validator.id} found "${input.context.id}" did not satisfy its acceptance criteria`,
                    issues: scripted.reopenTaskIds.map((taskId) => ({
                      taskId,
                      title: "Acceptance criteria not evidenced",
                      description:
                        "Record the verification evidence for this task.",
                    })),
                    advisories,
                    reopenTaskIds: [...scripted.reopenTaskIds],
                  },
                  metadata,
                  roundToken: input.roundToken ?? null,
                };
              },
            },
          },
          policy: {
            readRepoConfig,
            // The harness does not materialize workflow documents into its lane targets.
            materializeWorkflowDocuments: async ({ execution }) => execution,
            // Every fixture context leaves `askUserQuestions` disabled, so no lane
            // conversation can end on a pending question batch.
            readLaneConversation: async () => null,
            createTaskId: createCounter("task"),
            now,
          },
        };
      },
    });

    const taskCompletion = createGraphWorkflowExecutionToolContext({
      executionRepository: repository,
      runtimeEditService: createGraphWorkflowRuntimeEditService(),
      sharedDocumentRegistry:
        createGraphWorkflowSharedDocumentRegistryService(),
      publishLiveEditApplied: publisher.publishLiveEditApplied,
      readLiveOccupancy: () => null,
      executionContract,
      now,
    });

    const scheduleEligibleContexts = contextScheduler.scheduleEligibleContexts;
    contextScheduler.scheduleEligibleContexts = async function (input) {
      const result = await scheduleEligibleContexts(input);
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
    };
    const runIteration = iterationOrchestrator.runIteration;
    iterationOrchestrator.runIteration = async function (
      input: GraphWorkflowIterationInput,
    ): Promise<GraphWorkflowIterationResult> {
      scheduling.push({
        decision: "dispatched",
        contextId: input.contextId,
        iteration: nextDispatch(input.contextId),
      });
      return runIteration(input);
    };

    await repository.create(PROJECT_PATH, SESSION_NAME, {
      definition: scenario.definition,
      source: {
        kind: "template",
        definitionId: DEFINITION_ID,
        definitionRevision: 1,
        tier: "project",
      },
      launchDocument: makeLaunchDocument(scenario.definition),
      executionId: EXECUTION_ID,
      startedAt: now(),
      inputs: {},
      ownerConversationId: null,
    });

    const running = await repository
      .mutateActive(PROJECT_PATH, SESSION_NAME, (execution) =>
        changed({ ...execution, status: "running" }),
      )
      .then((mutation) => mutation.execution);

    const runExecutionLoop = (
      execution: GraphWorkflowExecution,
    ): Promise<GraphWorkflowExecution> =>
      executionLoop.run({
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
      captureCalls,
      events,
      manager,
      repository,
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
