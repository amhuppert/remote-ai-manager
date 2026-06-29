import { NextResponse } from "next/server";
import { z } from "zod";
import { readConfig } from "@/lib/config/loader";
import { resetExecutionContextRequestSchema } from "@/lib/workflows/schemas";
import {
  createConversation,
  getConversation,
} from "@/lib/conversations/service";
import { abortConversation as abortConversationRegistry } from "@/lib/conversations/abort-registry";
import { sendConversationEvent } from "@/lib/workflows/conversation/manager";
import { createLogger, withTracing } from "@/lib/logging";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import {
  getSession as defaultGetSession,
  getActiveGraphWorkflowExecution,
  mutateActiveGraphWorkflowExecution,
  archiveActiveGraphWorkflowExecution,
  markGraphWorkflowContextEventsPreReset,
  findLatestGraphWorkflowContextEvent,
  listArchivedGraphWorkflowExecutions,
  getGraphWorkflowEventsTail,
} from "@/lib/state-store";
import { resolveConfiguredTimeoutMs } from "@/lib/agent-backends/timeout";
import type { ApiError } from "@/lib/api/errors";
import type { SessionState } from "@/lib/sessions/schemas";
import type {
  GraphWorkflowCleanupStatusValue,
  GraphWorkflowExecution,
  GraphWorkflowExecutionEvent,
  GraphWorkflowExecutionJoinKind,
  GraphWorkflowExecutionJoinStatus,
  GraphWorkflowHaltReason,
  GraphWorkflowMergeStatusValue,
  GraphWorkflowStatus,
} from "@/lib/workflows/schemas";
import { dispatchPushForGraphWorkflowEvent } from "@/lib/push-notification/dispatcher";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
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
import { buildGraphWorkflowPortableMcp } from "@/lib/mcp-gateway/portable-config";
import {
  createGraphWorkflowExecutionLoop,
  isExecutionLoopActive,
} from "@/lib/workflow-graph/execution-loop";
import {
  createGraphWorkflowIterationOrchestrator,
  type IterationOrchestratorScriptValidatorInput,
} from "@/lib/workflow-graph/iteration-orchestrator";
import {
  createGraphWorkflowManager,
  WorkflowPrerequisitesUnmetError,
  WorkflowStartGuardError,
  WorkflowStartInputError,
  type RecordPendingHaltReasonInput,
  type RecordPendingHaltReasonResult,
  type DrainAndHaltInput,
} from "@/lib/workflow-graph/workflow-manager";
import { createPreflightPrerequisiteService } from "@/lib/workflow-graph/preflight-prerequisite-service";
import { stopExecutionLaneDevServers as defaultStopExecutionLaneDevServers } from "@/lib/workflow-graph/dev-server-lane-cleanup";
import { toHaltReason } from "@/lib/workflow-graph/errors";
import { readWorktreeDirtyPaths } from "@/lib/git/worktree";
import { createWorkflowContinuityService } from "@/lib/workflow-graph/workflow-continuity-service";
import { createGraphWorkflowImplementerRunner } from "./implementer-runner";
import { createParallelWorktrees } from "./parallel-worktrees";
import { createSharedDocumentStore } from "./shared-document-store";
import { createWorkflowDocumentMaterializer } from "./document-materialization";
import { createPerSessionMergeMutex } from "./per-session-merge-mutex";
import { createSessionGitLock } from "./session-git-lock";
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
import { createSoloContextCommitter } from "./solo-context-committer";
import { createLaneCommitter } from "./lane-committer";
import { createJoinRunner } from "./join-runner";

type RouteContext = {
  params: Promise<Record<string, string>>;
};

const startExecutionSchema = z.object({
  definitionId: z.string().trim().min(1),
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
});

const continuityService = createWorkflowContinuityService({
  createConversation,
  getConversation,
  startCodexThread: async () => ({ threadId: crypto.randomUUID() }),
  resumeCodexThread: async (threadId) => ({ threadId }),
});

