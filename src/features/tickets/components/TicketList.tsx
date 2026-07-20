"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

import ConfirmDialog from "@/components/ConfirmDialog";
import { Badge } from "@/components/ui/Badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";
import {
  EmptyState,
  EmptyStateDesc,
  EmptyStateTitle,
} from "@/components/ui/EmptyState";
import { IconButton } from "@/components/ui/IconButton";
import { StatusChip } from "@/components/ui/StatusChip";
import { ticketDetailHref as ticketDetailHrefFor } from "@/lib/tickets/hrefs";
import { useDeleteTicketMutation } from "@/lib/tickets/mutations";
import type { TicketListItem } from "@/lib/tickets/schemas";
import { pushToast } from "@/stores/toast.store";
import { cn } from "@/lib/ui/cn";
import { copyTicketReference } from "@/components/references/copy-ticket-reference";
import { formatRelativeTime } from "../format-relative-time";
import { ticketIdentifier } from "../ticket-reference";
import {
  TICKET_STATUS_VISUALS,
  TICKET_WORK_TYPE_LABELS,
} from "@/lib/tickets/ticket-visuals";
import { useAnimatedTicketItems } from "./use-animated-ticket-items";

// Handoff row grid: rail · id · title · type · status · CTX · session ·
// updated · kebab.
const ROW_GRID_CLASS =
  "grid grid-cols-[3px_160px_minmax(0,1fr)_118px_128px_64px_220px_92px_44px] items-center gap-sm max-768:grid-cols-[3px_minmax(0,1fr)_44px] max-768:gap-xs";

const COLUMN_HEADER_CLASS =
  "font-mono text-[0.65rem] font-medium uppercase tracking-[0.08em] text-text-tertiary";

const CELL_LINK_CLASS =
  "overflow-hidden font-mono font-semibold text-ellipsis whitespace-nowrap no-underline transition-colors duration-150 ease-[ease] hover:text-cyan!";

export interface TicketListProps {
  items: readonly TicketListItem[];
  /** Whether any ticket exists at all (unfiltered) — picks the empty state. */
  hasAnyTickets: boolean;
  onClearFilters: () => void;
}

function ticketDetailHref(item: TicketListItem): string {
  return ticketDetailHrefFor(item.projectName, item.number);
}

