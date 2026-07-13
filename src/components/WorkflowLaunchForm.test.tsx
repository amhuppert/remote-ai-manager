// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ParameterDeclaration } from "@/lib/workflows/schemas";
import WorkflowLaunchForm from "@/components/WorkflowLaunchForm";

// Radix Select focuses items / captures the pointer on open; jsdom implements
// neither, so the enum picker needs these polyfills to open under test.
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

function launchButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /launch/i });
}

describe("WorkflowLaunchForm", () => {
  it("renders one input affordance per declared parameter keyed by type (R7.1, R7.2)", () => {
    const parameters: ParameterDeclaration[] = [
      {
        type: "string",
        name: "feature",
        label: "Feature name",
        required: true,
      },
      { type: "text", name: "brief", label: "Brief", required: true },
      {
        type: "enum",
        name: "mode",
        label: "Mode",
        required: true,
        options: ["fast", "focus"],
      },
    ];
    render(<WorkflowLaunchForm parameters={parameters} onLaunch={vi.fn()} />);

    // string -> single-line text input
    const stringInput = screen.getByLabelText("Feature name");
    expect(stringInput.tagName).toBe("INPUT");
    expect(stringInput.getAttribute("type")).toBe("text");

    // text -> multiline textarea
    const textInput = screen.getByLabelText("Brief");
    expect(textInput.tagName).toBe("TEXTAREA");

    // enum -> Radix Select (combobox trigger)
    const enumInput = screen.getByLabelText("Mode");
    expect(enumInput.getAttribute("role")).toBe("combobox");
  });

  it("constrains an enum input to exactly the declared options (R7.2)", async () => {
    const user = userEvent.setup();
    const parameters: ParameterDeclaration[] = [
      {
        type: "enum",
        name: "mode",
        label: "Mode",
        required: true,
        options: ["fast", "focus", "thorough"],
      },
    ];
    render(<WorkflowLaunchForm parameters={parameters} onLaunch={vi.fn()} />);

    await user.click(screen.getByLabelText("Mode"));
    const optionValues = screen
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(optionValues).toEqual(["fast", "focus", "thorough"]);
  });

  it("pre-populates each input with its declared default (R7.3)", () => {
    const parameters: ParameterDeclaration[] = [
      {
        type: "string",
        name: "feature",
        label: "Feature name",
        required: false,
        default: "checkout",
      },
      {
        type: "text",
        name: "brief",
        label: "Brief",
        required: false,
        default: "ship it",
      },
      {
        type: "enum",
        name: "mode",
        label: "Mode",
        required: false,
        options: ["fast", "focus"],
        default: "focus",
      },
    ];
    render(<WorkflowLaunchForm parameters={parameters} onLaunch={vi.fn()} />);

    expect(
      (screen.getByLabelText("Feature name") as HTMLInputElement).value,
    ).toBe("checkout");
    expect((screen.getByLabelText("Brief") as HTMLTextAreaElement).value).toBe(
      "ship it",
    );
    // The Radix Select trigger shows the selected option's label.
    expect(screen.getByLabelText("Mode").textContent).toContain("focus");
  });

  it("keeps plain Enter multiline and launches only on Ctrl+Enter", () => {
    const onLaunch = vi.fn();
    render(
      <WorkflowLaunchForm
        parameters={[
          { type: "text", name: "brief", label: "Brief", required: true },
        ]}
        onLaunch={onLaunch}
      />,
    );
    const input = screen.getByLabelText("Brief");
    fireEvent.change(input, { target: { value: "line one" } });

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onLaunch).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    expect(onLaunch).toHaveBeenCalledWith({ brief: "line one" });
  });

  it("blocks launch and surfaces a missing-required error when a required value is empty (R7.4)", async () => {
    const user = userEvent.setup();
    const onLaunch = vi.fn();
    const parameters: ParameterDeclaration[] = [
      {
        type: "string",
        name: "feature",
        label: "Feature name",
        required: true,
      },
    ];
    render(<WorkflowLaunchForm parameters={parameters} onLaunch={onLaunch} />);

    // Attempt to launch with the required field empty.
    await user.click(launchButton());

    expect(onLaunch).not.toHaveBeenCalled();
    const input = screen.getByLabelText("Feature name");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText(/required/i)).toBeInTheDocument();

    // Filling it resolves the error and allows launch.
    await user.type(input, "checkout");
    await user.click(launchButton());
    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect(onLaunch).toHaveBeenCalledWith({ feature: "checkout" });
  });

  it("blocks launch and surfaces a length validation error (R7.5)", async () => {
    const user = userEvent.setup();
    const onLaunch = vi.fn();
    const parameters: ParameterDeclaration[] = [
      {
        type: "string",
        name: "feature",
        label: "Feature name",
        required: true,
        minLength: 5,
      },
    ];
    render(<WorkflowLaunchForm parameters={parameters} onLaunch={onLaunch} />);

    const input = screen.getByLabelText("Feature name");
    await user.type(input, "abc");
    await user.click(launchButton());

    expect(onLaunch).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-invalid")).toBe("true");

    await user.type(input, "defgh");
    await user.click(launchButton());
    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect(onLaunch).toHaveBeenCalledWith({ feature: "abcdefgh" });
  });

  it("calls onLaunch with the supplied values on a valid submit, including applied enum/default values (R7.7)", async () => {
    const user = userEvent.setup();
    const onLaunch = vi.fn();
    const parameters: ParameterDeclaration[] = [
      {
        type: "string",
        name: "feature",
        label: "Feature name",
        required: true,
      },
      {
        type: "enum",
        name: "mode",
        label: "Mode",
        required: true,
        options: ["fast", "focus"],
        default: "fast",
      },
    ];
    render(<WorkflowLaunchForm parameters={parameters} onLaunch={onLaunch} />);

    await user.type(screen.getByLabelText("Feature name"), "checkout");
    // The enum carries its declared default ("fast") into the payload without
    // interaction; changing the selection is covered by live Storybook verification
    // (Radix Select pointer-driven selection is unreliable under jsdom).
    await user.click(launchButton());

    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect(onLaunch).toHaveBeenCalledWith({
      feature: "checkout",
      mode: "fast",
    });
  });

  it("renders no parameter inputs and launches immediately for a zero-input definition (R7.6)", async () => {
    const user = userEvent.setup();
    const onLaunch = vi.fn();
    render(<WorkflowLaunchForm parameters={[]} onLaunch={onLaunch} />);

    // No textbox/combobox affordances.
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);

    expect(launchButton()).not.toBeDisabled();
    await user.click(launchButton());
    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect(onLaunch).toHaveBeenCalledWith({});
  });

  it("surfaces an engine start-time rejection reason after submit (R7.7)", () => {
    render(
      <WorkflowLaunchForm
        parameters={[]}
        onLaunch={vi.fn()}
        engineError="Worktree has uncommitted changes"
      />,
    );
    expect(
      screen.getByText("Worktree has uncommitted changes"),
    ).toBeInTheDocument();
  });

  it("disables the launch control while launching (R7.7)", () => {
    const onLaunch = vi.fn();
    render(
      <WorkflowLaunchForm
        parameters={[
          {
            type: "text",
            name: "brief",
            label: "Brief",
            required: false,
          },
        ]}
        onLaunch={onLaunch}
        isLaunching
      />,
    );
    expect(launchButton()).toBeDisabled();
    fireEvent.keyDown(screen.getByLabelText("Brief"), {
      key: "Enter",
      ctrlKey: true,
    });
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it("does not submit a value for an unfilled optional parameter that has no default", async () => {
    const user = userEvent.setup();
    const onLaunch = vi.fn();
    const parameters: ParameterDeclaration[] = [
      {
        type: "string",
        name: "feature",
        label: "Feature name",
        required: true,
      },
      { type: "string", name: "note", label: "Note", required: false },
    ];
    render(<WorkflowLaunchForm parameters={parameters} onLaunch={onLaunch} />);

    await user.type(screen.getByLabelText("Feature name"), "checkout");
    await user.click(launchButton());

    expect(onLaunch).toHaveBeenCalledWith({ feature: "checkout" });
  });

  it("invokes onCancel when the cancel control is used", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <WorkflowLaunchForm
        parameters={[]}
        onLaunch={vi.fn()}
        onCancel={onCancel}
      />,
    );
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("associates each error message with its field for accessibility (R7.4)", async () => {
    const user = userEvent.setup();
    const parameters: ParameterDeclaration[] = [
      { type: "text", name: "brief", label: "Brief", required: true },
    ];
    render(<WorkflowLaunchForm parameters={parameters} onLaunch={vi.fn()} />);

    await user.click(launchButton());

    const field = screen.getByLabelText("Brief");
    const describedBy = field.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const errorEl = document.getElementById(describedBy ?? "");
    expect(errorEl).not.toBeNull();
    expect(
      within(errorEl as HTMLElement).getByText(/required/i),
    ).toBeInTheDocument();
  });
});
