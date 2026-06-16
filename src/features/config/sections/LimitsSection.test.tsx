// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LimitsSection } from "./LimitsSection";
import { makeController } from "./test-controller";

describe("LimitsSection", () => {
  it("renders the Limits & timeouts heading and key fields", () => {
    const { controller } = makeController();
    render(<LimitsSection controller={controller} />);
    expect(
      screen.getByRole("heading", { name: /Limits & timeouts/i }),
    ).toBeVisible();
    expect(screen.getByText(/Claude timeout/)).toBeVisible();
    expect(screen.getByText(/Max turns/)).toBeVisible();
    expect(screen.getByText(/Pre-merge timeout/)).toBeVisible();
  });

  it("editing Claude timeout converts minutes to ms in the controller", () => {
    const { controller, getState } = makeController();
    render(<LimitsSection controller={controller} />);
    const input = screen
      .getByText("Claude timeout")
      .closest("[data-field]")!
      .querySelector("input")! as HTMLInputElement;
    fireEvent.change(input, { target: { value: "30" } });
    expect(getState().claudeTimeoutMs).toBe(1_800_000);
  });

  it("clearing Max turns sends undefined to the controller", () => {
    const { controller, getState } = makeController({ maxTurns: 25 });
    render(<LimitsSection controller={controller} />);
    const input = screen
      .getByText("Max turns")
      .closest("[data-field]")!
      .querySelector("input")! as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    expect(getState().maxTurns).toBeUndefined();
  });
});
