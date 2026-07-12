import { describe, expect, it, vi } from "vitest";

import type { TicketStatus } from "@/lib/tickets/schemas";
import {
  createTicketBoardCoordinateGetter,
  nextBoardCoordinates,
} from "./ticket-board-keyboard";

interface Rect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

function rect(left: number): Rect {
  return {
    left,
    top: 0,
    width: 190,
    height: 600,
    right: left + 190,
    bottom: 600,
  };
}

// Five columns at x = 0, 200, 400, 600, 800 in status order.
const COLUMN_RECTS = new Map<TicketStatus, Rect>([
  ["not_started", rect(0)],
  ["in_progress", rect(200)],
  ["done", rect(400)],
  ["blocked", rect(600)],
  ["closed", rect(800)],
]);

// A card currently inside the in_progress column.
const CARD = { top: 100, left: 205, width: 180, height: 80 };

describe("nextBoardCoordinates", () => {
  it("moves to the next column's slot on ArrowRight", () => {
    const next = nextBoardCoordinates("ArrowRight", CARD, COLUMN_RECTS);
    expect(next).toBeDefined();
    // Horizontally centered in the done column (x = 400).
    expect(next!.x).toBeGreaterThanOrEqual(400);
    expect(next!.x + CARD.width).toBeLessThanOrEqual(590);
  });

  it("moves to the previous column on ArrowLeft", () => {
    const next = nextBoardCoordinates("ArrowLeft", CARD, COLUMN_RECTS);
    expect(next).toBeDefined();
    expect(next!.x).toBeGreaterThanOrEqual(0);
    expect(next!.x + CARD.width).toBeLessThanOrEqual(190);
  });

  it("stays put at the first column on ArrowLeft", () => {
    const atFirst = { ...CARD, left: 5 };
    expect(
      nextBoardCoordinates("ArrowLeft", atFirst, COLUMN_RECTS),
    ).toBeUndefined();
  });

  it("stays put at the last column on ArrowRight", () => {
    const atLast = { ...CARD, left: 805 };
    expect(
      nextBoardCoordinates("ArrowRight", atLast, COLUMN_RECTS),
    ).toBeUndefined();
  });

  it.each(["ArrowUp", "ArrowDown"])(
    "ignores %s because the board has no persisted within-column order",
    (code) => {
      expect(nextBoardCoordinates(code, CARD, COLUMN_RECTS)).toBeUndefined();
    },
  );

  it("ignores non-arrow keys", () => {
    expect(nextBoardCoordinates("KeyA", CARD, COLUMN_RECTS)).toBeUndefined();
  });
});

describe("createTicketBoardCoordinateGetter", () => {
  function keyboardEvent(code: string): {
    event: KeyboardEvent;
    preventDefault: ReturnType<typeof vi.fn>;
  } {
    const preventDefault = vi.fn();
    return {
      event: { code, preventDefault } as unknown as KeyboardEvent,
      preventDefault,
    };
  }

  function getterArgs() {
    return {
      context: { collisionRect: CARD, droppableRects: COLUMN_RECTS },
    } as never;
  }

  it("moves and consumes a horizontal status-column key", () => {
    const getter = createTicketBoardCoordinateGetter();
    const { event, preventDefault } = keyboardEvent("ArrowRight");

    expect(getter(event, getterArgs())).toBeDefined();
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("ignores and does not consume a within-column arrow key", () => {
    const getter = createTicketBoardCoordinateGetter();
    const { event, preventDefault } = keyboardEvent("ArrowDown");

    expect(getter(event, getterArgs())).toBeUndefined();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
