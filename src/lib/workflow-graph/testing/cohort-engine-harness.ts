/**
 * The engine driving the REAL cohort machinery: the orchestrator's round, the
 * production validation service, and a fake at the one true boundary — the
 * single-specialist dispatch. Everything a test asserts through this harness
 * about concurrency, attempts, precedence, and event publication therefore runs
 * through production code.
 *
 * Shared rather than per-file because the cohort's behaviour and the cohort's
 * event contract are two views of one machine: a harness that drifted between
 * them would let a test prove a verdict the other test's events never saw.
 */

import { vi } from "vitest";
import { QUERY_SLOT_ADMISSION_TIMEOUT_CODE } from "@/lib/shared/query-semaphore";
import type { GraphWorkflowExecutionEvent } from "@/lib/workflow-graph/event-schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowValidationSpecialist,
} from "@/lib/workflow-graph/schemas";
import type { SeededValidatorAssignment } from "@/lib/workflow-graph/config-schemas";
import type { WorkflowValidatorAdvisory } from "@/lib/workflow-graph/definition-schemas";
import type {
  GraphWorkflowAdvisoryResponseInput,
  GraphWorkflowAdvisoryResponseOutcome,
} from "@/lib/workflow-graph/advisory-response-runner";
import {
  createGraphWorkflowExecutionEventPublisher,
  type GraphWorkflowEventDelivery,
  type GraphWorkflowPushInfo,
} from "@/lib/workflow-graph/execution-events";
import {
  createResolvedWorkflowDefinition,
  createWorkflowExecution,
  makeSeededValidatorAssignment,
} from "@/lib/workflow-graph/test-fixtures";
import {
  createGraphWorkflowIterationOrchestrator,
  type GraphWorkflowIterationResult,
  type IterationOrchestratorValidationRoundService,
} from "@/lib/workflow-graph/iteration-orchestrator";

/** What the engine asks a candidate-tree probe, exactly as the port declares it. */
export type ResolveCandidateTreeInput = Parameters<
  IterationOrchestratorValidationRoundService["resolveCandidateTree"]
>[0];
import { createGraphWorkflowValidationService } from "@/lib/workflow-graph/execution-validation";
import type { GraphWorkflowContextValidatorInput } from "@/lib/workflow-graph/execution-validation";
import type { ValidatorRunResult } from "@/lib/workflow-graph/validator-runner";
import {
  buildValidationRoundRoster,
  computeTaskStateHash,
  type ValidationCandidateTreeResolution,
} from "@/lib/workflow-graph/validation-round";
import { createGraphWorkflowManager } from "@/lib/workflow-graph/workflow-manager";
import type { ScriptValidatorOutcome } from "@/lib/workflow-graph/script-validator-runner";
import type {
  ResumeUserInputContext,
  UserInputGateService,
} from "@/lib/workflow-graph/user-input-gate";

export const NOW = "2026-08-04T12:00:00.000Z";
export const COHORT = [
  "general",
  "security-reviewer",
  "perf-reviewer",
] as const;

type MutateActiveReturn =
  | GraphWorkflowExecution
  | {
      execution: GraphWorkflowExecution;
      events: GraphWorkflowExecutionEvent[];
      pushes?: GraphWorkflowPushInfo[];
    };

function isResultWithEvents(value: MutateActiveReturn): value is {
  execution: GraphWorkflowExecution;
  events: GraphWorkflowExecutionEvent[];
  pushes?: GraphWorkflowPushInfo[];
} {
  return "events" in value && "execution" in value;
}

export function createRepository(initial: GraphWorkflowExecution) {
  let active = initial;
  let lock: Promise<void> = Promise.resolve();
  const appendedEvents: GraphWorkflowExecutionEvent[] = [];

  const repository = {
    async getActive() {
      return active;
    },
    async mutateActive(
      _projectPath: string,
      _sessionName: string,
      fn: (
        execution: GraphWorkflowExecution,
      ) => MutateActiveReturn | Promise<MutateActiveReturn>,
    ) {
      const previous = lock;
      let release!: () => void;
      lock = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        await previous;
        const result = await fn(structuredClone(active));
        if (isResultWithEvents(result)) {
          active = result.execution;
          appendedEvents.push(...result.events);
          repository.deliver({
            events: result.events,
            pushes: result.pushes ?? [],
          });
        } else {
          active = result;
        }
        return active;
      } finally {
        release();
      }
    },
    async findLatestContextValidationEvent() {
      return null;
    },
    // The manager's repository seam is wider than the orchestrator's. The
    // recovery paths the harness drives through it need only getActive and
    // mutateActive; the rest exist so the real manager can be constructed over
    // this repository, and throw rather than quietly no-op if one is reached.
    async create(): Promise<GraphWorkflowExecution> {
      throw new Error("the cohort harness never creates an execution");
    },
    async archiveActive(): Promise<void> {
      throw new Error("the cohort harness never archives an execution");
    },
    async markContextEventsPreReset(): Promise<number> {
      throw new Error("the cohort harness never pre-resets context events");
    },
    read() {
      return active;
    },
    appendedEvents,
    deliver: (_delivery: GraphWorkflowEventDelivery) => {},
  };
  return repository;
}

