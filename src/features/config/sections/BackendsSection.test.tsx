// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BackendsSection } from "./BackendsSection";
import { makeController } from "./test-controller";

describe("BackendsSection", () => {
  it("renders Claude and Codex groups", () => {
    const { controller } = makeController();
    render(<BackendsSection controller={controller} />);
    expect(
      screen.getByRole("heading", { name: /Agent backends/i }),
    ).toBeVisible();
    expect(screen.getByText(/^Claude$/)).toBeVisible();
    expect(screen.getByText(/^Codex$/)).toBeVisible();
    expect(screen.getByText(/SDK is bundled and ready/)).toBeVisible();
  });

  it("toggling Enable Codex flows through the controller", () => {
    const { controller, getState } = makeController();
    render(<BackendsSection controller={controller} />);
    const toggle = screen
      .getByText("Enable Codex")
      .closest(".config-field")!
      .querySelector('[role="switch"]')! as HTMLElement;
    fireEvent.click(toggle);
    expect(getState().codex?.enabled).toBe(true);
  });
});
