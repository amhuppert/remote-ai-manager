import { describe, expect, it } from "vitest";
import {
  createPanelNavigationState,
  currentEntry,
  isRootScreen,
  panelNavigationReducer,
  parentScreenId,
  ROOT_SCREEN_ID,
  type PanelNavigationState,
} from "./panel-navigation";

function push(
  state: PanelNavigationState,
  screenId: string,
  scrollTop = 0,
  returnFocusId: string | null = null,
): PanelNavigationState {
  return panelNavigationReducer(state, {
    type: "push",
    screenId,
    scrollTop,
    returnFocusId,
  });
}

describe("panelNavigationReducer", () => {
  it("starts at the root screen", () => {
    const state = createPanelNavigationState();
    expect(currentEntry(state).screenId).toBe(ROOT_SCREEN_ID);
    expect(isRootScreen(state)).toBe(true);
    expect(parentScreenId(state)).toBeNull();
  });

  it("pushes root → group → leaf and names each level's parent", () => {
    const leaf = push(push(createPanelNavigationState(), "gates"), "validator");

    expect(currentEntry(leaf).screenId).toBe("validator");
    expect(parentScreenId(leaf)).toBe("gates");
    expect(isRootScreen(leaf)).toBe(false);
    expect(leaf.stack.map((e) => e.screenId)).toEqual([
      ROOT_SCREEN_ID,
      "gates",
      "validator",
    ]);
  });

  it("goes back exactly one level", () => {
    const leaf = push(
      push(push(createPanelNavigationState(), "gates"), "validator"),
      "seat:security",
    );
    const back = panelNavigationReducer(leaf, { type: "back" });

    expect(currentEntry(back).screenId).toBe("validator");
    expect(back.stack).toHaveLength(3);
  });

  it("never pops off the root", () => {
    const root = createPanelNavigationState();
    const back = panelNavigationReducer(root, { type: "back" });

    expect(currentEntry(back).screenId).toBe(ROOT_SCREEN_ID);
    expect(back.stack).toHaveLength(1);
  });

  it("remembers the departing screen's scroll offset and focused control", () => {
    const gates = push(createPanelNavigationState(), "gates", 0, null);
    const leaf = push(gates, "validator", 148, "cfgnav-validator");

    // The leaf itself starts at the top of its own body.
    expect(currentEntry(leaf).scrollTop).toBe(0);

    const back = panelNavigationReducer(leaf, { type: "back" });
    expect(currentEntry(back)).toMatchObject({
      screenId: "gates",
      scrollTop: 148,
      returnFocusId: "cfgnav-validator",
    });
  });

  it("keeps each level's own memory when several levels are pushed", () => {
    // Each push records the state of the screen being LEFT: root at 40,
    // then gates at 148, then validator at 12.
    const gates = push(
      createPanelNavigationState(),
      "gates",
      40,
      "cfgnav-gates",
    );
    const validator = push(gates, "validator", 148, "cfgnav-validator");
    const seat = push(validator, "seat:security", 12, "cfgnav-seat:security");

    const toValidator = panelNavigationReducer(seat, { type: "back" });
    expect(currentEntry(toValidator).scrollTop).toBe(12);

    const toGates = panelNavigationReducer(toValidator, { type: "back" });
    expect(currentEntry(toGates).scrollTop).toBe(148);
    expect(currentEntry(toGates).returnFocusId).toBe("cfgnav-validator");

    const toRoot = panelNavigationReducer(toGates, { type: "back" });
    expect(currentEntry(toRoot).scrollTop).toBe(40);
    expect(currentEntry(toRoot).returnFocusId).toBe("cfgnav-gates");
  });

  it("resets to the root — the scope switch discards the whole stack", () => {
    const deep = push(push(createPanelNavigationState(), "gates"), "validator");
    const reset = panelNavigationReducer(deep, { type: "reset" });

    expect(reset.stack).toHaveLength(1);
    expect(currentEntry(reset).screenId).toBe(ROOT_SCREEN_ID);
  });

  it("seeds a deep stack for a deep-linked screen", () => {
    const seeded = createPanelNavigationState(["gates", "validator"]);

    expect(currentEntry(seeded).screenId).toBe("validator");
    expect(parentScreenId(seeded)).toBe("gates");
  });
});
