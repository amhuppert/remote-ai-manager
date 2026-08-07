import { NextResponse } from "next/server";
import {
  notFound,
  resolveProjectSessionOr404,
} from "@/lib/shared/route-resolution";
import { z } from "zod";
import { readConfig } from "@/lib/config/loader";
import {
  resetExecutionContextAssignmentRequestSchema,
  resetExecutionContextRequestSchema,
} from "@/lib/workflow-graph/schemas";
import {
  createConversation,
  getConversation,
} from "@/lib/conversations/service";
import { abortConversation as abortConversationRegistry } from "@/lib/conversations/abort-registry";
import {
  sendConversationEvent,
  stopConversationActor,
} from "@/lib/workflows/conversation/manager";
import { createLogger, withTracing } from "@/lib/logging";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import {
  getSession as defaultGetSession,
  getActiveGraphWorkflowExecution,
  mutateActiveGraphWorkflowExecution,
  archiveActiveGraphWorkflowExecution,
  markGraphWorkflowContextEventsPreReset,
  findLatestGraphWorkflowContextEvent,
  listActiveGraphWorkflowExecutions,
  listArchivedGraphWorkflowExecutions,
  getGraphWorkflowEventsPage,
  getGraphWorkflowEventsTail,
} from "@/lib/state-store";
import { createLaneService } from "@/lib/workflows/primitives/lane-service";
import { createGraphLaneStore } from "@/lib/workflow-graph/graph-lane-store";
import {
  resolveConfiguredAgentBackendDefaults,
  type ConversationTurnConfig,
} from "@/lib/agent-backends/conversation-policy";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { ApiError } from "@/lib/api/errors";
import type { SessionState } from "@/lib/sessions/schemas";
import type {
  GraphWorkflowCleanupStatusValue,
  GraphWorkflowExecutionEvent,
  GraphWorkflowMergeStatusValue,
} from "@/lib/workflow-graph/event-schemas";
import type {
  GraphWorkflowEventPage,
  GraphWorkflowEventPageQuery,
} from "@/lib/state-store/graph-workflow-events-repo";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionJoinKind,
  GraphWorkflowExecutionJoinStatus,
  GraphWorkflowHaltReason,
} from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowStatus } from "@/lib/workflow-graph/definition-schemas";
import { dispatchPushForGraphWorkflowEvent } from "@/lib/push-notification/dispatcher";
import {
  createAgentAuth,
  type OptionalTokenValidation,
} from "@/lib/agent-gateway/token";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
import {
  applyLiveEditsToActiveExecution,
  buildDefaultAssignmentSnapshotPreparation,
  buildDefaultLiveEditDeps,
  defaultWriteCharterDocument,
} from "./live-edit-apply";
import { createPlanRepairAgentRunner } from "./plan-repair/agent-runner";
import { createPlanRepairSupervisor } from "./plan-repair/supervisor";
import { toPlanRepairValidationVerdict } from "./plan-repair/prompt";
import { loadRotationHandoffNote } from "./rotation-handoff";
import { readConversationTelemetry } from "./conversation-telemetry";
import { createGraphWorkflowExecutionRepository } from "./execution-repository";
import { createGraphWorkflowValidationService } from "./execution-validation";
import { GraphWorkflowValidationError } from "./validation";
import { createValidatorRunner } from "./validator-runner";
import {
  createScriptValidatorRunner,
  type ScriptValidatorInput,
  type ScriptValidatorOutcome,
} from "./script-validator-runner";
import { createWorkflowStorageService } from "./storage";
import { scopeForTier } from "./template-library-service";
import {
  abortExecutionLoop,
  createGraphWorkflowExecutionLoop,
  isExecutionLoopActive,
} from "@/lib/workflow-graph/execution-loop";
import {
  createGraphWorkflowIterationOrchestrator,
  type GraphWorkflowIterationToolServer,
  type IterationOrchestratorScriptValidatorInput,
} from "@/lib/workflow-graph/iteration-orchestrator";
import {
  createGraphWorkflowManager,
  GraphWorkflowTransitionConflictError,
  WorkflowDefinitionApprovalRequiredError,
  WorkflowDefinitionRevisionMismatchError,
  WorkflowPrerequisitesUnmetError,
  WorkflowStartGuardError,
  WorkflowStartInputError,
  type RecordPendingHaltReasonInput,
  type RecordPendingHaltReasonResult,
  type RecordDefinitionApprovalResult,
  type DrainAndHaltInput,
  type GraphWorkflowResumeOptions,
} from "@/lib/workflow-graph/workflow-manager";
import { conflictDecisionInputSchema } from "@/lib/jobs/schemas";
import { runRegisteredMergeJob } from "@/lib/jobs/queue";
import { createRegisteredDeliveryGateEvaluator } from "@/lib/workflows/merge/delivery-gate-port";
import {
  createRegisteredGraphExecutionLifecycleCallbacks,
  type DefinitionApprovalGateDecision,
  type GraphExecutionLifecycleContext,
} from "@/lib/workflow-graph/execution-lifecycle-port";
import { createPreflightPrerequisiteService } from "@/lib/workflow-graph/preflight-prerequisite-service";
import { stopExecutionLaneDevServers as defaultStopExecutionLaneDevServers } from "@/lib/workflow-graph/dev-server-lane-cleanup";
import { toHaltReason } from "@/lib/workflow-graph/errors";
import { readWorktreeDirtyPaths } from "@/lib/git/worktree";
import { defaultGitClient } from "@/lib/git/client";
import { computeCandidateTreeHash } from "@/lib/git/diff";
import type { ValidationCandidateTreeResolution } from "@/lib/workflow-graph/validation-round";
import { createGraphLaneContinuity } from "@/lib/workflow-graph/lane-continuity";
import { createGraphWorkflowImplementerRunner } from "./implementer-runner";
import { createGraphWorkflowOutputCaptureRunner } from "./context-output-capture-runner";
import { createGraphWorkflowAdvisoryResponseRunner } from "./advisory-response-runner";
import { createParallelWorktrees } from "./parallel-worktrees";
import { createSharedDocumentStore } from "./shared-document-store";
import { createWorkflowDocumentMaterializer } from "./document-materialization";
import { createPerSessionMergeMutex } from "./per-session-merge-mutex";
import { createSessionGitLock } from "@/lib/shared/lock-retry";
import { acquireSessionLock } from "@/lib/prompt/single-flight";
import { createGraphWorkflowMergeRunner } from "./graph-merge-runner";
import {
  createExecutionTargetResolver,
  type ExecutionTarget,
} from "./execution-target-resolver";
import { createGraphWorkflowSignalHaltHandler } from "./graph-workflow-signal-halt";
import {
  createApprovalGateService,
  type ApprovalGateDecisionInput,
  type RecordDecisionGuardFailureReason,
  type RecordDecisionInput,
  type RecordDecisionResult,
} from "./approval-gate";
import { createSoloContextCommitter } from "./solo-context-committer";
import { createLaneCommitter } from "./lane-committer";
import { createJoinRunner } from "./join-runner";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  assertGraphExecutionContractAccepted,
  createRegisteredGraphExecutionContract,
  GraphExecutionContractViolationError,
} from "./execution-contract-port";

type RouteContext = {
  params: Promise<Record<string, string>>;
};

const startExecutionSchema = z.object({
  definitionId: z.string().trim().min(1),
  definitionRevision: z.number().int().positive().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  // Additive tier discriminator (the schema is not `.strict()`, so this
  // preserves every existing caller). Defaults to `project` — the per-project
  // load — so an omitted tier behaves exactly as today.
  tier: z.enum(["project", "global"]).default("project"),
});

const resolveApprovalSchema = z.discriminatedUnion("decision", [
  z.object({
    contextId: z.string().trim().min(1),
    decision: z.literal("approve"),
  }),
  z.object({
    contextId: z.string().trim().min(1),
    decision: z.literal("reject"),
    message: z.string().trim().min(1),
  }),
]);

// Resume accepts an optional body: per-file operator guidance for the next
// conflict-resolution attempt of any failed join being retried. An absent or
// empty body resumes without guidance (every pre-existing caller).
const resumeRequestSchema = z.object({
  conflictGuidance: z.array(conflictDecisionInputSchema).optional(),
});

const logger = createLogger("graph-workflow-route-handlers");

const GRAPH_WORKFLOW_EVENTS_DEFAULT_LIMIT = 500;
const GRAPH_WORKFLOW_EVENTS_MAX_LIMIT = 2000;

const eventPublisher = createGraphWorkflowExecutionEventPublisher({
  dispatchPush: dispatchPushForGraphWorkflowEvent,
});

const executionRepository = createGraphWorkflowExecutionRepository({
  getSession: defaultGetSession,
  getActiveGraphWorkflowExecution,
  mutateActiveGraphWorkflowExecution,
  archiveActiveGraphWorkflowExecution,
  markGraphWorkflowContextEventsPreReset,
  eventPublisher,
});

const workflowStorage = createWorkflowStorageService();

const parallelWorktrees = createParallelWorktrees();

