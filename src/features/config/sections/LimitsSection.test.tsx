// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LimitsSection } from "./LimitsSection";
import { makeController } from "./test-controller";

describe("LimitsSection", () => {
  it("renders the Limits & timeouts heading and key fields", () => {
    const { controller } = makeController({
      validation: { concurrencyLimit: 8, defaultTimeoutMs: 600_000 },
    });
    render(<LimitsSection controller={controller} />);
    expect(
      screen.getByRole("heading", { name: /Limits & timeouts/i }),
    ).toBeVisible();
    expect(screen.queryByText(/Claude timeout/)).not.toBeInTheDocument();
    expect(screen.getByText(/Max turns/)).toBeVisible();
    expect(screen.getByText(/Pre-merge timeout/)).toBeVisible();
    expect(screen.getByText("Validation capacity")).toBeVisible();
    expect(screen.getByText("Validation timeout")).toBeVisible();
    expect(
      screen.getByText(
        "Weighted machine budget. Running command costs cannot exceed this total.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Minutes. Starts when the command process spawns; queue time is excluded.",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("textbox", {
        name: "Validation capacity",
      }),
    ).toHaveValue("8");
    expect(
      screen.getByRole("textbox", { name: "Validation timeout" }),
    ).toHaveValue("10");
  });

  it.each([
    ["Validation capacity", "1.5", "Must be a whole number"],
    ["Validation capacity", "0", "Must be positive"],
    ["Validation timeout", "1.5", "Must be a whole number"],
    ["Validation timeout", "0", "Must be positive"],
  ])("validates %s as a positive integer", (name, input, error) => {
    const { controller } = makeController({
      validation: { concurrencyLimit: 8, defaultTimeoutMs: 600_000 },
    });
    render(<LimitsSection controller={controller} />);

    fireEvent.change(screen.getByRole("textbox", { name }), {
      target: { value: input },
    });

    expect(screen.getByRole("alert")).toHaveTextContent(error);
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
