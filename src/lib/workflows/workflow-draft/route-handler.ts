import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getErrorMessage } from "@/lib/shared/errors";
import { createLogger, withTracing } from "@/lib/logging";
import { assertGatewayAuthorization } from "./auth";

const logger = createLogger("workflow-draft-mcp");

type RouteParams = Promise<Record<string, string>>;
type RouteContext = { params: RouteParams };
type CreateServer = (
  request: Request,
  params: Record<string, string>,
) => Promise<McpServer>;

export class McpRouteError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "McpRouteError";
  }
}

function createJsonRpcErrorResponse(status: number): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Internal server error",
      },
      id: null,
    },
    { status },
  );
}

function isUnauthorizedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === "Unauthorized MCP gateway request"
  );
}

function isMcpRouteError(error: unknown): error is McpRouteError {
  return error instanceof McpRouteError;
}

function createMethodHandler(method: string, createServer: CreateServer) {
  return withTracing(async (request: Request, context: RouteContext) => {
    logger.info("request.start", {
      method,
      path: new URL(request.url).pathname,
    });

    try {
      assertGatewayAuthorization(request);
      const params = await context.params;
      const server = await createServer(request, params);
      const transport = new WebStandardStreamableHTTPServerTransport();

      await server.connect(transport);
      const response = await transport.handleRequest(request);

      logger.info("request.complete", {
        method,
        path: new URL(request.url).pathname,
        status: response.status,
      });
      return response;
    } catch (error) {
      if (isUnauthorizedError(error)) {
        logger.warn("request.auth_failed", {
          method,
          path: new URL(request.url).pathname,
        });
        return new Response("Unauthorized", { status: 401 });
      }

      if (isMcpRouteError(error)) {
        logger.warn("request.route_error", {
          method,
          path: new URL(request.url).pathname,
          status: error.status,
          error: error.message,
        });
        return createJsonRpcErrorResponse(error.status);
      }

      logger.error("request.error", {
        method,
        path: new URL(request.url).pathname,
        error: getErrorMessage(error),
      });
      return createJsonRpcErrorResponse(500);
    }
  });
}

export function createMcpRouteHandlers(createServer: CreateServer) {
  return {
    GET: createMethodHandler("GET", createServer),
    POST: createMethodHandler("POST", createServer),
    DELETE: createMethodHandler("DELETE", createServer),
  };
}