const workflowManager = createGraphWorkflowManager({
  retireLaneConversation: ({ projectPath, sessionName, conversationId }) =>
    stopConversationActor(
      projectPath,
      sessionName,
      conversationId,
      "workflow_assignment_reset",
    ),
  executionRepository,
  loadDefinition: (projectPath, definitionId, tier) =>
    workflowStorage.get(scopeForTier(tier, projectPath), definitionId),
  isExecutionLoopActive,
  parallelWorktrees,
  getSession: defaultGetSession,
  readSessionWorktreeDirtyPaths: (worktreePath) =>
    readWorktreeDirtyPaths(worktreePath),
  preflightService: createPreflightPrerequisiteService(),
  readGlobalConfig: readConfig,
  abortConversation: ({ projectPath, sessionName, conversationId }) => {
    abortConversationRegistry(conversationId);
    const accepted = sendConversationEvent(
      projectPath,
      sessionName,
      conversationId,
      { type: "ABORT_TURN", reason: "user" },
    );
    if (!accepted) {
      logger.warn("workflow.abort_event_rejected", {
        conversationId,
        sessionName,
      });
    }
  },
  abortExecutionLoop,
});

/**
 * Durable lane continuity: lane state lives on the execution row
 * (`laneStates`) and every read/write goes through the workflow manager's
 * `mutateActive` — the same critical section (and loop fence) as every other
 * execution mutation — so backend continuity handles survive restarts.
 */
const graphLaneService = createLaneService({
  store: createGraphLaneStore({
    listActiveExecutions: async () => listActiveGraphWorkflowExecutions(),
    mutateActiveExecution: (projectPath, sessionName, fn) =>
      workflowManager.mutateActive(projectPath, sessionName, fn),
  }),
});

const continuityService = createGraphLaneContinuity({
  laneService: graphLaneService,
  executionRepository: workflowManager,
  createConversation,
  getConversation,
  loadRotationHandoff: (conversationId) =>
    loadRotationHandoffNote(conversationId),
  retireLaneConversation: ({ projectPath, sessionName, conversationId }) =>
    stopConversationActor(
      projectPath,
      sessionName,
      conversationId,
      "workflow_lane_rotated",
    ),
});

export function resolveGraphValidatorTimeoutMs(
  config: ConversationTurnConfig,
  backend: AgentBackendId,
): number {
  return resolveConfiguredAgentBackendDefaults(config, backend).timeoutMs;
}

const validatorRunner = createValidatorRunner({
  async resolveWorktreePath(projectPath, sessionName) {
    const session = await defaultGetSession(projectPath, sessionName);
    if (!session) throw new Error("Session not found");
    return session.worktreePath;
  },
  async resolveTimeoutMs(validatorType) {
    const config = await readConfig();
    return resolveGraphValidatorTimeoutMs(config, validatorType);
  },
  continuityService,
  executionRepository: workflowManager,
});
const implementerRunner = createGraphWorkflowImplementerRunner();
const outputCaptureRunner = createGraphWorkflowOutputCaptureRunner({
  async resolveTimeoutMs(backend) {
    const config = await readConfig();
    return resolveConfiguredAgentBackendDefaults(config, backend).timeoutMs;
  },
});
const advisoryResponseRunner = createGraphWorkflowAdvisoryResponseRunner({
  async resolveTimeoutMs(backend) {
    const config = await readConfig();
    return resolveConfiguredAgentBackendDefaults(config, backend).timeoutMs;
  },
});
const validationService = createGraphWorkflowValidationService({
  runContextValidator: validatorRunner.runContextValidator,
  renderRoundCommonSections: validatorRunner.renderRoundCommonSections,
});

/**
 * Resolves a validation round's candidate tree from the worktree the cohort
 * will inspect: the per-context target when the context is worktree-isolated,
 * the session worktree otherwise.
 *
 * A failure is reported as `unavailable` with its reason, never as a partial
 * identity. The engine treats an unreadable tree as an infrastructure outcome —
 * a round that cannot name what it reviewed cannot certify it — so degrading to
 * "some components are missing" here would let a semantic verdict be published
 * on a candidate nobody could pin down.
 */
const validationRoundService = {
  async resolveCandidateTree(input: {
    projectPath: string;
    sessionName: string;
    executionTarget?: ExecutionTarget;
  }): Promise<ValidationCandidateTreeResolution> {
    const worktreePath =
      input.executionTarget?.worktreePath ??
      (await defaultGetSession(input.projectPath, input.sessionName))
        ?.worktreePath;
    if (worktreePath === undefined) {
      return {
        kind: "unavailable",
        reason: `no worktree resolved for session "${input.sessionName}"`,
      };
    }

    const [head, candidateTreeHash] = await Promise.all([
      defaultGitClient
        .git(["rev-parse", "HEAD"], worktreePath)
        .then((result) => result.stdout.trim() || null)
        .catch(() => null),
      computeCandidateTreeHash(worktreePath),
    ]);

    if (head === null || candidateTreeHash === null) {
      return {
        kind: "unavailable",
        reason: `git could not resolve ${head === null ? "HEAD" : "the candidate tree"} in ${worktreePath}`,
      };
    }

    return { kind: "resolved", headSha: head, candidateTreeHash };
  },
};
const scriptValidatorRunner = createScriptValidatorRunner();

export interface GraphWorkflowRouteScriptValidatorServiceDeps {
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  readConfig(): Promise<{ preMergeTimeoutMs?: number }>;
  runScriptValidator(
    input: ScriptValidatorInput,
  ): Promise<ScriptValidatorOutcome>;
}

export function createGraphWorkflowRouteScriptValidatorService(
  deps: GraphWorkflowRouteScriptValidatorServiceDeps,
) {
  return {
    async runScriptValidator(
      input: IterationOrchestratorScriptValidatorInput,
    ): Promise<ScriptValidatorOutcome> {
      const session = await deps.getSession(
        input.projectPath,
        input.sessionName,
      );
      if (!session) {
        throw new Error("Session not found");
      }

      const config = await deps.readConfig();
      const timeoutMs = config.preMergeTimeoutMs ?? 300_000;

      // Scope validation to the diff against where this context's work lands.
      // A worktree-isolated context branch fans into the session branch; a solo
      // context runs on the session branch itself, so its base is the session's
      // own merge target (using the session branch would yield an empty diff and
      // skip checks).
      const scopingTargetBranch = input.executionTarget
        ? session.branchName
        : session.targetBranch;
      const context = input.execution.workingDefinition.executionContexts.find(
        (candidate) => candidate.id === input.contextId,
      );
      if (!context) {
        throw new Error(
          `Execution context "${input.contextId}" was not found for script validation`,
        );
      }

      return deps.runScriptValidator({
        projectPath: input.projectPath,
        worktreePath: session.worktreePath,
        sessionName: input.sessionName,
        branchName: session.branchName,
        executionId: input.execution.id,
        contextId: input.contextId,
        targetBranch: scopingTargetBranch,
        timeoutMs,
        commands: context.scriptValidator.commands,
        executionTarget: input.executionTarget,
        signal: input.signal,
      });
    },
  };
}

const scriptValidatorService = createGraphWorkflowRouteScriptValidatorService({
  getSession: defaultGetSession,
  readConfig,
  runScriptValidator: scriptValidatorRunner.runScriptValidator,
});

const sharedDocumentMaterializer = createWorkflowDocumentMaterializer({
  store: createSharedDocumentStore(),
});

/**
 * The transient MCP tool server attached to a graph-workflow lane iteration.
 * Empty by design: the four lane tools (task complete/add, shared-doc upsert,
 * collab request) moved to the token-gated `cctl workflow …` verbs the lane
 * prompt instructs (docs/design/cc-cli/02 §4), so NEW lane conversations attach
 * no in-process CC MCP server — its empty `servers` list is a no-op in the
 * conversation's portable-MCP compose. Exported as a named seam so a unit test
 * can pin "new lane spawns get no in-process CC server entry" without
 * reaching into the orchestrator wiring.
 */
export function buildLaneIterationToolServer(): GraphWorkflowIterationToolServer {
  return { server: { servers: [] } };
}

const iterationOrchestrator = createGraphWorkflowIterationOrchestrator({
  executionRepository: workflowManager,
  findLatestContextValidationEvent: (executionId, contextId) =>
    findLatestGraphWorkflowContextEvent(
      executionId,
      contextId,
      "graph-workflow-validation-result",
    ),
  createConversation,
  continuityService,
  eventPublisher,
  signalHalt: createGraphWorkflowSignalHaltHandler(workflowManager),
  materializeWorkflowDocuments: (input) =>
    sharedDocumentMaterializer.materialize(input).then(() => undefined),
  createToolServer: () => buildLaneIterationToolServer(),
  runAgentIteration: async (input) => {
    const session = await defaultGetSession(
      input.projectPath,
      input.sessionName,
    );
    if (!session) {
      throw new Error("Session not found");
    }

    return implementerRunner.runIteration({
      projectPath: input.projectPath,
      session,
      prompt: input.prompt,
      conversationId: input.conversationId,
      executionId: input.executionId,
      contextId: input.contextId,
      backend: input.backend,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      toolServer: input.toolServer,
      executionTarget: input.executionTarget,
      askUserQuestionsEnabled: input.askUserQuestionsEnabled,
    });
  },
  validationService,
  scriptValidatorService,
  validationRoundService,
  outputCaptureService: outputCaptureRunner,
  advisoryResponseService: advisoryResponseRunner,
  readConversationTelemetry: (conversationId) =>
    readConversationTelemetry(conversationId),
});
const mergeMutex = createPerSessionMergeMutex();
// The global single-flight lock so graph git operations share state with
// user commit/merge jobs on the same session.
const sessionGitLock = createSessionGitLock({ acquireSessionLock });
const mergeRunner = createGraphWorkflowMergeRunner({
  deliveryGate: createRegisteredDeliveryGateEvaluator(),
  markDelivered:
    createRegisteredGraphExecutionLifecycleCallbacks().markDelivered,
  runMachine: runRegisteredMergeJob,
});
const soloContextCommitter = createSoloContextCommitter();
const laneCommitter = createLaneCommitter();
const joinRunner = createJoinRunner({
  mergeRunner,
  sessionGitLock,
  mergeMutex,
});
const executionTargetResolver = createExecutionTargetResolver();

