// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MobileActionMenu from "./MobileActionMenu";

const baseProps = {
  tddEnabled: false,
  onTddToggle: vi.fn(),
  onDelete: vi.fn(),
};

describe("MobileActionMenu", () => {
  it("contains keyboard focus while open and returns it to More on Escape", async () => {
    const user = userEvent.setup();
    render(<MobileActionMenu {...baseProps} />);
    const trigger = screen.getByRole("button", { name: "Session actions" });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Session actions" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("renders close button when open", () => {
    render(<MobileActionMenu {...baseProps} />);
    // Open the menu
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    expect(
      screen.getByRole("button", { name: "Close menu" }),
    ).toBeInTheDocument();
  });

  it("portals the open overlay outside its render container", () => {
    const { container } = render(<MobileActionMenu {...baseProps} />);

    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));

    const sheet =
      document.body.querySelector<HTMLElement>('[data-open="true"]');
    expect(sheet).toHaveAttribute("data-open", "true");
    expect(container).not.toContainElement(sheet);
  });

  it("closes the menu when close button is clicked", () => {
    render(<MobileActionMenu {...baseProps} />);
    // Open: the sheet exposes its state via data-open, the backdrop via .visible.
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    expect(document.body.querySelector('[data-open="true"]')).not.toBeNull();
    expect(document.body.querySelector("[data-cc-modal-scrim]")).not.toBeNull();

    // Close via button
    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));
    expect(document.body.querySelector('[data-open="true"]')).toBeNull();
    expect(document.body.querySelector("[data-cc-modal-scrim]")).toBeNull();
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
