"use client";

import { TicketChildSummary } from "./TicketChildSummary";
import { useEffect, useMemo, useRef, useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/Select";
import { StatusChip } from "@/components/ui/StatusChip";
import { ticketDetailHref as ticketDetailHrefFor } from "@/lib/tickets/hrefs";
import {
  useDeleteTicketMutation,
  useUpdateTicketMutation,
} from "@/lib/tickets/mutations";
import type {
  TicketListItem,
  TicketStatus,
  TicketWorkType,
} from "@/lib/tickets/schemas";
import {
  ticketSortNaturalDirection,
  type TicketListSortState,
  type TicketSelection,
  type TicketSortColumn,
} from "@/lib/tickets/ticket-url-state";
import { pushToast } from "@/stores/toast.store";
import { cn } from "@/lib/ui/cn";
import { copyTicketReference } from "@/components/references/copy-ticket-reference";
import { formatRelativeTime } from "../format-relative-time";
import { ticketIdentifier } from "../ticket-reference";
import {
  TICKET_STATUS_ORDER,
  TICKET_STATUS_VISUALS,
  TICKET_WORK_TYPE_LABELS,
  TICKET_WORK_TYPE_ORDER,
} from "@/lib/tickets/ticket-visuals";
import { sortTicketsForDisplay } from "./ticket-list-sort";
import { useAnimatedTicketItems } from "./use-animated-ticket-items";

// Handoff row grid: rail · id · title · type · status · CTX · session ·
// updated · kebab.
const ROW_GRID_CLASS =
  "grid grid-cols-[3px_160px_minmax(0,1fr)_118px_136px_64px_220px_92px_44px] items-center gap-sm max-768:grid-cols-[3px_minmax(0,1fr)_44px] max-768:gap-xs";

// Split-pane companion grid: rail · stacked id/title block · kebab.
const CONDENSED_ROW_GRID_CLASS =
  "grid grid-cols-[3px_minmax(0,1fr)_40px] items-center gap-xs";

const COLUMN_HEADER_CLASS =
  "font-mono text-[0.65rem] font-medium uppercase tracking-[0.08em] text-text-tertiary";

const CELL_LINK_CLASS =
  "overflow-hidden font-mono font-semibold text-ellipsis whitespace-nowrap no-underline transition-colors duration-150 ease-[ease] hover:text-cyan!";

// 24px inline control revealed on row hover/focus — matches the board card's
// small icon buttons. Also permanently reachable: focusing it reveals it.
const REVEAL_BUTTON_CLASS =
  "inline-flex size-[24px] shrink-0 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 text-text-tertiary opacity-0 transition-opacity duration-150 ease-[ease] group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100 hover:bg-bg-hover hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:2px] max-768:hidden";

export interface TicketListProps {
  items: readonly TicketListItem[];
  /** Whether any ticket exists at all (unfiltered) — picks the empty state. */
  hasAnyTickets: boolean;
  /** Whether the status filter is narrowing (affects the empty-state hint). */
  statusesNarrowed: boolean;
  sort: TicketListSortState;
  onSortChange: (next: TicketListSortState) => void;
  /** The ticket open in the split pane, if any. */
  selected: TicketSelection | null;
  /** Href that opens (or moves) the split pane onto this ticket. */
  selectHrefFor: (item: TicketListItem) => string;
  onSelect: (item: TicketListItem) => void;
  /** Split-pane companion presentation: rail + id/title/status only. */
  condensed: boolean;
  onClearFilters: () => void;
}

function ticketDetailHref(item: TicketListItem): string {
  return ticketDetailHrefFor(item.projectName, item.number);
}

function isSelected(
  selected: TicketSelection | null,
  item: TicketListItem,
): boolean {
  return (
    selected !== null &&
    selected.projectName === item.projectName &&
    selected.number === item.number
  );
}

interface SortableColumn {
  column: TicketSortColumn;
  label: string;
  align?: "right";
}

const SORTABLE_COLUMNS: Record<TicketSortColumn, SortableColumn> = {
  ticket: { column: "ticket", label: "Ticket" },
  title: { column: "title", label: "Title" },
  type: { column: "type", label: "Type" },
  status: { column: "status", label: "Status" },
  ctx: { column: "ctx", label: "Ctx", align: "right" },
  updated: { column: "updated", label: "Updated", align: "right" },
};

export default function TicketList({
  items,
  hasAnyTickets,
  statusesNarrowed,
  sort,
  onSortChange,
  selected,
  selectHrefFor,
  onSelect,
  condensed,
  onClearFilters,
}: TicketListProps): React.JSX.Element {
  const [pendingDelete, setPendingDelete] = useState<TicketListItem | null>(
    null,
  );
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const updateMutation = useUpdateTicketMutation();
  const deleteMutation = useDeleteTicketMutation();
  const sortedItems = useMemo(
    () => sortTicketsForDisplay(sort, items),
    [sort, items],
  );
  const animatedItems = useAnimatedTicketItems(sortedItems);
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

  const changeField = (
    item: TicketListItem,
    fields: { status: TicketStatus } | { workType: TicketWorkType },
  ) => {
    const failedTarget =
      "status" in fields
        ? TICKET_STATUS_VISUALS[fields.status].label
        : TICKET_WORK_TYPE_LABELS[fields.workType];
    void updateMutation
      .mutateAsync({
        projectName: item.projectName,
        number: item.number,
        fields,
      })
      .catch(() => {
        pushToast(
          `Couldn't move ${ticketIdentifier(item)} to ${failedTarget} — rolled back`,
          {
            action: {
              label: "Retry",
              onClick: () => changeField(item, fields),
            },
          },
        );
      });
  };

  const renameTitle = (item: TicketListItem, title: string) => {
    const next = title.trim();
    if (next.length === 0 || next === item.title) return;
    void updateMutation
      .mutateAsync({
        projectName: item.projectName,
        number: item.number,
        fields: { title: next },
      })
      .catch(() => {
        pushToast(`Couldn't rename ${ticketIdentifier(item)} — rolled back`, {
          action: { label: "Retry", onClick: () => renameTitle(item, next) },
        });
      });
  };

  const handleConfirmDelete = () => {
    const item = pendingDelete;
    setPendingDelete(null);
    if (item === null) return;
    const itemIndex = sortedItems.findIndex(
      (candidate) => candidate.id === item.id,
    );
    const successor =
      sortedItems[itemIndex + 1] ??
      sortedItems[Math.max(0, itemIndex - 1)] ??
      null;
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
              ? statusesNarrowed
                ? "Done and closed tickets are hidden by the status filter — widen it or switch to All statuses to see them."
                : "Widen the project, type, or status filters — or clear them to see every ticket."
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
      {condensed ? (
        <div role="row" className="sr-only">
          <span role="columnheader">Ticket</span>
          <span role="columnheader">Actions</span>
        </div>
      ) : (
        <div
          role="row"
          className={cn(
            ROW_GRID_CLASS,
            "border-x-0 border-t-0 border-b border-solid border-border-subtle py-[4px] pr-[12px] max-768:sr-only",
          )}
        >
          <span role="presentation" />
          <SortableHeader
            {...SORTABLE_COLUMNS.ticket}
            sort={sort}
            onSortChange={onSortChange}
            layout="pl-[9px]"
          />
          <SortableHeader
            {...SORTABLE_COLUMNS.title}
            sort={sort}
            onSortChange={onSortChange}
          />
          <SortableHeader
            {...SORTABLE_COLUMNS.type}
            sort={sort}
            onSortChange={onSortChange}
          />
          <SortableHeader
            {...SORTABLE_COLUMNS.status}
            sort={sort}
            onSortChange={onSortChange}
          />
          <SortableHeader
            {...SORTABLE_COLUMNS.ctx}
            sort={sort}
            onSortChange={onSortChange}
          />
          <span role="columnheader" className={COLUMN_HEADER_CLASS}>
            Session
          </span>
          <SortableHeader
            {...SORTABLE_COLUMNS.updated}
            sort={sort}
            onSortChange={onSortChange}
          />
          <span role="columnheader" className="sr-only">
            Actions
          </span>
        </div>
      )}

      {animatedItems.map(({ item, entered, exiting }) => {
        const statusVisual = TICKET_STATUS_VISUALS[item.status];
        const identifier = ticketIdentifier(item);
        const rowSelected = isSelected(selected, item);
        const editing = editingTitleId === item.id;

        const rowShell = (
          children: React.ReactNode,
          gridClass: string,
        ): React.JSX.Element => (
          <div
            key={item.id}
            role="row"
            data-ticket-title={item.title}
            data-selected={rowSelected || undefined}
            className={cn(
              gridClass,
              "group relative cursor-pointer border-x-0 border-t-0 border-b border-solid border-border-subtle pr-[12px] transition-colors duration-150 ease-[ease] motion-reduce:transition-none",
              rowSelected
                ? "bg-bg-surface shadow-[inset_0_0_0_1px_var(--color-border-strong)]"
                : "hover:bg-bg-base",
              entered && "animate-tk-sse-in motion-reduce:animate-none",
              exiting &&
                "pointer-events-none max-h-[160px] animate-tk-sse-out overflow-hidden motion-reduce:animate-none",
            )}
            onClick={(event) => {
              if (editing) return;
              const target = event.target as HTMLElement;
              if (
                target.closest(
                  "a,button,input,[role=combobox],[role=listbox],[role=menu],[role=dialog]",
                ) !== null
              )
                return;
              onSelect(item);
            }}
          >
            <span role="presentation" />
            <span
              aria-hidden="true"
              className={cn(
                "absolute inset-y-0 left-0 w-[3px]",
                statusVisual.rail,
              )}
            />
            {children}
          </div>
        );

        const kebabCell = (
          <span
            role="cell"
            className="flex justify-end max-768:col-start-3 max-768:row-start-1"
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton
                  aria-label={`Ticket actions for ${identifier}`}
                  data-ticket-action-id={item.id}
                >
                  <KebabIcon />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                  <Link href={ticketDetailHref(item)}>Open full page</Link>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setEditingTitleId(item.id)}>
                  Edit title…
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
        );

        if (condensed) {
          return rowShell(
            <>
              <span
                role="cell"
                className="flex min-w-0 flex-col gap-[3px] py-[8px] pl-[13px]"
              >
                <span className="flex min-w-0 items-center gap-[7px] font-mono text-[0.68rem] text-text-tertiary">
                  <span className="shrink-0">{identifier}</span>
                  <span
                    aria-hidden="true"
                    className={cn(
                      "h-[6px] w-[6px] shrink-0 rounded-full",
                      statusVisual.dot,
                    )}
                  />
                  <span
                    className={cn(
                      "shrink-0 text-[0.64rem] font-semibold tracking-[0.06em] uppercase",
                      statusVisual.text,
                    )}
                  >
                    {statusVisual.label}
                  </span>
                  <span className="ml-auto shrink-0 tabular-nums">
                    {formatRelativeTime(item.updatedAt)}
                  </span>
                </span>
                {editing ? (
                  <InlineTitleInput
                    item={item}
                    onSubmit={(value) => renameTitle(item, value)}
                    onDone={() => setEditingTitleId(null)}
                  />
                ) : (
                  <Link
                    href={selectHrefFor(item)}
                    scroll={false}
                    aria-current={rowSelected ? "true" : undefined}
                    className={cn(
                      CELL_LINK_CLASS,
                      "block text-[0.8rem] leading-[1.35] whitespace-normal text-text-primary!",
                      "line-clamp-2",
                    )}
                  >
                    {item.title}
                  </Link>
                )}
                <TicketChildSummary counts={item.childStatusCounts} />
              </span>
              {kebabCell}
            </>,
            CONDENSED_ROW_GRID_CLASS,
          );
        }

        return rowShell(
          <>
            <span
              role="cell"
              className="min-w-0 py-[9px] pl-[13px] max-768:sr-only"
            >
              <Link
                href={selectHrefFor(item)}
                scroll={false}
                className={cn(
                  CELL_LINK_CLASS,
                  "block text-[0.8rem] text-text-secondary!",
                )}
              >
                {identifier}
              </Link>
            </span>
            <span
              role="cell"
              className="min-w-0 py-[9px] max-768:col-start-2 max-768:row-start-1 max-768:flex max-768:flex-col max-768:gap-[3px] max-768:py-[3px] max-768:pl-[13px]"
            >
              <span
                aria-hidden="true"
                className="hidden font-mono text-[0.68rem] text-text-tertiary max-768:block"
              >
                {identifier} · {statusVisual.label}
              </span>
              {editing ? (
                <InlineTitleInput
                  item={item}
                  onSubmit={(value) => renameTitle(item, value)}
                  onDone={() => setEditingTitleId(null)}
                />
              ) : (
                <span className="flex min-w-0 items-center gap-[4px]">
                  <Link
                    href={selectHrefFor(item)}
                    scroll={false}
                    aria-current={rowSelected ? "true" : undefined}
                    className={cn(
                      CELL_LINK_CLASS,
                      "block min-w-0 text-[0.85rem] text-text-primary! max-768:line-clamp-2 max-768:leading-[1.35] max-768:whitespace-normal",
                    )}
                  >
                    {item.title}
                  </Link>
                  <button
                    type="button"
                    aria-label={`Edit title of ${identifier}`}
                    className={REVEAL_BUTTON_CLASS}
                    onClick={() => setEditingTitleId(item.id)}
                  >
                    <PencilIcon />
                  </button>
                </span>
              )}
              {item.childStatusCounts?.length ? (
                <span className="mt-xs block">
                  <TicketChildSummary counts={item.childStatusCounts} />
                </span>
              ) : null}
            </span>
            <span role="cell" className="min-w-0 max-768:sr-only">
              <Select
                value={item.workType}
                onValueChange={(value) => {
                  if (value !== item.workType)
                    changeField(item, { workType: value as TicketWorkType });
                }}
              >
                <SelectTrigger asChild aria-label={`Type for ${identifier}`}>
                  <button type="button" className={INLINE_SELECT_TRIGGER_CLASS}>
                    <Badge tier="type" kind={item.workType}>
                      {TICKET_WORK_TYPE_LABELS[item.workType]}
                    </Badge>
                    <InlineSelectChevron />
                  </button>
                </SelectTrigger>
                <SelectContent>
                  {TICKET_WORK_TYPE_ORDER.map((workType) => (
                    <SelectItem key={workType} value={workType}>
                      {capitalize(TICKET_WORK_TYPE_LABELS[workType])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </span>
            <span role="cell" className="min-w-0 max-768:sr-only">
              <Select
                value={item.status}
                onValueChange={(value) => {
                  if (value !== item.status)
                    changeField(item, { status: value as TicketStatus });
                }}
              >
                <SelectTrigger asChild aria-label={`Status for ${identifier}`}>
                  <button
                    type="button"
                    className={cn(
                      INLINE_SELECT_TRIGGER_CLASS,
                      "font-mono text-[0.7rem] font-semibold tracking-[0.06em] uppercase",
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
                    <InlineSelectChevron />
                  </button>
                </SelectTrigger>
                <SelectContent>
                  {TICKET_STATUS_ORDER.map((status) => (
                    <SelectItem key={status} value={status}>
                      {TICKET_STATUS_VISUALS[status].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
            {kebabCell}
          </>,
          ROW_GRID_CLASS,
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

// Inline (borderless) select trigger for in-row editing: invisible chrome at
// rest, border+bg on hover/open, canonical cyan focus ring.
const INLINE_SELECT_TRIGGER_CLASS = cn(
  "group/inline inline-flex h-[26px] max-w-full cursor-pointer items-center gap-[6px] rounded-sm border border-solid border-transparent bg-transparent px-[6px] transition-colors duration-150 ease-[ease]",
  "hover:border-border-subtle hover:bg-bg-hover data-[state=open]:border-cyan-dim data-[state=open]:bg-bg-hover",
  "focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:2px]",
);

function InlineSelectChevron(): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="inline-flex text-text-tertiary opacity-0 transition-opacity duration-150 ease-[ease] group-focus-within:opacity-100 group-hover:opacity-100 group-data-[state=open]/inline:opacity-100"
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
        <path
          d="M4 6 L8 10 L12 6"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

function InlineTitleInput({
  item,
  onSubmit,
  onDone,
}: {
  item: TicketListItem;
  onSubmit: (value: string) => void;
  onDone: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(item.title);
  return (
    <input
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          onSubmit(draft);
          onDone();
          return;
        }
        if (event.key !== "Escape") return;
        event.preventDefault();
        onDone();
      }}
      onBlur={() => onDone()}
      autoFocus
      aria-label={`Title of ${ticketIdentifier(item)} — Enter saves, Escape cancels`}
      className="w-full min-w-0 rounded-sm border border-solid border-cyan-dim bg-bg-base px-[8px] py-[3px] font-mono text-[0.85rem] font-semibold text-text-primary shadow-[0_0_0_2px_var(--color-cyan-glow)] outline-none"
    />
  );
}

interface SortableHeaderProps extends SortableColumn {
  sort: TicketListSortState;
  onSortChange: (next: TicketListSortState) => void;
  layout?: string;
}

function SortableHeader({
  column,
  label,
  align,
  sort,
  onSortChange,
  layout,
}: SortableHeaderProps): React.JSX.Element {
  const active = sort.column === column;
  return (
    <span
      role="columnheader"
      aria-sort={
        active
          ? sort.direction === "asc"
            ? "ascending"
            : "descending"
          : undefined
      }
      className={cn("min-w-0", layout, align === "right" && "text-right")}
    >
      <button
        type="button"
        className={cn(
          COLUMN_HEADER_CLASS,
          "inline-flex h-[24px] max-w-full cursor-pointer items-center gap-[4px] rounded-sm border-0 bg-transparent px-[4px] transition-colors duration-150 ease-[ease] hover:bg-bg-hover hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:-2px]",
          active && "text-text-primary",
          align === "right" && "flex-row-reverse",
        )}
        onClick={() =>
          onSortChange(
            active
              ? {
                  column,
                  direction: sort.direction === "asc" ? "desc" : "asc",
                }
              : { column, direction: ticketSortNaturalDirection(column) },
          )
        }
      >
        {label}
        <SortArrowIcon direction={active ? sort.direction : null} />
      </button>
    </span>
  );
}

function SortArrowIcon({
  direction,
}: {
  direction: "asc" | "desc" | null;
}): React.JSX.Element {
  if (direction === null) {
    // Unsorted affordance: paired chevrons, subdued.
    return (
      <svg
        width="12"
        height="12"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
        className="shrink-0 opacity-45"
      >
        <path
          d="M5 6.2 L8 3.2 L11 6.2 M5 9.8 L8 12.8 L11 9.8"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className="shrink-0 text-cyan"
    >
      <path
        d={direction === "asc" ? "M4 10 L8 5 L12 10" : "M4 6 L8 11 L12 6"}
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function isDocumentFocusStranded(): boolean {
  return (
    document.activeElement === null ||
    document.activeElement === document.body ||
    document.activeElement === document.documentElement
  );
}

function capitalize(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function PencilIcon(): React.JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M10.6 2.9 L13.1 5.4 L5.6 12.9 L2.6 13.4 L3.1 10.4 Z M9.4 4.1 L11.9 6.6"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
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
