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
import { ModelSelectionAdmissionError } from "@/lib/agent-backends/model-selection-admission";

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
        ...body,
        ...identity,
      });
      if (!parsed.success) {
        return validationFailedResponse(toTicketValidationIssues(parsed.error));
      }

      logger.info("tickets.routes.start_requested", {
        projectName: parsed.data.projectName,
        number: parsed.data.number,
        mode: parsed.data.mode,
        backend: parsed.data.backend,
        modelId: parsed.data.modelSelection?.modelId,
        parameterIds:
          parsed.data.modelSelection === undefined
            ? undefined
            : Object.keys(parsed.data.modelSelection.parameters).sort(),
      });
      try {
        return ticketResponse(await deps.getStartService().start(parsed.data));
      } catch (error) {
        if (!(error instanceof ModelSelectionAdmissionError)) throw error;
        logger.warn("model_selection.rejected", {
          backend: parsed.data.backend,
          modelId: error.modelId,
          code: error.code,
          ...(error.parameterId !== undefined
            ? { parameterId: error.parameterId }
            : {}),
          projectName: parsed.data.projectName,
          number: parsed.data.number,
        });
        return NextResponse.json(
          {
            error: error.message,
            code: error.code,
            modelId: error.modelId,
            ...(error.parameterId !== undefined
              ? { parameterId: error.parameterId }
              : {}),
          },
          { status: 400 },
        );
      }
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
