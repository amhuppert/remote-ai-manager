import { randomUUID } from "node:crypto";
import { readRepoConfig } from "@/lib/projects/repo-config";
import { getConfiguredQueryConcurrency } from "@/lib/shared/query-semaphore";
import {
  isConversationBusy,
  acquireConversationLock,
} from "@/lib/prompt/single-flight";
import { clearConversationQuestion } from "@/lib/workflows/conversation/manager";
import { createLandingEvidenceProber } from "./landing-evidence";
import { createLaneDriftAuditor } from "./lane-drift";
import {
  createRegisteredGraphExecutionContract,
  assertGraphExecutionContractRegistered,
} from "./execution-contract-port";
import {
  createGraphWorkflowLifecycleService,
  type GraphWorkflowLifecycleDeps,
} from "./lifecycle-service";

import { readConfig } from "@/lib/config/loader";

import { createLogger } from "@/lib/logging";

import {
  getSession as defaultGetSession,
  listArchivedGraphWorkflowExecutions,
  getGraphWorkflowEventsTail,
} from "@/lib/state-store";

import type {
  GraphWorkflowAbandonment,
  GraphWorkflowExecutionOrigin,
  GraphWorkflowExecution,
} from "@/lib/workflow-graph/schemas";

import type { SeededWorkflowDocument } from "@/lib/workflow-graph/shared-documents";

import {
  type RecordDefinitionApprovalResult,
  type ClaimDefinitionApprovalResult,
} from "@/lib/workflow-graph/workflow-manager";

import {
  createRegisteredGraphExecutionLifecycleCallbacks,
  assertGraphExecutionLifecycleCallbacksRegistered,
  type DefinitionApprovalGateDecision,
} from "@/lib/workflow-graph/execution-lifecycle-port";

import { stopExecutionLaneDevServers as defaultStopExecutionLaneDevServers } from "@/lib/workflow-graph/dev-server-lane-cleanup";

import { getErrorMessage } from "@/lib/shared/errors";

import { abandonRefusalMessage } from "./lifecycle-outcomes";
import type { GraphWorkflowExecutionPlacement } from "./lifecycle-service";
import { createGraphWorkflowEngine } from "./engine-composition";
import { targetFromStoreSessionName } from "@/lib/conversations/conversation-target";
import { getProjectDisplayName as getConversationProjectName } from "@/lib/projects/resolver";

import {
  createConversation,
  getConversation,
} from "@/lib/conversations/service";
import {
  requestConversationStop,
  stopConversationActor,
} from "@/lib/workflows/conversation/manager";

import {
  getActiveGraphWorkflowExecution,
  mutateActiveGraphWorkflowExecution,
  reserveActiveGraphWorkflowExecution,
  archiveActiveGraphWorkflowExecution,
  markGraphWorkflowContextEventsPreReset,
  getGraphWorkflowPendingArtifacts,
  clearGraphWorkflowPendingArtifacts,
  findLatestGraphWorkflowContextEvent,
  listActiveGraphWorkflowExecutions,
} from "@/lib/state-store";

import { resyncSharedIndexToHead } from "@/lib/git/shared-index";
import { resolveConfiguredAgentBackendDefaults } from "@/lib/agent-backends/conversation-policy";

import { dispatchPushForGraphWorkflowEvent } from "@/lib/push-notification/dispatcher";

import {
  applyLiveEditsToActiveExecution,
  buildDefaultAssignmentSnapshotPreparation,
  buildDefaultLiveEditDeps,
  defaultWriteCharterDocument,
} from "./live-edit-apply";
import { createPlanRepairAgentRunner } from "./plan-repair/agent-runner";

import { toPlanRepairValidationVerdict } from "./plan-repair/prompt";
import { loadRotationHandoffNote } from "./rotation-handoff";
import { readConversationTelemetry } from "./conversation-telemetry";

import { createValidatorRunner } from "./validator-runner";
import { createScriptValidatorRunner } from "./script-validator-runner";
import { createWorkflowStorageService } from "./storage";
import { scopeForTier } from "./template-library-service";
import {
  abortExecutionLoop,
  isExecutionLoopActive,
} from "@/lib/workflow-graph/execution-loop";

import { runRegisteredMergeJob } from "@/lib/jobs/queue";
import { createRegisteredDeliveryGateEvaluator } from "@/lib/workflows/merge/delivery-gate-port";

import { createPreflightPrerequisiteService } from "@/lib/workflow-graph/preflight-prerequisite-service";
import { readWorktreeDirtyPaths } from "@/lib/git/worktree";
import { defaultGitClient } from "@/lib/git/client";
import { computeCandidateTreeHash } from "@/lib/git/diff";

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