const executionLoop = createGraphWorkflowExecutionLoop({
  workflowManager,
  iterationOrchestrator,
  parallelWorktrees,
  mergeMutex,
  sessionGitLock,
  mergeRunner,
  soloContextCommitter,
  laneCommitter,
  joinRunner,
  executionTargetResolver,
  getSession: defaultGetSession,
});

// ============================================================
// Plan-repair supervisor composition (docs/design/cc-cli/08)
// ============================================================
// Every loop start flows through `kickOffExecutionLoop` below, so its
// settlement is the single trigger seam: after the loop returns, the
// supervisor re-reads the ACTIVE execution (never the loop's possibly-fenced
// snapshot) and runs one bounded repair round when a retry-exhaustion halt is
// eligible. Repairs ride the shared live-edit apply core (source
// `plan-repair`), and a successful repair resumes through the same
// normalize → resume → kick trio the RESUME route uses.

const planRepairSupervisor = createPlanRepairSupervisor({
  getActiveExecution: (projectPath, sessionName) =>
    workflowManager.getActive(projectPath, sessionName),
  mutateActive: executionRepository.mutateActive,
  applyLiveEdits: (input) =>
    applyLiveEditsToActiveExecution(input, {
      getActiveExecution: getActiveGraphWorkflowExecution,
      mutateActive: executionRepository.mutateActive,
      buildLiveEditDeps: buildDefaultLiveEditDeps,
      prepareAssignmentSnapshots: buildDefaultAssignmentSnapshotPreparation,
      publishLiveEditApplied: eventPublisher.publishLiveEditApplied,
      publishCharterUpdated: eventPublisher.publishCharterUpdated,
      getSession: defaultGetSession,
      writeCharterDocument: defaultWriteCharterDocument,
    }),
  runRepairAgent: createPlanRepairAgentRunner(),
  resumeExecution: async ({ projectPath, sessionName, projectName }) => {
    await workflowManager.normalizeAfterRestart(projectPath, sessionName);
    const execution = await workflowManager.resume(projectPath, sessionName);
    // Fire-and-forget like the RESUME route's kick: the loop owns its own
    // failure handling (recovery_error halts), so a rejection here is only
    // logged.
    void runExecutionLoopWithPlanRepair({
      projectPath,
      projectName,
      sessionName,
      execution,
    }).catch((error) => {
      logger.warn("graph-workflow.plan_repair.resume_kick_failed", {
        projectPath,
        sessionName,
        error: getErrorMessage(error),
      });
    });
  },
  getValidationHistory: async (executionId, contextId) => {
    const rows = await getGraphWorkflowEventsTail(
      executionId,
      GRAPH_WORKFLOW_EVENTS_DEFAULT_LIMIT,
    );
    return rows
      .map((row) => row.event)
      .filter(
        (
          event,
        ): event is Extract<
          typeof event,
          { type: "graph-workflow-validation-result" }
        > =>
          event.type === "graph-workflow-validation-result" &&
          event.contextId === contextId,
      )
      .map((event) => toPlanRepairValidationVerdict(event));
  },
  getSessionWorktreePath: async (projectPath, sessionName) =>
    (await defaultGetSession(projectPath, sessionName))?.worktreePath ?? null,
  publishPlanRepairRound: eventPublisher.publishPlanRepairRound,
  now: () => new Date().toISOString(),
});

/**
 * Run the execution loop, then give the plan-repair supervisor its shot at
 * the settlement state. The supervisor never throws and self-guards against
 * concurrent runs; a resume it performs re-enters this wrapper, bounded by
 * the round caps.
 */
async function runExecutionLoopWithPlanRepair(input: {
  projectPath: string;
  projectName: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
}): Promise<void> {
  await executionLoop.run(input);
  await planRepairSupervisor.maybeRunPlanRepair({
    projectPath: input.projectPath,
    sessionName: input.sessionName,
    projectName: input.projectName,
  });
}

interface GraphWorkflowExecutionContextMergeProgress {
  contextId: string;
  branchName: string | null;
  mergeStatus: GraphWorkflowMergeStatusValue;
  cleanupStatus: GraphWorkflowCleanupStatusValue;
  lastMergeError: string | null;
}

interface GraphWorkflowExecutionJoinProgress {
  joinId: string;
  kind: GraphWorkflowExecutionJoinKind;
  contextId: string | null;
  targetLaneId: string;
  sourceLaneIds: string[];
  mergedSourceLaneIds: string[];
  status: GraphWorkflowExecutionJoinStatus;
}

interface GraphWorkflowExecutionFinalPublishProgress {
  joinId: string;
  targetLaneId: string;
  sourceLaneIds: string[];
  mergedSourceLaneIds: string[];
  status: GraphWorkflowExecutionJoinStatus;
}

export interface GraphWorkflowExecutionSummary {
  executionId: string;
  definitionId: string;
  definitionRevision: number;
  status: GraphWorkflowStatus;
  startedAt: string;
  completedAt: string | null;
  activeContextIds: string[];
  activeContextTitles: string[];
  activeBatchIds: string[];
  activeJoinIds: string[];
  haltReason: GraphWorkflowHaltReason | null;
  pendingHaltReason: GraphWorkflowHaltReason | null;
  contextMergeProgress: GraphWorkflowExecutionContextMergeProgress[];
  joinProgress: GraphWorkflowExecutionJoinProgress[];
  finalPublishState: GraphWorkflowExecutionFinalPublishProgress | null;
  archived: boolean;
}

export interface GraphWorkflowExecutionRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  normalizeExecutionAfterRestart(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null>;
  startExecution(input: {
    projectPath: string;
    sessionName: string;
    definitionId: string;
    expectedDefinitionRevision?: number;
    tier?: "project" | "global";
    parameters?: Record<string, unknown>;
  }): Promise<GraphWorkflowExecution>;
  markRunning?(
    context: GraphExecutionLifecycleContext,
    workflowExecutionId: string,
    definitionId?: string,
    definitionRevision?: number,
  ): Promise<void>;
  /**
   * Reports an execution that started but parked awaiting definition
   * approval, so the registered lifecycle consumer can open its own review
   * request for the pending definition. Defaults to the registered port.
   */
  awaitingDefinitionApproval?(
    context: GraphExecutionLifecycleContext,
    workflowExecutionId: string,
    definitionId: string,
    definitionRevision: number,
  ): Promise<void>;
  /**
   * Consulted before a pending definition approval is recorded so the
   * registered lifecycle consumer can record its own execution-scoped
   * admission for definitions it prepared, or refuse with a machine-readable
   * reason. Defaults to the registered port (admit when nobody claims it).
   */
  admitDefinitionApproval?(
    context: GraphExecutionLifecycleContext,
    workflowExecutionId: string,
    definitionId: string,
    definitionRevision: number,
  ): Promise<DefinitionApprovalGateDecision>;
  /**
   * Reports a successful abort so the registered lifecycle consumer can
   * terminalize work pinned to the run. Defaults to the registered port.
   */
  executionAborted?(workflowExecutionId: string): Promise<void>;
  pauseExecution(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution>;
  resumeExecution(
    projectPath: string,
    sessionName: string,
    options?: GraphWorkflowResumeOptions,
  ): Promise<GraphWorkflowExecution>;
  abortExecution(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution>;
  resetExecutionContext(
    projectPath: string,
    sessionName: string,
    contextId: string,
  ): Promise<GraphWorkflowExecution>;
  resetExecutionContextAssignment(
    projectPath: string,
    sessionName: string,
    contextId: string,
    assignmentId: string,
  ): Promise<GraphWorkflowExecution>;
  archiveExecution(projectPath: string, sessionName: string): Promise<void>;
  kickOffExecutionLoop(input: {
    projectPath: string;
    projectName: string;
    sessionName: string;
    execution: GraphWorkflowExecution;
  }): Promise<void>;
  getActiveExecution(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null>;
  recordPendingHaltReason(
    input: RecordPendingHaltReasonInput,
  ): Promise<RecordPendingHaltReasonResult>;
  drainAndHalt(input: DrainAndHaltInput): Promise<GraphWorkflowExecution>;
  recordApprovalDecision(
    input: RecordDecisionInput,
  ): Promise<RecordDecisionResult>;
  /**
   * Approve the pending workflow definition on the session's active execution
   * (the definition-review gate for approval-required definitions). Defaults
   * to the workflow manager's atomic first-approval-wins recording.
   */
  recordDefinitionApproval?(input: {
    projectPath: string;
    sessionName: string;
    expectedExecutionId?: string;
    expectedDefinitionId?: string;
    expectedDefinitionRevision?: number;
  }): Promise<RecordDefinitionApprovalResult>;
  /**
   * Transport identity for the definition-approval gate. Definition approval
   * is a human review act: requests bearing a valid agent token are refused
   * with `human_act_required`. Defaults to the shared agent-gateway auth.
   */
  auth?: {
    validateOptionalToken(request: Request): Promise<OptionalTokenValidation>;
  };
  /**
   * List the session's archived (terminal, moved-out) graph-workflow
   * executions. Defaults to the real archived-executions repo via the store.
   */
  listArchivedExecutions?(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution[]>;
  /**
   * Read the bounded tail of the persisted append-only event log for an
   * execution. Defaults to the real `graph_workflow_events` repo via the store.
   */
  getEventsTail?(
    executionId: string,
    limit: number,
  ): Promise<GraphWorkflowExecutionEvent[]>;
  /**
   * Read one cursor-paginated page of an execution's event log — the reader the
   * loop-ledger surfaces walk for COMPLETE history, which the bounded tail
   * cannot serve. Defaults to the real `graph_workflow_events` repo.
   */
  getEventsPage?(
    executionId: string,
    query: GraphWorkflowEventPageQuery,
  ): Promise<GraphWorkflowEventPage>;
  /**
   * Stop dev servers running in a terminal execution's lane worktrees before it
   * is cleared/archived. Backstop for the case where halt/abort/merge cleanup
   * did not stop them. Defaults to the real worktree-scoped cleanup.
   */
  stopExecutionLaneDevServers?(input: {
    execution: GraphWorkflowExecution;
    projectPath: string;
  }): Promise<void>;
}

const approvalGateService = createApprovalGateService({
  mutateActive: executionRepository.mutateActive,
  now: () => new Date().toISOString(),
});

const defaultDeps: GraphWorkflowExecutionRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  getSession: defaultGetSession,
  normalizeExecutionAfterRestart: (projectPath, sessionName) =>
    workflowManager.normalizeAfterRestart(projectPath, sessionName),
  startExecution: (input) => workflowManager.start(input),
  markRunning: createRegisteredGraphExecutionLifecycleCallbacks().markRunning,
  awaitingDefinitionApproval:
    createRegisteredGraphExecutionLifecycleCallbacks()
      .awaitingDefinitionApproval,
  admitDefinitionApproval:
    createRegisteredGraphExecutionLifecycleCallbacks().admitDefinitionApproval,
  executionAborted:
    createRegisteredGraphExecutionLifecycleCallbacks().executionAborted,
  recordDefinitionApproval: (input) =>
    workflowManager.recordDefinitionApproval(input),
  pauseExecution: (projectPath, sessionName) =>
    workflowManager.send(projectPath, sessionName, { type: "pause" }),
  resumeExecution: (projectPath, sessionName, options) =>
    workflowManager.resume(projectPath, sessionName, options),
  abortExecution: (projectPath, sessionName) =>
    workflowManager.send(projectPath, sessionName, { type: "abort" }),
  resetExecutionContext: (projectPath, sessionName, contextId) =>
    workflowManager.resetContext(projectPath, sessionName, contextId),
  resetExecutionContextAssignment: (
    projectPath,
    sessionName,
    contextId,
    assignmentId,
  ) =>
    workflowManager.resetContextAssignment(
      projectPath,
      sessionName,
      contextId,
      assignmentId,
    ),
  archiveExecution: (projectPath, sessionName) =>
    executionRepository.archiveActive(projectPath, sessionName),
  async kickOffExecutionLoop(input) {
    await runExecutionLoopWithPlanRepair(input);
  },
  getActiveExecution: (projectPath, sessionName) =>
    workflowManager.getActive(projectPath, sessionName),
  recordPendingHaltReason: (input) =>
    workflowManager.recordPendingHaltReason(input),
  drainAndHalt: (input) => workflowManager.drainAndHalt(input),
  recordApprovalDecision: (input) => approvalGateService.recordDecision(input),
  auth: createAgentAuth(),
  listArchivedExecutions: (projectPath, sessionName) =>
    listArchivedGraphWorkflowExecutions(projectPath, sessionName),
  getEventsTail: (executionId, limit) =>
    getGraphWorkflowEventsTail(executionId, limit),
  getEventsPage: (executionId, query) =>
    getGraphWorkflowEventsPage(executionId, query),
  stopExecutionLaneDevServers: (input) =>
    defaultStopExecutionLaneDevServers(input),
};

function isTerminalStatus(status: GraphWorkflowStatus): boolean {
  return status === "completed" || status === "halted" || status === "aborted";
}

function summarizeExecution(
  execution: GraphWorkflowExecution,
  archived: boolean,
): GraphWorkflowExecutionSummary {
  const activeContextIds = [...execution.activeContextIds];
  const activeContextTitles = activeContextIds.map((contextId) => {
    const context = execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === contextId,
    );
    return context?.title ?? contextId;
  });

  const seenBatches = new Set<string>();
  const activeBatchIds: string[] = [];
  for (const contextId of activeContextIds) {
    const batchId = execution.contextStates[contextId]?.batchId;
    if (batchId && !seenBatches.has(batchId)) {
      seenBatches.add(batchId);
      activeBatchIds.push(batchId);
    }
  }

  const seenContexts = new Set<string>();
  const orderedContextIds: string[] = [];
  for (const id of activeContextIds) {
    if (!seenContexts.has(id)) {
      seenContexts.add(id);
      orderedContextIds.push(id);
    }
  }
  for (const context of execution.workingDefinition.executionContexts) {
    if (!seenContexts.has(context.id)) {
      seenContexts.add(context.id);
      orderedContextIds.push(context.id);
    }
  }

  const contextMergeProgress: GraphWorkflowExecutionContextMergeProgress[] = [];
  for (const contextId of orderedContextIds) {
    const state = execution.contextStates[contextId];
    if (!state) continue;
    if (
      state.mergeStatus === "not-applicable" &&
      state.cleanupStatus === "not-applicable" &&
      state.lastMergeError === null
    ) {
      continue;
    }
    contextMergeProgress.push({
      contextId,
      branchName: state.branchName,
      mergeStatus: state.mergeStatus,
      cleanupStatus: state.cleanupStatus,
      lastMergeError: state.lastMergeError,
    });
  }

  const joinValues = Object.values(execution.joins ?? {});
  const activeJoins = joinValues.filter(
    (join) => join.status === "pending" || join.status === "running",
  );
  activeJoins.sort((a, b) => a.joinId.localeCompare(b.joinId));
  const activeJoinIds = activeJoins.map((join) => join.joinId);
  const joinProgress: GraphWorkflowExecutionJoinProgress[] = activeJoins.map(
    (join) => ({
      joinId: join.joinId,
      kind: join.kind,
      contextId: join.contextId,
      targetLaneId: join.targetLaneId,
      sourceLaneIds: [...join.sourceLaneIds],
      mergedSourceLaneIds: [...join.mergedSourceLaneIds],
      status: join.status,
    }),
  );
  const finalPublishJoin = activeJoins.find(
    (join) => join.kind === "final_publish",
  );
  const finalPublishState: GraphWorkflowExecutionFinalPublishProgress | null =
    finalPublishJoin
      ? {
          joinId: finalPublishJoin.joinId,
          targetLaneId: finalPublishJoin.targetLaneId,
          sourceLaneIds: [...finalPublishJoin.sourceLaneIds],
          mergedSourceLaneIds: [...finalPublishJoin.mergedSourceLaneIds],
          status: finalPublishJoin.status,
        }
      : null;

  return {
    executionId: execution.id,
    definitionId: execution.seedDefinitionId,
    definitionRevision: execution.seedDefinitionRevision,
    status: execution.status,
    startedAt: execution.startedAt,
    completedAt: execution.completedAt,
    activeContextIds,
    activeContextTitles,
    activeBatchIds,
    activeJoinIds,
    haltReason: execution.haltReason,
    pendingHaltReason: execution.pendingHaltReason,
    contextMergeProgress,
    joinProgress,
    finalPublishState,
    archived,
  };
}

async function summarizeHistory(
  deps: GraphWorkflowExecutionRouteDeps,
  projectPath: string,
  sessionName: string,
): Promise<GraphWorkflowExecutionSummary[]> {
  const listArchived =
    deps.listArchivedExecutions ?? listArchivedGraphWorkflowExecutions;
  const archived = await listArchived(projectPath, sessionName);
  const items = archived.map((execution) =>
    summarizeExecution(execution, true),
  );

  const active = await deps.getActiveExecution(projectPath, sessionName);
  if (active && isTerminalStatus(active.status)) {
    items.push(summarizeExecution(active, false));
  }

  return items;
}

type ResolveSessionResult =
  | { error: Response }
  | {
      projectName: string;
      projectPath: string;
      sessionName: string;
      session: SessionState;
    };

async function resolveSession(
  context: RouteContext,
  deps: GraphWorkflowExecutionRouteDeps,
): Promise<ResolveSessionResult> {
  const params = await context.params;
  const projectName = params["name"] ?? "";
  const sessionName = decodeURIComponent(params["session"] ?? "");

  const resolved = await resolveProjectSessionOr404(
    deps,
    projectName,
    sessionName,
  );
  if (!resolved.ok) return { error: resolved.response };

  return {
    projectName,
    projectPath: resolved.value.projectPath,
    sessionName,
    session: resolved.value.session,
  };
}

function resolveApprovalConflictMessage(
  reason: Exclude<RecordDecisionGuardFailureReason, "no_active_execution">,
  contextId: string,
): string {
  switch (reason) {
    case "not_awaiting_approval":
      return `Context "${contextId}" is not awaiting approval (not_awaiting_approval)`;
    case "already_decided":
      return `Context "${contextId}" already has a recorded approval decision (already_decided)`;
    case "execution_not_running":
      return "The graph workflow execution no longer accepts approval decisions (execution_not_running)";
  }
}

function respondToManagerError(error: unknown): Response {
  const message =
    error instanceof Error ? error.message : "Graph workflow request failed";

  if (error instanceof GraphWorkflowTransitionConflictError) {
    logger.info("graph-workflow.lifecycle.transition_rejected", {
      action: error.action,
      currentStatus: error.currentStatus,
      allowedStatuses: error.allowedStatuses,
    });
    return NextResponse.json(
      {
        error: error.message,
        code: error.code,
        details: {
          action: error.action,
          currentStatus: error.currentStatus,
          allowedStatuses: error.allowedStatuses,
        },
      } satisfies ApiError,
      { status: 409 },
    );
  }

  if (error instanceof GraphExecutionContractViolationError) {
    return NextResponse.json(
      {
        error: message,
        code: error.code,
        errors: error.issues,
        instruction: error.instruction,
      } satisfies ApiError & {
        code: string;
        errors: unknown;
        instruction: string;
      },
      { status: 409 },
    );
  }

  if (error instanceof WorkflowDefinitionRevisionMismatchError) {
    return NextResponse.json(
      {
        error: error.message,
        code: error.code,
        details: {
          definitionId: error.definitionId,
          expectedRevision: error.expectedRevision,
          actualRevision: error.actualRevision,
        },
      } satisfies ApiError,
      { status: 409 },
    );
  }

  if (
    error instanceof GraphWorkflowValidationError ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { name?: string }).name === "GraphWorkflowValidationError" &&
      "errors" in error)
  ) {
    return NextResponse.json(
      {
        error: message,
        errors: (error as GraphWorkflowValidationError).errors,
      } satisfies ApiError & { errors: unknown },
      { status: 422 },
    );
  }

  if (
    message === "Session does not have an active graph workflow execution" ||
    (message.startsWith('Workflow definition "') &&
      message.endsWith('" was not found'))
  ) {
    return notFound(message);
  }

  if (
    message.includes("already has an active graph workflow execution") ||
    message.startsWith("Reset only allowed") ||
    message.startsWith("Resetting a validator assignment is only allowed") ||
    message.includes("is not configured on execution context") ||
    // Terminal-status refusals from resetExecutionContext: completed, and
    // (D4 R4.2) skipped.
    message.includes("and cannot be reset")
  ) {
    return NextResponse.json({ error: message } satisfies ApiError, {
      status: 409,
    });
  }

  if (
    message.startsWith("Execution context") &&
    message.includes("not found")
  ) {
    return notFound(message);
  }

  return NextResponse.json({ error: message } satisfies ApiError, {
    status: 500,
  });
}

