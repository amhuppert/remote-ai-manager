import type { OptionalTokenValidation } from "@/lib/agent-gateway/token";
import { createAgentAuth } from "@/lib/agent-gateway/token";
import type { ApiError } from "@/lib/api/errors";
import { createLogger, withTracing } from "@/lib/logging";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  addTicketRelationshipServiceInputSchema,
  getTicketRelationshipServiceInputSchema,
  listTicketRelationshipsServiceInputSchema,
  removeTicketRelationshipServiceInputSchema,
  updateTicketRelationshipServiceInputSchema,
  type TicketRelationshipService,
} from "./relationship-service";
import { ticketRelationshipRoleSchema } from "./schemas";
import {
  jsonBodyOrNull,
  resolveIdentity,
  ticketResponse,
  validationFailedResponse,
  type RouteContext,
} from "./route-handlers";
import { getTicketRelationshipService } from "./service-factory";
import { toTicketValidationIssues } from "./service";
import {
  decodeTicketKeysetCursor,
  normalizeTicketPageLimit,
} from "./ticket-keyset-cursor";

const logger = createLogger("tickets.relationships.routes");

export interface TicketRelationshipRouteDeps {
  getService(): TicketRelationshipService;
  validateOptionalToken(request: Request): Promise<OptionalTokenValidation>;
}

