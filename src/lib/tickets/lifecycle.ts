import path from "node:path";

import type { SSEEvent } from "@/lib/api/sse-events";
import { createLogger } from "@/lib/logging";
import type {
  EndSessionLinkInput,
  TicketsRepo,
} from "@/lib/state-store/tickets-repo";
import { publishTicketChange } from "./events";
import type {
  TicketChangedEvent,
  TicketDetail,
  TicketListItem,
  TicketSessionEndReason,
  TicketSessionLink,
} from "./schemas";

const logger = createLogger("tickets.lifecycle");

interface TicketLifecycleRepo {
  findOpenSessionLink(
    projectPath: string,
    sessionName: string,
  ): Promise<TicketSessionLink | null>;
  findById(ticketId: string): Promise<TicketDetail | null>;
  endSessionLink(input: EndSessionLinkInput): Promise<TicketSessionLink | null>;
  findListItem(
    projectPath: string,
    number: number,
  ): Promise<TicketListItem | null>;
  list(input: {
    projectPath: string;
    sort: "updated";
  }): Promise<TicketListItem[]>;
}

export interface ReconcileTicketSessionLifecycleInput {
  projectPath: string;
  sessionName: string;
  endReason: Exclude<TicketSessionEndReason, "replaced">;
}

export interface TicketProjectDeletionSnapshot {
  projectName: string;
  ticketNumbers: number[];
}

export interface TicketLifecycleObserverDeps {
  repo: TicketLifecycleRepo;
  broadcast(event: SSEEvent): void;
  now(): string;
}

function publishChange(
  deps: TicketLifecycleObserverDeps,
  input: {
    change: TicketChangedEvent["change"];
    projectName: string;
    ticketNumber: number;
    listItem: TicketListItem | null;
    linkedSessionName?: string;
  },
): void {
  publishTicketChange({
    broadcast: deps.broadcast,
    logger,
    change: input.change,
    projectName: input.projectName,
    ticketNumber: input.ticketNumber,
    listItem: input.listItem,
    attachmentIndexChanged: false,
    ...(input.linkedSessionName !== undefined
      ? { linkedSessionName: input.linkedSessionName }
      : {}),
  });
}

export function createTicketLifecycleObserver(
  deps: TicketLifecycleObserverDeps,
) {
  return {
    async reconcileSession(
      input: ReconcileTicketSessionLifecycleInput,
    ): Promise<boolean> {
      const openLink = await deps.repo.findOpenSessionLink(
        input.projectPath,
        input.sessionName,
      );
      if (openLink === null) return false;

      const detail = await deps.repo.findById(openLink.ticketId);
      if (detail === null) return false;

      const ended = await deps.repo.endSessionLink({
        linkId: openLink.id,
        endedAt: deps.now(),
        endReason: input.endReason,
      });
      if (ended === null) return false;

      const listItem = await deps.repo.findListItem(
        input.projectPath,
        detail.number,
      );
      if (listItem === null) return false;

      publishChange(deps, {
        change: "session",
        projectName: detail.projectName,
        ticketNumber: detail.number,
        listItem,
        linkedSessionName: input.sessionName,
      });
      logger.info("tickets.lifecycle.session_reconciled", {
        projectName: detail.projectName,
        number: detail.number,
        sessionName: input.sessionName,
        endReason: input.endReason,
      });
      return true;
    },

    async captureProjectDeletion(
      projectPath: string,
    ): Promise<TicketProjectDeletionSnapshot> {
      const items = await deps.repo.list({ projectPath, sort: "updated" });
      return {
        projectName: items[0]?.projectName ?? path.basename(projectPath),
        ticketNumbers: items.map((item) => item.number),
      };
    },

    publishProjectDeletion(snapshot: TicketProjectDeletionSnapshot): void {
      for (const ticketNumber of snapshot.ticketNumbers) {
        publishChange(deps, {
          change: "deleted",
          projectName: snapshot.projectName,
          ticketNumber,
          listItem: null,
        });
      }
      logger.info("tickets.lifecycle.project_deleted", {
        projectName: snapshot.projectName,
        ticketCount: snapshot.ticketNumbers.length,
      });
    },
  };
}

async function createProductionObserver() {
  const [{ getTicketsRepo }, { publishSessionStatus }] = await Promise.all([
    import("./service-factory"),
    import("@/lib/workflows/primitives/default-session-status-bus"),
  ]);
  return createTicketLifecycleObserver({
    repo: getTicketsRepo() as TicketsRepo,
    broadcast(event) {
      publishSessionStatus(event);
    },
    now: () => new Date().toISOString(),
  });
}

export async function reconcileTicketSessionLifecycle(
  input: ReconcileTicketSessionLifecycleInput,
): Promise<void> {
  const observer = await createProductionObserver();
  await observer.reconcileSession(input);
}

export async function captureTicketProjectDeletion(
  projectPath: string,
): Promise<TicketProjectDeletionSnapshot> {
  const observer = await createProductionObserver();
  return observer.captureProjectDeletion(projectPath);
}

export async function publishTicketProjectDeletion(
  snapshot: TicketProjectDeletionSnapshot,
): Promise<void> {
  const observer = await createProductionObserver();
  observer.publishProjectDeletion(snapshot);
}
