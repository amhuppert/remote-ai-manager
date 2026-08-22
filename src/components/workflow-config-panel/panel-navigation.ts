/**
 * The config panel's push-navigation stack: root → group → leaf, one screen
 * per level. Kept as a pure reducer so the "back restores where you were"
 * contract is testable without a layout engine — jsdom reports no scroll
 * geometry, and the parent's scroll offset and focused control are exactly what
 * a back step must restore.
 */

export const ROOT_SCREEN_ID = "root";

export interface PanelNavigationEntry {
  screenId: string;
  /** The body scroll offset to restore when this entry is returned to. */
  scrollTop: number;
  /** DOM id of the control that opened the child, refocused on return. */
  returnFocusId: string | null;
}

export interface PanelNavigationState {
  stack: PanelNavigationEntry[];
}

export type PanelNavigationAction =
  | {
      type: "push";
      screenId: string;
      /** State of the screen being left, recorded before it unmounts. */
      scrollTop: number;
      returnFocusId: string | null;
    }
  | { type: "back" }
  | { type: "reset" };

function entry(screenId: string): PanelNavigationEntry {
  return { screenId, scrollTop: 0, returnFocusId: null };
}

export function createPanelNavigationState(
  screenIds: readonly string[] = [],
): PanelNavigationState {
  return { stack: [entry(ROOT_SCREEN_ID), ...screenIds.map(entry)] };
}

export function panelNavigationReducer(
  state: PanelNavigationState,
  action: PanelNavigationAction,
): PanelNavigationState {
  switch (action.type) {
    case "push": {
      const departing = state.stack[state.stack.length - 1];
      if (!departing) return state;
      const remembered: PanelNavigationEntry = {
        screenId: departing.screenId,
        scrollTop: action.scrollTop,
        returnFocusId: action.returnFocusId,
      };
      return {
        stack: [
          ...state.stack.slice(0, -1),
          remembered,
          entry(action.screenId),
        ],
      };
    }
    case "back":
      // Exactly one level, and never off the root.
      if (state.stack.length <= 1) return state;
      return { stack: state.stack.slice(0, -1) };
    case "reset":
      return createPanelNavigationState();
  }
}

export function currentEntry(
  state: PanelNavigationState,
): PanelNavigationEntry {
  return state.stack[state.stack.length - 1] ?? entry(ROOT_SCREEN_ID);
}

export function parentScreenId(state: PanelNavigationState): string | null {
  return state.stack[state.stack.length - 2]?.screenId ?? null;
}

export function isRootScreen(state: PanelNavigationState): boolean {
  return state.stack.length === 1;
}
