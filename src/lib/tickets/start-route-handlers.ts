/**
 * Ticket start route handler — `POST /api/projects/:name/tickets/:number/start`.
 *
 * Accepts `{ mode: "agent" | "prepared" }` and delegates to the start
 * service; every typed service error maps through the shared
 * `ticketErrorResponse` (409 conflicts, 422 context preparation, 500
 * provisioning). Soft token gate like the other ticket routes.
 */

import { NextResponse } from "next/server";
import type { ApiError } from "@/lib/api/errors";
import { createAgentAuth, type AgentAuth } from "@/lib/agent-gateway/token";
import { createLogger, withTracing } from "@/lib/logging";
import {
  jsonBodyOrNull,
  resolveIdentity,
  ticketResponse,
  validationFailedResponse,
  type RouteContext,
} from "./route-handlers";
import { getTicketStartService } from "./service-factory";
import { toTicketValidationIssues } from "./service";
import {
  startTicketServiceInputSchema,
  type TicketStartService,
} from "./start-service";

const logger = createLogger("tickets.routes.start");

export interface TicketStartRouteDeps {
  /** Lazy so importing this module (route shells do) never opens the DB. */
  getStartService(): Pick<TicketStartService, "start">;
  auth: AgentAuth;
}

export interface TicketStartRouteHandlers {
  startPOST(request: Request, context: RouteContext): Promise<Response>;
}

export function createTicketStartRouteHandlers(
  deps: TicketStartRouteDeps = defaultDeps(),
): TicketStartRouteHandlers {
  return {
    async startPOST(request, context) {
      const validation = await deps.auth.validateOptionalToken(request);
      if (validation.kind === "invalid") {
        return NextResponse.json(
          { error: "Invalid Command Center API token" } satisfies ApiError,
          { status: 401 },
        );
      }

      const identity = await resolveIdentity(context);
      const body = await jsonBodyOrNull(request);
      if (body === null) {
        return validationFailedResponse([
          { path: "", message: "request body must be a JSON object" },
        ]);
      }

      const parsed = startTicketServiceInputSchema.safeParse({
        ...identity,
        mode: body["mode"],
        backend: body["backend"],
        model: body["model"],
        reasoningEffort: body["reasoningEffort"],
      });
      if (!parsed.success) {
        return validationFailedResponse(toTicketValidationIssues(parsed.error));
      }

      logger.info("tickets.routes.start_requested", {
        projectName: parsed.data.projectName,
        number: parsed.data.number,
        mode: parsed.data.mode,
        backend: parsed.data.backend,
        model: parsed.data.model,
        reasoningEffort: parsed.data.reasoningEffort,
      });
      return ticketResponse(await deps.getStartService().start(parsed.data));
    },
  };
}

function defaultDeps(): TicketStartRouteDeps {
  return {
    getStartService() {
      return getTicketStartService();
    },
    auth: createAgentAuth(),
  };
}

const _handlers = createTicketStartRouteHandlers();
export const startTicketPOST = withTracing(_handlers.startPOST);
