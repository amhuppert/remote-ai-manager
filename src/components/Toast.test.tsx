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
    expect(screen.getByRole("status")).toHaveClass("cc-toast");
  });
});
