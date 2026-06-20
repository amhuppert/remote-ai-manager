// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ConversationTab, { type ConversationTabProps } from "./ConversationTab";

function renderTab(overrides: Partial<ConversationTabProps> = {}): {
  onActivate: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
} {
  const onActivate = vi.fn();
  const onClose = vi.fn();
  render(
    <ConversationTab
      id="a"
      title="Conversation A"
      status="running"
      active={false}
      hotkeyHint="⌘1"
      onActivate={onActivate}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onActivate, onClose };
}

describe("ConversationTab", () => {
  it("renders the title, status dot, and hotkey hint", () => {
    renderTab();

    expect(screen.getByText("Conversation A")).toBeInTheDocument();
    expect(screen.getByText("⌘1")).toBeInTheDocument();

    const tab = screen.getByRole("tab");
    const dot = tab.querySelector("[data-status]");
    expect(dot).not.toBeNull();
    expect(dot?.getAttribute("data-status")).toBe("running");
  });

  it("omits the hotkey hint when not provided", () => {
    renderTab({ hotkeyHint: undefined });

    expect(screen.queryByText(/⌘/)).not.toBeInTheDocument();
  });

  it("marks the active tab via aria-selected and data-active", () => {
    renderTab({ active: true });

    const tab = screen.getByRole("tab");
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(tab).toHaveAttribute("data-active", "true");
  });

  it("does not mark inactive tabs", () => {
    renderTab({ active: false });

    const tab = screen.getByRole("tab");
    expect(tab).toHaveAttribute("aria-selected", "false");
    expect(tab).toHaveAttribute("data-active", "false");
  });

  it("activates on click", () => {
    const { onActivate } = renderTab();

    fireEvent.click(screen.getByRole("tab"));
    expect(onActivate).toHaveBeenCalledWith("a");
  });

  it("activates on Enter and Space", () => {
    const { onActivate } = renderTab();
    const tab = screen.getByRole("tab");

    fireEvent.keyDown(tab, { key: "Enter" });
    fireEvent.keyDown(tab, { key: " " });
    expect(onActivate).toHaveBeenCalledTimes(2);
    expect(onActivate).toHaveBeenNthCalledWith(1, "a");
    expect(onActivate).toHaveBeenNthCalledWith(2, "a");
  });

  it("closes via the close control without activating (stopPropagation)", () => {
    const { onActivate, onClose } = renderTab();

    fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
    expect(onClose).toHaveBeenCalledWith("a");
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("keeps the close control in the DOM even when inactive (CSS controls reveal)", () => {
    renderTab({ active: false });

    expect(
      screen.getByRole("button", { name: "Close tab" }),
    ).toBeInTheDocument();
  });
});
