// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FileAutocomplete, type ScoredFileItem } from "./FileAutocomplete";

const items: ScoredFileItem[] = [
  {
    item: { path: "src/components/App.tsx" },
    tier: "prefix",
    coverage: 1,
    indices: [],
  },
  {
    item: { path: "src/lib/utils.ts" },
    tier: "prefix",
    coverage: 1,
    indices: [4, 5, 6],
  },
];

describe("FileAutocomplete", () => {
  it("renders nothing when not visible", () => {
    const { container } = render(
      <FileAutocomplete
        items={items}
        visible={false}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("marks the active row via data-active and selects on click", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <FileAutocomplete
        items={items}
        visible
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );
    const rows = container.querySelectorAll("[data-active]");
    expect(rows[0]?.getAttribute("data-active")).toBe("true");
    fireEvent.click(rows[1]!);
    expect(onSelect).toHaveBeenCalledWith("src/lib/utils.ts");
  });

  it("gives every option a stable unique id for aria-activedescendant wiring", () => {
    const { container } = render(
      <FileAutocomplete
        items={items}
        visible
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const ids = Array.from(container.querySelectorAll('[role="option"]')).map(
      (o) => o.getAttribute("id"),
    );
    expect(ids).toHaveLength(items.length);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(
      true,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("renders the empty state when there are no items", () => {
    render(
      <FileAutocomplete
        items={[]}
        visible
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("No matching files")).toBeInTheDocument();
  });
});
