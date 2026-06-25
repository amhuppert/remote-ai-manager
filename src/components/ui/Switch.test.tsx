// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Switch } from "./Switch";

// Radix Switch captures the pointer on press; jsdom implements none of these.
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

afterEach(cleanup);

function getSwitch(): HTMLButtonElement {
  return screen.getByRole("switch") as HTMLButtonElement;
}

function getThumb(root: HTMLElement): HTMLElement {
  const thumb = root.firstElementChild;
  if (!(thumb instanceof HTMLElement)) throw new Error("thumb not rendered");
  return thumb;
}

describe("Switch — role and name semantics", () => {
  it("renders role=switch with an accessible name from aria-label", () => {
    render(<Switch aria-label="Enable telemetry" />);
    expect(
      screen.getByRole("switch", { name: "Enable telemetry" }),
    ).toBeInTheDocument();
  });

  it("associates with an external <label htmlFor>", () => {
    render(
      <>
        <label htmlFor="sw-1">Red-green TDD</label>
        <Switch id="sw-1" />
      </>,
    );
    expect(
      screen.getByRole("switch", { name: "Red-green TDD" }),
    ).toBeInTheDocument();
  });
});

describe("Switch — checked / unchecked / disabled state", () => {
  it("reflects unchecked via aria-checked and data-state", () => {
    render(<Switch aria-label="x" checked={false} />);
    const el = getSwitch();
    expect(el).toHaveAttribute("aria-checked", "false");
    expect(el).toHaveAttribute("data-state", "unchecked");
  });

  it("reflects checked via aria-checked and data-state", () => {
    render(<Switch aria-label="x" checked />);
    const el = getSwitch();
    expect(el).toHaveAttribute("aria-checked", "true");
    expect(el).toHaveAttribute("data-state", "checked");
  });

  it("carries off/on track recipe classes gated on data-state", () => {
    render(<Switch aria-label="x" />);
    const el = getSwitch();
    expect(el).toHaveClass("data-[state=unchecked]:border-border-default");
    expect(el).toHaveClass("data-[state=unchecked]:bg-bg-raised");
    expect(el).toHaveClass("data-[state=checked]:border-cyan");
    expect(el).toHaveClass("data-[state=checked]:bg-cyan-glow");
  });

  it("renders disabled with disabled styling", () => {
    render(<Switch aria-label="x" disabled />);
    const el = getSwitch();
    expect(el).toBeDisabled();
    expect(el).toHaveClass("disabled:opacity-45");
    expect(el).toHaveClass("disabled:cursor-not-allowed");
  });
});

describe("Switch — focus-visible outline", () => {
  it("declares the canonical cyan focus-visible outline", () => {
    render(<Switch aria-label="x" />);
    const el = getSwitch();
    expect(el).toHaveClass("outline-none");
    expect(el).toHaveClass(
      "focus-visible:[outline:2px_solid_var(--color-cyan)]",
    );
  });
});

describe("Switch — size variants", () => {
  it("defaults to the md track + thumb dimensions", () => {
    render(<Switch aria-label="x" />);
    const el = getSwitch();
    expect(el).toHaveClass("h-[18px]", "w-[34px]");
    expect(getThumb(el)).toHaveClass("h-[14px]", "w-[14px]");
  });

  it("applies the small (sm) track + thumb dimensions", () => {
    render(<Switch aria-label="x" size="sm" />);
    const el = getSwitch();
    expect(el).toHaveClass("h-[16px]", "w-[32px]");
    expect(getThumb(el)).toHaveClass("h-[12px]", "w-[12px]");
  });

  it("applies the compact track + thumb dimensions", () => {
    render(<Switch aria-label="x" size="compact" />);
    const el = getSwitch();
    expect(el).toHaveClass("h-[12px]", "w-[22px]");
    expect(getThumb(el)).toHaveClass("h-[8px]", "w-[8px]");
  });
});

describe("Switch — tone variants", () => {
  it("uses the cyan on-glow by default", () => {
    render(<Switch aria-label="x" />);
    expect(getSwitch()).toHaveClass(
      "data-[state=checked]:shadow-[0_0_8px_var(--cyan-glow)]",
    );
  });

  it("uses the green on-glow for tone=green", () => {
    render(<Switch aria-label="x" tone="green" />);
    const el = getSwitch();
    expect(el).toHaveClass("data-[state=checked]:border-green");
    expect(el).toHaveClass("data-[state=checked]:bg-green-dim");
  });
});

describe("Switch — thumb motion contract", () => {
  it("moves the thumb under a transform transition gated on checked state", () => {
    render(<Switch aria-label="x" />);
    const thumb = getThumb(getSwitch());
    expect(thumb).toHaveClass(
      "data-[state=checked]:[transform:translateX(16px)]",
    );
    expect(thumb).toHaveClass("motion-reduce:transition-none");
  });
});

describe("Switch — controlled / uncontrolled behavior", () => {
  it("controlled: stays put without an onCheckedChange that updates state", async () => {
    const user = userEvent.setup();
    render(<Switch aria-label="x" checked={false} />);
    const el = getSwitch();
    await user.click(el);
    expect(el).toHaveAttribute("aria-checked", "false");
  });

  it("controlled: fires onCheckedChange with the next value", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(
      <Switch
        aria-label="x"
        checked={false}
        onCheckedChange={onCheckedChange}
      />,
    );
    await user.click(getSwitch());
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("uncontrolled: toggles its own state on click", async () => {
    const user = userEvent.setup();
    render(<Switch aria-label="x" defaultChecked={false} />);
    const el = getSwitch();
    await user.click(el);
    expect(el).toHaveAttribute("aria-checked", "true");
  });
});

describe("Switch — keyboard operation", () => {
  it("toggles on Space when focused", async () => {
    const user = userEvent.setup();
    render(<Switch aria-label="x" defaultChecked={false} />);
    const el = getSwitch();
    el.focus();
    expect(el).toHaveFocus();
    await user.keyboard(" ");
    expect(el).toHaveAttribute("aria-checked", "true");
    await user.keyboard(" ");
    expect(el).toHaveAttribute("aria-checked", "false");
  });
});

describe("Switch — layoutClassName escape hatch", () => {
  it("appends layoutClassName last on the root, for external geometry only", () => {
    render(<Switch aria-label="x" layoutClassName="self-center ml-md" />);
    const el = getSwitch();
    expect(el).toHaveClass("self-center", "ml-md");
    expect(el.className.trimEnd().endsWith("ml-md")).toBe(true);
  });
});
