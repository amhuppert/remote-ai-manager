"use client";

import { useEffect, useRef, useState } from "react";

import type { TicketListItem } from "@/lib/tickets/schemas";

const ENTER_DURATION_MS = 1_200;
const EXIT_DURATION_MS = 150;

export interface AnimatedTicketItem {
  item: TicketListItem;
  entered: boolean;
  exiting: boolean;
}

interface TicketMotionState {
  inputItems: readonly TicketListItem[];
  renderedItems: readonly TicketListItem[];
  seenIds: ReadonlySet<string>;
  enteredIds: ReadonlySet<string>;
  exitingIds: ReadonlySet<string>;
}

function initialMotionState(
  items: readonly TicketListItem[],
): TicketMotionState {
  return {
    inputItems: items,
    renderedItems: [...items],
    seenIds: new Set(items.map((item) => item.id)),
    enteredIds: new Set(),
    exitingIds: new Set(),
  };
}

function transitionMotionState(
  state: TicketMotionState,
  items: readonly TicketListItem[],
): TicketMotionState {
  const previousInputs = new Map(
    state.inputItems.map((item) => [item.id, item]),
  );
  const currentInputs = new Map(items.map((item) => [item.id, item]));
  const seenIds = new Set(state.seenIds);
  const enteredIds = new Set(state.enteredIds);
  const exitingIds = new Set(state.exitingIds);

  for (const item of items) {
    exitingIds.delete(item.id);
    if (seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    enteredIds.add(item.id);
  }

  for (const previous of previousInputs.values()) {
    if (currentInputs.has(previous.id)) continue;
    exitingIds.add(previous.id);
  }

  const retainedRemovedItems = state.renderedItems.filter(
    (item) => !currentInputs.has(item.id) && exitingIds.has(item.id),
  );
  const renderedItems = [...items];
  for (const retained of retainedRemovedItems) {
    const previousIndex = state.renderedItems.findIndex(
      (item) => item.id === retained.id,
    );
    renderedItems.splice(
      Math.min(previousIndex, renderedItems.length),
      0,
      retained,
    );
  }

  return {
    inputItems: items,
    renderedItems,
    seenIds,
    enteredIds,
    exitingIds,
  };
}

function finishEntry(state: TicketMotionState, id: string): TicketMotionState {
  if (!state.enteredIds.has(id)) return state;
  const enteredIds = new Set(state.enteredIds);
  enteredIds.delete(id);
  return { ...state, enteredIds };
}

function finishExit(state: TicketMotionState, id: string): TicketMotionState {
  if (!state.exitingIds.has(id)) return state;
  const seenIds = new Set(state.seenIds);
  const enteredIds = new Set(state.enteredIds);
  const exitingIds = new Set(state.exitingIds);
  seenIds.delete(id);
  enteredIds.delete(id);
  exitingIds.delete(id);
  return {
    ...state,
    renderedItems: state.renderedItems.filter((item) => item.id !== id),
    seenIds,
    enteredIds,
    exitingIds,
  };
}

/**
 * Keeps removed ticket rows mounted through their collapse animation and marks
 * truly new identities for the live-update wash. Reappearing identities cancel
 * an in-flight removal so a fast SSE correction never flickers out and back in.
 */
export function useAnimatedTicketItems(
  items: readonly TicketListItem[],
): readonly AnimatedTicketItem[] {
  const [state, setState] = useState<TicketMotionState>(() =>
    initialMotionState(items),
  );
  const enterTimersRef = useRef(new Map<string, number>());
  const exitTimersRef = useRef(new Map<string, number>());

  useEffect(() => {
    for (const [id, timer] of enterTimersRef.current) {
      if (state.enteredIds.has(id)) continue;
      window.clearTimeout(timer);
      enterTimersRef.current.delete(id);
    }
    for (const id of state.enteredIds) {
      if (enterTimersRef.current.has(id)) continue;
      enterTimersRef.current.set(
        id,
        window.setTimeout(() => {
          enterTimersRef.current.delete(id);
          setState((current) => finishEntry(current, id));
        }, ENTER_DURATION_MS),
      );
    }

    for (const [id, timer] of exitTimersRef.current) {
      if (state.exitingIds.has(id)) continue;
      window.clearTimeout(timer);
      exitTimersRef.current.delete(id);
    }
    for (const id of state.exitingIds) {
      if (exitTimersRef.current.has(id)) continue;
      exitTimersRef.current.set(
        id,
        window.setTimeout(() => {
          exitTimersRef.current.delete(id);
          setState((current) => finishExit(current, id));
        }, EXIT_DURATION_MS),
      );
    }
  }, [state.enteredIds, state.exitingIds]);

  useEffect(
    () => () => {
      for (const timer of enterTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      for (const timer of exitTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
    },
    [],
  );

  let effectiveState = state;
  if (state.inputItems !== items) {
    effectiveState = transitionMotionState(state, items);
    setState(effectiveState);
  }

  return effectiveState.renderedItems.map((item) => ({
    item,
    entered: effectiveState.enteredIds.has(item.id),
    exiting: effectiveState.exitingIds.has(item.id),
  }));
}
