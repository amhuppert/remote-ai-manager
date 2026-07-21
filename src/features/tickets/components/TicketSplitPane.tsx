"use client";

import Link from "next/link";

import { CloseIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { WithTooltip } from "@/components/ui/WithTooltip";
import {
  EmptyState,
  EmptyStateDesc,
  EmptyStateTitle,
} from "@/components/ui/EmptyState";
import { ApiCallError } from "@/lib/api/errors";
import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/conversation-policy";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { ticketDetailHref } from "@/lib/tickets/hrefs";
import { useTicketDetailQuery } from "@/lib/tickets/queries";
import type { TicketSelection } from "@/lib/tickets/ticket-url-state";
import { ticketIdentifier } from "../ticket-reference";
import { TicketDossier } from "./TicketDetailView";

// 30px borderless icon control (button or link) — the Topbar config-link
// recipe, reused so the pane chrome reads as page chrome, not content.
const PANE_ICON_CONTROL_CLASS =
  "flex size-[30px] shrink-0 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 text-text-secondary no-underline transition-all duration-150 ease-[ease] hover:bg-bg-hover hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:size-[44px]";

export interface TicketSplitPaneProps {
  selection: TicketSelection;
  onClose: () => void;
  defaultAgentBackend: AgentBackendId;
  backendDefaults: BackendSelectionDefaultsById;
}

/**
 * The right half of the list view's split screen: a sticky, independently
 * scrolling pane hosting the full ticket dossier, so the filtered list keeps
 * its scroll position and context while switching between tickets.
 */
export default function TicketSplitPane({
  selection,
  onClose,
  defaultAgentBackend,
  backendDefaults,
}: TicketSplitPaneProps): React.JSX.Element {
  const detailQuery = useTicketDetailQuery(
    selection.projectName,
    selection.number,
  );
  const identifier = ticketIdentifier(selection);
  const notFound = detailQuery.isError && isNotFound(detailQuery.error);
  const fullHref = ticketDetailHref(selection.projectName, selection.number);

  return (
    <section
      aria-label={`Ticket detail: ${identifier}`}
      data-ticket-split-pane
      className="sticky top-[var(--topbar-height)] max-h-[calc(100dvh-var(--topbar-height))] min-w-0 overflow-y-auto max-768:static max-768:max-h-none max-768:overflow-visible"
    >
      <div className="sticky top-0 z-sticky flex min-h-[44px] items-center gap-sm border-x-0 border-t-0 border-b border-solid border-border-subtle bg-[var(--cc-topbar-bg)] px-lg [backdrop-filter:blur(12px)] max-768:px-md">
        <span className="min-w-0 overflow-hidden font-mono text-[0.78rem] font-semibold text-ellipsis whitespace-nowrap text-text-secondary">
          {identifier}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-xs">
          <WithTooltip label="Open full page">
            <Link
              href={fullHref}
              aria-label={`Open ${identifier} as a full page`}
              className={PANE_ICON_CONTROL_CLASS}
            >
              <ExpandIcon />
            </Link>
          </WithTooltip>
          <WithTooltip label="Close">
            <button
              type="button"
              aria-label="Close ticket detail"
              className={PANE_ICON_CONTROL_CLASS}
              onClick={onClose}
            >
              <CloseIcon size={14} />
            </button>
          </WithTooltip>
        </span>
      </div>

      {detailQuery.isPending ? (
        <div className="px-lg py-lg font-mono text-[0.72rem] text-text-tertiary">
          Loading ticket…
        </div>
      ) : detailQuery.isError ? (
        <div role={notFound ? undefined : "alert"} className="py-2xl">
          <EmptyState>
            <EmptyStateTitle>
              {notFound
                ? `${identifier} doesn't exist`
                : "Couldn't load the ticket"}
            </EmptyStateTitle>
            <EmptyStateDesc>
              {notFound
                ? "It may have been deleted — ticket numbers are never reused."
                : detailQuery.error instanceof Error
                  ? detailQuery.error.message
                  : "Something went wrong fetching the ticket."}
            </EmptyStateDesc>
            {notFound ? (
              <Button variant="ghost" size="sm" onClick={onClose}>
                Back to the list
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                disabled={detailQuery.isFetching}
                onClick={() => void detailQuery.refetch()}
              >
                {detailQuery.isFetching ? "Retrying…" : "Retry ticket"}
              </Button>
            )}
          </EmptyState>
        </div>
      ) : (
        <TicketDossier
          detail={detailQuery.data}
          defaultAgentBackend={defaultAgentBackend}
          backendDefaults={backendDefaults}
          layout="pane"
          onDeleted={onClose}
        />
      )}
    </section>
  );
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiCallError && error.status === 404;
}

function ExpandIcon(): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M9.5 2.5 H13.5 V6.5 M13.5 2.5 L9 7 M6.5 13.5 H2.5 V9.5 M2.5 13.5 L7 9"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
