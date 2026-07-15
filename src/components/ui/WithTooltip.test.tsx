// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { TooltipProvider } from "./Tooltip";
import { WithTooltip } from "./WithTooltip";

// Radix moves focus / animates content on open; jsdom implements neither the
// pointer-capture nor the scroll APIs Radix touches.
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

afterEach(cleanup);

function Harness({
  label,
  open,
}: {
  label: React.ReactNode;
  open?: boolean;
}): React.JSX.Element {
  return (
    <TooltipProvider delayDuration={0}>
      <WithTooltip label={label}>
        <button type="button" data-open={open ? "" : undefined}>
          Trigger
        </button>
      </WithTooltip>
    </TooltipProvider>
  );
}

describe("WithTooltip", () => {
  it("renders the trigger as the tooltip anchor", () => {
    render(<Harness label="Copy" />);
    expect(screen.getByRole("button", { name: "Trigger" })).toBeInTheDocument();
  });

  it("renders the child bare (no tooltip wiring) when the label is empty", () => {
    render(<Harness label="" />);
    const trigger = screen.getByRole("button", { name: "Trigger" });
    // A bare child carries no Radix trigger data-state / describedby wiring.
    expect(trigger).not.toHaveAttribute("data-state");
  });

  it("renders the child bare when the label is nullish", () => {
    render(<Harness label={undefined} />);
    const trigger = screen.getByRole("button", { name: "Trigger" });
    expect(trigger).not.toHaveAttribute("data-state");
  });

  it("wraps the child with Radix trigger wiring when a label is present", () => {
    render(<Harness label="Copy" />);
    const trigger = screen.getByRole("button", { name: "Trigger" });
    // Radix stamps the trigger with its own data-state once wired.
    expect(trigger).toHaveAttribute("data-state");
  });
});