const validatorRunner = createValidatorRunner({
  async resolveWorktreePath(projectPath, sessionName) {
    const session = await defaultGetSession(projectPath, sessionName);
    if (!session) throw new Error("Session not found");
    return session.worktreePath;
  },
  async resolveTimeoutMs(validatorType) {
    const config = await readConfig();
    if (validatorType === "codex") {
      const codexConfig = config.codex;
      if (codexConfig?.enabled !== true) {
        throw new Error(
          "Codex validator is configured for this workflow, but Codex is disabled in global config",
        );
      }
      return resolveConfiguredTimeoutMs(codexConfig.timeoutMs);
    }
    return config.claudeTimeoutMs;
  },
  continuityService,
  executionRepository: workflowManager,
});
const implementerRunner = createGraphWorkflowImplementerRunner();
const validationService = createGraphWorkflowValidationService({
  runContextValidator: validatorRunner.runContextValidator,
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

      return deps.runScriptValidator({
        projectPath: input.projectPath,
        worktreePath: session.worktreePath,
        sessionName: input.sessionName,
        branchName: session.branchName,
        executionId: input.execution.id,
        contextId: input.contextId,
        targetBranch: scopingTargetBranch,
        timeoutMs,
        executionTarget: input.executionTarget,
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
  createToolServer: (input) => ({
    server: buildGraphWorkflowPortableMcp(
      input.projectName,
      input.sessionName,
      input.executionId,
      input.contextId,
    ),
  }),
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
      contextId: input.contextId,
      backend: input.backend,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      toolServer: input.toolServer,
      executionTarget: input.executionTarget,
    });
  },
  validationService,
  scriptValidatorService,
});
const mergeMutex = createPerSessionMergeMutex();
const sessionGitLock = createSessionGitLock();
const mergeRunner = createGraphWorkflowMergeRunner();
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
    tier?: "project" | "global";
    parameters?: Record<string, unknown>;
  }): Promise<GraphWorkflowExecution>;
  pauseExecution(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution>;
  resumeExecution(
    projectPath: string,
    sessionName: string,
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
  pauseExecution: (projectPath, sessionName) =>
    workflowManager.send(projectPath, sessionName, { type: "pause" }),
  resumeExecution: (projectPath, sessionName) =>
    workflowManager.resume(projectPath, sessionName),
  abortExecution: (projectPath, sessionName) =>
    workflowManager.send(projectPath, sessionName, { type: "abort" }),
  resetExecutionContext: (projectPath, sessionName, contextId) =>
    workflowManager.resetContext(projectPath, sessionName, contextId),
  archiveExecution: (projectPath, sessionName) =>
    executionRepository.archiveActive(projectPath, sessionName),
  async kickOffExecutionLoop(input) {
    await executionLoop.run(input);
  },
  getActiveExecution: (projectPath, sessionName) =>
    workflowManager.getActive(projectPath, sessionName),
  recordPendingHaltReason: (input) =>
    workflowManager.recordPendingHaltReason(input),
  drainAndHalt: (input) => workflowManager.drainAndHalt(input),
  recordApprovalDecision: (input) => approvalGateService.recordDecision(input),
  listArchivedExecutions: (projectPath, sessionName) =>
    listArchivedGraphWorkflowExecutions(projectPath, sessionName),
  getEventsTail: (executionId, limit) =>
    getGraphWorkflowEventsTail(executionId, limit),
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

  const projectPath = await deps.resolveProjectPath(projectName);
  if (!projectPath) {
    return {
      error: NextResponse.json(
        { error: "Project not found" } satisfies ApiError,
        { status: 404 },
      ),
    };
  }

  const session = await deps.getSession(projectPath, sessionName);
  if (!session) {
    return {
      error: NextResponse.json(
        { error: "Session not found" } satisfies ApiError,
        { status: 404 },
      ),
    };
  }

  return { projectName, projectPath, sessionName, session };
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
    return NextResponse.json({ error: message } satisfies ApiError, {
      status: 404,
    });
  }

  if (
    message.includes("already has an active graph workflow execution") ||
    message.startsWith("Only running graph workflow executions") ||
    message.includes("graph workflow executions can be resumed") ||
    message.startsWith("Reset only allowed") ||
    message.includes("is completed and cannot be reset")
  ) {
    return NextResponse.json({ error: message } satisfies ApiError, {
      status: 409,
    });
  }

  if (
    message.startsWith("Execution context") &&
    message.includes("not found")
  ) {
    return NextResponse.json({ error: message } satisfies ApiError, {
      status: 404,
    });
  }

  return NextResponse.json({ error: message } satisfies ApiError, {
    status: 500,
  });
}

