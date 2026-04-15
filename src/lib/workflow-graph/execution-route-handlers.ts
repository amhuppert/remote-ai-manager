import { NextResponse } from "next/server";
import { z } from "zod";
import { readConfig } from "@/lib/config";
import { createConversation, getConversation } from "@/lib/conversations";
import { createLogger } from "@/lib/logging";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/project-resolver";
import { getSession as defaultGetSession, mutateSession } from "@/lib/state";
import { getTaskRunner } from "@/lib/agent-backends/registry";
import type { AgentSessionRef } from "@/lib/agent-backends/types";
import type {
  ApiError,
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
  GraphWorkflowStatus,
  SessionState,
} from "@/types";
import { dispatchPushForGraphWorkflowEvent } from "@/lib/push-dispatcher";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
import { createGraphWorkflowExecutionRepository } from "./execution-repository";
import { createGraphWorkflowRuntimeEditService } from "./runtime-edits";
import { createGraphWorkflowSharedDocumentRegistryService } from "./shared-documents";
import { createGraphWorkflowValidationService } from "./execution-validation";
import { createValidatorRunner } from "./validator-runner";
import { emit as emitGraphWorkflowStreamFrame } from "./stream-registry";
import { createWorkflowStorageService } from "./storage";
import { createGraphWorkflowToolServer } from "@/lib/workflows/graph-workflow/tool-server";
import {
  createGraphWorkflowExecutionLoop,
  isExecutionLoopActive,
} from "@/lib/workflows/graph-workflow/execution-loop";
import { createGraphWorkflowIterationOrchestrator } from "@/lib/workflows/graph-workflow/iteration-orchestrator";
import { createGraphWorkflowManager } from "@/lib/workflows/graph-workflow/workflow-manager";
import { createWorkflowContinuityService } from "@/lib/workflows/graph-workflow/workflow-continuity-service";
import { createGraphWorkflowImplementerRunner } from "./implementer-runner";

type RouteContext = {
  params: Promise<Record<string, string>>;
};

const startExecutionSchema = z.object({
  definitionId: z.string().trim().min(1),
});

const logger = createLogger("graph-workflow-route-handlers");

const eventPublisher = createGraphWorkflowExecutionEventPublisher({
  dispatchPush: dispatchPushForGraphWorkflowEvent,
});

const executionRepository = createGraphWorkflowExecutionRepository({
  getSession: defaultGetSession,
  mutateSession,
  eventPublisher,
});

const workflowStorage = createWorkflowStorageService({ readConfig });

const workflowManager = createGraphWorkflowManager({
  executionRepository,
  loadDefinition: (projectPath, definitionId) =>
    workflowStorage.get(projectPath, definitionId),
  isExecutionLoopActive,
});
const runtimeEditService = createGraphWorkflowRuntimeEditService();
const sharedDocumentRegistry =
  createGraphWorkflowSharedDocumentRegistryService();
const CODEX_VALIDATOR_TIMEOUT_MS = 300_000;

// In-memory cache of agent session refs for task runner resume within iterations.
// Keyed by conversationId, stores the backendRef from the last task result.
const agentBackendRefCache = new Map<string, AgentSessionRef>();

const continuityService = createWorkflowContinuityService({
  createConversation,
  getConversation,
  startCodexThread: async () => ({ threadId: crypto.randomUUID() }),
  resumeCodexThread: async (threadId) => ({ threadId }),
});

