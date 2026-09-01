/**
 * Ticket CRUD route handlers — extracted for dependency injection.
 *
 * Route shells under `src/app/api` re-export the traced default handlers;
 * tests create handlers with injected deps via `createTicketsRouteHandlers`.
 * Soft token gate (`validateOptionalToken`): browser requests carry no token,
 * cctl carries the instance bearer token, anything malformed is 401.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import type { ApiError } from "@/lib/api/errors";
import { createAgentAuth, type AgentAuth } from "@/lib/agent-gateway/token";
import { createLogger, withTracing } from "@/lib/logging";
import { jsonError, notFound } from "@/lib/shared/route-resolution";
import { parseTicketNumberSegment } from "./ticket-number";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import type {
  TicketError,
  TicketResult,
  TicketValidationIssue,
} from "./schemas";
import { getTicketProjectResolver, getTicketService } from "./service-factory";
import {
  createTicketServiceInputSchema,
  listTicketsServiceQuerySchema,
  toTicketValidationIssues,
  updateTicketServiceInputSchema,
  type TicketService,
} from "./service";
import { resolveTicketProjectOr404 } from "./route-resolution";
import { readBodyBounded } from "@/lib/shared/bounded-body";

const logger = createLogger("tickets.routes");

export const MAX_TICKET_CREATE_BODY_BYTES = 4 * 1024 * 1024;

export interface TicketsRouteDeps {
  /** Lazy so importing this module (route shells do) never opens the DB. */
  getService(): TicketService;
  resolveProjectPath(projectName: string): Promise<string | null>;
  resolveAvailableProjectPath(projectName: string): Promise<string | null>;
  auth: AgentAuth;
}

export interface TicketsRouteHandlers {
  globalListGET(request: Request): Promise<Response>;
  projectListGET(request: Request, context: RouteContext): Promise<Response>;
  projectCreatePOST(request: Request, context: RouteContext): Promise<Response>;
  detailGET(request: Request, context: RouteContext): Promise<Response>;
  detailPATCH(request: Request, context: RouteContext): Promise<Response>;
  detailDELETE(request: Request, context: RouteContext): Promise<Response>;
}

export type RouteContext = {
  params: Promise<Record<string, string>>;
};

// ---------------------------------------------------------------------------
// Shared response mapping
// ---------------------------------------------------------------------------

export function validationFailedResponse(
  issues: TicketValidationIssue[],
): Response {
  return NextResponse.json(
    {
      error: "Ticket request validation failed",
      code: "validation_failed",
      issues,
    },
    { status: 400 },
  );
}

/** Maps every typed service error to its stable HTTP status and body. */
export function ticketErrorResponse(error: TicketError): Response {
  switch (error.code) {
    case "validation_failed":
      return validationFailedResponse(error.issues);
    case "ticket_not_found":
      return notFound(`Ticket not found: ${error.identifier}`, error.code);
    case "attachment_not_found":
      return notFound(
        `Attachment not found on ${error.identifier}: ${error.attachmentId}`,
        error.code,
        { attachmentId: error.attachmentId },
      );
    case "relationship_not_found":
      return notFound(
        `Relationship not found on ${error.details.identifier}: ${error.details.relationshipId}`,
        error.code,
        error.details,
      );
    case "relationship_self_link":
    case "relationship_scope":
    case "status_update_actor_required":
    case "status_update_actor_not_found":
      return jsonError(
        error.rationale,
        400,
        error.code,
        error.details,
        undefined,
        error.rationale,
      );
    case "relationship_conflict":
    case "relationship_cycle":
      return jsonError(
        error.rationale,
        409,
        error.code,
        error.details,
        undefined,
        error.rationale,
      );
    case "active_session":
      return NextResponse.json(
        {
          error: `Ticket already has an active session: ${error.sessionName}`,
          code: error.code,
          details: { sessionName: error.sessionName },
        },
        { status: 409 },
      );
    case "start_in_progress":
      return NextResponse.json(
        {
          error: `A start is already in progress for ${error.identifier}`,
          code: error.code,
        },
        { status: 409 },
      );
    case "content_unavailable":
      return NextResponse.json(
        {
          error: `Attachment content unavailable: ${error.reason}`,
          code: error.code,
          details: { attachmentId: error.attachmentId },
        },
        { status: 410 },
      );
    // The design's error table splits preparation by phase: content failures
    // (failed compaction, unavailable snapshot) are the request's
    // unprocessable-content arm (422, ticket untouched); post-provision
    // preparation failures (materialization, charter, final link) are server
    // failures reported after compensation (500).
    case "context_preparation_failed":
      return NextResponse.json(
        { error: error.reason, code: error.code },
        { status: error.phase === "preparation" ? 500 : 422 },
      );
    case "session_provision_failed":
      return NextResponse.json(
        { error: error.reason, code: error.code },
        { status: 500 },
      );
  }
}

