// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import Toast from "./Toast";

describe("Toast", () => {
  it("renders the message", () => {
    render(<Toast message="Archived 3 sessions" onDismiss={vi.fn()} />);
    expect(screen.getByText("Archived 3 sessions")).toBeInTheDocument();
  });

  it("calls onDismiss when the toast is clicked", () => {
    const onDismiss = vi.fn();
    render(<Toast message="hi" onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("status"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("uses role=status for accessibility", () => {
    render(<Toast message="hi" onDismiss={vi.fn()} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("clicking the toast body dismisses without invoking the action", () => {
    const onDismiss = vi.fn();
    const onClick = vi.fn();
    render(
      <Toast
        message="Couldn't move"
        action={{ label: "Retry", onClick }}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole("status"));
    expect(onClick).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