const validatorRunner = createValidatorRunner({
  getTaskRunner,
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
      if (codexConfig.timeout === null) return 0;
      if (codexConfig.timeout !== undefined) return codexConfig.timeout * 1000;
      return CODEX_VALIDATOR_TIMEOUT_MS;
    }
    return config.claudeTimeoutMs;
  },
  continuityService,
  executionRepository,
});
const implementerRunner = createGraphWorkflowImplementerRunner();
const validationService = createGraphWorkflowValidationService({
  runTaskValidator: validatorRunner.runTaskValidator,
});
const iterationOrchestrator = createGraphWorkflowIterationOrchestrator({
  executionRepository,
  createConversation,
  continuityService,
  createToolServer: (input) => ({
    server: createGraphWorkflowToolServer({
      executionContextTitle: input.contextTitle,
      allowAgentTaskAdd: input.allowAgentTaskAdd,
      completeTask: input.completeTask,
      addTask: async (task) => {
        const execution = await executionRepository.getActive(
          input.projectPath,
          input.sessionName,
        );
        if (!execution) {
          throw new Error(
            "Session does not have an active graph workflow execution",
          );
        }

        const updated = runtimeEditService.applyAgentTaskAdd(
          execution,
          input.contextId,
          task,
        );
        await executionRepository.update(
          input.projectPath,
          input.sessionName,
          updated,
        );
        return updated;
      },
      upsertSharedDocument: async (document) => {
        const session = await defaultGetSession(
          input.projectPath,
          input.sessionName,
        );
        if (!session) {
          throw new Error("Session not found");
        }

        const execution = await executionRepository.getActive(
          input.projectPath,
          input.sessionName,
        );
        if (!execution) {
          throw new Error(
            "Session does not have an active graph workflow execution",
          );
        }

        const updated = sharedDocumentRegistry.upsert(
          session.worktreePath,
          execution,
          {
            ...document,
            conversationId: input.conversationId,
          },
        );
        await executionRepository.update(
          input.projectPath,
          input.sessionName,
          updated,
        );
        return updated;
      },
    }),
  }),
  runAgentIteration: async (input) => {
    const session = await defaultGetSession(
      input.projectPath,
      input.sessionName,
    );
    if (!session) {
      throw new Error("Session not found");
    }

    if (input.backend === "claude") {
      return implementerRunner.runClaudeIteration({
        projectPath: input.projectPath,
        session,
        prompt: input.prompt,
        conversationId: input.conversationId,
        contextId: input.contextId,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        toolServer: input.toolServer,
        emitStreamFrame: input.emitStreamFrame,
      });
    }

    const runner = getTaskRunner(input.backend ?? "claude");
    const resumeRef = agentBackendRefCache.get(input.conversationId) ?? null;
    const result = await runner.run({
      workingDirectory: session.worktreePath,
      prompt: input.prompt,
      modelId: input.model,
      reasoningEffort: input.reasoningEffort,
      autonomous: true,
      timeoutMs: 0,
      resumeRef,
      tooling:
        input.backend === "codex"
          ? undefined
          : { claudeSdkServers: { "graph-workflow": input.toolServer } },
    });

    if (result.backendRef) {
      agentBackendRefCache.set(input.conversationId, result.backendRef);
    }

    if (result.error) {
      throw new Error(result.error);
    }

    return {
      contextTokens: null,
      contextWindowMax: null,
    };
  },
  validationService,
  emitStreamFrame: emitGraphWorkflowStreamFrame,
});
const executionLoop = createGraphWorkflowExecutionLoop({
  workflowManager,
  iterationOrchestrator,
  emitStreamFrame: emitGraphWorkflowStreamFrame,
});

export interface GraphWorkflowExecutionSummary {
  executionId: string;
  definitionId: string;
  definitionRevision: number;
  status: GraphWorkflowStatus;
  startedAt: string;
  completedAt: string | null;
  activeContextId: string | null;
  activeContextTitle: string | null;
  haltReason: GraphWorkflowHaltReason | null;
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
  archiveExecution(projectPath: string, sessionName: string): Promise<void>;
  kickOffExecutionLoop(input: {
    projectPath: string;
    projectName: string;
    sessionName: string;
    execution: GraphWorkflowExecution;
  }): Promise<void>;
}

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
  archiveExecution: (projectPath, sessionName) =>
    executionRepository.archiveActive(projectPath, sessionName),
  async kickOffExecutionLoop(input) {
    await executionLoop.run(input);
  },
};

function isTerminalStatus(status: GraphWorkflowStatus): boolean {
  return status === "completed" || status === "halted" || status === "aborted";
}

