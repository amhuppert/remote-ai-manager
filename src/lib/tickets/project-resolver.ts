import path from "node:path";
import { createLogger } from "@/lib/logging";

const logger = createLogger("tickets.project-resolver");

export interface TicketProjectResolverDeps {
  resolveAvailableProjectPath(projectName: string): Promise<string | null>;
  listKnownProjectPaths(): string[];
}

export interface TicketProjectResolver {
  resolveKnownProjectPath(projectName: string): Promise<string | null>;
}

export function createTicketProjectResolver(
  deps: TicketProjectResolverDeps,
): TicketProjectResolver {
  return {
    async resolveKnownProjectPath(projectName) {
      const available = await deps.resolveAvailableProjectPath(projectName);
      if (available !== null) return available;

      const matches = deps
        .listKnownProjectPaths()
        .filter((projectPath) => path.basename(projectPath) === projectName);
      if (matches.length === 1) {
        logger.debug("tickets.project_resolver.retained_project_resolved", {
          projectName,
        });
        return matches[0] ?? null;
      }
      if (matches.length > 1) {
        logger.warn("tickets.project_resolver.ambiguous_retained_project", {
          projectName,
          matchCount: matches.length,
        });
      }
      return null;
    },
  };
}
