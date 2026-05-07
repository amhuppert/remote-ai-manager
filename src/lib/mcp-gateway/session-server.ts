import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readConfig } from "@/lib/config";
import { sendAgentNotification } from "@/lib/push-notification";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession, mutateConversation } from "@/lib/state";
import { registerNotificationTool } from "@/lib/agent-notification-tool";
import { registerAskUserQuestionTool } from "@/lib/ask-user-question-tool";
import { registerCodexTool } from "@/lib/codex-tool";
import { registerReferenceDocumentTools } from "@/lib/reference-document-tools";
import { registerRoadmapTools } from "@/lib/roadmap-tools";
import { createWorkflowStorageService } from "@/lib/workflow-graph/storage";
import { registerPlannerTools } from "@/lib/workflow-graph/planner-tools";
import { getConversationRuntime } from "@/lib/workflows/conversation/runtime-state";
import type { GlobalConfig, SessionState } from "@/types";
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
  registerRoadmapTools(
    server: McpServer,
    context: { projectPath: string },
  ): void;
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
    context: { worktreePath: string; sessionName: string },
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
}

const defaultSessionMcpServerDeps: SessionMcpServerDeps = {
  resolveProjectPath,
  getSession,
  readConfig,
  registerRoadmapTools,
  registerReferenceDocumentTools,
  registerPlannerTools(server, context) {
    const storage = createWorkflowStorageService({ readConfig });
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

    registerCodexTool(server, {
      ...context,
      defaultModel: config.model,
      defaultReasoningEffort: config.reasoningEffort,
      timeoutMs,
    });
  },
  registerAskUserQuestionTool(server, context) {
    registerAskUserQuestionTool(server, context, {
      getRuntime: getConversationRuntime,
      mutateConversation,
    });
  },
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

  deps.registerRoadmapTools(server, { projectPath });
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

  return server;
}
