"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";

import ConfirmDialog from "@/components/ConfirmDialog";
import {
  useDeleteTicketMutation,
  useUpdateTicketMutation,
} from "@/lib/tickets/mutations";
import type { TicketListItem, TicketStatus } from "@/lib/tickets/schemas";
import { cn } from "@/lib/ui/cn";
import { pushToast } from "@/stores/toast.store";
import { copyTicketReference } from "@/components/references/copy-ticket-reference";
import { ticketIdentifier } from "../ticket-reference";
import {
  TICKET_STATUS_ORDER,
  TICKET_STATUS_VISUALS,
} from "@/lib/tickets/ticket-visuals";
import {
  buildBoardAnnouncements,
  groupTicketsByStatus,
} from "./ticket-board-helpers";
import { createTicketBoardCoordinateGetter } from "./ticket-board-keyboard";
import TicketCard from "./TicketCard";
import { useAnimatedTicketItems } from "./use-animated-ticket-items";

const SCREEN_READER_INSTRUCTIONS = {
  draggable:
    "To pick up a ticket card, press Space or Enter. While dragging, use the left and right arrow keys to choose a status column. Press Space or Enter again to drop the card in the highlighted column, or press Escape to cancel.",
};

/** Pointer hit-testing while the pointer is inside a column; nearest-center
 * fallback covers keyboard moves, where there is no pointer. */
const boardCollisionDetection: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  return within.length > 0 ? within : closestCenter(args);
};

export interface TicketBoardProps {
  items: readonly TicketListItem[];
  statusFilter?: TicketStatus | null;
}