export function createGraphWorkflowExecutionRouteHandlers(
  deps: GraphWorkflowExecutionRouteDeps = defaultDeps,
) {
  const executionContract = createRegisteredGraphExecutionContract();
  async function markExecutionRunning(
    context: GraphExecutionLifecycleContext,
    execution: GraphWorkflowExecution,
  ): Promise<void> {
    if (deps.markRunning === undefined) return;
    try {
      await deps.markRunning(
        context,
        execution.id,
        execution.seedDefinitionId,
        execution.seedDefinitionRevision,
      );
    } catch (error) {
      logger.warn("graph-workflow.execution_mark_running_failed", {
        workflowExecutionId: execution.id,
        definitionId: execution.seedDefinitionId,
        definitionRevision: execution.seedDefinitionRevision,
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * Reports a start that parked awaiting definition approval through the
   * lifecycle port so the registered consumer can open its review request.
   * Reporting is best-effort: a consumer failure must not mask the
   * machine-readable `definition_approval_required` response.
   */
  async function reportAwaitingDefinitionApproval(
    context: GraphExecutionLifecycleContext,
    workflowExecutionId: string,
    definitionId: string,
    definitionRevision: number,
  ): Promise<void> {
    if (deps.awaitingDefinitionApproval === undefined) return;
    try {
      await deps.awaitingDefinitionApproval(
        context,
        workflowExecutionId,
        definitionId,
        definitionRevision,
      );
    } catch (error) {
      logger.warn("graph-workflow.execution_awaiting_approval_report_failed", {
        workflowExecutionId,
        definitionId,
        definitionRevision,
        error: getErrorMessage(error),
      });
    }
  }

  async function reportExecutionLoopFailure(input: {
    projectPath: string;
    sessionName: string;
    expectedExecutionId: string;
    error: unknown;
    phase: "start" | "resume";
  }): Promise<void> {
    const reason = toHaltReason(input.error, { cause: "unknown" });
    let active: GraphWorkflowExecution | null = null;
    try {
      active = await deps.getActiveExecution(
        input.projectPath,
        input.sessionName,
      );
    } catch (lookupError) {
      logger.error("graph-workflow.execution_loop_failed", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        phase: input.phase,
        haltReasonType: reason.type,
        lookupError:
          lookupError instanceof Error
            ? lookupError.message
            : String(lookupError),
      });
      return;
    }
    if (
      !active ||
      active.id !== input.expectedExecutionId ||
      active.status !== "running"
    ) {
      logger.error("graph-workflow.execution_loop_failed", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        phase: input.phase,
        haltReasonType: reason.type,
        hasActiveExecution: active !== null,
        expectedExecutionId: input.expectedExecutionId,
        activeExecutionId: active?.id ?? null,
        executionStatus: active?.status ?? null,
        haltRecovery:
          active !== null && active.id !== input.expectedExecutionId
            ? "execution_mismatch"
            : "not_applicable",
      });
      return;
    }
    try {
      const recorded = await deps.recordPendingHaltReason({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        expectedExecutionId: input.expectedExecutionId,
        reason,
      });
      if (!recorded.accepted) {
        logger.error("graph-workflow.execution_loop_failed", {
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          phase: input.phase,
          haltReasonType: reason.type,
          hasActiveExecution: true,
          executionStatus: recorded.execution.status,
          haltRecovery: "rejected",
        });
        return;
      }
      await deps.drainAndHalt({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        expectedExecutionId: input.expectedExecutionId,
      });
      logger.error("graph-workflow.execution_loop_failed", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        phase: input.phase,
        haltReasonType: reason.type,
        hasActiveExecution: true,
        haltRecovery: "completed",
      });
    } catch (haltError) {
      logger.error("graph-workflow.execution_loop_failed", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        phase: input.phase,
        haltReasonType: reason.type,
        hasActiveExecution: true,
        haltError: getErrorMessage(haltError),
      });
    }
  }

  async function START(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }

    const { projectPath, sessionName } = resolved;

    const parsed = startExecutionSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid request: definitionId is required",
        } satisfies ApiError,
        { status: 400 },
      );
    }

    let execution: GraphWorkflowExecution;
    try {
      // The active-execution and uncommitted-changes guards plus start-input
      // validation all run inside the shared start path so HTTP and MCP enforce
      // an identical pre-seed chain. Guard/input rejections seed nothing, so
      // they map directly to a response without engaging the loop-failure halt
      // path (which only applies to a seeded execution).
      execution = await deps.startExecution({
        projectPath,
        sessionName,
        definitionId: parsed.data.definitionId,
        ...(parsed.data.definitionRevision !== undefined
          ? { expectedDefinitionRevision: parsed.data.definitionRevision }
          : {}),
        tier: parsed.data.tier,
        ...(parsed.data.parameters !== undefined
          ? { parameters: parsed.data.parameters }
          : {}),
      });
    } catch (error) {
      if (error instanceof WorkflowDefinitionApprovalRequiredError) {
        await reportAwaitingDefinitionApproval(
          { projectPath, sessionName },
          error.executionId,
          error.definitionId,
          error.definitionRevision,
        );
        return NextResponse.json(
          {
            error: error.message,
            code: error.code,
            executionId: error.executionId,
            instruction: error.instruction,
          },
          { status: 409 },
        );
      }
      if (error instanceof WorkflowStartGuardError) {
        if (error.guard === "uncommitted_changes") {
          const dirtyPaths = error.dirtyPaths ?? [];
          return NextResponse.json(
            {
              error: error.message,
              code: "uncommitted_changes",
              details: {
                totalCount: dirtyPaths.length,
                paths: dirtyPaths.slice(0, 20).map((entry) => entry.path),
              },
            } satisfies ApiError,
            { status: 409 },
          );
        }
        return NextResponse.json({ error: error.message } satisfies ApiError, {
          status: 409,
        });
      }
      if (error instanceof WorkflowPrerequisitesUnmetError) {
        return NextResponse.json(
          {
            error: error.message,
            code: "prerequisites_unmet",
            details: {
              missing: error.missing,
            },
          } satisfies ApiError,
          { status: 409 },
        );
      }
      if (error instanceof WorkflowStartInputError) {
        return NextResponse.json({ error: error.message } satisfies ApiError, {
          status: 400,
        });
      }
      if (error instanceof GraphExecutionContractViolationError) {
        return respondToManagerError(error);
      }
      return respondToManagerError(error);
    }

    try {
      await markExecutionRunning({ projectPath, sessionName }, execution);
      void Promise.resolve()
        .then(() =>
          deps.kickOffExecutionLoop({
            projectPath,
            projectName: resolved.projectName,
            sessionName,
            execution,
          }),
        )
        .catch(async (error) => {
          logger.warn("graph-workflow.execution_loop_start_failed", {
            projectPath,
            sessionName,
            error: getErrorMessage(error),
          });
          await reportExecutionLoopFailure({
            projectPath,
            sessionName,
            expectedExecutionId: execution.id,
            error,
            phase: "start",
          });
        });
      return NextResponse.json(
        { execution: summarizeExecution(execution, false) },
        { status: 202 },
      );
    } catch (error) {
      await reportExecutionLoopFailure({
        projectPath,
        sessionName,
        expectedExecutionId: execution.id,
        error,
        phase: "start",
      });
      return respondToManagerError(error);
    }
  }

  /**
   * Production start+kickoff seam shared by the HTTP START handler and the MCP
   * `start_graph_workflow` tool. Both surfaces must launch identically: run the
   * shared start path (guards + input validation + substitution + seed via
   * `startExecution`), then fire-and-forget kick off the execution loop exactly
   * as START does so the run actually executes. Guard/input/not-found errors
   * from the shared start path propagate to the caller (which maps them to its
   * surface's error shape); nothing is seeded on a rejection, so the loop is
   * never engaged for a rejected launch.
   */
  async function launch(input: {
    projectPath: string;
    projectName: string;
    sessionName: string;
    definitionId: string;
    expectedDefinitionRevision?: number;
    tier?: "project" | "global";
    parameters?: Record<string, unknown>;
  }): Promise<GraphWorkflowExecution> {
    let execution: GraphWorkflowExecution;
    try {
      execution = await deps.startExecution({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        definitionId: input.definitionId,
        ...(input.expectedDefinitionRevision !== undefined
          ? { expectedDefinitionRevision: input.expectedDefinitionRevision }
          : {}),
        ...(input.tier !== undefined ? { tier: input.tier } : {}),
        ...(input.parameters !== undefined
          ? { parameters: input.parameters }
          : {}),
      });
    } catch (error) {
      if (error instanceof WorkflowDefinitionApprovalRequiredError) {
        await reportAwaitingDefinitionApproval(
          {
            projectPath: input.projectPath,
            sessionName: input.sessionName,
          },
          error.executionId,
          error.definitionId,
          error.definitionRevision,
        );
      }
      throw error;
    }

    await markExecutionRunning(
      { projectPath: input.projectPath, sessionName: input.sessionName },
      execution,
    );

    void Promise.resolve()
      .then(() =>
        deps.kickOffExecutionLoop({
          projectPath: input.projectPath,
          projectName: input.projectName,
          sessionName: input.sessionName,
          execution,
        }),
      )
      .catch(async (error) => {
        logger.warn("graph-workflow.execution_loop_start_failed", {
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          error: getErrorMessage(error),
        });
        await reportExecutionLoopFailure({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          expectedExecutionId: execution.id,
          error,
          phase: "start",
        });
      });

    return execution;
  }

  async function STATUS(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }

    const normalizedExecution = await deps.normalizeExecutionAfterRestart(
      resolved.projectPath,
      resolved.sessionName,
    );
    const execution =
      normalizedExecution ??
      (await deps.getActiveExecution(
        resolved.projectPath,
        resolved.sessionName,
      ));

    const listArchived =
      deps.listArchivedExecutions ?? listArchivedGraphWorkflowExecutions;
    const archived = await listArchived(
      resolved.projectPath,
      resolved.sessionName,
    );

    return NextResponse.json({
      execution: execution ? summarizeExecution(execution, false) : null,
      archivedExecutions: archived.map((entry) =>
        summarizeExecution(entry, true),
      ),
    });
  }

  async function EXECUTION(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }

    const normalizedExecution = await deps.normalizeExecutionAfterRestart(
      resolved.projectPath,
      resolved.sessionName,
    );
    const execution =
      normalizedExecution ??
      (await deps.getActiveExecution(
        resolved.projectPath,
        resolved.sessionName,
      ));

    return NextResponse.json({ execution: execution ?? null });
  }

  async function HISTORY(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }

    return NextResponse.json({
      items: await summarizeHistory(
        deps,
        resolved.projectPath,
        resolved.sessionName,
      ),
    });
  }

  async function EVENTS(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }

    const url = new URL(request.url);
    const activeExecution = await deps.getActiveExecution(
      resolved.projectPath,
      resolved.sessionName,
    );
    const executionId =
      url.searchParams.get("executionId") ?? activeExecution?.id ?? null;
    // `page` opts into the cursor-paginated ledger contract; without it the
    // route answers exactly as it always has, so no existing consumer moves.
    const paginated = url.searchParams.get("page") === "true";
    if (!executionId) {
      return NextResponse.json(
        paginated ? { events: [], nextCursor: null } : { events: [] },
      );
    }

    const limitParam = url.searchParams.get("limit");
    const parsedLimit = limitParam !== null ? Number(limitParam) : NaN;
    const limit =
      Number.isInteger(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, GRAPH_WORKFLOW_EVENTS_MAX_LIMIT)
        : GRAPH_WORKFLOW_EVENTS_DEFAULT_LIMIT;

    if (paginated) {
      const cursorParam = Number(url.searchParams.get("cursor"));
      const getEventsPage = deps.getEventsPage ?? getGraphWorkflowEventsPage;
      const page = await getEventsPage(executionId, {
        limit,
        cursor:
          Number.isInteger(cursorParam) && cursorParam > 0 ? cursorParam : null,
        direction:
          url.searchParams.get("direction") === "desc" ? "desc" : "asc",
      });
      return NextResponse.json({
        // `seq` is the wire name for the row's durable ordering key: it is what
        // the caller sends back as `cursor`, so the pair is one vocabulary.
        events: page.records.map((record) => ({
          seq: record.id,
          occurredAt: record.occurredAt,
          event: record.event,
          preReset: record.preReset,
        })),
        nextCursor: page.nextCursor,
      });
    }

    const getEventsTail = deps.getEventsTail ?? getGraphWorkflowEventsTail;
    const events = await getEventsTail(executionId, limit);
    return NextResponse.json({ events });
  }

  async function PAUSE(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }

    try {
      const execution = await deps.pauseExecution(
        resolved.projectPath,
        resolved.sessionName,
      );
      return NextResponse.json({
        execution: summarizeExecution(execution, false),
      });
    } catch (error) {
      return respondToManagerError(error);
    }
  }

  async function RESUME(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }

    const rawBody: unknown = await request.json().catch(() => ({}));
    const parsedBody = resumeRequestSchema.safeParse(rawBody ?? {});
    if (!parsedBody.success) {
      return NextResponse.json(
        {
          error: `Invalid resume request: ${parsedBody.error.issues[0]?.message ?? "malformed body"}`,
        },
        { status: 400 },
      );
    }
    const resumeOptions: GraphWorkflowResumeOptions | undefined =
      parsedBody.data.conflictGuidance &&
      parsedBody.data.conflictGuidance.length > 0
        ? { conflictGuidance: parsedBody.data.conflictGuidance }
        : undefined;

    try {
      await deps.normalizeExecutionAfterRestart(
        resolved.projectPath,
        resolved.sessionName,
      );
      const execution = await deps.resumeExecution(
        resolved.projectPath,
        resolved.sessionName,
        resumeOptions,
      );
      void Promise.resolve()
        .then(() =>
          deps.kickOffExecutionLoop({
            projectPath: resolved.projectPath,
            projectName: resolved.projectName,
            sessionName: resolved.sessionName,
            execution,
          }),
        )
        .catch(async (error) => {
          logger.warn("graph-workflow.execution_loop_resume_failed", {
            projectPath: resolved.projectPath,
            sessionName: resolved.sessionName,
            error: getErrorMessage(error),
          });
          await reportExecutionLoopFailure({
            projectPath: resolved.projectPath,
            sessionName: resolved.sessionName,
            expectedExecutionId: execution.id,
            error,
            phase: "resume",
          });
        });
      return NextResponse.json({
        execution: summarizeExecution(execution, false),
      });
    } catch (error) {
      return respondToManagerError(error);
    }
  }

  async function ABORT(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }

    try {
      const execution = await deps.abortExecution(
        resolved.projectPath,
        resolved.sessionName,
      );
      // Best-effort: a consumer failure must not mask the successful abort.
      if (deps.executionAborted !== undefined) {
        try {
          await deps.executionAborted(execution.id);
        } catch (error) {
          logger.warn("graph-workflow.execution_abort_report_failed", {
            workflowExecutionId: execution.id,
            error: getErrorMessage(error),
          });
        }
      }
      return NextResponse.json({
        execution: summarizeExecution(execution, false),
      });
    } catch (error) {
      return respondToManagerError(error);
    }
  }

  async function RESET_CONTEXT(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }

    const parsed = resetExecutionContextRequestSchema.safeParse(
      await request.json(),
    );
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid request: executionId and contextId are required",
        } satisfies ApiError,
        { status: 400 },
      );
    }

    const activeExecution = await deps.getActiveExecution(
      resolved.projectPath,
      resolved.sessionName,
    );
    if (!activeExecution) {
      return notFound(
        "Session does not have an active graph workflow execution",
      );
    }

    if (activeExecution.id !== parsed.data.executionId) {
      return NextResponse.json(
        {
          error:
            "Reset request targets a stale execution; reload and try again.",
        } satisfies ApiError,
        { status: 409 },
      );
    }

    try {
      const execution = await deps.resetExecutionContext(
        resolved.projectPath,
        resolved.sessionName,
        parsed.data.contextId,
      );
      return NextResponse.json({
        execution: summarizeExecution(execution, false),
      });
    } catch (error) {
      return respondToManagerError(error);
    }
  }

  async function RESET_ASSIGNMENT(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }

    const parsed = resetExecutionContextAssignmentRequestSchema.safeParse(
      await request.json(),
    );
    if (!parsed.success) {
      return NextResponse.json(
        {
          error:
            "Invalid request: executionId, contextId, and assignmentId are required",
        } satisfies ApiError,
        { status: 400 },
      );
    }

    const activeExecution = await deps.getActiveExecution(
      resolved.projectPath,
      resolved.sessionName,
    );
    if (!activeExecution) {
      return notFound(
        "Session does not have an active graph workflow execution",
      );
    }

    if (activeExecution.id !== parsed.data.executionId) {
      return NextResponse.json(
        {
          error:
            "Reset request targets a stale execution; reload and try again.",
        } satisfies ApiError,
        { status: 409 },
      );
    }

    try {
      const execution = await deps.resetExecutionContextAssignment(
        resolved.projectPath,
        resolved.sessionName,
        parsed.data.contextId,
        parsed.data.assignmentId,
      );
      return NextResponse.json({
        execution: summarizeExecution(execution, false),
      });
    } catch (error) {
      return respondToManagerError(error);
    }
  }

  async function RESOLVE_APPROVAL(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }

    const parsed = resolveApprovalSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        {
          error:
            "Invalid request: contextId and decision are required; reject requires a non-empty message",
        } satisfies ApiError,
        { status: 400 },
      );
    }

    const decision: ApprovalGateDecisionInput =
      parsed.data.decision === "approve"
        ? { type: "approved" }
        : { type: "rejected", message: parsed.data.message };

    let result: RecordDecisionResult;
    try {
      result = await deps.recordApprovalDecision({
        projectPath: resolved.projectPath,
        sessionName: resolved.sessionName,
        contextId: parsed.data.contextId,
        decision,
      });
    } catch (error) {
      return respondToManagerError(error);
    }

    if (!result.ok) {
      if (result.reason === "no_active_execution") {
        return notFound(
          "Session does not have an active graph workflow execution",
        );
      }
      return NextResponse.json(
        {
          error: resolveApprovalConflictMessage(
            result.reason,
            parsed.data.contextId,
          ),
        } satisfies ApiError,
        { status: 409 },
      );
    }

    return NextResponse.json({
      execution: summarizeExecution(result.execution, false),
    });
  }

  function executionAwaitsDefinitionApproval(
    execution: GraphWorkflowExecution | null,
  ): execution is GraphWorkflowExecution {
    return (
      execution !== null &&
      !isTerminalStatus(execution.status) &&
      execution.definitionApproval !== null &&
      execution.definitionApproval.approvedAt === null
    );
  }

  /**
   * Whether the session's active execution is parked awaiting definition
   * approval — the only state a definition approval can unblock. Callers that
   * record their own admission before approving (e.g. the spec-side
   * execution-start grant) probe this first so a grant never lands with
   * nothing waiting.
   */
  async function hasPendingDefinitionApproval(input: {
    projectPath: string;
    sessionName: string;
    expectedDefinitionId?: string;
    expectedDefinitionRevision?: number;
  }): Promise<string | null> {
    const active = await deps.getActiveExecution(
      input.projectPath,
      input.sessionName,
    );
    const matches =
      executionAwaitsDefinitionApproval(active) &&
      (input.expectedDefinitionId === undefined ||
        active.seedDefinitionId === input.expectedDefinitionId) &&
      (input.expectedDefinitionRevision === undefined ||
        active.seedDefinitionRevision === input.expectedDefinitionRevision);
    return matches ? active.id : null;
  }

  /**
   * Non-HTTP definition-approval seam: records the approval on the session's
   * active execution and, on success, reports the started run through the
   * lifecycle port and engages the loop exactly like a gate-free START. The
   * HTTP handler and human-only server-side callers (e.g. the spec-side
   * execution-start grant) share this path so approval always starts the run
   * the same way. Before recording, the registered lifecycle consumer is
   * consulted so a definition it prepared gets its own execution-scoped
   * admission recorded (or the approval is refused machine-readably).
   */
  async function approveDefinition(input: {
    projectPath: string;
    projectName: string;
    sessionName: string;
    expectedExecutionId?: string;
    expectedDefinitionId?: string;
    expectedDefinitionRevision?: number;
  }): Promise<
    | RecordDefinitionApprovalResult
    | { ok: false; reason: "unavailable" }
    | {
        ok: false;
        reason: "gate_refused";
        refusal: Exclude<DefinitionApprovalGateDecision, { ok: true }>;
      }
  > {
    if (deps.recordDefinitionApproval === undefined) {
      return { ok: false, reason: "unavailable" };
    }
    const active = await deps.getActiveExecution(
      input.projectPath,
      input.sessionName,
    );
    if (
      executionAwaitsDefinitionApproval(active) &&
      input.expectedExecutionId !== undefined &&
      active.id !== input.expectedExecutionId
    ) {
      logger.warn("graph-workflow.definition_approval.guard_failed", {
        executionId: active.id,
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        reason: "execution_mismatch",
        expectedExecutionId: input.expectedExecutionId,
      });
      return { ok: false, reason: "execution_mismatch" };
    }
    if (
      executionAwaitsDefinitionApproval(active) &&
      input.expectedDefinitionId !== undefined &&
      active.seedDefinitionId !== input.expectedDefinitionId
    ) {
      logger.warn("graph-workflow.definition_approval.guard_failed", {
        executionId: active.id,
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        reason: "definition_mismatch",
        expectedDefinitionId: input.expectedDefinitionId,
        activeDefinitionId: active.seedDefinitionId,
      });
      return { ok: false, reason: "definition_mismatch" };
    }
    if (
      executionAwaitsDefinitionApproval(active) &&
      input.expectedDefinitionRevision !== undefined &&
      active.seedDefinitionRevision !== input.expectedDefinitionRevision
    ) {
      logger.warn("graph-workflow.definition_approval.guard_failed", {
        executionId: active.id,
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        reason: "definition_revision_mismatch",
        expectedDefinitionRevision: input.expectedDefinitionRevision,
        activeDefinitionRevision: active.seedDefinitionRevision,
      });
      return { ok: false, reason: "definition_revision_mismatch" };
    }
    if (deps.admitDefinitionApproval !== undefined) {
      if (executionAwaitsDefinitionApproval(active)) {
        const contractDecision = executionContract.validateDefinition(
          active.workingDefinition,
        );
        if (!contractDecision.ok) {
          logger.warn(
            "graph-workflow.definition_approval.execution_contract_rejected",
            {
              executionId: active.id,
              definitionId: active.seedDefinitionId,
              code: contractDecision.code,
              issueCount: contractDecision.issues.length,
            },
          );
        }
        assertGraphExecutionContractAccepted(contractDecision);
        const admitted = await deps.admitDefinitionApproval(
          {
            projectPath: input.projectPath,
            sessionName: input.sessionName,
          },
          active.id,
          active.seedDefinitionId,
          active.seedDefinitionRevision,
        );
        if (!admitted.ok) {
          return { ok: false, reason: "gate_refused", refusal: admitted };
        }
      }
    }
    const guardedExecutionId = executionAwaitsDefinitionApproval(active)
      ? active.id
      : input.expectedExecutionId;
    const result = await deps.recordDefinitionApproval({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      ...(guardedExecutionId === undefined
        ? {}
        : { expectedExecutionId: guardedExecutionId }),
      ...(input.expectedDefinitionId === undefined
        ? {}
        : { expectedDefinitionId: input.expectedDefinitionId }),
      ...(input.expectedDefinitionRevision === undefined
        ? {}
        : { expectedDefinitionRevision: input.expectedDefinitionRevision }),
    });
    if (!result.ok) return result;

    await markExecutionRunning(
      { projectPath: input.projectPath, sessionName: input.sessionName },
      result.execution,
    );
    void Promise.resolve()
      .then(() =>
        deps.kickOffExecutionLoop({
          projectPath: input.projectPath,
          projectName: input.projectName,
          sessionName: input.sessionName,
          execution: result.execution,
        }),
      )
      .catch(async (error) => {
        await reportExecutionLoopFailure({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          expectedExecutionId: result.execution.id,
          error,
          phase: "start",
        });
      });
    return result;
  }

  async function APPROVE_DEFINITION(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    // Definition approval is a human review act (the execution-start gate for
    // approval-required definitions). Agent transport is refused with the
    // machine-readable human_act_required code rather than silently admitted.
    const transport = await (
      deps.auth ?? createAgentAuth()
    ).validateOptionalToken(request);
    if (transport.kind === "invalid") {
      return NextResponse.json(
        { error: "Invalid Command Center API token" } satisfies ApiError,
        { status: 401 },
      );
    }
    if (transport.kind === "valid") {
      return NextResponse.json(
        {
          error: "Workflow definition approval is a human-only act",
          code: "human_act_required",
          instruction:
            "Approve the definition from the Command Center UI (Spec Studio or the session workflow page), not from an agent.",
        } satisfies ApiError & { code: string; instruction: string },
        { status: 403 },
      );
    }

    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }

    const approvalIdentitySchema = z
      .object({
        executionId: z.string().min(1),
        definitionId: z.string().min(1),
        definitionRevision: z.number().int().positive(),
      })
      .strict();
    const rawBody: unknown = await request.json().catch(() => null);
    const approvalIdentity = approvalIdentitySchema.safeParse(rawBody);
    if (!approvalIdentity.success) {
      return NextResponse.json(
        {
          error: `Invalid definition approval request: ${approvalIdentity.error.issues[0]?.message ?? "malformed body"}`,
          code: "invalid_request",
        } satisfies ApiError & { code: string },
        { status: 400 },
      );
    }

    let result: Awaited<ReturnType<typeof approveDefinition>>;
    try {
      result = await approveDefinition({
        projectPath: resolved.projectPath,
        projectName: resolved.projectName,
        sessionName: resolved.sessionName,
        expectedExecutionId: approvalIdentity.data.executionId,
        expectedDefinitionId: approvalIdentity.data.definitionId,
        expectedDefinitionRevision: approvalIdentity.data.definitionRevision,
      });
    } catch (error) {
      return respondToManagerError(error);
    }

    if (!result.ok) {
      if (result.reason === "unavailable") {
        return NextResponse.json(
          { error: "Definition approval is not available" } satisfies ApiError,
          { status: 501 },
        );
      }
      if (result.reason === "no_active_execution") {
        return notFound(
          "Session does not have an active graph workflow execution",
        );
      }
      if (result.reason === "gate_refused") {
        return NextResponse.json(
          {
            error: result.refusal.unmetConditions.join(" "),
            code: result.refusal.code,
            unmetConditions: result.refusal.unmetConditions,
            instruction: result.refusal.instruction,
          } satisfies ApiError & {
            code: string;
            unmetConditions: string[];
            instruction: string;
          },
          { status: 409 },
        );
      }
      return NextResponse.json(
        {
          error:
            result.reason === "already_decided"
              ? "The pending workflow definition is already approved (already_decided)"
              : result.reason === "execution_mismatch"
                ? "The active workflow execution changed before approval (execution_mismatch)"
                : result.reason === "definition_mismatch"
                  ? "The active workflow definition changed before approval (definition_mismatch)"
                  : result.reason === "definition_revision_mismatch"
                    ? "The active workflow definition revision changed before approval (definition_revision_mismatch)"
                    : "The active execution is not awaiting definition approval (not_awaiting_approval)",
          code: result.reason,
        } satisfies ApiError & { code: string },
        { status: 409 },
      );
    }

    return NextResponse.json({
      execution: summarizeExecution(result.execution, false),
    });
  }

  async function CLEAR(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }

    const activeExecution = await deps.getActiveExecution(
      resolved.projectPath,
      resolved.sessionName,
    );
    if (!activeExecution || !isTerminalStatus(activeExecution.status)) {
      return NextResponse.json(
        {
          error:
            "Only completed, halted, or aborted graph workflow executions can be cleared",
        } satisfies ApiError,
        { status: 409 },
      );
    }

    // Backstop: stop any lane dev servers that survived prior cleanup before
    // the terminal execution (and its lane references) is archived away.
    await deps.stopExecutionLaneDevServers?.({
      execution: activeExecution,
      projectPath: resolved.projectPath,
    });
    await deps.archiveExecution(resolved.projectPath, resolved.sessionName);
    return NextResponse.json({ cleared: true });
  }

  return {
    START,
    launch,
    STATUS,
    EXECUTION,
    HISTORY,
    EVENTS,
    PAUSE,
    RESUME,
    ABORT,
    RESET_CONTEXT,
    RESET_ASSIGNMENT,
    RESOLVE_APPROVAL,
    APPROVE_DEFINITION,
    approveDefinition,
    hasPendingDefinitionApproval,
    CLEAR,
  };
}

