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
import {
  awaitsDefinitionApproval,
  holdsExecutionLease,
} from "@/lib/workflow-graph/lifecycle-classifier";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import {
  getSession as defaultGetSession,
  getActiveGraphWorkflowExecution,
  mutateActiveGraphWorkflowExecution,
  reserveActiveGraphWorkflowExecution,
  archiveActiveGraphWorkflowExecution,
  markGraphWorkflowContextEventsPreReset,
  getGraphWorkflowPendingArtifacts,
  clearGraphWorkflowPendingArtifacts,
  findLatestGraphWorkflowContextEvent,
  listActiveGraphWorkflowExecutions,
  listArchivedGraphWorkflowExecutions,
  getGraphWorkflowEventsPage,
  getGraphWorkflowEventsTail,
  getGraphWorkflowExecutionById as defaultGetGraphWorkflowExecutionById,
  getGraphWorkflowBoundaryResultAfter as defaultGetGraphWorkflowBoundaryResultAfter,
} from "@/lib/state-store";
import { createLaneService } from "@/lib/workflows/primitives/lane-service";
import { createGraphLaneStore } from "@/lib/workflow-graph/graph-lane-store";
import { resyncSharedIndexToHead } from "@/lib/git/shared-index";
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
  GraphWorkflowAbandonment,
  GraphWorkflowExecutionActReceipt,
  GraphWorkflowExecutionOrigin,
  GraphWorkflowExecution,
  GraphWorkflowExecutionJoinKind,
  GraphWorkflowExecutionJoinStatus,
  GraphWorkflowHaltReason,
  GraphWorkflowLaunchReceipt,
} from "@/lib/workflow-graph/schemas";
import { assertNever } from "@/lib/shared/assert-never";
import type { GraphWorkflowStatus } from "@/lib/workflow-graph/definition-schemas";
import type { SeededWorkflowDocument } from "@/lib/workflow-graph/shared-documents";
import type { GraphWorkflowArchiveOutcome } from "@/lib/state-store/setters";
import { dispatchPushForGraphWorkflowEvent } from "@/lib/push-notification/dispatcher";
import {
  createAgentAuth,
  type OptionalTokenValidation,
} from "@/lib/agent-gateway/token";
import type { ConversationCapabilityVerification } from "@/lib/agent-gateway/conversation-capability";
import type { LaneCapabilityVerification } from "@/lib/agent-gateway/lane-capability";
import { authorizeWorkflowLaunch } from "./request-principal";
import {
  classifyRoutePrincipal,
  guardExecutionMutation,
  guardHumanOnlyAct,
  invalidTokenResponse,
  runPinnedMutation,
} from "./mutation-guard";
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
  type IterationOrchestratorValidationRoundService,
} from "@/lib/workflow-graph/iteration-orchestrator";
import {
  createGraphWorkflowManager,
  GraphWorkflowTransitionConflictError,
  WorkflowDefinitionApprovalRequiredError,
  WorkflowDefinitionRevisionMismatchError,
  WorkflowPrerequisitesUnmetError,
  WorkflowStartGuardError,
  WorkflowStartInputError,
  interruptedDefinitionDecision,
  type AbandonExecutionInput,
  type AbandonExecutionResult,
  type RecordPendingHaltReasonInput,
  type RecordPendingHaltReasonResult,
  type RecordDefinitionApprovalInput,
  type RecordDefinitionApprovalResult,
  type ClaimDefinitionApprovalInput,
  type ClaimDefinitionApprovalResult,
  type ReleaseDefinitionApprovalClaimInput,
  type ReleaseDefinitionApprovalClaimResult,
  type RejectDefinitionResult,
  type DrainAndHaltInput,
  type GraphWorkflowLaunchOutcome,
  type GraphWorkflowResumeOptions,
} from "@/lib/workflow-graph/workflow-manager";
import type { WorkflowPlanIssue } from "@/lib/workflows/plan-validation";
import { readRepoConfig as defaultReadRepoConfig } from "@/lib/projects/repo-config";
import { buildGraphWorkflowExecutionDeepLink } from "./execution-deep-link";
import type { GraphWorkflowBoundaryResultProjection } from "./execution-result-projection";
import type { WorkflowDefinitionDraft } from "./storage";
import type { GlobalConfig, PerRepoConfig } from "@/lib/config/schemas";
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
import { computeCandidateTreeHash, type CandidateScope } from "@/lib/git/diff";
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
import { createExecutionTargetResolver } from "./execution-target-resolver";
import { createGraphWorkflowSignalHaltHandler } from "./graph-workflow-signal-halt";
import {
  createApprovalGateService,
  type ApprovalGateDecisionInput,
  type RecordDecisionGuardFailureReason,
  type RecordDecisionInput,
  type RecordDecisionResult,
} from "./approval-gate";
import {
  resolveApprovalSnapshot,
  type ApprovalSnapshotResolution,
  type ResolveApprovalSnapshotInput,
} from "./approval-snapshot";
import { createSoloContextCommitter } from "./solo-context-committer";
import { createLaneCommitter } from "./lane-committer";
import { createJoinRunner } from "./join-runner";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  assertGraphExecutionContractAccepted,
  createRegisteredGraphExecutionContract,
  GraphExecutionContractViolationError,
} from "./execution-contract-port";
import { admitAuthoredWorkflowLaunch } from "./authored-launch-admission";

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

/**
 * The inline launch body (D7 R1, decision D1): the plan document in the exact
 * dialect `workflow validate`/`create` accept, plus a SEPARATE inputs document.
 *
 * `plan` stays `unknown` here on purpose — `validateWorkflowPlan` owns the
 * accept-time parse, and a second Zod shape at this boundary would be a second
 * place for the dialect to drift. This schema only proves the two documents
 * arrived in their own channels, which is what keeps `run --file` and
 * `start --file` from meaning two different things.
 */
const runExecutionSchema = z.object({
  plan: z.unknown().refine((value) => value !== undefined, {
    message: "plan is required",
  }),
  inputs: z.record(z.string(), z.unknown()).optional(),
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
  reserveActiveGraphWorkflowExecution,
  archiveActiveGraphWorkflowExecution,
  markGraphWorkflowContextEventsPreReset,
  getGraphWorkflowPendingArtifacts,
  clearGraphWorkflowPendingArtifacts,
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
  async resolveWorktreePath(projectPath, sessionName) {
    const session = await defaultGetSession(projectPath, sessionName);
    if (!session) throw new Error("Session not found");
    return session.worktreePath;
  },
  async resolveTimeoutMs(backend) {
    const config = await readConfig();
    return resolveConfiguredAgentBackendDefaults(config, backend).timeoutMs;
  },
});
const advisoryResponseRunner = createGraphWorkflowAdvisoryResponseRunner({
  async resolveWorktreePath(projectPath, sessionName) {
    const session = await defaultGetSession(projectPath, sessionName);
    if (!session) throw new Error("Session not found");
    return session.worktreePath;
  },
  async resolveTimeoutMs(backend) {
    const config = await readConfig();
    return resolveConfiguredAgentBackendDefaults(config, backend).timeoutMs;
  },
});
const validationService = createGraphWorkflowValidationService({
  runContextValidator: validatorRunner.runContextValidator,
  renderRoundCommonSections: validatorRunner.renderRoundCommonSections,
});

export interface GraphWorkflowRouteValidationRoundServiceDeps {
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  /** The base commit the patch is read against; null when git cannot answer. */
  readHeadSha(worktreePath: string): Promise<string | null>;
  /** The candidate's identity under `scope`; null when it cannot be read. */
  computeCandidateIdentity(
    worktreePath: string,
    scope: CandidateScope,
  ): Promise<string | null>;
}

/**
 * Resolves a validation round's candidate identity from the worktree the cohort
 * will inspect: the per-context target when the context is worktree-isolated,
 * the session worktree otherwise.
 *
 * The identity is read under the caller's candidate scope, and the scope is
 * reported back as part of the resolution. The caller owns the scope because only
 * it knows the reviewed context's placement; this service owns reading it, so the
 * freeze and every later re-read go through one implementation and cannot differ
 * in how they computed the same thing.
 *
 * A failure is reported as `unavailable` with its reason, never as a partial
 * identity. The engine treats an unreadable candidate as an infrastructure
 * outcome — a round that cannot name what it reviewed cannot certify it — so
 * degrading to "some components are missing" here would let a semantic verdict be
 * published on a candidate nobody could pin down.
 */
export function createGraphWorkflowRouteValidationRoundService(
  deps: GraphWorkflowRouteValidationRoundServiceDeps,
): IterationOrchestratorValidationRoundService {
  return {
    async resolveCandidateTree(
      input,
    ): Promise<ValidationCandidateTreeResolution> {
      const worktreePath =
        input.executionTarget?.worktreePath ??
        (await deps.getSession(input.projectPath, input.sessionName))
          ?.worktreePath;
      if (worktreePath === undefined) {
        return {
          kind: "unavailable",
          reason: `no worktree resolved for session "${input.sessionName}"`,
        };
      }

      const [head, candidateTreeHash] = await Promise.all([
        deps.readHeadSha(worktreePath),
        deps.computeCandidateIdentity(worktreePath, input.candidateScope),
      ]);

      if (head === null || candidateTreeHash === null) {
        return {
          kind: "unavailable",
          reason: `git could not resolve ${head === null ? "HEAD" : "the candidate tree"} in ${worktreePath}`,
        };
      }

      return {
        kind: "resolved",
        identityScope:
          input.candidateScope.mode === "wholeTree" ? "wholeTree" : "owned",
        headSha: head,
        candidateTreeHash,
      };
    },
  };
}