export default function TicketList({
  items,
  hasAnyTickets,
  onClearFilters,
}: TicketListProps): React.JSX.Element {
  const [pendingDelete, setPendingDelete] = useState<TicketListItem | null>(
    null,
  );
  const deleteMutation = useDeleteTicketMutation();
  const animatedItems = useAnimatedTicketItems(items);
  const pendingDeleteFocusRef = useRef<{
    deletedId: string;
    successorId: string | null;
  } | null>(null);
  const focusFrameRef = useRef<number | null>(null);

  useEffect(() => {
    const pendingFocus = pendingDeleteFocusRef.current;
    if (pendingFocus === null) return;
    if (items.some((item) => item.id === pendingFocus.deletedId)) return;
    pendingDeleteFocusRef.current = null;
    focusFrameRef.current = window.requestAnimationFrame(() => {
      focusFrameRef.current = window.requestAnimationFrame(() => {
        focusFrameRef.current = null;
        if (!isDocumentFocusStranded()) return;
        const successor = Array.from(
          document.querySelectorAll<HTMLButtonElement>(
            "button[data-ticket-action-id]",
          ),
        ).find(
          (button) =>
            button.dataset.ticketActionId === pendingFocus.successorId,
        );
        if (successor !== undefined) {
          successor.focus();
          return;
        }
        document
          .querySelector<HTMLElement>("[data-ticket-page-heading]")
          ?.focus();
      });
    });
  }, [items]);

  useEffect(
    () => () => {
      if (focusFrameRef.current !== null) {
        window.cancelAnimationFrame(focusFrameRef.current);
      }
    },
    [],
  );

  const handleConfirmDelete = () => {
    const item = pendingDelete;
    setPendingDelete(null);
    if (item === null) return;
    const itemIndex = items.findIndex((candidate) => candidate.id === item.id);
    const successor =
      items[itemIndex + 1] ?? items[Math.max(0, itemIndex - 1)] ?? null;
    pendingDeleteFocusRef.current = {
      deletedId: item.id,
      successorId: successor?.id ?? null,
    };
    void deleteMutation
      .mutateAsync({ projectName: item.projectName, number: item.number })
      .catch(() =>
        pushToast(`Couldn't delete ${ticketIdentifier(item)} — restored`),
      );
  };

  if (animatedItems.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2xs py-3xl">
        <EmptyState>
          <EmptyStateTitle>
            {hasAnyTickets
              ? "No tickets match these filters"
              : "No tickets yet"}
          </EmptyStateTitle>
          <EmptyStateDesc>
            {hasAnyTickets
              ? "Widen the project, type, or status filters — or clear them to see every ticket."
              : "Park upcoming work as a ticket and enrich it with context over time — files, conversations, sessions, notes. When you start work, the agent gets all of it."}
          </EmptyStateDesc>
        </EmptyState>
        {hasAnyTickets ? (
          <button
            type="button"
            className="inline-flex h-[28px] cursor-pointer items-center rounded-sm border border-solid border-border-default bg-transparent px-md font-mono text-[0.72rem] font-medium text-text-secondary transition-colors duration-150 ease-[ease] hover:border-border-strong hover:text-text-primary"
            onClick={onClearFilters}
          >
            Clear filters
          </button>
        ) : (
          <span className="font-mono text-[0.72rem] text-text-tertiary">
            Run <span className="text-text-secondary">/ticket</span> in a
            project or session conversation to create one from context
          </span>
        )}
      </div>
    );
  }

  return (
    <div role="table" aria-label="Tickets">
      <div
        role="row"
        className={cn(
          ROW_GRID_CLASS,
          "border-x-0 border-t-0 border-b border-solid border-border-subtle py-[6px] pr-[12px] max-768:sr-only",
        )}
      >
        <span role="presentation" />
        <span
          role="columnheader"
          className={cn(COLUMN_HEADER_CLASS, "pl-[13px]")}
        >
          Ticket
        </span>
        <span role="columnheader" className={COLUMN_HEADER_CLASS}>
          Title
        </span>
        <span role="columnheader" className={COLUMN_HEADER_CLASS}>
          Type
        </span>
        <span role="columnheader" className={COLUMN_HEADER_CLASS}>
          Status
        </span>
        <span
          role="columnheader"
          className={cn(COLUMN_HEADER_CLASS, "text-right")}
        >
          Ctx
        </span>
        <span role="columnheader" className={COLUMN_HEADER_CLASS}>
          Session
        </span>
        <span
          role="columnheader"
          className={cn(COLUMN_HEADER_CLASS, "text-right")}
        >
          Updated
        </span>
        <span role="columnheader" className="sr-only">
          Actions
        </span>
      </div>

      {animatedItems.map(({ item, entered, exiting }) => {
        const statusVisual = TICKET_STATUS_VISUALS[item.status];
        return (
          <div
            key={item.id}
            role="row"
            data-ticket-title={item.title}
            className={cn(
              ROW_GRID_CLASS,
              "relative border-x-0 border-t-0 border-b border-solid border-border-subtle py-[9px] pr-[12px] transition-colors duration-150 ease-[ease] hover:bg-bg-base motion-reduce:transition-none",
              entered && "animate-tk-sse-in motion-reduce:animate-none",
              exiting &&
                "pointer-events-none max-h-[160px] animate-tk-sse-out overflow-hidden motion-reduce:animate-none",
            )}
          >
            <span role="presentation" />
            <span
              aria-hidden="true"
              className={cn(
                "absolute inset-y-0 left-0 w-[3px]",
                statusVisual.rail,
              )}
            />
            <span role="cell" className="min-w-0 pl-[13px] max-768:sr-only">
              <Link
                href={ticketDetailHref(item)}
                className={cn(
                  CELL_LINK_CLASS,
                  "block text-[0.8rem] text-text-secondary!",
                )}
              >
                {ticketIdentifier(item)}
              </Link>
            </span>
            <span
              role="cell"
              className="min-w-0 max-768:col-start-2 max-768:row-start-1 max-768:flex max-768:flex-col max-768:gap-[3px] max-768:py-[3px] max-768:pl-[13px]"
            >
              <span
                aria-hidden="true"
                className="hidden font-mono text-[0.68rem] text-text-tertiary max-768:block"
              >
                {ticketIdentifier(item)} · {statusVisual.label}
              </span>
              <Link
                href={ticketDetailHref(item)}
                className={cn(
                  CELL_LINK_CLASS,
                  "block text-[0.85rem] text-text-primary! max-768:line-clamp-2 max-768:leading-[1.35] max-768:whitespace-normal",
                )}
              >
                {item.title}
              </Link>
            </span>
            <span role="cell" className="max-768:sr-only">
              <Badge tier="type" kind={item.workType}>
                {TICKET_WORK_TYPE_LABELS[item.workType]}
              </Badge>
            </span>
            <span
              role="cell"
              className={cn(
                "inline-flex items-center gap-[6px] font-mono text-[0.7rem] font-semibold tracking-[0.06em] uppercase max-768:sr-only",
                statusVisual.text,
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "h-[6px] w-[6px] shrink-0 rounded-full",
                  statusVisual.dot,
                )}
              />
              {statusVisual.label}
            </span>
            <span
              role="cell"
              className={cn(
                "inline-flex items-center justify-end gap-[4px] font-mono text-[0.76rem] font-medium max-768:sr-only",
                item.attachmentCount === 0
                  ? "text-text-tertiary"
                  : "text-text-secondary",
              )}
            >
              <PaperclipIcon />
              {item.attachmentCount}
            </span>
            <span role="cell" className="min-w-0 max-768:sr-only">
              {item.activeSessionName !== null ? (
                <StatusChip
                  tone="neutral"
                  icon={
                    <span
                      aria-hidden="true"
                      className="h-[6px] w-[6px] shrink-0 [animation:pulse-dot_2.5s_ease_infinite] rounded-full bg-green shadow-[0_0_6px_var(--color-green-glow)] motion-reduce:[animation:none]"
                    />
                  }
                  layoutClassName="max-w-full overflow-hidden"
                >
                  <span className="overflow-hidden text-ellipsis">
                    {item.activeSessionName}
                  </span>
                </StatusChip>
              ) : (
                <span className="font-mono text-[0.72rem] text-text-tertiary">
                  —
                </span>
              )}
            </span>
            <span
              role="cell"
              className="text-right font-mono text-[0.72rem] text-text-secondary tabular-nums max-768:sr-only"
            >
              {formatRelativeTime(item.updatedAt)}
            </span>
            <span
              role="cell"
              className="flex justify-end max-768:col-start-3 max-768:row-start-1"
            >
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton
                    aria-label={`Ticket actions for ${ticketIdentifier(item)}`}
                    data-ticket-action-id={item.id}
                  >
                    <KebabIcon />
                  </IconButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem asChild>
                    <Link href={ticketDetailHref(item)}>Open ticket</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => void copyTicketReference(item)}
                  >
                    Copy ticket reference
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    danger
                    onSelect={() => setPendingDelete(item)}
                  >
                    Delete ticket…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          </div>
        );
      })}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete ticket?"
        message={
          pendingDelete !== null
            ? `${ticketIdentifier(pendingDelete)} — "${pendingDelete.title}" and its attachments will be removed permanently.`
            : ""
        }
        confirmLabel="Delete"
        danger
        onConfirm={handleConfirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

function isDocumentFocusStranded(): boolean {
  return (
    document.activeElement === null ||
    document.activeElement === document.body ||
    document.activeElement === document.documentElement
  );
}

function PaperclipIcon(): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className="opacity-80"
    >
      <path
        d="M13 7.5 L8.2 12.3 A3.2 3.2 0 0 1 3.7 7.8 L8.8 2.7 A2.1 2.1 0 0 1 11.8 5.7 L6.9 10.6 A1 1 0 0 1 5.5 9.2 L10 4.7"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function KebabIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <circle cx="8" cy="3" r="1.4" />
      <circle cx="8" cy="8" r="1.4" />
      <circle cx="8" cy="13" r="1.4" />
    </svg>
  );
}
