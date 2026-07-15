import { createLogger } from "@/lib/logging";
import {
  notFound,
  resolveProjectOr404,
  type ResolveProjectDeps,
  type RouteResolution,
} from "@/lib/shared/route-resolution";

const logger = createLogger("tickets.routes");

/** Resolve a ticket project while preserving the ticket API's stable error body. */
export async function resolveTicketProjectOr404(
  deps: ResolveProjectDeps,
  projectName: string,
): Promise<RouteResolution<string>> {
  const project = await resolveProjectOr404(deps, projectName);
  if (project.ok) return project;

  logger.info("tickets.routes.project_not_found", { projectName });
  return {
    ok: false,
    response: notFound(
      `Project not found: ${projectName}`,
      "project_not_found",
    ),
  };
}
