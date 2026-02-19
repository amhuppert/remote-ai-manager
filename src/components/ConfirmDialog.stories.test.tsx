// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { screen } from "@testing-library/react";
import { composeStories } from "@storybook/react";
import { storybookAnnotations } from "@/test/storybook-setup";
import * as stories from "./ConfirmDialog.stories";

beforeAll(storybookAnnotations.beforeAll);

const { Default, Danger, CustomLabels, Closed } = composeStories(stories);

describe("ConfirmDialog stories", () => {
  it("Default renders title, message, and standard buttons", async () => {
    await Default.run();
    expect(screen.getByText("Confirm Action")).toBeInTheDocument();
    expect(screen.getByText("Are you sure you want to proceed?")).toBeInTheDocument();
    expect(screen.getByText("Confirm")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
  });

  it("Danger renders with danger-styled confirm button", async () => {
    await Danger.run();
    expect(screen.getByText("Delete Session")).toBeInTheDocument();
    const confirmBtn = screen.getByText("Delete");
    expect(confirmBtn.className).toContain("btn-danger");
  });

  it("CustomLabels renders with overridden button text", async () => {
    await CustomLabels.run();
    expect(screen.getByText("Discard")).toBeInTheDocument();
    expect(screen.getByText("Keep Editing")).toBeInTheDocument();
  });

  it("Closed renders nothing when open=false", async () => {
    await Closed.run();
    expect(document.querySelector(".modal-overlay")).toBeNull();
  });
});