export function ticketResponse<T>(
  result: TicketResult<T>,
  successStatus = 200,
): Response {
  if (!result.ok) return ticketErrorResponse(result.error);
  return NextResponse.json(result.value, { status: successStatus });
}

// ---------------------------------------------------------------------------
// Boundary parsing helpers
// ---------------------------------------------------------------------------

const projectNameParamSchema = z.string().min(1);

/**
 * Reads the `:name`/`:number` segments as a service-layer ticket identity.
 * Non-numeric input becomes NaN here and fails the identity safeParse as
 * validation_failed (400), keeping one validation vocabulary.
 */
export async function resolveIdentity(
  context: RouteContext,
): Promise<{ projectName: string; number: number }> {
  const params = await context.params;
  return {
    projectName: params["name"] ?? "",
    number: parseTicketNumberSegment(params["number"] ?? "") ?? Number.NaN,
  };
}

/**
 * safeParses the `:name` route segment. Unreachable via normal Next.js
 * routing (an empty segment never matches), but the boundary stays validated
 * for direct handler invocation and future callers.
 */
export function parseProjectNameParam(
  params: Record<string, string>,
): { ok: true; projectName: string } | { ok: false; response: Response } {
  const parsed = projectNameParamSchema.safeParse(params["name"]);
  if (!parsed.success) {
    return {
      ok: false,
      response: validationFailedResponse(
        toTicketValidationIssues(parsed.error).map((issue) => ({
          ...issue,
          path: issue.path === "" ? "name" : issue.path,
        })),
      ),
    };
  }
  return { ok: true, projectName: parsed.data };
}

/** A present, non-empty query param; empty or absent both read as "not sent". */
function paramOrUndefined(
  params: URLSearchParams,
  name: string,
): string | undefined {
  const value = params.get(name);
  return value !== null && value.length > 0 ? value : undefined;
}

function rawListQuery(
  request: Request,
  projectName: string | undefined,
): Record<string, unknown> {
  const params = new URL(request.url).searchParams;
  // `status` is a comma-separated set; each token is validated by the schema.
  const status = paramOrUndefined(params, "status");
  return {
    projectName,
    statuses:
      status === undefined
        ? undefined
        : status.split(",").filter((token) => token.length > 0),
    workType: paramOrUndefined(params, "workType"),
    sort: paramOrUndefined(params, "sort"),
  };
}

export async function jsonBodyOrNull(
  request: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return null;
    }
    return body as Record<string, unknown>;
  } catch {
    logger.info("tickets.routes.invalid_json_body", {
      path: new URL(request.url).pathname,
    });
    return null;
  }
}

type BoundedJsonBodyResult =
  | { kind: "value"; value: Record<string, unknown> }
  | { kind: "invalid" }
  | { kind: "too_large"; sizeBytes: number };

async function boundedCreateJsonBody(
  request: Request,
): Promise<BoundedJsonBodyResult> {
  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_TICKET_CREATE_BODY_BYTES
  ) {
    return { kind: "too_large", sizeBytes: declaredLength };
  }

  const bounded = await readBodyBounded(
    request.body,
    MAX_TICKET_CREATE_BODY_BYTES,
  );
  if (!bounded.ok) {
    return { kind: "too_large", sizeBytes: bounded.receivedBytes };
  }

  try {
    const body: unknown = JSON.parse(new TextDecoder().decode(bounded.bytes));
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return { kind: "invalid" };
    }
    return { kind: "value", value: body as Record<string, unknown> };
  } catch {
    logger.info("tickets.routes.invalid_json_body", {
      path: new URL(request.url).pathname,
    });
    return { kind: "invalid" };
  }
}