export interface TicketRelationshipRouteHandlers {
  indexGET(request: Request, context: RouteContext): Promise<Response>;
  addPOST(request: Request, context: RouteContext): Promise<Response>;
  resolveGET(request: Request, context: RouteContext): Promise<Response>;
  editPATCH(request: Request, context: RouteContext): Promise<Response>;
  removeDELETE(request: Request, context: RouteContext): Promise<Response>;
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

const relationshipListQuerySchema = z
  .object({
    role: ticketRelationshipRoleSchema.optional(),
    limit: limitQuerySchema.optional(),
    cursor: cursorQuerySchema.optional(),
  })
  .strict();

const addRelationshipBodySchema = addTicketRelationshipServiceInputSchema
  .pick({ target: true, role: true, description: true })
  .strict();

const updateRelationshipBodySchema = updateTicketRelationshipServiceInputSchema
  .pick({ description: true })
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
  logger.info("tickets.relationships.routes.request_rejected", {
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

export function createTicketRelationshipRouteHandlers(
  deps: TicketRelationshipRouteDeps = defaultDeps(),
): TicketRelationshipRouteHandlers {
  async function softGate(
    request: Request,
    operation: string,
  ): Promise<Response | null> {
    const token = await deps.validateOptionalToken(request);
    if (token.kind !== "invalid") return null;
    logger.info("tickets.relationships.routes.request_rejected", {
      operation,
      errorCode: "invalid_token",
    });
    return invalidTokenResponse();
  }

  async function relationshipIdentity(context: RouteContext) {
    const identity = await resolveIdentity(context);
    const params = await context.params;
    return {
      ...identity,
      relationshipId: params["relationshipId"] ?? "",
    };
  }

  return {
    async indexGET(request, context) {
      const denied = await softGate(request, "list");
      if (denied) return denied;
      const query = relationshipListQuerySchema.safeParse(
        strictQueryObject(request),
      );
      if (!query.success) return validationResponse(query.error, "list");
      const input = listTicketRelationshipsServiceInputSchema.safeParse({
        ...(await resolveIdentity(context)),
        ...query.data,
      });
      if (!input.success) return validationResponse(input.error, "list");
      const result = await deps.getService().list(input.data);
      if (result.ok) {
        logger.debug("tickets.relationships.routes.list_served", {
          projectName: input.data.projectName,
          number: input.data.number,
          role: input.data.role,
          pageSize: input.data.limit,
          cursorPresent: input.data.cursor !== undefined,
          returnedCount: result.value.items.length,
          total: result.value.total,
        });
      }
      return ticketResponse(result);
    },

    async addPOST(request, context) {
      const denied = await softGate(request, "add");
      if (denied) return denied;
      const body = await jsonBodyOrNull(request);
      if (body === null) {
        return validationFailedResponse([
          { path: "", message: "request body must be a JSON object" },
        ]);
      }
      const parsedBody = addRelationshipBodySchema.safeParse(body);
      if (!parsedBody.success) {
        return validationResponse(parsedBody.error, "add");
      }
      const input = addTicketRelationshipServiceInputSchema.safeParse({
        ...(await resolveIdentity(context)),
        ...parsedBody.data,
        description: parsedBody.data.description ?? "",
      });
      if (!input.success) return validationResponse(input.error, "add");
      const result = await deps.getService().add(input.data);
      if (result.ok) {
        logger.info("tickets.relationships.routes.add_served", {
          projectName: input.data.projectName,
          number: input.data.number,
          relationshipId: result.value.relationship.id,
          role: result.value.relationship.role,
          affectedTicketCount: result.value.tickets.length,
        });
      }
      return ticketResponse(result, 201);
    },

    async resolveGET(request, context) {
      const denied = await softGate(request, "get");
      if (denied) return denied;
      const input = getTicketRelationshipServiceInputSchema.safeParse(
        await relationshipIdentity(context),
      );
      if (!input.success) return validationResponse(input.error, "get");
      const result = await deps.getService().get(input.data);
      if (result.ok) {
        logger.debug("tickets.relationships.routes.get_served", {
          projectName: input.data.projectName,
          number: input.data.number,
          relationshipId: result.value.id,
          role: result.value.role,
        });
      }
      return ticketResponse(result);
    },

    async editPATCH(request, context) {
      const denied = await softGate(request, "update");
      if (denied) return denied;
      const body = await jsonBodyOrNull(request);
      if (body === null) {
        return validationFailedResponse([
          { path: "", message: "request body must be a JSON object" },
        ]);
      }
      const parsedBody = updateRelationshipBodySchema.safeParse(body);
      if (!parsedBody.success) {
        return validationResponse(parsedBody.error, "update");
      }
      const input = updateTicketRelationshipServiceInputSchema.safeParse({
        ...(await relationshipIdentity(context)),
        ...parsedBody.data,
      });
      if (!input.success) return validationResponse(input.error, "update");
      const result = await deps.getService().update(input.data);
      if (result.ok) {
        logger.info("tickets.relationships.routes.update_served", {
          projectName: input.data.projectName,
          number: input.data.number,
          relationshipId: result.value.relationship.id,
          affectedTicketCount: result.value.tickets.length,
        });
      }
      return ticketResponse(result);
    },

    async removeDELETE(request, context) {
      const denied = await softGate(request, "remove");
      if (denied) return denied;
      const input = removeTicketRelationshipServiceInputSchema.safeParse(
        await relationshipIdentity(context),
      );
      if (!input.success) return validationResponse(input.error, "remove");
      const result = await deps.getService().remove(input.data);
      if (result.ok) {
        logger.info("tickets.relationships.routes.remove_served", {
          projectName: input.data.projectName,
          number: input.data.number,
          relationshipId: result.value.relationshipId,
          affectedTicketCount: result.value.tickets.length,
        });
      }
      return ticketResponse(result);
    },
  };
}

function defaultDeps(): TicketRelationshipRouteDeps {
  const auth = createAgentAuth();
  return {
    getService: () => getTicketRelationshipService(),
    validateOptionalToken(request) {
      return auth.validateOptionalToken(request);
    },
  };
}

const handlers = createTicketRelationshipRouteHandlers();
export const listTicketRelationships = withTracing(handlers.indexGET);
export const addTicketRelationship = withTracing(handlers.addPOST);
export const getTicketRelationship = withTracing(handlers.resolveGET);
export const updateTicketRelationship = withTracing(handlers.editPATCH);
export const removeTicketRelationship = withTracing(handlers.removeDELETE);
