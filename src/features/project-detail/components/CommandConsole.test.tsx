// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { createRef } from "react";
import CommandConsole from "./CommandConsole";
import type { Suggestion } from "./command-suggestions";
import type { FilterToken } from "./filter-tokens";

function defaults() {
  return {
    tokens: [] as FilterToken[],
    draft: "",
    suggestions: [] as Suggestion[],
    focused: false,
    onDraftChange: vi.fn(),
    onApply: vi.fn(),
    onRemoveToken: vi.fn(),
    onFocus: vi.fn(),
    onBlur: vi.fn(),
    inputRef: createRef<HTMLInputElement>(),
  };
}

describe("CommandConsole", () => {
  it("renders the input with the filter placeholder when no tokens", () => {
    render(<CommandConsole {...defaults()} />);
    const input = screen.getByRole("combobox");
    expect(input.getAttribute("placeholder")).toMatch(/filter sessions/i);
  });

  it("does not advertise a removed global focus shortcut", () => {
    render(<CommandConsole {...defaults()} />);

    expect(screen.queryByText("⌘K")).not.toBeInTheDocument();
  });

  it("renders one chip per token with key/value text", () => {
    const tokens: FilterToken[] = [
      { cat: "status", key: "is", value: "running" },
      { cat: "target", key: "target", value: "main" },
    ];
    render(<CommandConsole {...defaults()} tokens={tokens} />);
    expect(screen.getByText("is:")).toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByText("target:")).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getAllByLabelText(/Remove filter/)).toHaveLength(2);
  });

  it("calls onRemoveToken when chip × button is clicked", () => {
    const props = defaults();
    const tokens: FilterToken[] = [
      { cat: "status", key: "is", value: "running" },
    ];
    render(<CommandConsole {...props} tokens={tokens} />);
    fireEvent.click(screen.getByLabelText(/remove filter status/i));
    expect(props.onRemoveToken).toHaveBeenCalledWith("status");
  });

  it("calls onDraftChange when typing", () => {
    const props = defaults();
    render(<CommandConsole {...props} />);
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "/new" },
    });
    expect(props.onDraftChange).toHaveBeenCalledWith("/new");
  });

  it("calls onFocus on focus", () => {
    const props = defaults();
    render(<CommandConsole {...props} />);
    fireEvent.focus(screen.getByRole("combobox"));
    expect(props.onFocus).toHaveBeenCalledTimes(1);
  });

  it("renders suggestions only when focused", () => {
    const suggestions: Suggestion[] = [
      {
        kind: "filter",
        cat: "status",
        key: "is",
        value: "running",
        label: "is:running · 2",
        grp: "Filter",
      },
    ];

    const { rerender } = render(
      <CommandConsole
        {...defaults()}
        suggestions={suggestions}
        focused={false}
      />,
    );
    expect(screen.queryByText("is:running · 2")).toBeNull();

    rerender(
      <CommandConsole
        {...defaults()}
        suggestions={suggestions}
        focused={true}
      />,
    );
    expect(screen.getByText("is:running · 2")).toBeInTheDocument();
  });

  it("groups suggestions by grp label", () => {
    const suggestions: Suggestion[] = [
      {
        kind: "action",
        id: "new",
        label: "/new — Create new session",
        grp: "Actions",
      },
      {
        kind: "filter",
        cat: "status",
        key: "is",
        value: "running",
        label: "is:running · 0",
        grp: "Filter",
      },
    ];
    render(
      <CommandConsole
        {...defaults()}
        suggestions={suggestions}
        focused={true}
      />,
    );
    expect(screen.getByText("Actions")).toBeInTheDocument();
    expect(screen.getByText("Filter")).toBeInTheDocument();
  });

  it("applies the active suggestion on Enter", () => {
    const props = defaults();
    const suggestions: Suggestion[] = [
      {
        kind: "filter",
        cat: "status",
        key: "is",
        value: "running",
        label: "is:running · 0",
        grp: "Filter",
      },
    ];
    render(
      <CommandConsole {...props} suggestions={suggestions} focused={true} />,
    );
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(props.onApply).toHaveBeenCalledWith(suggestions[0]);
  });

  it("applies the clicked suggestion", () => {
    const props = defaults();
    const suggestions: Suggestion[] = [
      {
        kind: "action",
        id: "capabilities",
        label: "/capabilities — Configure capabilities",
        grp: "Actions",
      },
    ];
    render(
      <CommandConsole {...props} suggestions={suggestions} focused={true} />,
    );
    fireEvent.click(screen.getByText("/capabilities — Configure capabilities"));
    expect(props.onApply).toHaveBeenCalledWith(suggestions[0]);
  });

  it("removes last token on Backspace with empty draft", () => {
    const props = defaults();
    const tokens: FilterToken[] = [
      { cat: "status", key: "is", value: "running" },
      { cat: "target", key: "target", value: "main" },
    ];
    render(
      <CommandConsole {...props} tokens={tokens} draft="" focused={true} />,
    );
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Backspace" });
    expect(props.onRemoveToken).toHaveBeenCalledWith("target");
  });

  it("does NOT remove a token on Backspace when draft is non-empty", () => {
    const props = defaults();
    const tokens: FilterToken[] = [
      { cat: "status", key: "is", value: "running" },
    ];
    render(
      <CommandConsole {...props} tokens={tokens} draft="hi" focused={true} />,
    );
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Backspace" });
    expect(props.onRemoveToken).not.toHaveBeenCalled();
  });

  it("blurs on Escape", () => {
    const props = defaults();
    render(<CommandConsole {...props} focused={true} />);
    const input = screen.getByRole("combobox") as HTMLInputElement;
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(props.onBlur).toHaveBeenCalled();
  });

  it("closes via onBlur on mousedown outside the console while focused", () => {
    const props = defaults();
    render(
      <div>
        <CommandConsole {...props} focused={true} />
        <div data-testid="outside">elsewhere</div>
      </div>,
    );
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(props.onBlur).toHaveBeenCalled();
  });

  it("does NOT call onBlur on mousedown inside the console", () => {
    const props = defaults();
    render(<CommandConsole {...props} focused={true} />);
    fireEvent.mouseDown(screen.getByRole("combobox"));
    expect(props.onBlur).not.toHaveBeenCalled();
  });

  it("closes on document-level Escape even when input is not the event target", () => {
    const props = defaults();
    render(<CommandConsole {...props} focused={true} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(props.onBlur).toHaveBeenCalled();
  });

  it("ignores document-level Escape when not focused", () => {
    const props = defaults();
    render(<CommandConsole {...props} focused={false} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(props.onBlur).not.toHaveBeenCalled();
  });

  describe("combobox / listbox ARIA", () => {
    const twoSuggestions: Suggestion[] = [
      {
        kind: "action",
        id: "new",
        label: "/new — Create new session",
        grp: "Actions",
      },
      {
        kind: "filter",
        cat: "status",
        key: "is",
        value: "running",
        label: "is:running · 0",
        grp: "Filter",
      },
    ];

    it("exposes the open suggestion list as a listbox of options", () => {
      render(
        <CommandConsole {...defaults()} suggestions={twoSuggestions} focused />,
      );
      expect(screen.getByRole("listbox")).toBeInTheDocument();
      expect(screen.getAllByRole("option")).toHaveLength(2);
    });

    it("keeps grouped headings as labelled groups, not options", () => {
      render(
        <CommandConsole {...defaults()} suggestions={twoSuggestions} focused />,
      );
      // Grouped headings survive and name their groups (APG: listbox children
      // are option/group only — the heading is the group's accessible name).
      expect(
        screen.getByRole("group", { name: "Actions" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("group", { name: "Filter" })).toBeInTheDocument();
    });

    it("marks the active option aria-selected and wires aria-activedescendant", () => {
      render(
        <CommandConsole {...defaults()} suggestions={twoSuggestions} focused />,
      );
      const options = screen.getAllByRole("option");
      expect(options[0]).toHaveAttribute("aria-selected", "true");
      expect(options[1]).toHaveAttribute("aria-selected", "false");

      const activeId = options[0]?.getAttribute("id");
      expect(activeId).toBeTruthy();
      expect(screen.getByRole("combobox")).toHaveAttribute(
        "aria-activedescendant",
        activeId,
      );
    });

    it("moves aria-selected and aria-activedescendant with ArrowDown", () => {
      render(
        <CommandConsole {...defaults()} suggestions={twoSuggestions} focused />,
      );
      fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
      const options = screen.getAllByRole("option");
      expect(options[1]).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("combobox")).toHaveAttribute(
        "aria-activedescendant",
        options[1]?.getAttribute("id") ?? "",
      );
    });

    it("clears aria-activedescendant when the list is closed", () => {
      render(
        <CommandConsole
          {...defaults()}
          suggestions={twoSuggestions}
          focused={false}
        />,
      );
      expect(screen.getByRole("combobox")).not.toHaveAttribute(
        "aria-activedescendant",
      );
    });

    it("still applies the active suggestion on Enter and on click", () => {
      const props = defaults();
      render(
        <CommandConsole {...props} suggestions={twoSuggestions} focused />,
      );
      fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
      expect(props.onApply).toHaveBeenCalledWith(twoSuggestions[0]);

      fireEvent.click(screen.getByText("/new — Create new session"));
      expect(props.onApply).toHaveBeenCalledWith(twoSuggestions[0]);
    });
  });
});