/**
 * Launch a graph workflow run through the production start+kickoff seam,
 * reusing the same singletons (workflow manager, execution loop) as the HTTP
 * START handler. The MCP `start_graph_workflow` tool wires `startWorkflow` to
 * this so an agent launch behaves exactly like a human launch. The `deps`
 * parameter keeps the seam unit-testable.
 */
export async function launchGraphWorkflowExecution(
  input: {
    projectPath: string;
    projectName: string;
    sessionName: string;
    definitionId: string;
    expectedDefinitionRevision?: number;
    tier?: "project" | "global";
    parameters?: Record<string, unknown>;
  },
  deps: GraphWorkflowExecutionRouteDeps = defaultDeps,
): Promise<GraphWorkflowExecution> {
  return createGraphWorkflowExecutionRouteHandlers(deps).launch(input);
}

const defaultGraphWorkflowExecutionHandlers =
  createGraphWorkflowExecutionRouteHandlers();

/**
 * Approve the session's pending workflow definition and start the run through
 * the production seam (workflow manager + execution loop singletons) without
 * HTTP transport. Human-only server-side flows — e.g. the spec-side
 * execution-start gate grant, which records the human approval before calling
 * this — use it so definition approval always engages the same lifecycle-port
 * report and loop kickoff as the HTTP handler. Callers own the human-act
 * enforcement.
 */
