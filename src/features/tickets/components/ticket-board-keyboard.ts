/**
 * Keyboard coordinate getter for the board's status-only drag protocol:
 * ←/→ snap the lifted card between status columns. The geometry core is pure
 * for unit testing; the dnd-kit adapter merely feeds it the sensor context.
 */

import type { KeyboardCoordinateGetter } from "@dnd-kit/core";

import type { TicketStatus } from "@/lib/tickets/schemas";
import { TICKET_STATUS_ORDER } from "../ticket-visuals";

interface RectLike {
  top: number;
  left: number;
  width: number;
  height: number;
  bottom?: number;
}

export interface BoardCardRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Keeps the moved card below the column header. */
const COLUMN_HEADER_INSET = 36;
/** Keeps the card clear of the column's bottom edge. */
const COLUMN_BOTTOM_INSET = 8;

function clampY(rect: RectLike, y: number, cardHeight: number): number {
  const top = rect.top + COLUMN_HEADER_INSET;
  const bottom = Math.max(
    top,
    (rect.bottom ?? rect.top + rect.height) - cardHeight - COLUMN_BOTTOM_INSET,
  );
  return Math.min(Math.max(y, top), bottom);
}

export function nextBoardCoordinates(
  code: string,
  card: BoardCardRect,
  columnRects: ReadonlyMap<TicketStatus, RectLike>,
): { x: number; y: number } | undefined {
  const columns = TICKET_STATUS_ORDER.filter((status) =>
    columnRects.has(status),
  );
  if (columns.length === 0) return undefined;

  const cardCenterX = card.left + card.width / 2;
  let currentIndex = 0;
  let bestDistance = Infinity;
  columns.forEach((status, index) => {
    const rect = columnRects.get(status)!;
    const distance = Math.abs(rect.left + rect.width / 2 - cardCenterX);
    if (distance < bestDistance) {
      bestDistance = distance;
      currentIndex = index;
    }
  });

  switch (code) {
    case "ArrowRight":
    case "ArrowLeft": {
      const nextIndex = currentIndex + (code === "ArrowRight" ? 1 : -1);
      const nextStatus = columns[nextIndex];
      if (nextStatus === undefined) return undefined;
      const rect = columnRects.get(nextStatus)!;
      return {
        x: rect.left + Math.max(0, (rect.width - card.width) / 2),
        y: clampY(rect, card.top, card.height),
      };
    }
    default:
      return undefined;
  }
}

export function createTicketBoardCoordinateGetter(): KeyboardCoordinateGetter {
  return (event, { context: { collisionRect, droppableRects } }) => {
    if (!collisionRect) return undefined;
    const next = nextBoardCoordinates(
      event.code,
      collisionRect,
      droppableRects as ReadonlyMap<TicketStatus, RectLike>,
    );
    if (next) {
      event.preventDefault();
    }
    return next;
  };
}
