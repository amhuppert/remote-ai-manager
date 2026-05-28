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

  it("renders one chip per token with key/value text", () => {
    const tokens: FilterToken[] = [
      { cat: "status", key: "is", value: "running" },
      { cat: "target", key: "target", value: "main" },
    ];
    const { container } = render(
      <CommandConsole {...defaults()} tokens={tokens} />,
    );
    const chips = container.querySelectorAll(".console-token");
    expect(chips).toHaveLength(2);
    expect(chips[0]?.textContent).toContain("is:");
    expect(chips[0]?.textContent).toContain("running");
    expect(chips[1]?.textContent).toContain("target:");
    expect(chips[1]?.textContent).toContain("main");
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

    const { rerender, container } = render(
      <CommandConsole
        {...defaults()}
        suggestions={suggestions}
        focused={false}
      />,
    );
    expect(container.querySelector(".console-suggest")).toBeNull();

    rerender(
      <CommandConsole
        {...defaults()}
        suggestions={suggestions}
        focused={true}
      />,
    );
    expect(container.querySelector(".console-suggest")).not.toBeNull();
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
    const { container } = render(
      <CommandConsole
        {...defaults()}
        suggestions={suggestions}
        focused={true}
      />,
    );
    const labels = Array.from(container.querySelectorAll(".grp-label")).map(
      (el) => el.textContent,
    );
    expect(labels).toEqual(["Actions", "Filter"]);
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
    const { container } = render(<CommandConsole {...props} focused={true} />);
    const bar = container.querySelector(".console-bar");
    expect(bar).not.toBeNull();
    if (bar) fireEvent.mouseDown(bar);
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
});