function createPayloadTooLargeResponse(sizeBytes: number): Response {
  return NextResponse.json(
    {
      error: `Ticket create body exceeds the ${MAX_TICKET_CREATE_BODY_BYTES}-byte limit`,
      code: "payload_too_large",
      details: {
        sizeBytes,
        maxBytes: MAX_TICKET_CREATE_BODY_BYTES,
      },
    },
    { status: 413 },
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTicketsRouteHandlers(
  deps: TicketsRouteDeps = defaultDeps(),
): TicketsRouteHandlers {
  async function softGate(request: Request): Promise<Response | null> {
    const validation = await deps.auth.validateOptionalToken(request);
    if (validation.kind === "invalid") {
      return NextResponse.json(
        { error: "Invalid Command Center API token" } satisfies ApiError,
        { status: 401 },
      );
    }
    return null;
  }

  async function listTickets(
    request: Request,
    projectName: string | undefined,
  ): Promise<Response> {
    const parsed = listTicketsServiceQuerySchema.safeParse(
      rawListQuery(request, projectName),
    );
    if (!parsed.success) {
      return validationFailedResponse(toTicketValidationIssues(parsed.error));
    }
    return ticketResponse(await deps.getService().list(parsed.data));
  }

  return {
    async globalListGET(request) {
      const denied = await softGate(request);
      if (denied) return denied;

      const params = new URL(request.url).searchParams;
      return listTickets(request, paramOrUndefined(params, "project"));
    },

    async projectListGET(request, context) {
      const denied = await softGate(request);
      if (denied) return denied;

      const name = parseProjectNameParam(await context.params);
      if (!name.ok) return name.response;
      const { projectName } = name;
      const project = await resolveTicketProjectOr404(
        { resolveProjectPath: deps.resolveProjectPath },
        projectName,
      );
      if (!project.ok) return project.response;
      return listTickets(request, projectName);
    },

    async projectCreatePOST(request, context) {
      const denied = await softGate(request);
      if (denied) return denied;

      const name = parseProjectNameParam(await context.params);
      if (!name.ok) return name.response;
      const { projectName } = name;
      const project = await resolveTicketProjectOr404(
        { resolveProjectPath: deps.resolveAvailableProjectPath },
        projectName,
      );
      if (!project.ok) return project.response;
      const body = await boundedCreateJsonBody(request);
      if (body.kind === "too_large") {
        logger.info("tickets.routes.create_body_rejected", {
          projectName,
          sizeBytes: body.sizeBytes,
          maxBytes: MAX_TICKET_CREATE_BODY_BYTES,
        });
        return createPayloadTooLargeResponse(body.sizeBytes);
      }
      if (body.kind === "invalid") {
        return validationFailedResponse([
          { path: "", message: "request body must be a JSON object" },
        ]);
      }

      const parsed = createTicketServiceInputSchema.safeParse({
        ...body.value,
        projectName,
      });
      if (!parsed.success) {
        return validationFailedResponse(toTicketValidationIssues(parsed.error));
      }
      const result = await deps.getService().create(parsed.data);
      if (!result.ok) return ticketErrorResponse(result.error);
      return NextResponse.json(
        { ticket: result.value, warnings: result.warnings },
        { status: 201 },
      );
    },

    async detailGET(request, context) {
      const denied = await softGate(request);
      if (denied) return denied;

      const identity = await resolveIdentity(context);
      return ticketResponse(await deps.getService().get(identity));
    },

    async detailPATCH(request, context) {
      const denied = await softGate(request);
      if (denied) return denied;

      const identity = await resolveIdentity(context);
      const body = await jsonBodyOrNull(request);
      if (body === null) {
        return validationFailedResponse([
          { path: "", message: "request body must be a JSON object" },
        ]);
      }

      const parsed = updateTicketServiceInputSchema.safeParse({
        ...body,
        ...identity,
      });
      if (!parsed.success) {
        return validationFailedResponse(toTicketValidationIssues(parsed.error));
      }
      return ticketResponse(await deps.getService().update(parsed.data));
    },

    async detailDELETE(request, context) {
      const denied = await softGate(request);
      if (denied) return denied;

      const identity = await resolveIdentity(context);
      return ticketResponse(await deps.getService().delete(identity));
    },
  };
}

function defaultDeps(): TicketsRouteDeps {
  return {
    getService: () => getTicketService(),
    resolveProjectPath(projectName) {
      return getTicketProjectResolver().resolveKnownProjectPath(projectName);
    },
    resolveAvailableProjectPath(projectName) {
      return defaultResolveProjectPath(projectName);
    },
    auth: createAgentAuth(),
  };
}

// ---------------------------------------------------------------------------
// Default traced exports — consumed directly by route shells
// ---------------------------------------------------------------------------

const _handlers = createTicketsRouteHandlers();
export const listTicketsGlobal = withTracing(_handlers.globalListGET);
export const listProjectTickets = withTracing(_handlers.projectListGET);
export const createProjectTicket = withTracing(_handlers.projectCreatePOST);
export const getTicketDetail = withTracing(_handlers.detailGET);
export const updateTicketDetail = withTracing(_handlers.detailPATCH);
export const deleteTicketDetail = withTracing(_handlers.detailDELETE);
