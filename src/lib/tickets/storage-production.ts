import path from "node:path";
import {
  createTicketsRepo,
  type TicketsRepo,
} from "@/lib/state-store/tickets-repo";
import {
  createProjectsRepo,
  type ProjectsRepo,
} from "@/lib/state-store/projects-repo";
import {
  _resetForTesting,
  tryWithWriteQueue,
  withWriteQueue,
  withWriteQueueSync,
} from "@/lib/state-store/write-queue";
import {
  createTicketContentStore,
  TICKET_CONTENT_ROOT_DIRNAME,
  type TicketContentStore,
} from "./content-store";
import {
  createLiveTicketContextProvider,
  type LiveTicketContextProvider,
} from "./live-context";
import {
  createTicketProjectResolver,
  type TicketProjectResolver,
} from "./project-resolver";
import { getConfigDirPath } from "@/lib/config/loader";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { getGlobalSingleton } from "@/lib/shared/global-singleton";
import { getStateDb } from "@/lib/state-store/store";

/**
 * One repo per process: it shares the module-level write queue so ticket
 * writes serialize with every other state-store write, and route handlers
 * reuse the same prepared statements as the service.
 */
export function getTicketsRepo(): TicketsRepo {
  return getGlobalSingleton("__cc_tickets_repo", () =>
    createTicketsRepo(getStateDb(), {
      withWriteQueue,
      withWriteQueueSync,
      tryWithWriteQueue,
      _resetForTesting,
    }),
  );
}

function getTicketProjectsRepo(): ProjectsRepo {
  return getGlobalSingleton("__cc_ticket_projects_repo", () =>
    createProjectsRepo(getStateDb()),
  );
}

export function getTicketProjectResolver(): TicketProjectResolver {
  return getGlobalSingleton("__cc_ticket_project_resolver", () =>
    createTicketProjectResolver({
      resolveAvailableProjectPath(projectName) {
        return resolveProjectPath(projectName);
      },
      listKnownProjectPaths() {
        return getTicketProjectsRepo()
          .listAll()
          .map((project) => project.rootPath);
      },
    }),
  );
}

/** One provider per process; reads through the shared repo every turn. */
export function getLiveTicketContextProvider(): LiveTicketContextProvider {
  return getGlobalSingleton("__cc_live_ticket_context_provider", () =>
    createLiveTicketContextProvider({
      findLinkedTicket(projectPath, sessionName) {
        return getTicketsRepo().findLinkedTicket(projectPath, sessionName);
      },
    }),
  );
}

/** Durable attachment snapshots live under `<config-dir>/ticket-content/`. */
export function getTicketContentStore(): TicketContentStore {
  return getGlobalSingleton("__cc_ticket_content_store", () =>
    createTicketContentStore({
      contentRoot: path.join(getConfigDirPath(), TICKET_CONTENT_ROOT_DIRNAME),
      listTicketIdsForProject(projectPath) {
        return getTicketsRepo().listTicketIds(projectPath);
      },
    }),
  );
}
