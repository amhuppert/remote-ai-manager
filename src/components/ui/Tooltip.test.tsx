// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  TooltipProvider,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "./Tooltip";

// Radix moves focus / animates content on open; jsdom implements neither of the
// pointer-capture / scroll APIs Radix touches.
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

afterEach(cleanup);

// Radix exposes the accessible description on a visually-hidden `role="tooltip"`
// span (the trigger's `aria-describedby` target) nested inside the styled bubble.
// The bubble — the element our recipe lands on — is that span's parent.
function bubble(): HTMLElement {
  return screen.getByRole("tooltip").parentElement as HTMLElement;
}

function Hint({
  open,
  layoutClassName,
  delayDuration,
}: {
  open?: boolean;
  layoutClassName?: string;
  delayDuration?: number;
}): React.JSX.Element {
  return (
    <TooltipProvider delayDuration={delayDuration}>
      <Tooltip open={open}>
        <TooltipTrigger asChild>
          <button type="button">Trigger</button>
        </TooltipTrigger>
        <TooltipContent layoutClassName={layoutClassName}>
          Helpful hint
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

describe("Tooltip", () => {
  it("exposes provider/root/trigger/content as the primitive surface", () => {
    expect(typeof TooltipProvider).toBe("function");
    expect(typeof Tooltip).toBe("function");
    // Trigger is a structural Radix re-export (component or forwardRef object).
    expect(TooltipTrigger).toBeDefined();
    expect(typeof TooltipContent).toBe("function");
  });

  it("renders the open content with role=tooltip", () => {
    render(<Hint open delayDuration={0} />);
    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toContain("Helpful hint");
  });

  it("portals the content to document.body (above every stacking context)", () => {
    const { container } = render(<Hint open delayDuration={0} />);
    const tip = screen.getByRole("tooltip");
    // The tip is portalled, so it is NOT a descendant of the inline render root.
    expect(container.contains(tip)).toBe(false);
    expect(document.body.contains(tip)).toBe(true);
  });

  it("paints the content with the token-backed .tooltip-portal recipe", () => {
    render(<Hint open delayDuration={0} />);
    const tip = bubble();
    for (const cls of [
      "px-[8px]",
      "py-[4px]",
      "bg-bg-raised",
      "border",
      "border-solid",
      "border-border-default",
      "rounded-sm",
      "font-mono",
      "text-[0.7rem]",
      "font-medium",
      "text-text-secondary",
      "z-tooltip",
    ]) {
      expect(tip.className.split(/\s+/), `missing class: ${cls}`).toContain(
        cls,
      );
    }
  });

  it("gates the entrance animation behind motion-safe", () => {
    render(<Hint open delayDuration={0} />);
    const tip = bubble();
    expect(tip.className).toContain(
      "data-[state=delayed-open]:motion-safe:animate-[fadeIn_0.12s_ease]",
    );
  });

  it("wires aria-describedby from the trigger to the open tooltip", () => {
    render(<Hint open delayDuration={0} />);
    const trigger = screen.getByRole("button", { name: "Trigger" });
    const tip = screen.getByRole("tooltip");
    const describedBy = trigger.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(describedBy).toBe(tip.id);
  });

  it("appends layoutClassName last, after the appearance utilities", () => {
    render(<Hint open delayDuration={0} layoutClassName="max-w-[200px]" />);
    const tip = bubble();
    expect(tip.className.trim().endsWith("max-w-[200px]")).toBe(true);
  });
});
