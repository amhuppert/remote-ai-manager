import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  AmbiguousDevServerError,
  DevServerStartFailedError,
  DevServerWaitTimeoutError,
  NoDevServersConfiguredError,
  SessionNotFoundError,
  UnknownDevServerError,
  createDevServerService,
  defaultDevServerServiceDeps,
  type DevServerService,
  type DevServerStatusItem,
} from "./service";

const logger = createLogger("dev-server-mcp-tools");

export interface DevServerToolContext {
  projectPath: string;
  sessionName: string;
  /**
   * Worktree the dev server should run in. For an ordinary session this is the
   * session worktree; for a graph-workflow lane conversation it is the lane
   * worktree, so lane dev servers are spawned in and keyed by their own
   * worktree rather than the parent session's.
   */
  worktreePath: string;
}

const ensureDevServerInputSchema = {
  name: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Server name from CommandCenter.json devServers. Omit when only one server is configured.",
    ),
  wait: z
    .boolean()
    .optional()
    .describe(
      "Wait for the server to reach running state before returning (default true).",
    ),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum wait time in milliseconds (default 60000)."),
};

const stopDevServerInputSchema = {
  name: z.string().min(1).describe("Server name to stop."),
};

interface ErrorPayload {
  code: string;
  message: string;
  availableNames?: string[];
  recentOutput?: string[];
  lastStatus?: string;
  timeoutMs?: number;
}

function jsonText(payload: unknown) {
  return {
    type: "text" as const,
    text: JSON.stringify(payload, null, 2),
  };
}

function errorResponse(payload: ErrorPayload) {
  return {
    content: [jsonText({ error: payload })],
    isError: true,
  };
}

function classifyError(error: unknown): ErrorPayload {
  if (error instanceof AmbiguousDevServerError) {
    return {
      code: error.code,
      message: error.message,
      availableNames: error.availableNames,
    };
  }
  if (error instanceof NoDevServersConfiguredError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof UnknownDevServerError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof SessionNotFoundError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof DevServerStartFailedError) {
    return {
      code: error.code,
      message: error.message,
      recentOutput: error.recentOutput,
    };
  }
  if (error instanceof DevServerWaitTimeoutError) {
    return {
      code: error.code,
      message: error.message,
      timeoutMs: error.timeoutMs,
      lastStatus: error.lastStatus,
    };
  }
  return { code: "DEV_SERVER_ERROR", message: getErrorMessage(error) };
}

function createGetHandler(
  context: DevServerToolContext,
  service: DevServerService,
) {
  return async () => {
    try {
      const servers = await service.list({
        projectPath: context.projectPath,
        sessionName: context.sessionName,
        worktreePath: context.worktreePath,
      });
      return {
        content: [
          jsonText({ servers } satisfies { servers: DevServerStatusItem[] }),
        ],
      };
    } catch (error) {
      logger.error("dev-server.tool.list.error", {
        sessionName: context.sessionName,
        error: getErrorMessage(error),
      });
      return errorResponse(classifyError(error));
    }
  };
}

function createEnsureHandler(
  context: DevServerToolContext,
  service: DevServerService,
) {
  return async (args: {
    name?: string;
    wait?: boolean;
    timeout_ms?: number;
  }) => {
    try {
      const ensureParams: Parameters<DevServerService["ensure"]>[0] = {
        projectPath: context.projectPath,
        sessionName: context.sessionName,
        worktreePath: context.worktreePath,
      };
      if (args.name !== undefined) ensureParams.serverName = args.name;
      if (args.wait !== undefined) ensureParams.wait = args.wait;
      if (args.timeout_ms !== undefined)
        ensureParams.timeoutMs = args.timeout_ms;

      const server = await service.ensure(ensureParams);
      return {
        content: [
          jsonText({ server } satisfies { server: DevServerStatusItem }),
        ],
      };
    } catch (error) {
      logger.warn("dev-server.tool.ensure.error", {
        sessionName: context.sessionName,
        serverName: args.name,
        error: getErrorMessage(error),
      });
      return errorResponse(classifyError(error));
    }
  };
}

function createStopHandler(
  context: DevServerToolContext,
  service: DevServerService,
) {
  return async (args: { name: string }) => {
    try {
      const server = await service.stop({
        projectPath: context.projectPath,
        sessionName: context.sessionName,
        worktreePath: context.worktreePath,
        serverName: args.name,
      });
      return {
        content: [
          jsonText({ server } satisfies {
            server: DevServerStatusItem | null;
          }),
        ],
      };
    } catch (error) {
      logger.warn("dev-server.tool.stop.error", {
        sessionName: context.sessionName,
        serverName: args.name,
        error: getErrorMessage(error),
      });
      return errorResponse(classifyError(error));
    }
  };
}

export function registerDevServerTools(
  server: McpServer,
  context: DevServerToolContext,
  service: DevServerService = createDevServerService(
    defaultDevServerServiceDeps,
  ),
): void {
  server.registerTool(
    "get_dev_servers",
    {
      description:
        "List dev servers configured for this session, with reconciled runtime status (status, port, localUrl, remoteUrl, ownedByThisSession, source, logFilePath). `logFilePath` points to the interleaved stdout/stderr log on disk (truncated per spawn) — read it when diagnosing startup failures or runtime errors. Call this before assuming a server is running.",
      inputSchema: {},
    },
    createGetHandler(context, service),
  );

  server.registerTool(
    "ensure_dev_server",
    {
      description:
        "Ensure a dev server for this session worktree is running. Adopts an existing owned server, starts a stopped/errored one, or waits for an already-starting one. Returns the localUrl, remoteUrl, and logFilePath to use. `logFilePath` is the interleaved stdout/stderr log on disk (truncated per spawn) — read it when diagnosing startup failures. Always call this before driving Playwright, browser, visual, or Next.js MCP tools — do not assume ports like 3000 or 6006 belong to your worktree.",
      inputSchema: ensureDevServerInputSchema,
    },
    createEnsureHandler(context, service),
  );

  server.registerTool(
    "stop_dev_server",
    {
      description:
        "Stop a named dev server for this session. Verifies worktree ownership before signalling, so externally owned listeners are never killed.",
      inputSchema: stopDevServerInputSchema,
    },
    createStopHandler(context, service),
  );
}
