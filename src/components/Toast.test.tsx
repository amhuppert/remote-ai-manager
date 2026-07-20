// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Toast from "./Toast";

describe("Toast", () => {
  it("renders the message", () => {
    render(<Toast message="Archived 3 sessions" onDismiss={vi.fn()} />);
    expect(screen.getByText("Archived 3 sessions")).toBeInTheDocument();
  });

  it("does not turn the non-focusable toast body into a dismiss control", () => {
    const onDismiss = vi.fn();
    render(<Toast message="hi" onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("status"));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("uses role=status for accessibility", () => {
    render(<Toast message="hi" onDismiss={vi.fn()} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("keeps standalone viewport placement by default", () => {
    render(<Toast message="hi" onDismiss={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveClass(
      "fixed",
      "bottom-[24px]",
      "left-1/2",
      "z-dropdown",
      "[transform:translateX(-50%)]",
      "animate-bulk-float-in",
    );
  });

  it("renders the action button and invokes it once, then dismisses", () => {
    const onDismiss = vi.fn();
    const onClick = vi.fn();
    render(
      <Toast
        message="Couldn't move"
        action={{ label: "Retry", onClick }}
        onDismiss={onDismiss}
      />,
    );
    const action = screen.getByRole("button", { name: "Retry" });
    expect(action).toHaveClass(
      "min-h-[24px]",
      "min-w-[24px]",
      "focus-visible:[outline:2px_solid_var(--color-cyan)]",
    );
    fireEvent.click(action);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("provides a named 24px close button that keyboard users can activate", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<Toast message="Saved" onDismiss={onDismiss} />);

    const close = screen.getByRole("button", {
      name: "Dismiss notification",
    });
    expect(close).toHaveClass(
      "size-[24px]",
      "focus-visible:[outline:2px_solid_var(--color-cyan)]",
    );

    await user.tab();
    expect(close).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
