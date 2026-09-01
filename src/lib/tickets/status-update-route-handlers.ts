import type { OptionalTokenValidation } from "@/lib/agent-gateway/token";
import { createAgentAuth } from "@/lib/agent-gateway/token";
import type { ApiError } from "@/lib/api/errors";
import type { ConversationListItem } from "@/lib/conversations/schemas";
import { findConversationById } from "@/lib/conversations/cross-project-list";
import { createLogger, withTracing } from "@/lib/logging";
import { notFound } from "@/lib/shared/route-resolution";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getTicketStatusUpdateServiceInputSchema,
  listTicketStatusUpdatesServiceInputSchema,
  postTicketStatusUpdateServiceInputSchema,
  type TicketStatusUpdateService,
} from "./status-update-service";
import { getTicketStatusUpdateService } from "./service-factory";
import { formatTicketIdentifier } from "./references";
import {
  jsonBodyOrNull,
  resolveIdentity,
  ticketErrorResponse,
  ticketResponse,
  validationFailedResponse,
  type RouteContext,
} from "./route-handlers";
import {
  STATUS_UPDATE_ACTOR_RATIONALE,
  ticketStatusUpdateAuthorSchema,
  type TicketStatusUpdateAuthor,
} from "./schemas";
import { toTicketValidationIssues } from "./service";
import {
  decodeTicketKeysetCursor,
  normalizeTicketPageLimit,
} from "./ticket-keyset-cursor";

const logger = createLogger("tickets.status-updates.routes");

export interface TicketStatusUpdateRouteDeps {
  getService(): TicketStatusUpdateService;
  validateOptionalToken(request: Request): Promise<OptionalTokenValidation>;
  findConversationById(
    conversationId: string,
  ): Promise<ConversationListItem | null>;
}

export interface TicketStatusUpdateRouteHandlers {
  indexGET(request: Request, context: RouteContext): Promise<Response>;
  postPOST(request: Request, context: RouteContext): Promise<Response>;
  resolveGET(request: Request, context: RouteContext): Promise<Response>;
}

const limitQuerySchema = z.string().transform((value, context) => {
  const limit = normalizeTicketPageLimit(value);
  if (limit !== null) return limit;
  context.addIssue({
    code: "custom",
    message: "limit must be an integer from 1 through 100",
  });
  return z.NEVER;
});

const cursorQuerySchema = z
  .string()
  .min(1)
  .refine((value) => decodeTicketKeysetCursor(value) !== null, {
    message: "cursor must be a valid ticket keyset cursor",
  });

const statusUpdateListQuerySchema = z
  .object({
    limit: limitQuerySchema.optional(),
    cursor: cursorQuerySchema.optional(),
  })
  .strict();

const statusUpdatePostBodySchema = postTicketStatusUpdateServiceInputSchema
  .pick({ bodyMarkdown: true })
  .strict();

function strictQueryObject(request: Request): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [key, value] of new URL(request.url).searchParams) {
    const existing = values[key];
    values[key] =
      existing === undefined
        ? value
        : Array.isArray(existing)
          ? [...existing, value]
          : [existing, value];
  }
  return values;
}

function invalidTokenResponse(): Response {
  return NextResponse.json(
    { error: "Invalid Command Center API token" } satisfies ApiError,
    { status: 401 },
  );
}

function validationResponse(error: z.ZodError, operation: string): Response {
  logger.info("tickets.status_updates.routes.request_rejected", {
    operation,
    errorCode: "validation_failed",
    issueCount: error.issues.length,
  });
  const issues = error.issues.flatMap((issue) => {
    if (issue.code !== "unrecognized_keys") {
      return toTicketValidationIssues(new z.ZodError([issue]));
    }
    const parentPath = issue.path.map(String);
    return issue.keys.map((key) => ({
      path: [...parentPath, key].join("."),
      message: `Unrecognized key: "${key}"`,
    }));
  });
  return validationFailedResponse(issues);
}

function agentAuthor(
  conversation: ConversationListItem,
): TicketStatusUpdateAuthor {
  const shared = {
    kind: "agent" as const,
    conversationId: conversation.conversationId,
    conversationName: conversation.conversationName,
    projectName: conversation.projectName,
    backend: conversation.backend,
    redactedProfileSnapshot:
      conversation.redactedProfileSnapshot === undefined
        ? null
        : conversation.redactedProfileSnapshot,
  };
  return ticketStatusUpdateAuthorSchema.parse(
    conversation.scope === "session"
      ? {
          ...shared,
          scope: "session",
          sessionName: conversation.sessionName,
        }
      : { ...shared, scope: "project" },
  );
}

