// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import SessionActionsMenu from "./SessionActionsMenu";

describe("SessionActionsMenu", () => {
  it("does not render Commit or Merge actions but keeps Delete", () => {
    render(<SessionActionsMenu targetBranch="main" onDelete={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /actions/i }));

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

  it("invokes onDelete when the delete item is picked", () => {
    const onDelete = vi.fn();
    render(<SessionActionsMenu targetBranch="main" onDelete={onDelete} />);

    fireEvent.click(screen.getByRole("button", { name: /actions/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /delete session/i }));

    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