export function createCohortExecution(
  options: {
    assignmentIds?: readonly string[];
    /**
     * The whole cohort, when a test's subject is what distinguishes one seat
     * from another — distinct profiles, revisions, or instruction hashes.
     * `assignmentIds` covers the common case where only the seat ids matter.
     */
    assignments?: readonly SeededValidatorAssignment[];
    consecutiveFailureCount?: number;
  } = {},
): GraphWorkflowExecution {
  // Blocking by id-only construction: every rule this harness exists to
  // exercise — precedence, attempts, halts, remediation — is a rule about
  // lanes that can gate a round, so a cohort of advisory seats would quietly
  // turn those tests into tests of a round nothing can fail. A test whose
  // subject IS authority passes `assignments` and says so.
  const assignments =
    options.assignments ??
    (options.assignmentIds ?? COHORT).map((id) =>
      makeSeededValidatorAssignment({ id, authority: "blocking" }),
    );
  const base = createResolvedWorkflowDefinition();
  const definition = createResolvedWorkflowDefinition({
    executionContexts: base.executionContexts.map((context) =>
      context.id === "context-plan"
        ? {
            ...context,
            contextValidator: {
              enabled: true,
              assignments: [...assignments],
            },
            scriptValidator: { commands: ["pre-merge"] },
          }
        : context,
    ),
  });

  const execution = createWorkflowExecution({
    status: "running",
    activeContextIds: ["context-plan"],
    workingDefinition: definition,
  });
  execution.contextStates["context-plan"] = {
    ...execution.contextStates["context-plan"]!,
    status: "running",
    completedTaskCount: 1,
    iterationCount: 2,
    consecutiveFailureCount: options.consecutiveFailureCount ?? 1,
  };
  execution.taskStates["task-plan-1"] = {
    ...execution.taskStates["task-plan-1"]!,
    status: "completed",
    summary: "Documented the plan.",
    completedAt: "2026-08-04T11:00:00.000Z",
  };
  return execution;
}

export const TREE_A: ValidationCandidateTreeResolution = {
  kind: "resolved",
  identityScope: "wholeTree",
  headSha: "head-1",
  candidateTreeHash: "tree-a",
};

/**
 * An execution that already carries an OPEN round for `context-plan`, frozen on
 * the candidate {@link TREE_A} still resolves to.
 *
 * This is what a process reload looks like from the engine's side: the round
 * record is all that survived the crash, so a test built this way exercises the
 * recovery the round record is supposed to make possible rather than the
 * in-memory state of a run that never stopped.
 */
export function withOpenRound(
  execution: GraphWorkflowExecution,
  params: {
    seq?: number;
    specialists: Record<string, GraphWorkflowValidationSpecialist>;
  },
): GraphWorkflowExecution {
  const next = structuredClone(execution);
  const context = next.workingDefinition.executionContexts.find(
    (entry) => entry.id === "context-plan",
  );
  if (context === undefined) throw new Error("context-plan is not defined");
  const contextState = next.contextStates["context-plan"];
  if (contextState === undefined) {
    throw new Error("context-plan has no runtime state");
  }
  contextState.validationRound = {
    seq: params.seq ?? 1,
    candidate: {
      identityScope:
        TREE_A.kind === "resolved" ? TREE_A.identityScope : "wholeTree",
      headSha: TREE_A.kind === "resolved" ? TREE_A.headSha : "",
      candidateTreeHash:
        TREE_A.kind === "resolved" ? TREE_A.candidateTreeHash : "",
      taskStateHash: computeTaskStateHash(next.taskStates, "context-plan"),
    },
    roster: buildValidationRoundRoster(context.contextValidator.assignments),
    specialists: params.specialists,
    phase: "specialists",
    outcome: null,
    startedAt: NOW,
  };
  return next;
}

