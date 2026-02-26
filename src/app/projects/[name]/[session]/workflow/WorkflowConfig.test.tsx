// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import WorkflowConfigPanel from "./WorkflowConfigPanel";
import type { RalphLoopConfig } from "./types";

const defaultConfig: RalphLoopConfig = {
  maxIterations: 20,
  iterationTimeoutMs: 3_600_000,
  circuitBreaker: {
    noProgressThreshold: 3,
    sameErrorThreshold: 5,
  },
};

describe("WorkflowConfigPanel", () => {
  it("renders all config fields with correct values", () => {
    const { container } = render(
      <WorkflowConfigPanel config={defaultConfig} onConfigChange={vi.fn()} />,
    );
    const inputs = container.querySelectorAll<HTMLInputElement>("input[type='number']");
    expect(inputs.length).toBe(4);
    // Max iterations
    expect(inputs[0]!.value).toBe("20");
    // Timeout in minutes (3600000 / 60000 = 60)
    expect(inputs[1]!.value).toBe("60");
    // No-progress threshold
    expect(inputs[2]!.value).toBe("3");
    // Same-error threshold
    expect(inputs[3]!.value).toBe("5");
  });

  it("calls onConfigChange when max iterations changes", () => {
    const onConfigChange = vi.fn();
    const { container } = render(
      <WorkflowConfigPanel config={defaultConfig} onConfigChange={onConfigChange} />,
    );
    const inputs = container.querySelectorAll<HTMLInputElement>("input[type='number']");
    fireEvent.change(inputs[0]!, { target: { value: "50" } });
    expect(onConfigChange).toHaveBeenCalledWith({
      ...defaultConfig,
      maxIterations: 50,
    });
  });

  it("calls onConfigChange when timeout changes (converts minutes to ms)", () => {
    const onConfigChange = vi.fn();
    const { container } = render(
      <WorkflowConfigPanel config={defaultConfig} onConfigChange={onConfigChange} />,
    );
    const inputs = container.querySelectorAll<HTMLInputElement>("input[type='number']");
    fireEvent.change(inputs[1]!, { target: { value: "30" } });
    expect(onConfigChange).toHaveBeenCalledWith({
      ...defaultConfig,
      iterationTimeoutMs: 30 * 60_000,
    });
  });

  it("shows validation error for max iterations out of range", () => {
    const { container } = render(
      <WorkflowConfigPanel config={{ ...defaultConfig, maxIterations: 0 }} onConfigChange={vi.fn()} />,
    );
    const errors = container.querySelectorAll(".workflow-config-error");
    expect(errors.length).toBeGreaterThan(0);
  });

  it("shows validation error for timeout out of range", () => {
    const { container } = render(
      <WorkflowConfigPanel
        config={{ ...defaultConfig, iterationTimeoutMs: 0 }}
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
      <WorkflowConfigPanel config={defaultConfig} readOnly onConfigChange={vi.fn()} />,
    );
    const inputs = container.querySelectorAll<HTMLInputElement>("input[type='number']");
    for (const input of inputs) {
      expect(input.disabled).toBe(true);
    }
  });
});