import { createApprovalGateService } from "./approval-gate";
import { createSoloContextCommitter } from "./solo-context-committer";
import { createLaneCommitter } from "./lane-committer";
import { createJoinRunner } from "./join-runner";

import {
  resolveGraphValidatorTimeoutMs,
  createGraphWorkflowValidationRoundService,
  createGraphWorkflowScriptValidatorService,
} from "./validation-services";

const logger = createLogger("graph-workflow-production");
const GRAPH_WORKFLOW_EVENTS_DEFAULT_LIMIT = 500;

function createProductionGraphWorkflowRuntime() {
  const workflowStorage = createWorkflowStorageService();
  const parallelWorktrees = createParallelWorktrees();

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
  const {
    planRepairSupervisor,
    runExecutionLoopWithPlanRepair,
    eventPublisher,
    executionRepository,
    workflowManager,
    executionLoop,
  } = createGraphWorkflowEngine({
    clearConversationQuestion,
    executionContract: createRegisteredGraphExecutionContract(),
    repair({
      workflowManager,
      executionRepository,
      eventPublisher,
      runExecutionLoopWithPlanRepair,
    }) {
      return {
        getActiveExecution: (projectPath, sessionName) =>
          executionRepository.getActive(projectPath, sessionName),
        mutateActive: executionRepository.mutateActive,
        applyLiveEdits: (input) =>
          applyLiveEditsToActiveExecution(input, {
            executionContract: createRegisteredGraphExecutionContract(),
            getActiveExecution: getActiveGraphWorkflowExecution,
            mutateActive: executionRepository.mutateActive,
            buildLiveEditDeps: buildDefaultLiveEditDeps,
            prepareAssignmentSnapshots:
              buildDefaultAssignmentSnapshotPreparation,
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
          await workflowManager.normalizeAfterRestart(
            projectPath,
            sessionName,
            {
              expectedExecutionId: executionId,
            },
          );
          // The manager raises a transition conflict rather than resuming the
          // successor, which the supervisor records as an unresumed round. No human
          // is in this loop, so the resume declares itself automatic and the manager
          // refuses halts only restored capacity can clear.
          const execution = await workflowManager.resume(
            projectPath,
            sessionName,
            {
              expectedExecutionId: executionId,
              initiator: "system",
            },
          );
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
          (await defaultGetSession(projectPath, sessionName))?.worktreePath ??
          null,
        publishPlanRepairRound: eventPublisher.publishPlanRepairRound,
        now: () => new Date().toISOString(),
      };
    },
    conversation: {
      listActiveExecutions: async () => listActiveGraphWorkflowExecutions(),
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
    },
    storage: {
      publication: {
        dispatchPush: dispatchPushForGraphWorkflowEvent,
      },
      repository: () => ({
        getSession: defaultGetSession,
        getActiveGraphWorkflowExecution,
        mutateActiveGraphWorkflowExecution,
        reserveActiveGraphWorkflowExecution,
        archiveActiveGraphWorkflowExecution,
        markGraphWorkflowContextEventsPreReset,
        getGraphWorkflowPendingArtifacts,
        clearGraphWorkflowPendingArtifacts,
      }),
    },
    lifecycle: {
      stopExecutionLaneDevServers: defaultStopExecutionLaneDevServers,
      retireLaneConversation: ({ projectPath, sessionName, conversationId }) =>
        stopConversationActor(
          projectPath,
          sessionName,
          conversationId,
          "workflow_assignment_reset",
        ),
      loadDefinition: (projectPath, definitionId, tier) =>
        workflowStorage.get(scopeForTier(tier, projectPath), definitionId),
      isExecutionLoopActive,
      readSessionWorktreeDirtyPaths: (worktreePath) =>
        readWorktreeDirtyPaths(worktreePath),
      preflightService: createPreflightPrerequisiteService(),
      readGlobalConfig: readConfig,
      abortConversation: ({ projectPath, sessionName, conversationId }) => {
        const stop = requestConversationStop(
          {
            projectPath,
            target: targetFromStoreSessionName(
              getConversationProjectName(projectPath),
              sessionName,
              conversationId,
            ),
          },
          "user",
        );
        void stop.settled.catch((error) => {
          logger.warn("workflow.abort_settlement_failed", {
            conversationId,
            sessionName,
            error: getErrorMessage(error),
          });
        });
      },
      abortExecutionLoop,
    },
    git: {
      parallelWorktrees,
      mergeMutex,
      sessionGitLock,
      mergeRunner,
      soloContextCommitter,
      laneCommitter,
      joinRunner,
      executionTargetResolver,
    },
    execution: {
      landingEvidenceProber: createLandingEvidenceProber(),
      laneDriftAuditor: createLaneDriftAuditor(),
      resyncSharedIndex: resyncSharedIndexToHead,
      buildLiveEditDeps: buildDefaultLiveEditDeps,
      readRepoConfig,
      getMaxConcurrentQueries: getConfiguredQueryConcurrency,
      isConversationBusy,
      acquireConversationLock,
      getSessionWorktreeDirtyPaths: ({ sessionWorktreePath }) =>
        readWorktreeDirtyPaths(sessionWorktreePath),
      getSession: defaultGetSession,
    },
    context({ executionRepository, continuityService }) {
      const validatorRunner = createValidatorRunner({
        executionContract: createRegisteredGraphExecutionContract(),
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
        executionRepository: executionRepository,
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
          return resolveConfiguredAgentBackendDefaults(config, backend)
            .timeoutMs;
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
          return resolveConfiguredAgentBackendDefaults(config, backend)
            .timeoutMs;
        },
      });

      const validationRoundService = createGraphWorkflowValidationRoundService({
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

      const scriptValidatorService = createGraphWorkflowScriptValidatorService({
        getSession: defaultGetSession,
        readConfig,
        runScriptValidator: scriptValidatorRunner.runScriptValidator,
      });

      const sharedDocumentMaterializer = createWorkflowDocumentMaterializer({
        store: createSharedDocumentStore(),
      });
      return {
        storage: {
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
        },
        conversation: {
          createConversation,
          continuityService,
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
              executionTarget: input.executionTarget,
              askUserQuestionsEnabled: input.askUserQuestionsEnabled,
              placement: input.placement,
            });
          },
          outputCaptureService: outputCaptureRunner,
          advisoryResponseService: advisoryResponseRunner,
          readConversationTelemetry: (conversationId) =>
            readConversationTelemetry(conversationId),
        },
        validation: {
          scriptValidatorService,
          validationRoundService,
          cohort: {
            runContextValidator: validatorRunner.runContextValidator,
            renderRoundCommonSections:
              validatorRunner.renderRoundCommonSections,
          },
        },
        policy: {
          readRepoConfig,
          createTaskId: () => `task-${randomUUID()}`,
          async readLaneConversation(projectPath, sessionName, conversationId) {
            try {
              const conversation = await getConversation(
                projectPath,
                sessionName,
                conversationId,
              );
              if (!conversation) return null;
              return {
                pendingQuestionId: conversation.pendingQuestionId,
                pendingQuestions: conversation.pendingQuestions ?? [],
              };
            } catch (error) {
              // A read failure cannot confirm a pending question, so the park check
              // treats it as "no question" (deny-by-default). Logged so a systematic
              // failure is visible rather than silently suppressing every park.
              logger.warn(
                "graph-workflow.iteration.read_lane_conversation_failed",
                { conversationId, error: getErrorMessage(error) },
              );
              return null;
            }
          },
          materializeWorkflowDocuments: (input) =>
            sharedDocumentMaterializer.materialize(input).then(() => undefined),
        },
      };
    },
  });

  const approvalGateService = createApprovalGateService({
    mutateActive: executionRepository.mutateActive,
    now: () => new Date().toISOString(),
  });

  return {
    lifecycle: createGraphWorkflowLifecycleService(
      createProductionGraphWorkflowLifecycleDeps(),
    ),
    eventPublisher,
    executionRepository,
    workflowManager,
    executionLoop,
    planRepairSupervisor,
    approvalGateService,
    runExecutionLoopWithPlanRepair,
  };
}

