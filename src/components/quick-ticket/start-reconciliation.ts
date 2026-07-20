import { ApiCallError } from "@/lib/api/errors";
import { createClientLogger } from "@/lib/logging/client-logger";
import type {
  StartTicketOutput,
  TicketLinkSummary,
} from "@/lib/tickets/schemas";

export type QuickTicketStartResult =
  | { kind: "started"; output: StartTicketOutput }
  | { kind: "active"; sessionName: string }
  | { kind: "failed"; error: unknown };

interface ReconcileQuickTicketStartInput {
  ticketId: string;
  start(): Promise<StartTicketOutput>;
  refetchLinks(): Promise<Record<string, TicketLinkSummary>>;
  wait?(milliseconds: number): Promise<void>;
}

const LINK_RECONCILIATION_MAX_WAIT_MS = 30_000;
const LINK_RECONCILIATION_DELAY_MS = 1_000;
const LINK_RECONCILIATION_ATTEMPTS =
  LINK_RECONCILIATION_MAX_WAIT_MS / LINK_RECONCILIATION_DELAY_MS + 1;
const logger = createClientLogger("quick-ticket/start-reconciliation");

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function activeSessionName(
  links: Record<string, TicketLinkSummary>,
  ticketId: string,
): string | null {
  for (const [sessionName, link] of Object.entries(links)) {
    if (link.ticketId === ticketId && link.active) return sessionName;
  }
  return null;
}

export async function reconcileQuickTicketStart({
  ticketId,
  start,
  refetchLinks,
  wait: waitForNextCheck = wait,
}: ReconcileQuickTicketStartInput): Promise<QuickTicketStartResult> {
  try {
    return { kind: "started", output: await start() };
  } catch (error) {
    if (error instanceof ApiCallError && error.code === "active_session") {
      try {
        const sessionName = activeSessionName(await refetchLinks(), ticketId);
        if (sessionName !== null) return { kind: "active", sessionName };
      } catch {
        // The active-session response remains unconfirmed.
      }
      return { kind: "failed", error };
    }

    const ambiguous =
      !(error instanceof ApiCallError) ||
      error.code === "start_in_progress" ||
      error.status === undefined ||
      error.status >= 500;
    if (!ambiguous) return { kind: "failed", error };

    logger.info("quick_ticket.start_reconciliation_started", {
      ticketId,
      maxWaitMs: LINK_RECONCILIATION_MAX_WAIT_MS,
      delayMs: LINK_RECONCILIATION_DELAY_MS,
      errorCode: error instanceof ApiCallError ? error.code : undefined,
      errorStatus: error instanceof ApiCallError ? error.status : undefined,
    });

    let refetchFailures = 0;
    let lastRefetchFailure: string | undefined;
    for (
      let attempt = 0;
      attempt < LINK_RECONCILIATION_ATTEMPTS;
      attempt += 1
    ) {
      if (attempt > 0) {
        await waitForNextCheck(LINK_RECONCILIATION_DELAY_MS);
      }
      try {
        const sessionName = activeSessionName(await refetchLinks(), ticketId);
        if (sessionName !== null) {
          logger.info("quick_ticket.start_reconciliation_resolved", {
            ticketId,
            sessionName,
            attempt: attempt + 1,
            refetchFailures,
            lastRefetchFailure,
          });
          return { kind: "active", sessionName };
        }
      } catch (refetchError) {
        refetchFailures += 1;
        lastRefetchFailure =
          refetchError instanceof Error
            ? refetchError.message
            : "unknown error";
      }
    }
    logger.warn("quick_ticket.start_reconciliation_exhausted", {
      ticketId,
      attempts: LINK_RECONCILIATION_ATTEMPTS,
      maxWaitMs: LINK_RECONCILIATION_MAX_WAIT_MS,
      refetchFailures,
      lastRefetchFailure,
    });
    return { kind: "failed", error };
  }
}