export async function approveGraphWorkflowDefinitionForSession(input: {
  projectPath: string;
  projectName: string;
  sessionName: string;
  workflowExecutionId: string;
  definitionId: string;
  definitionRevision: number;
}): Promise<
  | RecordDefinitionApprovalResult
  | { ok: false; reason: "unavailable" }
  | {
      ok: false;
      reason: "gate_refused";
      refusal: Exclude<DefinitionApprovalGateDecision, { ok: true }>;
    }
> {
  return defaultGraphWorkflowExecutionHandlers.approveDefinition({
    ...input,
    expectedExecutionId: input.workflowExecutionId,
    expectedDefinitionId: input.definitionId,
    expectedDefinitionRevision: input.definitionRevision,
  });
}

/**
 * Whether the session's active graph workflow execution is parked awaiting
 * definition approval, through the production singletons. Server-side callers
 * that record their own admission before approving (the spec-side
 * execution-start grant) probe this so a grant never lands with nothing
 * waiting to unblock.
 */
export async function sessionHasPendingWorkflowDefinitionApproval(input: {
  projectPath: string;
  sessionName: string;
  definitionId: string;
  definitionRevision: number;
}): Promise<string | null> {
  return defaultGraphWorkflowExecutionHandlers.hasPendingDefinitionApproval({
    projectPath: input.projectPath,
    sessionName: input.sessionName,
    expectedDefinitionId: input.definitionId,
    expectedDefinitionRevision: input.definitionRevision,
  });
}