/** A specialist record as the round would have persisted it. */
export function specialistRecord(
  overrides: Partial<GraphWorkflowValidationSpecialist> & {
    state: GraphWorkflowValidationSpecialist["state"];
  },
): GraphWorkflowValidationSpecialist {
  return {
    attempts: 0,
    summary: null,
    issues: [],
    advisories: [],
    questionToken: null,
    sessionRef: null,
    reviewArtifact: null,
    lastInfraFailure: null,
    ...overrides,
  };
}

export function metadata(): ValidatorRunResult["metadata"] {
  return {
    sessionRef: null,
    reviewArtifact: null,
    limitEvaluation: "disabled",
    rotateBeforeNextTurn: false,
  };
}

export function passResult(
  assignmentId: string,
  advisories: WorkflowValidatorAdvisory[] = [],
): ValidatorRunResult["result"] {
  return {
    kind: "pass",
    summary: `${assignmentId} is satisfied.`,
    issues: [],
    advisories,
    reopenTaskIds: [],
  };
}

export function failResult(
  assignmentId: string,
  taskIds: string[],
  advisories: WorkflowValidatorAdvisory[] = [],
): ValidatorRunResult["result"] {
  return {
    kind: "fail",
    summary: `${assignmentId} rejected the work.`,
    issues: taskIds.map((taskId) => ({
      taskId,
      title: `${assignmentId} on ${taskId}`,
      description: `${assignmentId} wants ${taskId} redone.`,
    })),
    advisories,
    reopenTaskIds: taskIds,
  };
}

/** One advisory as a lane would report it, before the engine stamps identity. */
export function advisoryItem(
  overrides: Partial<WorkflowValidatorAdvisory> = {},
): WorkflowValidatorAdvisory {
  return {
    kind: "implementation",
    title: "Consider extracting the helper",
    description: "The same shape appears in two places.",
    ...overrides,
  };
}

export const INFRA_RESULT: ValidatorRunResult["result"] = {
  kind: "infra_error",
  reason: "exception",
  message: "provider unavailable",
  engine: "claude",
};

export const ADMISSION_TIMEOUT_RESULT: ValidatorRunResult["result"] = {
  kind: "queue_admission_timeout",
  message: `no slot [${QUERY_SLOT_ADMISSION_TIMEOUT_CODE}]`,
  engine: "claude",
};

export interface Harness {
  repository: ReturnType<typeof createRepository>;
  run(overrides?: {
    resumeUserInputs?: readonly ResumeUserInputContext[];
  }): Promise<GraphWorkflowIterationResult>;
  /** The operator pausing to edit — the real `workflowManager.send({pause})`. */
  pause(): Promise<void>;
  /**
   * The operator clearing the halt — the real `workflowManager.resume`, not a
   * copy of it, so a test cannot pass here on a reset the production resume
   * never performs.
   */
  resumeHalt(): Promise<void>;
  /**
   * A server restart over a still-running execution, then the operator resuming
   * it: the real `normalizeAfterRestart` (which pauses, carrying no halt reason)
   * followed by the real `resume`. This is the path a crash actually takes, and
   * it is the one that must NOT refill an attempt budget.
   */
  restartAndResume(): Promise<void>;
  runContextValidator: ReturnType<typeof vi.fn>;
  /** The advisory-response turn, when the test wired one. */
  runAdvisoryResponse: ReturnType<typeof vi.fn>;
  incidents(): GraphWorkflowExecutionEvent[];
  results(): GraphWorkflowExecutionEvent[];
  specialistResults(): GraphWorkflowExecutionEvent[];
  contextState(): GraphWorkflowExecution["contextStates"][string] | undefined;
}

