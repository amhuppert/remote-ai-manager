// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { render, cleanup } from "@testing-library/react";
import TooltipProvider from "./TooltipProvider";

function portal(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".tooltip-portal");
}

function isShowing(text: string): boolean {
  const el = portal();
  return !!el && el.style.opacity === "1" && el.textContent === text;
}

describe("TooltipProvider", () => {
  let trigger: HTMLButtonElement;

  beforeEach(() => {
    vi.useFakeTimers();
    trigger = document.createElement("button");
    trigger.setAttribute("data-tooltip", "New conversation");
    document.body.appendChild(trigger);
    render(<TooltipProvider />);
  });

  afterEach(() => {
    cleanup();
    trigger.remove();
    vi.useRealTimers();
  });

  function hoverTrigger() {
    act(() => {
      trigger.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    });
  }

  it("shows the tooltip when a data-tooltip element is hovered", () => {
    hoverTrigger();
    expect(isShowing("New conversation")).toBe(true);
  });

  it("hides on mouseleave from the tracked trigger", () => {
    hoverTrigger();
    expect(isShowing("New conversation")).toBe(true);

    act(() => {
      trigger.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }));
      vi.advanceTimersByTime(80);
    });
    expect(isShowing("New conversation")).toBe(false);
  });

  // Reported bug: the "New conversation" button sets `disabled` while its
  // create-conversation mutation is pending. Disabled elements never dispatch
  // mouseleave, so the hover-hide path can't fire — the tooltip must instead
  // self-heal the moment the pointer moves over anything outside the trigger.
  it("hides when the pointer leaves a trigger that was disabled while hovered", () => {
    hoverTrigger();
    expect(isShowing("New conversation")).toBe(true);

    // Mutation goes pending → the trigger is disabled. No mouseleave fires.
    trigger.disabled = true;

    // The user moves the mouse away, over some other part of the page.
    act(() => {
      document.body.dispatchEvent(
        new MouseEvent("pointermove", { bubbles: true }),
      );
    });
    expect(isShowing("New conversation")).toBe(false);
  });

  it("stays visible while the pointer moves within the tracked trigger", () => {
    const child = document.createElement("span");
    trigger.appendChild(child);
    hoverTrigger();
    expect(isShowing("New conversation")).toBe(true);

    act(() => {
      child.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
    });
    expect(isShowing("New conversation")).toBe(true);
  });

  it("hides when the user presses anywhere else on the page", () => {
    hoverTrigger();
    expect(isShowing("New conversation")).toBe(true);

    act(() => {
      document.body.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true }),
      );
    });
    expect(isShowing("New conversation")).toBe(false);
  });

  it("hides when the trigger itself is pressed", () => {
    hoverTrigger();
    expect(isShowing("New conversation")).toBe(true);

    act(() => {
      trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(isShowing("New conversation")).toBe(false);
  });

  it("hides when the tracked trigger is unmounted while hovered", () => {
    hoverTrigger();
    expect(isShowing("New conversation")).toBe(true);

    trigger.remove();
    act(() => {
      document.body.dispatchEvent(
        new MouseEvent("pointermove", { bubbles: true }),
      );
    });
    expect(isShowing("New conversation")).toBe(false);
  });
});