export default function TicketBoard({
  items,
  statusFilter = null,
}: TicketBoardProps): React.JSX.Element {
  const updateMutation = useUpdateTicketMutation();
  const deleteMutation = useDeleteTicketMutation();
  const animatedItems = useAnimatedTicketItems(items);

  const [activeTicket, setActiveTicket] = useState<TicketListItem | null>(null);
  const [landedId, setLandedId] = useState<string | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TicketListItem | null>(
    null,
  );
  const [mobileStatus, setMobileStatus] = useState<TicketStatus>(
    statusFilter ?? TICKET_STATUS_ORDER[0]!,
  );
  const [previousStatusFilter, setPreviousStatusFilter] =
    useState(statusFilter);
  if (statusFilter !== previousStatusFilter) {
    setPreviousStatusFilter(statusFilter);
    if (statusFilter !== null) setMobileStatus(statusFilter);
  }
  const timersRef = useRef<number[]>([]);
  const cancelFocusFrameRef = useRef<number | null>(null);
  const moveFocusFrameRef = useRef<number | null>(null);
  const deleteFocusFrameRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      timersRef.current.forEach((id) => window.clearTimeout(id));
      if (cancelFocusFrameRef.current !== null) {
        window.cancelAnimationFrame(cancelFocusFrameRef.current);
      }
      if (moveFocusFrameRef.current !== null) {
        window.cancelAnimationFrame(moveFocusFrameRef.current);
      }
      if (deleteFocusFrameRef.current !== null) {
        window.cancelAnimationFrame(deleteFocusFrameRef.current);
      }
    },
    [],
  );

  // A committed move remounts the card in its target column, destroying the
  // previously focused element (drag handle, kebab, or mobile select) and
  // dropping keyboard focus to <body>. After the re-render that moved the
  // card, restore focus to its drag handle so the board stays
  // keyboard-operable move after move.
  const pendingFocusRef = useRef<{
    ticketId: string;
    status: TicketStatus;
    label: string;
  } | null>(null);
  useEffect(() => {
    const pendingFocus = pendingFocusRef.current;
    if (pendingFocus === null) return;
    const displayedTicket = animatedItems.find(
      (animated) => animated.item.id === pendingFocus.ticketId,
    );
    if (displayedTicket?.item.status !== pendingFocus.status) return;
    pendingFocusRef.current = null;
    if (moveFocusFrameRef.current !== null) {
      window.cancelAnimationFrame(moveFocusFrameRef.current);
    }
    moveFocusFrameRef.current = window.requestAnimationFrame(() => {
      moveFocusFrameRef.current = window.requestAnimationFrame(() => {
        moveFocusFrameRef.current = null;
        if (isTicketPopupOpen()) return;
        focusDragHandle(pendingFocus.label);
      });
    });
  }, [animatedItems]);

  const pendingDeleteFocusRef = useRef<{
    deletedId: string;
    successorLabel: string | null;
  } | null>(null);
  useEffect(() => {
    const pendingFocus = pendingDeleteFocusRef.current;
    if (pendingFocus === null) return;
    if (items.some((item) => item.id === pendingFocus.deletedId)) return;
    pendingDeleteFocusRef.current = null;
    deleteFocusFrameRef.current = window.requestAnimationFrame(() => {
      deleteFocusFrameRef.current = window.requestAnimationFrame(() => {
        deleteFocusFrameRef.current = null;
        if (!isDocumentFocusStranded()) return;
        if (pendingFocus.successorLabel !== null) {
          focusDragHandle(pendingFocus.successorLabel);
          return;
        }
        document
          .querySelector<HTMLElement>("[data-ticket-page-heading]")
          ?.focus();
      });
    });
  }, [items]);

  const keyboardDragFocusRef = useRef<string | null>(null);

  const coordinateGetter = useMemo(
    () => createTicketBoardCoordinateGetter(),
    [],
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, { coordinateGetter }),
  );

  const announcements = useMemo(() => buildBoardAnnouncements(), []);

  const groups = groupTicketsByStatus(
    animatedItems.map((animated) => animated.item),
  );
  const motionById = new Map(
    animatedItems.map((animated) => [animated.item.id, animated]),
  );

  const flash = (
    set: (id: string | null) => void,
    id: string,
    ms: number,
  ): void => {
    set(id);
    timersRef.current.push(
      window.setTimeout(() => {
        set(null);
      }, ms),
    );
  };

  const commitMove = (ticket: TicketListItem, status: TicketStatus): void => {
    if (ticket.status === status) return;
    setMobileStatus(status);
    flash(setLandedId, ticket.id, 950);
    const focusTarget = {
      ticketId: ticket.id,
      status,
      label: `Drag ${ticketIdentifier(ticket)}`,
    };
    pendingFocusRef.current = focusTarget;
    void updateMutation
      .mutateAsync({
        projectName: ticket.projectName,
        number: ticket.number,
        fields: { status },
      })
      .catch(() => {
        setMobileStatus(ticket.status);
        pendingFocusRef.current = {
          ...focusTarget,
          status: ticket.status,
        };
        setLandedId(null);
        flash(setFailedId, ticket.id, 1500);
        pushToast(
          `Couldn't move ${ticketIdentifier(ticket)} to ${TICKET_STATUS_VISUALS[status].label} — rolled back`,
          {
            action: {
              label: "Retry",
              onClick: () => commitMove(ticket, status),
            },
          },
        );
      });
  };

  const handleDragStart = (event: DragStartEvent): void => {
    const ticket = event.active.data.current?.ticket as
      | TicketListItem
      | undefined;
    const label = ticket ? `Drag ${ticketIdentifier(ticket)}` : null;
    keyboardDragFocusRef.current =
      label !== null &&
      document.activeElement?.getAttribute("aria-label") === label
        ? label
        : null;
    setActiveTicket(ticket ?? null);
  };

  const handleDragEnd = (event: DragEndEvent): void => {
    const ticket = activeTicket;
    keyboardDragFocusRef.current = null;
    setActiveTicket(null);
    const target = event.over?.id as TicketStatus | undefined;
    if (ticket && target !== undefined) commitMove(ticket, target);
  };

  const handleDragCancel = (): void => {
    const focusLabel = keyboardDragFocusRef.current;
    keyboardDragFocusRef.current = null;
    setActiveTicket(null);
    if (focusLabel === null) return;
    cancelFocusFrameRef.current = window.requestAnimationFrame(() => {
      cancelFocusFrameRef.current = window.requestAnimationFrame(() => {
        cancelFocusFrameRef.current = null;
        focusDragHandle(focusLabel);
      });
    });
  };

  const handleConfirmDelete = (): void => {
    const item = pendingDelete;
    setPendingDelete(null);
    if (item === null) return;
    const sameStatusItems = items.filter(
      (candidate) =>
        candidate.status === item.status && candidate.id !== item.id,
    );
    const itemIndex = items.findIndex((candidate) => candidate.id === item.id);
    const successor =
      items
        .slice(itemIndex + 1)
        .find((candidate) => candidate.status === item.status) ??
      [...items]
        .slice(0, Math.max(itemIndex, 0))
        .reverse()
        .find((candidate) => candidate.status === item.status) ??
      sameStatusItems[0] ??
      null;
    pendingDeleteFocusRef.current = {
      deletedId: item.id,
      successorLabel:
        successor === null ? null : `Drag ${ticketIdentifier(successor)}`,
    };
    void deleteMutation
      .mutateAsync({ projectName: item.projectName, number: item.number })
      .catch(() =>
        pushToast(`Couldn't delete ${ticketIdentifier(item)} — restored`),
      );
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={boardCollisionDetection}
      accessibility={{
        announcements,
        screenReaderInstructions: SCREEN_READER_INSTRUCTIONS,
      }}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className="hidden gap-[6px] overflow-x-auto border-x-0 border-t-0 border-b border-solid border-border-dim px-md py-sm max-768:flex">
        {TICKET_STATUS_ORDER.map((status) => {
          const visual = TICKET_STATUS_VISUALS[status];
          const active = status === mobileStatus;
          return (
            <button
              key={status}
              type="button"
              data-ticket-status-pager={status}
              aria-pressed={active}
              className={cn(
                "inline-flex h-[44px] shrink-0 cursor-pointer items-center gap-[6px] rounded-full border border-solid bg-transparent px-[12px] font-mono text-[0.68rem] font-semibold tracking-[0.05em] uppercase",
                active
                  ? "border-cyan-dim bg-[var(--cc-cyan-a08)] text-cyan"
                  : "border-border-subtle text-text-secondary",
              )}
              onClick={() => setMobileStatus(status)}
            >
              <span
                aria-hidden="true"
                className={cn("h-[6px] w-[6px] rounded-full", visual.dot)}
              />
              {visual.label}
              <span className={active ? undefined : "text-text-tertiary"}>
                {groups[status].length}
              </span>
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-[repeat(5,minmax(0,1fr))] items-start gap-md px-xl pt-md pb-lg max-768:grid-cols-1 max-768:px-md">
        {TICKET_STATUS_ORDER.map((status) => (
          <BoardColumn
            key={status}
            status={status}
            items={groups[status]}
            activeTicket={activeTicket}
            hiddenOnMobile={status !== mobileStatus}
          >
            {groups[status].map((item) => (
              <DraggableTicketCard
                key={item.id}
                item={item}
                entered={motionById.get(item.id)?.entered ?? false}
                exiting={motionById.get(item.id)?.exiting ?? false}
                landed={item.id === landedId}
                failed={item.id === failedId}
                onMoveTo={(next) => commitMove(item, next)}
                onCopyReference={() => void copyTicketReference(item)}
                onDelete={() => setPendingDelete(item)}
              />
            ))}
          </BoardColumn>
        ))}
      </div>

      <DragOverlay>
        {activeTicket !== null ? (
          <TicketCard item={activeTicket} isOverlay />
        ) : null}
      </DragOverlay>

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
    </DndContext>
  );
}

function focusDragHandle(label: string): void {
  const handle = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button[aria-label]"),
  ).find((button) => button.getAttribute("aria-label") === label);
  handle?.focus();
}

function isDocumentFocusStranded(): boolean {
  return (
    document.activeElement === null ||
    document.activeElement === document.body ||
    document.activeElement === document.documentElement
  );
}

function isTicketPopupOpen(): boolean {
  return document.querySelector('[aria-expanded="true"]') !== null;
}

interface BoardColumnProps {
  status: TicketStatus;
  items: readonly TicketListItem[];
  activeTicket: TicketListItem | null;
  hiddenOnMobile: boolean;
  children: React.ReactNode;
}

function BoardColumn({
  status,
  items,
  activeTicket,
  hiddenOnMobile,
  children,
}: BoardColumnProps): React.JSX.Element {
  const { isOver, setNodeRef } = useDroppable({ id: status });
  const visual = TICKET_STATUS_VISUALS[status];
  const dragging = activeTicket !== null;
  const involved =
    activeTicket !== null && (isOver || activeTicket.status === status);
  const showPreview =
    isOver && activeTicket !== null && activeTicket.status !== status;

  return (
    <div
      ref={setNodeRef}
      role="group"
      aria-label={`${visual.label} column`}
      className={cn(
        "flex min-h-[320px] flex-col gap-sm rounded-md border border-solid p-sm transition-[opacity,border-color,background] duration-150 ease-[ease] motion-reduce:transition-none",
        isOver
          ? "border-cyan-dim bg-[var(--cc-cyan-a04)] shadow-[0_0_0_1px_var(--color-cyan-glow),inset_0_0_24px_var(--color-cyan-glow)]"
          : "border-border-dim bg-bg-base",
        dragging && !involved && "opacity-55",
        hiddenOnMobile && "max-768:hidden",
      )}
    >
      <div className="flex items-center gap-[7px] px-[4px] py-[2px]">
        <span
          aria-hidden="true"
          className={cn("h-[7px] w-[7px] shrink-0 rounded-full", visual.dot)}
        />
        <span
          className={cn(
            "font-mono text-[0.7rem] font-semibold tracking-[0.07em] uppercase",
            visual.text,
          )}
        >
          {visual.label}
        </span>
        <span
          aria-label={
            showPreview
              ? `${items.length} tickets, ${items.length + 1} after drop`
              : `${items.length} tickets`
          }
          className={cn(
            "ml-auto inline-flex min-w-[18px] items-center justify-center rounded-full px-[6px] py-px text-center font-mono text-[0.68rem] font-semibold",
            showPreview
              ? "bg-[var(--color-cyan-glow)] text-cyan"
              : "bg-bg-raised text-text-secondary",
          )}
        >
          {showPreview ? `${items.length} → ${items.length + 1}` : items.length}
        </span>
      </div>
      {children}
      {isOver && (
        <div
          aria-hidden="true"
          className="h-[3px] rounded-[2px] bg-cyan shadow-[0_0_8px_var(--color-cyan-glow-strong)]"
        />
      )}
      {items.length === 0 && !isOver && (
        <div className="flex min-h-[76px] items-center justify-center rounded-md border border-dashed border-border-default px-[12px] text-center font-mono text-[0.7rem] text-text-tertiary">
          No tickets — drop a card or use “Move to”
        </div>
      )}
    </div>
  );
}

interface DraggableTicketCardProps {
  item: TicketListItem;
  entered: boolean;
  exiting: boolean;
  landed: boolean;
  failed: boolean;
  onMoveTo: (status: TicketStatus) => void;
  onCopyReference: () => void;
  onDelete: () => void;
}

function DraggableTicketCard({
  item,
  entered,
  exiting,
  landed,
  failed,
  onMoveTo,
  onCopyReference,
  onDelete,
}: DraggableTicketCardProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } =
    useDraggable({
      id: item.id,
      data: { ticket: item },
    });

  // The card root must stay non-interactive ARIA-wise: it contains focusable
  // links and the kebab menu, so role=button on it is invalid (axe
  // nested-interactive). Pointer/touch dragging stays on the whole card body;
  // keyboard activation and the draggable ARIA attributes live on a dedicated
  // handle button registered as dnd-kit's activator node.
  const { onKeyDown, ...pointerListeners } = listeners ?? {};

  return (
    <TicketCard
      ref={setNodeRef}
      item={item}
      entered={entered}
      exiting={exiting}
      isDragSource={isDragging}
      landed={landed}
      failed={failed}
      onMoveTo={onMoveTo}
      onCopyReference={onCopyReference}
      onDelete={onDelete}
      dragHandle={
        <button
          type="button"
          ref={setActivatorNodeRef}
          data-ticket-drag-handle={item.id}
          aria-label={`Drag ${ticketIdentifier(item)}`}
          className="inline-flex size-[24px] cursor-grab items-center justify-center rounded-sm border-0 bg-transparent p-0 text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
          {...attributes}
          onKeyDown={(event) => onKeyDown?.(event)}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill="currentColor"
            aria-hidden="true"
          >
            <circle cx="5.5" cy="3.5" r="1.3" />
            <circle cx="10.5" cy="3.5" r="1.3" />
            <circle cx="5.5" cy="8" r="1.3" />
            <circle cx="10.5" cy="8" r="1.3" />
            <circle cx="5.5" cy="12.5" r="1.3" />
            <circle cx="10.5" cy="12.5" r="1.3" />
          </svg>
        </button>
      }
      {...pointerListeners}
    />
  );
}