const validationRoundService = createGraphWorkflowRouteValidationRoundService({
  getSession: defaultGetSession,
  readHeadSha: (worktreePath) =>
    defaultGitClient
      .git(["rev-parse", "HEAD"], worktreePath)
      .then((result) => result.stdout.trim() || null)
      .catch(() => null),
  computeCandidateIdentity: (worktreePath, scope) =>
    computeCandidateTreeHash(worktreePath, scope),
});
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
  findLatestContextValidationEvent: (
    projectPath,
    sessionName,
    executionId,
    contextId,
  ) =>
    findLatestGraphWorkflowContextEvent(
      projectPath,
      sessionName,
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
      modelSelection: input.modelSelection,
      toolServer: input.toolServer,
      executionTarget: input.executionTarget,
      askUserQuestionsEnabled: input.askUserQuestionsEnabled,
      placement: input.placement,
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
  resyncSharedIndex: resyncSharedIndexToHead,
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
  resumeExecution: async ({
    projectPath,
    sessionName,
    projectName,
    executionId,
  }) => {
    // Fenced on the round's execution: normalize/resume/kick all address the
    // session, and the run this repair examined may have been abandoned and
    // replaced while its agent turn was open. Normalization is fenced FIRST
    // because it is the step with side effects — it rewrites artifacts into the
    // worktree and rewrites the running state — so an unfenced normalize has
    // already touched the successor by the time the resume behind it refuses.
    await workflowManager.normalizeAfterRestart(projectPath, sessionName, {
      expectedExecutionId: executionId,
    });
    // The manager raises a transition conflict rather than resuming the
    // successor, which the supervisor records as an unresumed round. No human
    // is in this loop, so the resume declares itself automatic and the manager
    // refuses halts only restored capacity can clear.
    const execution = await workflowManager.resume(projectPath, sessionName, {
      expectedExecutionId: executionId,
      initiator: "system",
    });
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
  getValidationHistory: async (
    projectPath,
    sessionName,
    executionId,
    contextId,
  ) => {
    const rows = await getGraphWorkflowEventsTail(
      projectPath,
      sessionName,
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
  /**
   * Wall clock for the one question this layer asks of time: whether a
   * definition decision has been reserved long enough that its holder is no
   * longer plausibly live. Defaults to the real clock.
   */
  now?(): string;
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
    ownerConversationId?: string | null;
    seededDocuments?: readonly SeededWorkflowDocument[];
  }): Promise<GraphWorkflowLaunchOutcome>;
  /**
   * The inline (`workflow run`) launch, riding the SAME manager gauntlet as
   * `startExecution` with a one-off source (D7 R1, R2). It receives the plan
   * already parsed by the accept-time gate, never the raw request body.
   */
  runExecution(input: {
    projectPath: string;
    sessionName: string;
    plan: WorkflowDefinitionDraft;
    inputs?: Record<string, unknown>;
    ownerConversationId?: string | null;
  }): Promise<GraphWorkflowLaunchOutcome>;
  /**
   * The native-SDD spec-delivery launch, riding the SAME manager gauntlet with
   * a `spec_delivery` source. It receives the signed candidate's launch
   * document (admitted at proposal, TOCTOU-rechecked by the gauntlet) plus the
   * spec bridge's atomic attachment. In-process only — no HTTP transport.
   */
  launchSpecDeliveryExecution(input: {
    projectPath: string;
    sessionName: string;
    definitionId: string;
    expectedDefinitionRevision: number;
    specSlug: string;
    candidateId: string;
    inputs?: Record<string, unknown>;
    ownerConversationId?: string | null;
    seededDocuments?: readonly SeededWorkflowDocument[];
    transactionAttachment?: (input: { executionId: string }) => void;
  }): Promise<GraphWorkflowLaunchOutcome>;
  /**
   * `CommandCenter.json` and the global config, read per RUN request so the
   * inline plan is preflighted against the command registry and capacity the
   * launch will actually use — the same reads `workflow validate` and
   * `workflow create` perform. Optional so a test can drive RUN without a
   * project on disk.
   */
  readRepoConfig?(projectPath: string): Promise<PerRepoConfig | null>;
  readConfig?(): Promise<GlobalConfig>;
  markRunning?(
    context: GraphExecutionLifecycleContext,
    workflowExecutionId: string,
    origin?: GraphWorkflowExecutionOrigin,
  ): Promise<void>;
  /**
   * Reports an execution that started but parked awaiting definition
   * approval, so the registered lifecycle consumer can open its own review
   * request for the pending definition. Defaults to the registered port.
   */
  awaitingDefinitionApproval?(
    context: GraphExecutionLifecycleContext,
    workflowExecutionId: string,
    origin: GraphWorkflowExecutionOrigin,
  ): Promise<void>;
  /**
   * Classifies the signed conversation capability a launch presents (D11), from
   * which the origin principal is derived. Defaults to the registered verifier,
   * keyed on the server-only capability key.
   */
  verifyConversationCapability?(
    request: Request,
  ): Promise<ConversationCapabilityVerification>;
  /**
   * Classifies the signed lane capability a caller presents (D4 R7). A lane may
   * act on its OWN execution and is refused as nesting when it tries to launch,
   * so the mutation guard has to be able to tell a lane from an ordinary
   * conversation. Defaults to the registered verifier, keyed on the same
   * server-only capability key.
   */
  verifyLaneCapability?(request: Request): Promise<LaneCapabilityVerification>;
  /**
   * Consulted before a pending definition approval is recorded so the
   * registered lifecycle consumer can record its own execution-scoped
   * admission for work it prepared, or refuse with a machine-readable reason.
   * Consulted for every parked run whatever its origin. Defaults to the
   * registered port (admit when nobody claims it).
   *
   * A REFUSAL MUST BE WRITE-FREE. It is answered by handing the reservation
   * back, which reopens the park to a rejection or an abort, so a consumer that
   * has already committed anything durable may not report it as a refusal — it
   * throws instead, and the reservation is kept for a settlement that finishes
   * the saga forward. Idempotence is what makes that re-offer safe.
   */
  admitDefinitionApproval?(
    context: GraphExecutionLifecycleContext,
    workflowExecutionId: string,
    origin: GraphWorkflowExecutionOrigin,
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
  /**
   * Write the abandonment audit on the identified resumably halted lease
   * holder. Relocating the run into History stays with the route, which owns
   * the resource teardown that must precede it.
   */
  abandonExecution?(
    input: AbandonExecutionInput,
  ): Promise<AbandonExecutionResult>;
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
  /**
   * `audit` is present for an explicit, audited release act (abandon, the
   * definition rejection); absent for internal auto-release, which is not a
   * human act and has nothing to attribute.
   */
  archiveExecution(
    projectPath: string,
    sessionName: string,
    audit?: { reason: string; actor: string | null },
    /**
     * Re-applied inside the archive's own critical section against the row as
     * it is at that moment, so an eligibility or expected-id decision made out
     * here cannot be invalidated by a concurrent resume or slot turnover.
     * Must be pure.
     */
    guard?: (execution: GraphWorkflowExecution) => boolean,
  ): Promise<GraphWorkflowArchiveOutcome>;
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
  /** Find a named execution in Current first, then History, under full scope. */
  getExecutionById?(
    projectPath: string,
    sessionName: string,
    executionId: string,
  ): Promise<GraphWorkflowExecution | null>;
  /** Return the first durable boundary result after an opaque event cursor. */
  getBoundaryResultAfter?(
    projectPath: string,
    sessionName: string,
    executionId: string,
    cursor?: number | null,
  ): Promise<GraphWorkflowBoundaryResultProjection | null>;
  recordPendingHaltReason(
    input: RecordPendingHaltReasonInput,
  ): Promise<RecordPendingHaltReasonResult>;
  drainAndHalt(input: DrainAndHaltInput): Promise<GraphWorkflowExecution>;
  recordApprovalDecision(
    input: RecordDecisionInput,
  ): Promise<RecordDecisionResult>;
  /**
   * The change set the human approval surface renders for one parked context.
   * Optional so a test can exercise the route without git; defaults to the real
   * scoped reader.
   */
  resolveApprovalSnapshot?(
    input: ResolveApprovalSnapshotInput,
  ): Promise<ApprovalSnapshotResolution>;
  /**
   * Approve the pending workflow definition on the session's active execution
   * (the definition-review gate for approval-required definitions). Defaults
   * to the workflow manager's atomic first-approval-wins recording.
   */
  recordDefinitionApproval?(
    input: RecordDefinitionApprovalInput,
  ): Promise<RecordDefinitionApprovalResult>;
  /**
   * Reserve the park's decision for this act without deciding it — the
   * approval saga's arbiter. Defaults to the manager's serialized claim act.
   */
  claimDefinitionApproval?(
    input: ClaimDefinitionApprovalInput,
  ): Promise<ClaimDefinitionApprovalResult>;
  /**
   * Hand an unadmitted reservation back so the park is decidable again.
   * Defaults to the manager's serialized release act.
   */
  releaseDefinitionApprovalClaim?(
    input: ReleaseDefinitionApprovalClaimInput,
  ): Promise<ReleaseDefinitionApprovalClaimResult>;
  /**
   * The human's other decision at the same gate: end the parked run instead of
   * admitting it. Defaults to the workflow manager's serialized reject act.
   */
  rejectDefinition?(input: {
    projectPath: string;
    sessionName: string;
    executionId: string;
  }): Promise<RejectDefinitionResult>;
  /**
   * Transport identity for the definition-approval gate. Approving and
   * rejecting a definition are human review acts: requests bearing a valid
   * agent token are refused with `human_act_required`. Defaults to the shared
   * agent-gateway auth.
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
    projectPath: string,
    sessionName: string,
    executionId: string,
    limit: number,
  ): Promise<GraphWorkflowExecutionEvent[]>;
  /**
   * Read one cursor-paginated page of an execution's event log — the reader the
   * loop-ledger surfaces walk for COMPLETE history, which the bounded tail
   * cannot serve. Defaults to the real `graph_workflow_events` repo.
   */
  getEventsPage?(
    projectPath: string,
    sessionName: string,
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
  runExecution: (input) => workflowManager.run(input),
  launchSpecDeliveryExecution: (input) =>
    workflowManager.launchSpecDelivery(input),
  readRepoConfig: defaultReadRepoConfig,
  readConfig,
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
  claimDefinitionApproval: (input) =>
    workflowManager.claimDefinitionApproval(input),
  releaseDefinitionApprovalClaim: (input) =>
    workflowManager.releaseDefinitionApprovalClaim(input),
  rejectDefinition: (input) => workflowManager.rejectDefinition(input),
  pauseExecution: (projectPath, sessionName) =>
    workflowManager.send(projectPath, sessionName, { type: "pause" }),
  resumeExecution: (projectPath, sessionName, options) =>
    workflowManager.resume(projectPath, sessionName, options),
  abortExecution: (projectPath, sessionName) =>
    workflowManager.send(projectPath, sessionName, { type: "abort" }),
  abandonExecution: (input) => workflowManager.abandon(input),
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
  archiveExecution: (projectPath, sessionName, audit, guard) =>
    executionRepository.archiveActive(projectPath, sessionName, audit, guard),
  async kickOffExecutionLoop(input) {
    await runExecutionLoopWithPlanRepair(input);
  },
  getActiveExecution: (projectPath, sessionName) =>
    workflowManager.getActive(projectPath, sessionName),
  getExecutionById: (projectPath, sessionName, executionId) =>
    defaultGetGraphWorkflowExecutionById(projectPath, sessionName, executionId),
  getBoundaryResultAfter: (projectPath, sessionName, executionId, cursor) =>
    defaultGetGraphWorkflowBoundaryResultAfter(
      projectPath,
      sessionName,
      executionId,
      cursor,
    ),
  recordPendingHaltReason: (input) =>
    workflowManager.recordPendingHaltReason(input),
  drainAndHalt: (input) => workflowManager.drainAndHalt(input),
  recordApprovalDecision: (input) => approvalGateService.recordDecision(input),
  resolveApprovalSnapshot: (input) => resolveApprovalSnapshot(input),
  auth: createAgentAuth(),
  listArchivedExecutions: (projectPath, sessionName) =>
    listArchivedGraphWorkflowExecutions(projectPath, sessionName),
  getEventsTail: (projectPath, sessionName, executionId, limit) =>
    getGraphWorkflowEventsTail(projectPath, sessionName, executionId, limit),
  getEventsPage: (projectPath, sessionName, executionId, query) =>
    getGraphWorkflowEventsPage(projectPath, sessionName, executionId, query),
  stopExecutionLaneDevServers: (input) =>
    defaultStopExecutionLaneDevServers(input),
};

/**
 * Header the token-gated CLI/agent surfaces use to name the calling
 * conversation (`cctl` sends it from `CC_CONVERSATION_ID`).
 *
 * It carries NO authority and nothing here reads it. Ownership and every
 * mutation principal are derived from a signed capability instead
 * (`request-principal.ts`), because confirming a claimed id belongs to the
 * session only proves the conversation exists — every sibling passes that
 * check. The constant remains because agent transports still send the header
 * as context; treating it as identity again is the regression to avoid.
 */
export const OWNER_CONVERSATION_HEADER = "x-cc-conversation-id";

/** `live abort`'s optional body: the reason is carried onto the release audit row. */
const abortExecutionSchema = z.object({
  reason: z.string().trim().min(1).optional(),
  actor: z.string().min(1).nullable().optional(),
});

/**
 * `workflow abandon`'s body. Strict and execution-addressed: an act that named
 * a definition could not express a one-off run, which has no saved definition
 * identity at all, and would let a caller abandon "whatever this template is
 * running" instead of the run they read.
 */
const abandonExecutionSchema = z
  .object({
    executionId: z.string().trim().min(1),
    reason: z.string().trim().min(1),
  })
  .strict();

/**
 * The body BOTH definition decisions carry (D7 decision D17). Strict and
 * execution-addressed: a one-off park has no saved-definition identity to
 * co-guard with, and a template park's definition identity is already pinned by
 * the immutable snapshot the execution holds — so a definition id in either act
 * would be a second, origin-conditional meaning for the same decision.
 */
const definitionDecisionIdentitySchema = z
  .object({ executionId: z.string().trim().min(1) })
  .strict();

/**
 * Why an abandon was declined, in the operator's terms. Each message names the
 * act that DOES apply, because every refusal here means the caller's mental
 * model of the run's tenure is stale in a specific, correctable way.
 */
function abandonRefusalMessage(
  requestedExecutionId: string,
  refusal: Exclude<AbandonExecutionResult, { ok: true }>,
): string {
  switch (refusal.reason) {
    case "no_active_execution":
      return `This session owns no graph workflow execution, so ${requestedExecutionId} cannot be abandoned. Re-check with 'cctl workflow status'.`;
    case "execution_mismatch":
      return `Execution ${requestedExecutionId} does not hold this session's execution lease; ${refusal.activeExecutionId} does. Re-check with 'cctl workflow status', then abandon the run you mean.`;
    case "not_lease_holding_halt":
      return refusal.abandoned
        ? `Execution ${requestedExecutionId} was already abandoned and belongs to History.`
        : refusal.status === "halted"
          ? `Execution ${requestedExecutionId} halted for a reason that cannot be resumed, so it already belongs to History and holds no lease.`
          : `A ${refusal.status} graph workflow execution cannot be abandoned. Abort it with 'cctl workflow live abort --reason <reason>' instead.`;
    default:
      return assertNever(refusal, "unhandled abandon refusal");
  }
}

function rejectDefinitionRefusalMessage(
  requestedExecutionId: string,
  refusal: Exclude<RejectDefinitionResult, { ok: true }>,
): string {
  switch (refusal.reason) {
    case "no_active_execution":
      return `This session owns no graph workflow execution, so ${requestedExecutionId} cannot be rejected. Re-check with 'cctl workflow status'.`;
    case "execution_mismatch":
      return `Execution ${requestedExecutionId} does not hold this session's execution lease; ${refusal.activeExecutionId} does. Re-check with 'cctl workflow status', then decide on the run you mean.`;
    case "not_awaiting_approval":
      return `A ${refusal.status} graph workflow execution is not awaiting definition approval, so there is no definition decision to make. Abort it with 'cctl workflow live abort --reason <reason>' instead.`;
    case "decision_in_flight":
      return `An approval is already deciding execution ${requestedExecutionId}. Wait for it to settle, then re-check with 'cctl workflow status'.`;
    default:
      return assertNever(refusal, "unhandled definition rejection refusal");
  }
}

/**
 * Project an accepted launch into the wire receipt (D7 R1.2).
 *
 * Both launch verbs answer with this one shape, and it is built from the
 * execution's recorded origin rather than from the seed projection — which on a
 * one-off run names a definition that does not exist.
 */
function buildLaunchReceipt(input: {
  outcome: GraphWorkflowLaunchOutcome;
  projectName: string;
  sessionName: string;
  warnings?: readonly WorkflowPlanIssue[];
}): GraphWorkflowLaunchReceipt {
  const { execution } = input.outcome;
  const warnings = input.warnings ?? input.outcome.warnings ?? [];
  return {
    executionId: execution.id,
    status: input.outcome.awaitingDefinitionApproval
      ? "awaiting_definition_approval"
      : "running",
    origin: execution.origin,
    originConversationId: execution.ownerConversationId,
    deepLink: buildGraphWorkflowExecutionDeepLink({
      projectName: input.projectName,
      sessionName: input.sessionName,
      executionId: execution.id,
    }),
    startedAt: execution.startedAt,
    ...(warnings.length === 0 ? {} : { warnings: [...warnings] }),
  };
}

/**
 * Project the outcome of an execution-addressed lifecycle act into its wire
 * receipt (D7 R4.1, R14.2).
 *
 * Abandon, approve, and reject answer with this one shape rather than the
 * execution summary, which carries the definition tier the summary's History
 * and status callers need — and which on a one-off run is compatibility filler
 * naming a definition that does not exist.
 */
function buildExecutionActReceipt(
  execution: GraphWorkflowExecution,
  archived: boolean,
): GraphWorkflowExecutionActReceipt {
  return {
    executionId: execution.id,
    status: execution.status,
    origin: execution.origin,
    archived,
  };
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

  // History is a LEASE projection, not a storage location (D7 decision D4): a
  // lease-free run still sitting in the active row belongs here — normalization
  // has not yet relocated it, and R3.3 requires no explicit act to make it
  // historical. A terminal-but-resumable halt is deliberately excluded: it is
  // still Current until it is resumed or abandoned.
  const active = await deps.getActiveExecution(projectPath, sessionName);
  if (
    active &&
    !holdsExecutionLease(active.status, active.haltReason, active.abandonment)
  ) {
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

/**
 * Why an approval was declined, in the operator's terms. Each message says
 * what changed under the reviewer, because every refusal here means the park
 * they were looking at is no longer the park they are deciding.
 */
function definitionApprovalRefusalMessage(
  reason:
    | "not_awaiting_approval"
    | "already_decided"
    | "execution_mismatch"
    | "decision_in_flight"
    | "not_reserved"
    | "claim_superseded",
): string {
  switch (reason) {
    case "already_decided":
      return "The pending workflow definition is already approved (already_decided)";
    case "execution_mismatch":
      return "The active workflow execution changed before approval (execution_mismatch)";
    case "decision_in_flight":
      return "Another approval or rejection is already deciding this workflow definition (decision_in_flight)";
    case "not_reserved":
      return "The approval was no longer reserved when it went to record (not_reserved)";
    case "claim_superseded":
      return "This approval's reservation was reclaimed and another act now holds the decision (claim_superseded)";
    case "not_awaiting_approval":
      return "The active execution is not awaiting definition approval (not_awaiting_approval)";
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

/**
 * The body field each launch verb carries its bound parameters in. A located
 * input issue has to point at what the caller actually sent, and the two verbs
 * deliberately name that document differently — `start` takes `parameters`,
 * `run` takes a separate `inputs` document beside the plan — so the root is
 * passed in rather than guessed.
 */
type LaunchInputPathRoot = "parameters" | "inputs";

/**
 * Locate a launch-input refusal in the request body (R1.3).
 *
 * The refusal speaks the same `{code, issues:[{path, message}]}` dialect
 * `validateWorkflowPlan` already returns, so a caller parses one refusal shape
 * for a plan that fails validation and for an input that fails binding. The
 * parameter name is a plain object key in the submitted document, which is why
 * the path is the root joined to the name rather than a re-derived JSON path.
 */
function locateLaunchInputIssue(
  error: WorkflowStartInputError,
  root: LaunchInputPathRoot,
): { code: string; issues: WorkflowPlanIssue[] } {
  return {
    code: error.inputError.kind,
    issues: [
      { path: `${root}.${error.inputError.name}`, message: error.message },
    ],
  };
}

/**
 * THE launch-refusal mapping, shared by both launch transports (D7 R2).
 *
 * Every pre-seed refusal a launch can raise resolves to one response here, so
 * `workflow start` and `workflow run` cannot answer the same guard differently.
 * Each of these rejections seeds nothing, which is why none of them engages the
 * loop-failure halt path (that only applies to a seeded execution).
 */
function respondToLaunchRefusal(
  error: unknown,
  inputPathRoot: LaunchInputPathRoot,
): Response {
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
    // The session is being finalized by a merge, so there is no run to name and
    // no lease to clear — the remedy is the merge, not this session's workflow.
    if (error.guard === "session_finalizing") {
      return NextResponse.json(
        { error: error.message, code: "session_finalizing" } satisfies ApiError,
        { status: 409 },
      );
    }
    // The lease-held refusal (D7 decision D6). `details` is the blocker the
    // admission decision built, forwarded verbatim so the CLI and the UI
    // name the same run and the same remedy without re-reading anything.
    return NextResponse.json(
      {
        error: error.message,
        code: "lease_held",
        ...(error.blocker === undefined ? {} : { details: error.blocker }),
      } satisfies ApiError,
      { status: 409 },
    );
  }
  if (error instanceof WorkflowPrerequisitesUnmetError) {
    return NextResponse.json(
      {
        error: error.message,
        code: "prerequisites_unmet",
        details: { missing: error.missing },
      } satisfies ApiError,
      { status: 409 },
    );
  }
  if (error instanceof WorkflowStartInputError) {
    return NextResponse.json(
      {
        error: error.message,
        ...locateLaunchInputIssue(error, inputPathRoot),
      },
      { status: 400 },
    );
  }
  return respondToManagerError(error);
}

export function createGraphWorkflowExecutionRouteHandlers(
  deps: GraphWorkflowExecutionRouteDeps = defaultDeps,
) {
  const executionContract = createRegisteredGraphExecutionContract();

  /**
   * Launch authority for RUN and START (R9.4/R10.1).
   *
   * Two refusals a per-execution guard cannot express live here. A verified
   * LANE is refused as NESTING — a run must not launch a run, and that holds
   * even when the session's lease is free, so it is not a lease conflict and
   * must not be reported as one. An agent that proves nothing is refused
   * outright. The human UI launches unowned, which is what keeps a browser
   * launch working with no credentials at all.
   */
  async function resolveLaunchPrincipal(input: {
    request: Request;
    resolved: {
      session: SessionState;
      projectPath: string;
      sessionName: string;
    };
    verb: string;
  }): Promise<{ refusal: Response } | { ownerConversationId: string | null }> {
    const classified = await classifyRoutePrincipal(
      input.request,
      input.resolved.session,
      deps,
    );
    if (classified.kind === "invalid_token") {
      return { refusal: invalidTokenResponse() };
    }
    if (classified.kind === "unverified") {
      logger.warn("graph-workflow.run.unverified_principal_refused", {
        projectPath: input.resolved.projectPath,
        sessionName: input.resolved.sessionName,
        reason: classified.reason,
      });
      return {
        refusal: NextResponse.json(
          {
            error:
              "This agent cannot launch a workflow: it presented no verified conversation capability.",
            code: "unverified_principal",
            instruction:
              "Run `cctl workflow run` from an ordinary session conversation. Workflow lanes, the planner, and collaboration runtimes are not minted a capability and cannot launch runs.",
          } satisfies ApiError & { code: string; instruction: string },
          { status: 403 },
        ),
      };
    }

    const { principal } = classified;
    const authorization = authorizeWorkflowLaunch(principal);
    if (authorization.kind === "refused") {
      logger.warn("graph-workflow.run.nesting_refused", {
        projectPath: input.resolved.projectPath,
        sessionName: input.resolved.sessionName,
        ...(principal.kind === "lane"
          ? { laneExecutionId: principal.executionId }
          : {}),
      });
      return {
        refusal: NextResponse.json(
          {
            error:
              "A workflow lane cannot launch a workflow: runs do not nest inside runs.",
            code: "workflow_nesting_refused",
            instruction:
              "Ask the conversation that launched this run to start the next one, or launch it from the Command Center UI.",
          } satisfies ApiError & { code: string; instruction: string },
          { status: 403 },
        ),
      };
    }

    return {
      ownerConversationId:
        principal.kind === "conversation" ? principal.conversationId : null,
    };
  }

  async function markExecutionRunning(
    context: GraphExecutionLifecycleContext,
    execution: GraphWorkflowExecution,
  ): Promise<void> {
    if (deps.markRunning === undefined) return;
    try {
      await deps.markRunning(context, execution.id, execution.origin);
    } catch (error) {
      logger.warn("graph-workflow.execution_mark_running_failed", {
        workflowExecutionId: execution.id,
        origin: execution.origin.kind,
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
    execution: GraphWorkflowExecution,
  ): Promise<void> {
    if (deps.awaitingDefinitionApproval === undefined) return;
    try {
      await deps.awaitingDefinitionApproval(
        context,
        execution.id,
        execution.origin,
      );
    } catch (error) {
      logger.warn("graph-workflow.execution_awaiting_approval_report_failed", {
        workflowExecutionId: execution.id,
        origin: execution.origin.kind,
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * Auto-release (D7 decision D3): a settled run that no longer holds the
   * session's lease is archived the moment it settles rather than waiting for
   * an operator to clear it. The lease — not a status set — is the test, so a
   * non-resumable halt releases here exactly as R4 says it does, while a
   * resumable halt or a paused run is deliberately left holding: releasing one
   * would admit unrelated validation and race a resume.
   *
   * Best-effort by design: a failed archive must not turn a successful abort or
   * a finished run into an error, and admission normalizes whatever this
   * misses without any explicit clear act.
   */
  async function autoReleaseSettledExecution(
    projectPath: string,
    sessionName: string,
    audit?: { reason: string; actor: string | null },
  ): Promise<void> {
    try {
      const active = await deps.getActiveExecution(projectPath, sessionName);
      if (
        !active ||
        holdsExecutionLease(
          active.status,
          active.haltReason,
          active.abandonment,
        )
      ) {
        return;
      }
      // No operator act stops lane dev servers that survived earlier cleanup,
      // and completion is the one terminal transition the manager runs no
      // cleanup for — so the automatic release carries the backstop itself.
      await deps.stopExecutionLaneDevServers?.({
        execution: active,
        projectPath,
      });
      // An operator-initiated abort carries its reason here: `aborted`
      // auto-releases, so this IS the release that ends the run's ownership,
      // and the reason belongs on its durable audit row rather than nowhere.
      await deps.archiveExecution(projectPath, sessionName, audit);
      logger.info("graph-workflow.execution.archived", {
        projectPath,
        sessionName,
        executionId: active.id,
        status: active.status,
        reason: "auto_release",
      });
    } catch (error) {
      logger.warn("graph-workflow.execution.auto_release_failed", {
        projectPath,
        sessionName,
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * Kick off the execution loop and release the slot once it settles. Every
   * loop start goes through here so the completion transition auto-releases
   * identically no matter which surface launched or resumed the run.
   */
  async function kickOffAndAutoRelease(input: {
    projectPath: string;
    projectName: string;
    sessionName: string;
    execution: GraphWorkflowExecution;
  }): Promise<void> {
    try {
      await deps.kickOffExecutionLoop(input);
    } finally {
      await autoReleaseSettledExecution(input.projectPath, input.sessionName);
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

    // Owner identity is DERIVED, never read off a header or payload: a caller
    // header naming a conversation is a claim every sibling conversation and
    // every lane can also make, so START answers it with the same signed
    // principal RUN does (R9.4). A lane is refused here as nesting.
    const launchPrincipal = await resolveLaunchPrincipal({
      request,
      resolved,
      verb: "start",
    });
    if ("refusal" in launchPrincipal) return launchPrincipal.refusal;
    const ownerConversationId = launchPrincipal.ownerConversationId;

    let outcome: GraphWorkflowLaunchOutcome;
    try {
      // The active-execution and uncommitted-changes guards plus start-input
      // validation all run inside the shared start path so HTTP and MCP enforce
      // an identical pre-seed chain. Guard/input rejections seed nothing, so
      // they map directly to a response without engaging the loop-failure halt
      // path (which only applies to a seeded execution).
      outcome = await deps.startExecution({
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
        ...(ownerConversationId !== null ? { ownerConversationId } : {}),
      });
    } catch (error) {
      return respondToLaunchRefusal(error, "parameters");
    }

    const receipt = buildLaunchReceipt({
      outcome,
      projectName: resolved.projectName,
      sessionName,
    });

    if (outcome.awaitingDefinitionApproval) {
      // An accepted launch that has not begun (D7 R14, decision D1). START used
      // to persist the parked run and then report 409, forcing every caller to
      // decode a refusal as a success; the receipt says it plainly instead.
      await reportAwaitingDefinitionApproval(
        { projectPath, sessionName },
        outcome.execution,
      );
      return NextResponse.json(
        { execution: summarizeExecution(outcome.execution, false), receipt },
        { status: 202 },
      );
    }
    const execution = outcome.execution;

    try {
      await markExecutionRunning({ projectPath, sessionName }, execution);
      void Promise.resolve()
        .then(() =>
          kickOffAndAutoRelease({
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
        { execution: summarizeExecution(execution, false), receipt },
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
   * POST .../graph-workflow/run — the inline one-off launch (D7 R1, R2, R14).
   *
   * Two things happen here and nowhere else on this path: the submitted plan
   * passes the SAME accept-time gate `workflow validate`/`create` apply
   * (legacy-shape detection, dialect parse, structural + placement +
   * reference checks, command-selector preflight) before any state exists, and
   * the caller's conversation is captured server-side. Everything after that is
   * the shared manager gauntlet — no second engine, no reduced validation, and
   * no definition storage of any kind (R1.1).
   */
  async function RUN(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }
    const { projectPath, sessionName } = resolved;

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Request body must be JSON" } satisfies ApiError,
        { status: 400 },
      );
    }

    const body = runExecutionSchema.safeParse(rawBody);
    if (!body.success) {
      return NextResponse.json(
        {
          error: "Invalid request: plan is required",
        } satisfies ApiError,
        { status: 400 },
      );
    }

    const [repoConfig, globalConfig] = await Promise.all([
      (deps.readRepoConfig ?? defaultReadRepoConfig)(projectPath),
      (deps.readConfig ?? readConfig)(),
    ]);
    const validation = await admitAuthoredWorkflowLaunch(body.data.plan, {
      caller: "project-run",
      documentScope: { kind: "project", projectPath },
      projectValidation: repoConfig?.validation ?? null,
      globalValidation: globalConfig.validation,
      workflowDefaults: globalConfig.workflowDefaults,
      agentBackends: globalConfig.agentBackends,
    });
    if (!validation.ok) {
      logger.info("graph-workflow.run.plan_rejected", {
        projectPath,
        sessionName,
        code: validation.code ?? "invalid_plan",
        issueCount: validation.issues.length,
      });
      return NextResponse.json(
        {
          error: "Workflow plan is invalid",
          ...(validation.code ? { code: validation.code } : {}),
          issues: validation.issues,
        },
        { status: 400 },
      );
    }

    // Launch authority, in the order D11/D12 define it. The origin is a SIGNED
    // principal, not a claim (R9.4/D11), and an AGENT that cannot prove which
    // conversation it is does not launch: admitting it unowned would let a
    // lane, the planner, or a sibling agent consume the session's one lease
    // with no verified authority. No execution is passed — a launch has none
    // yet, so there is no origin to scope against.
    const launchPrincipal = await resolveLaunchPrincipal({
      request,
      resolved,
      verb: "launch",
    });
    if ("refusal" in launchPrincipal) return launchPrincipal.refusal;
    const ownerConversationId = launchPrincipal.ownerConversationId;

    let outcome: GraphWorkflowLaunchOutcome;
    try {
      outcome = await deps.runExecution({
        projectPath,
        sessionName,
        plan: validation.launch,
        ...(body.data.inputs !== undefined ? { inputs: body.data.inputs } : {}),
        ...(ownerConversationId !== null ? { ownerConversationId } : {}),
      });
    } catch (error) {
      return respondToLaunchRefusal(error, "inputs");
    }

    const receipt = buildLaunchReceipt({
      outcome,
      projectName: resolved.projectName,
      sessionName,
      warnings: [...validation.warnings, ...(outcome.warnings ?? [])],
    });
    logger.info("graph-workflow.run.accepted", {
      projectPath,
      sessionName,
      executionId: receipt.executionId,
      status: receipt.status,
      origin: receipt.origin.kind,
      warningCount: receipt.warnings?.length ?? 0,
    });

    if (outcome.awaitingDefinitionApproval) {
      // An accepted launch that has not begun: the review is opened and the
      // loop is deliberately not engaged until a human decides (R14.1).
      await reportAwaitingDefinitionApproval(
        { projectPath, sessionName },
        outcome.execution,
      );
      return NextResponse.json({ receipt }, { status: 202 });
    }

    const execution = outcome.execution;
    try {
      await markExecutionRunning({ projectPath, sessionName }, execution);
      void Promise.resolve()
        .then(() =>
          kickOffAndAutoRelease({
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
      return NextResponse.json({ receipt }, { status: 202 });
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
    /**
     * The launching conversation, resolved by the in-process caller (the spec
     * execution-start gate, the MCP start tool). `null` is an explicit "this
     * seam has no conversation identity" — a Studio-driven spec grant, for
     * instance — and leaves the run unowned.
     */
    ownerConversationId?: string | null;
    /**
     * Documents the launching tier rendered for this run. Threaded only
     * through this in-process seam, never through `startExecutionSchema`: an
     * HTTP body that could supply it would be an arbitrary write into the
     * session worktree's `.cc` namespace.
     */
    seededDocuments?: readonly SeededWorkflowDocument[];
  }): Promise<GraphWorkflowExecution> {
    const outcome = await deps.startExecution({
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
      ...(input.ownerConversationId !== undefined &&
      input.ownerConversationId !== null
        ? { ownerConversationId: input.ownerConversationId }
        : {}),
      ...(input.seededDocuments !== undefined
        ? { seededDocuments: input.seededDocuments }
        : {}),
    });

    // This in-process seam answers a caller that expects a RUNNING execution,
    // so a park is raised rather than returned: the spec start gate reads the
    // parked run back through its own pending-approval query and the MCP tool
    // reports the review, neither of which can proceed with a run that has not
    // begun. The HTTP transports keep the park as an accepted receipt.
    if (outcome.awaitingDefinitionApproval) {
      const parked = new WorkflowDefinitionApprovalRequiredError(
        outcome.execution.id,
        outcome.execution.seedDefinitionId,
        outcome.execution.seedDefinitionRevision,
      );
      await reportAwaitingDefinitionApproval(
        { projectPath: input.projectPath, sessionName: input.sessionName },
        outcome.execution,
      );
      throw parked;
    }
    const execution = outcome.execution;

    await markExecutionRunning(
      { projectPath: input.projectPath, sessionName: input.sessionName },
      execution,
    );

    void Promise.resolve()
      .then(() =>
        kickOffAndAutoRelease({
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

  /**
   * The spec-delivery sibling of `launch`: same running-execution contract,
   * different source. Sign-off already served as the human definition approval
   * (the finalized candidate carries `approvalRequired: false`), so a park here
   * is a caller error surfaced as the same raised approval, not a state to
   * wait on.
   */
  async function launchSpecDelivery(input: {
    projectPath: string;
    projectName: string;
    sessionName: string;
    definitionId: string;
    expectedDefinitionRevision: number;
    specSlug: string;
    candidateId: string;
    inputs?: Record<string, unknown>;
    ownerConversationId?: string | null;
    seededDocuments?: readonly SeededWorkflowDocument[];
    transactionAttachment?: (input: { executionId: string }) => void;
  }): Promise<GraphWorkflowExecution> {
    const outcome = await deps.launchSpecDeliveryExecution({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      definitionId: input.definitionId,
      expectedDefinitionRevision: input.expectedDefinitionRevision,
      specSlug: input.specSlug,
      candidateId: input.candidateId,
      ...(input.inputs !== undefined ? { inputs: input.inputs } : {}),
      ...(input.ownerConversationId !== undefined &&
      input.ownerConversationId !== null
        ? { ownerConversationId: input.ownerConversationId }
        : {}),
      ...(input.seededDocuments !== undefined
        ? { seededDocuments: input.seededDocuments }
        : {}),
      ...(input.transactionAttachment !== undefined
        ? { transactionAttachment: input.transactionAttachment }
        : {}),
    });

    if (outcome.awaitingDefinitionApproval) {
      const parked = new WorkflowDefinitionApprovalRequiredError(
        outcome.execution.id,
        outcome.execution.seedDefinitionId,
        outcome.execution.seedDefinitionRevision,
      );
      await reportAwaitingDefinitionApproval(
        { projectPath: input.projectPath, sessionName: input.sessionName },
        outcome.execution,
      );
      throw parked;
    }
    const execution = outcome.execution;

    await markExecutionRunning(
      { projectPath: input.projectPath, sessionName: input.sessionName },
      execution,
    );

    void Promise.resolve()
      .then(() =>
        kickOffAndAutoRelease({
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

    // Current is a LEASE projection here exactly as it is on EXECUTION and
    // History (D7 decision D4). A settled run still physically occupying the
    // active row holds nothing, and reporting it as Current is what made a
    // finished run render as the live one. It is not hidden: `summarizeHistory`
    // is the projection that carries a lease-free active row, so the same row
    // this drops from Current appears in the history list below.
    const current =
      execution &&
      holdsExecutionLease(
        execution.status,
        execution.haltReason,
        execution.abandonment,
      )
        ? execution
        : null;

    return NextResponse.json({
      execution: current ? summarizeExecution(current, false) : null,
      archivedExecutions: await summarizeHistory(
        deps,
        resolved.projectPath,
        resolved.sessionName,
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

    // Current is a LEASE projection, not a row-position one (D7 decision D4).
    // A settled run awaiting normalization still physically occupies the active
    // row, but it holds nothing — reporting it as Current is what made a
    // finished run render as the live one while History, which already carries
    // it, was told to drop it as a duplicate.
    if (
      execution &&
      !holdsExecutionLease(
        execution.status,
        execution.haltReason,
        execution.abandonment,
      )
    ) {
      return NextResponse.json({ execution: null });
    }

    return NextResponse.json({ execution: execution ?? null });
  }

  async function EXECUTION_BY_ID(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) return resolved.error;

    const executionId = decodeURIComponent(
      (await context.params)["executionId"] ?? "",
    );
    const getExecutionById =
      deps.getExecutionById ?? defaultGetGraphWorkflowExecutionById;
    const execution = await getExecutionById(
      resolved.projectPath,
      resolved.sessionName,
      executionId,
    );
    if (execution === null) {
      logger.info("graph-workflow.execution_by_id.not_found", {
        projectPath: resolved.projectPath,
        sessionName: resolved.sessionName,
        executionId,
      });
      return notFound("Graph workflow execution not found");
    }
    return NextResponse.json({ execution });
  }

  async function EXECUTION_RESULT(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) return resolved.error;

    const executionId = decodeURIComponent(
      (await context.params)["executionId"] ?? "",
    );
    const getExecutionById =
      deps.getExecutionById ?? defaultGetGraphWorkflowExecutionById;
    const execution = await getExecutionById(
      resolved.projectPath,
      resolved.sessionName,
      executionId,
    );
    if (execution === null) {
      logger.info("graph-workflow.execution_result.not_found", {
        projectPath: resolved.projectPath,
        sessionName: resolved.sessionName,
        executionId,
      });
      return notFound("Graph workflow execution not found");
    }

    const cursorParam = new URL(request.url).searchParams.get("cursor");
    let cursor: number | null = null;
    if (cursorParam !== null) {
      const parsedCursor = Number(cursorParam);
      if (!Number.isSafeInteger(parsedCursor) || parsedCursor < 1) {
        logger.info("graph-workflow.execution_result.invalid_cursor", {
          projectPath: resolved.projectPath,
          sessionName: resolved.sessionName,
          executionId,
        });
        return NextResponse.json(
          { error: "cursor must be a positive integer" } satisfies ApiError,
          { status: 400 },
        );
      }
      cursor = parsedCursor;
    }

    const getBoundaryResultAfter =
      deps.getBoundaryResultAfter ?? defaultGetGraphWorkflowBoundaryResultAfter;
    const result = await getBoundaryResultAfter(
      resolved.projectPath,
      resolved.sessionName,
      executionId,
      cursor,
    );
    return NextResponse.json({ result });
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
      const page = await getEventsPage(
        resolved.projectPath,
        resolved.sessionName,
        executionId,
        {
          limit,
          cursor:
            Number.isInteger(cursorParam) && cursorParam > 0
              ? cursorParam
              : null,
          direction:
            url.searchParams.get("direction") === "desc" ? "desc" : "asc",
        },
      );
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
    const events = await getEventsTail(
      resolved.projectPath,
      resolved.sessionName,
      executionId,
      limit,
    );
    return NextResponse.json({ events });
  }

  async function PAUSE(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }

    const guarded = await guardExecutionMutation({
      request,
      session: resolved.session,
      deps,
      verb: "pause",
      authority: "any_session_conversation",
      projectPath: resolved.projectPath,
      execution: await deps.getActiveExecution(
        resolved.projectPath,
        resolved.sessionName,
      ),
    });
    if ("refusal" in guarded) return guarded.refusal;

    try {
      const acted = await runPinnedMutation(guarded.fence, "pause", () =>
        deps.pauseExecution(resolved.projectPath, resolved.sessionName),
      );
      if (acted.kind === "turnover") return acted.refusal;
      return NextResponse.json({
        execution: summarizeExecution(acted.value, false),
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

    // Guarded BEFORE the restart normalization below, which mutates: a refused
    // caller must leave no trace, and normalizing for a caller that is then
    // turned away is a write a refusal is not allowed to make.
    const guarded = await guardExecutionMutation({
      request,
      session: resolved.session,
      deps,
      verb: "resume",
      authority: "any_session_conversation",
      projectPath: resolved.projectPath,
      execution: await deps.getActiveExecution(
        resolved.projectPath,
        resolved.sessionName,
      ),
    });
    if ("refusal" in guarded) return guarded.refusal;

    try {
      // Normalization is part of the act, not a prologue to it: it writes, so
      // it belongs inside the same pin as the resume it prepares.
      const acted = await runPinnedMutation(
        guarded.fence,
        "resume",
        async () => {
          await deps.normalizeExecutionAfterRestart(
            resolved.projectPath,
            resolved.sessionName,
          );
          return deps.resumeExecution(
            resolved.projectPath,
            resolved.sessionName,
            resumeOptions,
          );
        },
      );
      if (acted.kind === "turnover") return acted.refusal;
      const execution = acted.value;
      // Deliberately OUTSIDE the fence: the loop outlives this request, carries
      // its own generation fence, and must not inherit a request-scoped pin.
      void Promise.resolve()
        .then(() =>
          kickOffAndAutoRelease({
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
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }
    const abortBody = abortExecutionSchema.safeParse(
      await request.json().catch(() => ({})),
    );
    const abortReason = abortBody.success ? abortBody.data.reason : undefined;

    // Guarded BEFORE the interrupted-decision settlement below, which commits:
    // a refused abort must be write-free.
    const guarded = await guardExecutionMutation({
      request,
      session: resolved.session,
      deps,
      verb: "abort",
      authority: "any_session_conversation",
      projectPath: resolved.projectPath,
      execution: await deps.getActiveExecution(
        resolved.projectPath,
        resolved.sessionName,
      ),
    });
    if ("refusal" in guarded) return guarded.refusal;

    try {
      const acted = await runPinnedMutation(
        guarded.fence,
        "abort",
        async () => {
          // A park holding an interrupted decision refuses the abort, because
          // discarding that reservation could strand an admission already
          // recorded behind it. Finishing the interrupted saga first is what
          // makes the run abortable again — and leaves nothing behind either way.
          await settleInterruptedDefinitionDecision({
            projectPath: resolved.projectPath,
            projectName: resolved.projectName,
            sessionName: resolved.sessionName,
          });
          return deps.abortExecution(
            resolved.projectPath,
            resolved.sessionName,
          );
        },
      );
      if (acted.kind === "turnover") return acted.refusal;
      const execution = acted.value;
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
      // `aborted` auto-releases: the slot is free the moment this route
      // returns, with no separate clear step. Runs after the abort's own
      // cleanup (question withdrawal, lane dev servers), which needs the
      // execution still active.
      await autoReleaseSettledExecution(
        resolved.projectPath,
        resolved.sessionName,
        abortReason === undefined
          ? undefined
          : {
              reason: abortReason,
              actor: abortBody.success ? (abortBody.data.actor ?? null) : null,
            },
      );
      return NextResponse.json({
        execution: summarizeExecution(execution, false),
        released: true,
      });
    } catch (error) {
      return respondToManagerError(error);
    }
  }

  /**
   * `cctl workflow abandon` — the one explicit, audited act that ends a
   * resumable halt's tenure (D7 decision D5). Addressed by execution identity,
   * so the run the caller read is the run that ends; a refusal never falls back
   * to whatever holds the lease now.
   *
   * The manager act commits the audit, the released boundary event, and the
   * relocation into History in one transaction. Lane teardown follows it rather
   * than preceding it: the act is the authoritative release, so only the caller
   * whose transaction committed reaches the external cleanup, and it reaches it
   * holding the whole record — lane references included.
   */
  async function ABANDON(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) return resolved.error;

    const abandon = deps.abandonExecution;
    if (abandon === undefined) {
      return NextResponse.json(
        { error: "Workflow abandonment is not available" } satisfies ApiError,
        { status: 501 },
      );
    }

    const parsed = abandonExecutionSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: `Invalid abandon request: ${parsed.error.issues[0]?.message ?? "malformed body"}`,
          code: "invalid_request",
        } satisfies ApiError & { code: string },
        { status: 400 },
      );
    }

    // The shared mutation contract admits the human UI, any conversation this
    // session verified, or the execution's current lane. An agent that cannot
    // prove which conversation it is has no authority, and a stale lane fails
    // freshness. Authorization is against the active run even when the body
    // names a stale id; only an admitted caller reaches the service's separate
    // execution-mismatch refusal.
    const active = await deps.getActiveExecution(
      resolved.projectPath,
      resolved.sessionName,
    );
    const guarded = await guardExecutionMutation({
      request,
      session: resolved.session,
      deps,
      verb: "abandon",
      authority: "any_session_conversation",
      projectPath: resolved.projectPath,
      execution: active,
    });
    if ("refusal" in guarded) return guarded.refusal;

    // The abandonment is attributed to the principal the SERVER established,
    // never to a free-text label.
    const actor: GraphWorkflowAbandonment["actor"] =
      guarded.principal.kind === "human_ui"
        ? { kind: "human" }
        : {
            kind: "conversation",
            conversationId: guarded.principal.conversationId,
          };

    const acted = await runPinnedMutation(guarded.fence, "abandon", () =>
      abandon({
        projectPath: resolved.projectPath,
        sessionName: resolved.sessionName,
        executionId: parsed.data.executionId,
        reason: parsed.data.reason,
        actor,
      }),
    );
    if (acted.kind === "turnover") return acted.refusal;
    const outcome = acted.value;
    if (!outcome.ok) {
      return NextResponse.json(
        {
          error: abandonRefusalMessage(parsed.data.executionId, outcome),
          code: outcome.reason,
        } satisfies ApiError & { code: string },
        { status: outcome.reason === "no_active_execution" ? 404 : 409 },
      );
    }

    // Post-commit, winner only: the run is already in History, so a failed
    // teardown cannot un-abandon it — but leaving its lane dev servers running
    // beside the successor is exactly what this backstop exists to prevent.
    await deps.stopExecutionLaneDevServers?.({
      execution: outcome.execution,
      projectPath: resolved.projectPath,
    });
    return NextResponse.json({
      execution: buildExecutionActReceipt(outcome.execution, true),
      abandoned: true,
    });
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
    // A reset discards a context's work, so it is scoped exactly like the
    // sibling lifecycle verbs rather than admitted on transport alone.
    // Authorization is answered before the state ladder below: a caller with no
    // business here learns that, not which execution the session happens to
    // hold.
    const guarded = await guardExecutionMutation({
      request,
      session: resolved.session,
      deps,
      verb: "reset a context of",
      authority: "any_session_conversation",
      projectPath: resolved.projectPath,
      execution: activeExecution,
    });
    if ("refusal" in guarded) return guarded.refusal;

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
      const acted = await runPinnedMutation(
        guarded.fence,
        "reset a context of",
        () =>
          deps.resetExecutionContext(
            resolved.projectPath,
            resolved.sessionName,
            parsed.data.contextId,
          ),
      );
      if (acted.kind === "turnover") return acted.refusal;
      return NextResponse.json({
        execution: summarizeExecution(acted.value, false),
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
    const guarded = await guardExecutionMutation({
      request,
      session: resolved.session,
      deps,
      verb: "reset an assignment of",
      authority: "any_session_conversation",
      projectPath: resolved.projectPath,
      execution: activeExecution,
    });
    if ("refusal" in guarded) return guarded.refusal;

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
      const acted = await runPinnedMutation(
        guarded.fence,
        "reset an assignment of",
        () =>
          deps.resetExecutionContextAssignment(
            resolved.projectPath,
            resolved.sessionName,
            parsed.data.contextId,
            parsed.data.assignmentId,
          ),
      );
      if (acted.kind === "turnover") return acted.refusal;
      return NextResponse.json({
        execution: summarizeExecution(acted.value, false),
      });
    } catch (error) {
      return respondToManagerError(error);
    }
  }

  /**
   * The change set the approval panel renders for one parked context (R15.2).
   *
   * A read of its own rather than a field on the execution payload: the patch is
   * git bytes, not execution state, and folding it into the execution row every
   * poller already fetches would put an unbounded blob on the hot path for the
   * one surface that needs it.
   */
  async function APPROVAL_SNAPSHOT(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }

    const params = new URL(request.url).searchParams;
    const contextId = params.get("contextId") ?? "";
    // Optional: when the caller names the gate it is rendering, the resolver
    // refuses to answer for a different one.
    const requestedAt = params.get("requestedAt") ?? "";
    if (contextId.trim() === "") {
      return NextResponse.json(
        { error: "Invalid request: contextId is required" } satisfies ApiError,
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

    const resolveSnapshot =
      deps.resolveApprovalSnapshot ?? resolveApprovalSnapshot;
    const resolution = await resolveSnapshot({
      execution: activeExecution,
      contextId,
      sessionWorktreePath: resolved.session.worktreePath,
      ...(requestedAt.trim() === "" ? {} : { requestedAt }),
    });

    // A superseded gate 404s with the others rather than getting a response
    // kind of its own: the caller's view of the execution is simply stale, and
    // the fix is the refetch its next state update already triggers.
    if (
      resolution.kind === "unknown_context" ||
      resolution.kind === "not_awaiting_approval" ||
      resolution.kind === "gate_superseded"
    ) {
      return notFound(
        `Context "${contextId}" is not awaiting approval in the active execution`,
      );
    }

    return NextResponse.json(resolution);
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

    // Deciding a context's approval gate ANSWERS a question the run posed to
    // whoever launched it, rather than steering the run the way its sibling
    // verbs do, so it is the one guarded verb that keeps launch authority:
    // the human UI, the run's recorded origin, or the lane whose own gate it
    // is. It is still not the DEFINITION decision, which is human-only.
    const guarded = await guardExecutionMutation({
      request,
      session: resolved.session,
      deps,
      verb: "resolve an approval gate of",
      projectPath: resolved.projectPath,
      execution: await deps.getActiveExecution(
        resolved.projectPath,
        resolved.sessionName,
      ),
    });
    if ("refusal" in guarded) return guarded.refusal;

    const decision: ApprovalGateDecisionInput =
      parsed.data.decision === "approve"
        ? { type: "approved" }
        : { type: "rejected", message: parsed.data.message };

    let result: RecordDecisionResult;
    try {
      const acted = await runPinnedMutation(
        guarded.fence,
        "resolve an approval gate of",
        () =>
          deps.recordApprovalDecision({
            projectPath: resolved.projectPath,
            sessionName: resolved.sessionName,
            contextId: parsed.data.contextId,
            decision,
          }),
      );
      if (acted.kind === "turnover") return acted.refusal;
      result = acted.value;
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
      awaitsDefinitionApproval(execution.status, execution.definitionApproval)
    );
  }

  /**
   * The session's parked execution and the origin it recorded, or null when
   * nothing is parked. Callers outside this domain (the spec-side
   * execution-start act) use it to establish WHICH run holds the park before
   * deciding it: a session's lease says only that some run holds it, and
   * approving a run one does not mean starts the wrong workflow.
   */
  async function findPendingDefinitionApproval(input: {
    projectPath: string;
    sessionName: string;
  }): Promise<{
    executionId: string;
    origin: GraphWorkflowExecutionOrigin;
  } | null> {
    const active = await deps.getActiveExecution(
      input.projectPath,
      input.sessionName,
    );
    return executionAwaitsDefinitionApproval(active)
      ? { executionId: active.id, origin: active.origin }
      : null;
  }

  /**
   * Undo this act's own reservation. Best-effort by construction: the caller
   * is already returning a refusal, and a release that cannot land means the
   * park turned over — restart normalization releases whatever is stranded.
   */
  async function releaseReservation(
    input: { projectPath: string; sessionName: string },
    executionId: string,
    claimId: string,
  ): Promise<void> {
    if (deps.releaseDefinitionApprovalClaim === undefined) return;
    const released = await deps.releaseDefinitionApprovalClaim({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      expectedExecutionId: executionId,
      claimId,
    });
    if (!released.ok) {
      logger.warn("graph-workflow.definition_approval.claim_release_failed", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        executionId,
        reason: released.reason,
      });
    }
  }

  /**
   * Non-HTTP definition-approval seam: records the approval on the session's
   * active execution and, on success, reports the started run through the
   * lifecycle port and engages the loop exactly like a gate-free START. The
   * HTTP handler and human-only server-side callers (e.g. the spec-side
   * execution-start grant) share this path so approval always starts the run
   * the same way. The registered lifecycle consumer records its own
   * execution-scoped admission for a definition it prepared, or refuses
   * machine-readably.
   *
   * A SAGA in three steps, because the act spans two authorities — this graph's
   * serialized row and the consumer's own durable records — and neither
   * two-write order is sound alone: approving before the gate leaves a refused
   * act with an irreversibly approved run whose only remedy would be a resume
   * that never consults the gate, while admitting before any reservation leaves
   * a losing act's admission behind (charter `reserve-before-side-effects`).
   * So: reserve (decides nothing, arbitrates everything), admit (the
   * reservation holder's alone), then finalize. Every refusal releases the
   * reservation and leaves the park exactly as the reviewer found it, which is
   * what makes "fix this, then approve again" a remedy that works.
   */
  async function approveDefinition(input: {
    projectPath: string;
    projectName: string;
    sessionName: string;
    expectedExecutionId?: string;
  }): Promise<
    | RecordDefinitionApprovalResult
    | ClaimDefinitionApprovalResult
    | { ok: false; reason: "unavailable" }
    | {
        ok: false;
        reason: "gate_refused";
        refusal: Exclude<DefinitionApprovalGateDecision, { ok: true }>;
      }
  > {
    if (
      deps.recordDefinitionApproval === undefined ||
      deps.claimDefinitionApproval === undefined
    ) {
      return { ok: false, reason: "unavailable" };
    }
    // An interrupted decision on THIS run is finished before a new one is
    // taken: its reservation stands until the saga it belongs to ends, so a
    // fresh act would only be refused behind it. Fenced to the named execution
    // so a stale act never settles — and so never starts — a successor.
    await settleInterruptedDefinitionDecision(input);
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
    // ONE act for both origins (D7 R14.2): the park is validated and offered
    // to the admission consumer by execution identity and recorded origin,
    // never by a stored-definition identity a one-off run does not have.
    // Whether a consumer claims this run — and how it correlates one it does —
    // is its own decision, downstream of the origin it receives.
    const parked = executionAwaitsDefinitionApproval(active);
    if (parked) {
      // Pure: a contract verdict on bytes already in hand writes nothing, so it
      // stays ahead of the reservation and refuses an invalid plan without ever
      // reserving anything.
      const contractDecision = executionContract.validateDefinition(
        active.workingDefinition,
      );
      if (!contractDecision.ok) {
        logger.warn(
          "graph-workflow.definition_approval.execution_contract_rejected",
          {
            executionId: active.id,
            origin: active.origin.kind,
            code: contractDecision.code,
            issueCount: contractDecision.issues.length,
          },
        );
      }
      assertGraphExecutionContractAccepted(contractDecision);
    }
    // COMMIT ONE — the reservation, and the act's arbiter. It decides nothing:
    // the run stays parked and unapproved, so a caller the gate goes on to
    // refuse has an act it can hand back whole, and a caller that loses this
    // race never reaches the gate to write anything at all.
    const reserved = await deps.claimDefinitionApproval({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      ...(input.expectedExecutionId === undefined
        ? {}
        : { expectedExecutionId: input.expectedExecutionId }),
    });
    if (!reserved.ok) return reserved;

    return completeReservedApproval(input, {
      executionId: reserved.execution.id,
      origin: reserved.execution.origin,
      claimId: reserved.claimId,
    });
  }

  /**
   * The second half of the approval saga, from a reservation this server holds.
   *
   * Split out because a reservation has exactly two ways to end and both run
   * this code: the act that took it finishes here, and an act INTERRUPTED
   * before it could finish is finished here too, from the reservation it left
   * on the row. Nothing else may end a reservation — see
   * {@link settleInterruptedDefinitionDecision}.
   *
   * THE ADMISSION comes first and is still ahead of any approval this graph has
   * recorded. A consumer that REFUSES is answered by releasing the reservation,
   * which restores the park byte for byte: nothing was approved, nothing was
   * materialized, nothing started, and the gate's "fix this, then approve
   * again" remedy is literally true. That release is why a refusal is the one
   * answer the consumer contract requires to be write-free.
   *
   * Every other unhappy end KEEPS the reservation, because past the refusal the
   * consumer's records may be durable: a thrown consumer failure carries no
   * promise about what committed before it (the production spec consumer grants
   * its approval, admission and event before the notification work that can
   * throw), and a finalize that refuses does so behind an admission that already
   * landed. Handing the reservation back there would reopen the park for a
   * rejection or abort while those records stand — written and lost, which
   * `reserve-before-side-effects` forbids. A kept reservation refuses every
   * decision act until {@link settleInterruptedDefinitionDecision} finishes the
   * saga forward, which is the only end that strands nothing.
   */
  async function completeReservedApproval(
    input: { projectPath: string; projectName: string; sessionName: string },
    reservation: {
      executionId: string;
      origin: GraphWorkflowExecutionOrigin;
      claimId: string;
    },
  ): Promise<
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
    let result: RecordDefinitionApprovalResult;
    try {
      if (deps.admitDefinitionApproval !== undefined) {
        const admitted = await deps.admitDefinitionApproval(
          {
            projectPath: input.projectPath,
            sessionName: input.sessionName,
          },
          reservation.executionId,
          reservation.origin,
        );
        if (!admitted.ok) {
          logger.warn("graph-workflow.definition_approval.gate_refused", {
            executionId: reservation.executionId,
            origin: reservation.origin.kind,
            code: admitted.code,
          });
          await releaseReservation(
            input,
            reservation.executionId,
            reservation.claimId,
          );
          return { ok: false, reason: "gate_refused", refusal: admitted };
        }
      }

      // COMMIT TWO — the approval itself, admitted and only now recorded. The
      // manager refuses a finalize that holds no reservation, so this cannot be
      // reached by a caller that skipped the gate.
      result = await deps.recordDefinitionApproval({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        expectedExecutionId: reservation.executionId,
        claimId: reservation.claimId,
      });
    } catch (error) {
      // Kept, not released: a failure carries no promise about what the
      // consumer committed before it, and freeing the park under a durable
      // admission is the one outcome this saga exists to prevent.
      logger.warn("graph-workflow.definition_approval.reservation_kept", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        executionId: reservation.executionId,
        origin: reservation.origin.kind,
        error: getErrorMessage(error),
      });
      throw error;
    }
    if (!result.ok) {
      // Only a run that left the park underneath an admitted act reaches here,
      // and no act can do that while a reservation stands — so this is the
      // narrow case of a park that turned over between the reservation and the
      // finalize. The admission behind it is already durable, so the
      // reservation is kept rather than handed back to whatever would end the
      // run next.
      logger.warn("graph-workflow.definition_approval.reservation_kept", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        executionId: reservation.executionId,
        origin: reservation.origin.kind,
        reason: result.reason,
      });
      return result;
    }

    await markExecutionRunning(
      { projectPath: input.projectPath, sessionName: input.sessionName },
      result.execution,
    );
    void Promise.resolve()
      .then(() =>
        kickOffAndAutoRelease({
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

  /**
   * Finish a decision whose holder went away, before acting on the park it
   * holds.
   *
   * A reservation is taken BEFORE the admission consumer is called, so a
   * reservation that outlives its holder may already have that consumer's
   * durable records behind it. Freeing it and then ending the run would strand
   * those records on a run this server killed — the interrupted act would have
   * written and lost, which `reserve-before-side-effects` forbids. So an
   * interrupted decision is FINISHED instead: the admission is re-offered
   * (consumers make it idempotent for exactly this) and the reservation is
   * either finalized into the approval it was taken for, or released because
   * the gate refused it. Either way nothing is left behind, and the park is
   * decidable again.
   *
   * Only a reservation aged past a plausible live holder qualifies; a live
   * holder finishes its own act, and every decision act refuses while it does.
   *
   * FENCED to the execution the caller named, because finishing a decision can
   * admit, approve and start the run it finishes. An act addressed to a run that
   * has already turned over would otherwise decide its successor and then refuse
   * — a refusal that changed another execution, which is exactly what
   * `reserve-before-side-effects` forbids. A session-addressed caller (abort)
   * names no execution and settles whatever holds the session, which is the run
   * it is acting on.
   */
  async function settleInterruptedDefinitionDecision(input: {
    projectPath: string;
    projectName: string;
    sessionName: string;
    expectedExecutionId?: string;
  }): Promise<void> {
    if (
      deps.recordDefinitionApproval === undefined ||
      deps.releaseDefinitionApprovalClaim === undefined
    ) {
      return;
    }
    const active = await deps.getActiveExecution(
      input.projectPath,
      input.sessionName,
    );
    if (active === null) return;
    if (
      input.expectedExecutionId !== undefined &&
      active.id !== input.expectedExecutionId
    ) {
      return;
    }
    const interrupted = interruptedDefinitionDecision(
      active,
      deps.now?.() ?? new Date().toISOString(),
    );
    if (interrupted === null) return;
    logger.warn("graph-workflow.definition_approval.settling_interrupted", {
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      executionId: active.id,
      origin: active.origin.kind,
    });
    try {
      await completeReservedApproval(input, {
        executionId: active.id,
        origin: active.origin,
        claimId: interrupted.claimId,
      });
    } catch (error) {
      // A settlement that cannot finish leaves the reservation standing, which
      // is the safe end: every decision act refuses behind a live reservation,
      // so the caller is answered with a write-free conflict instead of a
      // failure that looks like it acted.
      logger.warn("graph-workflow.definition_approval.settlement_failed", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        executionId: active.id,
        error: getErrorMessage(error),
      });
    }
  }

  async function APPROVE_DEFINITION(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    // Definition approval is a human review act (the execution-start gate for
    // approval-required definitions), so it is refused to every agent
    // credential, not merely to agent transport.
    const humanOnly = await guardHumanOnlyAct({
      request,
      deps,
      error: "Workflow definition approval is a human-only act",
      instruction:
        "Approve the definition from the Command Center UI (Spec Studio or the session workflow page), not from an agent.",
    });
    if (humanOnly !== null) return humanOnly;

    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }

    const rawBody: unknown = await request.json().catch(() => null);
    const approvalIdentity =
      definitionDecisionIdentitySchema.safeParse(rawBody);
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
          error: definitionApprovalRefusalMessage(result.reason),
          code: result.reason,
        } satisfies ApiError & { code: string },
        { status: 409 },
      );
    }

    return NextResponse.json({
      execution: buildExecutionActReceipt(result.execution, false),
    });
  }

  /**
   * The reject half of the definition gate (D7 R14.2, decision D17). Addressed
   * solely by execution identity, so a one-off park — which has no saved
   * definition to name — and a template park are the same act.
   *
   * Order mirrors ABANDON for the same reasons: the decision is committed
   * through the serialized mutation first, then lane resources are released,
   * then the record is relocated into History through the audited archive seam.
   * `aborted` is lease-free the moment it commits, so the session is free even
   * if the archive below is missed — admission normalizes the row on the next
   * launch.
   */
  async function REJECT_DEFINITION(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    // Rejecting a definition is the same human review act as approving one, so
    // it answers every agent credential with the same refusal.
    const humanOnly = await guardHumanOnlyAct({
      request,
      deps,
      error: "Workflow definition rejection is a human-only act",
      instruction:
        "Reject the definition from the Command Center UI (Spec Studio or the session workflow page), not from an agent.",
    });
    if (humanOnly !== null) return humanOnly;

    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) return resolved.error;

    if (deps.rejectDefinition === undefined) {
      return NextResponse.json(
        {
          error: "Workflow definition rejection is not available",
        } satisfies ApiError,
        { status: 501 },
      );
    }

    const parsed = definitionDecisionIdentitySchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: `Invalid definition rejection request: ${parsed.error.issues[0]?.message ?? "malformed body"}`,
          code: "invalid_request",
        } satisfies ApiError & { code: string },
        { status: 400 },
      );
    }

    // Same reason as the abort: a rejection may not discard a reservation whose
    // admission may already have landed, so an interrupted decision is finished
    // before this one is attempted. If that settlement admits and starts the
    // run, this rejection arrives too late and is refused as such. Fenced to the
    // rejected execution: a rejection naming a run that has turned over must not
    // start its successor on the way to refusing.
    await settleInterruptedDefinitionDecision({
      projectPath: resolved.projectPath,
      projectName: resolved.projectName,
      sessionName: resolved.sessionName,
      expectedExecutionId: parsed.data.executionId,
    });
    const outcome = await deps.rejectDefinition({
      projectPath: resolved.projectPath,
      sessionName: resolved.sessionName,
      executionId: parsed.data.executionId,
    });
    if (!outcome.ok) {
      return NextResponse.json(
        {
          error: rejectDefinitionRefusalMessage(
            parsed.data.executionId,
            outcome,
          ),
          code: outcome.reason,
        } satisfies ApiError & { code: string },
        { status: outcome.reason === "no_active_execution" ? 404 : 409 },
      );
    }

    // Rejection ends the run exactly as an abort does, so whatever a consumer
    // pinned to it terminalizes the same way — a linked delivery left
    // nonterminal is the one difference between the two ends that would matter.
    // Origin-aware by construction: the consumer decides whether this execution
    // is its business, which is where template-specific behavior belongs.
    // Best-effort like ABORT's report: a consumer failure must not mask a
    // rejection that has already committed.
    if (deps.executionAborted !== undefined) {
      try {
        await deps.executionAborted(outcome.execution.id);
      } catch (error) {
        logger.warn("graph-workflow.definition_rejection.report_failed", {
          workflowExecutionId: outcome.execution.id,
          error: getErrorMessage(error),
        });
      }
    }
    await deps.stopExecutionLaneDevServers?.({
      execution: outcome.execution,
      projectPath: resolved.projectPath,
    });
    const archiveOutcome = await deps.archiveExecution(
      resolved.projectPath,
      resolved.sessionName,
      { reason: "definition_rejected", actor: "human" },
      (current) =>
        current.id === outcome.execution.id && current.status === "aborted",
    );
    if (!archiveOutcome.archived) {
      logger.warn("graph-workflow.definition_rejection.archive_skipped", {
        projectPath: resolved.projectPath,
        sessionName: resolved.sessionName,
        executionId: outcome.execution.id,
        reason: archiveOutcome.reason,
      });
    }
    return NextResponse.json({
      execution: buildExecutionActReceipt(
        outcome.execution,
        archiveOutcome.archived,
      ),
      rejected: true,
    });
  }

  return {
    START,
    RUN,
    launch,
    launchSpecDelivery,
    STATUS,
    EXECUTION,
    EXECUTION_BY_ID,
    EXECUTION_RESULT,
    HISTORY,
    EVENTS,
    PAUSE,
    RESUME,
    ABORT,
    ABANDON,
    RESET_CONTEXT,
    RESET_ASSIGNMENT,
    RESOLVE_APPROVAL,
    APPROVAL_SNAPSHOT,
    APPROVE_DEFINITION,
    REJECT_DEFINITION,
    approveDefinition,
    findPendingDefinitionApproval,
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
    /** Owner conversation resolved by the calling seam; `null` when it has none. */
    ownerConversationId?: string | null;
    /** Pre-rendered documents the launching tier seeds into every lane. */
    seededDocuments?: readonly SeededWorkflowDocument[];
  },
  deps: GraphWorkflowExecutionRouteDeps = defaultDeps,
): Promise<GraphWorkflowExecution> {
  return createGraphWorkflowExecutionRouteHandlers(deps).launch(input);
}

/**
 * In-process seam for the native-SDD launch bridge: launches a signed
 * candidate's authored document as a `spec_delivery` run through the shared
 * gauntlet, committing the bridge's spec rows atomically with the reservation.
 */
export async function launchSpecDeliveryGraphWorkflowExecution(
  input: {
    projectPath: string;
    projectName: string;
    sessionName: string;
    definitionId: string;
    expectedDefinitionRevision: number;
    specSlug: string;
    candidateId: string;
    inputs?: Record<string, unknown>;
    /** Owner conversation resolved by the calling seam; `null` when it has none. */
    ownerConversationId?: string | null;
    /** Pre-rendered documents the launching tier seeds into every lane. */
    seededDocuments?: readonly SeededWorkflowDocument[];
    /** Spec rows committed atomically with the execution's reservation. */
    transactionAttachment?: (input: { executionId: string }) => void;
  },
  deps: GraphWorkflowExecutionRouteDeps = defaultDeps,
): Promise<GraphWorkflowExecution> {
  return createGraphWorkflowExecutionRouteHandlers(deps).launchSpecDelivery(
    input,
  );
}

const defaultGraphWorkflowExecutionHandlers =
  createGraphWorkflowExecutionRouteHandlers();

/**
 * Approve the session's pending workflow definition and start the run through
 * the production seam (workflow manager + execution loop singletons) without
 * HTTP transport. Human-only server-side flows — e.g. the spec-side
 * execution-start act, which records its own human grant from inside this
 * saga's admission callback rather than ahead of it — use it so definition
 * approval always engages the same lifecycle-port report and loop kickoff as
 * the HTTP handler. Callers own the human-act enforcement.
 */
export async function approveGraphWorkflowDefinitionForSession(input: {
  projectPath: string;
  projectName: string;
  sessionName: string;
  workflowExecutionId: string;
}): Promise<
  | RecordDefinitionApprovalResult
  | ClaimDefinitionApprovalResult
  | { ok: false; reason: "unavailable" }
  | {
      ok: false;
      reason: "gate_refused";
      refusal: Exclude<DefinitionApprovalGateDecision, { ok: true }>;
    }
> {
  return defaultGraphWorkflowExecutionHandlers.approveDefinition({
    projectPath: input.projectPath,
    projectName: input.projectName,
    sessionName: input.sessionName,
    expectedExecutionId: input.workflowExecutionId,
  });
}

/**
 * The session's park and its recorded origin, through the production
 * singletons. Server-side callers outside this domain (the spec-side
 * execution-start act) correlate that origin to the run they mean before
 * deciding it.
 */
export async function findSessionPendingWorkflowDefinitionApproval(input: {
  projectPath: string;
  sessionName: string;
}): Promise<{
  executionId: string;
  origin: GraphWorkflowExecutionOrigin;
} | null> {
  return defaultGraphWorkflowExecutionHandlers.findPendingDefinitionApproval(
    input,
  );
}

/**
 * Where the named run stands. Callers that must clean a specific run up — the
 * spec abandon coordinator, the `cctl workflow live` verbs — need the LEASE,
 * not the row position: a terminal record still sitting in the active row
 * holds nothing and is normalized by the next launch, while a resumably halted
 * one is live work no cleanup may step over. A bare status cannot express
 * either, since abandonment and halt resumability are invisible to it.
 */
export type GraphWorkflowExecutionPlacement =
  | { kind: "missing" }
  | { kind: "archived"; status: GraphWorkflowStatus }
  | { kind: "active"; status: GraphWorkflowStatus; leaseHeld: boolean };

/**
 * Locate a named execution without HTTP transport. Resolves against the
 * session's live slot first, then the archive — a cleared run keeps its
 * terminal status there, so only a truly deleted execution reports `missing`.
 */
export async function locateGraphWorkflowExecution(
  input: {
    projectPath: string;
    sessionName: string;
    workflowExecutionId: string;
  },
  deps: GraphWorkflowExecutionRouteDeps = defaultDeps,
): Promise<GraphWorkflowExecutionPlacement> {
  const active = await deps.getActiveExecution(
    input.projectPath,
    input.sessionName,
  );
  if (active !== null && active.id === input.workflowExecutionId) {
    return {
      kind: "active",
      status: active.status,
      leaseHeld: holdsExecutionLease(
        active.status,
        active.haltReason,
        active.abandonment,
      ),
    };
  }
  const listArchived =
    deps.listArchivedExecutions ?? listArchivedGraphWorkflowExecutions;
  const archived = (
    await listArchived(input.projectPath, input.sessionName)
  ).find((execution) => execution.id === input.workflowExecutionId);
  return archived === undefined
    ? { kind: "missing" }
    : { kind: "archived", status: archived.status };
}

/**
 * Abort the session's active run when — and only when — it is still the named
 * execution. The id guard matters for server-side callers that pinned a target
 * earlier: without it a slot re-taken in between would be aborted instead.
 */
export async function abortGraphWorkflowExecutionForSession(
  input: {
    projectPath: string;
    sessionName: string;
    workflowExecutionId: string;
  },
  deps: GraphWorkflowExecutionRouteDeps = defaultDeps,
): Promise<GraphWorkflowExecution | null> {
  const active = await deps.getActiveExecution(
    input.projectPath,
    input.sessionName,
  );
  if (active === null || active.id !== input.workflowExecutionId) return null;
  const aborted = await deps.abortExecution(
    input.projectPath,
    input.sessionName,
  );
  await deps.executionAborted?.(input.workflowExecutionId);
  return aborted;
}

/**
 * End the session's resumably halted run through the audited abandon act, from
 * a server-side caller with no HTTP transport (the spec abandon coordinator).
 *
 * Deliberately NOT the abort seam above. Abort would answer the lease just as
 * well and is exactly the wrong act here: it drives the record to `aborted`,
 * discarding the halt reason and leaving no abandonment audit, so a run ended
 * by spec cleanup would render in History as an operator's abort. The id guard
 * lives inside the act, which re-applies it in the archiving transaction.
 */
export async function abandonGraphWorkflowExecutionForSession(
  input: {
    projectPath: string;
    sessionName: string;
    workflowExecutionId: string;
    reason: string;
    actor: GraphWorkflowAbandonment["actor"];
  },
  deps: GraphWorkflowExecutionRouteDeps = defaultDeps,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (deps.abandonExecution === undefined) {
    return { ok: false, reason: "workflow abandonment is not available" };
  }
  const outcome = await deps.abandonExecution({
    projectPath: input.projectPath,
    sessionName: input.sessionName,
    executionId: input.workflowExecutionId,
    reason: input.reason,
    actor: input.actor,
  });
  if (!outcome.ok) {
    return {
      ok: false,
      reason: abandonRefusalMessage(input.workflowExecutionId, outcome),
    };
  }
  // Post-commit, winner only — the same backstop the HTTP act performs, for the
  // same reason: the run is in History, and its lane dev servers must not
  // outlive it.
  await deps.stopExecutionLaneDevServers?.({
    execution: outcome.execution,
    projectPath: input.projectPath,
  });
  return { ok: true };
}

export const startGraphWorkflowExecution = withTracing(
  defaultGraphWorkflowExecutionHandlers.START,
);
export const runGraphWorkflowExecution = withTracing(
  defaultGraphWorkflowExecutionHandlers.RUN,
);
export const getGraphWorkflowExecutionStatus = withTracing(
  defaultGraphWorkflowExecutionHandlers.STATUS,
);
export const getGraphWorkflowExecutionFull = withTracing(
  defaultGraphWorkflowExecutionHandlers.EXECUTION,
);
export const getGraphWorkflowExecutionById = withTracing(
  defaultGraphWorkflowExecutionHandlers.EXECUTION_BY_ID,
);
export const getGraphWorkflowExecutionResult = withTracing(
  defaultGraphWorkflowExecutionHandlers.EXECUTION_RESULT,
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
export const abandonGraphWorkflowExecution = withTracing(
  defaultGraphWorkflowExecutionHandlers.ABANDON,
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
export const getGraphWorkflowApprovalSnapshot = withTracing(
  defaultGraphWorkflowExecutionHandlers.APPROVAL_SNAPSHOT,
);
export const approveGraphWorkflowDefinition = withTracing(
  defaultGraphWorkflowExecutionHandlers.APPROVE_DEFINITION,
);
export const rejectGraphWorkflowDefinition = withTracing(
  defaultGraphWorkflowExecutionHandlers.REJECT_DEFINITION,
);
