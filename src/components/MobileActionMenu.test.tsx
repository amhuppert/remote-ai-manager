// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import MobileActionMenu from "./MobileActionMenu";

const baseProps = {
  tddEnabled: false,
  onTddToggle: vi.fn(),
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
    // Open: the sheet exposes its state via data-open, the backdrop via .visible.
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    expect(container.querySelector('[data-open="true"]')).not.toBeNull();
    expect(
      container.querySelector(".mobile-action-backdrop.visible"),
    ).not.toBeNull();

    // Close via button
    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));
    expect(container.querySelector('[data-open="true"]')).toBeNull();
    expect(
      container.querySelector(".mobile-action-backdrop.visible"),
    ).toBeNull();
  });

  it("does not render Commit or Merge actions", () => {
    render(<MobileActionMenu {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));

    expect(
      screen.queryByRole("button", { name: /commit/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /merge/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /delete session/i }),
    ).toBeInTheDocument();
  });
});
