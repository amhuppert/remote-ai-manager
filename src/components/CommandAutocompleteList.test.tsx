// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  CommandAutocompleteList,
  type CommandAutocompleteListItem,
} from "./CommandAutocompleteList";

const items: CommandAutocompleteListItem[] = [
  {
    id: "1",
    name: "/spec-init",
    description: "Initialize a spec",
    badge: "command",
    source: "user",
  },
  {
    id: "2",
    name: "/spec-design",
    description: "Design phase",
    badge: "command",
    source: "user",
    matchIndices: [1, 2, 3, 4],
  },
];

describe("CommandAutocompleteList", () => {
  it("renders header label and item count", () => {
    render(
      <CommandAutocompleteList
        items={items}
        selectedIndex={0}
        onHover={() => {}}
        onSelect={() => {}}
        headerLabel="Commands"
        emptyLabel="No matching commands"
      />,
    );
    expect(screen.getByText("Commands")).toBeInTheDocument();
    expect(screen.getByText("2 items")).toBeInTheDocument();
  });

  it("highlights the selected index", () => {
    const { container } = render(
      <CommandAutocompleteList
        items={items}
        selectedIndex={1}
        onHover={() => {}}
        onSelect={() => {}}
        headerLabel="Commands"
        emptyLabel="No matching commands"
      />,
    );
    const itemEls = container.querySelectorAll("[data-active]");
    expect(itemEls[0]?.getAttribute("data-active")).toBe("false");
    expect(itemEls[1]?.getAttribute("data-active")).toBe("true");
  });

  it("calls onSelect with the item when clicked", () => {
    const onSelect = vi.fn();
    render(
      <CommandAutocompleteList
        items={items}
        selectedIndex={0}
        onHover={() => {}}
        onSelect={onSelect}
        headerLabel="Commands"
        emptyLabel="No matching commands"
      />,
    );
    fireEvent.click(screen.getByText("/spec-init"));
    expect(onSelect).toHaveBeenCalledWith(items[0]);
  });

  it("calls onHover with item index on mouse enter", () => {
    const onHover = vi.fn();
    const { container } = render(
      <CommandAutocompleteList
        items={items}
        selectedIndex={0}
        onHover={onHover}
        onSelect={() => {}}
        headerLabel="Commands"
        emptyLabel="No matching commands"
      />,
    );
    const itemEls = container.querySelectorAll("[data-active]");
    fireEvent.mouseEnter(itemEls[1]!);
    expect(onHover).toHaveBeenCalledWith(1);
  });

  it("gives every option a stable unique id for aria-activedescendant wiring", () => {
    const { container } = render(
      <CommandAutocompleteList
        items={items}
        selectedIndex={0}
        onHover={() => {}}
        onSelect={() => {}}
        headerLabel="Commands"
        emptyLabel="No matching commands"
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

  it("renders the empty label when items is empty", () => {
    render(
      <CommandAutocompleteList
        items={[]}
        selectedIndex={0}
        onHover={() => {}}
        onSelect={() => {}}
        headerLabel="Commands"
        emptyLabel="No matching commands"
      />,
    );
    expect(screen.getByText("No matching commands")).toBeInTheDocument();
  });

  it("renders error text when error is set", () => {
    render(
      <CommandAutocompleteList
        items={[]}
        selectedIndex={0}
        onHover={() => {}}
        onSelect={() => {}}
        headerLabel="Commands"
        emptyLabel="No matching commands"
        error="boom"
      />,
    );
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("renders loading state with header label lowercased", () => {
    render(
      <CommandAutocompleteList
        items={[]}
        selectedIndex={0}
        onHover={() => {}}
        onSelect={() => {}}
        headerLabel="Commands"
        emptyLabel="No matching commands"
        loading
      />,
    );
    expect(screen.getByText(/Loading commands/)).toBeInTheDocument();
  });
});
