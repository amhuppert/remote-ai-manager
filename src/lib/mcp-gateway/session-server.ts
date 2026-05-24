import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readConfig } from "@/lib/config/loader";
import { sendAgentNotification } from "@/lib/notifications/push";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { getSession, mutateConversation } from "@/lib/state-store";
import { registerNotificationTool } from "@/lib/notifications/agent-notification-tool";
import { registerAskUserQuestionTool } from "@/lib/conversations/ask-user-question-tool";
import {
  defaultCodexToolDeps,
  registerCodexTool,
} from "@/lib/agent-backends/codex/codex-tool";
import { registerReferenceDocumentTools } from "@/lib/reference-documents/tools";
import { registerDevServerTools } from "@/lib/dev-server/mcp-tools";
import { createSessionArtifactRegistryForProduction } from "@/lib/workflows/primitives/default-session-artifact-registry";
import { createWorkflowStorageService } from "@/lib/workflow-graph/storage";
import { registerPlannerTools } from "@/lib/workflow-graph/planner-tools";
import { getConversationRuntime } from "@/lib/workflows/conversation/runtime-state";
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
  "sessionName" | "worktreePath"
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
    registerPlannerTools(server, context, {
      readConfig,
      listWorkflows: storage.list,
      getWorkflow: storage.get,
      createWorkflow: storage.create,
      updateWorkflow: storage.update,
      deleteWorkflow: storage.delete,
      async getActiveExecution(projectPath, sessionName) {
        const session = await getSession(projectPath, sessionName);
        return session?.graphWorkflowExecution ?? null;
      },
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
    let timeoutMs: number | undefined;
    if (config.timeout === null) {
      timeoutMs = 0;
    } else if (config.timeout !== undefined) {
      timeoutMs = config.timeout * 1000;
    }

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
  registerDevServerTools,
};

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

  deps.registerDevServerTools(server, {
    projectPath,
    sessionName: session.sessionName,
  });

  return server;
}