let runtime:
  | ReturnType<typeof createProductionGraphWorkflowRuntime>
  | undefined;

export function getGraphWorkflowRuntime() {
  assertGraphExecutionContractRegistered();
  assertGraphExecutionLifecycleCallbacksRegistered();
  runtime ??= createProductionGraphWorkflowRuntime();
  return runtime;
}

export function createProductionGraphWorkflowLifecycleDeps(): GraphWorkflowLifecycleDeps {
  return {
    executionContract: createRegisteredGraphExecutionContract(),
    normalizeExecutionAfterRestart: (projectPath, sessionName) =>
      getGraphWorkflowRuntime().workflowManager.normalizeAfterRestart(
        projectPath,
        sessionName,
      ),
    startExecution: (input) =>
      getGraphWorkflowRuntime().workflowManager.start(input),
    runExecution: (input) =>
      getGraphWorkflowRuntime().workflowManager.run(input),
    launchSpecDeliveryExecution: (input) =>
      getGraphWorkflowRuntime().workflowManager.launchSpecDelivery(input),
    markRunning: createRegisteredGraphExecutionLifecycleCallbacks().markRunning,
    awaitingDefinitionApproval:
      createRegisteredGraphExecutionLifecycleCallbacks()
        .awaitingDefinitionApproval,
    admitDefinitionApproval:
      createRegisteredGraphExecutionLifecycleCallbacks()
        .admitDefinitionApproval,
    executionAborted:
      createRegisteredGraphExecutionLifecycleCallbacks().executionAborted,
    recordDefinitionApproval: (input) =>
      getGraphWorkflowRuntime().workflowManager.recordDefinitionApproval(input),
    claimDefinitionApproval: (input) =>
      getGraphWorkflowRuntime().workflowManager.claimDefinitionApproval(input),
    releaseDefinitionApprovalClaim: (input) =>
      getGraphWorkflowRuntime().workflowManager.releaseDefinitionApprovalClaim(
        input,
      ),
    rejectDefinition: (input) =>
      getGraphWorkflowRuntime().workflowManager.rejectDefinition(input),
    pauseExecution: (projectPath, sessionName) =>
      getGraphWorkflowRuntime().workflowManager.send(projectPath, sessionName, {
        type: "pause",
      }),
    resumeExecution: (projectPath, sessionName, options) =>
      getGraphWorkflowRuntime().workflowManager.resume(
        projectPath,
        sessionName,
        options,
      ),
    abortExecution: (projectPath, sessionName) =>
      getGraphWorkflowRuntime().workflowManager.send(projectPath, sessionName, {
        type: "abort",
      }),
    abandonExecution: (input) =>
      getGraphWorkflowRuntime().workflowManager.abandon(input),
    resetExecutionContext: (projectPath, sessionName, contextId) =>
      getGraphWorkflowRuntime().workflowManager.resetContext(
        projectPath,
        sessionName,
        contextId,
      ),
    resetExecutionContextAssignment: (
      projectPath,
      sessionName,
      contextId,
      assignmentId,
    ) =>
      getGraphWorkflowRuntime().workflowManager.resetContextAssignment(
        projectPath,
        sessionName,
        contextId,
        assignmentId,
      ),
    archiveExecution: (projectPath, sessionName, audit, guard) =>
      getGraphWorkflowRuntime().executionRepository.archiveActive(
        projectPath,
        sessionName,
        audit,
        guard,
      ),
    async kickOffExecutionLoop(input) {
      await getGraphWorkflowRuntime().runExecutionLoopWithPlanRepair(input);
    },
    getActiveExecution: (projectPath, sessionName) =>
      getGraphWorkflowRuntime().executionRepository.getActive(
        projectPath,
        sessionName,
      ),
    recordPendingHaltReason: (input) =>
      getGraphWorkflowRuntime().workflowManager.recordPendingHaltReason(input),
    drainAndHalt: (input) =>
      getGraphWorkflowRuntime().workflowManager.drainAndHalt(input),
    listArchivedExecutions: (projectPath, sessionName) =>
      listArchivedGraphWorkflowExecutions(projectPath, sessionName),
    stopExecutionLaneDevServers: (input) =>
      defaultStopExecutionLaneDevServers(input),
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
  deps: GraphWorkflowLifecycleDeps = createProductionGraphWorkflowLifecycleDeps(),
): Promise<GraphWorkflowExecution> {
  return createGraphWorkflowLifecycleService(deps).launchSavedRunning(input);
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
  deps: GraphWorkflowLifecycleDeps = createProductionGraphWorkflowLifecycleDeps(),
): Promise<GraphWorkflowExecution> {
  return createGraphWorkflowLifecycleService(deps).launchSpecDelivery(input);
}

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
  return getGraphWorkflowRuntime().lifecycle.approveDefinition({
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
  return getGraphWorkflowRuntime().lifecycle.findPendingDefinitionApproval(
    input,
  );
}

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
  deps: GraphWorkflowLifecycleDeps = createProductionGraphWorkflowLifecycleDeps(),
): Promise<GraphWorkflowExecutionPlacement> {
  return createGraphWorkflowLifecycleService(deps).locateExecution(input);
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
  deps: GraphWorkflowLifecycleDeps = createProductionGraphWorkflowLifecycleDeps(),
): Promise<GraphWorkflowExecution | null> {
  return createGraphWorkflowLifecycleService(deps).abortDeliveryExecution(
    input,
  );
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
  deps: GraphWorkflowLifecycleDeps = createProductionGraphWorkflowLifecycleDeps(),
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const result = await createGraphWorkflowLifecycleService(deps).abandon({
    projectPath: input.projectPath,
    sessionName: input.sessionName,
    executionId: input.workflowExecutionId,
    reason: input.reason,
    actor: input.actor,
  });
  if (result.ok) return { ok: true };
  return {
    ok: false,
    reason:
      result.reason === "unavailable"
        ? "workflow abandonment is not available"
        : abandonRefusalMessage(input.workflowExecutionId, result),
  };
}
