// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import MobileActionMenu from "./MobileActionMenu";

const baseProps = {
  tddEnabled: false,
  onTddToggle: vi.fn(),
  commitDisabled: false,
  mergeDisabled: false,
  onCommit: vi.fn(),
  onMerge: vi.fn(),
  onDelete: vi.fn(),
};

describe("MobileActionMenu", () => {
  it("renders close button when open", () => {
    render(<MobileActionMenu {...baseProps} />);
    // Open the menu
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    expect(
      screen.getByRole("button", { name: "Close menu" }),
    ).toBeInTheDocument();
  });

  it("closes the menu when close button is clicked", () => {
    const { container } = render(<MobileActionMenu {...baseProps} />);
    // Open the menu
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    expect(
      container.querySelector(".mobile-action-sheet.visible"),
    ).toBeInTheDocument();

    // Close via button
    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));
    expect(
      container.querySelector(".mobile-action-sheet.visible"),
    ).not.toBeInTheDocument();
  });
});
