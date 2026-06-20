// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  FileAutocompleteList,
  type FileAutocompleteListItem,
} from "./FileAutocompleteList";

const items: FileAutocompleteListItem[] = [
  { id: "1", path: "src/components/App.tsx" },
  { id: "2", path: "src/lib/utils.ts", matchIndices: [4, 5, 6] },
];

describe("FileAutocompleteList", () => {
  it("renders the file count footer when no totalCount is provided", () => {
    render(
      <FileAutocompleteList
        items={items}
        selectedIndex={0}
        onHover={() => {}}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("2 files")).toBeInTheDocument();
  });

  it('renders "N of M" footer when totalCount exceeds items', () => {
    render(
      <FileAutocompleteList
        items={items}
        selectedIndex={0}
        onHover={() => {}}
        onSelect={() => {}}
        totalCount={50}
      />,
    );
    expect(screen.getByText("2 of 50")).toBeInTheDocument();
  });

  it("marks the selected item active via data-active", () => {
    const { container } = render(
      <FileAutocompleteList
        items={items}
        selectedIndex={1}
        onHover={() => {}}
        onSelect={() => {}}
      />,
    );
    const itemEls = container.querySelectorAll("[data-active]");
    expect(itemEls[0]?.getAttribute("data-active")).toBe("false");
    expect(itemEls[1]?.getAttribute("data-active")).toBe("true");
  });

  it("calls onSelect with the item when clicked", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <FileAutocompleteList
        items={items}
        selectedIndex={0}
        onHover={() => {}}
        onSelect={onSelect}
      />,
    );
    const itemEls = container.querySelectorAll("[data-active]");
    fireEvent.click(itemEls[1]!);
    expect(onSelect).toHaveBeenCalledWith(items[1]);
  });

  it("renders empty label when items is empty", () => {
    render(
      <FileAutocompleteList
        items={[]}
        selectedIndex={0}
        onHover={() => {}}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("No matching files")).toBeInTheDocument();
  });

  it("renders error text when error is set", () => {
    render(
      <FileAutocompleteList
        items={[]}
        selectedIndex={0}
        onHover={() => {}}
        onSelect={() => {}}
        error="scan failed"
      />,
    );
    expect(screen.getByText("scan failed")).toBeInTheDocument();
  });

  it("calls onHover with index on mouse enter", () => {
    const onHover = vi.fn();
    const { container } = render(
      <FileAutocompleteList
        items={items}
        selectedIndex={0}
        onHover={onHover}
        onSelect={() => {}}
      />,
    );
    const itemEls = container.querySelectorAll("[data-active]");
    fireEvent.mouseEnter(itemEls[1]!);
    expect(onHover).toHaveBeenCalledWith(1);
  });
});
