/**
 * Per-project session-link map route handler — the session-indicator read.
 *
 * Serves `GET /api/projects/:name/tickets/session-links` as the lean
 * `Record<sessionName, TicketLinkSummary>` the repo derives with the
 * instance-guarded active check. Soft token gate like the other ticket routes.
 */

import { createAgentAuth, type AgentAuth } from "@/lib/agent-gateway/token";
import type { ApiError } from "@/lib/api/errors";
import { createLogger, withTracing } from "@/lib/logging";
import { NextResponse } from "next/server";
import {
  parseProjectNameParam,
  projectNotFoundResponse,
} from "./route-handlers";
import { getTicketProjectResolver, getTicketsRepo } from "./service-factory";
import type { TicketLinkSummary } from "./schemas";

const logger = createLogger("tickets.routes.session-links");

export interface TicketSessionLinksRouteDeps {
  resolveProjectPath(projectName: string): Promise<string | null>;
  listSessionLinks(
    projectPath: string,
  ): Promise<Record<string, TicketLinkSummary>>;
  auth: AgentAuth;
}

export interface TicketSessionLinksRouteHandlers {
  sessionLinksGET(
    request: Request,
    context: { params: Promise<Record<string, string>> },
  ): Promise<Response>;
}

export function createTicketSessionLinksRouteHandlers(
  deps: TicketSessionLinksRouteDeps = defaultDeps(),
): TicketSessionLinksRouteHandlers {
  return {
    async sessionLinksGET(request, context) {
      const validation = await deps.auth.validateOptionalToken(request);
      if (validation.kind === "invalid") {
        return NextResponse.json(
          { error: "Invalid Command Center API token" } satisfies ApiError,
          { status: 401 },
        );
      }

      const name = parseProjectNameParam(await context.params);
      if (!name.ok) return name.response;
      const { projectName } = name;
      const projectPath = await deps.resolveProjectPath(projectName);
      if (projectPath === null) {
        return projectNotFoundResponse(projectName);
      }

      const links = await deps.listSessionLinks(projectPath);
      logger.debug("tickets.routes.session_links_served", {
        projectName,
        linkCount: Object.keys(links).length,
      });
      return NextResponse.json(links);
    },
  };
}

function defaultDeps(): TicketSessionLinksRouteDeps {
  return {
    resolveProjectPath(projectName) {
      return getTicketProjectResolver().resolveKnownProjectPath(projectName);
    },
    listSessionLinks(projectPath) {
      return getTicketsRepo().listSessionLinks(projectPath);
    },
    auth: createAgentAuth(),
  };
}

const _handlers = createTicketSessionLinksRouteHandlers();
export const getTicketSessionLinks = withTracing(_handlers.sessionLinksGET);