function summarizeExecution(
  execution: GraphWorkflowExecution,
  archived: boolean,
): GraphWorkflowExecutionSummary {
  const activeContext = execution.activeContextId
    ? (execution.workingDefinition.executionContexts.find(
        (context) => context.id === execution.activeContextId,
      ) ?? null)
    : null;
  return {
    executionId: execution.id,
    definitionId: execution.seedDefinitionId,
    definitionRevision: execution.seedDefinitionRevision,
    status: execution.status,
    startedAt: execution.startedAt,
    completedAt: execution.completedAt,
    activeContextId: execution.activeContextId,
    activeContextTitle: activeContext?.title ?? null,
    haltReason: execution.haltReason,
    archived,
  };
}

function summarizeHistory(
  session: SessionState,
): GraphWorkflowExecutionSummary[] {
  const items = session.graphWorkflowExecutionHistory.map((execution) =>
    summarizeExecution(execution, true),
  );

  if (
    session.graphWorkflowExecution &&
    isTerminalStatus(session.graphWorkflowExecution.status)
  ) {
    items.push(summarizeExecution(session.graphWorkflowExecution, false));
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

function respondToManagerError(error: unknown): Response {
  const message =
    error instanceof Error ? error.message : "Graph workflow request failed";

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
    message.includes("graph workflow executions can be resumed")
  ) {
    return NextResponse.json({ error: message } satisfies ApiError, {
      status: 409,
    });
  }

  return NextResponse.json({ error: message } satisfies ApiError, {
    status: 500,
  });
}

export function createGraphWorkflowExecutionRouteHandlers(
  deps: GraphWorkflowExecutionRouteDeps = defaultDeps,
) {
  async function START(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }

    const { projectPath, sessionName, session } = resolved;

    const parsed = startExecutionSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid request: definitionId is required",
        } satisfies ApiError,
        { status: 400 },
      );
    }

    if (session.graphWorkflowExecution) {
      if (isTerminalStatus(session.graphWorkflowExecution.status)) {
        await deps.archiveExecution(projectPath, sessionName);
      } else {
        return NextResponse.json(
          {
            error: `Session "${sessionName}" already has an active graph workflow execution`,
          } satisfies ApiError,
          { status: 409 },
        );
      }
    }

    try {
      const execution = await deps.startExecution({
        projectPath,
        sessionName,
        definitionId: parsed.data.definitionId,
      });
      void Promise.resolve(
        deps.kickOffExecutionLoop({
          projectPath,
          projectName: resolved.projectName,
          sessionName,
          execution,
        }),
      ).catch((error) => {
        logger.warn("graph-workflow.execution_loop_start_failed", {
          projectPath,
          sessionName,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return NextResponse.json(
        { execution: summarizeExecution(execution, false) },
        { status: 202 },
      );
    } catch (error) {
      return respondToManagerError(error);
    }
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
      normalizedExecution ?? resolved.session.graphWorkflowExecution;

    return NextResponse.json({
      execution: execution ? summarizeExecution(execution, false) : null,
      archivedExecutions: resolved.session.graphWorkflowExecutionHistory.map(
        (entry) => summarizeExecution(entry, true),
      ),
    });
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
      items: summarizeHistory(resolved.session),
    });
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
      ).catch((error) => {
        logger.warn("graph-workflow.execution_loop_resume_failed", {
          projectPath: resolved.projectPath,
          sessionName: resolved.sessionName,
          error: error instanceof Error ? error.message : String(error),
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
      return NextResponse.json({
        execution: summarizeExecution(execution, false),
      });
    } catch (error) {
      return respondToManagerError(error);
    }
  }

  async function CLEAR(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }

    const { session } = resolved;
    if (
      !session.graphWorkflowExecution ||
      !isTerminalStatus(session.graphWorkflowExecution.status)
    ) {
      return NextResponse.json(
        {
          error:
            "Only completed, halted, or aborted graph workflow executions can be cleared",
        } satisfies ApiError,
        { status: 409 },
      );
    }

    await deps.archiveExecution(resolved.projectPath, resolved.sessionName);
    return NextResponse.json({ cleared: true });
  }

  return {
    START,
    STATUS,
    HISTORY,
    PAUSE,
    RESUME,
    ABORT,
    CLEAR,
  };
}