export const startGraphWorkflowExecution = withTracing(
  defaultGraphWorkflowExecutionHandlers.START,
);
export const getGraphWorkflowExecutionStatus = withTracing(
  defaultGraphWorkflowExecutionHandlers.STATUS,
);
export const getGraphWorkflowExecutionFull = withTracing(
  defaultGraphWorkflowExecutionHandlers.EXECUTION,
);
export const getGraphWorkflowExecutionHistory = withTracing(
  defaultGraphWorkflowExecutionHandlers.HISTORY,
);
export const getGraphWorkflowExecutionEvents = withTracing(
  defaultGraphWorkflowExecutionHandlers.EVENTS,
);
export const pauseGraphWorkflowExecution = withTracing(
  defaultGraphWorkflowExecutionHandlers.PAUSE,
);
export const resumeGraphWorkflowExecution = withTracing(
  defaultGraphWorkflowExecutionHandlers.RESUME,
);
export const abortGraphWorkflowExecution = withTracing(
  defaultGraphWorkflowExecutionHandlers.ABORT,
);
export const resetGraphWorkflowExecutionContext = withTracing(
  defaultGraphWorkflowExecutionHandlers.RESET_CONTEXT,
);
export const resetGraphWorkflowExecutionAssignment = withTracing(
  defaultGraphWorkflowExecutionHandlers.RESET_ASSIGNMENT,
);
export const resolveGraphWorkflowApproval = withTracing(
  defaultGraphWorkflowExecutionHandlers.RESOLVE_APPROVAL,
);
export const approveGraphWorkflowDefinition = withTracing(
  defaultGraphWorkflowExecutionHandlers.APPROVE_DEFINITION,
);
export const clearGraphWorkflowExecution = withTracing(
  defaultGraphWorkflowExecutionHandlers.CLEAR,
);
