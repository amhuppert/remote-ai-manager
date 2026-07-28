// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfigToggle } from "./ConfigToggle";

// Radix Switch captures the pointer on press; jsdom implements none of these.
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

afterEach(cleanup);

describe("ConfigToggle", () => {
  it("renders ON when value is true", () => {
    render(
      <ConfigToggle label="Tailscale enabled" value onChange={() => {}} />,
    );
    expect(screen.getByText("ON")).toBeVisible();
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  });

  it("renders OFF when value is false", () => {
    render(
      <ConfigToggle
        label="Tailscale enabled"
        value={false}
        onChange={() => {}}
      />,
    );
    expect(screen.getByText("OFF")).toBeVisible();
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });

  it("exposes the field label as the switch's accessible name", () => {
    render(
      <ConfigToggle
        label="Tailscale enabled"
        value={false}
        onChange={() => {}}
      />,
    );
    expect(
      screen.getByRole("switch", { name: "Tailscale enabled" }),
    ).toBeInTheDocument();
  });

  it("provides a 44px mobile touch target across the full toggle row", () => {
    render(<ConfigToggle label="x" value={false} onChange={() => {}} />);

    expect(screen.getByRole("switch").closest("label")).toHaveClass(
      "max-768:min-h-[var(--touch-target-min)]",
    );
  });

  it("calls onChange with toggled value on switch click", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ConfigToggle label="x" value={false} onChange={onChange} />);
    await user.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("toggles when the ON/OFF caption is clicked (full-row target)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ConfigToggle label="x" value={false} onChange={onChange} />);
    await user.click(screen.getByText("OFF"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("calls onChange with toggled value on Enter key", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ConfigToggle label="x" value={false} onChange={onChange} />);
    screen.getByRole("switch").focus();
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("calls onChange with toggled value on Space key", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ConfigToggle label="x" value onChange={onChange} />);
    screen.getByRole("switch").focus();
    await user.keyboard(" ");
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("does not call onChange when disabled (click, caption, or keyboard)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ConfigToggle label="x" value={false} onChange={onChange} disabled />,
    );
    const el = screen.getByRole("switch");
    await user.click(el);
    await user.click(screen.getByText("OFF"));
    el.focus();
    await user.keyboard(" ");
    await user.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();
  });
});
