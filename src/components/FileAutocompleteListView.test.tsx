// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  FileAutocompleteListView,
  type FileAutocompleteRow,
} from "./FileAutocompleteListView";

const items: FileAutocompleteRow[] = [
  { id: "1", path: "src/components/App.tsx" },
  { id: "2", path: "src/lib/utils.ts", matchIndices: [4, 5, 6] },
];

const openItems: FileAutocompleteRow[] = [
  ...items,
  { id: "3", path: "docs/plan.md", openable: true },
];

describe("FileAutocompleteListView — shared chrome", () => {
  it('renders the "N files" count when no totalCount', () => {
    render(
      <FileAutocompleteListView
        items={items}
        selectedIndex={0}
        onHover={() => {}}
        onSelect={() => {}}
        optionIdPrefix="p"
      />,
    );
    expect(screen.getByText("2 files")).toBeInTheDocument();
  });

  it('renders "N of M" when totalCount exceeds items', () => {
    render(
      <FileAutocompleteListView
        items={items}
        selectedIndex={0}
        onHover={() => {}}
        onSelect={() => {}}
        optionIdPrefix="p"
        totalCount={50}
      />,
    );
    expect(screen.getByText("2 of 50")).toBeInTheDocument();
  });

  it("renders the singular file count", () => {
    render(
      <FileAutocompleteListView
        items={[items[0]!]}
        selectedIndex={0}
        onHover={() => {}}
        onSelect={() => {}}
        optionIdPrefix="p"
      />,
    );
    expect(screen.getByText("1 file")).toBeInTheDocument();
  });

  it("flags a truncated scan in the header count", () => {
    render(
      <FileAutocompleteListView
        items={items}
        selectedIndex={0}
        onHover={() => {}}
        onSelect={() => {}}
        optionIdPrefix="p"
        totalCount={50}
        truncated
      />,
    );
    expect(screen.getByText(/\(truncated\)/)).toBeInTheDocument();
  });

  it("uses the source label in the popup name and header", () => {
    render(
      <FileAutocompleteListView
        items={items}
        selectedIndex={0}
        onHover={() => {}}
        onSelect={() => {}}
        optionIdPrefix="p"
        sourceLabel="project root"
      />,
    );
    expect(
      screen.getByRole("listbox", { name: "Files — project root" }),
    ).toBeInTheDocument();
  });

  it("renders loading, error, and empty states", () => {
    const { rerender } = render(
      <FileAutocompleteListView
        items={[]}
        selectedIndex={0}
        onHover={() => {}}
        onSelect={() => {}}
        optionIdPrefix="p"
        loading
      />,
    );
    expect(screen.getByText("Scanning files...")).toBeInTheDocument();

    rerender(
      <FileAutocompleteListView
        items={[]}
        selectedIndex={0}
        onHover={() => {}}
        onSelect={() => {}}
        optionIdPrefix="p"
        error="scan failed"
      />,
    );
    expect(screen.getByText("scan failed")).toBeInTheDocument();

    rerender(
      <FileAutocompleteListView
        items={[]}
        selectedIndex={0}
        onHover={() => {}}
        onSelect={() => {}}
        optionIdPrefix="p"
      />,
    );
    expect(screen.getByText("No matching files")).toBeInTheDocument();
  });
});

describe("FileAutocompleteListView — listbox semantics", () => {
  it("uses role=listbox / role=option and marks the active option", () => {
    render(
      <FileAutocompleteListView
        items={items}
        selectedIndex={1}
        onHover={() => {}}
        onSelect={() => {}}
        popupRole="listbox"
        optionIdPrefix="opt"
      />,
    );
    expect(screen.getByRole("listbox", { name: "Files" })).toBeInTheDocument();
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]!.getAttribute("data-active")).toBe("false");
    expect(options[1]!.getAttribute("data-active")).toBe("true");
    expect(options.map((o) => o.id)).toEqual(["opt-0", "opt-1"]);
  });

  it("calls onSelect with the item and index on click", () => {
    const onSelect = vi.fn();
    render(
      <FileAutocompleteListView
        items={items}
        selectedIndex={0}
        onHover={() => {}}
        onSelect={onSelect}
        popupRole="listbox"
        optionIdPrefix="opt"
      />,
    );
    fireEvent.click(screen.getAllByRole("option")[1]!);
    expect(onSelect).toHaveBeenCalledWith(items[1], 1);
  });

  it("does not render any Open action when onOpen is omitted", () => {
    render(
      <FileAutocompleteListView
        items={openItems}
        selectedIndex={0}
        onHover={() => {}}
        onSelect={() => {}}
        popupRole="listbox"
        optionIdPrefix="opt"
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("open")).toBeNull();
  });
});

describe("FileAutocompleteListView — grid semantics", () => {
  it("uses role=grid / role=row and renders the Open action for openable items", () => {
    const onOpen = vi.fn();
    render(
      <FileAutocompleteListView
        items={openItems}
        selectedIndex={0}
        onHover={() => {}}
        onSelect={() => {}}
        onOpen={onOpen}
        popupRole="grid"
        optionIdPrefix="row"
      />,
    );
    expect(screen.getByRole("grid", { name: "Files" })).toBeInTheDocument();
    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(openItems.length);
    expect(rows.map((r) => r.id)).toEqual(["row-0", "row-1", "row-2"]);
    expect(
      screen.getByRole("button", {
        name: "Open docs/plan.md in Markdown viewer",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "Open src/components/App.tsx in Markdown viewer",
      }),
    ).toBeNull();
  });

  it("opens without selecting the row", () => {
    const onOpen = vi.fn();
    const onSelect = vi.fn();
    render(
      <FileAutocompleteListView
        items={openItems}
        selectedIndex={2}
        onHover={() => {}}
        onSelect={onSelect}
        onOpen={onOpen}
        popupRole="grid"
        optionIdPrefix="row"
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open docs/plan.md in Markdown viewer",
      }),
    );
    expect(onOpen).toHaveBeenCalledWith(openItems[2], 2);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("shows the Alt+Enter open footer hint only when an openable item exists and onOpen is set", () => {
    const { rerender } = render(
      <FileAutocompleteListView
        items={items}
        selectedIndex={0}
        onHover={() => {}}
        onSelect={() => {}}
        onOpen={() => {}}
        popupRole="grid"
        optionIdPrefix="row"
      />,
    );
    expect(screen.queryByText("open")).toBeNull();

    rerender(
      <FileAutocompleteListView
        items={openItems}
        selectedIndex={0}
        onHover={() => {}}
        onSelect={() => {}}
        onOpen={() => {}}
        popupRole="grid"
        optionIdPrefix="row"
      />,
    );
    expect(screen.getByText("open")).toBeInTheDocument();
    expect(screen.getByText("Alt+Enter")).toBeInTheDocument();
  });

  it("calls onHover with the row index on mouse enter", () => {
    const onHover = vi.fn();
    render(
      <FileAutocompleteListView
        items={items}
        selectedIndex={0}
        onHover={onHover}
        onSelect={() => {}}
        popupRole="grid"
        optionIdPrefix="row"
      />,
    );
    fireEvent.mouseEnter(screen.getAllByRole("row")[1]!);
    expect(onHover).toHaveBeenCalledWith(1);
  });
});
