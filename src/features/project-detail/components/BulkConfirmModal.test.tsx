// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import BulkConfirmModal from "./BulkConfirmModal";

describe("BulkConfirmModal", () => {
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
    expect(
      screen.getByRole("button", { name: "Archive 4" }),
    ).toBeInTheDocument();
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
    expect(
      screen.getByRole("button", { name: "Unarchive 2" }),
    ).toBeInTheDocument();
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
        "This permanently removes the worktree, history, and state for 5 sessions. The git branch is preserved. This cannot be undone.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Delete 5" }),
    ).toBeInTheDocument();
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
});