export function createHarness(params: {
  execution: GraphWorkflowExecution;
  runContextValidator: (
    input: GraphWorkflowContextValidatorInput,
  ) => Promise<ValidatorRunResult>;
  scriptValidatorOutcome?: () => Promise<ScriptValidatorOutcome>;
  /**
   * The candidate tree each probe resolves; defaults to {@link TREE_A}. Receives
   * the probe's own input, so a test can assert what the engine ASKED for — the
   * candidate scope in particular, which the engine derives from placement.
   */
  resolveCandidateTree?: (
    input: ResolveCandidateTreeInput,
  ) => ValidationCandidateTreeResolution;
  /**
   * The user-input gate the orchestrator AND the manager share. Injected when a
   * test needs to observe the parked-question lifecycle (withdrawals, machine
   * dispatches); otherwise each builds its own default over this repository.
   */
  userInputGateService?: UserInputGateService;
  /**
   * What the advisory-response turn returns. Omitted leaves the service
   * unwired, which is the shape of every context whose validators raise no
   * advisories — the engine must dispatch nothing.
   */
  advisoryResponse?: (
    input: GraphWorkflowAdvisoryResponseInput,
  ) => Promise<GraphWorkflowAdvisoryResponseOutcome>;
}): Harness {
  const repository = createRepository(params.execution);
  const eventPublisher = createGraphWorkflowExecutionEventPublisher({
    now: () => NOW,
  });
  repository.deliver = eventPublisher.deliver;

  const runContextValidator = vi.fn(params.runContextValidator);
  const validationService = createGraphWorkflowValidationService({
    runContextValidator,
  });

  const signalHalt = vi.fn(
    async (halt: { reason: GraphWorkflowExecution["haltReason"] }) => {
      const current = structuredClone(repository.read());
      current.status = "halted";
      current.haltReason = halt.reason;
      await repository.mutateActive("/repo", "session-1", () => current);
      return current;
    },
  );

  // The real recovery paths, over the same repository the orchestrator writes
  // through: resume and restart-normalization are production decisions about a
  // round's attempt budget, so the harness drives them rather than imitating
  // them.
  const manager = createGraphWorkflowManager({
    executionRepository: repository,
    async loadDefinition() {
      return null;
    },
    ...(params.userInputGateService
      ? { userInputGateService: params.userInputGateService }
      : {}),
    eventPublisher,
    now: () => NOW,
  });

  // Unwired means the service is never passed to the orchestrator at all, so
  // this default exists only to keep the spy's type honest. It throws rather
  // than inventing an empty batch: a test that reaches it has wired nothing and
  // is about to assert on dispositions no turn produced.
  const runAdvisoryResponse = vi.fn(
    params.advisoryResponse ??
      (async (): Promise<GraphWorkflowAdvisoryResponseOutcome> => {
        throw new Error("no advisory response was wired for this harness");
      }),
  );

  const orchestrator = createGraphWorkflowIterationOrchestrator({
    executionRepository: repository,
    ...(params.advisoryResponse
      ? { advisoryResponseService: { runAdvisoryResponse } }
      : {}),
    signalHalt,
    findLatestContextValidationEvent:
      repository.findLatestContextValidationEvent,
    createConversation: vi.fn(async () => ({ id: "conversation-impl" })),
    createToolServer: vi.fn(() => ({ server: {} })),
    runAgentIteration: vi.fn(async () => {
      throw new Error("the validation-only path must not run the implementer");
    }),
    validationService,
    scriptValidatorService: {
      runScriptValidator: vi.fn(
        params.scriptValidatorOutcome ??
          (async (): Promise<ScriptValidatorOutcome> => ({
            kind: "pass",
            treeState: { headSha: "head-1", dirty: true },
            command: "bun run pre-merge",
          })),
      ),
    },
    validationRoundService: {
      resolveCandidateTree: vi.fn(
        async (input: ResolveCandidateTreeInput) =>
          params.resolveCandidateTree?.(input) ?? TREE_A,
      ),
    },
    ...(params.userInputGateService
      ? { userInputGateService: params.userInputGateService }
      : {}),
    eventPublisher,
    now: () => NOW,
  });

  return {
    repository,
    runContextValidator,
    runAdvisoryResponse,
    async run(overrides) {
      return await orchestrator.runIteration({
        projectPath: "/repo",
        projectName: "repo",
        sessionName: "session-1",
        contextId: "context-plan",
        ...(overrides?.resumeUserInputs
          ? { resumeUserInputs: overrides.resumeUserInputs }
          : {}),
      });
    },
    async pause() {
      await manager.send("/repo", "session-1", { type: "pause" });
    },
    async resumeHalt() {
      await manager.resume("/repo", "session-1");
    },
    async restartAndResume() {
      // A restart only normalizes an execution the persisted record still calls
      // running — which is exactly what a crash leaves behind.
      await repository.mutateActive("/repo", "session-1", (latest) => {
        const next = structuredClone(latest);
        next.status = "running";
        next.haltReason = null;
        return next;
      });
      await manager.normalizeAfterRestart("/repo", "session-1");
      await manager.resume("/repo", "session-1");
    },
    incidents: () =>
      repository.appendedEvents.filter(
        (entry) => entry.event.type === "graph-workflow-validation-incident",
      ),
    results: () =>
      repository.appendedEvents.filter(
        (entry) => entry.event.type === "graph-workflow-validation-result",
      ),
    specialistResults: () =>
      repository.appendedEvents.filter(
        (entry) =>
          entry.event.type === "graph-workflow-validation-specialist-result",
      ),
    contextState: () => repository.read().contextStates["context-plan"],
  };
}
