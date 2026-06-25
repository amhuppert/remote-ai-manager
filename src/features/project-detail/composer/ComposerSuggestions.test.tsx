// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ComposerSuggestions from "./ComposerSuggestions";
import type { Suggestion } from "../components/command-suggestions";

const suggestions: Suggestion[] = [
  { kind: "action", id: "new", label: "Create session", grp: "Actions" },
  {
    kind: "filter",
    cat: "status",
    key: "is",
    value: "running",
    label: "3 sessions",
    grp: "Filter",
  },
];

describe("ComposerSuggestions", () => {
  it("renders a listbox with one option per suggestion", () => {
    render(
      <ComposerSuggestions
        suggestions={suggestions}
        activeIndex={0}
        onApply={vi.fn()}
      />,
    );
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("marks the active option aria-selected", () => {
    render(
      <ComposerSuggestions
        suggestions={suggestions}
        activeIndex={1}
        onApply={vi.fn()}
      />,
    );
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "false");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
  });

  it("gives every option a stable id for aria-activedescendant wiring", () => {
    render(
      <ComposerSuggestions
        suggestions={suggestions}
        activeIndex={0}
        onApply={vi.fn()}
      />,
    );
    const ids = screen.getAllByRole("option").map((o) => o.getAttribute("id"));
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(
      true,
    );
    // Ids are unique per option.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("applies the suggestion on click", () => {
    const onApply = vi.fn();
    render(
      <ComposerSuggestions
        suggestions={suggestions}
        activeIndex={0}
        onApply={onApply}
      />,
    );
    fireEvent.mouseDown(screen.getByText("Create session"));
    expect(onApply).toHaveBeenCalledWith(suggestions[0]);
  });

  it("renders nothing when there are no suggestions", () => {
    const { container } = render(
      <ComposerSuggestions
        suggestions={[]}
        activeIndex={0}
        onApply={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
