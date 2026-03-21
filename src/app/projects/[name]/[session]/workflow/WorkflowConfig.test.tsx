// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import WorkflowConfigPanel from "./WorkflowConfigPanel";
import type { RalphLoopConfig } from "./types";

const defaultConfig: RalphLoopConfig = {
  maxIterations: 20,
  iterationTimeoutMs: 3_600_000,
  contextSoftLimitTokens: 160_000,
  contextHardLimitTokens: 180_000,
  circuitBreaker: {
    noProgressThreshold: 3,
    sameErrorThreshold: 5,
  },
};

function getInputs(container: HTMLElement) {
  return container.querySelectorAll<HTMLInputElement>(
    "input[inputmode='numeric']",
  );
}

describe("WorkflowConfigPanel", () => {
  it("renders all config fields as text inputs with numeric inputmode", () => {
    const { container } = render(
      <WorkflowConfigPanel config={defaultConfig} onConfigChange={vi.fn()} />,
    );
    const inputs = getInputs(container);
    expect(inputs.length).toBe(6);
    for (const input of inputs) {
      expect(input.type).toBe("text");
      expect(input.inputMode).toBe("numeric");
    }
  });

  it("renders fields with correct display values", () => {
    const { container } = render(
      <WorkflowConfigPanel config={defaultConfig} onConfigChange={vi.fn()} />,
    );
    const inputs = getInputs(container);
    expect(inputs[0]!.value).toBe("20");
    expect(inputs[1]!.value).toBe("60");
    expect(inputs[2]!.value).toBe("3");
    expect(inputs[3]!.value).toBe("5");
    expect(inputs[4]!.value).toBe("160");
    expect(inputs[5]!.value).toBe("180");
  });

  it("allows typing freely and commits valid values on blur", () => {
    const onConfigChange = vi.fn();
    const { container } = render(
      <WorkflowConfigPanel
        config={defaultConfig}
        onConfigChange={onConfigChange}
      />,
    );
    const inputs = getInputs(container);
    // Type a new value
    fireEvent.change(inputs[0]!, { target: { value: "50" } });
    // Should not call onConfigChange during typing
    expect(onConfigChange).not.toHaveBeenCalled();
    // Commit on blur
    fireEvent.blur(inputs[0]!);
    expect(onConfigChange).toHaveBeenCalledWith({
      ...defaultConfig,
      maxIterations: 50,
    });
  });

  it("allows clearing the field while typing without snapping back", () => {
    const onConfigChange = vi.fn();
    const { container } = render(
      <WorkflowConfigPanel
        config={defaultConfig}
        onConfigChange={onConfigChange}
      />,
    );
    const inputs = getInputs(container);
    // Clear the field
    fireEvent.change(inputs[0]!, { target: { value: "" } });
    // Value should be empty in the input (not snapped back)
    expect(inputs[0]!.value).toBe("");
    // No callback during typing
    expect(onConfigChange).not.toHaveBeenCalled();
  });

  it("reverts to original value on blur when field is empty", () => {
    const onConfigChange = vi.fn();
    const { container } = render(
      <WorkflowConfigPanel
        config={defaultConfig}
        onConfigChange={onConfigChange}
      />,
    );
    const inputs = getInputs(container);
    fireEvent.change(inputs[0]!, { target: { value: "" } });
    fireEvent.blur(inputs[0]!);
    // Should revert, not call onChange
    expect(onConfigChange).not.toHaveBeenCalled();
    expect(inputs[0]!.value).toBe("20");
  });

  it("strips non-numeric characters from input", () => {
    const { container } = render(
      <WorkflowConfigPanel config={defaultConfig} onConfigChange={vi.fn()} />,
    );
    const inputs = getInputs(container);
    fireEvent.change(inputs[0]!, { target: { value: "12abc3" } });
    expect(inputs[0]!.value).toBe("123");
  });

  it("commits on Enter key", () => {
    const onConfigChange = vi.fn();
    const { container } = render(
      <WorkflowConfigPanel
        config={defaultConfig}
        onConfigChange={onConfigChange}
      />,
    );
    const inputs = getInputs(container);
    fireEvent.change(inputs[0]!, { target: { value: "50" } });
    fireEvent.keyDown(inputs[0]!, { key: "Enter" });
    expect(onConfigChange).toHaveBeenCalledWith({
      ...defaultConfig,
      maxIterations: 50,
    });
  });

  it("converts timeout minutes to ms on commit", () => {
    const onConfigChange = vi.fn();
    const { container } = render(
      <WorkflowConfigPanel
        config={defaultConfig}
        onConfigChange={onConfigChange}
      />,
    );
    const inputs = getInputs(container);
    fireEvent.change(inputs[1]!, { target: { value: "30" } });
    fireEvent.blur(inputs[1]!);
    expect(onConfigChange).toHaveBeenCalledWith({
      ...defaultConfig,
      iterationTimeoutMs: 30 * 60_000,
    });
  });

  it("shows validation error for out-of-range value on blur", () => {
    const onConfigChange = vi.fn();
    const { container } = render(
      <WorkflowConfigPanel
        config={defaultConfig}
        onConfigChange={onConfigChange}
      />,
    );
    const inputs = getInputs(container);
    // Type out-of-range value
    fireEvent.change(inputs[0]!, { target: { value: "999" } });
    fireEvent.blur(inputs[0]!);
    // Should not call onChange for invalid values
    expect(onConfigChange).not.toHaveBeenCalled();
    // Should show error
    const errors = container.querySelectorAll(".workflow-config-error");
    expect(errors.length).toBeGreaterThan(0);
  });

  it("shows validation error when initial config value is out of range", () => {
    const { container } = render(
      <WorkflowConfigPanel
        config={{ ...defaultConfig, maxIterations: 0 }}
        onConfigChange={vi.fn()}
      />,
    );
    const errors = container.querySelectorAll(".workflow-config-error");
    expect(errors.length).toBeGreaterThan(0);
  });

  it("does not show errors for valid config", () => {
    const { container } = render(
      <WorkflowConfigPanel config={defaultConfig} onConfigChange={vi.fn()} />,
    );
    const errors = container.querySelectorAll(".workflow-config-error");
    expect(errors.length).toBe(0);
  });

  it("disables inputs in readOnly mode", () => {
    const { container } = render(
      <WorkflowConfigPanel
        config={defaultConfig}
        readOnly
        onConfigChange={vi.fn()}
      />,
    );
    const inputs = getInputs(container);
    for (const input of inputs) {
      expect(input.disabled).toBe(true);
    }
  });

  it("organizes fields into labeled groups", () => {
    const { container } = render(
      <WorkflowConfigPanel config={defaultConfig} onConfigChange={vi.fn()} />,
    );
    const groupLabels = container.querySelectorAll(
      ".workflow-config-group-label",
    );
    expect(groupLabels.length).toBe(3);
    expect(groupLabels[0]!.textContent).toBe("Execution Limits");
    expect(groupLabels[1]!.textContent).toBe("Circuit Breakers");
    expect(groupLabels[2]!.textContent).toBe("Context Management");
  });
});