export function createTicketStatusUpdateRouteHandlers(
  deps: TicketStatusUpdateRouteDeps = defaultDeps(),
): TicketStatusUpdateRouteHandlers {
  async function authenticate(
    request: Request,
    operation: string,
  ): Promise<OptionalTokenValidation | Response> {
    const token = await deps.validateOptionalToken(request);
    if (token.kind !== "invalid") return token;
    logger.info("tickets.status_updates.routes.request_rejected", {
      operation,
      errorCode: "invalid_token",
    });
    return invalidTokenResponse();
  }

  async function statusUpdateIdentity(context: RouteContext) {
    const identity = await resolveIdentity(context);
    const params = await context.params;
    return { ...identity, updateId: params["updateId"] ?? "" };
  }

  async function resolveAuthor(
    token: OptionalTokenValidation,
    request: Request,
  ): Promise<TicketStatusUpdateAuthor | Response> {
    if (token.kind === "absent") return { kind: "user" };

    const conversationId =
      request.headers.get("x-cc-conversation-id")?.trim() ?? "";
    if (conversationId === "") {
      logger.info("tickets.status_updates.routes.request_rejected", {
        operation: "post",
        errorCode: "status_update_actor_required",
      });
      return ticketErrorResponse({
        code: "status_update_actor_required",
        details: {},
        rationale: STATUS_UPDATE_ACTOR_RATIONALE,
      });
    }

    const conversation = await deps.findConversationById(conversationId);
    if (conversation === null) {
      logger.info("tickets.status_updates.routes.request_rejected", {
        operation: "post",
        conversationId,
        errorCode: "status_update_actor_not_found",
      });
      return ticketErrorResponse({
        code: "status_update_actor_not_found",
        details: { conversationId },
        rationale: STATUS_UPDATE_ACTOR_RATIONALE,
      });
    }

    logger.debug("tickets.status_updates.routes.actor_resolved", {
      conversationId: conversation.conversationId,
      projectName: conversation.projectName,
      scope: conversation.scope,
      ...(conversation.scope === "session"
        ? { sessionName: conversation.sessionName }
        : {}),
      backend: conversation.backend,
      profilePresent: conversation.redactedProfileSnapshot != null,
    });
    return agentAuthor(conversation);
  }

  return {
    async indexGET(request, context) {
      const token = await authenticate(request, "list");
      if (token instanceof Response) return token;
      const query = statusUpdateListQuerySchema.safeParse(
        strictQueryObject(request),
      );
      if (!query.success) return validationResponse(query.error, "list");
      const input = listTicketStatusUpdatesServiceInputSchema.safeParse({
        ...(await resolveIdentity(context)),
        ...query.data,
      });
      if (!input.success) return validationResponse(input.error, "list");
      const result = await deps.getService().list(input.data);
      if (result.ok) {
        logger.debug("tickets.status_updates.routes.list_served", {
          projectName: input.data.projectName,
          number: input.data.number,
          pageSize: input.data.limit,
          cursorPresent: input.data.cursor !== undefined,
          returnedCount: result.value.items.length,
          total: result.value.total,
        });
      }
      return ticketResponse(result);
    },

    async postPOST(request, context) {
      const token = await authenticate(request, "post");
      if (token instanceof Response) return token;
      const author = await resolveAuthor(token, request);
      if (author instanceof Response) return author;
      const body = await jsonBodyOrNull(request);
      if (body === null) {
        return validationFailedResponse([
          { path: "", message: "request body must be a JSON object" },
        ]);
      }
      const parsedBody = statusUpdatePostBodySchema.safeParse(body);
      if (!parsedBody.success) {
        return validationResponse(parsedBody.error, "post");
      }
      const input = postTicketStatusUpdateServiceInputSchema.safeParse({
        ...(await resolveIdentity(context)),
        ...parsedBody.data,
        author,
      });
      if (!input.success) return validationResponse(input.error, "post");
      const result = await deps.getService().post(input.data);
      if (result.ok) {
        logger.info("tickets.status_updates.routes.post_served", {
          projectName: input.data.projectName,
          number: input.data.number,
          ticketId: result.value.ticket.id,
          updateId: result.value.update.id,
          authorKind: result.value.update.author.kind,
        });
      }
      return ticketResponse(result, 201);
    },

    async resolveGET(request, context) {
      const token = await authenticate(request, "get");
      if (token instanceof Response) return token;
      const input = getTicketStatusUpdateServiceInputSchema.safeParse(
        await statusUpdateIdentity(context),
      );
      if (!input.success) return validationResponse(input.error, "get");
      const result = await deps.getService().get(input.data);
      if (!result.ok) return ticketErrorResponse(result.error);
      if (result.value === null) {
        const identifier = formatTicketIdentifier(
          input.data.projectName,
          input.data.number,
        );
        return notFound(
          `Status update not found on ${identifier}: ${input.data.updateId}`,
          "status_update_not_found",
          { identifier, updateId: input.data.updateId },
        );
      }
      logger.debug("tickets.status_updates.routes.get_served", {
        projectName: input.data.projectName,
        number: input.data.number,
        ticketId: result.value.ticketId,
        updateId: result.value.id,
        authorKind: result.value.author.kind,
      });
      return NextResponse.json(result.value);
    },
  };
}

function defaultDeps(): TicketStatusUpdateRouteDeps {
  const auth = createAgentAuth();
  return {
    getService: () => getTicketStatusUpdateService(),
    validateOptionalToken(request) {
      return auth.validateOptionalToken(request);
    },
    findConversationById(conversationId) {
      return findConversationById(conversationId);
    },
  };
}

const handlers = createTicketStatusUpdateRouteHandlers();
export const listTicketStatusUpdates = withTracing(handlers.indexGET);
export const postTicketStatusUpdate = withTracing(handlers.postPOST);
export const getTicketStatusUpdate = withTracing(handlers.resolveGET);
