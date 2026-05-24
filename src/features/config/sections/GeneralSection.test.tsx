// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GeneralSection } from "./GeneralSection";
import { makeController } from "./test-controller";

describe("GeneralSection", () => {
  it("renders the General settings heading and Workspace/Infrastructure groups", () => {
    const { controller } = makeController();
    render(<GeneralSection controller={controller} />);
    expect(
      screen.getByRole("heading", { name: /General settings/i }),
    ).toBeVisible();
    expect(screen.getByText(/^Workspace$/)).toBeVisible();
    expect(screen.getByText(/^Infrastructure$/)).toBeVisible();
  });

  it("editing baseDir flows through the controller", () => {
    const { controller, getState } = makeController();
    render(<GeneralSection controller={controller} />);
    const baseDir = screen
      .getByText("Base directory")
      .closest(".config-field")!
      .querySelector("input")!;
    fireEvent.change(baseDir, { target: { value: "/new/path" } });
    expect(getState().baseDir).toBe("/new/path");
  });

  it("toggling Tailscale flows through the controller", () => {
    const { controller, getState } = makeController();
    render(<GeneralSection controller={controller} />);
    const toggle = screen
      .getByText("Tailscale enabled")
      .closest(".config-field")!
      .querySelector('[role="switch"]')! as HTMLElement;
    fireEvent.click(toggle);
    expect(getState().tailscaleEnabled).toBe(true);
  });

  it("renders ignore patterns as read-only tags", () => {
    const { controller } = makeController();
    render(<GeneralSection controller={controller} />);
    expect(screen.getByText("node_modules")).toBeVisible();
    expect(screen.getByText(".next")).toBeVisible();
    expect(
      screen.getByText("Ignore patterns").closest(".config-field")?.className,
    ).toContain("config-field-readonly");
  });
});
