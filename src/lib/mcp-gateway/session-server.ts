import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readConfig } from "@/lib/config/loader";
import { sendAgentNotification } from "@/lib/notifications/push";
import { resolveProjectPath } from "@/lib/projects/resolver";
import {
  getSession,
  getActiveGraphWorkflowExecution,
  mutateConversation,
} from "@/lib/state-store";
import { registerNotificationTool } from "@/lib/notifications/agent-notification-tool";
import { registerAskUserQuestionTool } from "@/lib/conversations/ask-user-question-tool";
import { registerSessionAlignmentTools } from "@/lib/session-alignment/tools";
import { createSessionAlignmentServiceForProduction } from "@/lib/session-alignment/service-factory";
import {
  defaultCodexToolDeps,
  registerCodexTool,
} from "@/lib/agent-backends/codex/codex-tool";
import { registerReferenceDocumentTools } from "@/lib/reference-documents/tools";
import { registerDevServerTools } from "@/lib/dev-server/mcp-tools";
import { createSessionArtifactRegistryForProduction } from "@/lib/workflows/primitives/default-session-artifact-registry";
import { resolveConfiguredTimeoutMs } from "@/lib/agent-backends/timeout";
import { createWorkflowStorageService } from "@/lib/workflow-graph/storage";
import { createGraphWorkflowExecutionEventPublisher } from "@/lib/workflow-graph/execution-events";
import { registerPlannerTools } from "@/lib/workflow-graph/planner-tools";
import {
  registerStartGraphWorkflowTool,
  type StartGraphWorkflowToolContext,
} from "@/lib/workflow-graph/start-graph-workflow-tool";
import {
  registerListTemplatesTool,
  type ListTemplatesToolContext,
} from "@/lib/workflow-graph/list-templates-tool";
import { createTemplateLibraryService } from "@/lib/workflow-graph/template-library-service";
import { getConversationRuntime } from "@/lib/workflows/conversation/runtime-state";
import { isProjectSentinel } from "@/lib/conversations/project-conversation-scope";
import type { GlobalConfig } from "@/lib/config/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import { McpRouteError } from "./route-handler";

export interface SessionMcpServerParams {
  name: string;
  session: string;
  conversationId: string;
}

interface SessionWithConversations extends Pick<
  SessionState,
  "sessionName" | "worktreePath" | "creationMode"
> {
  conversations: ReadonlyArray<{ id: string }>;
}

export interface SessionMcpServerDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionWithConversations | null>;
  readConfig(): Promise<GlobalConfig>;
  registerReferenceDocumentTools(
    server: McpServer,
    context: {
      projectPath: string;
      sessionName: string;
      worktreePath: string;
    },
  ): void;
  registerPlannerTools(
    server: McpServer,
    context: { projectPath: string; sessionName: string },
  ): void;
  registerStartGraphWorkflowTool(
    server: McpServer,
    context: StartGraphWorkflowToolContext,
  ): void;
  registerListTemplatesTool(
    server: McpServer,
    context: ListTemplatesToolContext,
  ): void;
  registerNotificationTool(
    server: McpServer,
    context: { projectName: string; sessionName: string },
  ): void;
  registerCodexTool(
    server: McpServer,
    context: {
      projectPath: string;
      worktreePath: string;
      sessionName: string;
    },
    config: NonNullable<GlobalConfig["codex"]>,
  ): void;
  registerAskUserQuestionTool(
    server: McpServer,
    context: {
      projectPath: string;
      sessionName: string;
      conversationId: string;
    },
  ): void;
  registerSessionAlignmentTools(
    server: McpServer,
    context: {
      projectPath: string;
      sessionName: string;
      conversationId: string;
    },
  ): void;
  registerDevServerTools(
    server: McpServer,
    context: { projectPath: string; sessionName: string },
  ): void;
}

