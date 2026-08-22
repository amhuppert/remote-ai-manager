// @vitest-environment jsdom
/**
 * The controls a config row hosts that no shared primitive already covers:
 * the text/textarea inputs, the chips editor, the command checklist, the
 * reorderable item list, and the danger button.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  ConfigChecklist,
  ConfigChipsEditor,
  ConfigDangerButton,
  ConfigItemList,
  ConfigTextArea,
  ConfigTextInput,
} from "./ConfigControls";
import { chipPart } from "./value-parts";

afterEach(cleanup);

describe("ConfigTextInput", () => {
  it("reports every keystroke and honours disabled", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ConfigTextInput
        value="delivery"
        onChange={onChange}
        ariaLabel="Lane"
        placeholder="lane-name"
      />,
    );

    const input = screen.getByRole("textbox", { name: "Lane" });
    expect(input).toHaveValue("delivery");
    fireEvent.change(input, { target: { value: "review" } });
    expect(onChange).toHaveBeenCalledWith("review");

    rerender(
      <ConfigTextInput
        value="delivery"
        onChange={onChange}
        ariaLabel="Lane"
        disabled
      />,
    );
    expect(screen.getByRole("textbox", { name: "Lane" })).toBeDisabled();
  });
});

describe("ConfigTextArea", () => {
  it("reports edits and carries its own accessible name", () => {
    const onChange = vi.fn();
    render(
      <ConfigTextArea
        value="Wire the risk rules in."
        onChange={onChange}
        ariaLabel="Description"
        rows={4}
      />,
    );

    const area = screen.getByRole("textbox", { name: "Description" });
    fireEvent.change(area, { target: { value: "Wire them in." } });
    expect(onChange).toHaveBeenCalledWith("Wire them in.");
  });
});

describe("ConfigChipsEditor", () => {
  it("removes a chip by its own labelled button and adds through the add control", () => {
    const onRemove = vi.fn();
    const onAdd = vi.fn();
    render(
      <ConfigChipsEditor
        chips={[
          { id: "src/checkout", label: "src/checkout", onRemove },
          { id: "src/audit", label: "src/audit", onRemove: vi.fn() },
        ]}
        addLabel="Add path"
        onAdd={onAdd}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Remove src/checkout" }),
    );
    expect(onRemove).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Add path" }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("hides both affordances while disabled", () => {
    render(
      <ConfigChipsEditor
        chips={[{ id: "a", label: "a", onRemove: vi.fn() }]}
        addLabel="Add path"
        onAdd={vi.fn()}
        disabled
      />,
    );

    expect(screen.getByRole("button", { name: "Remove a" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add path" })).toBeDisabled();
  });
});

describe("ConfigChecklist", () => {
  it("toggles a command and shows its cost description", () => {
    const onToggle = vi.fn();
    render(
      <ConfigChecklist
        options={[
          {
            id: "typecheck",
            label: "typecheck",
            description: "cost 2 — full-project tsc",
            checked: false,
            onToggle,
          },
        ]}
      />,
    );

    expect(screen.getByText("cost 2 — full-project tsc")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /typecheck/i }));
    expect(onToggle).toHaveBeenCalledWith(true);
  });
});

describe("ConfigItemList", () => {
  it("moves, removes and adds items through labelled controls", () => {
    const onMoveUp = vi.fn();
    const onMoveDown = vi.fn();
    const onRemove = vi.fn();
    const onAdd = vi.fn();
    render(
      <ConfigItemList
        items={[
          {
            id: "ac-1",
            title: "ac-1",
            chips: [chipPart("blocking", "amber")],
            onMoveDown,
            onRemove,
            children: <p>criterion body</p>,
          },
          { id: "ac-2", title: "ac-2", onMoveUp, onRemove: vi.fn() },
        ]}
        addLabel="Add criterion"
        onAdd={onAdd}
      />,
    );

    expect(screen.getByText("criterion body")).toBeInTheDocument();
    expect(screen.getByText("blocking")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Move ac-1 down" }));
    expect(onMoveDown).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Move ac-2 up" }));
    expect(onMoveUp).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Remove ac-1" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Add criterion" }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("omits the move and remove controls an item does not offer", () => {
    render(
      <ConfigItemList
        items={[{ id: "plan", title: "plan", meta: "from ctx-plan" }]}
      />,
    );

    expect(screen.getByText("from ctx-plan")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /move plan/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove plan" })).toBeNull();
  });

  it("drills into a child screen when the item names one", () => {
    const onOpen = vi.fn();
    render(
      <ConfigItemList
        items={[
          {
            id: "security",
            title: "security",
            screenId: "seat:security",
            onOpen,
          },
        ]}
      />,
    );

    const trigger = screen.getByRole("button", { name: /security/i });
    expect(trigger).toHaveAttribute("id", "cfgnav-seat:security");
    fireEvent.click(trigger);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe("ConfigDangerButton", () => {
  it("is a real button that reports its click", () => {
    const onClick = vi.fn();
    render(<ConfigDangerButton label="Delete context" onClick={onClick} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete context" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
