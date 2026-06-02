import { describe, it, expect, beforeEach } from "vitest";
import {
  _useOverlayScopeStore,
  isOverlayOpen,
  isTopOverlay,
} from "./overlay-scope.store";

describe("overlay-scope store", () => {
  beforeEach(() => {
    _useOverlayScopeStore.setState({ openStack: [] });
  });

  it("starts closed", () => {
    expect(isOverlayOpen()).toBe(false);
  });

  it("marks open and sets the top after a push", () => {
    _useOverlayScopeStore.getState().pushOverlay("a");
    expect(isOverlayOpen()).toBe(true);
    expect(isTopOverlay("a")).toBe(true);
  });

  it("restores closed state after a matching pop", () => {
    const { pushOverlay, popOverlay } = _useOverlayScopeStore.getState();
    pushOverlay("a");
    popOverlay("a");
    expect(isOverlayOpen()).toBe(false);
  });

  it("tracks the topmost token across stacked overlays", () => {
    const { pushOverlay, popOverlay } = _useOverlayScopeStore.getState();
    pushOverlay("a");
    pushOverlay("b");
    expect(isTopOverlay("b")).toBe(true);
    expect(isTopOverlay("a")).toBe(false);
    popOverlay("b");
    expect(isTopOverlay("a")).toBe(true);
  });

  it("pop removes only the first matching token", () => {
    const { pushOverlay, popOverlay } = _useOverlayScopeStore.getState();
    pushOverlay("a");
    pushOverlay("a");
    popOverlay("a");
    expect(isOverlayOpen()).toBe(true);
  });

  it("isTopOverlay is false for an unknown token", () => {
    _useOverlayScopeStore.getState().pushOverlay("a");
    expect(isTopOverlay("zzz")).toBe(false);
  });
});