const defaultSessionMcpServerDeps: SessionMcpServerDeps = {
  resolveProjectPath,
  getSession,
  readConfig,
  registerReferenceDocumentTools,
  registerPlannerTools(server, context) {
    const storage = createWorkflowStorageService();
    const eventPublisher = createGraphWorkflowExecutionEventPublisher();
    registerPlannerTools(server, context, {
      readConfig,
      // list/delete operate on this project's library. create/replace/get take a
      // scope the handler derives from the tool's `tier` arg, so they can target
      // either this project's library or the cross-project global template tier.
      listWorkflows: (projectPath) =>
        storage.list({ kind: "project", projectPath }),
      getWorkflow: (scope, workflowId) => storage.get(scope, workflowId),
      createWorkflow: (scope, draft) => storage.create(scope, draft),
      updateWorkflow: (scope, workflowId, draft) =>
        storage.update(scope, workflowId, draft),
      deleteWorkflow: (projectPath, workflowId) =>
        storage.delete({ kind: "project", projectPath }, workflowId),
      async getActiveExecution(projectPath, sessionName) {
        return getActiveGraphWorkflowExecution(projectPath, sessionName);
      },
      publishCharterUpdated: eventPublisher.publishCharterUpdated,
    });
  },
  registerStartGraphWorkflowTool(server, context) {
    registerStartGraphWorkflowTool(server, context, {
      // Bind the production start+kickoff seam lazily. A static import would
      // close an init cycle: execution-route-handlers → implementer-runner →
      // sdk-driver → agent-backends/registry → conversation-runtime →
      // session-server. Loading the seam at tool-call time keeps the module
      // graph acyclic while sharing the same production singletons.
      async startWorkflow(input) {
        const { launchGraphWorkflowExecution } =
          await import("@/lib/workflow-graph/execution-route-handlers");
        return launchGraphWorkflowExecution({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          // The execution loop derives lane provisioning from the project name;
          // fall back to the directory name when the caller did not thread it.
          projectName: input.projectName ?? path.basename(input.projectPath),
          definitionId: input.definitionId,
          tier: input.tier,
          ...(input.parameters !== undefined
            ? { parameters: input.parameters }
            : {}),
        });
      },
    });
  },
  registerListTemplatesTool(server, context) {
    const library = createTemplateLibraryService();
    registerListTemplatesTool(server, context, {
      listTemplates: (projectPath) => library.list(projectPath),
    });
  },
  registerNotificationTool(server, context) {
    registerNotificationTool(server, context, {
      async sendNotification(title, message, tags) {
        const config = await readConfig();
        const pushConfig = config.pushNotification;
        if (!pushConfig || pushConfig.enabled !== true) {
          throw new Error("Push notifications are not configured");
        }

        await sendAgentNotification(
          pushConfig,
          title,
          message,
          tags,
          context.projectName,
          context.sessionName,
        );
      },
    });
  },
  registerCodexTool(server, context, config) {
    const timeoutMs = resolveConfiguredTimeoutMs(config.timeoutMs);

    const artifactRegistry = createSessionArtifactRegistryForProduction({
      projectPath: context.projectPath,
      sessionName: context.sessionName,
    });

    registerCodexTool(
      server,
      {
        worktreePath: context.worktreePath,
        sessionName: context.sessionName,
        defaultModel: config.model,
        defaultReasoningEffort: config.reasoningEffort,
        timeoutMs,
      },
      { ...defaultCodexToolDeps, artifactRegistry },
    );
  },
  registerAskUserQuestionTool(server, context) {
    registerAskUserQuestionTool(server, context, {
      getRuntime: getConversationRuntime,
      mutateConversation,
    });
  },
  registerSessionAlignmentTools(server, context) {
    const service = getSessionAlignmentService();
    registerSessionAlignmentTools(server, context, {
      getRuntime: getConversationRuntime,
      beginDraft: service.beginDraft,
      fillDraft: service.fillDraft,
      proposeDecisions: service.proposeDecisions,
    });
  },
  registerDevServerTools,
};

// The production alignment service binds a repo over the live DB; build it once
// on first use rather than at module load so importing this module never opens
// the database.
let sessionAlignmentService: ReturnType<
  typeof createSessionAlignmentServiceForProduction
> | null = null;
function getSessionAlignmentService() {
  sessionAlignmentService ??= createSessionAlignmentServiceForProduction();
  return sessionAlignmentService;
}

function isNotificationEnabled(config: GlobalConfig): boolean {
  return (
    config.pushNotification?.enabled === true &&
    config.pushNotification.topic.trim().length > 0
  );
}

export async function createSessionMcpServer(
  params: SessionMcpServerParams,
  deps: SessionMcpServerDeps = defaultSessionMcpServerDeps,
): Promise<McpServer> {
  const projectPath = await deps.resolveProjectPath(params.name);
  if (!projectPath) {
    throw new McpRouteError(404, "Project not found");
  }

  // Session-less project conversation: there is no session row to load, the
  // turn runs in the repo-root (main) worktree, and the main-worktree guard
  // forbids dev-server tooling. Register only the project-safe tool surface
  // (AskUserQuestion, routed scope-aware via the sentinel) and skip the
  // session-scoped tools (reference docs, planner/graph-workflow, codex) and
  // dev-server tools entirely.
  if (isProjectSentinel(params.session)) {
    const projectServer = new McpServer({
      name: "cc-session-tools",
      version: "1.0.0",
    });
    deps.registerAskUserQuestionTool(projectServer, {
      projectPath,
      sessionName: params.session,
      conversationId: params.conversationId,
    });
    return projectServer;
  }

  const session = await deps.getSession(projectPath, params.session);
  if (!session) {
    throw new McpRouteError(404, "Session not found");
  }

  const conversation = session.conversations.find(
    (c) => c.id === params.conversationId,
  );
  if (!conversation) {
    throw new McpRouteError(404, "Conversation not found");
  }

  const config = await deps.readConfig();
  const server = new McpServer({
    name: "cc-session-tools",
    version: "1.0.0",
  });

  deps.registerReferenceDocumentTools(server, {
    projectPath,
    sessionName: session.sessionName,
    worktreePath: session.worktreePath,
  });
  deps.registerPlannerTools(server, {
    projectPath,
    sessionName: session.sessionName,
  });
  deps.registerStartGraphWorkflowTool(server, {
    projectPath,
    sessionName: session.sessionName,
    projectName: params.name,
  });
  deps.registerListTemplatesTool(server, {
    projectPath,
    sessionName: session.sessionName,
  });

  if (isNotificationEnabled(config)) {
    deps.registerNotificationTool(server, {
      projectName: params.name,
      sessionName: session.sessionName,
    });
  }

  if (config.codex?.enabled === true) {
    deps.registerCodexTool(
      server,
      {
        projectPath,
        worktreePath: session.worktreePath,
        sessionName: session.sessionName,
      },
      config.codex,
    );
  }

  deps.registerAskUserQuestionTool(server, {
    projectPath,
    sessionName: session.sessionName,
    conversationId: params.conversationId,
  });

  // Alignment is for attended normal sessions only. The project sentinel
  // early-returns above (no alignment for project conversations); optimistic
  // sessions are excluded here so the tools never appear on an autonomous
  // session's surface.
  if (session.creationMode === "normal") {
    deps.registerSessionAlignmentTools(server, {
      projectPath,
      sessionName: session.sessionName,
      conversationId: params.conversationId,
    });
  }

  deps.registerDevServerTools(server, {
    projectPath,
    sessionName: session.sessionName,
  });

  return server;
}