export function createGraphWorkflowExecutionRouteHandlers(
  deps: GraphWorkflowExecutionRouteDeps = defaultDeps,
) {
  async function reportExecutionLoopFailure(input: {
    projectPath: string;
    sessionName: string;
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
    if (!active || isTerminalStatus(active.status)) {
      logger.error("graph-workflow.execution_loop_failed", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        phase: input.phase,
        haltReasonType: reason.type,
        hasActiveExecution: active !== null,
        executionStatus: active?.status ?? null,
      });
      return;
    }
    try {
      await deps.recordPendingHaltReason({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        reason,
      });
      await deps.drainAndHalt({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
      });
      logger.error("graph-workflow.execution_loop_failed", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        phase: input.phase,
        haltReasonType: reason.type,
        hasActiveExecution: true,
      });
    } catch (haltError) {
      logger.error("graph-workflow.execution_loop_failed", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        phase: input.phase,
        haltReasonType: reason.type,
        hasActiveExecution: true,
        haltError:
          haltError instanceof Error ? haltError.message : String(haltError),
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
        tier: parsed.data.tier,
        ...(parsed.data.parameters !== undefined
          ? { parameters: parsed.data.parameters }
          : {}),
      });
    } catch (error) {
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
      await reportExecutionLoopFailure({
        projectPath,
        sessionName,
        error,
        phase: "start",
      });
      return respondToManagerError(error);
    }

    try {
      void Promise.resolve(
        deps.kickOffExecutionLoop({
          projectPath,
          projectName: resolved.projectName,
          sessionName,
          execution,
        }),
      ).catch(async (error) => {
        logger.warn("graph-workflow.execution_loop_start_failed", {
          projectPath,
          sessionName,
          error: error instanceof Error ? error.message : String(error),
        });
        await reportExecutionLoopFailure({
          projectPath,
          sessionName,
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
    tier?: "project" | "global";
    parameters?: Record<string, unknown>;
  }): Promise<GraphWorkflowExecution> {
    const execution = await deps.startExecution({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      definitionId: input.definitionId,
      ...(input.tier !== undefined ? { tier: input.tier } : {}),
      ...(input.parameters !== undefined
        ? { parameters: input.parameters }
        : {}),
    });

    void Promise.resolve(
      deps.kickOffExecutionLoop({
        projectPath: input.projectPath,
        projectName: input.projectName,
        sessionName: input.sessionName,
        execution,
      }),
    ).catch(async (error) => {
      logger.warn("graph-workflow.execution_loop_start_failed", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        error: error instanceof Error ? error.message : String(error),
      });
      await reportExecutionLoopFailure({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
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
    if (!executionId) {
      return NextResponse.json({ events: [] });
    }

    const limitParam = url.searchParams.get("limit");
    const parsedLimit = limitParam !== null ? Number(limitParam) : NaN;
    const limit =
      Number.isInteger(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, GRAPH_WORKFLOW_EVENTS_MAX_LIMIT)
        : GRAPH_WORKFLOW_EVENTS_DEFAULT_LIMIT;

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
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }

    try {
      await deps.normalizeExecutionAfterRestart(
        resolved.projectPath,
        resolved.sessionName,
      );
      const execution = await deps.resumeExecution(
        resolved.projectPath,
        resolved.sessionName,
      );
      void Promise.resolve(
        deps.kickOffExecutionLoop({
          projectPath: resolved.projectPath,
          projectName: resolved.projectName,
          sessionName: resolved.sessionName,
          execution,
        }),
      ).catch(async (error) => {
        logger.warn("graph-workflow.execution_loop_resume_failed", {
          projectPath: resolved.projectPath,
          sessionName: resolved.sessionName,
          error: error instanceof Error ? error.message : String(error),
        });
        await reportExecutionLoopFailure({
          projectPath: resolved.projectPath,
          sessionName: resolved.sessionName,
          error,
          phase: "resume",
        });
      });
      return NextResponse.json({
        execution: summarizeExecution(execution, false),
      });
    } catch (error) {
      await reportExecutionLoopFailure({
        projectPath: resolved.projectPath,
        sessionName: resolved.sessionName,
        error,
        phase: "resume",
      });
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
      return NextResponse.json(
        {
          error: "Session does not have an active graph workflow execution",
        } satisfies ApiError,
        { status: 404 },
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
        return NextResponse.json(
          {
            error: "Session does not have an active graph workflow execution",
          } satisfies ApiError,
          { status: 404 },
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
    RESOLVE_APPROVAL,
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
    tier?: "project" | "global";
    parameters?: Record<string, unknown>;
  },
  deps: GraphWorkflowExecutionRouteDeps = defaultDeps,
): Promise<GraphWorkflowExecution> {
  return createGraphWorkflowExecutionRouteHandlers(deps).launch(input);
}

const defaultGraphWorkflowExecutionHandlers =
  createGraphWorkflowExecutionRouteHandlers();

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
export const resolveGraphWorkflowApproval = withTracing(
  defaultGraphWorkflowExecutionHandlers.RESOLVE_APPROVAL,
);
export const clearGraphWorkflowExecution = withTracing(
  defaultGraphWorkflowExecutionHandlers.CLEAR,
);
