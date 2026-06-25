// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "./Collapsible";

// Radix Collapsible measures content via ResizeObserver (polyfilled in
// vitest.setup) and may capture the pointer; stub the pointer methods jsdom omits.
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

afterEach(cleanup);

describe("Collapsible", () => {
  it("is closed by default: content is absent and aria-expanded is false", () => {
    render(
      <Collapsible>
        <CollapsibleTrigger>More</CollapsibleTrigger>
        <CollapsibleContent>body</CollapsibleContent>
      </Collapsible>,
    );
    const trigger = screen.getByRole("button", { name: /More/ });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("body")).not.toBeInTheDocument();
  });

  it("uncontrolled: clicking the trigger reveals the content and wires aria-controls", () => {
    render(
      <Collapsible>
        <CollapsibleTrigger>More</CollapsibleTrigger>
        <CollapsibleContent>body</CollapsibleContent>
      </Collapsible>,
    );
    const trigger = screen.getByRole("button", { name: /More/ });
    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const body = screen.getByText("body");
    expect(body).toBeInTheDocument();
    expect(trigger.getAttribute("aria-controls")).toBe(body.id);
  });

  it("defaultOpen renders the content open on first paint", () => {
    render(
      <Collapsible defaultOpen>
        <CollapsibleTrigger>More</CollapsibleTrigger>
        <CollapsibleContent>body</CollapsibleContent>
      </Collapsible>,
    );
    expect(screen.getByText("body")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /More/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("controlled: open is driven by the prop and onOpenChange fires on toggle", () => {
    const onOpenChange = vi.fn();
    render(
      <Collapsible open={false} onOpenChange={onOpenChange}>
        <CollapsibleTrigger>More</CollapsibleTrigger>
        <CollapsibleContent>body</CollapsibleContent>
      </Collapsible>,
    );
    expect(screen.queryByText("body")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /More/ }));
    expect(onOpenChange).toHaveBeenCalledWith(true);
    // Still closed: parent owns the open state in controlled mode.
    expect(screen.queryByText("body")).not.toBeInTheDocument();
  });

  it("disabled: trigger is disabled, carries data-disabled, and does not open", () => {
    const onOpenChange = vi.fn();
    render(
      <Collapsible disabled onOpenChange={onOpenChange}>
        <CollapsibleTrigger>More</CollapsibleTrigger>
        <CollapsibleContent>body</CollapsibleContent>
      </Collapsible>,
    );
    const trigger = screen.getByRole("button", { name: /More/ });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute("data-disabled");
    fireEvent.click(trigger);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.queryByText("body")).not.toBeInTheDocument();
  });

  it("trigger owns the CC disclosure recipe: full-width, canonical focus ring, disabled treatment", () => {
    render(
      <Collapsible>
        <CollapsibleTrigger>More</CollapsibleTrigger>
      </Collapsible>,
    );
    const trigger = screen.getByRole("button", { name: /More/ });
    expect(trigger.className).toContain("w-full");
    expect(trigger.className).toContain(
      "focus-visible:[outline:2px_solid_var(--color-cyan)]",
    );
    expect(trigger.className).toContain("data-[disabled]:opacity-50");
  });

  it("trigger renders an auto-rotating chevron that can be suppressed with hideChevron", () => {
    const { rerender } = render(
      <Collapsible defaultOpen>
        <CollapsibleTrigger>More</CollapsibleTrigger>
      </Collapsible>,
    );
    const chevron = screen
      .getByRole("button", { name: /More/ })
      .querySelector("svg");
    expect(chevron).not.toBeNull();
    expect(chevron?.getAttribute("class") ?? "").toContain(
      "group-data-[state=open]:rotate-180",
    );

    rerender(
      <Collapsible defaultOpen>
        <CollapsibleTrigger hideChevron>More</CollapsibleTrigger>
      </Collapsible>,
    );
    expect(
      screen.getByRole("button", { name: /More/ }).querySelector("svg"),
    ).toBeNull();
  });

  it("content carries the motion-safe reveal and appends layoutClassName last", () => {
    render(
      <Collapsible defaultOpen>
        <CollapsibleTrigger layoutClassName="mt-4">More</CollapsibleTrigger>
        <CollapsibleContent layoutClassName="mx-2">body</CollapsibleContent>
      </Collapsible>,
    );
    const trigger = screen.getByRole("button", { name: /More/ });
    expect(trigger.className.trim().split(/\s+/).at(-1)).toBe("mt-4");

    const content = screen.getByText("body");
    expect(content.className).toContain(
      "data-[state=open]:motion-safe:animate-[fadeIn_0.15s_ease]",
    );
    expect(content.className.trim().split(/\s+/).at(-1)).toBe("mx-2");
  });
});

describe("Collapsible — asChild (unstyled) escape hatch", () => {
  it("CollapsibleTrigger asChild adopts the consumer's element, dropping the baked recipe and chevron while keeping Radix behaviour", () => {
    render(
      <Collapsible>
        <CollapsibleTrigger asChild>
          <button type="button" className="bespoke-header grid grid-cols-2">
            <span>Commit row</span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>body</CollapsibleContent>
      </Collapsible>,
    );
    const trigger = screen.getByRole("button", { name: /Commit row/ });
    // Consumer appearance survives; the baked disclosure recipe is NOT applied.
    expect(trigger.className).toContain("bespoke-header");
    expect(trigger.className).not.toContain(
      "focus-visible:[outline:2px_solid_var(--color-cyan)]",
    );
    // No injected chevron polluting the single asChild child.
    expect(trigger.querySelector("svg")).toBeNull();
    // Radix behaviour is still wired onto the consumer element.
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const body = screen.getByText("body");
    expect(trigger.getAttribute("aria-controls")).toBe(body.id);
  });

  it("CollapsibleTrigger asChild still merges layoutClassName (layout-only escape hatch) onto the child", () => {
    render(
      <Collapsible>
        <CollapsibleTrigger asChild layoutClassName="mb-2">
          <button type="button" className="bespoke-header">
            Header
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>body</CollapsibleContent>
      </Collapsible>,
    );
    const trigger = screen.getByRole("button", { name: /Header/ });
    expect(trigger.className).toContain("bespoke-header");
    expect(trigger.className).toContain("mb-2");
  });

  it("CollapsibleContent asChild adopts the consumer's region element without the motion recipe", () => {
    render(
      <Collapsible defaultOpen>
        <CollapsibleTrigger asChild>
          <button type="button">Header</button>
        </CollapsibleTrigger>
        <CollapsibleContent asChild>
          <section className="bespoke-region">body</section>
        </CollapsibleContent>
      </Collapsible>,
    );
    const region = screen.getByText("body");
    expect(region.tagName).toBe("SECTION");
    expect(region.className).toContain("bespoke-region");
    expect(region.className).not.toContain(
      "data-[state=open]:motion-safe:animate-[fadeIn_0.15s_ease]",
    );
  });
});
