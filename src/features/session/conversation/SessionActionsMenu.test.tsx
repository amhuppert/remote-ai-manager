// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SessionActionsMenu from "./SessionActionsMenu";

// Radix focuses items / captures the pointer on open; jsdom implements neither.
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

afterEach(cleanup);

describe("SessionActionsMenu", () => {
  it("does not render Commit or Merge actions but keeps Delete", async () => {
    const user = userEvent.setup();
    render(<SessionActionsMenu targetBranch="main" onDelete={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /actions/i }));

    expect(
      screen.queryByRole("menuitem", { name: /commit changes/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: /merge into/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /delete session/i }),
    ).toBeInTheDocument();
  });

  it("invokes onDelete when the delete item is picked", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(<SessionActionsMenu targetBranch="main" onDelete={onDelete} />);

    await user.click(screen.getByRole("button", { name: /actions/i }));
    await user.click(screen.getByRole("menuitem", { name: /delete session/i }));

    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("disables Push and Rebase when no handler is provided", async () => {
    const user = userEvent.setup();
    render(<SessionActionsMenu targetBranch="main" onDelete={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /actions/i }));
    expect(
      screen.getByRole("menuitem", { name: /push branch/i }),
    ).toHaveAttribute("data-disabled");
    expect(
      screen.getByRole("menuitem", { name: /rebase on main/i }),
    ).toHaveAttribute("data-disabled");
  });
});
