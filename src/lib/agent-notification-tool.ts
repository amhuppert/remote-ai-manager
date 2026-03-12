import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getErrorMessage } from "@/lib/errors";
import { createLogger } from "@/lib/logging";

const logger = createLogger("agent-notification-tool");

export interface NotificationToolContext {
  projectName: string;
  sessionName: string;
}

export interface NotificationToolDeps {
  sendNotification: (
    title: string,
    message: string,
    tags: string,
  ) => Promise<void>;
}

/**
 * Creates an in-process MCP server with a send_notification tool.
 * Only registered when push notifications are configured (enabled + topic set).
 */
export function createNotificationToolServer(
  context: NotificationToolContext,
  deps: NotificationToolDeps,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "agent-notification",
    version: "1.0.0",
    tools: [
      tool(
        "send_notification",
        "Send a push notification to the user's phone. Use this to notify when long-running tasks complete or when the user asked to be notified.",
        {
          title: z.string().min(1).describe("Short notification title"),
          message: z.string().min(1).describe("Notification body text"),
          tags: z
            .string()
            .optional()
            .describe(
              "Emoji tag name for ntfy (e.g. 'white_check_mark', 'warning'). Defaults to 'robot'",
            ),
        },
        async (args) => {
          const tags = args.tags ?? "robot";
          try {
            await deps.sendNotification(args.title, args.message, tags);

            logger.info("tool.send_notification", {
              title: args.title,
              projectName: context.projectName,
              sessionName: context.sessionName,
            });

            return {
              content: [
                {
                  type: "text" as const,
                  text: `Notification sent: "${args.title}"`,
                },
              ],
            };
          } catch (error) {
            logger.error("tool.send_notification.error", {
              error: getErrorMessage(error),
            });
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Failed to send notification: ${getErrorMessage(error)}`,
                },
              ],
              isError: true,
            };
          }
        },
      ),
    ],
  });
}
