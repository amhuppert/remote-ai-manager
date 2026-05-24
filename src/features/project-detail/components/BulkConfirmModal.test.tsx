// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import BulkConfirmModal from "./BulkConfirmModal";

describe("BulkConfirmModal", () => {
  it("returns null when not open", () => {
    const { container } = render(
      <BulkConfirmModal
        open={false}
        kind="archive"
        count={3}
        isPending={false}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders archive copy with cyan primary button", () => {
    render(
      <BulkConfirmModal
        open
        kind="archive"
        count={4}
        isPending={false}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Archive sessions?" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Archive 4 sessions. They stay accessible via "Include archived".',
      ),
    ).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "Archive 4" });
    expect(confirm).toHaveClass("btn-primary");
  });

  it("uses singular noun when count is 1", () => {
    render(
      <BulkConfirmModal
        open
        kind="archive"
        count={1}
        isPending={false}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.getByText(
        'Archive 1 session. They stay accessible via "Include archived".',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Archive 1" }),
    ).toBeInTheDocument();
  });

  it("renders unarchive copy", () => {
    render(
      <BulkConfirmModal
        open
        kind="unarchive"
        count={2}
        isPending={false}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Unarchive sessions?" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Unarchive 2 sessions.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unarchive 2" })).toHaveClass(
      "btn-primary",
    );
  });

  it("renders delete copy with danger button", () => {
    render(
      <BulkConfirmModal
        open
        kind="delete"
        count={5}
        isPending={false}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Delete sessions?" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "This permanently removes 5 sessions — worktree, history, and branch will be deleted.",
      ),
    ).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "Delete 5" });
    expect(confirm).toHaveClass("btn-danger");
  });

  it("calls onConfirm when primary button is clicked", () => {
    const onConfirm = vi.fn();
    render(
      <BulkConfirmModal
        open
        kind="delete"
        count={3}
        isPending={false}
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete 3" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when cancel button is clicked", () => {
    const onClose = vi.fn();
    render(
      <BulkConfirmModal
        open
        kind="archive"
        count={2}
        isPending={false}
        onConfirm={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when Escape is pressed", () => {
    const onClose = vi.fn();
    render(
      <BulkConfirmModal
        open
        kind="archive"
        count={1}
        isPending={false}
        onConfirm={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("disables buttons while pending", () => {
    render(
      <BulkConfirmModal
        open
        kind="delete"
        count={2}
        isPending
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Delete 2" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("does not call onConfirm when Escape is pressed", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <BulkConfirmModal
        open
        kind="delete"
        count={1}
        isPending={false}
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
