// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NotificationsSection } from "./NotificationsSection";
import { makeController } from "./test-controller";

describe("NotificationsSection", () => {
  it("renders Provider and Triggers groups with all five trigger toggles", () => {
    const { controller } = makeController();
    render(<NotificationsSection controller={controller} />);
    expect(
      screen.getByRole("heading", { name: /Push notifications/i }),
    ).toBeVisible();
    expect(screen.getAllByText(/^Provider$/).length).toBeGreaterThan(0);
    expect(screen.getByText(/^Triggers$/)).toBeVisible();
    expect(screen.getByText(/Job Completed/i)).toBeVisible();
    expect(screen.getByText(/Waiting For Input/i)).toBeVisible();
    expect(screen.getByText(/Workflow Completed/i)).toBeVisible();
    expect(screen.getByText(/Workflow Halted/i)).toBeVisible();
    expect(screen.getByText(/Conversation Idle/i)).toBeVisible();
  });

  it("editing Topic flows through the controller", () => {
    const { controller, getState } = makeController();
    render(<NotificationsSection controller={controller} />);
    const input = screen
      .getByText("Topic")
      .closest(".config-field")!
      .querySelector("input")! as HTMLInputElement;
    fireEvent.change(input, { target: { value: "abc123" } });
    expect(getState().pushNotification?.topic).toBe("abc123");
  });

  it("toggling a trigger updates the trigger flag", () => {
    const { controller, getState } = makeController();
    render(<NotificationsSection controller={controller} />);
    const toggle = screen
      .getByText(/Workflow Halted/i)
      .closest(".config-field")!
      .querySelector('[role="switch"]')! as HTMLElement;
    fireEvent.click(toggle);
    expect(getState().pushNotification?.triggers?.workflowHalted).toBe(false);
  });
});
