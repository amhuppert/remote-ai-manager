// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import TooltipProvider from "./TooltipProvider";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("TooltipProvider", () => {
  it("does not expose an empty tooltip while idle", () => {
    render(<TooltipProvider />);

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("reveals focused hints, associates them with the trigger, and dismisses on Escape", async () => {
    render(
      <>
        <span id="existing-description">Existing description</span>
        <button
          type="button"
          data-tooltip="Helpful hint"
          aria-describedby="existing-description"
        >
          Trigger
        </button>
        <TooltipProvider />
      </>,
    );
    const trigger = screen.getByRole("button", { name: "Trigger" });

    act(() => trigger.focus());

    const tooltip = await screen.findByRole("tooltip", {
      name: "Helpful hint",
    });
    expect(trigger).toHaveAttribute(
      "aria-describedby",
      `existing-description ${tooltip.id}`,
    );
    expect(document.activeElement).toBe(trigger);

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() =>
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveAttribute("aria-describedby", "existing-description");
    expect(document.activeElement).toBe(trigger);
  });

  it("preserves pointer reveal and delayed pointer-leave dismissal", () => {
    vi.useFakeTimers();
    render(
      <>
        <button type="button" data-tooltip="Pointer hint">
          Trigger
        </button>
        <TooltipProvider />
      </>,
    );
    const trigger = screen.getByRole("button", { name: "Trigger" });

    fireEvent.mouseEnter(trigger);
    expect(
      screen.getByRole("tooltip", { name: "Pointer hint" }),
    ).toBeInTheDocument();

    fireEvent.mouseLeave(trigger);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(50));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});

describe("TooltipProvider pointer dismissal", () => {
  function portal(): HTMLElement | null {
    return document.querySelector<HTMLElement>(".tooltip-portal");
  }

  function isShowing(text: string): boolean {
    const el = portal();
    return !!el && el.style.opacity === "1" && el.textContent === text;
  }

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

  it("does not expose an empty tooltip to assistive technology", () => {
    expect(portal()).toBeNull();
  });

  it("shows the tooltip when a data-tooltip element is hovered", () => {
    hoverTrigger();
    expect(isShowing("New conversation")).toBe(true);
    expect(portal()).toHaveAttribute("role", "tooltip");
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
