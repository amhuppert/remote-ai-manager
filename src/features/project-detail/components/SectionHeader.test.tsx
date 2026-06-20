// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import SectionHeader from "./SectionHeader";

describe("SectionHeader (idle)", () => {
  it("renders the sessions label and filtered count", () => {
    render(
      <SectionHeader
        filteredCount={7}
        tokenCount={0}
        selectionSize={0}
        bulkActionKind="archive"
        isBulkPending={false}
        onClearFilters={vi.fn()}
        onDeselect={vi.fn()}
        onBulkArchive={vi.fn()}
        onBulkUnarchive={vi.fn()}
        onBulkDelete={vi.fn()}
      />,
    );
    expect(screen.getByText(/sessions/i)).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
  });

  it("does not render Clear button when no filters are applied", () => {
    render(
      <SectionHeader
        filteredCount={3}
        tokenCount={0}
        selectionSize={0}
        bulkActionKind="archive"
        isBulkPending={false}
        onClearFilters={vi.fn()}
        onDeselect={vi.fn()}
        onBulkArchive={vi.fn()}
        onBulkUnarchive={vi.fn()}
        onBulkDelete={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /clear/i })).toBeNull();
  });

  it("renders Clear button + filter count when tokens are applied", () => {
    const onClear = vi.fn();
    render(
      <SectionHeader
        filteredCount={2}
        tokenCount={2}
        selectionSize={0}
        bulkActionKind="archive"
        isBulkPending={false}
        onClearFilters={onClear}
        onDeselect={vi.fn()}
        onBulkArchive={vi.fn()}
        onBulkUnarchive={vi.fn()}
        onBulkDelete={vi.fn()}
      />,
    );
    expect(screen.getByText(/2 filters? applied/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /clear/i }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

describe("SectionHeader (bulk-mode)", () => {
  function renderBulk(
    overrides: Partial<{
      selectionSize: number;
      bulkActionKind: "archive" | "unarchive";
      onDeselect: () => void;
      onBulkArchive: () => void;
      onBulkUnarchive: () => void;
      onBulkDelete: () => void;
      isBulkPending: boolean;
    }> = {},
  ) {
    const onDeselect = overrides.onDeselect ?? vi.fn();
    const onBulkArchive = overrides.onBulkArchive ?? vi.fn();
    const onBulkUnarchive = overrides.onBulkUnarchive ?? vi.fn();
    const onBulkDelete = overrides.onBulkDelete ?? vi.fn();
    return {
      handlers: { onDeselect, onBulkArchive, onBulkUnarchive, onBulkDelete },
      ...render(
        <SectionHeader
          filteredCount={5}
          tokenCount={0}
          selectionSize={overrides.selectionSize ?? 3}
          bulkActionKind={overrides.bulkActionKind ?? "archive"}
          isBulkPending={overrides.isBulkPending ?? false}
          onClearFilters={vi.fn()}
          onDeselect={onDeselect}
          onBulkArchive={onBulkArchive}
          onBulkUnarchive={onBulkUnarchive}
          onBulkDelete={onBulkDelete}
        />,
      ),
    };
  }

  it("morphs to bulk-mode and shows the selection count chip", () => {
    renderBulk({ selectionSize: 4 });
    expect(
      screen.getByRole("region", { name: "Bulk actions" }),
    ).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText(/sessions selected/i)).toBeInTheDocument();
  });

  it('shows "Archive N" when bulkActionKind is archive', () => {
    renderBulk({ selectionSize: 4, bulkActionKind: "archive" });
    expect(
      screen.getByRole("button", { name: "Archive 4" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Unarchive/ })).toBeNull();
  });

  it('shows "Unarchive N" when bulkActionKind is unarchive', () => {
    renderBulk({ selectionSize: 4, bulkActionKind: "unarchive" });
    expect(
      screen.getByRole("button", { name: "Unarchive 4" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Archive/ })).toBeNull();
  });

  it("calls onDeselect when Deselect all is clicked", () => {
    const { handlers } = renderBulk();
    fireEvent.click(screen.getByRole("button", { name: /deselect all/i }));
    expect(handlers.onDeselect).toHaveBeenCalledTimes(1);
  });

  it("calls onBulkArchive when Archive N is clicked", () => {
    const { handlers } = renderBulk({ selectionSize: 2 });
    fireEvent.click(screen.getByRole("button", { name: "Archive 2" }));
    expect(handlers.onBulkArchive).toHaveBeenCalledTimes(1);
  });

  it("calls onBulkUnarchive when Unarchive N is clicked", () => {
    const { handlers } = renderBulk({
      selectionSize: 2,
      bulkActionKind: "unarchive",
    });
    fireEvent.click(screen.getByRole("button", { name: "Unarchive 2" }));
    expect(handlers.onBulkUnarchive).toHaveBeenCalledTimes(1);
  });

  it("calls onBulkDelete when Delete N is clicked", () => {
    const { handlers } = renderBulk({ selectionSize: 6 });
    fireEvent.click(screen.getByRole("button", { name: "Delete 6" }));
    expect(handlers.onBulkDelete).toHaveBeenCalledTimes(1);
  });

  it("disables bulk action buttons while a bulk mutation is pending", () => {
    renderBulk({ selectionSize: 3, isBulkPending: true });
    expect(screen.getByRole("button", { name: "Archive 3" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete 3" })).toBeDisabled();
  });
});
