// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "./Accordion";

// Radix Accordion measures content via ResizeObserver (polyfilled in
// vitest.jsdom.setup) and may capture the pointer; stub the pointer methods jsdom omits.
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

afterEach(cleanup);

function ThreeItems(props: React.ComponentProps<typeof Accordion>) {
  return (
    <Accordion {...props}>
      <AccordionItem value="a">
        <AccordionTrigger>First</AccordionTrigger>
        <AccordionContent>body-a</AccordionContent>
      </AccordionItem>
      <AccordionItem value="b">
        <AccordionTrigger>Second</AccordionTrigger>
        <AccordionContent>body-b</AccordionContent>
      </AccordionItem>
      <AccordionItem value="c" disabled>
        <AccordionTrigger>Third</AccordionTrigger>
        <AccordionContent>body-c</AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

describe("Accordion", () => {
  it("type=single collapsible: opening one section collapses the previously open one", () => {
    render(<ThreeItems type="single" collapsible />);

    fireEvent.click(screen.getByRole("button", { name: /First/ }));
    expect(screen.getByText("body-a")).toBeInTheDocument();
    expect(screen.queryByText("body-b")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Second/ }));
    expect(screen.queryByText("body-a")).not.toBeInTheDocument();
    expect(screen.getByText("body-b")).toBeInTheDocument();
  });

  it("type=single collapsible: clicking the open section's trigger closes it", () => {
    render(<ThreeItems type="single" collapsible />);
    const first = screen.getByRole("button", { name: /First/ });
    fireEvent.click(first);
    expect(screen.getByText("body-a")).toBeInTheDocument();
    fireEvent.click(first);
    expect(screen.queryByText("body-a")).not.toBeInTheDocument();
  });

  it("type=multiple: independent sections stay open together", () => {
    render(<ThreeItems type="multiple" />);
    fireEvent.click(screen.getByRole("button", { name: /First/ }));
    fireEvent.click(screen.getByRole("button", { name: /Second/ }));
    expect(screen.getByText("body-a")).toBeInTheDocument();
    expect(screen.getByText("body-b")).toBeInTheDocument();
  });

  it("wires APG accordion semantics: header buttons with aria-expanded/controls and a region", () => {
    render(<ThreeItems type="single" collapsible />);
    const trigger = screen.getByRole("button", { name: /First/ });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    const region = screen.getByRole("region");
    expect(region).toHaveTextContent("body-a");
    expect(trigger.getAttribute("aria-controls")).toBe(region.id);
  });

  it("disabled item: trigger is disabled and does not open", () => {
    render(<ThreeItems type="single" collapsible />);
    const third = screen.getByRole("button", { name: /Third/ });
    expect(third).toBeDisabled();
    expect(third).toHaveAttribute("data-disabled");
    fireEvent.click(third);
    expect(screen.queryByText("body-c")).not.toBeInTheDocument();
  });

  it("root and item own the CC grouped-section recipe; trigger shares the disclosure focus ring", () => {
    const { container } = render(<ThreeItems type="single" collapsible />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("rounded-md");
    expect(root.className).toContain("border-border-subtle");

    // Items divide with a top border, suppressed on the first.
    const items = root.children;
    expect((items[0] as HTMLElement).className).toContain("first:border-t-0");
    expect((items[1] as HTMLElement).className).toContain("border-t");

    const trigger = screen.getByRole("button", { name: /First/ });
    expect(trigger.className).toContain(
      "focus-visible:[outline:2px_solid_var(--color-cyan)]",
    );
  });

  it("content carries the motion-safe reveal and appends layoutClassName last", () => {
    render(
      <Accordion type="single" collapsible defaultValue="a">
        <AccordionItem value="a">
          <AccordionTrigger>First</AccordionTrigger>
          <AccordionContent layoutClassName="px-6">body-a</AccordionContent>
        </AccordionItem>
      </Accordion>,
    );
    const content = screen.getByRole("region");
    expect(content.className).toContain(
      "data-[state=open]:motion-safe:animate-[fadeIn_0.15s_ease]",
    );
    expect(content.className.trim().split(/\s+/).at(-1)).toBe("px-6");
  });

  it("trigger renders an auto-rotating chevron suppressible with hideChevron", () => {
    render(
      <Accordion type="single" collapsible>
        <AccordionItem value="a">
          <AccordionTrigger>First</AccordionTrigger>
          <AccordionContent>body-a</AccordionContent>
        </AccordionItem>
        <AccordionItem value="b">
          <AccordionTrigger hideChevron>Second</AccordionTrigger>
          <AccordionContent>body-b</AccordionContent>
        </AccordionItem>
      </Accordion>,
    );
    const first = screen.getByRole("button", { name: /First/ });
    const chevron = first.querySelector("svg");
    expect(chevron).not.toBeNull();
    expect(chevron?.getAttribute("class") ?? "").toContain(
      "group-data-[state=open]:rotate-180",
    );
    expect(
      screen.getByRole("button", { name: /Second/ }).querySelector("svg"),
    ).toBeNull();
  });
});

describe("Accordion — asChild (unstyled) escape hatch", () => {
  // A fully bespoke accordion (e.g. CommitHistory's timeline rail + grid header):
  // root, item, trigger and content all adopt the consumer's own elements while
  // Radix keeps single-open semantics, roving focus, aria wiring, and mount/unmount.
  function Bespoke(props: { defaultValue?: string }) {
    return (
      <Accordion
        type="single"
        collapsible
        defaultValue={props.defaultValue}
        asChild
      >
        <div className="bespoke-rail">
          <AccordionItem value="a" asChild>
            <div className="bespoke-row">
              <AccordionTrigger asChild>
                <button type="button" className="bespoke-grid grid grid-cols-2">
                  First
                </button>
              </AccordionTrigger>
              <AccordionContent asChild>
                <section className="bespoke-panel">body-a</section>
              </AccordionContent>
            </div>
          </AccordionItem>
          <AccordionItem value="b" asChild>
            <div className="bespoke-row">
              <AccordionTrigger asChild>
                <button type="button" className="bespoke-grid">
                  Second
                </button>
              </AccordionTrigger>
              <AccordionContent asChild>
                <section className="bespoke-panel">body-b</section>
              </AccordionContent>
            </div>
          </AccordionItem>
        </div>
      </Accordion>
    );
  }

  it("root/item/trigger/content adopt consumer elements and drop the baked recipes", () => {
    const { container } = render(<Bespoke />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toBe("bespoke-rail");
    expect(root.className).not.toContain("rounded-md");
    expect(root.className).not.toContain("border-border-subtle");

    const trigger = screen.getByRole("button", { name: /First/ });
    expect(trigger.className).toContain("bespoke-grid");
    expect(trigger.className).not.toContain(
      "focus-visible:[outline:2px_solid_var(--color-cyan)]",
    );
    // No injected chevron in the single asChild child.
    expect(trigger.querySelector("svg")).toBeNull();
  });

  it("preserves Radix single-open semantics and aria wiring through asChild", () => {
    render(<Bespoke />);
    const first = screen.getByRole("button", { name: /First/ });
    const second = screen.getByRole("button", { name: /Second/ });

    fireEvent.click(first);
    expect(first).toHaveAttribute("aria-expanded", "true");
    const region = screen.getByRole("region");
    expect(region.tagName).toBe("SECTION");
    expect(region.className).toContain("bespoke-panel");
    expect(first.getAttribute("aria-controls")).toBe(region.id);

    // Single: opening the second collapses the first.
    fireEvent.click(second);
    expect(first).toHaveAttribute("aria-expanded", "false");
    expect(second).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByText("body-a")).not.toBeInTheDocument();
  });
});
